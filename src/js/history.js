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
      gsUtils.getMessage('js_history_confirm_delete'),
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

  // baselineSession = the previous browser session's final "current session" snapshot
  // (currentSessions[1] in render() below); currentSession = the live one (currentSessions[0]).
  // Comparison is by URL presence (Set), not by count or tabId — tab ids never survive a
  // restart, and a URL open twice in the baseline that's down to one copy now isn't "missing".
  function computeMissingTabs(baselineSession, currentSession) {
    if (!baselineSession || !currentSession) {
      return [];
    }
    gsUtils.removeInternalUrlsFromSession(baselineSession);
    gsUtils.removeInternalUrlsFromSession(currentSession);

    const flattenTabs = (session) => {
      const tabs = [];
      for (const win of session.windows || []) {
        for (const tab of win.tabs || []) {
          const url = gsUtils.isSuspendedTab(tab) ? gsUtils.getOriginalUrl(tab.url) : tab.url;
          tabs.push({ url, title: gsUtils.getCleanTabTitle(tab) });
        }
      }
      return tabs;
    };

    const baselineTabs = flattenTabs(baselineSession);
    const currentUrls  = new Set(flattenTabs(currentSession).map((tab) => tab.url));

    const seen    = new Set();
    const missing = [];
    for (const tab of baselineTabs) {
      if (!currentUrls.has(tab.url) && !seen.has(tab.url)) {
        seen.add(tab.url);
        missing.push(tab);
      }
    }
    return missing;
  }

  function createMissingTabRow(tab) {
    const row = document.createElement('div');
    row.className = 'missingTabsRow';

    const text = document.createElement('span');
    text.className = 'missingTabsRowText';
    text.title = tab.url;
    text.textContent = tab.title && tab.title.length > 1 ? tab.title : tab.url;

    const reopen = document.createElement('a');
    reopen.href = '#';
    reopen.className = 'groupLink missingTabsReopen';
    reopen.textContent = gsUtils.getMessage('js_history_reopen');
    reopen.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: tab.url, active: false }).catch((err) => {
        gsUtils.error('history', 'Failed to reopen tab', tab.url, err);
      });
    };

    row.appendChild(text);
    row.appendChild(reopen);
    return row;
  }

  // Icon swap mirrors the existing sessionIcon convention in toggleSession() above,
  // for visual consistency with the session expand/collapse control already on this page.
  function setMissingTabsIcon(iconName) {
    const icon = document.querySelector('#missingTabsBadge .missingTabsIcon');
    icon.setAttribute('data-icon', iconName);
    icon.querySelector('use').setAttribute('href', `img/icons.svg#${iconName}`);
  }

  function renderMissingTabsPanel(missingTabs) {
    const badge     = document.getElementById('missingTabsBadge');
    const badgeText = document.getElementById('missingTabsBadgeText');
    const panel     = document.getElementById('missingTabsPanel');

    panel.innerHTML = '';

    if (!missingTabs.length) {
      badge.classList.add('reallyHidden');
      panel.classList.add('reallyHidden');
      return;
    }

    badgeText.textContent = gsUtils.getMessage('js_history_missing_tabs_badge', [String(missingTabs.length)]);
    badge.classList.remove('reallyHidden');
    badge.setAttribute('aria-expanded', 'false');
    setMissingTabsIcon('square-plus');
    panel.classList.add('reallyHidden');

    const hint = document.createElement('p');
    hint.className = 'missingTabsHint lesserText';
    hint.textContent = gsUtils.getMessage('js_history_missing_tabs_hint');
    panel.appendChild(hint);

    for (const tab of missingTabs) {
      panel.appendChild(createMissingTabRow(tab));
    }

    badge.onclick = () => {
      const expanded = badge.getAttribute('aria-expanded') === 'true';
      badge.setAttribute('aria-expanded', String(!expanded));
      setMissingTabsIcon(expanded ? 'square-plus' : 'square-minus');
      panel.classList.toggle('reallyHidden', expanded);
    };
  }

  async function toggleSession(element, sessionId) {
    var sessionContentsEl = element.getElementsByClassName(
      'sessionContents',
    )[0];
    var sessionIcon = element.getElementsByClassName('sessionIcon')[0];
    const isExpanded = sessionIcon.getAttribute('data-icon') === 'square-minus';
    const nextIcon = isExpanded ? 'square-plus' : 'square-minus';
    sessionIcon.setAttribute('data-icon', nextIcon);
    sessionIcon.querySelector('use').setAttribute('href', `img/icons.svg#${nextIcon}`);

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

    // currentSessions[0] is the live session; currentSessions[1], if present, is the
    // previous browser session's final snapshot — the right "before this restart"
    // baseline, already tracked by the existing session history, no new storage needed.
    const missingTabs = currentSessions.length > 1
      ? computeMissingTabs(currentSessions[1], currentSessions[0])
      : [];
    renderMissingTabsPanel(missingTabs);

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

  });

})();
