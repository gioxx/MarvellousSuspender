import  { openDB }                from './idb.js';
import  { gsChrome }              from './gsChrome.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';

// One native screenshot per open tab, taken while it is on screen, for tabs later suspended in the background
export const gsPrecapture = (function() {

  const DB_NAME = 'tmsPrecapture';
  const DB_STORE = 'captures';
  const ALL_URLS = { origins: ['<all_urls>'] };

  const SETTLE_DELAY = 1000;
  const CAPTURE_TIMEOUT = 1500;
  // chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND is 2
  const MIN_CAPTURE_INTERVAL = 600;

  const _timers = new Map();
  let _db;
  let _pruned = false;
  let _lastCaptureAt = 0;
  // Every caller of captureVisibleTab() is chained through this, not just the precapture
  // scheduler: the suspension queue's own concurrent jobs (one per window's active tab) can
  // call it directly, and without a shared chain their calls aren't spaced at all.
  let _captureChain = Promise.resolve();
  // Bumped by clear(): a capture already in flight when the setting is disabled must not
  // write to the store after it's been cleared, even though it passed isEnabled() earlier.
  let _generation = 0;

  // Deliberately not a store in the main 'tgs' database: previews there are keyed by url and
  // trimmed oldest first, so writing one per visited page would evict suspended tabs' previews
  async function getDb() {
    _db ??= await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(DB_STORE, { keyPath: 'tabId' });
      },
    });
    return _db;
  }

  async function isEnabled() {
    if (!await gsStorage.getOption(gsStorage.SCREEN_CAPTURE_PRECAPTURE)) return false;
    if (await gsStorage.getOption(gsStorage.SCREEN_CAPTURE) === '0') return false;
    if (await gsStorage.getOption(gsStorage.SCREEN_CAPTURE_METHOD) === 'renderer') return false;
    // The option syncs between devices but the permission does not
    return chrome.permissions.contains(ALL_URLS);
  }

  // Resolves with a data url, or null when the tab is not the visible tab of its window
  function captureVisibleTab(tab) {
    // Chained rather than fired directly: two concurrent callers (e.g. two suspension-queue
    // jobs for active tabs in different windows) must not both pass a stale _lastCaptureAt
    // check and issue their chrome.tabs.captureVisibleTab() calls in the same instant.
    const run = _captureChain.then(() => doCaptureVisibleTab(tab));
    // Keep the chain alive even if this run rejects, so the next queued caller still gets a turn
    _captureChain = run.catch(() => {});
    return run;
  }

  async function doCaptureVisibleTab(tab) {
    const isCapturable = async () => {
      const _tab = await gsChrome.tabsGet(tab.id);
      return !!_tab && _tab.active && !gsUtils.isSuspendedTab(_tab);
    };
    if (!await isCapturable()) {
      return null;
    }

    const wait = _lastCaptureAt + MIN_CAPTURE_INTERVAL - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (!await isCapturable()) {
        return null;
      }
    }

    const forceScreenCapture = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE_FORCE);
    const options = { format: 'jpeg', quality: forceScreenCapture ? 92 : 50 };
    let timer;
    // Counts against the per-second quota whether or not it succeeds, so record it up front
    _lastCaptureAt = Date.now();
    try {
      // captureVisibleTab never settles for a window that isn't painting (occluded, display asleep)
      const dataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(tab.windowId, options),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out')), CAPTURE_TIMEOUT);
        }),
      ]);
      // The capture is of whichever tab is active at that instant, so make sure it was still ours
      if (!await isCapturable()) {
        return null;
      }
      return dataUrl ?? null;
    }
    catch (e) {
      gsUtils.log(tab.id, 'gsPrecapture', 'Native capture failed', e.message);
      return null;
    }
    finally {
      clearTimeout(timer);
    }
  }

  function schedule(tabId, delay = SETTLE_DELAY) {
    clearTimeout(_timers.get(tabId));
    _timers.set(tabId, setTimeout(() => {
      _timers.delete(tabId);
      precapture(tabId).catch((e) => { gsUtils.log(tabId, 'gsPrecapture', e); });
    }, delay));
  }

  async function precapture(tabId) {
    // Snapshot before the isEnabled() await, not after: clear() can bump this while that
    // await is in flight, and a snapshot taken afterwards would already read the bumped
    // value, defeating the check below entirely.
    const generation = _generation;
    if (!await isEnabled()) return;
    await prune();

    const tab = await gsChrome.tabsGet(tabId);
    if (!tab?.active || tab.incognito || tab.status !== 'complete') return;
    if (gsUtils.isSuspendedTab(tab) || gsUtils.isSpecialTab(tab)) return;
    // A tab that will never be suspended never needs a preview
    if (await gsUtils.checkWhiteList(tab.url)) return;

    const wait = _lastCaptureAt + MIN_CAPTURE_INTERVAL - Date.now();
    if (wait > 0) {
      schedule(tabId, wait);
      return;
    }

    const img = await captureVisibleTab(tab);
    if (!img) return;
    const current = await gsChrome.tabsGet(tabId);
    if (current?.url !== tab.url) return;
    if (generation !== _generation) return;

    const db = await getDb();
    await db.put(DB_STORE, { tabId, url: tab.url, img });
    gsUtils.log(tabId, 'gsPrecapture', 'Stored pre-capture');
  }

  // Only hands back a capture of the exact page the tab is still showing
  async function take(tabId, url) {
    try {
      if (!await isEnabled()) return null;
      const db = await getDb();
      const record = await db.get(DB_STORE, tabId);
      return record?.url === url ? record.img : null;
    }
    catch (e) {
      gsUtils.log(tabId, 'gsPrecapture', e);
      return null;
    }
  }

  async function remove(tabId) {
    clearTimeout(_timers.get(tabId));
    _timers.delete(tabId);
    // Always deletes, regardless of the current setting: a stored capture must not outlive
    // its tab just because the setting was turned off (locally, or via a sync echo) in between.
    try {
      const db = await getDb();
      await db.delete(DB_STORE, tabId);
    }
    catch (e) {
      gsUtils.log(tabId, 'gsPrecapture', e);
    }
  }

  // Tab ids don't survive a browser restart, so drop whatever no longer maps to an open tab
  async function prune() {
    if (_pruned) return;
    _pruned = true;
    const openTabIds = new Set((await gsChrome.tabsQuery()).map((tab) => tab.id));
    const db = await getDb();
    for (const tabId of await db.getAllKeys(DB_STORE)) {
      if (!openTabIds.has(tabId)) {
        await db.delete(DB_STORE, tabId);
      }
    }
  }

  async function clear() {
    _generation++;
    // Cancel timers scheduled before the disable click: the generation check alone only
    // catches a capture already past isEnabled() when this runs, not one whose timer fires
    // afterwards -- options.js doesn't persist the setting as off until this call returns,
    // so a freshly-fired timer's own isEnabled() would still read the stale 'true' value.
    for (const timer of _timers.values()) {
      clearTimeout(timer);
    }
    _timers.clear();
    const db = await getDb();
    await db.clear(DB_STORE);
  }

  return {
    ALL_URLS,
    captureVisibleTab,
    schedule,
    take,
    remove,
    clear,
  };
})();
