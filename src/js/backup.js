import  { gsBackup }   from './gsBackup.js';
import  { gsStorage }  from './gsStorage.js';
import  { gsUtils }    from './gsUtils.js';

(() => {

  const elementPrefMap = {
    autoBackupEnabled      : gsStorage.AUTO_BACKUP_ENABLED,
    autoBackupInterval     : gsStorage.AUTO_BACKUP_INTERVAL,
    autoBackupDestination  : gsStorage.AUTO_BACKUP_DESTINATION,
    autoBackupTime         : gsStorage.AUTO_BACKUP_TIME,
    autoBackupMaxFiles     : gsStorage.AUTO_BACKUP_MAX_FILES,
  };

  function renderDriveFilesList(files, registry) {
    const details = document.getElementById('section-drive-files');
    const listEl  = document.getElementById('driveFilesList');
    if (!details || !listEl) return;

    if (!files.length) {
      details.classList.add('hidden');
      return;
    }

    listEl.innerHTML = '';

    function formatSize(bytes) {
      if (!bytes) return '';
      const kb = Math.round(parseInt(bytes, 10) / 1024 * 10) / 10;
      return `${kb} KB`;
    }

    function formatDate(filename) {
      const m = filename.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.json$/);
      return m ? `${m[1]} ${m[2]}:${m[3]}` : filename;
    }

    function buildFileRow(f) {
      const row = document.createElement('div');
      row.className = 'driveFileRow';

      const label = document.createElement('span');
      label.className   = 'driveFileLabel';
      label.textContent = formatDate(f.name);

      const size = document.createElement('span');
      size.className   = 'driveFileSize';
      size.textContent = formatSize(f.size);

      const btn = document.createElement('button');
      btn.className = 'btn btnNeg btnSmall';
      btn.setAttribute('aria-label', `${chrome.i18n.getMessage('html_backup_drive_download_btn')} ${formatDate(f.name)}`);
      btn.textContent = chrome.i18n.getMessage('html_backup_drive_download_btn');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        row.querySelector('.driveFileError')?.remove();
        try {
          await gsBackup.downloadDriveBackupAsFile(f.id, f.name);
        } catch (_) {
          const errEl = document.createElement('span');
          errEl.className   = 'driveFileError';
          errEl.textContent = chrome.i18n.getMessage('js_backup_restore_error_drive');
          row.appendChild(errEl);
        } finally {
          btn.disabled = false;
        }
      });

      row.appendChild(label);
      row.appendChild(size);
      row.appendChild(btn);
      return row;
    }

    function buildGroup(title, groupFiles) {
      const group   = document.createElement('div');
      group.className = 'driveFilesGroup';
      const heading = document.createElement('p');
      heading.className   = 'driveFilesGroupTitle';
      heading.textContent = title;
      group.appendChild(heading);
      for (const f of groupFiles) group.appendChild(buildFileRow(f));
      return group;
    }

    const groups = new Map();
    const legacy = [];
    for (const f of files) {
      if (!f.deviceId) { legacy.push(f); continue; }
      if (!groups.has(f.deviceId)) groups.set(f.deviceId, []);
      groups.get(f.deviceId).push(f);
    }

    const hasMultiple = groups.size > 1 || (groups.size === 1 && legacy.length > 0);

    for (const [did, deviceFiles] of groups) {
      const name = registry[did]?.name || did;
      if (hasMultiple) {
        listEl.appendChild(buildGroup(name, deviceFiles));
      } else {
        for (const f of deviceFiles) listEl.appendChild(buildFileRow(f));
      }
    }

    if (legacy.length) {
      const legacyTitle = chrome.i18n.getMessage('js_backup_restore_legacy_group') || 'Legacy backups';
      listEl.appendChild(buildGroup(legacyTitle, legacy));
    }

    details.classList.remove('hidden');
  }

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
    else if (element.tagName === 'INPUT' && element.getAttribute('type') === 'number') {
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
    if (element.tagName === 'INPUT' && element.getAttribute('type') === 'number') {
      return parseInt(element.value, 10);
    }
    if (element.tagName === 'SELECT') {
      return element.children[element.selectedIndex].value;
    }
  }

  function initSettings() {
    gsStorage.getSettings().then(async (settings) => {
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

      const deviceName = await gsBackup.getDeviceName();
      const nameInput  = document.getElementById('backupDeviceName');
      if (nameInput) {
        nameInput.value       = deviceName;
        nameInput.placeholder = chrome.i18n.getMessage('html_backup_device_name_placeholder') || 'e.g. MacBook, PC lavoro';
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
      iconEl.src = chrome.runtime.getURL('img/google-drive.png');
    }

    const user = await gsBackup.getDriveUserInfo();
    const driveCard      = document.getElementById('restoreDriveCard');
    const restoreActions = document.getElementById('restoreActions');
    const settingsDriveCard = document.getElementById('settingsDriveCard');
    const settingsActions   = document.getElementById('settingsActions');

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

      // Show Drive settings card whenever Drive is connected
      settingsDriveCard?.classList.remove('hidden');
      settingsActions?.classList.add('has-drive-card');

      // Show date of last settings backup on Drive, if file exists
      try {
        const info    = await gsBackup.getDriveSettingsInfo();
        const dateEl  = document.getElementById('settingsDriveBackupDate');
        if (dateEl && info?.modifiedTime) {
          const d = new Date(info.modifiedTime);
          dateEl.textContent = chrome.i18n.getMessage('js_backup_settings_drive_last_backup', [d.toLocaleString()]);
          dateEl.classList.remove('hidden');
        }
      } catch (_) { /* silently skip if Drive unavailable */ }

      try {
        const [files, registry, myDeviceId] = await Promise.all([
          gsBackup.listDriveBackups(),
          gsBackup.listDeviceRegistry(),
          gsBackup.getDeviceId(),
        ]);

        // Show device name field only when other devices have backed up to this Drive account
        const hasOtherDevices = Object.keys(registry).some(id => id !== myDeviceId);
        const deviceNameGroup = document.getElementById('backupDeviceNameGroup');
        if (deviceNameGroup) {
          deviceNameGroup.classList.toggle('hidden', !hasOtherDevices);
        }

        if (files.length && driveCard) {
          const sel = document.getElementById('driveBackupsSelect');
          sel.innerHTML = '';

          function formatOptionLabel(filename) {
            return filename
              .replace(/\.json$/, '')
              .replace(/^tms-session-[a-f0-9]{8}-/, '')
              .replace(/^tms-session-/, '')
              .replace('T', ' ')
              .replace(/-(\d{2})-(\d{2})$/, ' $1:$2');
          }

          const groups = new Map();
          const legacy = [];
          for (const f of files) {
            if (!f.deviceId) { legacy.push(f); continue; }
            if (!groups.has(f.deviceId)) groups.set(f.deviceId, []);
            groups.get(f.deviceId).push(f);
          }

          if (hasOtherDevices) {
            // Multi-device: group by device name
            for (const [did, deviceFiles] of groups) {
              const info = registry[did];
              const grp  = document.createElement('optgroup');
              grp.label  = info?.name || did;
              for (const f of deviceFiles) {
                const opt       = document.createElement('option');
                opt.value       = f.id;
                opt.textContent = formatOptionLabel(f.name);
                grp.appendChild(opt);
              }
              sel.appendChild(grp);
            }

            if (legacy.length) {
              const grp = document.createElement('optgroup');
              grp.label = chrome.i18n.getMessage('js_backup_restore_legacy_group') || 'Legacy backups';
              for (const f of legacy) {
                const opt       = document.createElement('option');
                opt.value       = f.id;
                opt.textContent = formatOptionLabel(f.name);
                grp.appendChild(opt);
              }
              sel.appendChild(grp);
            }
          } else {
            // Single device: flat list, no optgroup headers
            for (const f of files) {
              const opt       = document.createElement('option');
              opt.value       = f.id;
              opt.textContent = formatOptionLabel(f.name);
              sel.appendChild(opt);
            }
          }

          driveCard.classList.remove('hidden');
          restoreActions?.classList.add('has-drive-card');
        }

        renderDriveFilesList(files, registry);
      } catch (_) {
        // Drive list unavailable — silently keep card hidden
        renderDriveFilesList([], {});
      }
    } else {
      connectedEl.style.display    = 'none';
      disconnectedEl.style.display = 'flex';
      const folderLink = document.getElementById('driveFolderLink');
      if (folderLink) folderLink.classList.add('hidden');

      settingsDriveCard?.classList.add('hidden');
      settingsActions?.classList.remove('has-drive-card');
      document.getElementById('settingsDriveBackupDate')?.classList.add('hidden');
      driveCard?.classList.add('hidden');
      restoreActions?.classList.remove('has-drive-card');
      renderDriveFilesList([], {});
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

  // ── Settings import/restore shared logic ──────────────────────────────────

  function showSettingsStatus(msgKey, clearAfterMs) {
    const bar = document.getElementById('settingsStatusBar');
    if (!bar) return;
    bar.textContent = msgKey ? chrome.i18n.getMessage(msgKey) : '';
    if (clearAfterMs) setTimeout(() => { bar.textContent = ''; }, clearAfterMs);
  }

  // Returns true if settings were applied, false if user cancelled.
  async function applySettingsJson(jsonText) {
    const imported  = JSON.parse(jsonText); // throws on invalid JSON
    const defaults  = gsStorage.getSettingsDefaults();
    const knownKeys = Object.keys(defaults);

    if (!imported || typeof imported !== 'object' || !knownKeys.some(k => Object.prototype.hasOwnProperty.call(imported, k))) {
      throw new Error('invalid');
    }

    if (!confirm(chrome.i18n.getMessage('js_options_settings_import_confirm'))) return false;

    const merged = { ...defaults };
    for (const key of knownKeys) {
      if (Object.prototype.hasOwnProperty.call(imported, key)) {
        merged[key] = imported[key];
      }
    }

    await gsStorage.saveSettings(merged);
    await gsStorage.syncSettings();
    return true;
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

    // Device name save
    document.getElementById('backupDeviceNameSaveBtn').addEventListener('click', async () => {
      const nameInput = document.getElementById('backupDeviceName');
      if (!nameInput) return;
      await gsBackup.setDeviceName(nameInput.value);
      showOptionSaved();
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
      // Option A: if a backup already exists, confirm before overwriting
      const existing = await gsBackup.getDriveSettingsInfo();
      if (existing) {
        const dateStr = new Date(existing.modifiedTime).toLocaleString();
        const msg     = chrome.i18n.getMessage('js_backup_settings_drive_overwrite_confirm', [dateStr]) ||
                        `Existing settings backup from ${dateStr}. Overwrite?`;
        if (!confirm(msg)) return;
      }
      showSettingsStatus('js_backup_drive_settings_saving');
      try {
        const settings = await gsStorage.getSettings();
        const json     = JSON.stringify(settings, null, 2);
        await gsBackup.performDriveSettingsBackup(json);
        // Refresh date badge after successful save
        const updated = await gsBackup.getDriveSettingsInfo();
        const dateEl  = document.getElementById('settingsDriveBackupDate');
        if (dateEl && updated) {
          dateEl.textContent = chrome.i18n.getMessage('js_backup_settings_drive_last_backup', [
            new Date(updated.modifiedTime).toLocaleString(),
          ]);
          dateEl.classList.remove('hidden');
        }
        showSettingsStatus('js_backup_drive_settings_saved', 4000);
      } catch (e) {
        showSettingsStatus('js_backup_drive_settings_error', 4000);
      }
    });

    // Drive: restore settings from Drive
    document.getElementById('driveSettingsRestoreBtn').addEventListener('click', async () => {
      showSettingsStatus('js_backup_settings_drive_downloading');
      try {
        const json    = await gsBackup.downloadDriveSettingsContent();
        const applied = await applySettingsJson(json);
        if (applied) {
          showSettingsStatus('js_backup_settings_drive_restore_success');
          setTimeout(() => window.location.reload(), 1500);
        } else {
          showSettingsStatus(null);
        }
      } catch (e) {
        if (e?.message === 'TMS_SETTINGS_NOT_FOUND') {
          showSettingsStatus('js_backup_settings_drive_not_found', 5000);
        } else if (e?.message === 'invalid') {
          showSettingsStatus('js_options_settings_import_error', 5000);
        } else {
          showSettingsStatus('js_backup_settings_drive_restore_error', 5000);
        }
      }
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

    // Import settings from local file
    document.getElementById('importSettingsBtn').addEventListener('click', () => {
      document.getElementById('importSettingsFile').click();
    });

    document.getElementById('importSettingsFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';

      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const applied = await applySettingsJson(ev.target.result);
          if (applied) {
            showSettingsStatus('js_options_settings_import_success');
            setTimeout(() => window.location.reload(), 1500);
          } else {
            showSettingsStatus(null);
          }
        } catch (_) {
          showSettingsStatus('js_options_settings_import_error', 5000);
        }
      };
      reader.readAsText(file);
    });

    // ── Restore session from backup ─────────────────────────────────────────

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

    // Restore session from local file
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

    // Restore session from Drive
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
