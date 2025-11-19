import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

(() => {

  function addWatermarkHandler() {
    document.querySelector('.watermark').onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
    };
  }

  function showUnsuspendAnimation() {
    if (document.body.classList.contains('img-preview-mode')) {
      document.getElementById('refreshSpinner').classList.add('spinner');
    } else {
      document.body.classList.add('waking');
      document.getElementById('snoozyImg').src = chrome.runtime.getURL( 'img/snoozy_tab_awake.svg', );
      document.getElementById('snoozySpinner').classList.add('spinner');
    }
  }

  function buildUnsuspendTabHandler(tab) {
    return async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.id === 'setKeyboardShortcut') {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      }
      else if (e.which === 1) {
        showUnsuspendAnimation();
        await tgs.unsuspendTab(tab);
      }
    };
  }

  function cleanUrl(urlStr) {
    // remove scheme
    if (urlStr.indexOf('//') > 0) {
      urlStr = urlStr.substring(urlStr.indexOf('//') + 2);
    }
    // remove query string
    let match = urlStr.match(/\/?[?#]+/);
    if (match) {
      urlStr = urlStr.substring(0, match.index);
    }
    // remove trailing slash
    match = urlStr.match(/\/$/);
    if (match) {
      urlStr = urlStr.substring(0, match.index);
    }
    return urlStr;
  }

  async function getPreviewUri(suspendedUrl) {
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);
    const preview = await gsIndexedDb.fetchPreviewImage(originalUrl);
    let previewUri = null;
    if (
      preview &&
      preview.img &&
      preview.img !== null &&
      preview.img !== 'data:,' &&
      preview.img.length > 10000
    ) {
      previewUri = preview.img;
    }
    return previewUri;
  }

  function setUrl(url) {
    const gsTopBarUrl = document.getElementById('gsTopBarUrl');
    gsTopBarUrl.innerHTML = cleanUrl(url);
    gsTopBarUrl.setAttribute('href', url);
    gsTopBarUrl.onmousedown = function(event) { event.stopPropagation(); };
  }

  function showContents() {
    document.body.classList.add('visible');
  }

  function buildImagePreview(tab, previewUri) {
    return new Promise(async (resolve) => {
      const previewEl = document.createElement('div');
      const bodyEl = document.getElementsByTagName('body')[0];
      previewEl.setAttribute('id', 'gsPreviewContainer');
      previewEl.classList.add('gsPreviewContainer');
      previewEl.innerHTML = document.getElementById(
        'previewTemplate',
      ).innerHTML;
      const unsuspendTabHandler = buildUnsuspendTabHandler(tab);
      previewEl.onclick = unsuspendTabHandler;
      gsUtils.localiseHtml(previewEl);
      bodyEl.appendChild(previewEl);

      const previewImgEl = document.getElementById('gsPreviewImg');
      const onLoadedHandler = function() {
        previewImgEl.removeEventListener('load', onLoadedHandler);
        previewImgEl.removeEventListener('error', onLoadedHandler);
        resolve();
      };
      previewImgEl.setAttribute('src', previewUri);
      previewImgEl.addEventListener('load', onLoadedHandler);
      previewImgEl.addEventListener('error', onLoadedHandler);
    });
  }

  async function toggleImagePreviewVisibility(tab, previewMode, previewUri) {
    const builtImagePreview =
      document.getElementById('gsPreviewContainer') !== null;
    if (
      !builtImagePreview &&
      previewUri &&
      previewMode &&
      previewMode !== '0'
    ) {
      await buildImagePreview(tab, previewUri);
    }
    else {
      addWatermarkHandler();
    }

    if (!document.getElementById('gsPreviewContainer')) {
      return;
    }
    const overflow = previewMode === '2' ? 'auto' : 'hidden';
    document.body.style['overflow'] = overflow;

    if (previewMode === '0' || !previewUri) {
      document.getElementById('gsPreviewContainer').style.display = 'none';
      document.getElementById('suspendedMsg').style.display = 'flex';
      document.body.classList.remove('img-preview-mode');
    }
    else {
      document.getElementById('gsPreviewContainer').style.display = 'block';
      document.getElementById('suspendedMsg').style.display = 'none';
      document.body.classList.add('img-preview-mode');
    }
  }

  function setCommand(command) {
    const hotkeyEl = document.getElementById('hotkeyWrapper');
    if (command) {
      hotkeyEl.innerHTML = '<span class="hotkeyCommand">(' + command + ')</span>';
    }
    else {
      const reloadString = chrome.i18n.getMessage( 'js_suspended_hotkey_to_reload', );
      hotkeyEl.innerHTML = `<a id='setKeyboardShortcut' href='#'>${reloadString}</a>`;
    }
  }

  function setGoToUpdateHandler() {
    document.getElementById('gotoUpdatePage').onclick = async (e) => {
      e.stopPropagation();
      await gsChrome.tabsCreate(chrome.runtime.getURL('update.html'));
    };
  }

  function setFaviconMeta(faviconMeta) {
    document.getElementById('gsTopBarImg').setAttribute('src', faviconMeta.normalisedDataUrl);
    document.getElementById('gsFavicon').setAttribute('href', faviconMeta.transparentDataUrl);
  }

  function setReason(reason) {
    let reasonMsgEl = document.getElementById('reasonMsg');
    if (!reasonMsgEl) {
      reasonMsgEl = document.createElement('div');
      reasonMsgEl.setAttribute('id', 'reasonMsg');
      reasonMsgEl.classList.add('reasonMsg');
      const containerEl = document.getElementById('suspendedMsg-instr');
      containerEl.insertBefore(reasonMsgEl, containerEl.firstChild);
    }
    reasonMsgEl.innerHTML = reason;
  }

  function setScrollPosition(scrollPosition, previewMode) {
    const scrollPosAsInt = (scrollPosition && parseInt(scrollPosition)) || 0;
    const scrollImagePreview = previewMode === '2';
    if (scrollImagePreview && scrollPosAsInt > 15) {
      const offsetScrollPosition = scrollPosAsInt + 151;
      document.body.scrollTop = offsetScrollPosition;
      document.documentElement.scrollTop = offsetScrollPosition;
    } else {
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
    }
  }

  function setTheme(theme, isLowContrastFavicon) {
    gsUtils.setPageTheme(window, theme);
    if (theme === 'dark' && isLowContrastFavicon) {
      document.getElementById('faviconWrap').classList.add('faviconWrapLowContrast');
    } else {
      document.getElementById('faviconWrap').classList.remove('faviconWrapLowContrast');
    }
  }

  function setTitle(title) {
    document.title = title;
    document.getElementById('gsTitle').innerHTML = title;
    const gsTopBarTitle = document.getElementById('gsTopBarTitle');
    gsTopBarTitle.innerHTML = title;
    // Prevent unsuspend by parent container
    // Using mousedown event otherwise click can still be triggered if
    // mouse is released outside of this element
    gsTopBarTitle.onmousedown = function(e) {
      e.stopPropagation();
    };
  }

  async function setUpdateBanner() {
    // Check if there are updates
    const update = await gsStorage.getOption(gsStorage.UPDATE_AVAILABLE);
    if (update) {
      let el = document.getElementById('tmsUpdateAvailable');
      el.style.display = 'block';
    }
    setGoToUpdateHandler();
  }

  async function setUnloadTabHandler(tab) {
    // beforeunload event will get fired if: the tab is refreshed, the url is changed,
    // the tab is closed, or the tab is frozen by chrome ??
    // when this happens the STATE_UNLOADED_URL gets set with the suspended tab url
    // if the tab is refreshed, then on reload the url will match and the tab will unsuspend
    // if the url is changed then on reload the url will not match
    // if the tab is closed, the reload will never occur
    addEventListener('beforeunload', async (event) => {
      gsUtils.log(tab.id, 'BeforeUnload triggered: ' + tab.url);
      if (await tgs.isCurrentFocusedTab(tab)) {
        await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_UNLOADED_URL, tab.url);
      }
      else {
        gsUtils.log( tab.id, 'Ignoring beforeUnload as tab is not currently focused.', );
      }
    });
  }

  function setWatermark() {
    const div = document.getElementById('watermark');
    if (div) {
      div.innerHTML = `${chrome.runtime.getManifest().name} v${chrome.runtime.getManifest().version}`;
    }
  }

  async function setUnsuspendTabHandlers(tab) {
    const unsuspendTabHandler = buildUnsuspendTabHandler(tab);
    document.getElementById('gsTopBarUrl').onclick = unsuspendTabHandler;
    document.getElementById('gsTopBar').onmousedown = unsuspendTabHandler;
    document.getElementById('suspendedMsg').onclick = unsuspendTabHandler;
    document.getElementById('tmsUpdateAvailable').onclick = unsuspendTabHandler;
  }

  async function initTab(tab, sessionId, quickInit) {

    const suspendedUrl = tab.url;

    // Set sessionId for subsequent checks
    document.sessionId = sessionId;

    // Set title
    let title = gsUtils.getSuspendedTitle(suspendedUrl);
    if (title.indexOf('<') >= 0) {
      // Encode any raw html tags that might be used in the title
      title = gsUtils.htmlEncode(title);
    }
    setTitle(title);
    await setUpdateBanner();
    setWatermark();

    // Set faviconMeta
    const faviconMeta = await gsFavicon.getFaviconMeta(tab);
    setFaviconMeta(faviconMeta);

    if (quickInit) {
      return;
    }

    const options = await gsStorage.getSettings();
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);

    // Add event listeners
    await setUnloadTabHandler(tab);
    await setUnsuspendTabHandlers(tab);

    // Set imagePreview
    const previewMode = options[gsStorage.SCREEN_CAPTURE];
    const previewUri = await getPreviewUri(suspendedUrl);
    await toggleImagePreviewVisibility( tab, previewMode, previewUri, );

    // Set theme
    const theme = options[gsStorage.THEME];
    const isLowContrastFavicon = faviconMeta.isDark;
    setTheme(theme, isLowContrastFavicon);

    // Set command
    setCommand(await tgs.getSuspensionToggleHotkey());

    // Set url
    setUrl(originalUrl);

    // Set reason
    const suspendReasonInt = await tgs.getTabStatePropForTabId( tab.id, tgs.STATE_SUSPEND_REASON );
    let suspendReason = null;
    if (suspendReasonInt === 3) {
      suspendReason = chrome.i18n.getMessage('js_suspended_low_memory');
    }
    setReason(suspendReason);

    // Show the view
    showContents();

    // Set scrollPosition (must come after showing page contents)
    const scrollPosition = gsUtils.getSuspendedScrollPosition(suspendedUrl);
    setScrollPosition(scrollPosition, previewMode);
    await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);
    // const whitelisted = gsUtils.checkWhiteList(originalUrl);
  }


  function loadToastTemplate() {
    const toastEl = document.createElement('div');
    toastEl.setAttribute('id', 'disconnectedNotice');
    toastEl.classList.add('toast-wrapper');
    toastEl.innerHTML = document.getElementById('toastTemplate').innerHTML;
    gsUtils.localiseHtml(toastEl);
    document.getElementsByTagName('body')[0].appendChild(toastEl);
  }

  function showNoConnectivityMessage() {
    if (!document.getElementById('disconnectedNotice')) {
      loadToastTemplate();
    }
    document.getElementById('disconnectedNotice').style.display = 'none';
    setTimeout(function() {
      document.getElementById('disconnectedNotice').style.display = 'block';
    }, 50);
  }

  async function updatePreviewMode(tab, previewMode) {
    const previewUri = await getPreviewUri(tab.url);
    await toggleImagePreviewVisibility( tab, previewMode, previewUri, );
    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    setScrollPosition(scrollPosition, previewMode);
  }

  async function messageRequestListener(request, sender, sendResponse) {
    gsUtils.log('suspended', 'messageRequestListener', request.action, request, sender);

    switch (request.action) {

      case 'initTab' : {
        // { action: 'initTab', tab, quickInit, sessionId: gsSession.getSessionId() }
        await initTab(request.tab, request.sessionId, request.quickInit);
        sendResponse();
        break;
      }
      case 'getSuspendInfo' : {
        // { action: 'getSuspendInfo', tab }
        let isVisible = false;
        const bodyEl = document.getElementsByTagName('body')[0];
        if (bodyEl) {
          isVisible = bodyEl.classList.contains('visible');
        }
        sendResponse({ sessionId: document.sessionId, isVisible });
        break;
      }
      case 'updateCommand' : {
        // { action: 'updateCommand', tabId: context.tabId }
        setCommand(await tgs.getSuspensionToggleHotkey());
        sendResponse();
        break;
      }
      case 'updateTheme' : {
        // { action: 'updateTheme', tab, theme, isLowContrastFavicon }
        setTheme(request.theme, request.isLowContrastFavicon);
        sendResponse();
        break;
      }
      case 'updatePreviewMode' : {
        // { action: 'updatePreviewMode', tab, previewMode }
        // @TODO preview mode might not work with the JSOB tab here
        await updatePreviewMode(request.tab, request.previewMode);
        sendResponse();
        break;
      }
      case 'showNoConnectivityMessage' : {
        // { action: 'showNoConnectivityMessage', tab: focusedTab }
        showNoConnectivityMessage();
        sendResponse();
        break;
      }

      default: {
        // NOTE: All messages sent to chrome.runtime will be delivered here too
        gsUtils.log('suspended', 'messageRequestListener', `Ignoring unhandled message: ${request.action}`);
        // sendResponse();
        break;
      }
    }
    return true;
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(function() {
    gsUtils.log('suspended', 'documentReadyAndLocalisedAsPromised');
    chrome.runtime.onMessage.addListener(messageRequestListener);
    // initSettings();
  });

})();
