import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';

export const gsMessages = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',

  sendInitTabToContentScript( tabId, ignoreForms, tempWhitelist, scrollPos, callback ) {
    var payload = { ignoreForms, tempWhitelist };
    if (scrollPos) {
      payload.scrollPos = scrollPos;
    }
    gsMessages.sendMessageToContentScript( tabId, payload, gsMessages.ERROR, callback );
  },

  sendUpdateToContentScriptOfTab: async (tab) => {
    if (
      gsUtils.isSpecialTab(tab) ||
      gsUtils.isSuspendedTab(tab, true) ||
      gsUtils.isDiscardedTab(tab)
    ) {
      return;
    }

    const ignoreForms = await gsStorage.getOption(gsStorage.IGNORE_FORMS);
    gsMessages.sendMessageToContentScript( tab.id, { ignoreForms }, gsMessages.WARNING );
  },

  sendTemporaryWhitelistToContentScript: function(tabId, callback) {
    gsMessages.sendMessageToContentScript( tabId, { tempWhitelist: true, }, gsMessages.WARNING, callback );
  },

  sendUndoTemporaryWhitelistToContentScript: function(tabId, callback) {
    gsMessages.sendMessageToContentScript( tabId, { tempWhitelist: false, }, gsMessages.WARNING, callback );
  },

  sendRequestInfoToContentScript(tabId, callback) {
    gsMessages.sendMessageToContentScript( tabId, { action: 'requestInfo', }, gsMessages.WARNING, callback );
  },

  sendMessageToContentScript: function(tabId, message, severity, callback) {
    gsMessages.sendMessageToTab(tabId, message, severity, ( error, response ) => {
      if (error) {
        if (callback) callback(error);
      }
      else {
        if (callback) callback(null, response);
      }
    });
  },

  sendPingToTab: function(tabId, callback) {
    gsMessages.sendMessageToTab( tabId, { action: 'ping', }, gsMessages.INFO, callback );
  },

  sendMessageToTab: function(tabId, message, severity, callback) {
    if (!tabId) {
      if (callback) callback('tabId not specified');
      return;
    }
    var responseHandler = function(response) {
      gsUtils.log(tabId, 'response from tab', response);
      if (chrome.runtime.lastError) {
        if (callback) callback(chrome.runtime.lastError);
      }
      else {
        if (callback) callback(null, response);
      }
    };

    message.tabId = tabId;
    try {
      gsUtils.log(tabId, 'send message to tab', message);
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, responseHandler);
    }
    catch (e) {
      gsUtils.warning(tabId, e);
      chrome.tabs.sendMessage(tabId, message, responseHandler);
    }
  },

  executeScriptOnTab: function(tabId, scriptPath, callback) {
    gsUtils.log(tabId, 'gsMessages', 'executeScriptOnTab', scriptPath);
    if (!tabId) {
      if (callback) callback('tabId not specified');
      return;
    }
    chrome.scripting.executeScript({ target : {tabId}, files: [scriptPath] }, (response) => {
      // gsUtils.log(tabId, 'executeScript response from script', response);
      if (chrome.runtime.lastError) {
        if (callback) callback(chrome.runtime.lastError);
      }
      else {
        if (callback) callback(null, response);
      }
    });
  },

  executeCodeOnTab: function(tabId, args, func, callback) {
    gsUtils.log(tabId, 'gsMessages', 'executeCodeOnTab', func);
    if (!tabId) {
      if (callback) callback('tabId not specified');
      return;
    }
    chrome.scripting.executeScript({ target : {tabId}, func, args }, (result) => {
      // gsUtils.log(tabId, 'executeScript response from code', response);
      if (chrome.runtime.lastError) {
        if (callback) callback(chrome.runtime.lastError);
      }
      else {
        if (callback) callback(null, result[0].result);
      }
    });
  },
};
