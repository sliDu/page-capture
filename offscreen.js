// ── offscreen.js — clipboard writer ──────────────────────────────────────────
// Runs in the extension's offscreen document (created by background.js with
// the CLIPBOARD reason). Writing an image to the clipboard requires a document
// context with the Clipboard API — the MV3 service worker cannot do it, and
// the popup may already be closed by the time a long capture finishes. This
// document, covered by the clipboardWrite permission, writes the finished PNG
// regardless of which context has focus.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_CLIPBOARD_WRITE') return false;

  (async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard image writing is unavailable in this browser');
      }
      const response = await fetch(message.dataUrl);
      const blob = await response.blob();
      if (blob.type && blob.type !== 'image/png') {
        throw new Error('The capture service did not return a PNG image');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ error: errorMessage(error) });
    }
  })();

  return true;
});
