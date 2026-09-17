// ── background.js (Service Worker) ────────────────────────────────────────────
//
// NOTE on the "fs-" prefix: this extension was previously called FullSnap and
// the old namespace (window.__fs_*, ids like fs-select-root, classes like
// fs-capture-hide) survives deliberately. It is an internal contract used only
// by this file, so it stays to avoid pointless churn; new code should keep
// using it for consistency.
//
// Full-page screenshot strategy:
//   1. Measure the real scroll container and its content rect (excluding
//      scrollbars and any app chrome surrounding an inner scroll pane),
//      scroll to top, disable smooth-scroll.
//   2. Default CLEAN mode: DETACH footers, headers, and position:fixed chrome
//      so they cannot repeat in every tile. Sticky elements, table cells, and
//      open dialogs are hidden IN PLACE instead — removing them would reflow
//      the page mid-capture or break the dialog's top-layer placement.
//      Original mode keeps everything.
//   3. Scroll tile-by-tile, capturing each viewport with captureVisibleTab()
//      and cropping each tile to the content rect. Uses ACTUAL scrollY (not
//      target) so the last tile lands correctly when scrollHeight isn't a
//      clean multiple of the stride.
//   4. Stitch tiles onto an OffscreenCanvas, drawing each at its actual
//      scrollY. If the page height shrinks mid-capture (late-detached chrome,
//      removed content), the capture restarts so tiles stay aligned.
//   5. Restore hidden elements & original scroll position.
//   6. Copy via the offscreen document, the focused page, or the popup —
//      whichever is available — or save as a PNG file.
//
// Select area: drag a rectangle on the current viewport, capture once, crop.
// Clean/Original chrome stripping does not apply — the crop is what is on screen.
//
// Rate-limit safety: Chrome/Brave caps captureVisibleTab at 2 calls/sec.
// We enforce ≥ 600ms gaps + retry with exponential back-off.

importScripts('shared.js');

const CAPTURE_INTERVAL_MS  = 600;      // min gap between captureVisibleTab calls
const SCROLL_SETTLE_MS     = 350;      // wait for repaint + lazy-load after scroll
const OVERLAY_TEARDOWN_MS  = 80;       // selection overlay cleanup → capture gap
const NOTICE_LIFETIME_MS   = 4000;     // on-page notice auto-dismiss
const SELECTION_TIMEOUT_MS = 120_000;  // abandon an idle area selection
const SW_KEEPALIVE_MS      = 20_000;   // API ping cadence while awaiting selection
const MAX_RETRIES          = 4;
const MAX_TILES            = 200;
const MAX_CANVAS_DIMENSION = 32767;
const MAX_CANVAS_PIXELS    = 100_000_000;
const MAX_CAPTURE_RESTARTS = 2;        // recover from mid-capture layout shifts

// captureVisibleTab is rate-limited for the entire extension, not per tab.
// Serializing calls also prevents two overlapping captures from stitching tiles
// from each other's viewport positions.
const activeCaptures = new Set();
let captureVisibleQueue = Promise.resolve();
let lastVisibleCaptureAt = 0;

// Generated once so insertCSS/removeCSS always see byte-identical text.
const chromeHidingCss = buildChromeHidingCss();

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
  const isSelect = mode === 'select';
  let failure = null;
  // Ownership flag: a rejected duplicate/validation call must NOT tear down
  // the page state or release the lock of the capture that IS running.
  let started = false;

  try {
    // Validation lives INSIDE the try so its finally can surface failures as
    // on-page notices — the popup has already closed in select mode, and a
    // thrown guard used to vanish without a trace.
    if (!Number.isInteger(tabId)) throw new Error('No valid tab was selected');
    if (!CAPTURE_MODES.has(mode)) throw new Error('Unsupported capture mode');
    if (!OUTPUT_TYPES.has(output)) throw new Error('Unsupported output type');
    if (activeCaptures.has(tabId)) throw new Error('A capture is already running for this tab');

    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) throw new Error('Keep the page active while it is being captured');
    // Privileged-side guard: restricted schemes (chrome://, Web Store,
    // devtools) must not reach executeScript/captureVisibleTab no matter
    // which entry point asked. Mirrors CAPTURABLE_PROTOCOLS in shared.js.
    if (!isCapturableUrl(tab.url)) throw new Error('Cannot capture this browser page');

    activeCaptures.add(tabId);
    started = true;

    // A prior failed run may have left temporary page styles behind.  Always
    // reset them before starting a new capture.
    await restoreCaptureState(tabId);

    // `return await` (not bare `return`): the finally below must run AFTER
    // the capture completes, not the moment this try block evaluates.
    if (isSelect) return await captureSelectedRegion(tabId, output, tab.windowId);
    if (mode === 'visible') return await captureVisibleOnly(tabId, output, tab.windowId, includeChrome);
    return await captureFullPage(tabId, output, tab.windowId, includeChrome);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (started) {
      // The popup closes before area capture, so cleanup must be independent
      // of it. Only the invocation that took the lock may release it.
      if (Number.isInteger(tabId)) await restoreCaptureState(tabId).catch(() => {});
      activeCaptures.delete(tabId);
    }
    // Notices are safe for rejected duplicates too: showPageNotice never
    // touches the running capture's overlay.
    if (isSelect && failure && failure.message !== 'Area selection cancelled') {
      await showPageNotice(tabId, failure.message, 'error');
    }
  }
}

