# Page Capture

A lightweight Manifest V3 Chrome/Brave extension. It captures full-page or visible-area screenshots, stitches tiles, and by default strips repeating headers, footers, and sticky/fixed chrome.

## Features

- **Full Page Screenshot:** Scrolls and stitches the entire webpage into one PNG.
- **Clean capture (default):** Detects and removes site headers, footers, cookie bars, and `position: fixed` / `sticky` overlays so they do not repeat on every tile.
- **Original capture:** Optional toggle keeps headers, footers, and overlays as they appear on the live page.
- **Select area:** Drag a rectangle on the current view. Clean/Original does not apply.
- **Visible:** Capture just the current viewport.
- **Rate-limit resilience:** Throttles and retries `captureVisibleTab` (Chrome/Brave cap ~2 calls/sec).
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
- **Select area**: drag a rectangle on the current view. Clean/Original is ignored.

## Project Structure

- `manifest.json` — Manifest V3 configuration.
- `background.js` — Scrolling, chrome detection, tile capture, stitching.
- `hide-footer.css` — CSP-safe backup hide rules (injected via `insertCSS`).
- `popup.html` / `popup.js` — Popup UI and clipboard write.
- `icons/` — Extension icons.
