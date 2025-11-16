import  { gsChrome }              from './gsChrome.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';
import  { historyItems }          from './historyItems.js';
import  { historyUtils }          from './historyUtils.js';

(() => {
  'use strict';

  const knownExtensions = {
    'klbibkeccnjlkjkiokjodocebajanakg'  : 'The Great Suspender',
    'ahkbmjhfoplmfkpncgoedjgkajkehcgo'  : 'The Great Suspender (notrack)',
    'plpkmjcnhhnpkblimgenmdhghfgghdpp'  : 'The Great-<span class="italic">er</span> Tab Discarder',
  };
  knownExtensions[chrome.runtime.id]    = 'The Marvellous Suspender ( this extension! )';

  async function reloadTabs(sessionId, windowId, openTabsAsSuspended) {
    const session = await gsIndexedDb.fetchSessionBySessionId(sessionId);
    if (!session || !session.windows) {
      return;
    }

    gsUtils.removeInternalUrlsFromSession(session);

    //if loading a specific window
    let sessionWindows = [];
    if (windowId) {
      sessionWindows.push(gsUtils.getWindowFromSession(windowId, session));
      //else load all windows from session
    } else {
      sessionWindows = session.windows;
    }

    for (let sessionWindow of sessionWindows) {
      const suspendMode = openTabsAsSuspended ? 1 : 2;
      await gsSession.restoreSessionWindow(sessionWindow, null, session.tabGroups, suspendMode);
    }
  }

  function deleteSession(sessionId) {
    var result = window.confirm(
      chrome.i18n.getMessage('js_history_confirm_delete'),
    );
    if (result) {
      gsIndexedDb.removeSessionFromHistory(sessionId).then(function() {
        window.location.reload();
      });
    }
  }

  function removeTab(element, sessionId, windowId, tabId) {
    var sessionEl, newSessionEl;

    gsIndexedDb
      .removeTabFromSessionHistory(sessionId, windowId, tabId)
      .then(async (session) => {
        gsUtils.removeInternalUrlsFromSession(session);
        //if we have a valid session returned
        if (session) {
          sessionEl = element.parentElement.parentElement;
          newSessionEl = await createSessionElement(session);
          sessionEl.parentElement.replaceChild(newSessionEl, sessionEl);
          toggleSession(newSessionEl, session.sessionId); //async. unhandled promise

          //otherwise assume it was the last tab in session and session has been removed
        } else {
          window.location.reload();
        }
      });
  }

  async function toggleSession(element, sessionId) {
    var sessionContentsEl = element.getElementsByClassName(
      'sessionContents',
    )[0];
    var sessionIcon = element.getElementsByClassName('sessionIcon')[0];
    if (sessionIcon.classList.contains('icon-plus-squared-alt')) {
      sessionIcon.classList.remove('icon-plus-squared-alt');
      sessionIcon.classList.add('icon-minus-squared-alt');
    } else {
      sessionIcon.classList.remove('icon-minus-squared-alt');
      sessionIcon.classList.add('icon-plus-squared-alt');
    }

    //if toggled on already, then toggle off
    if (sessionContentsEl.childElementCount > 0) {
      sessionContentsEl.innerHTML = '';
      return;
    }

    gsIndexedDb
      .fetchSessionBySessionId(sessionId)
      .then(async function(curSession) {
        if (!curSession || !curSession.windows) {
          return;
        }
        gsUtils.removeInternalUrlsFromSession(curSession);

        const tabGroupsMap = await gsChrome.tabGroupsMap(curSession.tabGroups);

        for (const [i, curWindow] of curSession.windows.entries()) {
          curWindow.sessionId = curSession.sessionId;
          sessionContentsEl.appendChild(
            await createWindowElement(curSession, curWindow, i),
          );

          const tabPromises     = [];
          for (const curTab of curWindow.tabs) {
            curTab.windowId     = curWindow.id;
            curTab.sessionId    = curSession.sessionId;
            curTab.title        = gsUtils.getCleanTabTitle(curTab);
            curTab.group        = tabGroupsMap[curTab.groupId] || {};
            curTab.isSuspended  = gsUtils.isSuspendedTab(curTab);

            if (curTab.isSuspended) {
              curTab.url = gsUtils.getOriginalUrl(curTab.url);
            }
            tabPromises.push(createTabElement(curSession, curWindow, curTab));
          }
          const tabEls = await Promise.all(tabPromises);
          for (const tabEl of tabEls) {
            sessionContentsEl.appendChild(tabEl);
          }
        }
      });
  }

  function addClickListenerToElement(element, func) {
    if (element) {
      element.onclick = () => {
        func();
        return false;
      };
    }
  }

  async function createSessionElement(session) {
    var sessionEl = await historyItems.createSessionHtml(session, true);

    addClickListenerToElement(
      sessionEl.getElementsByClassName('sessionIcon')[0],
      function() {
        toggleSession(sessionEl, session.sessionId); //async. unhandled promise
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('sessionLink')[0],
      function() {
        toggleSession(sessionEl, session.sessionId); //async. unhandled promise
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('exportLink')[0],
      function() {
        historyUtils.exportSessionWithId(null, session.sessionId);
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('resuspendLink')[0],
      function() {
        reloadTabs(session.sessionId, null, true); // async
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('reloadLink')[0],
      function() {
        reloadTabs(session.sessionId, null, false); // async
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('saveLink')[0],
      function() {
        historyUtils.saveSession(session.sessionId, null);
      },
    );
    addClickListenerToElement(
      sessionEl.getElementsByClassName('deleteLink')[0],
      function() {
        deleteSession(session.sessionId);
      },
    );
    return sessionEl;
  }

  async function createWindowElement(session, window, index) {
    var allowReload = session.sessionId !== (await gsSession.getSessionId());
    var windowEl = historyItems.createWindowHtml(index, allowReload);

    addClickListenerToElement(
      windowEl.getElementsByClassName('resuspendLink')[0],
      function() {
        reloadTabs(session.sessionId, window.id, true); // async
      },
    );
    addClickListenerToElement(
      windowEl.getElementsByClassName('reloadLink')[0],
      function() {
        reloadTabs(session.sessionId, window.id, false); // async
      },
    );
    addClickListenerToElement(
      windowEl.getElementsByClassName('exportLink' + index)[0],
      function() {
        historyUtils.exportSessionWithId(window.id, session.sessionId);
      },
    );
    addClickListenerToElement(
      windowEl.getElementsByClassName('saveLink' + index)[0],
      function() {
        historyUtils.saveSession(session.sessionId, window.id);
      },
    );
    return windowEl;
  }

  async function createTabElement(session, window, tab) {
    var allowDelete = session.sessionId !== (await gsSession.getSessionId());
    var tabEl = await historyItems.createTabHtml(tab, allowDelete);

    addClickListenerToElement(
      tabEl.getElementsByClassName('removeLink')[0],
      function() {
        removeTab(tabEl, session.sessionId, window.id, tab.id);
      },
    );
    return tabEl;
  }

  async function render() {

    await gsSession.updateCurrentSession();

    let currentDiv = document.getElementById('currentSessions'),
      sessionsDiv = document.getElementById('recoverySessions'),
      historyDiv = document.getElementById('historySessions'),
      importSessionEl = document.getElementById('importSession'),
      importSessionActionEl = document.getElementById('importSessionAction'),
      firstSession = true;

    currentDiv.innerHTML = '';
    sessionsDiv.innerHTML = '';
    historyDiv.innerHTML = '';

    const currentSessions = await gsIndexedDb.fetchCurrentSessions();
    for (const session of currentSessions) {
      gsUtils.removeInternalUrlsFromSession(session);
      const sessionEl = await createSessionElement(session);
      if (firstSession) {
        currentDiv.appendChild(sessionEl);
        firstSession = false;
      } else {
        sessionsDiv.appendChild(sessionEl);
      }
    };

    const savedSessions = await gsIndexedDb.fetchSavedSessions();
    for (const session of savedSessions) {
      gsUtils.removeInternalUrlsFromSession(session);
      const sessionEl = await createSessionElement(session);
      historyDiv.appendChild(sessionEl);
    };

    importSessionActionEl.addEventListener( 'change', historyUtils.importSession, false );
    importSessionEl.onclick = function() {
      importSessionActionEl.click();
    };

    var migrateTabsEl = document.getElementById('migrateTabs');
    migrateTabsEl.onclick = function() {
      var migrateTabsFromIdEl = document.getElementById('migrateFromId');
      historyUtils.migrateTabs(migrateTabsFromIdEl.value);
    };

    //hide incompatible sidebar items if in incognito mode
    if (chrome.extension.inIncognitoContext) {
      Array.prototype.forEach.call(
        document.getElementsByClassName('noIncognito'),
        function(el) {
          el.style.display = 'none';
        },
      );
    }

    const tabs = await chrome.tabs.query({});
    const foundExts = {};
    for (const tab of tabs) {
      // console.log('tabs query', tab.url);
      const url = new URL(tab.url || '');
      if (url.protocol.match(/extension:$/i)
        && url.pathname.match(/\/(suspend(ed)?|park).html$/i)
        && url.host.toLowerCase() !== chrome.runtime.id
        ) {
        foundExts[url.host] ??= { name: knownExtensions[url.host] ?? url.host, count: 0 };
        foundExts[url.host].count += 1;
        // generateTabInfo(tab, url);
      }
    }
    const foundSorted       = Object.entries(foundExts).sort(([key1, val1], [key2, val2]) => val2 - val1);
    if (foundSorted.length) {
      const [key, val]      = foundSorted[0];
      const migrateIdEl     = document.getElementById('migrateFromId');
      const migrateNameEl   = document.getElementById('migrateFromName');
      const messageEl       = document.getElementById('migrateMessage');
      if (migrateIdEl && migrateNameEl && messageEl) {
        messageEl.innerHTML = '';
        if (key && val) {
          migrateIdEl.value   = key;
          migrateNameEl.innerHTML = `${val.name}: ${val.count} tabs`;
        }
      }
    }

  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {

    window.onfocus = () => {
      render();
    };

    render();

  });

})();
