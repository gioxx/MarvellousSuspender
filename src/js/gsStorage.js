import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

'use strict';

// Share reads within this context; Chrome remains the source of truth across contexts.
/** @type { object | Promise<object> | null } */
let settingsPromise = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.gsSettings) settingsPromise = null;
});

// Every write of the settings object is a read-modify-write of the whole object, so two
// overlapping ones could write back a stale copy. Per context: a page has its own chain.
let _settingsWriteChain = Promise.resolve();

function withSettingsLock(fn) {
  const result = _settingsWriteChain.then(fn, fn);
  _settingsWriteChain = result.then(() => {}, () => {});
  return result;
}

//defaults filled in, not saved. Use this inside the lock: getSettings() would deadlock there
async function readSettings() {
  const settings = await gsStorage.getStorage('local', 'gsSettings');
  if (!settings) {
    return { settings: gsStorage.getSettingsDefaults(), backfilled: true };
  }
  const defaults = gsStorage.getSettingsDefaults();
  let backfilled = false;
  for (const prop in defaults) {
    if (typeof settings[prop] === 'undefined' || settings[prop] === null) {
      settings[prop] = defaults[prop];
      backfilled = true;
    }
  }
  return { settings, backfilled };
}

export const gsStorage = {
  SCREEN_CAPTURE                : 'screenCapture',
  SCREEN_CAPTURE_FORCE          : 'screenCaptureForce',
  SCREEN_CAPTURE_METHOD         : 'screenCaptureMethod',
  SCREEN_CAPTURE_PRECAPTURE     : 'screenCapturePrecapture',
  SUSPEND_IN_PLACE_OF_DISCARD   : 'suspendInPlaceOfDiscard',
  UNSUSPEND_ON_FOCUS            : 'gsUnsuspendOnFocus',
  RELOAD_UNSUSPEND_BACKGROUND   : 'gsReloadUnsuspendBackground',
  SUSPEND_TIME                  : 'gsTimeToSuspend',
  SUSPEND_TIME_ON_BATTERY       : 'gsTimeToSuspendOnBattery',
  IGNORE_WHEN_OFFLINE           : 'onlineCheck',
  IGNORE_WHEN_CHARGING          : 'batteryCheck',
  CLAIM_BY_DEFAULT              : 'claimByDefault',
  IGNORE_PINNED                 : 'gsDontSuspendPinned',
  IGNORE_FORMS                  : 'gsDontSuspendForms',
  IGNORE_AUDIO                  : 'gsDontSuspendAudio',
  IGNORE_ACTIVE_TABS            : 'gsDontSuspendActiveTabs',
  IGNORE_APP_WINDOWS            : 'gsDontSuspendAppWindows',
  IGNORE_GROUPED_TABS           : 'gsDontSuspendGroupedTabs',
  IGNORE_SCROLL_POS             : 'gsDontRestoreScrollPos',
  IGNORE_CACHE                  : 'gsIgnoreCache',
  ADD_CONTEXT                   : 'gsAddContextMenu',
  SYNC_SETTINGS                 : 'gsSyncSettings',
  NO_NAG                        : 'gsNoNag',
  THEME                         : 'gsTheme',
  LEGACY_MASCOT                 : 'gsLegacyMascot',
  LANGUAGE                      : 'gsLanguage',
  WHITELIST                     : 'gsWhitelist',
  ALWAYS_SUSPEND_LIST           : 'gsAlwaysSuspendList',
  NEVER_SUSPEND_GROUPS          : 'gsNeverSuspendGroups',

  DISCARD_AFTER_SUSPEND         : 'discardAfterSuspend',
  DISCARD_IN_PLACE_OF_SUSPEND   : 'discardInPlaceOfSuspend',

  AUTO_BACKUP_ENABLED           : 'gsAutoBackupEnabled',
  AUTO_BACKUP_INTERVAL          : 'gsAutoBackupInterval',
  AUTO_BACKUP_DESTINATION       : 'gsAutoBackupDestination',
  AUTO_BACKUP_TIME              : 'gsAutoBackupTime',
  AUTO_BACKUP_MAX_FILES         : 'gsAutoBackupMaxFiles',

  BACKUP_NUDGE_DISMISSED_UNTIL  : 'gsBackupNudgeDismissedUntil',
  BACKUP_NUDGE_OPTOUT           : 'gsBackupNudgeOptOut',

  NEWS_FEED_ENABLED             : 'gsNewsFeedEnabled',
  PERMISSIONS_NOTICE_SEEN       : 'gsPermissionsNoticeSeen',

  APP_VERSION                   : 'gsVersion',
  LAST_EXTENSION_RECOVERY       : 'gsExtensionRecovery',
  UPDATE_AVAILABLE              : 'gsUpdateAvailable',
  LAST_SEEN_CHANGELOG_VERSION   : 'gsLastSeenChangelogVersion',

  DEFAULT_FAVICON_FINGERPRINTS  : 'gsDefaultFaviconFingerprints',

  CAPTURE_LOGS                  : 'gsCaptureVerbose',

  APPEND_URL_TO_TITLE           : 'gsAppendUrlToTitle',
  ADD_YOUTUBE_TIMESTAMP         : 'gsAddYouTubeTimestamp',

  noop: function() {},

  getSettingsDefaults: function() {
    const defaults = {};
    defaults[gsStorage.SCREEN_CAPTURE] = '0';
    defaults[gsStorage.SCREEN_CAPTURE_FORCE] = false;
    defaults[gsStorage.SCREEN_CAPTURE_METHOD] = 'auto';
    defaults[gsStorage.SCREEN_CAPTURE_PRECAPTURE] = false;
    defaults[gsStorage.SUSPEND_IN_PLACE_OF_DISCARD] = false;
    defaults[gsStorage.DISCARD_IN_PLACE_OF_SUSPEND] = false;
    defaults[gsStorage.DISCARD_AFTER_SUSPEND] = false;
    defaults[gsStorage.IGNORE_WHEN_OFFLINE] = false;
    defaults[gsStorage.IGNORE_WHEN_CHARGING] = false;
    defaults[gsStorage.CLAIM_BY_DEFAULT] = false;
    defaults[gsStorage.UNSUSPEND_ON_FOCUS] = false;
    defaults[gsStorage.RELOAD_UNSUSPEND_BACKGROUND] = false;
    defaults[gsStorage.IGNORE_PINNED] = true;
    defaults[gsStorage.IGNORE_FORMS] = true;
    defaults[gsStorage.IGNORE_AUDIO] = true;
    defaults[gsStorage.IGNORE_ACTIVE_TABS] = true;
    defaults[gsStorage.IGNORE_APP_WINDOWS] = true;
    defaults[gsStorage.IGNORE_GROUPED_TABS] = false;
    defaults[gsStorage.IGNORE_SCROLL_POS] = false;
    defaults[gsStorage.IGNORE_CACHE] = false;
    defaults[gsStorage.ADD_CONTEXT] = true;
    defaults[gsStorage.SYNC_SETTINGS] = true;
    defaults[gsStorage.SUSPEND_TIME] = '60';
    defaults[gsStorage.SUSPEND_TIME_ON_BATTERY] = '';
    defaults[gsStorage.NO_NAG] = false;
    defaults[gsStorage.WHITELIST] = '';
    defaults[gsStorage.ALWAYS_SUSPEND_LIST] = '';
    defaults[gsStorage.NEVER_SUSPEND_GROUPS] = '';
    defaults[gsStorage.THEME] = 'system';
    defaults[gsStorage.LEGACY_MASCOT] = false;
    defaults[gsStorage.LANGUAGE] = 'auto';
    defaults[gsStorage.UPDATE_AVAILABLE] = false; //Set to true for debug
    defaults[gsStorage.AUTO_BACKUP_ENABLED] = false;
    defaults[gsStorage.AUTO_BACKUP_INTERVAL] = '1';
    defaults[gsStorage.AUTO_BACKUP_DESTINATION] = 'local';
    defaults[gsStorage.AUTO_BACKUP_TIME] = '09:00';
    defaults[gsStorage.AUTO_BACKUP_MAX_FILES] = 10;
    defaults[gsStorage.BACKUP_NUDGE_DISMISSED_UNTIL] = 0;
    defaults[gsStorage.BACKUP_NUDGE_OPTOUT] = false;
    defaults[gsStorage.NEWS_FEED_ENABLED] = true;
    defaults[gsStorage.PERMISSIONS_NOTICE_SEEN] = false;
    defaults[gsStorage.APPEND_URL_TO_TITLE] = true;
    defaults[gsStorage.ADD_YOUTUBE_TIMESTAMP] = true;

    return defaults;
  },

  /**
   * LOCAL STORAGE FUNCTIONS
   */

  //populate local storage settings with sync settings where undefined
  initSettingsAsPromised: function() {
    return new Promise(function(resolve) {
      var defaultSettings = gsStorage.getSettingsDefaults();
      var defaultKeys = Object.keys(defaultSettings);
      chrome.storage.sync.get(defaultKeys, async (syncedSettings) => {
        gsUtils.log('gsStorage', 'syncedSettings on init: ', syncedSettings);
        await gsSession.setSynchedSettingsOnInit(syncedSettings);

        chrome.storage.local.get(['gsSettings'], async (result) => {

          var rawLocalSettings = result.gsSettings;
          if (typeof rawLocalSettings === 'string' && (rawLocalSettings[0] === '{' || rawLocalSettings[0] === '[' || rawLocalSettings[0] === '"')) {
            try {
              rawLocalSettings = JSON.parse(rawLocalSettings);
            } catch (e) {
              gsUtils.error( 'gsStorage', 'Failed to parse gsSettings: ', result, );
              rawLocalSettings = null;
            }
          }

          if (!rawLocalSettings) {
            rawLocalSettings = {};
          } else {
            //if we have some rawLocalSettings but SYNC_SETTINGS is not defined
            //then define it as FALSE (as opposed to default of TRUE)
            rawLocalSettings[gsStorage.SYNC_SETTINGS] =
              rawLocalSettings[gsStorage.SYNC_SETTINGS] || false;
          }
          gsUtils.log('gsStorage', 'localSettings on init: ', rawLocalSettings);
          var shouldSyncSettings = rawLocalSettings[gsStorage.SYNC_SETTINGS];

          var mergedSettings = {};
          for (const key of defaultKeys) {
            if (key === gsStorage.SYNC_SETTINGS) {
              if (chrome.extension.inIncognitoContext) {
                mergedSettings[key] = false;
              } else {
                mergedSettings[key] = rawLocalSettings.hasOwnProperty(key)
                  ? rawLocalSettings[key]
                  : defaultSettings[key];
              }
              continue;
            }
            // If nags are disabled locally, then ensure we disable them on synced profile
            if (
              key === gsStorage.NO_NAG &&
              shouldSyncSettings &&
              rawLocalSettings.hasOwnProperty(gsStorage.NO_NAG) &&
              rawLocalSettings[gsStorage.NO_NAG]
            ) {
              mergedSettings[gsStorage.NO_NAG] = true;
              continue;
            }
            // if synced setting exists and local setting does not exist or
            // syncing is enabled locally then overwrite with synced value
            if (
              syncedSettings.hasOwnProperty(key) &&
              (!rawLocalSettings.hasOwnProperty(key) || shouldSyncSettings)
            ) {
              mergedSettings[key] = syncedSettings[key];
            }
            //fallback on rawLocalSettings
            if (!mergedSettings.hasOwnProperty(key)) {
              mergedSettings[key] = rawLocalSettings[key];
            }
            //fallback on defaultSettings
            if (
              typeof mergedSettings[key] === 'undefined' ||
              mergedSettings[key] === null
            ) {
              gsUtils.warning( 'gsStorage', 'Missing key: ' + key + '! Will init with default.' );
              mergedSettings[key] = defaultSettings[key];
            }
          }
          await gsStorage.saveSettings(mergedSettings);
          gsUtils.log('gsStorage', 'mergedSettings: ', mergedSettings);

          // if any of the new settings are different to those in sync, then trigger a resync
          var triggerResync = false;
          for (const key of defaultKeys) {
            if (
              key !== gsStorage.SYNC_SETTINGS &&
              syncedSettings[key] !== mergedSettings[key]
            ) {
              triggerResync = true;
            }
          }
          if (triggerResync) {
            await gsStorage.syncSettings();
          }
          gsStorage.addSettingsSyncListener();
          gsUtils.log('gsStorage', 'init successful');
          resolve();

        });

      });
    });
  },

  // Listen for changes to synced settings
  addSettingsSyncListener: function() {
    chrome.storage.onChanged.addListener(async (remoteSettings, namespace) => {
      if (namespace !== 'sync' || !remoteSettings) {
        return;
      }
      const shouldSync = await gsStorage.getOption(gsStorage.SYNC_SETTINGS);
      if (shouldSync) {
        var changedSettingKeys = [];
        var oldValueBySettingKey = {};
        var newValueBySettingKey = {};
        await withSettingsLock(async () => {
          const { settings: localSettings, backfilled } = await readSettings();
          Object.keys(remoteSettings).forEach(function(key) {
            var remoteSetting = remoteSettings[key];

            // If nags are disabled locally, then ensure we disable them on synced profile
            if (key === gsStorage.NO_NAG) {
              if (remoteSetting.newValue === false) {
                return false; // don't process this key
              }
            }

            // based on a value this device has since moved past: applying it restores a stale one
            if (remoteSetting.oldValue !== undefined
              && localSettings[key] !== remoteSetting.oldValue
              && localSettings[key] !== remoteSetting.newValue) {
              return false;
            }

            if (localSettings[key] !== remoteSetting.newValue) {
              gsUtils.log( 'gsStorage', 'Changed value from sync', key, remoteSetting.newValue );
              changedSettingKeys.push(key);
              oldValueBySettingKey[key] = localSettings[key];
              newValueBySettingKey[key] = remoteSetting.newValue;
              localSettings[key] = remoteSetting.newValue;
            }
          });
          if (changedSettingKeys.length > 0 || backfilled) {
            await gsStorage.saveSettings(localSettings);
          }
        });

        if (changedSettingKeys.length > 0) {
          gsUtils.performPostSaveUpdates(
            changedSettingKeys,
            oldValueBySettingKey,
            newValueBySettingKey,
          );
        }
      }
    });
  },

  //due to migration issues and new settings being added, i have built in some redundancy
  //here so that getOption will always return a valid value.
  //no save here, getSettings() does it under the lock
  getOption: async (prop) => {
    const settings = await gsStorage.getSettings();
    return settings[prop] ?? gsStorage.getSettingsDefaults()[prop];
  },

  setOption: async (prop, value) => {
    await withSettingsLock(async () => {
      const { settings } = await readSettings();
      settings[prop] = value;
      await gsStorage.saveSettings(settings);
    });
  },

  // Calling syncSettings has the unfortunate side-effect of triggering the chrome.storage.onChanged
  // listener which the re-saves the setting to local storage a second time.
  setOptionAndSync: async (prop, value) => {
    await gsStorage.setOption(prop, value);
    await gsStorage.syncSettings();
  },

  /**
   * @param {'session'|'local'} store
   * @param {string}            name
   */
  getStorage: async (store, name) => {
    const result = await chrome.storage[store].get([name]);
    let value = result[name];
    if (typeof value === 'string' && (value[0] === '{' || value[0] === '[' || value[0] === '"')) {
      try {
        value = JSON.parse(value);
      } catch (e) {
        gsUtils.error( 'gsStorage', 'Failed to parse', name, value );
      }
    }
    return value;
  },

  getStorageJSON: async (store, name) => {
    return gsStorage.getStorage(store, name);
  },

  /**
   * @param {'session'|'local'} store
   * @param {string}            name
   * @param {any}               value
   */
  saveStorage: async (store, name, value) => {
    await chrome.storage[store].set({ [name]: value });
    if (chrome.runtime.lastError) {
      gsUtils.error( 'gsStorage', 'failed to save to local storage', chrome.runtime.lastError );
    }
  },

  /**
   * @param {'session'|'local'} store
   * @param {string}            name
   */
  deleteStorage: async (store, name) => {
    await chrome.storage[store].remove([name]);
    if (chrome.runtime.lastError) {
      gsUtils.error( 'gsStorage', 'failed to remove from local storage', chrome.runtime.lastError );
    }
  },

  fetchSettings: async () => {
    const { settings, backfilled } = await readSettings();
    if (backfilled) {
      // Save from a fresh read under the lock, so a newer write is not overwritten.
      await withSettingsLock(async () => {
        const fresh = await readSettings();
        if (fresh.backfilled) {
          await gsStorage.saveSettings(fresh.settings);
        }
      });
    }
    return settings;
  },

  getSettings: async () => {
    if (settingsPromise) return structuredClone(await settingsPromise);
    try {
      const pending = gsStorage.fetchSettings();
      settingsPromise = pending;
      const setting = await settingsPromise;
      if (settingsPromise === pending) settingsPromise = setting;
      return structuredClone(setting);
    }
    catch (error) {
      settingsPromise = null;
      throw error;
    }
  },

  saveSettings: async (settings) => {
    // gsUtils.log(0, 'saveSettings');
    settingsPromise = null;
    try {
      await gsStorage.saveStorage('local', 'gsSettings', settings);
    }
    finally {
      settingsPromise = null;
    }
  },

  getTabState: async (tabId) => {
    return gsStorage.getStorage('session', `gsTab${tabId}`);
  },

  saveTabState: async (tabId, state) => {
    if (!tabId) {
      gsUtils.error('saveTabState', 'Missing tabId');
      return;
    }
    gsStorage.saveStorage('session', `gsTab${tabId}`, state);
  },

  deleteTabState: async (tabId) => {
    await chrome.storage.session.remove([`gsTab${tabId}`]);
    if (chrome.runtime.lastError) {
      gsUtils.error( 'gsStorage', 'failed delete from local storage', chrome.runtime.lastError );
    }
  },

  // Push settings to sync
  syncSettings: async () => {
    // gsUtils.log('syncSettings');
    const settings = await gsStorage.getSettings();
    if (settings[gsStorage.SYNC_SETTINGS]) {
      // Since sync is a local setting, delete it to simplify things.
      delete settings[gsStorage.SYNC_SETTINGS];
      gsUtils.log('gsStorage', 'gsStorage', 'Pushing local settings to sync', settings);
      try {
        await chrome.storage.sync.set(settings);
      }
      catch (e) {
        gsUtils.error('gsStorage', 'failed to save to chrome.storage.sync: ', e);
      }
    }
  },

  fetchLastVersion: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get([gsStorage.APP_VERSION], (result) => {
        var version = result[gsStorage.APP_VERSION];
        if (typeof version === 'string' && (version[0] === '{' || version[0] === '[' || version[0] === '"')) {
          try {
            version = JSON.parse(version);
          } catch (e) {
            gsUtils.error(
              'gsStorage',
              'Failed to parse ' + gsStorage.APP_VERSION + ': ',
              result,
            );
          }
        }
        version = version || '0.0.0';
        resolve(version + '');
      });
    });
  },

  setLastVersion: function(newVersion) {
    chrome.storage.local.set({ [gsStorage.APP_VERSION]: newVersion }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.error(
          'gsStorage',
          'failed to save ' + gsStorage.APP_VERSION + ' to local storage',
          chrome.runtime.lastError
        );
      }
    });
  },

  fetchLastSeenChangelogVersion: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get([gsStorage.LAST_SEEN_CHANGELOG_VERSION], (result) => {
        resolve(result[gsStorage.LAST_SEEN_CHANGELOG_VERSION] || '');
      });
    });
  },

  setLastSeenChangelogVersion: function(newVersion) {
    chrome.storage.local.set({ [gsStorage.LAST_SEEN_CHANGELOG_VERSION]: newVersion }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.error(
          'gsStorage',
          'failed to save ' + gsStorage.LAST_SEEN_CHANGELOG_VERSION + ' to local storage',
          chrome.runtime.lastError
        );
      }
    });
  },

  fetchLastExtensionRecoveryTimestamp: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get([gsStorage.LAST_EXTENSION_RECOVERY], (result) => {
        var lastExtensionRecoveryTimestamp = result[gsStorage.LAST_EXTENSION_RECOVERY];
        if (typeof lastExtensionRecoveryTimestamp === 'string' && (lastExtensionRecoveryTimestamp[0] === '{' || lastExtensionRecoveryTimestamp[0] === '[' || lastExtensionRecoveryTimestamp[0] === '"')) {
          try {
            lastExtensionRecoveryTimestamp = JSON.parse(lastExtensionRecoveryTimestamp);
          } catch (e) {
            gsUtils.error(
              'gsStorage',
              'Failed to parse ' + gsStorage.LAST_EXTENSION_RECOVERY + ': ',
              result,
            );
          }
        }
        resolve(lastExtensionRecoveryTimestamp);
      });
    });
  },

  setLastExtensionRecoveryTimestamp: function(extensionRecoveryTimestamp) {
    chrome.storage.local.set({ [gsStorage.LAST_EXTENSION_RECOVERY]: extensionRecoveryTimestamp }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.error(
          'gsStorage',
          'failed to save ' +
          gsStorage.LAST_EXTENSION_RECOVERY +
          ' to local storage',
          chrome.runtime.lastError
        );
      }
    });
  },

};
