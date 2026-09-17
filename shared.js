// ── shared.js ────────────────────────────────────────────────────────────────
// Loaded by EVERY extension context: the service worker (via importScripts in
// background.js), the popup (<script src="shared.js"> before popup.js), and
// the offscreen clipboard document. Keep this file declaration-only — no
// chrome.* calls — so it stays safe to load anywhere.

// Message protocol between popup and service worker. Single source of truth;
// do not re-declare copies in popup.js / background.js.
const CAPTURE_MODES = new Set(['full', 'select', 'visible']);
const OUTPUT_TYPES = new Set(['clipboard', 'file']);
const CHROME_MODES = new Set(['clean', 'original']);
const CAPTURABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

// Single source of truth for "what counts as repeating page chrome" (headers,
// footers, cookie bars). Consumed by:
//   • markFooterElements()   — prepare-time DOM scoring (background.js)
//   • detachCaptureChrome()  — per-tile DOM detachment (background.js)
//   • buildChromeHidingCss() — generated author stylesheet (background.js)
// Injected page functions receive this table via executeScript args because
// they are serialized and cannot close over this file's scope. Before this
// table existed the three consumers each kept a private token list and they
// had already drifted apart.
const CHROME_TOKENS = {
  headerIds: ['header', 'navbar', 'nav', 'masthead'],
  headerClassTokens: [
    'site-header', 'main-header', 'page-header', 'sticky-header',
    'navbar', 'nav-bar', 'topbar', 'top-bar', 'masthead',
  ],
  footerIds: ['footer', 'colophon'],
  footerClassTokens: [
    'site-footer', 'page-footer', 'global-footer', 'main-footer',
    'app-footer', 'footer', 'colophon',
  ],
  strongFooterTokens: [
    'footer', 'colophon', 'sitefooter', 'pagefooter', 'globalfooter',
    'mainfooter', 'appfooter', 'sitefoot', 'pagefoot', 'footwrap',
  ],
  cookieTokens: [
    'cookie', 'consent', 'gdpr', 'onetrust', 'cookiebanner', 'cookiebar',
    'cookieconsent', 'bottomnav', 'bottombar', 'tabbar', 'dock', 'snackbar',
    'toastcontainer',
  ],
  weakFooterTokens: ['bottom', 'legal', 'copyright', 'sitemap', 'credits', 'disclaimer'],
  // Names that argue AGAINST an element being chrome.
  negativeTokens: [
    'header', 'hero', 'content', 'article', 'sidebar', 'main', 'modal',
    'dialog', 'drawer', 'tooltip', 'popover',
  ],
  // Elements nested inside these tags are page CONTENT (article headers,
  // bylines, table cells), not repeating site chrome. Used as a scoring
  // penalty in markFooterElements, a detach guard in detachCaptureChrome, and
  // a :not() exemption in the generated stylesheet — one list, three uses.
  nestedTags: [
    'ARTICLE', 'ASIDE', 'SECTION', 'LI', 'UL', 'OL', 'TD', 'TH', 'TR',
    'TABLE', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'DETAILS', 'DIALOG',
  ],
};

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'Capture failed';
}
