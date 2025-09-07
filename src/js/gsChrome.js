import  { gsUtils }               from './gsUtils.js';

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
          tab = null;
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
          tab = null;
        }
        resolve(tab);
      });
    });
  },
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
          tab = null;
        }
        resolve(tab);
      });
    });
  },
  tabsQuery: function(queryInfo) {
    queryInfo = queryInfo || {};
    return new Promise(resolve => {
      chrome.tabs.query(queryInfo, tabs => {
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
        resolve();
      });
    });
  },
  windowsGetLastFocused: function() {
    return new Promise(resolve => {
      chrome.windows.getLastFocused({}, window => {
        if (chrome.runtime.lastError) {
          gsUtils.warning('chromeWindows', chrome.runtime.lastError);
          window = null;
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
          window = null;
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
   * @param   { chrome.tabGroups.TabGroup[] } groups
   * @returns { Promise<Record<number, chrome.tabGroups.TabGroup>> }
   */
  tabGroupsMap: async (groups = []) => {
    if (!groups.length) {
      groups        = await gsChrome.tabGroupsGetAll();
    }
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
   * @param   { number[] }            tabIds
   * @param   { number }              windowId
   * @param   { number | undefined }  groupId
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
          window = null;
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
          window = null;
        }
        resolve(window);
      });
    });
  },
};
