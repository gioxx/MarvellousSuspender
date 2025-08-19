import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

'use strict';

export const gsStorage = {
  SCREEN_CAPTURE                : 'screenCapture',
  SCREEN_CAPTURE_FORCE          : 'screenCaptureForce',
  SUSPEND_IN_PLACE_OF_DISCARD   : 'suspendInPlaceOfDiscard',
  UNSUSPEND_ON_FOCUS            : 'gsUnsuspendOnFocus',
  SUSPEND_TIME                  : 'gsTimeToSuspend',
  IGNORE_WHEN_OFFLINE           : 'onlineCheck',
  IGNORE_WHEN_CHARGING          : 'batteryCheck',
  CLAIM_BY_DEFAULT              : 'claimByDefault',
  IGNORE_PINNED                 : 'gsDontSuspendPinned',
  IGNORE_FORMS                  : 'gsDontSuspendForms',
  IGNORE_AUDIO                  : 'gsDontSuspendAudio',
  IGNORE_ACTIVE_TABS            : 'gsDontSuspendActiveTabs',
  IGNORE_CACHE                  : 'gsIgnoreCache',
  ADD_CONTEXT                   : 'gsAddContextMenu',
  SYNC_SETTINGS                 : 'gsSyncSettings',
  NO_NAG                        : 'gsNoNag',
  THEME                         : 'gsTheme',
  WHITELIST                     : 'gsWhitelist',

  DISCARD_AFTER_SUSPEND         : 'discardAfterSuspend',
  DISCARD_IN_PLACE_OF_SUSPEND   : 'discardInPlaceOfSuspend',

  APP_VERSION                   : 'gsVersion',
  LAST_NOTICE                   : 'gsNotice',
  LAST_EXTENSION_RECOVERY       : 'gsExtensionRecovery',
  UPDATE_AVAILABLE              : 'gsUpdateAvailable',

  DEFAULT_FAVICON_FINGERPRINTS  : 'gsDefaultFaviconFingerprints',

  noop: function() {},

  getSettingsDefaults: function() {
    const defaults = {};
    defaults[gsStorage.SCREEN_CAPTURE] = '0';
    defaults[gsStorage.SCREEN_CAPTURE_FORCE] = false;
    defaults[gsStorage.SUSPEND_IN_PLACE_OF_DISCARD] = false;
    defaults[gsStorage.DISCARD_IN_PLACE_OF_SUSPEND] = false;
    defaults[gsStorage.DISCARD_AFTER_SUSPEND] = false;
    defaults[gsStorage.IGNORE_WHEN_OFFLINE] = false;
    defaults[gsStorage.IGNORE_WHEN_CHARGING] = false;
    defaults[gsStorage.CLAIM_BY_DEFAULT] = false;
    defaults[gsStorage.UNSUSPEND_ON_FOCUS] = false;
    defaults[gsStorage.IGNORE_PINNED] = true;
    defaults[gsStorage.IGNORE_FORMS] = true;
    defaults[gsStorage.IGNORE_AUDIO] = true;
    defaults[gsStorage.IGNORE_ACTIVE_TABS] = true;
    defaults[gsStorage.IGNORE_CACHE] = false;
    defaults[gsStorage.ADD_CONTEXT] = true;
    defaults[gsStorage.SYNC_SETTINGS] = true;
    defaults[gsStorage.SUSPEND_TIME] = '60';
    defaults[gsStorage.NO_NAG] = false;
    defaults[gsStorage.WHITELIST] = '';
    defaults[gsStorage.THEME] = 'system';
    defaults[gsStorage.UPDATE_AVAILABLE] = false; //Set to true for debug

    return defaults;
  },

  /**
   * LOCAL STORAGE FUNCTIONS
   */

  // @TODO: try to remove JSON calls since the storage does it natively -- but what about existing saved options?

  //populate local storage settings with sync settings where undefined
  initSettingsAsPromised: function() {
    return new Promise(function(resolve) {
      var defaultSettings = gsStorage.getSettingsDefaults();
      var defaultKeys = Object.keys(defaultSettings);
      chrome.storage.sync.get(defaultKeys, async (syncedSettings) => {
        gsUtils.log('gsStorage', 'syncedSettings on init: ', syncedSettings);
        await gsSession.setSynchedSettingsOnInit(syncedSettings);

        chrome.storage.local.get(['gsSettings'], async (result) => {

          var rawLocalSettings;
          try {
            rawLocalSettings = JSON.parse(result.gsSettings || null);
          } catch (e) {
            gsUtils.error( 'gsStorage', 'Failed to parse gsSettings: ', result, );
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
        const localSettings = await gsStorage.getSettings();
        var changedSettingKeys = [];
        var oldValueBySettingKey = {};
        var newValueBySettingKey = {};
        Object.keys(remoteSettings).forEach(function(key) {
          var remoteSetting = remoteSettings[key];

          // If nags are disabled locally, then ensure we disable them on synced profile
          if (key === gsStorage.NO_NAG) {
            if (remoteSetting.newValue === false) {
              return false; // don't process this key
            }
          }

          if (localSettings[key] !== remoteSetting.newValue) {
            gsUtils.log( 'gsStorage', 'Changed value from sync', key, remoteSetting.newValue );
            changedSettingKeys.push(key);
            oldValueBySettingKey[key] = localSettings[key];
            newValueBySettingKey[key] = remoteSetting.newValue;
            localSettings[key] = remoteSetting.newValue;
          }
        });

        if (changedSettingKeys.length > 0) {
          await gsStorage.saveSettings(localSettings);
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
  getOption: async (prop) => {
    const settings = await gsStorage.getSettings();
    if (typeof settings[prop] === 'undefined' || settings[prop] === null) {
      settings[prop] = gsStorage.getSettingsDefaults()[prop];
      await gsStorage.saveSettings(settings);
    }
    return settings[prop];
  },

  setOption: async (prop, value) => {
    const settings = await gsStorage.getSettings();
    settings[prop] = value;
    await gsStorage.saveSettings(settings);
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
  getStorageJSON: async (store, name) => {
    const result = await chrome.storage[store].get([name]);
    let value;
    try {
      value = JSON.parse(result[name] || null);
    } catch (e) {
      gsUtils.error( 'gsStorage', 'Failed to parse gsSettings: ', result );
    }
    return value;
  },

  /**
   * @param {'session'|'local'} store
   * @param {string}            name
   * @param {any}               value
   */
  saveStorage: async (store, name, value) => {
    await chrome.storage[store].set({ [name]: JSON.stringify(value) });
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

  getSettings: async () => {
    let settings = await gsStorage.getStorageJSON('local', 'gsSettings');
    if (!settings) {
      settings = gsStorage.getSettingsDefaults();
      await gsStorage.saveSettings(settings);
    }
    return settings;
  },

  saveSettings: async (settings) => {
    // gsUtils.log(0, 'saveSettings');
    return gsStorage.saveStorage('local', 'gsSettings', settings);
  },

  getTabState: async (tabId) => {
    return gsStorage.getStorageJSON('session', `gsTab${tabId}`);
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
      chrome.storage.sync.set(settings, () => {
        if (chrome.runtime.lastError) {
          gsUtils.error('gsStorage', 'failed to save to chrome.storage.sync: ', chrome.runtime.lastError);
        }
      });
    }
  },

  fetchLastVersion: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get([gsStorage.APP_VERSION], (result) => {
        var version;
        try {
          version = JSON.parse(result[gsStorage.APP_VERSION] || null);
        } catch (e) {
          gsUtils.error(
            'gsStorage',
            'Failed to parse ' + gsStorage.APP_VERSION + ': ',
            result,
          );
        }
        version = version || '0.0.0';
        resolve(version + '');
      });
    });
  },

  setLastVersion: function(newVersion) {
    chrome.storage.local.set({ [gsStorage.APP_VERSION]: JSON.stringify(newVersion) }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.error(
          'gsStorage',
          'failed to save ' + gsStorage.APP_VERSION + ' to local storage',
          chrome.runtime.lastError
        );
      }
    });
  },

  setNoticeVersion: function(newVersion) {
    chrome.storage.local.set({ [gsStorage.LAST_NOTICE]: JSON.stringify(newVersion) }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.error(
          'gsStorage',
          'failed to save ' + gsStorage.LAST_NOTICE + ' to local storage',
          chrome.runtime.lastError
        );
      }
    });
  },

  fetchLastExtensionRecoveryTimestamp: function() {
    return new Promise((resolve) => {
      chrome.storage.local.get([gsStorage.LAST_EXTENSION_RECOVERY], (result) => {
        var lastExtensionRecoveryTimestamp;
        try {
          lastExtensionRecoveryTimestamp = JSON.parse(result[gsStorage.LAST_EXTENSION_RECOVERY] || null);
        } catch (e) {
          gsUtils.error(
            'gsStorage',
            'Failed to parse ' + gsStorage.LAST_EXTENSION_RECOVERY + ': ',
            result,
          );
        }
        resolve(lastExtensionRecoveryTimestamp);
      });
    });
  },

  setLastExtensionRecoveryTimestamp: function(extensionRecoveryTimestamp) {
    chrome.storage.local.set({ [gsStorage.LAST_EXTENSION_RECOVERY]: JSON.stringify(extensionRecoveryTimestamp) }, () => {
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
