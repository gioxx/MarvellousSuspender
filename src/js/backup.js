import  { gsBackup }   from './gsBackup.js';
import  { gsStorage }  from './gsStorage.js';
import  { gsUtils }    from './gsUtils.js';

(() => {

  const elementPrefMap = {
    autoBackupEnabled      : gsStorage.AUTO_BACKUP_ENABLED,
    autoBackupInterval     : gsStorage.AUTO_BACKUP_INTERVAL,
    autoBackupDestination  : gsStorage.AUTO_BACKUP_DESTINATION,
    autoBackupTime         : gsStorage.AUTO_BACKUP_TIME,
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

  function populateOption(element, value) {
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox') {
      element.checked = value;
    }
    else if (element.tagName === 'INPUT' && element.getAttribute('type') === 'radio') {
      element.checked = (element.value === value);
    }
    else if (element.tagName === 'INPUT' && element.getAttribute('type') === 'time') {
      element.value = value;
    }
    else if (element.tagName === 'SELECT') {
      selectComboBox(element, value);
    }
  }

  function getOptionValue(element) {
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox') {
      return element.checked;
    }
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'radio') {
      return element.value;
    }
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'time') {
      return element.value;
    }
    if (element.tagName === 'SELECT') {
      return element.children[element.selectedIndex].value;
    }
  }

  function initSettings() {
    gsStorage.getSettings().then((settings) => {
      const optionEls = document.getElementsByClassName('option');
      for (let i = 0; i < optionEls.length; i++) {
        const element = optionEls[i];
        const pref = elementPrefMap[element.id];
        if (pref !== undefined) {
          populateOption(element, settings[pref]);
        }
      }

      const optionElsArr = Array.from(optionEls);
      for (const element of optionElsArr) {
        element.onchange = handleChange(element);
      }

      const isDrive = settings[gsStorage.AUTO_BACKUP_DESTINATION] === 'drive';
      setAutoBackupOptionsVisibility(settings[gsStorage.AUTO_BACKUP_ENABLED]);
      setDailyTimeVisibility(settings[gsStorage.AUTO_BACKUP_INTERVAL]);
      setIntervalWarning(settings[gsStorage.AUTO_BACKUP_INTERVAL]);
      setDestinationPanels(isDrive);
      updateDriveAuthUI();
    });
  }

  function setAutoBackupOptionsVisibility(visible) {
    const el = document.getElementById('autoBackupIntervalContainer');
    if (el) el.style.display = visible ? 'block' : 'none';
  }

  function setDailyTimeVisibility(intervalValue) {
    const el = document.getElementById('autoBackupTimeContainer');
    if (!el) return;
    if (parseFloat(intervalValue) === 24) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function setIntervalWarning(intervalValue) {
    const el = document.getElementById('autoBackupIntervalWarning');
    if (!el) return;
    if (parseFloat(intervalValue) >= 8) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function setDestinationPanels(isDrive) {
    const driveEl = document.getElementById('driveAuthContainer');
    const localEl = document.getElementById('localFolderInfo');
    if (driveEl) driveEl.style.display = isDrive ? 'block' : 'none';
    if (localEl) localEl.style.display = isDrive ? 'none' : 'block';
    if (!isDrive) {
      const btn = document.getElementById('driveSettingsBackupBtn');
      if (btn) btn.classList.add('hidden');
    }
  }

  async function updateDriveSettingsBackupBtn(isConnected) {
    const destination = await gsStorage.getOption(gsStorage.AUTO_BACKUP_DESTINATION);
    const btn         = document.getElementById('driveSettingsBackupBtn');
    if (!btn) return;
    if (destination === 'drive' && isConnected) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  let savedTimer = null;
  function showOptionSaved() {
    const el = document.getElementById('optionSavedStatus');
    if (!el) return;
    el.textContent = chrome.i18n.getMessage('js_backup_option_saved');
    el.classList.add('visible');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('visible'), 2000);
  }

  async function updateDriveAuthUI() {
    const connectedEl    = document.getElementById('driveConnectedInfo');
    const disconnectedEl = document.getElementById('driveDisconnectedInfo');
    const nameEl         = document.getElementById('driveUserName');
    const emailEl        = document.getElementById('driveUserEmail');
    if (!connectedEl || !disconnectedEl) return;

    const iconEl = document.getElementById('driveIcon');
    if (iconEl) {
      const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
      faviconUrl.searchParams.set('pageUrl', 'https://drive.google.com');
      faviconUrl.searchParams.set('size', '32');
      iconEl.src = faviconUrl.href;
    }

    const user = await gsBackup.getDriveUserInfo();
    const driveCard    = document.getElementById('restoreDriveCard');
    const restoreActions = document.getElementById('restoreActions');
    if (user && user.emailAddress) {
      if (nameEl)  nameEl.textContent  = user.displayName || '';
      emailEl.textContent          = user.emailAddress;
      connectedEl.style.display    = 'flex';
      disconnectedEl.style.display = 'none';

      const folderLink = document.getElementById('driveFolderLink');
      if (folderLink) {
        const url = await gsBackup.getDriveFolderUrl();
        if (url) {
          folderLink.href = url;
          folderLink.classList.remove('hidden');
        }
      }
      await updateDriveSettingsBackupBtn(true);

      try {
        const files = await gsBackup.listDriveBackups();
        if (files.length && driveCard) {
          const sel = document.getElementById('driveBackupsSelect');
          sel.innerHTML = '';
          for (const f of files) {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.name
              .replace(/\.json$/, '')
              .replace('tms-session-', '')
              .replace('T', ' ')
              .replace(/-(\d{2})-(\d{2})$/, ' $1:$2');
            sel.appendChild(opt);
          }
          driveCard.classList.remove('hidden');
          restoreActions?.classList.add('has-drive-card');
        }
      } catch (_) {
        // Drive list unavailable — silently keep card hidden
      }
    } else {
      connectedEl.style.display    = 'none';
      disconnectedEl.style.display = 'flex';
      const folderLink = document.getElementById('driveFolderLink');
      if (folderLink) folderLink.classList.add('hidden');
      await updateDriveSettingsBackupBtn(false);
      driveCard?.classList.add('hidden');
      restoreActions?.classList.remove('has-drive-card');
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

      if (pref === gsStorage.AUTO_BACKUP_ENABLED) {
        setAutoBackupOptionsVisibility(getOptionValue(element));
      }
      else if (pref === gsStorage.AUTO_BACKUP_INTERVAL) {
        setDailyTimeVisibility(getOptionValue(element));
        setIntervalWarning(getOptionValue(element));
      }
      else if (pref === gsStorage.AUTO_BACKUP_DESTINATION) {
        setDestinationPanels(getOptionValue(element) === 'drive');
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

        showOptionSaved();

        if (pref === gsStorage.AUTO_BACKUP_ENABLED || pref === gsStorage.AUTO_BACKUP_INTERVAL || pref === gsStorage.AUTO_BACKUP_TIME) {
          const enabled = await gsStorage.getOption(gsStorage.AUTO_BACKUP_ENABLED);
          if (pref === gsStorage.AUTO_BACKUP_ENABLED) {
            await gsBackup.syncAlarmWithSettings();
          } else if (enabled) {
            const interval = await gsStorage.getOption(gsStorage.AUTO_BACKUP_INTERVAL);
            await gsBackup.scheduleBackup(interval);
          }
          await updateBackupMeta();
        }
      }
    };
  }

  async function saveChange(element) {
    const pref     = elementPrefMap[element.id];
    const newValue = getOptionValue(element);
    const oldValue = await gsStorage.getOption(pref);

    if (oldValue !== newValue) {
      await gsStorage.setOptionAndSync(pref, newValue);
    }

    return [oldValue, newValue];
  }


  gsUtils.documentReadyAndLocalisedAsPromised(window).then(() => {
    gsUtils.initSelectArrows(document);
    initSettings();
    updateBackupMeta();

    // Back-to-top button
    const backToTopBtn = document.getElementById('backToTop');
    window.addEventListener('scroll', () => {
      backToTopBtn.classList.toggle('visible', window.scrollY > 200);
    }, { passive: true });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

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
          await new Promise((r) => setTimeout(r, 1500));
          const results = await chrome.downloads.search({ id: result });
          const item    = results && results[0];

          if (item && item.state === 'complete') {
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_done');
            await updateBackupMeta();
          } else {
            statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_error');
          }
        }
      } catch (e) {
        statusEl.textContent = chrome.i18n.getMessage('js_options_backup_now_error');
      }

      setTimeout(() => statusEl.classList.remove('visible'), 6000);
    });

    // Drive: save settings to Drive
    document.getElementById('driveSettingsBackupBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('settingsImportStatus');
      statusEl.textContent = chrome.i18n.getMessage('js_backup_drive_settings_saving');
      try {
        const settings = await gsStorage.getSettings();
        const json     = JSON.stringify(settings, null, 2);
        await gsBackup.performDriveSettingsBackup(json);
        statusEl.textContent = chrome.i18n.getMessage('js_backup_drive_settings_saved');
      } catch (e) {
        statusEl.textContent = chrome.i18n.getMessage('js_backup_drive_settings_error');
      }
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
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
        gsUtils.error('backup', 'Drive auth failed:', msg);
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
      const date      = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const filename  = `tms-settings-${date}.json`;
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

    // ── Restore from backup ─────────────────────────────────────────────────

    function showRestoreStatus(node) {
      const bar = document.getElementById('restoreStatusBar');
      if (!bar) return;
      bar.innerHTML = '';
      if (!node) return;
      bar.appendChild(node);
    }

    function buildRestoreSuccessNode(sessionName) {
      const msg  = chrome.i18n.getMessage('js_backup_restore_success', [sessionName]);
      const link = chrome.i18n.getMessage('js_backup_restore_go_sessions');
      const span = document.createElement('span');
      span.textContent = msg + ' ';
      const a = document.createElement('a');
      a.href = 'history.html';
      a.textContent = link;
      span.appendChild(a);
      return span;
    }

    function buildRestoreTextNode(msgKey) {
      const span = document.createElement('span');
      span.textContent = chrome.i18n.getMessage(msgKey);
      return span;
    }

    async function runImport(jsonText, sourceName) {
      showRestoreStatus(buildRestoreTextNode('js_backup_restore_importing'));
      try {
        const name = await gsBackup.importBackupJson(jsonText, sourceName);
        showRestoreStatus(buildRestoreSuccessNode(name));
      } catch (e) {
        const key = e?.message === 'TMS_IMPORT_EMPTY' || e?.message === 'TMS_IMPORT_INVALID_JSON'
          ? 'js_backup_restore_error_invalid'
          : 'js_backup_restore_error_generic';
        showRestoreStatus(buildRestoreTextNode(key));
      }
    }

    // Restore from local file
    document.getElementById('restoreFromFileBtn').addEventListener('click', () => {
      document.getElementById('restoreFile').click();
    });

    document.getElementById('restoreFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => runImport(ev.target.result, file.name);
      reader.readAsText(file);
    });

    // Restore from Drive
    document.getElementById('importDriveBackupBtn').addEventListener('click', async () => {
      const sel    = document.getElementById('driveBackupsSelect');
      const fileId = sel.value;
      const name   = sel.options[sel.selectedIndex]?.text || fileId;
      if (!fileId) return;
      showRestoreStatus(buildRestoreTextNode('js_backup_restore_importing'));
      try {
        const json = await gsBackup.downloadDriveBackupContent(fileId);
        await runImport(json, `tms-session-${name.replace(/\s/g, 'T').replace(':', '-')}.json`);
      } catch (_) {
        showRestoreStatus(buildRestoreTextNode('js_backup_restore_error_drive'));
      }
    });

    // hide incompatible sections if in incognito mode
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
