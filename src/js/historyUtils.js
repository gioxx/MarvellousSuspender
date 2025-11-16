import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsUtils }               from './gsUtils.js';

export const historyUtils = (() => {
  'use strict';

  var noop = function() {
  };

  function importSession(e) {
    var f = e.target.files[0];
    if (f) {
      var r = new FileReader();
      r.onload = function(e) {
        var contents = e.target.result;
        if (f.type !== 'text/plain' && f.type !== 'application/json') {
          alert(chrome.i18n.getMessage('js_history_import_fail'));
        } else {
          handleImport(f.name, contents).then(function() {
            window.location.reload();
          });
        }
      };
      r.readAsText(f);
    } else {
      alert(chrome.i18n.getMessage('js_history_import_fail'));
    }
  }

  /**
   * @param { string }    textContents
   * @param { number }    sessionId
   */
  async function importPlainText(textContents, sessionId) {

    var windows = [];
    var createNextWindow = function() {
      return {
        id: sessionId + '_' + windows.length,
        tabs: [],
      };
    };
    var curWindow = createNextWindow();

    for (const line of textContents.split('\n')) {
      if (typeof line !== 'string') {
        continue;
      }
      if (line === '') {
        if (curWindow.tabs.length > 0) {
          windows.push(curWindow);
          curWindow = createNextWindow();
        }
        continue;
      }
      if (line.indexOf('://') < 0) {
        continue;
      }
      const tabInfo = {
        windowId: curWindow.id,
        sessionId: sessionId,
        id: curWindow.id + '_' + curWindow.tabs.length,
        url: line,
        title: line,
        index: curWindow.tabs.length,
        pinned: false,
      };
      const savedTabInfo = await gsIndexedDb.fetchTabInfo(line);
      if (savedTabInfo) {
        tabInfo.title = savedTabInfo.title;
        tabInfo.favIconUrl = savedTabInfo.favIconUrl;
      }
      curWindow.tabs.push(tabInfo);
    }
    if (curWindow.tabs.length > 0) {
      windows.push(curWindow);
    }

    gsUtils.log('historyUtils', 'importPlainText return', windows);
    return windows;
  }

  /**
   * @param { object }  importObj
   * @param { number }  sessionId
   */
  async function importObject(importObj, sessionId) {
    gsUtils.log('historyUtils', 'importObject', importObj);

    const windows = [];

    for (const window of importObj.windows) {
      const curWindow = {
        id: sessionId + '_' + windows.length,
        tabs: [],
      };
      for (const tab of window.tabs) {
        const tabInfo = {
          windowId    : curWindow.id,
          sessionId   : sessionId,
          id          : curWindow.id + '_' + curWindow.tabs.length,
          url         : tab.url,
          title       : tab.url,
          index       : curWindow.tabs.length,
          pinned      : false,
          groupId     : tab.groupId
        };
        const savedTabInfo    = await gsIndexedDb.fetchTabInfo(tab.url);
        if (savedTabInfo) {
          tabInfo.title       = savedTabInfo.title;
          tabInfo.favIconUrl  = savedTabInfo.favIconUrl;
        }
        curWindow.tabs.push(tabInfo);
      }
      windows.push(curWindow);
    }

    gsUtils.log('historyUtils', 'importObject return', windows);
    return windows;
  }

  async function handleImport(sessionName, textContents) {
    sessionName = window.prompt(
      chrome.i18n.getMessage('js_history_enter_name_for_session'),
      sessionName,
    );
    if (sessionName) {
      const shouldSave = await new Promise((resolve) => {
        validateNewSessionName(sessionName, (result) => {
          resolve(result);
        });
      });
      if (!shouldSave) {
        return;
      }

      const sessionId = '_' + gsUtils.generateHashCode(sessionName);

      let importObj = {};
      try {
        importObj = JSON.parse(textContents);
      } catch (error) {
        gsUtils.log( 'historyUtils', 'handleImport', 'JSON parse failed, so fallback to old file format' );
      }

      let windows   = [];
      let tabGroups = [];
      if (importObj.windows && importObj.windows.length) {
        windows     = await importObject(importObj, sessionId);
        tabGroups   = importObj.tabGroups;
      }
      else {
        windows     = await importPlainText(textContents, sessionId);
      }

      var session = {
        name: sessionName,
        sessionId,
        windows,
        tabGroups,
        date: new Date().toISOString(),
      };
      gsUtils.log('historyUtils', 'handleImport session', session);
      await gsIndexedDb.updateSession(session);
    }
  }

  function exportSessionWithId(windowId, sessionId, callback) {
    callback = typeof callback !== 'function' ? noop : callback;

    // document.getElementById('debugWindowId').innerText = document.getElementById('debugWindowId').innerText + ' - Window ID retrieved: ' + windowId;
    gsIndexedDb.fetchSessionBySessionId(sessionId).then(function(session) {
      if (!session || !session.windows) {
        callback();
      } else {
        exportSession(session, callback, windowId);
      }
    });
  }

  function exportSession(session, callback, windowId) {

    const windows = [];

    function _exInternalExport(curWindow) {
      const window = {
        windowId  : curWindow.id,
        tabs      : [],
      };
      for (const curTab of curWindow.tabs) {
        const url = gsUtils.isSuspendedTab(curTab) ? gsUtils.getOriginalUrl(curTab.url) : curTab.url;
        window.tabs.push({ url, groupId: curTab.groupId });
      };
      windows.push(window);
    }

    for (const curWindow of session.windows) {
      if (windowId) {
        if (curWindow.id == windowId) {
          _exInternalExport(curWindow);
        }
      }
      else {
        _exInternalExport(curWindow);
      }
    };

    const exportObj = {
      windows,
      tabGroups: session.tabGroups,
    };

    const sessionString = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([sessionString], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', blobUrl);
    link.setAttribute('download', `tms-session-${(new Date()).toISOString().substring(0,10)}.json`);
    link.click();

    callback();
  }

  function validateNewSessionName(sessionName, callback) {
    gsIndexedDb.fetchSavedSessions().then(function(savedSessions) {
      var nameExists = savedSessions.some(function(savedSession, index) {
        return savedSession.name === sessionName;
      });
      if (nameExists) {
        var overwrite = window.confirm(
          chrome.i18n.getMessage('js_history_confirm_session_overwrite'),
        );
        if (!overwrite) {
          callback(false);
          return;
        }
      }
      callback(true);
    });
  }

  function saveSession(sessionId, windowId) {
    // document.getElementById('debugWindowId').innerText = document.getElementById('debugWindowId').innerText + ' - Window ID retrieved: ' + windowId;
    gsIndexedDb.fetchSessionBySessionId(sessionId).then(function(session) {
      if (!session) {
        gsUtils.warning( 'historyUtils', 'Could not find session with sessionId: ' + sessionId + '. Save aborted' );
        return;
      }
      var sessionName = window.prompt(
        chrome.i18n.getMessage('js_history_enter_name_for_session'),
      );
      if (sessionName) {
        historyUtils.validateNewSessionName(sessionName, function(shouldSave) {
          if (shouldSave) {
            session.name = sessionName;
            // document.getElementById('debugWindowId').innerText = document.getElementById('debugWindowId').innerText + ' - SessionData: ' + JSON.stringify(session);
            let newSession = JSON.parse(JSON.stringify(session));
            newSession.windows = (windowId !== null) ? session.windows.filter((curWindow) => (curWindow.id === windowId)) : session.windows;
            // document.getElementById('debugWindowId').innerText = JSON.stringify(newSession);

            gsIndexedDb.addToSavedSessions(newSession).then(function() {
              window.location.reload();
            });
          }
        });
      }
    });
  }

  function migrateTabs(from_id) {
    const messageEl       = document.getElementById('migrateMessage');
    if (messageEl) {
      messageEl.innerHTML = '';
    }
    if (from_id.length == 32) {
      chrome.tabs.query({}, function(tabs) {
        let count = 0;
        const to_id = chrome.runtime.id;
        for (const tab of tabs) {
          const url       = new URL(tab.url);
          if (url.host === from_id && url.pathname.match(/\/(suspend(ed)?|park).html$/i)) {
            count += 1;
            url.host      = to_id;
            url.pathname  = 'suspended.html';
            chrome.tabs.update(tab.id, { url: url.href });
          }
        }
        if (messageEl && count) {
          messageEl.innerHTML = chrome.i18n.getMessage('js_history_migrate_success', '' + count);
        }
      });
    }
    else {
      if (messageEl) {
        messageEl.innerHTML = chrome.i18n.getMessage('js_history_migrate_fail');
      }
    }
  }

  return {
    importSession,
    exportSession,
    exportSessionWithId,
    validateNewSessionName,
    saveSession,
    migrateTabs,
  };
})();
