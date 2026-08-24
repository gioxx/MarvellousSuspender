import  { gsChangelog }           from './gsChangelog.js';
import  { gsChrome }              from './gsChrome.js';
import  { gsMascot }              from './gsMascot.js';
import  { gsNewsFeed }            from './gsNewsFeed.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';

(() => {

  const elementPrefMap = {
    preview: gsStorage.SCREEN_CAPTURE,
    forceScreenCapture: gsStorage.SCREEN_CAPTURE_FORCE,
    suspendInPlaceOfDiscard: gsStorage.SUSPEND_IN_PLACE_OF_DISCARD,
    onlineCheck: gsStorage.IGNORE_WHEN_OFFLINE,
    batteryCheck: gsStorage.IGNORE_WHEN_CHARGING,
    unsuspendOnFocus: gsStorage.UNSUSPEND_ON_FOCUS,
    reloadUnsuspendBackground: gsStorage.RELOAD_UNSUSPEND_BACKGROUND,
    claimByDefault: gsStorage.CLAIM_BY_DEFAULT,
    discardAfterSuspend: gsStorage.DISCARD_AFTER_SUSPEND,
    appendUrlToTitle:    gsStorage.APPEND_URL_TO_TITLE,
    addYouTubeTimestamp: gsStorage.ADD_YOUTUBE_TIMESTAMP,
    dontSuspendPinned: gsStorage.IGNORE_PINNED,
    dontSuspendForms: gsStorage.IGNORE_FORMS,
    dontSuspendAudio: gsStorage.IGNORE_AUDIO,
    dontSuspendActiveTabs: gsStorage.IGNORE_ACTIVE_TABS,
    dontRestoreScrollPos: gsStorage.IGNORE_SCROLL_POS,
    ignoreCache: gsStorage.IGNORE_CACHE,
    addContextMenu: gsStorage.ADD_CONTEXT,
    syncSettings: gsStorage.SYNC_SETTINGS,
    timeToSuspend: gsStorage.SUSPEND_TIME,
    timeToSuspendOnBattery: gsStorage.SUSPEND_TIME_ON_BATTERY,
    theme: gsStorage.THEME,
    legacyMascot: gsStorage.LEGACY_MASCOT,
    language: gsStorage.LANGUAGE,
    whitelist: gsStorage.WHITELIST,
    alwaysSuspendList: gsStorage.ALWAYS_SUSPEND_LIST,
    newsFeedEnabled: gsStorage.NEWS_FEED_ENABLED,
  };


  function selectComboBox(element, key) {
    for (let i = 0; i < element.children.length; i += 1) {
      const child = element.children[i];
      if (child.value === key) {
        child.selected = 'true';
        break;
      }
    }
  }

  // populate settings from synced storage
  function initSettings() {
    gsStorage.getSettings().then((settings) => {

      const optionEls = document.getElementsByClassName('option');
      for (let i = 0; i < optionEls.length; i++) {
        const element = optionEls[i];
        const pref = elementPrefMap[element.id];
        populateOption(element, settings[pref]);
      }

      addClickHandlers();

      setForceScreenCaptureVisibility(settings[gsStorage.SCREEN_CAPTURE] !== '0');
      setAutoSuspendOptionsVisibility(parseFloat(settings[gsStorage.SUSPEND_TIME]) > 0);
      setSyncNoteVisibility(!settings[gsStorage.SYNC_SETTINGS]);

      const searchParams = new URL(location.href).searchParams;
      const isFirstTime = searchParams.has('firstTime');
      if (isFirstTime) {
        document
          .querySelector('.welcome-message')
          .classList.remove('reallyHidden');
        document.querySelector('#options-heading').classList.add('reallyHidden');
      }

      maybeShowChangelogModal(isFirstTime);
    });
  }

  // Shows the current version's changelog once per version, in a dismissible modal.
  // Skipped on a brand-new install (nothing to announce yet).
  async function maybeShowChangelogModal(isFirstTime) {
    const curVersion = chrome.runtime.getManifest().version;
    if (isFirstTime) {
      gsStorage.setLastSeenChangelogVersion(curVersion);
      return;
    }

    const lastSeenVersion = await gsStorage.fetchLastSeenChangelogVersion();
    if (lastSeenVersion === curVersion) return;

    const modal = document.getElementById('changelogModal');
    const title = document.getElementById('changelogModalTitle');
    const body  = document.getElementById('changelogModalBody');

    const found = await gsChangelog.renderVersionChangelog(body, curVersion);
    gsStorage.setLastSeenChangelogVersion(curVersion);
    if (!found) return;

    title.textContent = chrome.i18n.getMessage('html_options_changelog_modal_title', [curVersion]);
    modal.classList.remove('hidden');

    document.getElementById('changelogModalClose').onclick = () => {
      modal.classList.add('hidden');
    };
    modal.addEventListener('click', (event) => {
      if (event.target.id === 'changelogModal') {
        modal.classList.add('hidden');
      }
    });
  }

  function addClickHandlers() {
    document.getElementById('preview').addEventListener('change', function() {
      if (this.value === '1' || this.value === '2') {
        chrome.permissions.request({
          origins: [
            'http://*/*',
            'https://*/*',
            // 'file://*/*',
          ],
        }, (granted) => {
          if (chrome.runtime.lastError) {
            gsUtils.warning('addClickHandlers', chrome.runtime.lastError);
          }
          if (!granted) {
            const select = document.getElementById('preview');
            select.value = '0';
            select.dispatchEvent(new Event('change'));
          }
        });
      }
    });

  }

  function populateOption(element, value) {
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox') {
      element.checked = value;
    }
    else if (element.tagName === 'INPUT' && element.getAttribute('type') === 'radio') {
      element.checked = (element.value === value);
    }
    else if (element.tagName === 'SELECT') {
      selectComboBox(element, value);
    }
    else if (element.tagName === 'TEXTAREA') {
      element.value = value;
    }
  }

  function getOptionValue(element) {
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox') {
      return element.checked;
    }
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'radio') {
      return element.value;
    }
    if (element.tagName === 'SELECT') {
      return element.children[element.selectedIndex].value;
    }
    if (element.tagName === 'TEXTAREA') {
      return element.value;
    }
  }

  function setForceScreenCaptureVisibility(visible) {
    document.getElementById('forceScreenCaptureContainer').classList.toggle('hidden', !visible);
  }

  function setSyncNoteVisibility(visible) {
    document.getElementById('syncNote').classList.toggle('hidden', !visible);
  }

  function setAutoSuspendOptionsVisibility(visible) {
    Array.prototype.forEach.call(
      document.getElementsByClassName('autoSuspendOption'),
      (el) => el.classList.toggle('hidden', !visible),
    );
  }

  function handleChange(element) {
    return async () => {
      const pref = elementPrefMap[element.id];

      // add specific screen element listeners
      if (pref === gsStorage.SCREEN_CAPTURE) {
        setForceScreenCaptureVisibility(getOptionValue(element) !== '0');
      }
      else if (pref === gsStorage.SUSPEND_TIME) {
        const interval = getOptionValue(element);
        setAutoSuspendOptionsVisibility(interval > 0);
      }
      else if (pref === gsStorage.SYNC_SETTINGS) {
        // we only really want to show this on load. not on toggle
        if (getOptionValue(element)) {
          setSyncNoteVisibility(false);
        }
      }
      else if (pref === gsStorage.THEME) {
        // window.location.reload();
        // Instead of reloading the page, just update the CSS directly
        gsUtils.setPageTheme(window, getOptionValue(element));
      }
      else if (pref === gsStorage.AUTO_BACKUP_ENABLED) {
        setAutoBackupOptionsVisibility(getOptionValue(element));
      }
      else if (pref === gsStorage.AUTO_BACKUP_DESTINATION) {
        setDriveDestinationVisibility(getOptionValue(element) === 'drive');
        await updateDriveAuthUI();
      }

      const [oldValue, newValue] = await saveChange(element);
      if (oldValue !== newValue) {
        const prefKey = elementPrefMap[element.id];
        if (prefKey === gsStorage.LEGACY_MASCOT) {
          await gsMascot.applyToDocument(document);
        }
        gsUtils.performPostSaveUpdates(
          [prefKey],
          { [prefKey]: oldValue },
          { [prefKey]: newValue },
        );
        if (prefKey !== gsStorage.LANGUAGE) {
          showSavedFeedback(element);
        }
        if (prefKey === gsStorage.NEWS_FEED_ENABLED) {
          await gsNewsFeed.syncAlarm();
        }
      }

      if (pref === gsStorage.LANGUAGE) {
        window.location.reload();
      }
    };
  }

  const _savedTimers = new Map();

  function showSavedFeedback(element) {
    const row = element.closest('.formRow');
    if (!row) return;
    const span = row.querySelector('.optionSavedFeedback');
    if (!span) return;
    span.textContent = gsUtils.getMessage('js_backup_option_saved');
    span.classList.add('visible');
    clearTimeout(_savedTimers.get(row));
    _savedTimers.set(row, setTimeout(() => span.classList.remove('visible'), 2000));
  }

  function injectSavedFeedbackSpans() {
    document.querySelectorAll('.formRow').forEach(row => {
      if (row.querySelector('.option') && !row.querySelector('.optionSavedFeedback')) {
        const span = document.createElement('span');
        span.className = 'optionSavedFeedback';
        span.setAttribute('aria-live', 'polite');
        row.appendChild(span);
      }
    });
  }

  async function saveChange(element) {
    const pref = elementPrefMap[element.id];
    let newValue = getOptionValue(element);
    const oldValue = await gsStorage.getOption(pref);

    // clean up list-type options before saving (cleanupWhitelist is a generic
    // dedupe/sort/trim of a newline-separated list, not whitelist-specific)
    if (pref === gsStorage.WHITELIST || pref === gsStorage.ALWAYS_SUSPEND_LIST) {
      newValue = gsUtils.cleanupWhitelist(newValue);
    }

    // save option
    if (oldValue !== newValue) {
      await gsStorage.setOptionAndSync(elementPrefMap[element.id], newValue);
    }

    return [oldValue, newValue];
  }


  function messageRequestListener(request, sender, sendResponse) {
    // Declared synchronous (not async) so this decline is a real, immediate `false`
    // return rather than a resolved Promise: an async function's `return false` is
    // still a Promise, and Chrome/Firefox treat a returned Promise as this listener's
    // eventual response, letting its trivial resolved value race the service worker's
    // real, slower response for actions like 'checkTabResponsiveness'.
    // These are meant only for the service worker, delivered here too because Chrome
    // broadcasts any chrome.runtime.sendMessage() with no tabId to every extension page.
    // Not logging them (not even as "ignoring") matters specifically for
    // gsAppendLogEntries: logging it would itself be a log entry needing its own flush,
    // whose "ignored" broadcast produces another one, forever.
    if (gsUtils.INTERNAL_MESSAGE_ACTIONS.has(request.action)) return false;

    gsUtils.log('options', 'messageRequestListener', request.action, request, sender);

    switch (request.action) {

      // { action: 'initSettings', tab: focusedTab }
      case 'initSettings': {
        initSettings();
        // This function is synchronous, so no longer returns a Promise Chrome could use
        // as the response (that's the whole point of the sync-decline fix above) —
        // sendResponse() must be called explicitly here, or a sender awaiting a response
        // (e.g. tgs.js's handleNewStationaryTabFocus() awaiting 'initSettings' before
        // resetting the previous tab's suspend timer) would hang until the message
        // channel itself eventually tears down.
        sendResponse();
        return true;
      }

      default: {
        // NOTE: All messages sent to chrome.runtime will be delivered here too. A real
        // `false` decline (not a response) matters here too: another extension page's
        // own action (e.g. debug.js's 'repairFavicons', handled only in background.js)
        // must be free to have its real, slower response win, not get shadowed by this
        // page unconditionally answering with `undefined` for an action it doesn't own.
        gsUtils.log('options', 'messageRequestListener', `Ignoring unhandled message: ${request.action}`);
        return false;
      }

    }
  }


  gsUtils.documentReadyAndLocalisedAsPromised(window).then(() => {
    chrome.runtime.onMessage.addListener(messageRequestListener);
    gsUtils.initSelectArrows(document);
    injectSavedFeedbackSpans();
    initSettings();

    const optionEls = document.getElementsByClassName('option');

    // add change listeners for all 'option' elements
    for (let i = 0; i < optionEls.length; i++) {
      const element = optionEls[i];
      if (element.tagName === 'TEXTAREA') {
        element.addEventListener(
          'input',
          gsUtils.debounce(handleChange(element), 200),
          false,
        );
      }
      else {
        element.onchange = handleChange(element);
      }
    }

    // Back-to-top button
    const backToTopBtn = document.getElementById('backToTop');
    window.addEventListener('scroll', () => {
      backToTopBtn.classList.toggle('visible', window.scrollY > 200);
    }, { passive: true });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Active section tracking for in-page nav
    const navSections = Array.from(document.querySelectorAll('.sub-section[id]'));
    const navLinks    = Array.from(document.querySelectorAll('.pageInlineNav a[href^="#"]'));
    let navClickLock  = null;
    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        clearTimeout(navClickLock);
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        navClickLock = setTimeout(() => { navClickLock = null; }, 1000);
      });
    });
    function updateActiveNavLink() {
      if (navClickLock) return;
      const scrollPos = window.scrollY + 120;
      let activeId    = navSections[0]?.id;
      for (const section of navSections) {
        if (section.offsetTop <= scrollPos) activeId = section.id;
      }
      navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${activeId}`));
    }
    window.addEventListener('scroll', updateActiveNavLink, { passive: true });
    updateActiveNavLink();

    document.getElementById('testWhitelistBtn').onclick = async (event) => {
      event.preventDefault();
      const tabs     = await gsChrome.tabsQuery();
      const matches  = [];
      for (const tab of tabs) {
        const url    = gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
        if (!(gsUtils.isSpecialTab(tab)) && (await gsUtils.checkWhiteList(url))) {
          const label = url.length > 55 ? `${url.substr(0, 52)}...` : url;
          matches.push({ tabId: tab.id, windowId: tab.windowId, label });
        }
      }

      const modal    = document.getElementById('whitelistTestModal');
      const listEl   = document.getElementById('whitelistTestModalList');
      const emptyEl  = document.getElementById('whitelistTestModalEmpty');
      listEl.innerHTML = '';

      if (matches.length === 0) {
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
        for (const match of matches) {
          const li = document.createElement('li');
          const a  = document.createElement('a');
          a.href        = '#';
          a.textContent = match.label;
          a.addEventListener('click', async (clickEvent) => {
            clickEvent.preventDefault();
            modal.classList.add('hidden');
            await gsChrome.tabsUpdate(match.tabId, { active: true });
            await gsChrome.windowsUpdate(match.windowId, { focused: true });
          });
          li.appendChild(a);
          listEl.appendChild(li);
        }
      }

      modal.classList.remove('hidden');
    };

    document.getElementById('whitelistTestModalClose').onclick = () => {
      document.getElementById('whitelistTestModal').classList.add('hidden');
    };

    document.getElementById('whitelistTestModal').addEventListener('click', (event) => {
      if (event.target.id === 'whitelistTestModal') {
        event.target.classList.add('hidden');
      }
    });

    document.getElementById('unsuspendWhitelistedBtn').onclick = async (event) => {
      event.preventDefault();
      await chrome.runtime.sendMessage({ action: 'unsuspendWhitelisted' });
    };

    document.getElementById('testAlwaysSuspendBtn').onclick = async (event) => {
      event.preventDefault();
      const tabs     = await gsChrome.tabsQuery();
      const matches  = [];
      for (const tab of tabs) {
        const url = gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
        if (!(gsUtils.isSpecialTab(tab)) && (await gsUtils.checkAlwaysSuspendList(url))) {
          const label = url.length > 55 ? `${url.substr(0, 52)}...` : url;
          matches.push({ tabId: tab.id, windowId: tab.windowId, label });
        }
      }

      const modal    = document.getElementById('alwaysSuspendTestModal');
      const listEl   = document.getElementById('alwaysSuspendTestModalList');
      const emptyEl  = document.getElementById('alwaysSuspendTestModalEmpty');
      listEl.innerHTML = '';

      if (matches.length === 0) {
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
        for (const match of matches) {
          const li = document.createElement('li');
          const a  = document.createElement('a');
          a.href        = '#';
          a.textContent = match.label;
          a.addEventListener('click', async (clickEvent) => {
            clickEvent.preventDefault();
            modal.classList.add('hidden');
            await gsChrome.tabsUpdate(match.tabId, { active: true });
            await gsChrome.windowsUpdate(match.windowId, { focused: true });
          });
          li.appendChild(a);
          listEl.appendChild(li);
        }
      }

      modal.classList.remove('hidden');
    };

    document.getElementById('alwaysSuspendTestModalClose').onclick = () => {
      document.getElementById('alwaysSuspendTestModal').classList.add('hidden');
    };

    document.getElementById('alwaysSuspendTestModal').addEventListener('click', (event) => {
      if (event.target.id === 'alwaysSuspendTestModal') {
        event.target.classList.add('hidden');
      }
    });

    document.getElementById('forceSuspendAlwaysListBtn').onclick = async (event) => {
      event.preventDefault();
      await chrome.runtime.sendMessage({ action: 'forceSuspendAlwaysList' });
    };

    // hide incompatible sidebar items if in incognito mode
    if (chrome.extension.inIncognitoContext) {
      Array.prototype.forEach.call(
        document.getElementsByClassName('noIncognito'),
        (el) => {
          el.style.display = 'none';
        },
      );
      window.alert(gsUtils.getMessage('js_options_incognito_warning'));
    }
  });

})();
