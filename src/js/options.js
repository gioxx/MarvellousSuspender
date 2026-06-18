import  { gsBackup }              from './gsBackup.js';
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
    autoBackupEnabled: gsStorage.AUTO_BACKUP_ENABLED,
    autoBackupInterval: gsStorage.AUTO_BACKUP_INTERVAL,
    backupDestLocal: gsStorage.AUTO_BACKUP_DESTINATION,
    backupDestDrive: gsStorage.AUTO_BACKUP_DESTINATION,
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
      setAutoBackupOptionsVisibility(settings[gsStorage.AUTO_BACKUP_ENABLED]);
      setDriveDestinationVisibility(settings[gsStorage.AUTO_BACKUP_DESTINATION] === 'drive');
      updateDriveAuthUI();

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
    if (visible) {
      document.getElementById('forceScreenCaptureContainer').style.display = 'block';
    }
    else {
      document.getElementById('forceScreenCaptureContainer').style.display = 'none';
    }
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
          el.style.display = 'block';
        }
        else {
          el.style.display = 'none';
        }
      },
    );
  }

  function setAutoBackupOptionsVisibility(visible) {
    const el = document.getElementById('autoBackupIntervalContainer');
    if (el) el.style.display = visible ? 'block' : 'none';
  }

  function setDriveDestinationVisibility(isDrive) {
    const el = document.getElementById('driveAuthContainer');
    if (el) el.style.display = isDrive ? 'block' : 'none';
  }

  async function updateDriveAuthUI() {
    const connectedEl    = document.getElementById('driveConnectedInfo');
    const disconnectedEl = document.getElementById('driveDisconnectedInfo');
    const emailEl        = document.getElementById('driveUserEmail');
    if (!connectedEl || !disconnectedEl) return;

    const user = await gsBackup.getDriveUserInfo();
    if (user && user.emailAddress) {
      emailEl.textContent          = user.emailAddress;
      connectedEl.style.display    = 'flex';
      disconnectedEl.style.display = 'none';
    } else {
      connectedEl.style.display    = 'none';
      disconnectedEl.style.display = 'flex';
    }
  }

  async function updateBackupMeta() {
    const nextRunEl   = document.getElementById('backupNextRun');
    const fileCountEl = document.getElementById('backupFileCount');
    if (!nextRunEl || !fileCountEl) return;

    const alarm = await chrome.alarms.get(gsBackup.ALARM_NAME);
    if (alarm) {
      const t = new Date(alarm.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      nextRunEl.textContent = chrome.i18n.getMessage('js_options_backup_next_run', [t]);
    } else {
      nextRunEl.textContent = '';
    }

    const destination = await gsStorage.getOption(gsStorage.AUTO_BACKUP_DESTINATION);
    if (destination === 'drive') {
      fileCountEl.textContent = '';
    } else {
      const items = await chrome.downloads.search({ filenameRegex: 'tms-backups.tms-session-' });
      const count = items.filter(i => i.exists !== false).length;
      fileCountEl.textContent = count > 0
        ? chrome.i18n.getMessage('js_options_backup_file_count', [String(count)])
        : '';
    }
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
      else if (pref === gsStorage.LANGUAGE) {
        window.location.reload();
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

        if (pref === gsStorage.AUTO_BACKUP_ENABLED || pref === gsStorage.AUTO_BACKUP_INTERVAL) {
          await gsBackup.syncAlarmWithSettings();
          await updateBackupMeta();
        }
      }
    };
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
    initSettings();
    updateBackupMeta();

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

    // Manual backup now
    document.getElementById('backupNowBtn').addEventListener('click', async () => {
      const statusEl    = document.getElementById('backupNowStatus');
      const destination = await gsStorage.getOption(gsStorage.AUTO_BACKUP_DESTINATION);
      statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_running');
      statusEl.classList.add('visible');

      try {
        const result = await gsBackup.performBackup();

        if (destination === 'drive') {
          if (result) {
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_done');
            await updateBackupMeta();
          } else {
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_error');
          }
        } else {
          // Local: wait briefly, then check the download state
          await new Promise((r) => setTimeout(r, 1500));
          const results = await chrome.downloads.search({ id: result });
          const item    = results && results[0];

          if (item && item.state === 'complete') {
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_done');
            await updateBackupMeta();
          } else {
            // still 'in_progress' means Chrome is showing a save-as dialog
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_error');
          }
        }
      } catch (e) {
        statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_error');
      }

      setTimeout(() => statusEl.classList.remove('visible'), 6000);
    });

    // Drive: connect button
    document.getElementById('driveConnectBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('driveAuthStatus');
      statusEl.textContent = chrome.i18n.getMessage('js_options_backup_drive_connecting');
      try {
        await gsBackup.getAuthToken(true);
        await updateDriveAuthUI();
        statusEl.textContent = '';
      } catch (e) {
        const msg = e?.message || String(e);
        gsUtils.error('options', 'Drive auth failed:', msg);
        statusEl.textContent = msg || chrome.i18n.getMessage('js_options_backup_drive_auth_error');
        setTimeout(() => { statusEl.textContent = ''; }, 8000);
      }
    });

    // Drive: disconnect button
    document.getElementById('driveDisconnectBtn').addEventListener('click', async () => {
      await gsBackup.revokeAuthToken();
      await updateDriveAuthUI();
    });

    // Export settings
    document.getElementById('exportSettingsBtn').addEventListener('click', async () => {
      const settings  = await gsStorage.getSettings();
      const json      = JSON.stringify(settings, null, 2);
      const blob      = new Blob([json], { type: 'application/json' });
      const url       = URL.createObjectURL(blob);
      const now       = new Date();
      const pad       = (n) => String(n).padStart(2, '0');
      const filename  = `tms-settings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
      const a         = document.createElement('a');
      a.href          = url;
      a.download      = filename;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Import settings
    document.getElementById('importSettingsBtn').addEventListener('click', () => {
      document.getElementById('importSettingsFile').click();
    });

    document.getElementById('importSettingsFile').addEventListener('change', async (e) => {
      const statusEl = document.getElementById('settingsImportStatus');
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';

      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const imported  = JSON.parse(ev.target.result);
          const defaults  = gsStorage.getSettingsDefaults();
          const knownKeys = Object.keys(defaults);

          if (!imported || typeof imported !== 'object' || !knownKeys.some(k => Object.prototype.hasOwnProperty.call(imported, k))) {
            throw new Error('invalid');
          }

          if (!confirm(chrome.i18n.getMessage('js_options_settings_import_confirm'))) return;

          const merged = { ...defaults };
          for (const key of knownKeys) {
            if (Object.prototype.hasOwnProperty.call(imported, key)) {
              merged[key] = imported[key];
            }
          }

          await gsStorage.saveSettings(merged);
          await gsStorage.syncSettings();
          statusEl.textContent = chrome.i18n.getMessage('js_options_settings_import_success');
          setTimeout(() => window.location.reload(), 1500);
        } catch (_) {
          statusEl.textContent = chrome.i18n.getMessage('js_options_settings_import_error');
          setTimeout(() => { statusEl.textContent = ''; }, 5000);
        }
      };
      reader.readAsText(file);
    });

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
        alert(chrome.i18n.getMessage('js_options_whitelist_no_matches'));
        return;
      }

      const firstUrls = tabUrls.splice(0, 22);
      let alertString = `${chrome.i18n.getMessage(
        'js_options_whitelist_matches_heading',
      )}\n${firstUrls.join('\n')}`;

      if (tabUrls.length > 0) {
        alertString += `\n${chrome.i18n.getMessage(
          'js_options_whitelist_matches_overflow_prefix',
        )} ${tabUrls.length} ${chrome.i18n.getMessage(
          'js_options_whitelist_matches_overflow_suffix',
        )}`;
      }
      alert(alertString);
      // gsUtils.log('options', 'testWhitelistBtn', '\n', alertString);
    };

    // hide incompatible sidebar items if in incognito mode
    if (chrome.extension.inIncognitoContext) {
      Array.prototype.forEach.call(
        document.getElementsByClassName('noIncognito'),
        (el) => {
          el.style.display = 'none';
        },
      );
      window.alert(chrome.i18n.getMessage('js_options_incognito_warning'));
    }
  });

})();
