// ── background.js (Service Worker) ────────────────────────────────────────────
//
// Full-page screenshot strategy:
//   1. Scroll to top, disable smooth-scroll.
//   2. Default CLEAN mode: DETACH footers, headers, and position:fixed/sticky
//      chrome so they cannot repeat in every tile. Original mode keeps them.
//   3. Scroll tile-by-tile, capturing each viewport with captureVisibleTab().
//      Uses ACTUAL scrollY (not target) to handle the last tile correctly
//      when scrollHeight isn't a clean multiple of viewportHeight.
//   4. Stitch tiles onto an OffscreenCanvas, drawing each at its actual scrollY.
//   5. Restore hidden elements & original scroll position.
//   6. Copy through the focused popup/page or save as a PNG file.
//
// Select area: drag a rectangle on the current viewport, capture once, crop.
// Clean/Original chrome stripping does not apply — the crop is what is on screen.
//
// Rate-limit safety: Chrome/Brave caps captureVisibleTab at 2 calls/sec.
// We enforce ≥ 600ms gaps + retry with exponential back-off.

const CAPTURE_INTERVAL_MS = 600;
const SCROLL_SETTLE_MS    = 350;   // wait for repaint + lazy-load after scroll
const FOOTER_CSS_FILE     = 'hide-footer.css';
const footerCssByTab      = new Map();
const MAX_RETRIES         = 4;
const MAX_TILES           = 200;
const MAX_CANVAS_DIMENSION = 32767;
const MAX_CANVAS_PIXELS    = 100_000_000;
const CAPTURE_MODES = new Set(['full', 'select', 'visible']);
const OUTPUT_TYPES = new Set(['clipboard', 'file']);

// captureVisibleTab is rate-limited for the entire extension, not per tab.
// Serializing calls also prevents two overlapping captures from stitching tiles
// from each other's viewport positions.
const activeCaptures = new Set();
let captureVisibleQueue = Promise.resolve();
let lastVisibleCaptureAt = 0;

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'CAPTURE') return false;

  (async () => {
    try {
      const result = await captureTab(msg.tabId, msg.mode, msg.output, !!msg.includeChrome);
      sendResponse(result);
    } catch (err) {
      sendResponse({ error: errorMessage(err) });
    }
  })();

  return true;
});

// ── Main capture orchestrator ─────────────────────────────────────────────────
async function captureTab(tabId, mode, output, includeChrome = false) {
  if (!Number.isInteger(tabId)) throw new Error('No valid tab was selected');
  if (!CAPTURE_MODES.has(mode)) throw new Error('Unsupported capture mode');
  if (!OUTPUT_TYPES.has(output)) throw new Error('Unsupported output type');
  if (activeCaptures.has(tabId)) throw new Error('A capture is already running for this tab');

  activeCaptures.add(tabId);
  const isSelect = mode === 'select';
  let failure = null;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) throw new Error('Keep the page active while it is being captured');

    // A prior failed run may have left temporary page styles behind.  Always
    // reset them before starting a new capture.
    await restoreCaptureState(tabId);

    if (isSelect) {
      return captureSelectedRegion(tabId, output, tab.windowId);
    }
    if (mode === 'visible') {
      return captureVisibleOnly(tabId, output, tab.windowId, includeChrome);
    }
    return captureFullPage(tabId, output, tab.windowId, includeChrome);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // The popup closes before area capture, so cleanup must be independent of it.
    await restoreCaptureState(tabId).catch(() => {});
    if (isSelect && failure && failure.message !== 'Area selection cancelled') {
      await showPageNotice(tabId, failure.message, 'error');
    }
    activeCaptures.delete(tabId);
  }
}

// ── Area selection (viewport crop) ────────────────────────────────────────────
async function captureSelectedRegion(tabId, output, windowId) {
  notifyPopup(5, 'Select an area on the page...');
  const selection = await selectAreaRect(tabId);

  notifyPopup(40, 'Capturing selection…');
  await notifyPage(tabId, 40, 'Capturing selection…');
  await sleep(80);

  const dataUrl = await captureWithRetry(tabId, windowId, {
    hideUi: true,
    includeChrome: true,
  });

  notifyPopup(75, 'Cropping selection…');
  await notifyPage(tabId, 75, 'Cropping selection…');
  const bitmap = await dataUrlToBitmap(dataUrl);
  try {
    const blob = await cropBitmapToRect(bitmap, selection);
    notifyPopup(95, output === 'clipboard' ? 'Preparing clipboard…' : 'Saving PNG…');
    await notifyPage(tabId, 95, 'Finalizing image…');
    return outputResult(blob, output, true, tabId);
  } finally {
    bitmap.close();
  }
}

