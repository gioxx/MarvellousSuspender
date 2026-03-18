// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsSession }             from './gsSession.js';

(() => {

  const PACING  = 100;

  /**
   * @param   { string }      id
   * @returns { HTMLElement }
   * Just return a safe HTML Element, and create a dummy element if there's no match
   */
  function quickElemById(id) {
    return document.getElementById(id) ?? document.createElement('div');
  }

  /**
   * @param {string} name
   */
  function logClear(name) {
    quickElemById(name).innerHTML = '';
  }

  /**
   * @param {string} name
   * @param {string|number} num
   * @param {string} txt
   * @param {string} [status]
   */
  function log(name, num, txt, status = '') {
    quickElemById(name).innerHTML += `<div class="center">${num}</div><div>${txt}</div><div>${status}</div><div></div>`;
  }

  /**
   * @param {string} name
   * @param {string} txt
   */
  function warn(name, txt) {
    // log(name, '&#9888;', txt, status);
    quickElemById(name).innerHTML += `<div class="center">&#9888;</div><div class="span-3">${txt}</div>`;
  }

  function reset() {
    logClear('log');
    logClear('scanResults');
    logClear('actionResults');
    quickElemById('scanSection').style.display = 'block';
    quickElemById('actionSection').style.display = 'none';
    quickElemById('actionProgress').style.display = 'none';
    quickElemById('copySection').style.display = 'none';
  }

  /**
   * @param {string} id
   * @param {number} current
   * @param {number} total
   * The percent "done" should be between 0 and 1
   */
  function showProgress(id, current, total) {
    const bar = document.querySelector(`#${id}.progress .inner`);
    if (bar && bar instanceof HTMLElement) {
      bar.style.width     = `${100 * current / total}%`;
      bar.innerHTML       = `${current} tabs`;
    }
  }


  /**
   * @callback ActionCallback
   * @param {chrome.tabs.Tab} tab
   * @returns {Promise<void>}
   */

  /**
   * @param { string }  id
   * @param { boolean } [fClear]
   */
  function addProgressBar(id, fClear = false) {
    const actionProgress = document.getElementById('actionProgress');
    if (actionProgress) {
      if(fClear) actionProgress.innerHTML = `<div>${chrome.i18n.getMessage('html_health_action_label')}</div>`;
      const progress = document.createElement('div');
      progress.innerHTML  = '<div class="inner"></div>';
      progress.className  = 'option progress';
      progress.id         = id;
      actionProgress.appendChild(progress);
      actionProgress.style.display = 'block';
    }
  }

  /**
   * @param { string } id
   * @param { chrome.tabs.Tab[] } tabs
   * @param { ActionCallback } fnAction
   */
  async function performAction(id, tabs, fnAction) {
    let   count     = 0;
    for (const tab of tabs) {
      count        += 1;
      gsUtils.log(tab.id, '-----');
      gsUtils.log(tab.id, 'URL', tab.url);

      await fnAction(tab);

      showProgress(id, count, tabs.length);
      // if (Math.random() < 0.2) {
      //   await new Promise((resolve) => setTimeout(resolve, PACING));   // Dramatic effect! :)
      // }
    }
  }

  /**
   * @param { chrome.tabs.Tab[] } tabsHosts
   * @param { chrome.tabs.Tab[] } tabsSuspended
   */
  async function restoreTabs(tabsHosts, tabsSuspended) {
    gsUtils.log('', 'restoreTabs');

    addProgressBar('restore1', true);
    addProgressBar('restore2');
    addProgressBar('restore3');
    logClear('actionResults');

    const reloadQueue   = [];
    await performAction('restore1', tabsHosts, async (tab) => {
      await tgs.unsuspendTab(tab);

      // Ugh - Chrome is caching the old/blank favicon here, so we'll need try try a bit harder...
      // unsuspendTab simply replaces the tab.url with the main site -- this appears to be a cached load
      // Triggering a tab reload appears to pull in the favicon...
      // This 1 second delay could probably be replaced by a tab state listener, but for now keeping it simple
      reloadQueue.push(new Promise((resolve) => setTimeout(async () => {
        if (tab.id) await chrome.tabs.reload(tab.id);
        resolve(0);
      }, 2000)));
    });
    await Promise.all(reloadQueue);

    const suspendQueue  = [];
    await performAction('restore2', tabsHosts, async (tab) => {
      suspendQueue.push(new Promise((resolve) => setTimeout(async () => {
        await gsTabSuspendManager.queueTabForSuspensionAsPromise(tab, 1);
        resolve(0);
      }, 3000)));
    });
    await Promise.all(suspendQueue);


    await performAction('restore3', tabsSuspended, async (tab) => {
      await gsUtils.resuspendSuspendedTab(tab);
      await new Promise((resolve) => setTimeout(resolve, 10));  // Give the browser some time to process the tabs
    });

    log('actionResults', '', chrome.i18n.getMessage('html_health_after_restore'));

  }

  /**
   * @param { chrome.tabs.Tab[] } tabs
   */
  async function reloadTabs(tabs) {
    logClear('actionResults');
    addProgressBar('reload1', true);
    await performAction('reload1', tabs, async (tab) => {
      await gsUtils.resuspendSuspendedTab(tab);
    });
    log('actionResults', '', chrome.i18n.getMessage('html_health_after_reload'));
  }


  /**
   * @param { chrome.tabs.Tab } tab
   * @param { Record<string, chrome.tabs.Tab[]> } tabTypes
   * @param { Set<string> } tabHosts
   */
  async function scanTab(tab, tabTypes, tabHosts) {
    if (tab.url) {

      if (gsUtils.isSuspendedTab(tab)) {
        gsUtils.log(tab.id, '-----');
        gsUtils.log(tab.id, 'URL', tab.url);
        gsUtils.log(tab.id, 'FAV', tab.favIconUrl);
        // gsUtils.log(tab.id, 'TAB', tab);

        tabTypes.tabSuspended.push(tab);
        // gsUtils.log(tab.id, 'Suspended');

        if (tab.favIconUrl) {
          const faviconMeta = await gsFavicon.buildFaviconMeta(tab.favIconUrl);
          const isExtension = (tab.favIconUrl === chrome.runtime.getURL('img/ic_suspendy_16x16.png'));
          const isValid     = await gsFavicon.isFaviconMetaValid(faviconMeta);

          if (isExtension) {
            gsUtils.log(tab.id, 'Extension FavIcon');
            tabTypes.favExtension.push(tab);
          }
          else if (!isValid) {
            gsUtils.log(tab.id, 'Chrome Default FavIcon');
            tabTypes.favDefault.push(tab);

            const originalUrl = gsUtils.getNewURL(gsUtils.getOriginalUrl(tab.url));
            if (originalUrl?.hostname && !tabHosts.has(originalUrl.hostname)) {
              tabHosts.add(originalUrl.hostname);
              tabTypes.favHosts.push(tab);
            }
          }
        }
        else {
          gsUtils.log(tab.id, 'No FavIcon');
          tabTypes.favEmpty.push(tab);
        }

      }

      else if (gsUtils.isSpecialTab(tab)) {
        // Do nothing for special tabs, which include all extension tabs including our own
        tabTypes.tabSpecial.push(tab);
      }
      else if (gsUtils.isNormalTab(tab)) {
        // Do nothing for regular tabs
        tabTypes.tabNormal.push(tab);
      }

      if (tab.discarded) {
        gsUtils.log(tab.id, 'Discarded');
        tabTypes.tabDiscarded.push(tab);
      }
      if (tab.frozen) {
        gsUtils.log(tab.id, 'Frozen');
        tabTypes.tabFrozen.push(tab);
      }

      // if (Math.random() < 0.2) {
      //   await new Promise((resolve) => setTimeout(resolve, PACING));   // Dramatic effect! :)
      // }

    }
  }

  async function scan() {

    const logName   = 'scanResults';
    const tabHosts  = new Set();
    const tabTypes  = {
      favExtension  : [],
      favEmpty      : [],
      favDefault    : [],
      favHosts      : [],
      '---'         : [],
      tabSuspended  : [],
      '----'        : [],
      tabDiscarded  : [],
      tabFrozen     : [],
      tabNormal     : [],
      tabSpecial    : [],
    };

    reset();

    const tabs    = await gsChrome.tabsQuery();
    // log(tabs.length, 'tabs');

    let   count     = 0;
    for (const tab of tabs) {
      count  += 1;
      await scanTab(tab, tabTypes, tabHosts);
      showProgress('scanProgress', count, tabs.length);
    }

    const db      = await gsIndexedDb.getDb();
    const dbSize  = await db.count(gsIndexedDb.DB_FAVICON_META);
    // const results = await db.query(gsIndexedDb.DB_FAVICON_META, 'url').all().execute();

    log(logName, tabTypes.tabSuspended.length,  chrome.i18n.getMessage('html_health_num_tms_tabs'));
    log(logName, dbSize,                        `&ensp;&raquo; ${chrome.i18n.getMessage('html_health_num_tms_cache')}`);
    log(logName, tabTypes.favEmpty.length,      `&ensp;&raquo; ${chrome.i18n.getMessage('html_health_num_tabs_empty')}`,      tabTypes.favEmpty.length ? '' : '✓');
    log(logName, tabTypes.favExtension.length,  `&ensp;&raquo; ${chrome.i18n.getMessage('html_health_num_tabs_extension')}`,  tabTypes.favExtension.length ? '' : '✓');
    log(logName, tabTypes.favDefault.length,    `&ensp;&raquo; ${chrome.i18n.getMessage('html_health_num_tabs_default')}`,    tabTypes.favDefault.length ? '' : '✓');
    if (tabTypes.favDefault.length) {
      log(logName, tabTypes.favHosts.length,    `&ensp;&raquo; ${chrome.i18n.getMessage('html_health_num_hostnames')}`);
    }
    // if (dbSize < tabTypes.favHosts.length) {
    //   warn(logName, `${chrome.i18n.getMessage('html_health_small_cache')}`);
    // }

    if (tabTypes.favEmpty.length) {
      quickElemById('actionSection').style.display = 'block';
      quickElemById('actionIntro').innerHTML = chrome.i18n.getMessage('html_health_reload_intro');
      const button  = quickElemById('actionButton');
      button.innerHTML = chrome.i18n.getMessage('html_health_reload_button', `${tabTypes.favEmpty.length}`);
      button.onclick = async (event) => {
        event.preventDefault();
        // button.classList.add('btnDisabled');
        // button.onclick = () => false;
        await reloadTabs(tabTypes.favEmpty);
        return false;
      };
    }
    else if (tabTypes.favHosts.length) {
      quickElemById('actionSection').style.display = 'block';
      quickElemById('actionIntro').innerHTML = chrome.i18n.getMessage('html_health_restore_intro');
      const button  = quickElemById('actionButton');
      button.innerHTML = chrome.i18n.getMessage('html_health_restore_button', `${tabTypes.favHosts.length}`);
      button.onclick = async (event) => {
        event.preventDefault();
        await restoreTabs(tabTypes.favHosts, tabTypes.favDefault);
        return false;
      };
    }
    else {
      quickElemById('actionSection').style.display = 'block';
      quickElemById('actionIntro').innerHTML = chrome.i18n.getMessage('html_health_all_good');
      const button  = quickElemById('actionButton');
      button.style.display = 'none';
    }

    const stats = {};
    Object.keys(tabTypes).forEach((key) => {
      stats[key] = tabTypes[key].length;
    });
    // log('log', 'Stats', `<pre>${JSON.stringify([stats, Array.from(tabHosts.values())], undefined, 2)}</pre>`);

    const copyButton  = document.getElementById('copyButton');
    const copySection = document.getElementById('copySection');
    const scanResults = document.getElementById('scanResults');
    if (copyButton && copySection && scanResults) {
      copyButton.onclick  = async (event) => {
        event.preventDefault();
        await navigator.clipboard.writeText(`
          ${chrome.runtime.getManifest().version}
          ${scanResults.innerText}
          ${JSON.stringify(stats, undefined, 2)}
        `.replace(/^\s+/img, ''));
        copyButton.innerHTML = '&nbsp;';
        await new Promise((resolve) => setTimeout(resolve, 100));
        copyButton.innerHTML = 'Done!';
        return false;
      };
      copySection.style.display = 'block';
    }

  }


  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {

    await gsTabSuspendManager.initAsPromised();
    await gsTabCheckManager.initAsPromised();

    // hide incompatible sidebar items if in incognito mode
    if (chrome.extension.inIncognitoContext) {
      Array.prototype.forEach.call(
        document.getElementsByClassName('noIncognito'),
        (el) => {
          el.style.display = 'none';
        },
      );
    }

    const scanButton  = document.getElementById('scanButton');
    if (scanButton) {
      scanButton.onclick  = async (event) => {
        event.preventDefault();
        await scan();
        return false;
      };
    }

  });

})();
