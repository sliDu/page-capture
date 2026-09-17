# Page Capture

A lightweight Manifest V3 Chrome/Brave extension. It captures full-page or visible-area screenshots, stitches tiles, and by default strips repeating headers, footers, and sticky/fixed chrome.

## Features

- **Full Page Screenshot:** Scrolls and stitches the entire webpage into one PNG. Tiles are cropped to the content rect, so scrollbars and app chrome around inner scroll panes stay out of the shot.
- **Clean capture (default):** Detects and removes site headers, footers, cookie bars, and `position: fixed` overlays so they do not repeat on every tile. Sticky elements, table headers, and open dialogs are hidden *in place* so the page layout doesn't reflow mid-capture. Nested content (article headers, bylines) is preserved.
- **Original capture:** Optional toggle keeps headers, footers, and overlays as they appear on the live page.
- **Select area:** Click an element to capture it — hovering highlights it like the Windows/OSX snip tools — or drag a rectangle. Elements taller than the viewport are scroll-captured and stitched; width is capped to the visible column. Clean/Original does not apply.
- **Visible:** Capture just the current viewport.
- **Rate-limit resilience:** Throttles and retries `captureVisibleTab` (Chrome/Brave cap ~2 calls/sec).
- **Robust clipboard delivery:** The finished PNG is written to the clipboard from an offscreen document, so a capture still lands even if the popup was closed mid-capture. The popup's clipboard write is only a fallback.
- **Remembered settings:** Mode, destination, and Clean/Original persist across popup opens (`chrome.storage.local`).
- **Outputs:** Copy to clipboard (default) or save as `{domain}_{page}_{YYYY-MM-DD}.png`.

## Installation

1. Open Brave or Chrome and go to `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.

Reload the extension after updates so the service worker picks up changes.

## Usage

- **Clean** (default): strip repeating page chrome on Full page and Visible captures.
- **Original**: capture the page as-is, including headers and footers.
- **Select area**: click an element to capture it (hover shows what will be captured), or drag a rectangle. Clean/Original is ignored.

## Project Structure

- `manifest.json` — Manifest V3 configuration.
- `background.js` — Scrolling, chrome detection, tile capture, stitching, clipboard/download output.
- `shared.js` — Constants shared by every context: the popup↔worker message protocol and the single "what is page chrome" token table.
- `offscreen.html` / `offscreen.js` — Offscreen document that writes finished captures to the clipboard.
- `popup.html` / `popup.js` — Popup UI, persisted preferences, clipboard fallback.
- `icons/` — Extension icons.

The chrome-hiding stylesheet is generated at runtime in `background.js` (`buildChromeHidingCss`) from the same token table the DOM passes use — there is no separate CSS file to keep in sync.
