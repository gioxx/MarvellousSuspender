// @ts-check
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';

export const gsFavicon = (() => {

  /**
   * @typedef { {
   * favIconUrl          : string,
   * isDark              : boolean,
   * normalisedDataUrl   : string,
   * transparentDataUrl  : string,
   * } } FavIconMeta
   */

  // const GOOGLE_S2_URL = 'https://www.google.com/s2/favicons?domain_url=';
  /** @type { FavIconMeta } */
  const FALLBACK_CHROME_FAVICON_META = {
    favIconUrl          : 'chrome://favicon/size/16@2x/fallbackChromeFaviconMeta',
    isDark              : true,
    normalisedDataUrl   : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAYklEQVQ4T2NkoBAwIuuPior6j8O8xmXLljVgk8MwYNmyZdgMfcjAwLAAmyFEGfDv3z9FJiamA9gMIcoAkKsiIiIUsBlClAHofkf2JkED0DWDAnrUgOEfBsRkTpzpgBjN6GoA24V1Efr1zoAAAAAASUVORK5CYII=',
    transparentDataUrl  : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVQ4T2NkoBAwIuuPioqqx2YeExPTwSVLlhzAJodhwLJlyxrRDWVkZPzIyMh4AZshRBnAxsY28ffv3wnYDCHKAJCrEhISBLAZQpQB6H5H9iZBA9A1gwJ61IDhHwbEZE6c6YAYzehqAAmQeBHM42eMAAAAAElFTkSuQmCC',
  };


  /** @type { Record<string, string> } */
  let _defaultFaviconFingerprintById  = {};
  let _defaultChromeFaviconMeta       = FALLBACK_CHROME_FAVICON_META;


  // gsFavicon cannot be initialized in the background because it requires a DOM.  So, we'll init JIT.
  // async function initAsPromised() {
  //   await addFaviconDefaults();
  //   gsUtils.log('gsFavicon', 'init successful');
  // }

  async function getFaviconDefaults() {
    // Generate a list of potential 'default' favicons so we can avoid caching anything that matches these defaults

    _defaultFaviconFingerprintById    = (await gsStorage.getStorageJSON('session', gsStorage.DEFAULT_FAVICON_FINGERPRINTS)) ?? {};
    gsUtils.log( 'gsFavicon', 'Loaded session storage defaults', _defaultFaviconFingerprintById );
    if (Object.keys(_defaultFaviconFingerprintById).length) return;

    const defaultIconUrls = [
      getChromeFavIconUrl('http://chromeDefaultFavicon'),
      getChromeFavIconUrl('chromeDefaultFavicon'),
      chrome.runtime.getURL('img/ic_suspendy_16x16.png'),
      chrome.runtime.getURL('img/chromeDefaultFavicon.png'),
      chrome.runtime.getURL('img/chromeDefaultFaviconSml.png'),
      chrome.runtime.getURL('img/chromeDevDefaultFavicon.png'),
      chrome.runtime.getURL('img/chromeDevDefaultFaviconSml.png'),
    ];

    const faviconPromises = [];
    for (let i = 0; i < defaultIconUrls.length; i += 1) {
      const iconUrl = defaultIconUrls[i];
      faviconPromises.push(
        /** @type {Promise<void>} */
        (new Promise(async (resolve) => {
          const faviconMeta = await addDefaultFaviconMeta(iconUrl);
          if (faviconMeta) {
            // gsUtils.log( 'gsFavicon', 'Successfully built default faviconMeta', iconUrl, faviconMeta );
          }
          else {
            gsUtils.warning('gsFavicon', 'Failed to build faviconMeta', iconUrl);
          }
          // Set the first url as the default favicon
          if (i === 0) {
            _defaultChromeFaviconMeta = faviconMeta || FALLBACK_CHROME_FAVICON_META;
          }
          resolve();
        }))
      );
    }
    await Promise.all(faviconPromises);
    await gsStorage.saveStorage('session', gsStorage.DEFAULT_FAVICON_FINGERPRINTS, _defaultFaviconFingerprintById);
  }

  /**
   * @param   { string }  url
   * @returns { Promise< FavIconMeta | undefined > }
   */
  async function addDefaultFaviconMeta(url) {
    // gsUtils.log( 'gsFavicon', '2 addDefaultFaviconMeta' );
    /** @type { FavIconMeta } */
    let faviconMeta;
    try {
      faviconMeta = await gsUtils.executeWithRetries(buildFaviconMeta, [url], 4, 0);
      const url2  = `${url}Transparent`;
      _defaultFaviconFingerprintById[url]   = await createImageFingerprint(faviconMeta.normalisedDataUrl);
      _defaultFaviconFingerprintById[url2]  = await createImageFingerprint(faviconMeta.transparentDataUrl);
      return faviconMeta;
    }
    catch (error) {
      gsUtils.warning('gsFavicon', error);
    }
  }

  /**
   * @param   { string }  url
   * @returns { string }
   */
  function getChromeFavIconUrl(url) {
    // gsUtils.log( 'gsFavicon', 'getChromeFavIconUrl', url );
    const icon_url = new URL(chrome.runtime.getURL('/_favicon/'));
    icon_url.searchParams.set('pageUrl', url);
    icon_url.searchParams.set('size', '32');
    return icon_url.toString();
  }

  /**
   * @param   { string }  url
   * @param   { string }  tabFavIconUrl
   * @param   { boolean } fRecursion
   * @returns { Promise< FavIconMeta | undefined > }
   */
  async function getFaviconMetaForUrl(url, tabFavIconUrl, fRecursion = false) {

    let faviconMeta = await getFaviconMetaFromCache(url);
    if (faviconMeta) {
      gsUtils.log('gsFavicon', 'Found cached favicon', url, faviconMeta);
      return faviconMeta;
    }
    gsUtils.log('gsFavicon', 'No cached favicon', url);

    // Else try to build from chrome's favicon cache
    faviconMeta = await buildFaviconMetaFromChrome(url);
    if (faviconMeta) {
      await saveFaviconMetaToCache(url, faviconMeta);
      return faviconMeta;
    }
    gsUtils.log('gsFavicon', 'No entry in chrome favicon cache', url);

    // Else try to build from tabFavIconUrl
    faviconMeta = await buildFaviconMetaFromTab(tabFavIconUrl);
    if (faviconMeta) {
      gsUtils.log('gsFavicon', 'Built faviconMeta from tabFavIconUrl', faviconMeta);
      return faviconMeta;
    }
    gsUtils.log('gsFavicon', 'No tabFavIconUrl', tabFavIconUrl, url);

    // Else try to fetch from google -- this approach is no longer valid
    // if (fallbackToGoogle) {
    //   const rootUrl = encodeURIComponent(gsUtils.getRootUrl(url));
    //   const tabFavIconUrl = GOOGLE_S2_URL + rootUrl;
    //   //TODO: Handle reject case below
    //   faviconMeta = await buildFaviconMeta(tabFavIconUrl, 5000);
    //   faviconMetaValid = await isFaviconMetaValid(faviconMeta);
    //   if (faviconMetaValid) {
    //     gsUtils.log(
    //       tab.id,
    //       'Built faviconMeta from google.com/s2 service',
    //       faviconMeta
    //     );
    //     return faviconMeta;
    //   }
    // }

    // Else try one more time with the root hostname -- this is needed for YouTube, for example
    const fullUrl = new URL(url).toString();
    const hostUrl = gsUtils.getRootUrlNew(fullUrl);
    if (!fRecursion && fullUrl != hostUrl) {
      gsUtils.log('gsFavicon', 'Trying root hostname', fullUrl, hostUrl);
      faviconMeta = await getFaviconMetaForUrl(hostUrl, tabFavIconUrl, true);
      if (faviconMeta) {
        gsUtils.log('gsFavicon', 'Built faviconMeta from root hostname', faviconMeta);
        await saveFaviconMetaToCache(url, faviconMeta);
        return faviconMeta;
      }
    }

  }

  /**
   * @param   { chrome.tabs.Tab } tab
   * @returns { Promise< FavIconMeta > }
   */
  async function getFaviconMeta(tab) {
    gsUtils.log('gsFavicon', 'getFaviconMeta', tab.url);
    let   originalUrl   = tab.url ?? '';
    const tabFavIconUrl = tab.favIconUrl ?? '';

    if (gsUtils.isFileTab(tab)) {
      return _defaultChromeFaviconMeta;
    }

    // First try to fetch from cache
    if (gsUtils.isSuspendedTab(tab)) {
      originalUrl = gsUtils.getOriginalUrl(tab.url);
    }

    const faviconMeta = await getFaviconMetaForUrl(originalUrl, tabFavIconUrl);
    if (faviconMeta) {
      return faviconMeta;
    }

    // Else return the default chrome favicon
    gsUtils.log('gsFavicon', 'Failed to build faviconMeta. Using default icon');
    return _defaultChromeFaviconMeta;
  }

  /**
   * @param { string }  url
   * @returns { Promise< FavIconMeta | undefined > }
   */
  async function buildFaviconMetaFromChrome(url) {
    const chromeFavIconUrl = getChromeFavIconUrl(url);
    gsUtils.log('gsFavicon', 'buildFaviconMetaFromChrome', url, chromeFavIconUrl);
    try {
      const faviconMeta = await buildFaviconMeta(chromeFavIconUrl);
      const isValid     = await isFaviconMetaValid(faviconMeta);
      if (isValid) {
        return faviconMeta;
      }
    }
    catch (error) {
      gsUtils.warning('gsUtils', error);
    }
  }

  /**
   * @param   { string }  favIconUrl
   * @returns { Promise< FavIconMeta | undefined > }
   */
  async function buildFaviconMetaFromTab(favIconUrl) {
    if (favIconUrl && favIconUrl !== chrome.runtime.getURL('img/ic_suspendy_16x16.png')) {
      gsUtils.log('gsFavicon', 'buildFaviconMetaFromTab', favIconUrl);
      try {
        const faviconMeta = await buildFaviconMeta(favIconUrl);
        const isValid     = await isFaviconMetaValid(faviconMeta);
        if (isValid) {
          return faviconMeta;
        }
      }
      catch (error) {
        gsUtils.warning('gsUtils', error);
      }
    }
  }

  /**
   * @param { string }  url
   * @returns { Promise< FavIconMeta | undefined > }
   */
  async function getFaviconMetaFromCache(url) {
    const fullUrl   = gsUtils.getRootUrl(url, true, false);
    let faviconMeta = await gsIndexedDb.fetchFaviconMeta(fullUrl);
    if (!faviconMeta) {
      const rootUrl = gsUtils.getRootUrl(url, false, false);
      faviconMeta   = await gsIndexedDb.fetchFaviconMeta(rootUrl);
    }
    const isValid   = await isFaviconMetaValid(faviconMeta);
    if (isValid) {
      return faviconMeta;
    }
  }

  /**
   * @param { string }  url
   * @param { object }  faviconMeta
   */
  async function saveFaviconMetaToCache(url, faviconMeta) {
    const fullUrl = gsUtils.getRootUrl(url, true, false);
    const rootUrl = gsUtils.getRootUrl(url, false, false);
    gsUtils.log('gsFavicon', `Saving favicon cache entry for ${fullUrl}`, faviconMeta);
    await gsIndexedDb.addFaviconMeta(fullUrl, Object.assign({}, faviconMeta));
    gsUtils.log('gsFavicon', `Saving favicon cache entry for ${rootUrl}`, faviconMeta);
    await gsIndexedDb.addFaviconMeta(rootUrl, Object.assign({}, faviconMeta));
  }

  /**
   * @param { FavIconMeta }  faviconMeta
   * @returns { Promise< boolean > }
   */
  async function isFaviconMetaValid(faviconMeta) {
    if (
      !faviconMeta ||
      faviconMeta.normalisedDataUrl === 'data:,' ||
      faviconMeta.transparentDataUrl === 'data:,'
    ) {
      return false;
    }
    const normalisedFingerprint   = await createImageFingerprint(faviconMeta.normalisedDataUrl);
    const transparentFingerprint  = await createImageFingerprint(faviconMeta.transparentDataUrl);

    if (!Object.keys(_defaultFaviconFingerprintById).length) {
      await getFaviconDefaults();
    }

    for (const id of Object.keys(_defaultFaviconFingerprintById)) {
      const defaultFaviconFingerprint = _defaultFaviconFingerprintById[id];
      if (
        normalisedFingerprint === defaultFaviconFingerprint ||
        transparentFingerprint === defaultFaviconFingerprint
      ) {
        gsUtils.log('gsFavicon', `FaviconMeta not valid as it matches fingerprint of default favicon ${id}`, faviconMeta);
        return false;
      }
    }
    return true;
  }

  /**
   * @param   { string }  dataUrl
   * @returns { Promise<string> }
   * Turns the img into a 16x16 black and white dataUrl
   */
  function createImageFingerprint(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = async () => {
        const canvas  = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const threshold = 80;

        if (context) {
          canvas.width = 16;
          canvas.height = 16;
          context.drawImage(img, 0, 0, 16, 16);

          const imageData = context.getImageData(0, 0, 16, 16);
          for (let i = 0; i < imageData.data.length; i += 4) {
            const luma = Math.floor(
              imageData.data[i] * 0.3 +
                imageData.data[i + 1] * 0.59 +
                imageData.data[i + 2] * 0.11
            );
            imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] =
              luma > threshold ? 255 : 0;
            imageData.data[i + 3] = 255;
          }
          context.putImageData(imageData, 0, 0);
          const fingerprintDataUrl = canvas.toDataURL('image/png');
          resolve(fingerprintDataUrl);
        }
        else {
          reject('Failed to get canvas context');
        }
      };
      img.src = dataUrl;
    });
  }

  /**
   * @param   { string }  url
   * @returns { Promise<FavIconMeta> }
   */
  function buildFaviconMeta(url) {
    // gsUtils.log( 'gsFavicon', 'buildFaviconMeta', url );
    const timeout = 5 * 1000;
    return new Promise((resolve, reject) => {
      const img = new Image();
      // 12-16-2018 ::: @CollinChaffin ::: Anonymous declaration required to prevent terminating cross origin security errors
      // 12-16-2018 ::: @CollinChaffin ::: http://bit.ly/2BolEqx
      // 12-16-2018 ::: @CollinChaffin ::: https://bugs.chromium.org/p/chromium/issues/detail?id=409090#c23
      // 12-16-2018 ::: @CollinChaffin ::: https://bugs.chromium.org/p/chromium/issues/detail?id=718352#c10
      img.crossOrigin = 'Anonymous';
      let imageLoaded = false;

      img.onload = () => {
        imageLoaded = true;

        const canvas  = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        const context = canvas.getContext('2d');

        if (context) {
          context.drawImage(img, 0, 0);

          let imageData;
          try {
            imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          }
          catch (error) {
            reject(error);
            return;
          }

          const origDataArray = imageData.data;
          const normalisedDataArray = new Uint8ClampedArray(origDataArray);
          const transparentDataArray = new Uint8ClampedArray(origDataArray);

          const fuzzy     = 0.1;
          let   r         = 0;
          let   g         = 0;
          let   b         = 0;
          let   a         = 0;
          let   light     = 0;
          let   dark      = 0;
          let   maxAlpha  = 0;
          let   maxRGB    = 0;

          for (let x = 0; x < origDataArray.length; x += 4) {
            r = origDataArray[x];
            g = origDataArray[x + 1];
            b = origDataArray[x + 2];
            a = origDataArray[x + 3];

            const localMaxRgb = Math.max(Math.max(r, g), b);
            if (localMaxRgb < 128 || a < 128) dark++;
            else light++;
            maxAlpha  = Math.max(a, maxAlpha);
            maxRGB    = Math.max(localMaxRgb, maxRGB);
          }

          // safety check to make sure image is not completely transparent
          if (maxAlpha === 0) {
            reject(`Aborting favicon generation as image is completely transparent ${url}`);
            return;
          }

          const darkLightDiff = (light - dark) / (canvas.width * canvas.height);
          const isDark = darkLightDiff + fuzzy < 0;
          const normaliserMultiple = 1 / (maxAlpha / 255);

          for (let x = 0; x < origDataArray.length; x += 4) {
            a = origDataArray[x + 3];
            normalisedDataArray[x + 3] = parseInt(String(a * normaliserMultiple), 10);
          }
          for (let x = 0; x < normalisedDataArray.length; x += 4) {
            a = normalisedDataArray[x + 3];
            transparentDataArray[x + 3] = parseInt(String(a * 0.5), 10);
          }

          imageData.data.set(normalisedDataArray);
          context.putImageData(imageData, 0, 0);
          const normalisedDataUrl = canvas.toDataURL('image/png');

          imageData.data.set(transparentDataArray);
          context.putImageData(imageData, 0, 0);
          const transparentDataUrl = canvas.toDataURL('image/png');

          /** @type FavIconMeta */
          const faviconMeta = {
            favIconUrl: url,
            isDark,
            normalisedDataUrl,
            transparentDataUrl,
          };
          resolve(faviconMeta);
        }
        else {
          reject('Failed to get canvas context');
        }
      };
      img.src = url;
      setTimeout(() => {
        if (!imageLoaded) {
          reject(`Failed to load img.src for ${url}`);
        }
      }, timeout);
    });
  }

  return {
    // initAsPromised,
    getFaviconMeta,
    getChromeFavIconUrl,
    // buildFaviconMetaFromChrome,
    // saveFaviconMetaToCache,
  };
})();
