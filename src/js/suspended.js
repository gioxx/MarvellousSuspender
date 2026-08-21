import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsMascot }              from './gsMascot.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

(() => {

  function addWatermarkHandler() {
    document.querySelector('.watermark').onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
    };
  }

  async function showUnsuspendAnimation() {
    if (document.body.classList.contains('img-preview-mode')) {
      document.getElementById('refreshSpinner').classList.add('spinner');
    } else {
      document.body.classList.add('waking');
      document.getElementById('snoozyImg').src = await gsMascot.resolveUrl('img/snoozy_tab_awake.svg');
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
        await showUnsuspendAnimation();
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
    document.body.classList.toggle('preview-scrollable', previewMode === '2');
    document.body.classList.toggle('img-preview-mode', previewMode !== '0' && !!previewUri);
  }

  function setCommand(command) {
    const hotkeyEl = document.getElementById('hotkeyWrapper');
    if (command) {
      hotkeyEl.innerHTML = '<span class="hotkeyCommand">(' + command + ')</span>';
    }
    else {
      const reloadString = gsUtils.getMessage( 'js_suspended_hotkey_to_reload', );
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

  function updateMascotContrast() {
    const isDark = document.body.classList.contains('dark');
    document.querySelector('.snoozyWrapper').classList.toggle('mascotLowContrast', isDark);
  }

  function setTheme(theme, isLowContrastFavicon) {
    gsUtils.setPageTheme(window, theme);
    if (theme === 'dark' && isLowContrastFavicon) {
      document.getElementById('faviconWrap').classList.add('faviconWrapLowContrast');
    } else {
      document.getElementById('faviconWrap').classList.remove('faviconWrapLowContrast');
    }
    updateMascotContrast();
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

  // This function has been disabled below, and replaced by showing 1 new tab when an update is available
  async function setUpdateBanner() {
    // Check if there are updates
    const update = await gsStorage.getOption(gsStorage.UPDATE_AVAILABLE);
    if (update) {
      document.getElementById('tmsUpdateAvailable').classList.add('update-available');
    }
    setGoToUpdateHandler();
  }

  let _unloadHandlerRegistered = false;

  // reloadUnsuspendBackground is resolved by the caller (at initTab time, no time
  // pressure there) rather than re-fetched inside the beforeunload handler below.
  // Chrome gives beforeunload no guarantee that pending async work finishes before
  // the page is actually torn down — every extra `await` in the handler (a settings
  // lookup, a diagnostic read, isCurrentFocusedTab()'s own storage reads) is more
  // time for a multi-tab reload to lose that race. With several tabs reloaded
  // together, contending for the same chrome.storage IPC, that's exactly what
  // happened in testing: a random subset of tabs failed to unsuspend each run,
  // a different subset every time, because whichever write hadn't resolved yet
  // when the page died simply never landed. Cutting the pre-write hops from ~4
  // down to 1 (the actual storage write) shrinks that window.
  async function setUnloadTabHandler(tab, reloadUnsuspendBackground) {
    // initTab() re-runs (without quickInit) whenever checkQueue reinitialises an
    // unresponsive suspended tab, which would otherwise call this again and stack a
    // second beforeunload listener carrying its own captured `tab` snapshot. Both
    // listeners would then race to write STATE_UNLOADED_URL on the actual unload,
    // non-deterministically, since each write is an async storage call — whichever
    // resolves last wins, independent of which snapshot is actually correct. Only
    // the first registration is needed: the suspended.html URL itself never changes
    // for the lifetime of a suspended tab, so the first capture stays valid.
    if (_unloadHandlerRegistered) return;
    _unloadHandlerRegistered = true;

    // beforeunload event will get fired if: the tab is refreshed, the url is changed,
    // the tab is closed, or the tab is frozen by chrome ??
    // when this happens the STATE_UNLOADED_URL gets set with the suspended tab url
    // if the tab is refreshed, then on reload the url will match and the tab will unsuspend
    // if the url is changed then on reload the url will not match
    // if the tab is closed, the reload will never occur
    addEventListener('beforeunload', async (event) => {
      if (reloadUnsuspendBackground || await tgs.isCurrentFocusedTab(tab)) {
        await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_UNLOADED_URL, tab.url);
        gsUtils.log(tab.id, 'BeforeUnload triggered, marked as reload', tab.url);
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

    const appendUrl = await gsStorage.getOption(gsStorage.APPEND_URL_TO_TITLE);
    if (appendUrl) {
      const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);
      if (originalUrl) {
        document.title = title + ' · ' + originalUrl;
      }
    }

    // await setUpdateBanner();
    setWatermark();

    // Set faviconMeta
    const faviconMeta = await gsFavicon.getFaviconMeta(tab);
    setFaviconMeta(faviconMeta);

    if (quickInit) {
      // quickInit skips the heavy setup below (preview, unsuspend click handlers, etc.)
      // for tabs about to be discarded anyway, but that also means it never registers
      // the beforeunload listener the "reload also unsuspends background tabs" option
      // depends on — a background tab suspended with "Discard after suspend" on always
      // takes this path, silently defeating that option regardless of its own state.
      const reloadUnsuspendBackground = await gsStorage.getOption(gsStorage.RELOAD_UNSUSPEND_BACKGROUND);
      if (reloadUnsuspendBackground) {
        await setUnloadTabHandler(tab, reloadUnsuspendBackground);
      }
      return;
    }

    const options = await gsStorage.getSettings();
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);

    // Add event listeners
    await setUnloadTabHandler(tab, options[gsStorage.RELOAD_UNSUSPEND_BACKGROUND]);
    await setUnsuspendTabHandlers(tab);

    // Set imagePreview
    const previewMode = options[gsStorage.SCREEN_CAPTURE];
    const previewUri = await getPreviewUri(suspendedUrl);
    await toggleImagePreviewVisibility( tab, previewMode, previewUri, );

    // Set theme
    const theme = options[gsStorage.THEME];
    const isLowContrastFavicon = faviconMeta.isDark;
    setTheme(theme, isLowContrastFavicon);

    // Set url
    setUrl(originalUrl);

    // Set reason
    const suspendReasonInt = await tgs.getTabStatePropForTabId( tab.id, tgs.STATE_SUSPEND_REASON );
    let suspendReason = null;
    if (suspendReasonInt === 3) {
      suspendReason = gsUtils.getMessage('js_suspended_low_memory');
    }
    setReason(suspendReason);

    // Show the view
    // NOTE: must not be gated behind setCommand()/chrome.commands.getAll() below, that
    // call can be slow (#320), and unsuspend click handlers are already attached above,
    // so there's no reason to keep the page hidden/non-interactive while waiting on it.
    showContents();

    // Set scrollPosition (must come after showing page contents)
    const scrollPosition = gsUtils.getSuspendedScrollPosition(suspendedUrl);
    setScrollPosition(scrollPosition, previewMode);
    await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);
    // const whitelisted = gsUtils.checkWhiteList(originalUrl);

    // Set command (cosmetic hotkey label only, fetched after the page is already visible/interactive)
    setCommand(await tgs.getSuspensionToggleHotkey());
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
    const noticeEl = document.getElementById('disconnectedNotice');
    noticeEl.classList.remove('toast-active');
    setTimeout(function() {
      noticeEl.classList.add('toast-active');
    }, 50);
  }

  async function updatePreviewMode(tab, previewMode) {
    const previewUri = await getPreviewUri(tab.url);
    await toggleImagePreviewVisibility( tab, previewMode, previewUri, );
    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    setScrollPosition(scrollPosition, previewMode);
  }

  const HANDLED_MESSAGE_ACTIONS = new Set([
    'initTab', 'getSuspendInfo', 'updateCommand', 'updateTheme',
    'updateMascot', 'updatePreviewMode', 'showNoConnectivityMessage',
  ]);

  // chrome.runtime.sendMessage with no tabId broadcasts to every extension page
  // (this one included), not just its intended recipient (e.g. the service worker).
  // An async function listener always returns a Promise the instant it's invoked,
  // regardless of what it returns internally — so a synchronous dispatcher that
  // checks request.action first is the only reliable way to give Chrome a real,
  // immediate `false` for actions this page doesn't own, so it doesn't shadow
  // whichever listener the message was actually meant for.
  function messageRequestListener(request, sender, sendResponse) {
    if (!HANDLED_MESSAGE_ACTIONS.has(request.action)) {
      // gsAppendLogEntries especially must stay unlogged here: logging it would be a
      // log entry needing its own flush, whose "ignored" broadcast produces another
      // one in turn, in every open suspended tab, forever. See the matching guard in
      // options.js/updated.js.
      if (!gsUtils.INTERNAL_MESSAGE_ACTIONS.has(request.action)) {
        gsUtils.log('suspended', 'messageRequestListener', `Ignoring unhandled message: ${request.action}`);
      }
      return false;
    }
    handleMessageRequest(request, sender, sendResponse);
    return true;
  }

  async function handleMessageRequest(request, sender, sendResponse) {
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
      case 'updateMascot' : {
        // { action: 'updateMascot' }
        await gsMascot.applyToDocument(document);
        updateMascotContrast();
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
    }
  }

  // Registered as soon as the DOM is ready, decoupled from the full localisation chain
  // below (locale storage read, possible locale-file fetch, mascot/theme application) —
  // that chain has no fixed upper bound, especially with dozens of suspended pages
  // initialising concurrently (e.g. browser startup), and tgs.js's initTab message can
  // arrive as soon as this tab's status flips to 'complete'. Registering the listener
  // early instead of waiting on that whole chain closes the race at the source, rather
  // than relying on tgs.js retrying a fixed number of times against an unbounded wait.
  gsUtils.documentReadyAsPromised(window.document).then(() => {
    chrome.runtime.onMessage.addListener(messageRequestListener);
  });

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(function() {
    gsUtils.log('suspended', 'documentReadyAndLocalisedAsPromised');
    // initSettings();
  });

})();