async function selectAreaRect(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => new Promise((resolve) => {
      // Replacing an unfinished selection must also resolve its old promise;
      // otherwise its service-worker capture remains locked forever.
      window.__fs_cancelSelection?.();
      document.getElementById('fs-select-root')?.remove();
      document.getElementById('fs-selection-highlight')?.remove();

      const MIN_SIZE = 8;
      let finished = false;
      let dragging = false;
      let startX = 0;
      let startY = 0;

      const root = document.createElement('div');
      root.id = 'fs-select-root';
      root.setAttribute('data-fs-ui', '');
      root.style.cssText = [
        'display: block',
        'position: fixed',
        'top: 0',
        'right: 0',
        'bottom: 0',
        'left: 0',
        'width: auto',
        'height: auto',
        'margin: 0',
        'padding: 0',
        'border: 0',
        'background: transparent',
        'overflow: hidden',
        'z-index: 2147483647',
        'cursor: crosshair',
        'pointer-events: auto',
        'user-select: none',
        'touch-action: none',
        'transform: none',
        'filter: none',
        'isolation: isolate',
      ].map((rule) => `${rule} !important`).join(';');

      const shadow = root.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = [
        ':host { display: block; }',
        '* { box-sizing: border-box; }',
        '.dim { position: absolute; background: rgba(8, 10, 18, 0.55); pointer-events: none; }',
        '.box { position: absolute; display: none; pointer-events: none; outline: 2px solid #9b87ff;',
        '  box-shadow: 0 0 0 1px rgba(0,0,0,.4); }',
        '.hint, .size { position: absolute; pointer-events: none; color: #f7f8ff;',
        '  font-family: system-ui, sans-serif; white-space: nowrap; }',
        '.hint { top: 20px; left: 50%; transform: translateX(-50%); padding: 8px 14px;',
        '  border: 1px solid rgba(255,255,255,.12); border-radius: 999px;',
        '  background: rgba(15, 18, 28, 0.94); box-shadow: 0 10px 28px rgba(0,0,0,.35);',
        '  font-size: 12px; font-weight: 650; }',
        '.size { display: none; padding: 3px 7px; border-radius: 6px; background: #8068ff;',
        '  font-size: 11px; font-weight: 700; }',
      ].join('\n');

      const dimTop = document.createElement('div');
      const dimLeft = document.createElement('div');
      const dimRight = document.createElement('div');
      const dimBottom = document.createElement('div');
      const box = document.createElement('div');
      const hint = document.createElement('div');
      const size = document.createElement('div');
      dimTop.className = 'dim';
      dimLeft.className = 'dim';
      dimRight.className = 'dim';
      dimBottom.className = 'dim';
      box.className = 'box';
      hint.className = 'hint';
      size.className = 'size';
      hint.textContent = 'Drag to select an area · Esc to cancel';
      shadow.append(style, dimTop, dimLeft, dimRight, dimBottom, box, hint, size);
      document.documentElement.appendChild(root);

      const layout = (rect) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (!rect) {
          dimTop.style.cssText = `position:absolute;left:0;top:0;width:${vw}px;height:${vh}px;`;
          dimLeft.style.cssText = 'display:none';
          dimRight.style.cssText = 'display:none';
          dimBottom.style.cssText = 'display:none';
          box.style.display = 'none';
          size.style.display = 'none';
          return;
        }
        const { left, top, width, height } = rect;
        dimTop.style.cssText = `position:absolute;left:0;top:0;width:${vw}px;height:${top}px;`;
        dimLeft.style.cssText = `position:absolute;left:0;top:${top}px;width:${left}px;height:${height}px;`;
        dimRight.style.cssText = `position:absolute;left:${left + width}px;top:${top}px;width:${Math.max(0, vw - left - width)}px;height:${height}px;`;
        dimBottom.style.cssText = `position:absolute;left:0;top:${top + height}px;width:${vw}px;height:${Math.max(0, vh - top - height)}px;`;
        box.style.cssText = `display:block;position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
        size.style.display = 'block';
        size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
        size.style.left = `${Math.min(left, Math.max(0, vw - 88))}px`;
        size.style.top = `${Math.min(top + height + 8, vh - 24)}px`;
      };

      const normRect = (x0, y0, x1, y1) => {
        const left = Math.max(0, Math.min(x0, x1));
        const top = Math.max(0, Math.min(y0, y1));
        const right = Math.min(window.innerWidth, Math.max(x0, x1));
        const bottom = Math.min(window.innerHeight, Math.max(y0, y1));
        return {
          left,
          top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };
      };

      const cleanup = () => {
        root.removeEventListener('pointerdown', onPointerDown, true);
        root.removeEventListener('pointermove', onPointerMove, true);
        root.removeEventListener('pointerup', onPointerUp, true);
        root.removeEventListener('pointercancel', onPointerUp, true);
        root.removeEventListener('wheel', onWheel, true);
        root.removeEventListener('click', swallowEvent, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('contextmenu', onContextMenu, true);
        document.removeEventListener('click', swallowEvent, true);
        document.removeEventListener('mousedown', swallowEvent, true);
        document.removeEventListener('mouseup', swallowEvent, true);
        document.removeEventListener('dblclick', swallowEvent, true);
        document.removeEventListener('auxclick', swallowEvent, true);
        root.remove();
        window.__fs_cancelSelection = null;
      };

      const finish = (value) => {
        if (finished) return;
        finished = true;
        dragging = false;
        // Keep the overlay up through the leftover click so it does not hit the page.
        setTimeout(() => {
          cleanup();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
        }, 50);
      };

      function onWheel(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!dragging) window.scrollBy(e.deltaX, e.deltaY);
      }

      function swallowEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }

      function onContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();
      }

      function onKeyDown(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }

      function onPointerDown(e) {
        if (e.button !== 0 || finished) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        try { root.setPointerCapture(e.pointerId); } catch (_) {}
        hint.style.visibility = 'hidden';
        layout(normRect(startX, startY, startX, startY));
      }

      function onPointerMove(e) {
        if (!dragging || finished) return;
        e.preventDefault();
        layout(normRect(startX, startY, e.clientX, e.clientY));
      }

      function onPointerUp(e) {
        if (!dragging || finished) return;
        dragging = false;
        e.preventDefault();
        e.stopPropagation();
        try { root.releasePointerCapture(e.pointerId); } catch (_) {}
        const rect = normRect(startX, startY, e.clientX, e.clientY);
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
          hint.style.visibility = 'visible';
          hint.textContent = 'Drag to select an area · Esc to cancel';
          layout(null);
          return;
        }
        finish({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      }

      window.__fs_cancelSelection = () => finish(null);
      layout(null);
      root.addEventListener('pointerdown', onPointerDown, true);
      root.addEventListener('pointermove', onPointerMove, true);
      root.addEventListener('pointerup', onPointerUp, true);
      root.addEventListener('pointercancel', onPointerUp, true);
      root.addEventListener('wheel', onWheel, { capture: true, passive: false });
      root.addEventListener('click', swallowEvent, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('click', swallowEvent, true);
      document.addEventListener('mousedown', swallowEvent, true);
      document.addEventListener('mouseup', swallowEvent, true);
      document.addEventListener('dblclick', swallowEvent, true);
      document.addEventListener('auxclick', swallowEvent, true);
    }),
  });
  if (!result) throw new Error('Area selection cancelled');
  return result;
}

function cropBitmapToRect(bitmap, selection) {
  const viewportWidth = Number(selection?.viewportWidth);
  const viewportHeight = Number(selection?.viewportHeight);
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0
    || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new Error('The selected area could not be measured');
  }

  const scaleX = bitmap.width / viewportWidth;
  const scaleY = bitmap.height / viewportHeight;
  if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) {
    throw new Error('The captured image could not be cropped');
  }

  let sx = Math.round(Number(selection.left) * scaleX);
  let sy = Math.round(Number(selection.top) * scaleY);
  let sw = Math.round(Number(selection.width) * scaleX);
  let sh = Math.round(Number(selection.height) * scaleY);

  sx = Math.min(Math.max(0, sx), Math.max(0, bitmap.width - 1));
  sy = Math.min(Math.max(0, sy), Math.max(0, bitmap.height - 1));
  sw = Math.min(Math.max(1, sw), bitmap.width - sx);
  sh = Math.min(Math.max(1, sh), bitmap.height - sy);

  if (sw > MAX_CANVAS_DIMENSION || sh > MAX_CANVAS_DIMENSION || sw * sh > MAX_CANVAS_PIXELS) {
    throw new Error('The captured image is too large for the browser to create safely');
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to prepare the screenshot image');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ────────────────────────────────────────────────────────────────────────────
//  FULL-PAGE CAPTURE
// ────────────────────────────────────────────────────────────────────────────
async function captureFullPage(tabId, output, windowId, includeChrome = false) {
  let pagePrepared = false;

  try {
    notifyPopup(8, 'Measuring page…');
    const { viewportHeight } = await getPageMetrics(tabId);

    notifyPopup(12, 'Preparing page…');
    await prepareCapturePage(tabId, includeChrome);
    pagePrepared = true;
    await sleep(SCROLL_SETTLE_MS);

    const scrollHeight = await getScrollHeight(tabId);
    const numTiles = Math.max(1, Math.ceil(scrollHeight / viewportHeight));
    notifyPopup(14, `Estimated ${numTiles} tile${numTiles > 1 ? 's' : ''} to capture…`);

    const tiles = [];
    let prevScrollY = -1;
    let i = 0;

    while (true) {
      if (i >= MAX_TILES) {
        const latestHeight = await getScrollHeight(tabId);
        if (prevScrollY + viewportHeight < latestHeight - 0.5) {
          throw new Error(`This page needs more than ${MAX_TILES} screenshot tiles`);
        }
        break;
      }

      await injectScript(tabId, (y) => {
        const sc = window.__fs_scrollContainer || window;
        if (sc === window) window.scrollTo(0, y);
        else sc.scrollTop = y;
      }, [i * viewportHeight]);
      await sleep(SCROLL_SETTLE_MS);

      const actualScrollY = await getScrollY(tabId);
      if (Math.abs(actualScrollY - prevScrollY) < 0.5) break;

      const pct = 15 + Math.min(60, Math.round((i / Math.max(1, numTiles)) * 60));
      notifyPopup(pct, `Capturing tile ${i + 1}…`);

      const dataUrl = await captureWithRetry(tabId, windowId, {
        hideHeaders: !includeChrome,
        hideFixed: !includeChrome,
        includeChrome,
      });
      tiles.push({ dataUrl, scrollY: actualScrollY });
      prevScrollY = actualScrollY;
      i++;
    }

    const capturedScrollHeight = await getScrollHeight(tabId);
    notifyPopup(78, 'Restoring page…');
    await restoreCaptureState(tabId);
    pagePrepared = false;

    notifyPopup(82, 'Stitching tiles…');
    if (!tiles.length) throw new Error('No screenshot tiles were captured');

    const firstBitmap = await dataUrlToBitmap(tiles[0].dataUrl);
    const pixelScaleY = firstBitmap.height / viewportHeight;
    const pageHeight = Math.max(0, capturedScrollHeight || scrollHeight);
    const canvasW = firstBitmap.width;
    const canvasH = Math.max(1, Math.ceil(pageHeight * pixelScaleY));

    if (!Number.isFinite(pixelScaleY) || pixelScaleY <= 0 || canvasW > MAX_CANVAS_DIMENSION
      || canvasH > MAX_CANVAS_DIMENSION || canvasW * canvasH > MAX_CANVAS_PIXELS) {
      firstBitmap.close();
      throw new Error('The captured image is too large for the browser to create safely');
    }

    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      firstBitmap.close();
      throw new Error('Unable to prepare the screenshot image');
    }
    ctx.imageSmoothingEnabled = false;

    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t];
      const spct = 82 + Math.round((t / tiles.length) * 12);
      notifyPopup(spct, 'Stitching tiles…');

      const bitmap = t === 0 ? firstBitmap : await dataUrlToBitmap(tile.dataUrl);
      const nextScrollY = t + 1 < tiles.length ? tiles[t + 1].scrollY : pageHeight;
      const destY = Math.max(0, Math.round(tile.scrollY * pixelScaleY));
      const destEnd = t + 1 < tiles.length
        ? Math.min(canvasH, Math.round(nextScrollY * pixelScaleY))
        : canvasH;
      const sourceH = Math.min(bitmap.height, Math.max(0, destEnd - destY));

      if (sourceH > 0 && destY < canvasH) {
        ctx.drawImage(bitmap, 0, 0, bitmap.width, sourceH, 0, destY, bitmap.width, sourceH);
      }
      bitmap.close();
    }

    notifyPopup(95, output === 'clipboard' ? 'Preparing clipboard…' : 'Saving PNG…');
    return outputResult(await canvas.convertToBlob({ type: 'image/png' }), output, false, tabId);
  } finally {
    if (pagePrepared) await restoreCaptureState(tabId).catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  PAGE PREP / RESTORE
// ────────────────────────────────────────────────────────────────────────────
async function prepareCapturePage(tabId, includeChrome = false) {
  if (!includeChrome) await hideFootersInTab(tabId);
  await injectScript(tabId, preparePageForCapture);
}

async function hideFootersInTab(tabId) {
  try {
    const target = await insertFooterCss(tabId);
    footerCssByTab.set(tabId, target);
  } catch (_) {
    // Class marking + in-page stylesheet still run below.
  }
  await runInTab(tabId, markFooterElements);
}

async function insertFooterCss(tabId) {
  const targets = [{ tabId, allFrames: true }, { tabId }];
  const extra = { files: [FOOTER_CSS_FILE], origin: 'AUTHOR' };
  let lastError;
  for (const target of targets) {
    try {
      await chrome.scripting.insertCSS({ target, ...extra });
      return { target, extra };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to inject footer-hiding CSS');
}

async function removeFooterCss(tabId) {
  const remembered = footerCssByTab.get(tabId);
  footerCssByTab.delete(tabId);
  const extra = remembered?.extra || { files: [FOOTER_CSS_FILE], origin: 'AUTHOR' };
  const targets = remembered?.target
    ? [remembered.target, { tabId }]
    : [{ tabId, allFrames: true }, { tabId }];
  for (const target of targets) {
    try {
      await chrome.scripting.removeCSS({ target, ...extra });
    } catch (_) {}
  }
}

async function runInTab(tabId, func, args = []) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, func, args });
  }
}

async function restoreCaptureState(tabId) {
  await removeFooterCss(tabId);
  await runInTab(tabId, restorePageAfterCapture);
}

// ────────────────────────────────────────────────────────────────────────────
//  VISIBLE-AREA CAPTURE
// ────────────────────────────────────────────────────────────────────────────
async function captureVisibleOnly(tabId, output, windowId, includeChrome = false) {
  notifyPopup(40, 'Capturing viewport…');
  if (!includeChrome) await hideFootersInTab(tabId);
  await sleep(SCROLL_SETTLE_MS);
  const dataUrl = await captureWithRetry(tabId, windowId, {
    includeChrome,
  });

  notifyPopup(80, output === 'clipboard' ? 'Preparing clipboard…' : 'Saving PNG…');
  const blob = await dataUrlToBlob(dataUrl);
  return outputResult(blob, output, false, tabId);
}

// ────────────────────────────────────────────────────────────────────────────
//  OUTPUT: clipboard (popup or focused page) or file (save PNG)
// ────────────────────────────────────────────────────────────────────────────
async function outputResult(blob, output, isSelect, tabId) {
  if (output === 'clipboard') {
    if (isSelect) {
      // The popup is destroyed when the user clicks a page area.  The selected
      // page itself remains focused, so run the Clipboard API in that page.
      await notifyPage(tabId, 97, 'Copying to clipboard…');
      await copyBlobToClipboard(tabId, blob);
      notifyPopup(100, 'Done!');
      await showPageNotice(tabId, 'Copied to clipboard', 'success');
      return { success: true };
    }

    // Keep the established popup route for Full Page and Visible captures.
    // It is focused and can therefore use navigator.clipboard.write reliably.
    return { dataUrl: await blobToDataUrl(blob) };
  }

  // Save file
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const filename = buildFilename(tab);
  await downloadPng(blob, filename);
  notifyPopup(100, 'Done!');
  if (isSelect) {
    await showPageNotice(tabId, `Saved ${filename}`, 'success');
  }
  return { filename };
}

async function copyBlobToClipboard(tabId, blob) {
  const dataUrl = await blobToDataUrl(blob);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (imageDataUrl) => {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard image writing is unavailable on this page');
      }
      const response = await fetch(imageDataUrl);
      const imageBlob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': imageBlob }),
      ]);
      return true;
    },
    args: [dataUrl],
  });
  if (!result) throw new Error('The page did not confirm the clipboard copy');
}

async function showPageNotice(tabId, message, type) {
  try {
    await injectScript(tabId, (text, noticeType) => {
      document.getElementById('fs-page-progress')?.remove();
      document.getElementById('fs-page-notice')?.remove();
      document.getElementById('fs-select-root')?.remove();

      const notice = document.createElement('div');
      notice.id = 'fs-page-notice';
      notice.textContent = text;
      Object.assign(notice.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
        padding: '12px 16px', borderRadius: '10px', color: '#fff',
        font: '600 13px system-ui, sans-serif',
        background: noticeType === 'success' ? '#168c68' : '#b4233a',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)',
      });
      document.documentElement.appendChild(notice);
      setTimeout(() => notice.remove(), 4000);
    }, [message, type]);
  } catch (_) {
    // The tab may have navigated; there is nowhere to show a page notice.
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────────────────────────────────

/** Capture with retry + exponential back-off for rate-limit errors. */
async function captureWithRetry(tabId, windowId, options = {}) {
  const task = captureVisibleQueue.then(() => captureWithRetryInternal(tabId, windowId, options));
  // Keep the queue usable after a failed capture without swallowing this
  // caller's error.
  captureVisibleQueue = task.catch(() => {});
  return task;
}

async function captureWithRetryInternal(tabId, windowId, options) {
  const hideUi = !!options.hideUi;
  const chromeOptions = {
    headers: !!options.hideHeaders,
    fixed: !!options.hideFixed,
  };
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active || tab.windowId !== windowId) {
        throw new Error('Keep the selected tab active until the capture completes');
      }

      const elapsed = Date.now() - lastVisibleCaptureAt;
      if (elapsed < CAPTURE_INTERVAL_MS) await sleep(CAPTURE_INTERVAL_MS - elapsed);

      if (!options.includeChrome) await runInTab(tabId, detachCaptureChrome, [chromeOptions]);
      if (hideUi) await injectScript(tabId, setCaptureUiHidden, [true]);
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: 'png',
        });
        lastVisibleCaptureAt = Date.now();
        return dataUrl;
      } finally {
        if (hideUi) await injectScript(tabId, setCaptureUiHidden, [false]).catch(() => {});
      }
    } catch (err) {
      lastError = err;
      if (err.message && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        const backoff = CAPTURE_INTERVAL_MS * Math.pow(2, attempt + 1);
        await sleep(backoff);
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/** Get page dimensions. */
async function getPageMetrics(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 1-pixel test to find the real scroll container
      function testScroll(el) {
        let origBehavior = '';
        let origPriority = '';
        if (el && el.style) {
          origBehavior = el.style.getPropertyValue('scroll-behavior');
          origPriority = el.style.getPropertyPriority('scroll-behavior');
          el.style.setProperty('scroll-behavior', 'auto', 'important');
        }

        let res = false;
        if (el === window) {
          const start = window.scrollY;
          window.scrollTo(0, start + 1);
          if (Math.abs(window.scrollY - start) > 0.1) { window.scrollTo(0, start); res = true; }
          else {
            window.scrollTo(0, start - 1);
            if (Math.abs(window.scrollY - start) > 0.1) { window.scrollTo(0, start); res = true; }
          }
        } else {
          const start = el.scrollTop;
          el.scrollTop = start + 1;
          if (Math.abs(el.scrollTop - start) > 0.1) { el.scrollTop = start; res = true; }
          else {
            el.scrollTop = start - 1;
            if (Math.abs(el.scrollTop - start) > 0.1) { el.scrollTop = start; res = true; }
          }
        }

        if (el && el.style) {
          if (origBehavior) el.style.setProperty('scroll-behavior', origBehavior, origPriority);
          else el.style.removeProperty('scroll-behavior');
        }
        return res;
      }

      let sc = window.__fs_scrollContainer;
      if (sc && sc !== window && !sc.isConnected) sc = null;
      
      if (!sc) {
        if (testScroll(window)) {
          sc = window;
        } else if (document.scrollingElement && testScroll(document.scrollingElement)) {
          sc = document.scrollingElement;
        } else {
        let bestEl = null;
        let maxArea = 0;
        const els = document.querySelectorAll('*');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (el.scrollHeight > el.clientHeight && el.clientHeight > 0) {
            const area = el.clientWidth * el.clientHeight;
            if (area > maxArea && testScroll(el)) {
              maxArea = area;
              bestEl = el;
            }
          }
        }
          if (bestEl) sc = bestEl;
        }
        if (!sc) sc = window;
        window.__fs_scrollContainer = sc;
      }

      let sHeight = 0;
      if (sc === window) {
        sHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      } else {
        sHeight = sc.scrollHeight;
      }

      return {
        scrollHeight: Math.max(sHeight, window.innerHeight),
        viewportHeight: window.innerHeight,
      };
    },
  });
  return result;
}

/** Get actual current scrollY of the tab. */
async function getScrollY(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sc = window.__fs_scrollContainer || window;
      return sc === window ? window.scrollY : sc.scrollTop;
    },
  });
  return result;
}

/** Get the current total height of the active scroll container. */
async function getScrollHeight(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sc = window.__fs_scrollContainer || window;
      if (sc === window) {
        return Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
          window.innerHeight,
        );
      }
      return Math.max(sc.scrollHeight, sc.clientHeight);
    },
  });
  return result;
}

/**
 * Injected into every frame. Scores nodes with stacked signals (semantics,
 * names, geometry, layout) and detaches high-confidence page chrome so page
 * CSS cannot keep it visible.
 */
function markFooterElements() {
  const HIDE_CLASS = 'fs-capture-hide';
  const DETACH_SCORE = 8;
  const HIDE_SCORE = 6;
  const SKIP_TAGS = new Set([
    'HTML', 'BODY', 'MAIN', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT',
    'HEAD', 'BR', 'HR', 'IMG', 'SVG', 'PATH', 'CANVAS', 'VIDEO', 'AUDIO',
    'SOURCE', 'IFRAME', 'PICTURE', 'TEMPLATE',
  ]);
  const SMALL_TAGS = new Set([
    'A', 'SPAN', 'BUTTON', 'INPUT', 'LABEL', 'I', 'B', 'EM', 'STRONG',
    'SMALL', 'LI', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'CODE', 'TIME',
  ]);
  const NESTED_CONTEXT = new Set([
    'ARTICLE', 'ASIDE', 'LI', 'TD', 'TR', 'TABLE', 'FIGURE', 'BLOCKQUOTE', 'DETAILS',
  ]);
  const LAYOUT_IDS = new Set(['root', 'app', '__next', '__nuxt', 'page', 'wrapper', 'container']);
  const STRONG_NAMES = new Set([
    'footer', 'colophon', 'sitefooter', 'pagefooter', 'globalfooter',
    'mainfooter', 'appfooter', 'sitefoot', 'pagefoot', 'footwrap',
  ]);
  const CHROME_NAMES = new Set([
    'cookie', 'consent', 'gdpr', 'onetrust', 'cookiebanner', 'cookiebar',
    'cookieconsent', 'bottomnav', 'bottombar', 'tabbar', 'dock', 'snackbar',
    'toastcontainer',
  ]);
  const WEAK_NAMES = new Set(['bottom', 'legal', 'copyright', 'sitemap', 'credits', 'disclaimer']);
  const NEGATIVE_NAMES = new Set([
    'header', 'hero', 'content', 'article', 'sidebar', 'main', 'modal',
    'dialog', 'drawer', 'tooltip', 'popover',
  ]);

  if (!window.__fs_hiddenElements) window.__fs_hiddenElements = [];
  if (!window.__fs_detachedNodes) window.__fs_detachedNodes = [];

  const detached = new Set(window.__fs_detachedNodes.map((item) => item.el));
  const hiddenEls = new Set(window.__fs_hiddenElements.map((item) => item.el));

  const isOwnUi = (el) => {
    const id = el?.id || '';
    return id.startsWith('fs-') || el?.hasAttribute?.('data-fs-ui');
  };

  const selectedLineage = new Set();
  let selectedAncestor = window.__fs_scrollContainer;
  while (selectedAncestor && selectedAncestor !== window) {
    selectedLineage.add(selectedAncestor);
    const root = selectedAncestor.getRootNode?.();
    selectedAncestor = selectedAncestor.parentElement || root?.host || null;
  }

  const nameBlob = (el) => [
    el.id,
    el.getAttribute('name'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-test'),
    el.getAttribute('data-test-id'),
    el.getAttribute('data-cy'),
    el.getAttribute('data-id'),
    el.getAttribute('data-qa'),
    el.getAttribute('itemprop'),
    el.getAttribute('itemtype'),
    el.getAttribute('slot'),
    typeof el.className === 'string' ? el.className : el.className?.baseVal,
  ].filter(Boolean).join(' ');

  const tokensOf = (str) => String(str)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  const isLayoutRoot = (el) => {
    if (!el || el === document.body) return true;
    const id = (el.id || '').toLowerCase();
    return LAYOUT_IDS.has(id) || el.getAttribute('data-reactroot') != null;
  };

  const collectElements = (root, acc = []) => {
    let list;
    try { list = root.querySelectorAll('*'); } catch (_) { return acc; }
    for (const el of list) {
      acc.push(el);
      if (el.shadowRoot) collectElements(el.shadowRoot, acc);
    }
    return acc;
  };

  const scoreChrome = (el) => {
    if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return 0;
    if (isOwnUi(el) || selectedLineage.has(el) || detached.has(el)) return 0;

    const role = (el.getAttribute('role') || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    let score = 0;

    if (el.tagName === 'FOOTER') score += 10;
    if (role === 'contentinfo') score += 10;
    if ((el.getAttribute('slot') || '').toLowerCase() === 'footer') score += 8;
    if (id === 'footer' || id === 'colophon') score += 8;
    if (id.endsWith('-footer') || id.endsWith('_footer') || id.endsWith('footer')) score += 5;

    const toks = new Set(tokensOf(nameBlob(el)));
    if (toks.has('footer') || toks.has('colophon')) score += 6;
    for (const token of toks) {
      if (STRONG_NAMES.has(token)) score += 5;
      if (CHROME_NAMES.has(token)) score += 4;
      if (WEAK_NAMES.has(token)) score += 2;
      if (NEGATIVE_NAMES.has(token) && !toks.has('footer') && role !== 'contentinfo') score -= 5;
    }

    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return score; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
      return score >= 10 ? score : 0;
    }

    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const docH = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      vh,
    );
    const topAbs = rect.top + window.scrollY;
    const bottomAbs = rect.bottom + window.scrollY;
    const parentW = el.parentElement?.clientWidth || vw;
    const fullWidth = rect.width >= vw * 0.45 || rect.width >= parentW * 0.8;
    const nearDocBottom = bottomAbs >= docH - 32 || topAbs >= docH * 0.72;
    const bottomDock = (cs.position === 'fixed' || cs.position === 'sticky')
      && rect.height >= 28 && rect.height <= vh * 0.5
      && rect.width >= vw * 0.35
      && rect.bottom >= vh - 10
      && rect.top > vh * 0.4;

    if (rect.height >= docH * 0.7 && !bottomDock) return 0;
    if (fullWidth) score += 2;
    if (nearDocBottom && rect.height < docH * 0.55) score += 4;
    if (bottomDock) score += 6;

    const parent = el.parentElement;
    if (parent && isLayoutRoot(parent)) {
      const visibleKids = [...parent.children].filter((kid) => {
        try { return getComputedStyle(kid).display !== 'none'; } catch (_) { return true; }
      });
      if (visibleKids[visibleKids.length - 1] === el) score += 4;
    }

    if (el.tagName !== 'FOOTER' && role !== 'contentinfo') {
      let ancestor = parent;
      while (ancestor && ancestor !== document.body) {
        if (NESTED_CONTEXT.has(ancestor.tagName)) { score -= 6; break; }
        ancestor = ancestor.parentElement;
      }
    }

    if (SMALL_TAGS.has(el.tagName) && el.tagName !== 'FOOTER') score -= 8;
    if (rect.width < 8 || rect.height < 8) score -= 4;
    return score;
  };

  const detach = (el) => {
    if (!(el instanceof Element) || detached.has(el) || !el.parentNode || isOwnUi(el)) return;
    if (selectedLineage.has(el)) return;
    detached.add(el);
    window.__fs_detachedNodes.push({ el, parent: el.parentNode, next: el.nextSibling });
    el.parentNode.removeChild(el);
  };

  const hideBar = (el) => {
    if (!(el instanceof Element) || hiddenEls.has(el) || detached.has(el) || isOwnUi(el)) return;
    hiddenEls.add(el);
    el.classList.add(HIDE_CLASS);
    el.setAttribute('data-fs-hidden', '');
    window.__fs_hiddenElements.push({ el, classAdded: true });
  };

  const outermost = (nodes) => {
    const set = new Set(nodes);
    return nodes.filter((el) => {
      let parent = el.parentElement;
      while (parent) {
        if (set.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  };

  const applyTo = (scopeRoot) => {
    const elements = scopeRoot === document
      ? collectElements(document)
      : [scopeRoot, ...collectElements(scopeRoot)];
    const detachHits = [];
    const hideHits = [];
    for (const el of elements) {
      const score = scoreChrome(el);
      if (score >= DETACH_SCORE) detachHits.push(el);
      else if (score >= HIDE_SCORE) hideHits.push(el);
    }
    for (const el of outermost(detachHits)) detach(el);
    for (const el of hideHits) hideBar(el);
  };

  applyTo(document);

  window.__fs_footerObserver?.disconnect();
  window.__fs_footerObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element) || isOwnUi(node) || detached.has(node)) continue;
        applyTo(node);
        if (scoreChrome(node) >= DETACH_SCORE) detach(node);
      }
    }
  });
  try {
    window.__fs_footerObserver.observe(document.documentElement, { subtree: true, childList: true });
  } catch (_) {}
}

/**
 * Injected into the page. Scrolls to top and disables smooth-scroll.
 * Repeating chrome is detached immediately before each tile capture.
 */
function preparePageForCapture() {
  const saveStyle = (el, properties) => el ? {
    el,
    styles: properties.map((property) => [
      property,
      el.style.getPropertyValue(property),
      el.style.getPropertyPriority(property),
    ]),
  } : null;

  const sc = window.__fs_scrollContainer || window;

  window.__fs_captureState = {
    scrollContainer: sc,
    scrollX: sc === window ? window.scrollX : sc.scrollLeft,
    scrollY: sc === window ? window.scrollY : sc.scrollTop,
    html: saveStyle(document.documentElement, ['scroll-behavior']),
    body: saveStyle(document.body, ['scroll-behavior']),
    container: sc === window ? null : saveStyle(sc, ['scroll-behavior']),
  };

  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');
  if (sc !== window && sc.style) sc.style.setProperty('scroll-behavior', 'auto', 'important');

  if (sc === window) window.scrollTo(0, 0);
  else sc.scrollTop = 0;
}

/** Injected into every frame. Restores capture mutations. */
function restorePageAfterCapture() {
  const restoreStyle = (state) => {
    if (!state?.el?.style) return;
    for (const [property, value, priority] of state.styles || []) {
      if (value) state.el.style.setProperty(property, value, priority);
      else state.el.style.removeProperty(property);
    }
  };

  window.__fs_footerObserver?.disconnect();
  window.__fs_footerObserver = null;
  for (const el of window.__fs_footerStyles || []) el.remove();
  window.__fs_footerStyles = null;

  const detached = window.__fs_detachedNodes || [];
  window.__fs_detachedNodes = null;
  for (let i = detached.length - 1; i >= 0; i--) {
    const { el, parent, next } = detached[i];
    if (!el || !parent) continue;
    try {
      if (next && next.parentNode === parent) parent.insertBefore(el, next);
      else parent.appendChild(el);
    } catch (_) {}
  }

  window.__fs_cancelSelection?.();
  document.getElementById('fs-select-root')?.remove();
  document.getElementById('fs-selection-highlight')?.remove();

  for (const state of window.__fs_captureUi || []) restoreStyle({
    el: state.el,
    styles: [['visibility', state.visibility, state.priority]],
  });
  window.__fs_captureUi = null;

  for (const state of window.__fs_hiddenElements || []) {
    restoreStyle(state);
    if (state?.classAdded && state.el) {
      state.el.classList.remove('fs-capture-hide');
      state.el.removeAttribute('data-fs-hidden');
    }
  }
  window.__fs_hiddenElements = null;

  const captureState = window.__fs_captureState;
  if (captureState) {
    restoreStyle(captureState.html);
    restoreStyle(captureState.body);
    restoreStyle(captureState.container);
  }

  restoreStyle(window.__fs_selectedContainerState);
  window.__fs_selectedContainerState = null;

  for (const state of window.__fs_neutralizedAncestors || []) restoreStyle(state);
  window.__fs_neutralizedAncestors = null;

  if (captureState) {
    const sc = captureState.scrollContainer;
    if (sc === window) window.scrollTo(captureState.scrollX, captureState.scrollY);
    else if (sc?.isConnected) {
      sc.scrollLeft = captureState.scrollX;
      sc.scrollTop = captureState.scrollY;
    }
  }

  window.__fs_captureState = null;
  window.__fs_scrollContainer = null;
}

/**
 * Injected into the page. Hides or restores the extension's own overlay so it
 * is not captured. Waits two animation frames after hiding so the paint lands.
 */
function setCaptureUiHidden(hidden) {
  const ids = ['fs-page-progress', 'fs-page-notice', 'fs-selection-highlight', 'fs-select-root'];
  if (hidden) {
    window.__fs_captureUi = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      window.__fs_captureUi.push({
        el,
        visibility: el.style.getPropertyValue('visibility'),
        priority: el.style.getPropertyPriority('visibility'),
      });
      el.style.setProperty('visibility', 'hidden', 'important');
    }
    if (!window.__fs_captureUi.length) {
      window.__fs_captureUi = null;
      return;
    }
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  for (const state of window.__fs_captureUi || []) {
    if (!state?.el?.style) continue;
    if (state.visibility) state.el.style.setProperty('visibility', state.visibility, state.priority);
    else state.el.style.removeProperty('visibility');
  }
  window.__fs_captureUi = null;
}

/** Inject a function into the tab. */
async function injectScript(tabId, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, func, args });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'Capture failed';
}

/** Data URL → Blob */
async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Data URL → ImageBitmap (for service worker, no DOM Image). */
async function dataUrlToBitmap(dataUrl) {
  const res  = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

/** Blob → base64 data URL (chunked to avoid stack overflow on large images). */
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let base64;

  if (typeof bytes.toBase64 === 'function') {
    base64 = bytes.toBase64();
  } else {
    const CHUNK = 8192;
    const chunks = new Array(Math.ceil(bytes.length / CHUNK));
    let chunkIndex = 0;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      chunks[chunkIndex++] = String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    base64 = btoa(chunks.join(''));
  }
  return `data:${blob.type || 'image/png'};base64,${base64}`;
}

async function downloadPng(blob, filename) {
  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (_) {
    const dataUrl = await blobToDataUrl(blob);
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

/**
 * Injected immediately before each tile. Removes repeating chrome from the
 * DOM so page CSS cannot keep it visible. Footers always; headers and
 * position:fixed/sticky when requested. Full-viewport shells are left alone.
 */
function detachCaptureChrome(options = {}) {
  const hideHeaders = !!options.headers;
  const hideFixed = !!options.fixed;
  if (!window.__fs_detachedNodes) window.__fs_detachedNodes = [];
  const seen = new Set(window.__fs_detachedNodes.map((item) => item.el));

  const isOwnUi = (el) => String(el?.id || '').startsWith('fs-');
  const selectedLineage = new Set();
  let selectedAncestor = window.__fs_scrollContainer;
  while (selectedAncestor && selectedAncestor !== window) {
    selectedLineage.add(selectedAncestor);
    const root = selectedAncestor.getRootNode?.();
    selectedAncestor = selectedAncestor.parentElement || root?.host || null;
  }

  const ancestorTaken = (el) => {
    let parent = el.parentElement;
    while (parent) {
      if (seen.has(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const take = (el) => {
    if (!(el instanceof Element) || seen.has(el) || !el.parentNode) return;
    if (isOwnUi(el) || selectedLineage.has(el) || ancestorTaken(el)) return;
    if (el === document.body || el === document.documentElement) return;
    seen.add(el);
    window.__fs_detachedNodes.push({ el, parent: el.parentNode, next: el.nextSibling });
    el.parentNode.removeChild(el);
  };

  const nameBlob = (el) => [
    el.id,
    el.getAttribute('role'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
    typeof el.className === 'string' ? el.className : el.className?.baseVal,
  ].filter(Boolean).join(' ').toLowerCase();

  const looksLikeHeader = (el) => {
    if (el.getAttribute('role') === 'banner') return true;
    const id = (el.id || '').toLowerCase();
    if (['header', 'navbar', 'nav', 'masthead', 'site-header', 'main-header', 'page-header'].includes(id)) {
      return true;
    }
    if (el.tagName === 'HEADER') {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (parent.tagName === 'ARTICLE' || parent.tagName === 'LI') return false;
        parent = parent.parentElement;
      }
      return true;
    }
    return /(^|[\s_-])(navbar|nav-bar|topbar|top-bar|masthead|site-header|main-header|page-header|sticky-header)([\s_-]|$)/.test(nameBlob(el));
  };

  const looksLikeFooter = (el) => {
    if (el.tagName === 'FOOTER' || el.getAttribute('role') === 'contentinfo') return true;
    const id = (el.id || '').toLowerCase();
    if (id === 'footer' || id === 'colophon' || id.endsWith('-footer') || id.endsWith('_footer')) return true;
    return /(^|[\s_-])(footer|colophon|site-footer|page-footer)([\s_-]|$)/.test(nameBlob(el));
  };

  const scan = (root) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    try {
      root.querySelectorAll('footer, #footer, [role="contentinfo"]').forEach(take);
    } catch (_) {}
    if (hideHeaders) {
      try {
        root.querySelectorAll('header, #header, #navbar, #nav, [role="banner"]').forEach(take);
      } catch (_) {}
    }

    let all = [];
    try { all = [...root.querySelectorAll('*')]; } catch (_) {}
    for (const el of all) {
      if (el.shadowRoot) scan(el.shadowRoot);
      if (seen.has(el) || isOwnUi(el) || selectedLineage.has(el)) continue;

      if (looksLikeFooter(el)) { take(el); continue; }
      if (hideHeaders && looksLikeHeader(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.height < vh * 0.6 && rect.width >= vw * 0.4) take(el);
        continue;
      }
      if (!hideFixed) continue;

      let cs;
      try { cs = getComputedStyle(el); } catch (_) { continue; }
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky' && !el.matches?.('dialog[open], [popover]:popover-open')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (rect.width >= vw * 0.85 && rect.height >= vh * 0.8) continue;
      take(el);
    }
  };

  scan(document);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/** `{domain}_{page}_{YYYY-MM-DD}.png` from the captured tab. */
function buildFilename(tab) {
  const { domain, page } = filenamePartsFromTab(tab);
  return `${domain}_${page}_${formatLocalDate(new Date())}.png`;
}

function filenamePartsFromTab(tab) {
  const fallback = { domain: 'page', page: 'capture' };
  const url = tab?.url || '';
  try {
    const parsed = new URL(url);
    let domain = (parsed.hostname || '').replace(/^www\./i, '');
    if (!domain) domain = parsed.protocol === 'file:' ? 'file' : fallback.domain;

    let page = '';
    if (parsed.pathname && parsed.pathname !== '/') {
      page = parsed.pathname
        .replace(/\/+$/, '')
        .split('/')
        .filter(Boolean)
        .map(decodePathSegment)
        .join('-');
    } else if (tab?.title) {
      page = tab.title;
    } else {
      page = 'home';
    }

    return {
      domain: sanitizeFilenamePart(domain) || fallback.domain,
      page: sanitizeFilenamePart(page) || 'home',
    };
  } catch (_) {
    return {
      domain: fallback.domain,
      page: sanitizeFilenamePart(tab?.title || '') || fallback.page,
    };
  }
}

function decodePathSegment(segment) {
  try { return decodeURIComponent(segment); } catch (_) { return segment; }
}

function sanitizeFilenamePart(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Best-effort progress notification to popup. */
function notifyPopup(pct, label) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', pct, label }).catch(() => {});
}

async function notifyPage(tabId, pct, label) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (p, l) => {
        let wrap = document.getElementById('fs-page-progress');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.id = 'fs-page-progress';
          Object.assign(wrap.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            background: '#151820', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px', padding: '16px', color: '#fff',
            fontFamily: 'system-ui, sans-serif', zIndex: '2147483647',
            width: '240px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column', gap: '8px'
          });
          const header = document.createElement('div');
          header.style.display = 'flex';
          header.style.justifyContent = 'space-between';
          header.style.fontSize = '12px';
          const lbl = document.createElement('span');
          lbl.id = 'fs-page-label'; lbl.style.color = '#a0a5b5';
          const pctEl = document.createElement('span');
          pctEl.id = 'fs-page-pct'; pctEl.style.fontWeight = 'bold'; pctEl.style.color = '#8b85ff';
          header.appendChild(lbl); header.appendChild(pctEl); wrap.appendChild(header);
          const barBg = document.createElement('div');
          barBg.style.height = '4px'; barBg.style.background = 'rgba(255,255,255,0.1)';
          barBg.style.borderRadius = '2px'; barBg.style.overflow = 'hidden';
          const barFill = document.createElement('div');
          barFill.id = 'fs-page-fill'; barFill.style.height = '100%';
          barFill.style.background = '#6c63ff'; barFill.style.width = '0%';
          barFill.style.transition = 'width 0.2s';
          barBg.appendChild(barFill); wrap.appendChild(barBg);
          document.body.appendChild(wrap);
        }
        document.getElementById('fs-page-label').textContent = l;
        document.getElementById('fs-page-pct').textContent = Math.round(p) + '%';
        document.getElementById('fs-page-fill').style.width = p + '%';
      },
      args: [pct, label]
    });
  } catch (e) {}
}
