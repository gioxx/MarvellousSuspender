// @ts-check
import  { gsUtils }               from './gsUtils.js';


// URL verified 2026-04: Chrome, Edge, Brave, Vivaldi, Opera
const EXTENSION_URL_MATCH = `^(chrome-)?extension://${chrome.runtime.id}/`;


export const gsChrome = {

  /**
   * @param   { string | chrome.tabs.CreateProperties } details
   * @returns { Promise<chrome.tabs.Tab | null> }
   */
  tabsCreate: function(details) {
    return new Promise(resolve => {
      if (
        !details ||
        (typeof details !== 'string' && typeof details.url !== 'string')
      ) {
        gsUtils.warning('chromeTabs', 'url not specified');
        resolve(null);
        return;
      }
      details = typeof details === 'string' ? { url: details } : details;
      chrome.tabs.create(details, tab => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(tab);
      });
    });
  },
  tabsReload: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(false);
        return;
      }
      chrome.tabs.reload(tabId, () => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  },
  tabsUpdate: function(tabId, updateProperties) {
    return new Promise(resolve => {
      if (!tabId || !updateProperties) {
        gsUtils.warning( 'chromeTabs', 'tabId or updateProperties not specified' );
        resolve(null);
        return;
      }
      chrome.tabs.update(tabId, updateProperties, tab => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(tab);
      });
    });
  },

  /**
   * @param   { number | undefined }  tabId
   * @returns { Promise<chrome.tabs.Tab | null> }
   */
  tabsGet: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(null);
        return;
      }
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(tab);
      });
    });
  },
  /**
   * @param {chrome.tabs.QueryInfo} [queryInfo]
   * @returns {Promise<chrome.tabs.Tab[]>}
   */
  tabsQuery: async (queryInfo) => {
    queryInfo = queryInfo || {};
    return new Promise((resolve) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
          tabs = [];
        }
        resolve(tabs);
      });
    });
  },
  tabsRemove: function(tabId) {
    return new Promise(resolve => {
      if (!tabId) {
        gsUtils.warning('chromeTabs', 'tabId not specified');
        resolve(null);
        return;
      }
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeTabs', chrome.runtime.lastError);
        }
        resolve(null);
      });
    });
  },
  windowsGetLastFocused: function() {
    return new Promise(resolve => {
      chrome.windows.getLastFocused({}, window => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeWindows', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(window);
      });
    });
  },
  windowsGet: function(windowId) {
    return new Promise(resolve => {
      if (!windowId) {
        gsUtils.warning('chromeWindows', 'windowId not specified');
        resolve(null);
        return;
      }
      chrome.windows.get(windowId, { populate: true }, window => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeWindows', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(window);
      });
    });
  },
  windowsGetAll: function() {
    return new Promise(resolve => {
      chrome.windows.getAll({ populate: true }, (windows) => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('windowsGetAll', chrome.runtime.lastError);
          windows = [];
        }
        resolve(windows);
      });
    });
  },

  /**
   * @returns { Promise<chrome.tabGroups.TabGroup[]> }
   */
  tabGroupsGetAll: function() {
    return new Promise(resolve => {
      chrome.tabGroups.query({}, (groups) => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('tabGroupsGetAll', chrome.runtime.lastError);
          groups = [];
        }
        resolve(groups);
      });
    });
  },

  /**
   * @typedef { Record<number, chrome.tabGroups.TabGroup> } GroupMap
   * @param   { chrome.tabGroups.TabGroup[] } groups
   * @returns { Promise<GroupMap> }
   */
  tabGroupsMap: async (groups = []) => {
    if (!groups.length) {
      groups        = await gsChrome.tabGroupsGetAll();
    }
    /** @type GroupMap */
    const groupMap  = {};
    for (const group of groups) {
      groupMap[group.id] = group;
    }
    return groupMap;
  },
  /**
   * @param   { number }                              groupId
   * @param   { chrome.tabGroups.UpdateProperties }   updateProperties
   */
  tabGroupsUpdate: (groupId, updateProperties) => {
    return chrome.tabGroups.update(groupId, updateProperties);
  },

  /**
   * @param   { number | [number, ...number[]] }  tabIds
   * @param   { number }                          windowId
   * @param   { number | undefined }              [groupId]
   * @returns { Promise<number> }
   */
  tabsGroup: (tabIds, windowId, groupId) => {
    return new Promise(async (resolve) => {
      if (groupId === -1) {
        gsUtils.warning('tabsGroup', `Skipping groupId ${groupId}`);
        resolve(groupId);
      }
      gsUtils.log('tabsGroup', tabIds, windowId, groupId);
      if (groupId) {
        resolve(chrome.tabs.group({ tabIds, groupId }));
      }
      else {
        resolve(chrome.tabs.group({ tabIds, createProperties: { windowId } }));
      }
    });
  },

  windowsCreate: function(createData) {
    createData = createData || {};
    return new Promise(resolve => {
      chrome.windows.create(createData, window => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeWindows', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(window);
      });
    });
  },
  windowsUpdate: function(windowId, updateInfo) {
    return new Promise(resolve => {
      if (!windowId || !updateInfo) {
        gsUtils.warning('chromeTabs', 'windowId or updateInfo not specified');
        resolve(null);
        return;
      }
      chrome.windows.update(windowId, updateInfo, window => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeWindows', chrome.runtime.lastError);
          resolve(null);
        }
        resolve(window);
      });
    });
  },


  /**
   * @typedef { { tabId: number | undefined } } ContextLike
   * @param   { number | undefined }  tabId
   * @returns { Promise<ContextLike | undefined> }
   */
  contextGetByTabId: async (tabId) => {
    if (!tabId) return;
    // NOTE: getContexts probably isn't really needed, since the workaround should be quick enough
    const contexts  = await chrome.runtime.getContexts({ tabIds: [tabId] });
    gsUtils.log('contextGetByTabId', contexts[0]?.tabId, tabId);
    if (contexts.length === 1) {
      return contexts[0];
    }

    // Workaround for Vivaldi bug.  chrome.runtime.getContexts is returning an empty list.
    // Vivaldi bug reported: VB-122957
    // https://forum.vivaldi.net/search?in=titlesposts&term=122957&matchWords=any
    const tab     = await chrome.tabs.get(tabId);
    gsUtils.log('contextGetByTabId fallback', tabId, tab.id);
    if (tab.url?.match(new RegExp(EXTENSION_URL_MATCH, 'i'))) {
      return { tabId };
    }

  },

  /**
   * @param   { string }  viewName
   * @returns { Promise<ContextLike[]> }
   */
  contextsGetByViewName: async (viewName) => {
    // NOTE: getContexts might be significantly faster than the workaround for users with lots of tabs.  We'll have to test before removing entirely.
    const contexts    = await chrome.runtime.getContexts({});
    const filtered    = contexts.filter((context) => context.documentUrl?.includes(viewName));
    gsUtils.log('contextsGetByViewName', filtered);
    if (filtered.length) {
      return filtered;
    }

    // Workaround for Vivaldi bug.  chrome.runtime.getContexts is returning an empty list.
    // Vivaldi bug reported: VB-122957
    // https://forum.vivaldi.net/search?in=titlesposts&term=122957&matchWords=any
    if (contexts.length === 1) {
      const tabs      = await chrome.tabs.query({});
      const filtered  = tabs.filter((tab) => tab.url?.match(new RegExp(`${EXTENSION_URL_MATCH}/${viewName}`, 'i')));
      const mapped    = filtered.map((tab) => ({ tabId: tab.id }));
      gsUtils.log('contextsGetByViewName fallback', mapped);
      return mapped;
    }
    return [];
  },

};
