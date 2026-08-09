// @ts-check
import  { gsStorage }             from './gsStorage.js';

export const gsMascot = (() => {

  // Maps each current mascot/icon asset to its legacy (pre-robot) TMS equivalent.
  // Assets with no entry here have no legacy counterpart and always use the new image.
  const LEGACY_MAP = {
    // Illustrations and DOM-rendered icons: legacy source PNGs converted to WEBP,
    // matching the format the current mascot assets already use.
    'img/suspendy-guy-main.webp'         : 'img/legacy/suspendy-guy-main.webp',
    'img/suspendy-guy.webp'              : 'img/legacy/suspendy-guy.webp',
    'img/suspendy-guy-oops.webp'         : 'img/legacy/suspendy-guy-oops.webp',
    'img/suspendy-guy-success.webp'      : 'img/legacy/suspendy-guy-alt.webp',
    'img/suspendy-guy-uh-oh.webp'        : 'img/legacy/suspendy-guy-uh-oh.webp',
    'img/ic_suspendy_16x16.webp'         : 'img/legacy/ic_suspendy_16x16.webp',
    'img/chromeDefaultFavicon.webp'      : 'img/legacy/chromeDefaultFavicon.webp',
    'img/chromeDefaultFaviconSml.webp'   : 'img/legacy/chromeDefaultFaviconSml.webp',
    'img/chromeDevDefaultFavicon.webp'   : 'img/legacy/chromeDevDefaultFavicon.webp',
    'img/chromeDevDefaultFaviconSml.webp': 'img/legacy/chromeDevDefaultFaviconSml.webp',
    // Toolbar/action icons: chrome.action.setIcon requires raster PNG, so these
    // stay PNG on both sides, same as the current (non-legacy) icon set.
    'img/ic_suspendy_16x16.png'          : 'img/legacy/ic_suspendy_16x16.png',
    'img/ic_suspendy_16x16_grey.png'     : 'img/legacy/ic_suspendy_16x16_grey.png',
    'img/ic_suspendy_32x32.png'          : 'img/legacy/ic_suspendy_32x32.png',
    'img/ic_suspendy_32x32_grey.png'     : 'img/legacy/ic_suspendy_32x32_grey.png',
    'img/ic_suspendy_48x48.png'          : 'img/legacy/ic_suspendy_48x48.png',
    'img/ic_suspendy_128x128.png'        : 'img/legacy/ic_suspendy_128x128.png',
    // Vector art: already format-matched, no conversion needed.
    'img/snoozy_tab.svg'                 : 'img/legacy/snoozy_tab.svg',
    'img/snoozy_tab_awake.svg'           : 'img/legacy/snoozy_tab_awake.svg',
  };

  const REVERSE_MAP = Object.fromEntries(
    Object.entries(LEGACY_MAP).map(([defaultPath, legacyPath]) => [legacyPath, defaultPath]),
  );

  async function isLegacyEnabled() {
    return gsStorage.getOption(gsStorage.LEGACY_MASCOT);
  }

  /**
   * @param { string } defaultPath  e.g. 'img/suspendy-guy.webp' or '/img/ic_suspendy_16x16.png'
   * @returns { Promise<string> }
   */
  async function resolvePath(defaultPath) {
    if (!defaultPath || !(await isLegacyEnabled())) return defaultPath;
    const hasLeadingSlash = defaultPath[0] === '/';
    const key = hasLeadingSlash ? defaultPath.slice(1) : defaultPath;
    const mapped = LEGACY_MAP[key];
    if (!mapped) return defaultPath;
    return hasLeadingSlash ? `/${mapped}` : mapped;
  }

  /**
   * @param { string } defaultPath
   * @returns { Promise<string> }
   */
  async function resolveUrl(defaultPath) {
    return chrome.runtime.getURL(await resolvePath(defaultPath));
  }

  /**
   * Rewrites all <img src> and <link rel="icon" href> in the given document
   * to match the current legacy mascot setting (in either direction, so this
   * is also safe to call again after the option has just been toggled).
   * @param { Document } doc
   */
  async function applyToDocument(doc) {
    if (!doc) return;
    const legacyEnabled = await isLegacyEnabled();
    const rewrite = (el, attr) => {
      const current = el.getAttribute(attr);
      if (!current) return;
      const mapped = legacyEnabled ? LEGACY_MAP[current] : REVERSE_MAP[current];
      if (mapped) el.setAttribute(attr, mapped);
    };
    doc.querySelectorAll('img[src]').forEach((el) => rewrite(el, 'src'));
    doc.querySelectorAll('link[rel="icon"][href]').forEach((el) => rewrite(el, 'href'));
  }

  return {
    isLegacyEnabled,
    resolvePath,
    resolveUrl,
    applyToDocument,
  };

})();
