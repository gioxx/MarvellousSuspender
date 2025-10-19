/* eslint-disable no-console */
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { tgs }                   from './tgs.js';

'use strict';

export const gsUtils = {
  STATUS_NORMAL         : 'normal',
  STATUS_LOADING        : 'loading',
  STATUS_SPECIAL        : 'special',
  STATUS_BLOCKED_FILE   : 'blockedFile',
  STATUS_SUSPENDED      : 'suspended',
  STATUS_DISCARDED      : 'discarded',
  STATUS_NEVER          : 'never',
  STATUS_FORMINPUT      : 'formInput',
  STATUS_AUDIBLE        : 'audible',
  STATUS_ACTIVE         : 'active',
  STATUS_TEMPWHITELIST  : 'tempWhitelist',
  STATUS_PINNED         : 'pinned',
  STATUS_WHITELISTED    : 'whitelisted',
  STATUS_CHARGING       : 'charging',
  STATUS_NOCONNECTIVITY : 'noConnectivity',
  STATUS_UNKNOWN        : 'unknown',

  debugInfo   : false,
  debugError  : false,

  contains: function(array, value) {
    for (var i = 0; i < array.length; i++) {
      if (array[i] === value) return true;
    }
    return false;
  },

  dir: function(object) {
    if (gsUtils.debugInfo) {
      console.dir(object);
    }
  },
  log: function(id, text, ...args) {
    if (gsUtils.debugInfo) {
      args = args || [];
      console.log(id, (new Date() + '').split(' ')[4], text, ...args);
    }
  },
  highlight: function(text, ...args) {
    gsUtils.log('highlight: %s %c%s', 'color:red', text, ...args);
  },
  warning: function(id, text, ...args) {
    if (gsUtils.debugError) {
      args = args || [];
      const ignores = ['Error', 'gsUtils', 'gsMessages'];
      const errorLine = gsUtils
        .getStackTrace()
        .split('\n')
        .filter(o => !ignores.find(p => o.indexOf(p) >= 0))
        .join('\n');
      args.push(`\n${errorLine}`);
      console.warn('WARNING:', id, (new Date() + '').split(' ')[4], text, ...args,);
    }
  },
  error: function(id, errorObj, ...args) {
    if (errorObj === undefined) {
      errorObj = id;
      id = '?';
    }
    //NOTE: errorObj may be just a string :/
    if (gsUtils.debugError) {
      const stackTrace = errorObj.hasOwnProperty('stack')
        ? errorObj.stack
        : gsUtils.getStackTrace();
      const errorMessage = errorObj.hasOwnProperty('message')
        ? errorObj.message
        : typeof errorObj === 'string'
          ? errorObj
          : JSON.stringify(errorObj, null, 2);
      errorObj = errorObj || {};
      console.log(id, (new Date() + '').split(' ')[4], 'Error:');
      console.error(
        gsUtils.getPrintableError(errorMessage, stackTrace, ...args),
      );
    } else {
      // const logString = errorObj.hasOwnProperty('stack')
      //   ? errorObj.stack
      //   : `${JSON.stringify(errorObj)}\n${gsUtils.getStackTrace()}`;
    }
  },
  // Puts all the error args into a single printable string so that all the info
  // is displayed in chrome://extensions error console
  getPrintableError(errorMessage, stackTrace, ...args) {
    let errorString = errorMessage;
    errorString += `\n${args.map(o => JSON.stringify(o, null, 2)).join('\n')}`;
    errorString += `\n${stackTrace}`;
    return errorString;
  },
  getStackTrace: function() {
    var obj = {};
    Error.captureStackTrace(obj, gsUtils.getStackTrace);
    return obj.stack;
  },

  isDebugInfo: function() {
    return gsUtils.debugInfo;
  },

  isDebugError: function() {
    return gsUtils.debugError;
  },

  setDebugInfo: function(value) {
    gsUtils.debugInfo = value;
  },

  setDebugError: function(value) {
    gsUtils.debugError = value;
  },

  isDiscardedTab: function(tab) {
    return tab.discarded;
  },

  getTabUrl: function (tab) {
    return tab.url || tab.pendingUrl;
  },

  isValidTabWithUrl: function(tab) {
    if (!tab || typeof tab == "undefined") {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    if (url && typeof url == "string" && url.length > 0) {
      return true;
    }
    return false;
  },


  //tests for non-standard web pages. does not check for suspended pages!
  isSpecialTab: function(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    if (gsUtils.isSuspendedTab(tab, true)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    // Careful, suspended urls start with "chrome-extension://"
    if (
      url.indexOf('about') === 0 ||
      url.indexOf('chrome') === 0 ||
      // webstore urls no longer seem to crash the extension :D
      // url.indexOf('chrome.google.com/webstore') >= 0 ||
      gsUtils.isBlockedFileTab(tab)
    ) {
      return true;
    }
    return false;
  },

  isFileTab: function(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    if (url.indexOf('file') === 0) {
      return true;
    }
    return false;
  },

  //tests if the page is a file:// page AND the user has not enabled access to
  //file URLs in extension settings
  isBlockedFileTab: function(tab) {
    if (gsUtils.isFileTab(tab) && !gsSession.isFileUrlsAccessAllowed()) {
      return true;
    }
    return false;
  },

  //does not include suspended pages!
  isInternalTab: function(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    var isLocalExtensionPage =
      url.indexOf('chrome-extension://' + chrome.runtime.id) === 0;
    return isLocalExtensionPage && !gsUtils.isSuspendedTab(tab);
  },

  isProtectedPinnedTab: async (tab) => {
    const ignorePinned = await gsStorage.getOption(gsStorage.IGNORE_PINNED);
    return ignorePinned && tab.pinned;
  },

  isProtectedAudibleTab: async (tab) => {
    const ignoreAudible = await gsStorage.getOption(gsStorage.IGNORE_AUDIO);
    return ignoreAudible && tab.audible;
  },

  isProtectedActiveTab: async (tab) => {
    const ignoreActiveTabs = await gsStorage.getOption(gsStorage.IGNORE_ACTIVE_TABS);
    return ( await tgs.isCurrentFocusedTab(tab) || (ignoreActiveTabs && tab.active) );
  },

  // Note: Normal tabs may be in a discarded state
  isNormalTab: function(tab, excludeDiscarded) {
    excludeDiscarded = excludeDiscarded || false;
    return (
      !gsUtils.isSpecialTab(tab) &&
      !gsUtils.isSuspendedTab(tab, true) &&
      (!excludeDiscarded || !gsUtils.isDiscardedTab(tab))
    );
  },

  isSuspendedTab: function(tab, looseMatching) {
    const url = tab.url || tab.pendingUrl;
    return gsUtils.isSuspendedUrl(url, looseMatching);
  },

  isSuspendedUrl: function(url, looseMatching) {
    if (!url) {
      return false;
    } else if (looseMatching) {
      return url.indexOf('suspended.html') > 0;
    } else {
      return url.indexOf(chrome.runtime.getURL('suspended.html')) === 0;
    }
  },

  shouldSuspendDiscardedTabs: async () => {
    const suspendInPlaceOfDiscard = await gsStorage.getOption(gsStorage.SUSPEND_IN_PLACE_OF_DISCARD);
    const discardInPlaceOfSuspend = await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    return suspendInPlaceOfDiscard && !discardInPlaceOfSuspend;
  },

  removeTabsByUrlAsPromised: function(url) {
    return new Promise(async resolve => {
      const tabs = await gsChrome.tabsQuery({ url });
      chrome.tabs.remove(tabs.map(o => o.id), () => {
        resolve();
      });
    });
  },

  createTabAndWaitForFinishLoading: function(url, maxWaitTimeInMs) {
    return new Promise(async resolve => {
      let tab = await gsChrome.tabsCreate(url);
      maxWaitTimeInMs = maxWaitTimeInMs || 1000;
      const retryUntil = Date.now() + maxWaitTimeInMs;
      let loaded = false;
      while (!loaded && Date.now() < retryUntil) {
        tab = await gsChrome.tabsGet(tab.id);
        loaded = tab.status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
        }
      }
      resolve(tab);
    });
  },

  createWindowAndWaitForFinishLoading: function(createData, maxWaitTimeInMs) {
    return new Promise(async resolve => {
      let window = await gsChrome.windowsCreate(createData);
      maxWaitTimeInMs = maxWaitTimeInMs || 1000;
      const retryUntil = Date.now() + maxWaitTimeInMs;
      let loaded = false;
      while (!loaded && Date.now() < retryUntil) {
        window = await gsChrome.windowsGet(window.id);
        loaded = window.tabs.length > 0 && window.tabs[0].status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
        }
      }
      resolve(window);
    });
  },

  checkWhiteList: async (url) => {
    const whitelist = await gsStorage.getOption(gsStorage.WHITELIST);
    return gsUtils.checkSpecificWhiteList(url, whitelist);
  },

  checkSpecificWhiteList: function(url, whitelistString) {
    const whitelistItems = whitelistString ? whitelistString.split(/[\s\n]+/) : [];
    const whitelisted = whitelistItems.some(function(item) {
      return gsUtils.testForMatch(item, url);
    }, this);
    return whitelisted;
  },

  removeFromWhitelist: async (url) => {
    const oldWhitelistString = (await gsStorage.getOption(gsStorage.WHITELIST)) || '';
    const whitelistItems = oldWhitelistString.split(/[\s\n]+/).sort();
    let i;

    for (i = whitelistItems.length - 1; i >= 0; i--) {
      if (gsUtils.testForMatch(whitelistItems[i], url)) {
        whitelistItems.splice(i, 1);
      }
    }
    var whitelistString = whitelistItems.join('\n');
    await gsStorage.setOptionAndSync(gsStorage.WHITELIST, whitelistString);

    var key = gsStorage.WHITELIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldWhitelistString },
      { [key]: whitelistString },
    );
  },

  testForMatch: function(whitelistItem, word) {
    if (whitelistItem.length < 1) {
      return false;

      //test for regex ( must be of the form /foobar/ )
    } else if (
      whitelistItem.length > 2 &&
      whitelistItem.indexOf('/') === 0 &&
      whitelistItem.indexOf('/', whitelistItem.length - 1) !== -1
    ) {
      whitelistItem = whitelistItem.substring(1, whitelistItem.length - 1);
      try {
        new RegExp(whitelistItem);
      } catch (e) {
        return false;
      }
      return new RegExp(whitelistItem).test(word);

      // test as substring
    } else {
      return word.indexOf(whitelistItem) >= 0;
    }
  },

  saveToWhitelist: async (newString) => {
    const oldWhitelistString = (await gsStorage.getOption(gsStorage.WHITELIST)) || '';
    let newWhitelistString = oldWhitelistString + '\n' + newString;
    newWhitelistString = gsUtils.cleanupWhitelist(newWhitelistString);
    await gsStorage.setOptionAndSync(gsStorage.WHITELIST, newWhitelistString);

    const key = gsStorage.WHITELIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldWhitelistString },
      { [key]: newWhitelistString },
    );
  },

  cleanupWhitelist: function(whitelist) {
    var whitelistItems = whitelist ? whitelist.split(/[\s\n]+/).sort() : '',
      i,
      j;

    for (i = whitelistItems.length - 1; i >= 0; i--) {
      j = whitelistItems.lastIndexOf(whitelistItems[i]);
      if (j !== i) {
        whitelistItems.splice(i + 1, j - i);
      }
      if (!whitelistItems[i] || whitelistItems[i] === '') {
        whitelistItems.splice(i, 1);
      }
    }
    if (whitelistItems.length) {
      return whitelistItems.join('\n');
    } else {
      return whitelistItems;
    }
  },

  documentReadyAsPromised: function(doc) {
    return new Promise(function(resolve) {
      if (doc.readyState !== 'loading') {
        resolve();
      } else {
        doc.addEventListener('DOMContentLoaded', function() {
          resolve();
        });
      }
    });
  },

  localiseHtml: function(parentEl) {
    let replaceTagFunc = function(match, p1) {
      return p1 ? chrome.i18n.getMessage(p1) : '';
    };
    for (let el of parentEl.getElementsByTagName('*')) {
      if (el.hasAttribute('data-i18n')) {
        el.innerHTML = el
          .getAttribute('data-i18n')
          .replace(/__MSG_(\w+)__/g, replaceTagFunc)
          .replace(/\n/g, '<br />');
      }
      if (el.hasAttribute('data-i18n-tooltip')) {
        el.setAttribute(
          'data-i18n-tooltip',
          el
            .getAttribute('data-i18n-tooltip')
            .replace(/__MSG_(\w+)__/g, replaceTagFunc),
        );
      }
    }
  },

  setPageTheme: function(win, theme) {
    if (win.document?.body) {
      // Set theme
      if (theme === 'system') {
        const isDark = win.matchMedia('(prefers-color-scheme: dark)').matches;
        theme = isDark ? 'dark' : 'light';
      }
      win.document.body.classList.remove('dark', 'light');
      win.document.body.classList.add(theme);
    }
  },

  documentReadyAndLocalisedAsPromised: async function(win) {
    await gsUtils.documentReadyAsPromised(win.document);
    gsUtils.localiseHtml(win.document);

    if (win.document?.body) {
      let theme = await gsStorage.getOption(gsStorage.THEME);
      this.setPageTheme(win, theme);
      // Unhide the body
      setTimeout(() => {
        win.document.body.classList.add('visible');
      }, 100);
    }
  },

  generateSuspendedUrl: (url, title, scrollPos) => {
    let encodedTitle = gsUtils.encodeString(title);
    var args = `#ttl=${encodedTitle}&pos=${scrollPos || '0'}&uri=${url}`;
    return chrome.runtime.getURL('suspended.html' + args);
  },

  // @TODO: Make some unit tests to verify getRootUrl vs getRootUrlNew
  getRootUrlNew: function(url) {
    const fullURL = new URL(url);
    return new URL(`//${fullURL.host}`, fullURL).toString();
  },

  getRootUrl: function(url, includePath, includeScheme) {
    let rootUrlStr = url;
    let scheme;

    // temporarily remove scheme
    if (rootUrlStr.indexOf('//') > 0) {
      scheme = rootUrlStr.substring(0, rootUrlStr.indexOf('//') + 2);
      rootUrlStr = rootUrlStr.substring(rootUrlStr.indexOf('//') + 2);
    }

    // remove path
    if (!includePath) {
      if (scheme === 'file://') {
        rootUrlStr = rootUrlStr.replace(new RegExp('/[^/]*$', 'g'), '');
      } else {
        const pathStartIndex =
          rootUrlStr.indexOf('/') > 0
            ? rootUrlStr.indexOf('/')
            : rootUrlStr.length;
        rootUrlStr = rootUrlStr.substring(0, pathStartIndex);
      }
    } else {
      // remove query string
      var match = rootUrlStr.match(/\/?[?#]+/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
      // remove trailing slash
      match = rootUrlStr.match(/\/$/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
    }

    // readd scheme
    if (scheme && includeScheme) {
      rootUrlStr = scheme + rootUrlStr;
    }
    return rootUrlStr;
  },

  getHashVariable: function(key, urlStr) {
    var valuesByKey = {},
      keyPairRegEx = /^(.+)=(.+)/,
      hashStr;

    if (!urlStr || urlStr.length === 0 || urlStr.indexOf('#') === -1) {
      return false;
    }

    //extract hash component from url
    hashStr = urlStr.replace(/^[^#]+#+(.*)/, '$1');

    if (hashStr.length === 0) {
      return false;
    }

    //handle possible unencoded final var called 'uri'
    let uriIndex = hashStr.indexOf('uri=');
    if (uriIndex >= 0) {
      valuesByKey.uri = hashStr.substr(uriIndex + 4);
      hashStr = hashStr.substr(0, uriIndex);
    }

    hashStr.split('&').forEach(function(keyPair) {
      if (keyPair && keyPair.match(keyPairRegEx)) {
        valuesByKey[keyPair.replace(keyPairRegEx, '$1')] = keyPair.replace(
          keyPairRegEx,
          '$2',
        );
      }
    });
    return valuesByKey[key] || false;
  },
  getSuspendedTitle: function(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('ttl', urlStr) || '');
  },
  getSuspendedScrollPosition: function(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('pos', urlStr) || '');
  },
  getOriginalUrl: function(urlStr) {
    return (
      gsUtils.getHashVariable('uri', urlStr) ||
      gsUtils.decodeString(gsUtils.getHashVariable('url', urlStr) || '')
    );
  },
  getCleanTabTitle: function(tab) {
    let cleanedTitle = gsUtils.decodeString(tab.title);
    if (
      !cleanedTitle ||
      cleanedTitle === '' ||
      cleanedTitle === gsUtils.decodeString(tab.url) ||
      cleanedTitle === 'Suspended Tab'
    ) {
      if (gsUtils.isSuspendedTab(tab)) {
        cleanedTitle =
          gsUtils.getSuspendedTitle(tab.url) || gsUtils.getOriginalUrl(tab.url);
      } else {
        cleanedTitle = tab.url;
      }
    }
    return cleanedTitle;
  },
  decodeString: function(string) {
    try {
      return decodeURIComponent(string);
    } catch (e) {
      return string;
    }
  },
  encodeString: function(string) {
    try {
      return encodeURIComponent(string);
    } catch (e) {
      return string;
    }
  },

  formatHotkeyString: function(hotkeyString) {
    return hotkeyString
      .replace(/Command/, '⌘')
      .replace(/[⌘\u2318]/, ' ⌘ ')
      .replace(/[⇧\u21E7]/, ' Shift ')
      .replace(/[⌃\u8963]/, ' Ctrl ')
      .replace(/[⌥\u8997]/, ' Option ')
      .replace(/\+/g, ' ')
      .replace(/ +/g, ' ')
      .trim()
      .replace(/[ ]/g, ' \u00B7 ');
  },

  getSuspendedTabCount: async function() {
    const currentTabs = await gsChrome.tabsQuery();
    const currentSuspendedTabs = currentTabs.filter(tab =>
      gsUtils.isSuspendedTab(tab),
    );
    return currentSuspendedTabs.length;
  },

  htmlEncode: function(text) {
    return document
      .createElement('pre')
      .appendChild(document.createTextNode(text)).parentNode.innerHTML;
  },

  getChromeVersion: function() {
    var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
    return raw ? parseInt(raw[2], 10) : false;
  },

  generateHashCode: function(text) {
    var hash = 0,
      i,
      chr,
      len;
    if (!text) return hash;
    for (i = 0, len = text.length; i < len; i++) {
      chr = text.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  },

  performPostSaveUpdates: function(changedSettingKeys, oldValueBySettingKey, newValueBySettingKey) {
    // gsUtils.log('gsUtils', 'performPostSaveUpdates');
    chrome.tabs.query({}, async (tabs) => {
      for (const tab of tabs) {
        if (gsUtils.isSpecialTab(tab)) {
          continue;
        }

        if (gsUtils.isSuspendedTab(tab)) {
          //If toggling IGNORE_PINNED or IGNORE_ACTIVE_TABS to TRUE, then unsuspend any suspended pinned/active tabs
          if (
            (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) && (await gsUtils.isProtectedPinnedTab(tab))) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) && (await gsUtils.isProtectedActiveTab(tab)))
          ) {
            await tgs.unsuspendTab(tab);
            continue;
          }

          //if theme or screenshot preferences have changed then refresh suspended tabs
          const updateTheme = changedSettingKeys.includes(gsStorage.THEME);
          const updatePreviewMode = changedSettingKeys.includes(gsStorage.SCREEN_CAPTURE);
          if (updateTheme || updatePreviewMode) {
            const context = await tgs.getInternalContextByTabId(tab.id);
            if (context) {
              if (updateTheme) {
                gsStorage.getOption(gsStorage.THEME).then((theme) => {
                  // @TODO favicon will probably fail here if it can't create a DOM Image
                  gsFavicon.getFaviconMeta(tab).then(faviconMeta => {
                    const isLowContrastFavicon = faviconMeta.isDark || false;
                    chrome.tabs.sendMessage(tab.id, { action: 'updateTheme', tab, theme, isLowContrastFavicon });
                  });
                });
              }
              if (updatePreviewMode) {
                gsStorage.getOption(gsStorage.SCREEN_CAPTURE).then((previewMode) => {
                  chrome.tabs.sendMessage(tab.id, { action: 'updatePreviewMode', tab, previewMode });
                });
              }
            }
          }

          //if discardAfterSuspend has changed then updated discarded tabs
          const updateDiscardAfterSuspend = changedSettingKeys.includes(gsStorage.DISCARD_AFTER_SUSPEND);
          gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND).then((discardAfterSuspend) => {
            if (
              updateDiscardAfterSuspend &&
              discardAfterSuspend &&
              gsUtils.isSuspendedTab(tab) &&
              !gsUtils.isDiscardedTab(tab)
            ) {
              gsTabDiscardManager.queueTabForDiscard(tab);
            }
            return;
          });
        }

        if (!gsUtils.isNormalTab(tab, true)) {
          continue;
        }

        //update content scripts of normal tabs
        const updateIgnoreForms = changedSettingKeys.includes(
          gsStorage.IGNORE_FORMS,
        );
        if (updateIgnoreForms) {
          gsMessages.sendUpdateToContentScriptOfTab(tab); //async. unhandled error
        }

        gsStorage.getSettings().then(async (settings) => {
          //update suspend timers
          const updateSuspendTime =
            changedSettingKeys.includes(gsStorage.SUSPEND_TIME) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) && tab.active) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) && !settings[gsStorage.IGNORE_PINNED] && tab.pinned) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_AUDIO) && !settings[gsStorage.IGNORE_AUDIO] && tab.audible) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_OFFLINE) && !settings[gsStorage.IGNORE_WHEN_OFFLINE] && !navigator.onLine) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_CHARGING) && !settings[gsStorage.IGNORE_WHEN_CHARGING] && await tgs.isCharging()) ||
            (changedSettingKeys.includes(gsStorage.WHITELIST) &&
              ( gsUtils.checkSpecificWhiteList(tab.url, oldValueBySettingKey[gsStorage.WHITELIST]) &&
               !gsUtils.checkSpecificWhiteList(tab.url, newValueBySettingKey[gsStorage.WHITELIST])
              )
            );
          if (updateSuspendTime) {
            await tgs.resetAutoSuspendTimerForTab(tab);
          }
        });

        //if SuspendInPlaceOfDiscard has changed then updated discarded tabs
        const updateSuspendInPlaceOfDiscard = changedSettingKeys.includes( gsStorage.SUSPEND_IN_PLACE_OF_DISCARD );
        if (updateSuspendInPlaceOfDiscard && gsUtils.isDiscardedTab(tab)) {
          gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.
          //note: this may cause the tab to suspend
        }

        //if we aren't resetting the timer on this tab, then check to make sure it does not have an expired timer
        //should always be caught by tests above, but we'll check all tabs anyway just in case
        // if (!updateSuspendTime) {
        //     gsMessages.sendRequestInfoToContentScript(tab.id, function (err, tabInfo) { // unhandled error
        //         tgs.calculateTabStatus(tab, tabInfo, function (tabStatus) {
        //             if (tabStatus === STATUS_NORMAL && tabInfo && tabInfo.timerUp && (new Date(tabInfo.timerUp)) < new Date()) {
        //                 gsUtils.error(tab.id, 'Tab has an expired timer!', tabInfo);
        //                 gsMessages.sendUpdateToContentScriptOfTab(tab, true, false); // async. unhandled error
        //             }
        //         });
        //     });
        // }
      };
    });

    //if context menu has been disabled then remove from chrome
    if (gsUtils.contains(changedSettingKeys, gsStorage.ADD_CONTEXT)) {
      gsStorage.getOption(gsStorage.ADD_CONTEXT).then((addContextMenu) => {
        tgs.buildContextMenu(addContextMenu);
      });
    }

    //if screenshot preferences have changed then update the queue parameters
    if (
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE) ||
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE_FORCE)
    ) {
      gsTabSuspendManager.initAsPromised(); //async. unhandled promise
    }
  },

  getWindowFromSession: function(windowId, session) {
    var window = false;
    session.windows.some(function(curWindow) {
      //leave this as a loose matching as sometimes it is comparing strings. other times ints
      if (curWindow.id == windowId) {
        window = curWindow;
        return true;
      }
    });
    return window;
  },

  removeInternalUrlsFromSession: function(session) {
    if (!session || !session.windows) { return; }
    for (var i = session.windows.length - 1; i >= 0; i--) {
      var curWindow = session.windows[i];
      for (var j = curWindow.tabs.length - 1; j >= 0; j--) {
        var curTab = curWindow.tabs[j];
        if (gsUtils.isInternalTab(curTab)) {
          curWindow.tabs.splice(j, 1);
        }
      }
      if (curWindow.tabs.length === 0) {
        session.windows.splice(i, 1);
      }
    }
  },

  getSimpleDate: function(date) {
    var d = new Date(date);
    return (
      ('0' + d.getDate()).slice(-2) +
      '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) +
      '-' +
      d.getFullYear() +
      ' ' +
      ('0' + d.getHours()).slice(-2) +
      ':' +
      ('0' + d.getMinutes()).slice(-2)
    );
  },

  getHumanDate: function(date) {
    var monthNames = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ],
      d = new Date(date),
      currentDate = d.getDate(),
      currentMonth = d.getMonth(),
      currentYear = d.getFullYear(),
      currentHours = d.getHours(),
      currentMinutes = d.getMinutes();

    var AMPM = currentHours >= 12 ? 'pm' : 'am';
    var hoursString = currentHours % 12 || 12;
    var minutesString = ('0' + currentMinutes).slice(-2);

    return ( `${currentDate} ${monthNames[currentMonth]} ${currentYear} ${hoursString}:${minutesString}${AMPM}`);
  },

  debounce: function(func, wait) {
    var timeout;
    return function() {
      var context = this,
        args = arguments;
      var later = function() {
        timeout = null;
        func.apply(context, args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  setTimeout: async function(timeout) {
    return new Promise(resolve => {
      setTimeout(resolve, timeout);
    });
  },

  executeWithRetries: async ( promiseFn, fnArgsArray, maxRetries, retryWaitTime ) => {
    const retryFn = async retries => {
      try {
        return await promiseFn(...fnArgsArray);
      } catch (e) {
        if (retries >= maxRetries) {
          gsUtils.warning('gsUtils', 'Max retries exceeded');
          return Promise.reject(e);
        }
        retries += 1;
        await gsUtils.setTimeout(retryWaitTime);
        return await retryFn(retries);
      }
    };
    return await retryFn(0);
  },
};
