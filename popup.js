// ── popup.js — popup UI ───────────────────────────────────────────────────────
// Protocol constants (CAPTURE_MODES, OUTPUT_TYPES, CHROME_MODES,
// CAPTURABLE_PROTOCOLS, errorMessage) come from shared.js, loaded first in
// popup.html — the same file the service worker loads via importScripts, so
// the popup/background contract has a single definition.

const SETTINGS_KEY = 'captureSettings';

let captureMode = 'full';
let captureOutput = 'clipboard';
let chromeMode = 'clean';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CHECK_ICON = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
const WARN_ICON = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z';

const btnCapture = document.getElementById('btnCapture');
const btnLabel = document.getElementById('btnLabel');
const favicon = document.getElementById('favicon');
const pageTitle = document.getElementById('pageTitle');
const pageUrl = document.getElementById('pageUrl');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressPct = document.getElementById('progressPct');
const progressLabel = document.getElementById('progressLabel');
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toastMsg');
const toastIcon = document.getElementById('toastIcon');
const chromeCard = document.getElementById('chromeCard');
const chromeHint = document.getElementById('chromeHint');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const outputButtons = [...document.querySelectorAll('[data-output]')];
const chromeButtons = [...document.querySelectorAll('[data-chrome]')];

initializePopup().catch((error) => showToast('error', errorMessage(error)));

async function initializePopup() {
  await loadSettings();
  applySettingsToUi();

  favicon.addEventListener('load', () => { favicon.hidden = false; });
  favicon.addEventListener('error', () => {
    favicon.removeAttribute('src');
    favicon.hidden = true;
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => setCaptureMode(button.dataset.mode));
  });
  outputButtons.forEach((button) => {
    button.addEventListener('click', () => setCaptureOutput(button.dataset.output));
  });
  chromeButtons.forEach((button) => {
    button.addEventListener('click', () => setChromeMode(button.dataset.chrome));
  });
  btnCapture.addEventListener('click', startCapture);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  pageTitle.textContent = tab.title || tab.url || 'Current page';
  pageUrl.textContent = tab.url || '';
  if (tab.favIconUrl) favicon.src = tab.favIconUrl;
}

/** Restore the user's last selections; the popup is rebuilt on every open. */
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = stored?.[SETTINGS_KEY] || {};
    if (CAPTURE_MODES.has(settings.mode)) captureMode = settings.mode;
    if (OUTPUT_TYPES.has(settings.output)) captureOutput = settings.output;
    if (CHROME_MODES.has(settings.chrome)) chromeMode = settings.chrome;
  } catch (_) {
    // Storage unavailable — defaults are fine.
  }
}

function persistSettings() {
  // Best-effort: remembering preferences is nice-to-have, not critical.
  chrome.storage.local.set({
    [SETTINGS_KEY]: { mode: captureMode, output: captureOutput, chrome: chromeMode },
  }).catch(() => {});
}

function applySettingsToUi() {
  setSelectedButton(modeButtons, 'mode', captureMode);
  setSelectedButton(outputButtons, 'output', captureOutput);
  setSelectedButton(chromeButtons, 'chrome', chromeMode);
  syncChromeAvailability();
  updateCaptureButtonLabel();
}

function setCaptureMode(mode) {
  if (!CAPTURE_MODES.has(mode)) return;
  captureMode = mode;
  setSelectedButton(modeButtons, 'mode', mode);
  syncChromeAvailability();
  updateCaptureButtonLabel();
  persistSettings();
}

function setCaptureOutput(output) {
  if (!OUTPUT_TYPES.has(output)) return;
  captureOutput = output;
  updateCaptureButtonLabel();
  setSelectedButton(outputButtons, 'output', output);
  persistSettings();
}

function setChromeMode(mode) {
  if (!CHROME_MODES.has(mode) || captureMode === 'select') return;
  chromeMode = mode;
  setSelectedButton(chromeButtons, 'chrome', mode);
  persistSettings();
}

function updateCaptureButtonLabel() {
  if (captureMode === 'select') {
    btnLabel.textContent = captureOutput === 'clipboard' ? 'Select & copy' : 'Select & save';
    return;
  }
  btnLabel.textContent = captureOutput === 'clipboard' ? 'Copy to Clipboard' : 'Save as PNG';
}

function syncChromeAvailability() {
  const disabled = captureMode === 'select';
  chromeCard.classList.toggle('is-disabled', disabled);
  chromeCard.toggleAttribute('inert', disabled);
  chromeCard.setAttribute('aria-disabled', String(disabled));
  chromeButtons.forEach((button) => {
    button.disabled = disabled;
  });
  chromeHint.textContent = disabled
    ? 'Not used for area capture'
    : 'Headers, footers, and sticky bars';
  chromeCard.title = disabled ? 'Clean/Original does not apply to area capture' : '';
}

function setSelectedButton(buttons, dataName, selectedValue) {
  buttons.forEach((button) => {
    const isSelected = button.dataset[dataName] === selectedValue;
    button.classList.toggle('active', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
}

function setProgress(pct, label) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  progressWrap.classList.add('visible');
  progressFill.style.width = `${safePct}%`;
  progressPct.textContent = `${Math.round(safePct)}%`;
  if (label) progressLabel.textContent = label;
}

function hideProgress() {
  progressWrap.classList.remove('visible');
}

function showToast(type, message) {
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', type === 'success' ? CHECK_ICON : WARN_ICON);
  toast.className = `toast visible ${type}`;
  toastMsg.textContent = message;
  toastIcon.replaceChildren(path);
}

async function startCapture() {
  btnCapture.disabled = true;
  toast.classList.remove('visible');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');
    if (!isCapturableUrl(tab.url)) throw new Error('Cannot capture this browser page');

    const payload = {
      type: 'CAPTURE',
      tabId: tab.id,
      mode: captureMode,
      output: captureOutput,
      includeChrome: captureMode === 'select' ? false : chromeMode === 'original',
    };

    // Area capture needs the page, not the popup. Fire the job and close so
    // the drag overlay is visible; the service worker finishes on its own
    // and surfaces any failure as an on-page notice.
    if (captureMode === 'select') {
      chrome.runtime.sendMessage(payload).catch(() => {});
      window.close();
      return;
    }

    setProgress(5, 'Preparing capture...');
    setProgress(15, 'Starting capture...');
    const result = await chrome.runtime.sendMessage(payload);

    if (!result) throw new Error('The capture service did not respond');
    if (result.error) throw new Error(result.error);

    if (captureOutput === 'clipboard') {
      if (result.dataUrl) {
        // Legacy route: the background could not write to the clipboard
        // itself and handed the image to this (focused) popup.
        setProgress(95, 'Copying to clipboard...');
        await copyDataUrlToClipboard(result.dataUrl);
      } else if (!result.success) {
        throw new Error('The clipboard copy did not complete');
      }
      showToast('success', 'Copied to clipboard!');
    } else {
      showToast('success', `Saved: ${result.filename}`);
    }
    setProgress(100, 'Done!');
  } catch (error) {
    hideProgress();
    showToast('error', errorMessage(error));
  } finally {
    btnCapture.disabled = false;
  }
}

function isCapturableUrl(url) {
  try {
    return CAPTURABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

async function copyDataUrlToClipboard(dataUrl) {
  const response = await fetch(dataUrl);
  const image = await response.blob();
  if (image.type !== 'image/png') throw new Error('The capture service did not return a PNG image');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CAPTURE_PROGRESS') {
    setProgress(message.pct, message.label);
  }
});
