// Issue #168 follow-up (Codex review): critical.css's OS-only prefers-color-scheme guess
// is wrong whenever gsTheme is explicitly 'dark'/'light' rather than 'system' -- an
// explicit dark override on a light OS still flashed light, and vice versa, since
// suspended.js's own setTheme() only applies once its async gsStorage.getOption() read
// resolves, well after first paint.
//
// A classic (non-module, non-defer) <script> in <head>, placed before any stylesheet,
// blocks parsing until it finishes -- unlike suspended.js's `type='module'` script, which
// behaves like `defer` and runs after the page has already started painting. That gives
// this one exclusive access to the one synchronous, pre-paint storage API extension pages
// have: localStorage. gsUtils.js's setPageTheme() mirrors the effective theme ('dark' or
// 'light', already resolved from 'system' if needed) into localStorage every time it runs,
// so this only ever reads a value this same page previously wrote itself.
//
// First suspend ever (or after a profile wipe/new install, before any cache exists) has
// nothing to read here -- critical.css's prefers-color-scheme fallback covers that case,
// same as before this fix.
(function() {
  try {
    var cached = localStorage.getItem('gsCachedTheme');
    if (cached === 'dark' || cached === 'light') {
      document.documentElement.classList.add('gsTheme-' + cached);
    }
  } catch { /* localStorage unavailable -- fall back to prefers-color-scheme */ }
})();
