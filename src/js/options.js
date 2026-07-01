import  { gsChrome }              from './gsChrome.js';
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
    claimByDefault: gsStorage.CLAIM_BY_DEFAULT,
    discardAfterSuspend: gsStorage.DISCARD_AFTER_SUSPEND,
    appendUrlToTitle:    gsStorage.APPEND_URL_TO_TITLE,
    dontSuspendPinned: gsStorage.IGNORE_PINNED,
    dontSuspendForms: gsStorage.IGNORE_FORMS,
    dontSuspendAudio: gsStorage.IGNORE_AUDIO,
    dontSuspendActiveTabs: gsStorage.IGNORE_ACTIVE_TABS,
    ignoreCache: gsStorage.IGNORE_CACHE,
    addContextMenu: gsStorage.ADD_CONTEXT,
    syncSettings: gsStorage.SYNC_SETTINGS,
    timeToSuspend: gsStorage.SUSPEND_TIME,
    theme: gsStorage.THEME,
    language: gsStorage.LANGUAGE,
    whitelist: gsStorage.WHITELIST,
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
      if (searchParams.has('firstTime')) {
        document
          .querySelector('.welcome-message')
          .classList.remove('reallyHidden');
        document.querySelector('#options-heading').classList.add('reallyHidden');
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
    if (visible) {
      document.getElementById('syncNote').style.display = 'block';
    }
    else {
      document.getElementById('syncNote').style.display = 'none';
    }
  }

  function setAutoSuspendOptionsVisibility(visible) {
    Array.prototype.forEach.call(
      document.getElementsByClassName('autoSuspendOption'),
      (el) => {
        if (visible) {
          el.style.display = 'flex';
        }
        else {
          el.style.display = 'none';
        }
      },
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
        gsUtils.performPostSaveUpdates(
          [prefKey],
          { [prefKey]: oldValue },
          { [prefKey]: newValue },
        );
        if (prefKey !== gsStorage.LANGUAGE) {
          showSavedFeedback(element);
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

    // clean up whitelist before saving
    if (pref === gsStorage.WHITELIST) {
      newValue = gsUtils.cleanupWhitelist(newValue);
    }

    // save option
    if (oldValue !== newValue) {
      await gsStorage.setOptionAndSync(elementPrefMap[element.id], newValue);
    }

    return [oldValue, newValue];
  }


  async function messageRequestListener(request, sender, sendResponse) {
    gsUtils.log('options', 'messageRequestListener', request.action, request, sender);

    switch (request.action) {

      // { action: 'initSettings', tab: focusedTab }
      case 'initSettings': {
        initSettings();
        break;
      }

      default: {
        // NOTE: All messages sent to chrome.runtime will be delivered here too
        gsUtils.log('options', 'messageRequestListener', `Ignoring unhandled message: ${request.action}`);
        // sendResponse();
        break;
      }

    }
    return true;
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
      const tabs      = await gsChrome.tabsQuery();
      const tabUrls   = [];
      for (const tab of tabs) {
        const url     = gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
        if (!(gsUtils.isSpecialTab(tab)) && (await gsUtils.checkWhiteList(url))) {
          const str   = url.length > 55 ? `${url.substr(0, 52)}...` : url;
          tabUrls.push(str);
        }
      }

      if (tabUrls.length === 0) {
        alert(gsUtils.getMessage('js_options_whitelist_no_matches'));
        return;
      }

      const firstUrls = tabUrls.splice(0, 22);
      let alertString = `${gsUtils.getMessage(
        'js_options_whitelist_matches_heading',
      )}\n${firstUrls.join('\n')}`;

      if (tabUrls.length > 0) {
        alertString += `\n${gsUtils.getMessage(
          'js_options_whitelist_matches_overflow_prefix',
        )} ${tabUrls.length} ${gsUtils.getMessage(
          'js_options_whitelist_matches_overflow_suffix',
        )}`;
      }
      alert(alertString);
      // gsUtils.log('options', 'testWhitelistBtn', '\n', alertString);
    };

    document.getElementById('unsuspendWhitelistedBtn').onclick = async (event) => {
      event.preventDefault();
      await chrome.runtime.sendMessage({ action: 'unsuspendWhitelisted' });
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