// ── Area selection (viewport crop) ────────────────────────────────────────────
async function captureSelectedRegion(tabId, output, windowId) {
  notifyPopup(5, 'Select an area on the page...');
  const selection = await selectAreaRect(tabId);

  notifyPopup(40, 'Capturing selection…');
  await notifyPage(tabId, 40, 'Capturing selection…');
  // Re-pin the viewport to where the user drew the rectangle: momentum wheel
  // events or smooth scrolling during the teardown window can shift it.
  // behavior:'instant' — the two-arg scrollTo form would defer to the page's
  // CSS scroll-behavior and animate instead of pinning.
  await injectScript(tabId, (x, y) => {
    try { window.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch (_) {}
  }, [Number(selection.scrollX) || 0, Number(selection.scrollY) || 0]);
  await sleep(OVERLAY_TEARDOWN_MS);

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
    return await outputResult(blob, output, true, tabId);
  } finally {
    bitmap.close();
  }
}

async function selectAreaRect(tabId) {
  // An idle service worker is evicted after ~30s, which would silently kill
  // this capture while the user is still deciding. A periodic extension API
  // call resets the idle timer for as long as the selection is pending.
  const heartbeat = setInterval(() => {
    chrome.tabs.get(tabId).catch(() => {});
  }, SW_KEEPALIVE_MS);

  const injected = chrome.scripting.executeScript({
    target: { tabId },
    func: () => new Promise((resolve) => {
      // Replacing an unfinished selection must also resolve its old promise;
      // otherwise its service-worker capture remains locked forever.
      window.__fs_cancelSelection?.();
      document.getElementById('fs-select-root')?.remove();

      const MIN_SIZE = 8;
      const SIZE_LABEL_MARGIN_X = 88;  // keeps the size badge inside the viewport
      const SIZE_LABEL_MARGIN_Y = 24;
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
        size.style.left = `${Math.min(left, Math.max(0, vw - SIZE_LABEL_MARGIN_X))}px`;
        size.style.top = `${Math.min(top + height + 8, vh - SIZE_LABEL_MARGIN_Y)}px`;
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
        // `finished` matters: wheel events in the teardown window would
        // scroll the viewport away from the frozen selection rectangle.
        if (finished || !dragging) return;
        window.scrollBy(e.deltaX, e.deltaY);
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
          // Capture the scroll offset the rectangle was drawn at so the
          // service worker can restore it before pulling pixels.
          scrollX: window.scrollX,
          scrollY: window.scrollY,
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

  let result;
  try {
    result = await Promise.race([
      injected.then((r) => (r && r[0] ? r[0].result : null)),
      sleep(SELECTION_TIMEOUT_MS).then(() => 'timed-out'),
    ]);
  } finally {
    clearInterval(heartbeat);
  }

  if (result === 'timed-out') {
    // Remove the overlay ourselves; if the user finishes a drag afterwards,
    // the still-pending injected promise resolves into the void harmlessly.
    await injectScript(tabId, () => {
      window.__fs_cancelSelection?.();
      document.getElementById('fs-select-root')?.remove();
    }).catch(() => {});
    throw new Error('Area selection cancelled');
  }
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
    // First pass only detects and caches the scroll container (prepare needs
    // it); the measurements consumed below are taken AFTER preparation.
    await getPageMetrics(tabId);

    notifyPopup(12, 'Preparing page…');
    await prepareCapturePage(tabId, includeChrome);
    pagePrepared = true;
    await sleep(SCROLL_SETTLE_MS);

    // Re-measure AFTER chrome hiding: detaching/display:none-ing elements
    // above or beside the container shifts its rect, and the stitcher would
    // sample every tile with a stale crop.
    const metrics = await getPageMetrics(tabId);
    // Stride = rows of CONTENT advance per tile, clamped to what one tile can
    // actually photograph (a container clipped by the viewport bottom shows
    // fewer rows than its clientHeight). Coverage = full rows the container
    // can show at its final scroll position, used for bottom-edge sizing.
    const { stride, coverageHeight, crop } = metrics;

    const scrollHeight = await getScrollHeight(tabId);

    // Fail fast: the projected canvas size is known before the first tile.
    // Don't let the user watch a progress bar climb for minutes towards a
    // failure that was predictable up front.
    const estW = Math.ceil(crop.width * metrics.devicePixelRatio);
    const estH = Math.ceil(scrollHeight * metrics.devicePixelRatio);
    if (estW > MAX_CANVAS_DIMENSION || estH > MAX_CANVAS_DIMENSION
      || estW * estH > MAX_CANVAS_PIXELS * 1.25) {
      throw new Error('The captured image is too large for the browser to create safely');
    }

    const numTiles = Math.max(1, Math.ceil(scrollHeight / stride));
    notifyPopup(14, `Estimated ${numTiles} tile${numTiles > 1 ? 's' : ''} to capture…`);

    const tiles = [];
    let prevScrollY = -1;
    let lastStableHeight = scrollHeight;
    let restarts = 0;
    let i = 0;

    while (true) {
      if (i >= MAX_TILES) {
        const latestHeight = await getScrollHeight(tabId);
        if (prevScrollY + coverageHeight < latestHeight - 0.5) {
          throw new Error(`This page needs more than ${MAX_TILES} screenshot tiles`);
        }
        break;
      }

      // runInTab (allFrames) so the in-flight flag is set in every frame the
      // chrome detectors run in; only the main frame drives the scroll.
      await runInTab(tabId, (y) => {
        // Flags the capture as "tiles in flight" for the injected chrome
        // logic: in-flow DOM removal from here on would shift content that
        // earlier tiles already photographed.
        window.__fs_captureScrollStarted = true;
        if (window.top !== window) return;
        const sc = window.__fs_scrollContainer;
        if (sc && sc !== window) sc.scrollTop = y;
        else window.scrollTo(0, y);
      }, [i * stride]);
      await sleep(SCROLL_SETTLE_MS);

      const actualScrollY = await getScrollY(tabId);
      if (Math.abs(actualScrollY - prevScrollY) < 0.5) break;

      const heightNow = await getScrollHeight(tabId);
      if (heightNow < lastStableHeight - 1) {
        // Content above the viewport was removed between tiles — every tile
        // captured so far is misaligned with what follows. Restart from the
        // top; if restarts run out, continue best-effort.
        if (tiles.length > 0 && restarts < MAX_CAPTURE_RESTARTS) {
          restarts++;
          tiles.length = 0;
          prevScrollY = -1;
          i = 0;
          continue;
        }
        lastStableHeight = heightNow;
      } else {
        lastStableHeight = Math.max(lastStableHeight, heightNow);
      }

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
    let blob;
    try {
      // Scale of the FULL viewport bitmap (captureVisibleTab includes classic
      // scrollbars; the crop rect below carves them back out).
      const scaleX = firstBitmap.width / Math.max(1, metrics.innerWidth);
      const scaleY = firstBitmap.height / Math.max(1, metrics.innerHeight);

      // Never size the canvas beyond what the tiles actually cover: on
      // infinite-scroll pages the height can keep growing right after the
      // last tile, which would leave a transparent band at the bottom.
      // The last tile contributes up to coverageHeight rows (its full
      // clientHeight), which can exceed the stride when tiles overlap.
      const lastCoverage = tiles[tiles.length - 1].scrollY + coverageHeight;
      const measuredHeight = Math.max(0, capturedScrollHeight || scrollHeight);
      const pageHeight = Math.min(measuredHeight, lastCoverage);
      const canvasW = Math.max(1, Math.round(crop.width * scaleX));
      const canvasH = Math.max(1, Math.ceil(pageHeight * scaleY));

      if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0
        || canvasW > MAX_CANVAS_DIMENSION || canvasH > MAX_CANVAS_DIMENSION
        || canvasW * canvasH > MAX_CANVAS_PIXELS) {
        throw new Error('The captured image is too large for the browser to create safely');
      }

      const canvas = new OffscreenCanvas(canvasW, canvasH);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Unable to prepare the screenshot image');
      ctx.imageSmoothingEnabled = false;

      // Crop window in bitmap pixels: scrollbar columns/rows and any app
      // chrome surrounding an inner scroll container stay out of the output.
      const sourceX = Math.max(0, Math.min(firstBitmap.width - 1, Math.round(crop.left * scaleX)));
      const sourceY = Math.max(0, Math.min(firstBitmap.height - 1, Math.round(crop.top * scaleY)));
      const sourceW = Math.max(1, Math.min(
        firstBitmap.width - sourceX,
        Math.round(crop.width * scaleX)
      ));

      for (let t = 0; t < tiles.length; t++) {
        const tile = tiles[t];
        const spct = 82 + Math.round((t / tiles.length) * 12);
        notifyPopup(spct, 'Stitching tiles…');

        const bitmap = t === 0 ? firstBitmap : await dataUrlToBitmap(tile.dataUrl);
        const nextScrollY = t + 1 < tiles.length ? tiles[t + 1].scrollY : pageHeight;
        const destY = Math.max(0, Math.round(tile.scrollY * scaleY));
        const destEnd = t + 1 < tiles.length
          ? Math.min(canvasH, Math.round(nextScrollY * scaleY))
          : canvasH;
        const drawH = Math.min(bitmap.height - sourceY, Math.max(0, destEnd - destY));

        if (drawH > 0 && destY < canvasH) {
          ctx.drawImage(bitmap, sourceX, sourceY, sourceW, drawH, 0, destY, sourceW, drawH);
        }
        if (bitmap !== firstBitmap) bitmap.close();
      }

      blob = await canvas.convertToBlob({ type: 'image/png' });
    } finally {
      firstBitmap.close();
    }

    notifyPopup(95, output === 'clipboard' ? 'Preparing clipboard…' : 'Saving PNG…');
    return await outputResult(blob, output, false, tabId);
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
    await insertChromeCss(tabId);
  } catch (_) {
    // The backup stylesheet is best-effort; the DOM detach pass below still
    // runs and is the primary mechanism.
  }
  await runInTab(tabId, markFooterElements, [CHROME_TOKENS]);
}

/**
 * Builds the author-origin stylesheet injected during clean captures. Unlike
 * the old static hide-footer.css file, these selectors are generated from the
 * same CHROME_TOKENS table the DOM passes use, and every chrome selector is
 * scoped with a :not() so nested content (article headers, bylines, table
 * cells) is never hidden.
 */
function buildChromeHidingCss() {
  const nested = `:not(:is(${CHROME_TOKENS.nestedTags.map((t) => t.toLowerCase()).join(',')}) *)`;
  const selectors = [
    `html body footer${nested}`,
    `html body header${nested}`,
    `html body [role="contentinfo"]${nested}`,
    `html body [role="banner"]${nested}`,
    ...CHROME_TOKENS.footerIds.map((id) => `html body #${id}${nested}`),
    ...CHROME_TOKENS.headerIds.map((id) => `html body #${id}${nested}`),
    ...CHROME_TOKENS.footerClassTokens.map((cls) => `html body .${cls}${nested}`),
    ...CHROME_TOKENS.headerClassTokens.map((cls) => `html body .${cls}${nested}`),
    // Markers applied by markFooterElements' hide tier.
    'html body .fs-capture-hide',
    'html body [data-fs-hidden]',
  ];
  return `${selectors.join(',\n')} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
}`;
}

async function insertChromeCss(tabId) {
  const targets = [{ tabId, allFrames: true }, { tabId }];
  let lastError;
  for (const target of targets) {
    try {
      await chrome.scripting.insertCSS({ target, css: chromeHidingCss, origin: 'AUTHOR' });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to inject chrome-hiding CSS');
}

async function removeChromeCss(tabId) {
  // removeCSS matches on exact css text; the same generated string removes
  // the sheet from whichever target it landed in.
  for (const target of [{ tabId, allFrames: true }, { tabId }]) {
    try {
      await chrome.scripting.removeCSS({ target, css: chromeHidingCss, origin: 'AUTHOR' });
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
  await removeChromeCss(tabId);
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
    // Same stripping as clean full-page captures — "Clean" must mean the same
    // thing in both modes.
    hideHeaders: !includeChrome,
    hideFixed: !includeChrome,
    includeChrome,
  });

  notifyPopup(80, output === 'clipboard' ? 'Preparing clipboard…' : 'Saving PNG…');
  const blob = await dataUrlToBlob(dataUrl);
  return await outputResult(blob, output, false, tabId);
}

// ────────────────────────────────────────────────────────────────────────────
//  OUTPUT: clipboard (offscreen page, focused page, or popup) or file
// ────────────────────────────────────────────────────────────────────────────
async function outputResult(blob, output, isSelect, tabId) {
  if (output === 'clipboard') {
    // Try the most reliable writer first; each fallback covers a different
    // failure mode. The popup closing mid-capture used to discard finished
    // captures silently — the offscreen writer makes delivery independent of
    // any particular context surviving.
    let copied = false;
    try {
      await copyBlobViaOffscreen(blob);
      copied = true;
    } catch (_) { /* offscreen unavailable — fall through */ }

    if (!copied) {
      // The selected page is focused whenever the popup is closed, so the
      // Clipboard API can run in the page itself.
      try {
        await notifyPage(tabId, 97, 'Copying to clipboard…');
        await copyBlobToClipboard(tabId, blob);
        copied = true;
      } catch (_) { /* page not focused or injection blocked — fall through */ }
    }

    if (copied) {
      notifyPopup(100, 'Done!');
      await showPageNotice(tabId, 'Copied to clipboard', 'success');
      return { success: true };
    }

    if (isSelect) {
      // The popup is closed in select mode — nobody can receive a dataUrl
      // handoff. Fail loudly instead of stranding the progress widget and
      // silently discarding the capture.
      throw new Error('Copy to clipboard failed');
    }

    // Last resort: hand the image to the popup, which can write it while it
    // holds focus. Clean up the on-page progress widget and point the user
    // at the popup; if the popup already closed, the notice says where the
    // copy was meant to finish.
    await showPageNotice(tabId, 'Finishing clipboard copy in the popup', 'success');
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

let offscreenCreating = null;

/** Create the offscreen clipboard document once; safe to call concurrently. */
async function ensureOffscreenDocument() {
  let contexts;
  try {
    contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  } catch (_) { /* older Chrome: fall through and try to create */ }
  if (contexts && contexts.length > 0) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy finished screenshots to the clipboard when the popup has closed.',
    }).catch((error) => {
      // Without runtime.getContexts (Chrome < 116) an existing document
      // cannot be detected — treat "already exists" as success.
      if (!/single offscreen document/i.test(String(error?.message || ''))) throw error;
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function copyBlobViaOffscreen(blob) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_CLIPBOARD_WRITE',
    dataUrl: await blobToDataUrl(blob),
  });
  if (!response?.success) {
    throw new Error(response?.error || 'The offscreen clipboard write failed');
  }
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
    // lifetimeMs arrives via args: injected functions cannot close over
    // service-worker constants. fs-select-root is deliberately NOT removed
    // here — a live selection overlay belongs to the capture in flight.
    await injectScript(tabId, (text, noticeType, lifetimeMs) => {
      document.getElementById('fs-page-progress')?.remove();
      document.getElementById('fs-page-notice')?.remove();

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
      setTimeout(() => notice.remove(), lifetimeMs);
    }, [message, type, NOTICE_LIFETIME_MS]);
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
      let tab = await chrome.tabs.get(tabId);
      if (!tab.active || tab.windowId !== windowId) {
        throw new Error('Keep the selected tab active until the capture completes');
      }

      const elapsed = Date.now() - lastVisibleCaptureAt;
      if (elapsed < CAPTURE_INTERVAL_MS) await sleep(CAPTURE_INTERVAL_MS - elapsed);

      if (!options.includeChrome) {
        await runInTab(tabId, detachCaptureChrome, [chromeOptions, CHROME_TOKENS]);
      }
      if (hideUi) await injectScript(tabId, setCaptureUiHidden, [true]);

      // captureVisibleTab is window-scoped, not tab-scoped, and awaits have
      // run since the check above — re-verify right before pulling pixels so
      // a tab switch cannot splice another tab's content into this capture.
      tab = await chrome.tabs.get(tabId);
      if (!tab.active || tab.windowId !== windowId) {
        throw new Error('Keep the selected tab active until the capture completes');
      }
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
      // Back off only when another attempt will actually follow; sleeping
      // after the final attempt just stalls the user and every queued
      // capture behind this one.
      if (attempt < MAX_RETRIES && err.message
        && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        const backoff = CAPTURE_INTERVAL_MS * Math.pow(2, attempt + 1);
        await sleep(backoff);
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/** Get page dimensions: scroll container, stride, and content crop rect. */
async function getPageMetrics(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 1-pixel test to find the real scroll container
      function testScroll(el) {
        // For window probes, smooth scrolling must be disabled on the
        // document element — window has no .style of its own, and an animated
        // scrollTo reads back the OLD scrollY synchronously, so a perfectly
        // scrollable window would otherwise test as unscrollable.
        const styleTargets = el === window
          ? [document.documentElement, document.body]
          : [el];
        const saved = styleTargets.map((t) => (t && t.style) ? [
          t.style.getPropertyValue('scroll-behavior'),
          t.style.getPropertyPriority('scroll-behavior'),
        ] : null);
        for (const t of styleTargets) {
          if (t && t.style) t.style.setProperty('scroll-behavior', 'auto', 'important');
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

        styleTargets.forEach((t, i) => {
          if (!t || !t.style) return;
          const [value, priority] = saved[i] || ['', ''];
          if (value) t.style.setProperty('scroll-behavior', value, priority);
          else t.style.removeProperty('scroll-behavior');
        });
        return res;
      }

      let sc = window.__fs_scrollContainer;
      if (sc && sc !== window && !sc.isConnected) sc = null;

      if (!sc) {
        const doc = document.documentElement;
        const body = document.body;
        const windowScrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);

        // Largest inner scrollable pane by client area. Code blocks and side
        // lists scroll a little too, so the winner is compared against the
        // window's own scroll range below.
        let bestEl = null;
        let bestRange = 0;
        let maxArea = 0;
        const els = document.querySelectorAll('*');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const range = el.scrollHeight - el.clientHeight;
          if (range > 1 && el.clientHeight > 0) {
            const area = el.clientWidth * el.clientHeight;
            if (area > maxArea) {
              maxArea = area;
              bestEl = el;
              bestRange = range;
            }
          }
        }

        // Prefer the window only when it carries the meaningful scroll range.
        // App-shell pages can leave the document a few pixels scrollable while
        // the real content scrolls in an inner pane — the old "window wins if
        // it scrolls at all" rule truncated those captures to one tile.
        const windowRange = windowScrollHeight - window.innerHeight;
        const preferWindow = !bestEl || windowRange > bestRange;

        if (preferWindow && testScroll(window)) {
          sc = window;
        } else if (bestEl && testScroll(bestEl)) {
          sc = bestEl;
        } else if (document.scrollingElement && document.scrollingElement !== window
          && testScroll(document.scrollingElement)) {
          sc = document.scrollingElement;
        } else {
          sc = window;
        }
        window.__fs_scrollContainer = sc;
      }

      const isWindow = sc === window;
      const doc = document.documentElement;
      // Viewport element per compat mode: documentElement in standards mode,
      // body in quirks mode (documentElement.clientHeight is the DOCUMENT
      // height there, not the viewport).
      const vpEl = document.scrollingElement || doc;
      let coverageHeight;
      let scrollHeight;
      let crop;
      if (isWindow) {
        // clientWidth/Height exclude classic scrollbars, which
        // captureVisibleTab includes — the stitcher crops them back out.
        coverageHeight = vpEl?.clientHeight || window.innerHeight;
        scrollHeight = Math.max(doc?.scrollHeight || 0, document.body?.scrollHeight || 0);
        crop = {
          left: 0,
          top: 0,
          width: vpEl?.clientWidth || window.innerWidth,
          height: coverageHeight,
        };
      } else {
        coverageHeight = sc.clientHeight;
        scrollHeight = sc.scrollHeight;
        const rect = sc.getBoundingClientRect();
        // Clip the container's rect to the viewport: the crop must never
        // extend past what a single tile can actually photograph, and the
        // chrome around an inner scroll pane stays out of every tile.
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(rect.right, window.innerWidth);
        const bottom = Math.min(rect.bottom, window.innerHeight);
        crop = {
          left,
          top,
          width: Math.max(1, Math.min(sc.clientWidth, right - left)),
          height: Math.max(1, Math.min(coverageHeight, bottom - top)),
        };
      }

      // Stride: advance by no more than the rows visible in one tile, or the
      // rows between tile boundaries are never photographed (tiles then
      // overlap slightly instead of skipping content).
      const stride = Math.max(1, Math.min(coverageHeight, crop.height));

      return {
        scrollHeight: Math.max(scrollHeight, coverageHeight),
        stride,
        coverageHeight,
        crop,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
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
 * CSS cannot keep it visible. Receives the shared CHROME_TOKENS table via
 * args — injected functions cannot close over service-worker scope.
 */
function markFooterElements(T = {}) {
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
  const NESTED_CONTEXT = new Set(T.nestedTags || []);
  const LAYOUT_IDS = new Set(['root', 'app', '__next', '__nuxt', 'page', 'wrapper', 'container']);
  const STRONG_NAMES = new Set(T.strongFooterTokens || []);
  const CHROME_NAMES = new Set(T.cookieTokens || []);
  const WEAK_NAMES = new Set(T.weakFooterTokens || []);
  const NEGATIVE_NAMES = new Set(T.negativeTokens || []);

  if (!window.__fs_hiddenElements) window.__fs_hiddenElements = [];
  if (!window.__fs_detachedNodes) window.__fs_detachedNodes = [];
  if (!window.__fs_styleHidden) window.__fs_styleHidden = [];

  const detached = new Set(window.__fs_detachedNodes.map((item) => item.el));
  const hiddenEls = new Set(window.__fs_hiddenElements.map((item) => item.el));
  const styleHiddenEls = new Set(window.__fs_styleHidden.map((item) => item.el));

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

    // Nested-content gate (mirrors detachCaptureChrome and the generated
    // CSS): an element inside an article/list/table cell is content, not
    // chrome — an article's <footer>byline</footer> must survive. Out-of-flow
    // elements (fixed/sticky) are exempt: a fixed cookie bar wrapped in a
    // <section> is still chrome.
    {
      let ancestor = el.parentElement;
      let nested = false;
      while (ancestor && ancestor !== document.body) {
        if (NESTED_CONTEXT.has(ancestor.tagName)) { nested = true; break; }
        ancestor = ancestor.parentElement;
      }
      if (nested && cs.position !== 'fixed' && cs.position !== 'sticky') return 0;
    }

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

    if (SMALL_TAGS.has(el.tagName) && el.tagName !== 'FOOTER') score -= 8;
    if (rect.width < 8 || rect.height < 8) score -= 4;
    return score;
  };

  const hideInPlace = (el) => {
    if (!(el instanceof Element) || styleHiddenEls.has(el) || !el.isConnected) return;
    if (isOwnUi(el) || selectedLineage.has(el)) return;
    styleHiddenEls.add(el);
    window.__fs_styleHidden.push({
      el,
      visibility: el.style.getPropertyValue('visibility'),
      priority: el.style.getPropertyPriority('visibility'),
    });
    el.style.setProperty('visibility', 'hidden', 'important');
  };

  // Once tiles are in flight, removing an in-flow element would shift content
  // that earlier tiles already photographed. Only out-of-flow elements (or
  // elements at the very bottom, with nothing below to shift) may be removed;
  // everything else is hidden in place instead.
  const isLayoutSafeToRemove = (el) => {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.position === 'fixed') return true;
    if (cs.position === 'sticky') return false;
    const rect = el.getBoundingClientRect();
    const docH = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      window.innerHeight,
    );
    return rect.bottom + window.scrollY >= docH - 32;
  };

  const detach = (el) => {
    if (!(el instanceof Element) || detached.has(el) || !el.parentNode || isOwnUi(el)) return;
    if (selectedLineage.has(el)) return;
    if (window.__fs_captureScrollStarted && !isLayoutSafeToRemove(el)) {
      hideInPlace(el);
      return;
    }
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

  window.__fs_captureScrollStarted = false;

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

  for (const state of window.__fs_captureUi || []) {
    if (!state?.el?.style) continue;
    if (state.visibility) state.el.style.setProperty('visibility', state.visibility, state.priority);
    else state.el.style.removeProperty('visibility');
  }
  window.__fs_captureUi = null;

  // Elements hidden with visibility (sticky chrome, dialogs, late additions):
  // they kept their layout space, so restoring is just un-hiding.
  for (const state of window.__fs_styleHidden || []) {
    if (!state?.el?.style) continue;
    if (state.visibility) state.el.style.setProperty('visibility', state.visibility, state.priority);
    else state.el.style.removeProperty('visibility');
  }
  window.__fs_styleHidden = null;

  for (const state of window.__fs_hiddenElements || []) {
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
  window.__fs_captureScrollStarted = null;
}

/**
 * Injected into the page. Hides or restores the extension's own overlay so it
 * is not captured. Waits two animation frames after hiding so the paint lands.
 */
function setCaptureUiHidden(hidden) {
  const ids = ['fs-page-progress', 'fs-page-notice', 'fs-select-root'];
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
  // Service workers cannot create blob: URLs (URL.createObjectURL is not
  // available there), so downloads always go through a data URL.
  const dataUrl = await blobToDataUrl(blob);
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (err) {
    // Cancelling the Save As dialog is a deliberate user action, not a
    // failure — surface it as such instead of a raw API error.
    if (/cancel/i.test(String(err?.message || ''))) throw new Error('Download cancelled');
    throw err;
  }
}

/**
 * Injected immediately before each tile. Removes repeating chrome from the
 * DOM so page CSS cannot keep it visible. Footers always; headers and
 * position:fixed/sticky when requested. Full-viewport shells are left alone.
 * Receives the shared CHROME_TOKENS table via args.
 */
function detachCaptureChrome(options = {}, T = {}) {
  const hideHeaders = !!options.headers;
  const hideFixed = !!options.fixed;
  if (!window.__fs_detachedNodes) window.__fs_detachedNodes = [];
  if (!window.__fs_styleHidden) window.__fs_styleHidden = [];
  const seen = new Set(window.__fs_detachedNodes.map((item) => item.el));
  const styleHidden = new Set(window.__fs_styleHidden.map((item) => item.el));

  const NESTED_TAGS = new Set(T.nestedTags || []);
  const HEADER_IDS = new Set(T.headerIds || []);
  const FOOTER_IDS = new Set(T.footerIds || []);
  const HEADER_TOKENS = new Set(T.headerClassTokens || []);
  const FOOTER_TOKENS = new Set([...(T.footerClassTokens || []), ...(T.strongFooterTokens || [])]);

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

  const nameBlob = (el) => [
    el.id,
    el.getAttribute('role'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
    typeof el.className === 'string' ? el.className : el.className?.baseVal,
  ].filter(Boolean).join(' ').toLowerCase();

  const tokensOf = (str) => String(str)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  const hasToken = (el, tokens) => {
    if (!tokens.size) return false;
    // Candidate names include BOTH split tokens (camelCase/punctuation torn
    // apart) and raw whitespace-split words, so hyphenated table entries like
    // 'site-header' match a class="site-header" / id="site-header" verbatim —
    // tokensOf alone can never produce a hyphen.
    const blob = nameBlob(el);
    const toks = new Set(tokensOf(blob));
    for (const raw of blob.split(/\s+/)) toks.add(raw);
    if (el.id) toks.add(el.id.toLowerCase());
    for (const token of tokens) {
      if (toks.has(token)) return true;
    }
    return false;
  };

  // Nested content guard: an element inside an article/list/table cell is
  // page content (bylines, per-article footers, table headers), never chrome.
  const inNestedContext = (el) => {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      if (NESTED_TAGS.has(parent.tagName)) return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const hideInPlace = (el) => {
    if (!(el instanceof Element) || styleHidden.has(el) || seen.has(el) || !el.isConnected) return;
    if (isOwnUi(el) || selectedLineage.has(el)) return;
    styleHidden.add(el);
    window.__fs_styleHidden.push({
      el,
      visibility: el.style.getPropertyValue('visibility'),
      priority: el.style.getPropertyPriority('visibility'),
    });
    el.style.setProperty('visibility', 'hidden', 'important');
  };

  // Once tiles are in flight, removing an in-flow element would shift content
  // that earlier tiles already photographed. Only out-of-flow elements (or
  // elements at the very bottom, with nothing below to shift) may be removed;
  // everything else is hidden in place instead.
  const isLayoutSafeToRemove = (el) => {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.position === 'fixed') return true;
    if (cs.position === 'sticky') return false;
    const rect = el.getBoundingClientRect();
    const docH = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      window.innerHeight,
    );
    return rect.bottom + window.scrollY >= docH - 32;
  };

  const take = (el) => {
    if (!(el instanceof Element) || seen.has(el) || !el.parentNode) return;
    if (isOwnUi(el) || selectedLineage.has(el) || ancestorTaken(el)) return;
    if (el === document.body || el === document.documentElement) return;
    if (window.__fs_captureScrollStarted && !isLayoutSafeToRemove(el)) {
      hideInPlace(el);
      return;
    }
    seen.add(el);
    window.__fs_detachedNodes.push({ el, parent: el.parentNode, next: el.nextSibling });
    el.parentNode.removeChild(el);
  };

  // Semantic markers (tags, roles, well-known ids) are trusted outright;
  // fuzzy NAME matches must also pass a geometry sanity check so
  // footer-named CONTENT (bylines, comment sections) survives.
  const semanticHeader = (el) => el.tagName === 'HEADER'
    || el.getAttribute('role') === 'banner'
    || HEADER_IDS.has((el.id || '').toLowerCase());
  const semanticFooter = (el) => el.tagName === 'FOOTER'
    || el.getAttribute('role') === 'contentinfo'
    || FOOTER_IDS.has((el.id || '').toLowerCase());

  const scan = (root) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let all = [];
    try { all = [...root.querySelectorAll('*')]; } catch (_) {}
    for (const el of all) {
      if (el.shadowRoot) scan(el.shadowRoot);
      if (seen.has(el) || isOwnUi(el) || selectedLineage.has(el)) continue;

      if (semanticFooter(el) || hasToken(el, FOOTER_TOKENS)) {
        if (!inNestedContext(el)) {
          if (semanticFooter(el)) {
            take(el);
          } else {
            const rect = el.getBoundingClientRect();
            if (rect.height > 0 && rect.height < vh * 0.6 && rect.width >= vw * 0.4) take(el);
          }
        }
        continue;
      }
      if (hideHeaders && (semanticHeader(el) || hasToken(el, HEADER_TOKENS))) {
        if (!inNestedContext(el)) {
          if (semanticHeader(el)) {
            take(el);
          } else {
            const rect = el.getBoundingClientRect();
            if (rect.height > 0 && rect.height < vh * 0.6 && rect.width >= vw * 0.4) take(el);
          }
        }
        continue;
      }
      if (!hideFixed) continue;

      let cs;
      try { cs = getComputedStyle(el); } catch (_) { continue; }
      const pos = cs.position;
      const isTopLayerOverlay = el.matches?.('dialog[open], [popover]:popover-open');
      if (pos !== 'fixed' && pos !== 'sticky' && !isTopLayerOverlay) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (rect.width >= vw * 0.85 && rect.height >= vh * 0.8) continue;

      if (pos === 'fixed' && !isTopLayerOverlay) {
        // Out of flow: removing it cannot shift page content.
        take(el);
      } else {
        // Sticky elements and open dialogs/popovers are in flow (or in the
        // top layer): removing them would reflow the page mid-capture, and
        // per spec removing a showing popover hides it — re-insertion does
        // not restore top-layer placement. Note dialog:modal and [popover]
        // default to position:fixed, so the flag must gate the fixed branch
        // too, not just add candidates. Hiding in place keeps layout, table
        // structure, and the dialog intact through the capture and after.
        hideInPlace(el);
      }
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

/** True for schemes the extension may capture (mirrors the popup's check). */
function isCapturableUrl(url) {
  try {
    return CAPTURABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch (_) {
    return false;
  }
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
