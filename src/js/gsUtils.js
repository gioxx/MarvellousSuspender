// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsMascot }              from './gsMascot.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { tgs }                   from './tgs.js';

'use strict';

let _localeMessages = null;

// ── Log buffer ────────────────────────────────────────────────────────────────
const _LOG_BUFFER_KEY = 'gsLogBuffer';
const _LOG_BUFFER_MAX = 500;
const _logBuffer = [];
// Separate, much larger ring buffer feeding only the downloadable/copyable report.
// The 500-entry _logBuffer above is what the debug page's live view renders; on a
// noisy profile (dozens of background tabs auto-suspending/discarding) that window
// alone is often only a minute or two, evicting whatever a reporter was actually
// trying to capture before they get to the download button.
const _LOG_BUFFER_FULL_KEY = 'gsLogBufferFull';
const _LOG_BUFFER_FULL_MAX = 10000;
const _logBufferFull = [];
// A random token stored alongside the buffers, replaced on every write attempt.
// manifest.json declares "incognito": "split", so a regular and an incognito window
// each get their own fully independent service worker instance (their own copy of
// every module-level variable below, including _writeQueue), while both still share
// the same chrome.storage.local — two such workers logging around the same time are
// two genuinely separate single-writers, not one. An incrementing counter can't tell
// these apart: two workers racing off the same prior value both compute the same
// next number, so whichever set() lands last leaves a value both sides consider a
// match, even though only one of their batches is actually still in the buffers. A
// per-attempt random token has no such collision — reading back exactly the token
// this attempt just wrote is proof this exact write (and no one else's) landed.
const _LOG_BUFFER_VERSION_KEY = 'gsLogBufferVersion';
// Persisted high-water mark for the last "Clear log" action, never removed by the clear
// itself. A page can already have grabbed a batch out of its own _pendingEntries (or be
// mid-flight sending it) at the exact moment a clear runs elsewhere; without this, that
// batch merging in afterwards would resurrect entries the user just wiped. Every merge
// attempt drops entries older than this timestamp before persisting, regardless of
// whether they arrive before or after the clear physically completes.
const _LOG_BUFFER_CLEARED_AT_KEY = 'gsLogBufferClearedAt';

function _newWriteToken() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}
let   _flushTimer = null;
// Entries logged in this context since its last successful flush, not yet confirmed
// persisted.
const _pendingEntries = [];

// Every page (including suspended.js, in every suspended tab) shares the same
// gsUtils.js module but gets its own separate instance — if each context wrote to
// chrome.storage directly, two contexts logging around the same time could each
// clobber what the other had just persisted, no matter how the read-modify-write is
// shaped, since chrome.storage has no compare-and-swap. Only the service worker
// (the one context every other one can always reach via messaging) actually touches
// these two storage keys; every other context hands its entries to it instead.
const _isServiceWorker =
  typeof ServiceWorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof ServiceWorkerGlobalScope;

// Chains every write (a merge, or a clear) through one promise, so this one service
// worker instance never has two get()/set() (or remove()) pairs for these keys in
// flight at once — without this, its own scheduled flush and an incoming message from
// another context could still interleave their storage round trips the same way
// multiple direct writers used to. Doesn't cover the split-incognito worker (see
// _LOG_BUFFER_VERSION_KEY above); the version check is what catches that.
let _writeQueue = Promise.resolve();

// Returns whether the batch ended up persisted (either written, or correctly dropped for
// predating the last clear) so callers can requeue on genuine failure instead of losing
// entries silently.
async function _mergeAndPersist(entries) {
  _writeQueue = _writeQueue.then(async () => {
    if (typeof chrome === 'undefined' || !chrome.storage || entries.length === 0) return true;
    // Bounded retry: read the latest snapshot, apply this batch on top of it, write,
    // then check the version is still exactly what we just wrote. If another worker's
    // write landed in between, our set() above already got silently overwritten by
    // it (or vice versa) — re-read and reapply the same batch on the newer state
    // instead of losing it.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result       = await chrome.storage.local.get([_LOG_BUFFER_KEY, _LOG_BUFFER_FULL_KEY, _LOG_BUFFER_CLEARED_AT_KEY]);
        const clearedAt    = result[_LOG_BUFFER_CLEARED_AT_KEY] || '';
        const freshEntries = clearedAt ? entries.filter((e) => e.ts > clearedAt) : entries;
        if (freshEntries.length === 0) return true; // entire batch predates the last clear
        const current       = JSON.parse(result[_LOG_BUFFER_KEY] || '[]');
        const currentFull   = JSON.parse(result[_LOG_BUFFER_FULL_KEY] || '[]');
        const myToken       = _newWriteToken();
        current.push(...freshEntries);
        if (current.length > _LOG_BUFFER_MAX) current.splice(0, current.length - _LOG_BUFFER_MAX);
        currentFull.push(...freshEntries);
        if (currentFull.length > _LOG_BUFFER_FULL_MAX) currentFull.splice(0, currentFull.length - _LOG_BUFFER_FULL_MAX);
        await chrome.storage.local.set({
          [_LOG_BUFFER_KEY]        : JSON.stringify(current),
          [_LOG_BUFFER_FULL_KEY]   : JSON.stringify(currentFull),
          [_LOG_BUFFER_VERSION_KEY]: myToken,
        });
        const verify = await chrome.storage.local.get([_LOG_BUFFER_VERSION_KEY, _LOG_BUFFER_CLEARED_AT_KEY]);
        // The token alone only proves no other *merge* wrote after ours — it doesn't
        // catch a Clear whose set(clearedAt) landed after our get() above but whose
        // remove() hadn't run yet, since that leaves the pre-clear `current` we just
        // read still in storage for us to read, append to, and write straight back on
        // top of the clear, undoing it entirely while still verifying "successfully".
        // Re-checking clearedAt here catches that: if it moved past what we filtered
        // against, our write may have resurrected pre-clear state, so treat it as a
        // race and retry against whatever's actually there now, same as a token miss.
        if (
          verify[_LOG_BUFFER_VERSION_KEY] === myToken &&
          (verify[_LOG_BUFFER_CLEARED_AT_KEY] || '') === clearedAt
        ) {
          return true; // no one raced us
        }
        // Someone else's write (a merge, or a clear) landed between our get() and set()
        // above — retry on top of whatever's there now instead of leaving it unpersisted.
      } catch { /* fall through to retry, or give up after the last attempt */ }
    }
    return false; // exhausted retries — caller is responsible for not losing these entries
  });
  return _writeQueue;
}

function _clearPersisted() {
  _writeQueue = _writeQueue.then(async () => {
    if (typeof chrome === 'undefined' || !chrome.storage) return false;
    try {
      // Written before the remove, and never cleaned up itself, so it stays the
      // authoritative cutoff for _mergeAndPersist() regardless of how a stale batch's
      // merge and this clear happen to interleave.
      await chrome.storage.local.set({ [_LOG_BUFFER_CLEARED_AT_KEY]: new Date().toISOString() });
      await chrome.storage.local.remove([_LOG_BUFFER_KEY, _LOG_BUFFER_FULL_KEY, _LOG_BUFFER_VERSION_KEY]);
      return true;
    } catch {
      // A rejected .then() callback would leave _writeQueue itself a rejected promise —
      // every _mergeAndPersist()/_clearPersisted() call chains onto it with .then() and
      // no rejection handler, so once rejected, every future call's callback would be
      // skipped forever (silently breaking logging until the worker restarts) instead
      // of just this one clear failing. Swallowing the error here keeps the queue alive.
      return false;
    }
  });
  return _writeQueue;
}

// Actions meant only for the service worker (or another internal recipient), sent via
// a bare chrome.runtime.sendMessage() with no tabId — which Chrome delivers to every
// listening extension page, not just the intended one. Every page's own
// messageRequestListener already has to tolerate that and ignore what it doesn't own,
// but doing so by logging "ignoring unhandled message" is itself a log call: for an
// action this frequent (gsAppendLogEntries, sent on every flush, roughly every 1.5s
// from any context that's logged something), that log entry becomes new pending
// history needing its own flush, whose "ignored" broadcast produces another log entry
// in turn, a self-sustaining loop with no natural end. Pages check this set and skip
// logging entirely for anything in it, rather than trying to rate-limit the loop.
const INTERNAL_MESSAGE_ACTIONS = new Set(['gsAppendLogEntries', 'clearLogs']);

// Only the service worker listens; every other context reaches it via sendMessage in
// _flushNow() below. Registered at module top level (not inside an async block) so
// Chrome can queue the very first message even if it arrives before this line runs.
if (_isServiceWorker && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'gsAppendLogEntries') return false;
    _mergeAndPersist(request.entries || []).then((success) => sendResponse({ success }));
    return true; // keep the channel open for the async sendResponse above
  });
}

// Cheap djb2-style hash so two favicons of similar length still show up as distinct in
// the log (a bare length like "[data URL, 812 chars]" can't tell "same icon" from
// "different icon, same size"), without hashing the full multi-KB string char-by-char.
function _shortHash(str) {
  let h = 5381;
  const step = Math.max(1, Math.floor(str.length / 200)); // sample at most ~200 chars
  for (let i = 0; i < str.length; i += step) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Tab objects logged wholesale (e.g. gsTabCheckManager's "Updated tab" dumps) carry
// favIconUrl as a base64 data: URL, often several KB of text per entry. Replacing it
// with a length+hash fingerprint here keeps every log call site favicon-safe without
// having to remember to redact it at each one, stops a handful of tab dumps from
// evicting most of the 500-entry buffer, and still lets "did the favicon change between
// these two log lines" be answered by comparing fingerprints, useful when a reporter's
// complaint is specifically about favicon behaviour.
function _redactDataUrls(key, value) {
  if (typeof value === 'string' && value.startsWith('data:') && value.length > 100) {
    return `[data URL, ${value.length} chars, #${_shortHash(value)}]`;
  }
  return value;
}

function _serialize(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, _redactDataUrls); } catch { return String(v); }
}

function _appendEntry(level, src, parts) {
  const entry = {
    ts    : new Date().toISOString(),
    level,
    src   : String(src),
    msg   : parts.map(_serialize).join(' '),
  };
  _logBuffer.push(entry);
  if (_logBuffer.length > _LOG_BUFFER_MAX) _logBuffer.shift();
  _logBufferFull.push(entry);
  if (_logBufferFull.length > _LOG_BUFFER_FULL_MAX) _logBufferFull.shift();
  _pendingEntries.push(entry);
}

async function _flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_pendingEntries.length === 0) return;
  // Grab-and-clear rather than read-then-clear, so entries logged while this flush is
  // still in flight stay queued for the next one instead of being dropped.
  const toPersist = _pendingEntries.splice(0, _pendingEntries.length);
  if (_isServiceWorker) {
    const success = await _mergeAndPersist(toPersist);
    if (!success) {
      // Storage errors on every retry attempt, or an exhausted version-conflict retry —
      // put the batch back at the front (ahead of anything logged meanwhile) and let the
      // next scheduled flush try again, instead of discarding captured diagnostic history.
      _pendingEntries.unshift(...toPersist);
      _scheduleFlush();
    }
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'gsAppendLogEntries', entries: toPersist });
    if (!response || !response.success) {
      _pendingEntries.unshift(...toPersist);
      _scheduleFlush();
    }
  } catch {
    // Service worker unreachable (e.g. mid-reload/recycle) — requeue and retry on the
    // next scheduled flush rather than dropping the batch; it's usually back within a
    // beat, and there's no other recipient for these entries in the meantime.
    _pendingEntries.unshift(...toPersist);
    _scheduleFlush();
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(_flushNow, 1500);
}
// ─────────────────────────────────────────────────────────────────────────────

export const gsUtils = {
  INTERNAL_MESSAGE_ACTIONS,
  STATUS_NORMAL         : 'normal',
  STATUS_LOADING        : 'loading',
  STATUS_SPECIAL        : 'special',
  STATUS_BLOCKED_FILE   : 'blockedFile',
  STATUS_SUSPENDED      : 'suspended',
  STATUS_DISCARDED      : 'discarded',
  STATUS_NEVER          : 'never',
  STATUS_FORMINPUT      : 'formInput',
  STATUS_AUDIBLE        : 'audible',
  STATUS_ACTIVE         : 'active',
  STATUS_TEMPWHITELIST  : 'tempWhitelist',
  STATUS_PINNED         : 'pinned',
  STATUS_WHITELISTED    : 'whitelisted',
  STATUS_CHARGING       : 'charging',
  STATUS_NOCONNECTIVITY : 'noConnectivity',
  STATUS_UNKNOWN        : 'unknown',

  debugInfo   : false,
  debugError  : false,
  captureLogs : false,

  contains(array, value) {
    for (var i = 0; i < array.length; i++) {
      if (array[i] === value) return true;
    }
    return false;
  },

  dir(object) {
    if (gsUtils.debugInfo) {
      // eslint-disable-next-line no-console
      console.dir(object);
    }
  },
  log(id, text, ...args) {
    args = args || [];
    if (gsUtils.debugInfo) {
      // eslint-disable-next-line no-console
      console.log(id, (new Date() + '').split(' ')[4], text, ...args);
    }
    if (gsUtils.captureLogs) {
      _appendEntry('I', id, [text, ...args]);
      _scheduleFlush();
    }
  },
  highlight(text, ...args) {
    gsUtils.log('highlight: %s %c%s', 'color:red', text, ...args);
  },
  warning(id, text, ...args) {
    args = args || [];
    if (gsUtils.debugError) {
      const ignores = ['Error', 'gsUtils', 'gsMessages'];
      const errorLine = gsUtils
        .getStackTrace()
        .split('\n')
        .filter((o) => !ignores.find((p) => o.indexOf(p) >= 0))
        .join('\n');
      // eslint-disable-next-line no-console
      console.warn('WARNING:', id, (new Date() + '').split(' ')[4], text, ...args, `\n${errorLine}`);
    }
    if (gsUtils.captureLogs || gsUtils.debugError) {
      _appendEntry('W', id, [text, ...args]);
      _scheduleFlush();
    }
  },
  error(id, errorObj, ...args) {
    if (errorObj === undefined) {
      errorObj = id;
      id = '?';
    }
    //NOTE: errorObj may be just a string :/
    const errorMessage = errorObj && errorObj.hasOwnProperty && errorObj.hasOwnProperty('message')
      ? errorObj.message
      : typeof errorObj === 'string'
        ? errorObj
        : JSON.stringify(errorObj, null, 2);
    if (gsUtils.debugError) {
      const stackTrace = errorObj && errorObj.hasOwnProperty && errorObj.hasOwnProperty('stack')
        ? errorObj.stack
        : gsUtils.getStackTrace();
      // eslint-disable-next-line no-console
      console.log(id, (new Date() + '').split(' ')[4], 'Error:');
      // eslint-disable-next-line no-console
      console.error(
        gsUtils.getPrintableError(errorMessage, stackTrace, ...args),
      );
    }
    // Always buffer errors regardless of flags
    _appendEntry('E', id, [errorMessage, ...args]);
    _flushNow();
  },
  // Puts all the error args into a single printable string so that all the info is displayed in the error console
  getPrintableError(errorMessage, stackTrace, ...args) {
    let errorString = errorMessage;
    errorString += `\n${args.map((o) => JSON.stringify(o, null, 2)).join('\n')}`;
    errorString += `\n${stackTrace}`;
    return errorString;
  },
  getStackTrace() {
    var obj = {};
    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(obj, gsUtils.getStackTrace);
      return obj.stack;
    }
  },

  isDebugInfo() {
    return gsUtils.debugInfo;
  },

  isDebugError() {
    return gsUtils.debugError;
  },

  setDebugInfo(value) {
    gsUtils.debugInfo = value;
  },

  setDebugError(value) {
    gsUtils.debugError = value;
  },

  isCaptureLogs() {
    return gsUtils.captureLogs;
  },

  setCaptureLogs(value) {
    gsUtils.captureLogs = value;
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ gsCaptureVerbose: value });
    }
  },

  getLogBuffer() {
    return _logBuffer.slice();
  },

  getLogBufferFull() {
    return _logBufferFull.slice();
  },

  // Only ever called from the service worker (background.js's 'clearLogs' case, itself
  // reached by messaging from the debug page). Chaining the removal through
  // _clearPersisted() orders it correctly against this context's own in-flight or
  // queued merges, but that alone doesn't cover a batch another page already grabbed
  // from its own _pendingEntries (or is still mid-flight sending) before this ran —
  // _clearPersisted()'s clearedAt timestamp is what stops that batch resurrecting old
  // entries once its merge eventually lands, whichever side of the clear it arrives on.
  async clearLogBuffer() {
    _logBuffer.length = 0;
    _logBufferFull.length = 0;
    _pendingEntries.length = 0;
    await _clearPersisted();
  },

  isDiscardedTab(tab) {
    return tab.discarded;
  },

  /**
   *
   * @param {chrome.tabs.Tab} tab
   * @returns {string | undefined}
   */
  getTabUrl (tab) {
    return tab.url || tab.pendingUrl;
  },

  isValidTabWithUrl(tab) {
    if (!tab || typeof tab == 'undefined') {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    if (url && typeof url == 'string' && url.length > 0) {
      return true;
    }
    return false;
  },


  /**
   * Detect the top Chromium browsers internal URL protocols.
   * If afterScheme is provided, it should typically start with "://"
   * @param {string} [url]
   * @param {string} [afterScheme]
   * @returns {boolean}
   */
  isBrowserInternalURL(url, afterScheme) {
    const after = afterScheme ?? ':';
    const ret   = Boolean((url ?? '').match(new RegExp(`^(about|chrome|edge|opera|brave|vivaldi|browser|arc)${after}`, 'i')));
    // gsUtils.log('gsUtils', 'isBrowserSpecialURL', url, afterScheme, ret);
    return ret;
  },

  /**
   * tests for non-standard web pages
   * suspended tabs are not considered "Special"
   * @param {chrome.tabs.Tab} tab
   * @returns {boolean}
   */
  isSpecialTab(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    if (gsUtils.isSuspendedTab(tab, true)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    // chrome-extension:// pages (TMS own pages or other extensions) cannot receive
    // content scripts and must never be suspended — isBrowserInternalURL misses them
    // because its regex matches "chrome:" but not "chrome-extension:".
    if (url?.startsWith(`${chrome.runtime.getURL('').split(':')[0]}://`)) {
      return true;
    }
    return ( this.isBrowserInternalURL(url) || gsUtils.isBlockedFileTab(tab) );
  },

  isFileTab(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    if (url?.startsWith('file')) {
      return true;
    }
    return false;
  },

  //tests if the page is a file:// page AND the user has not enabled access to
  //file URLs in extension settings
  isBlockedFileTab(tab) {
    if (gsUtils.isFileTab(tab) && !gsSession.isFileUrlsAccessAllowed()) {
      return true;
    }
    return false;
  },

  //does not include suspended pages!
  isInternalTab(tab) {
    if (!gsUtils.isValidTabWithUrl(tab)) {
      return false;
    }
    const url = gsUtils.getTabUrl(tab);
    const isLocalExtensionPage = url?.startsWith(chrome.runtime.getURL(''));
    return isLocalExtensionPage && !gsUtils.isSuspendedTab(tab);
  },

  isProtectedPinnedTab: async (tab) => {
    const ignorePinned = await gsStorage.getOption(gsStorage.IGNORE_PINNED);
    return ignorePinned && tab.pinned;
  },

  isProtectedAudibleTab: async (tab) => {
    const ignoreAudible = await gsStorage.getOption(gsStorage.IGNORE_AUDIO);
    return ignoreAudible && tab.audible;
  },

  isProtectedActiveTab: async (tab) => {
    const ignoreActiveTabs = await gsStorage.getOption(gsStorage.IGNORE_ACTIVE_TABS);
    return ( await tgs.isCurrentFocusedTab(tab) || (ignoreActiveTabs && tab.active) );
  },

  // Note: Normal tabs may be in a discarded state
  isNormalTab(tab, excludeDiscarded) {
    excludeDiscarded = excludeDiscarded || false;
    return (
      !gsUtils.isSpecialTab(tab) &&
      !gsUtils.isSuspendedTab(tab, true) &&
      (!excludeDiscarded || !gsUtils.isDiscardedTab(tab))
    );
  },

  isSuspendedTab(tab, looseMatching) {
    const url = tab.url || tab.pendingUrl;
    return gsUtils.isSuspendedUrl(url, looseMatching);
  },

  isSuspendedUrl(url, looseMatching) {
    if (!url) {
      return false;
    }
    else if (looseMatching) {
      return url.indexOf('suspended.html') > 0;
    }
    else {
      return url.indexOf(chrome.runtime.getURL('suspended.html')) === 0;
    }
  },

  shouldSuspendDiscardedTabs: async () => {
    const suspendInPlaceOfDiscard = await gsStorage.getOption(gsStorage.SUSPEND_IN_PLACE_OF_DISCARD);
    const discardInPlaceOfSuspend = await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    return suspendInPlaceOfDiscard && !discardInPlaceOfSuspend;
  },

  removeTabsByUrlAsPromised(url) {
    return new Promise(async (resolve) => {
      const tabs = await gsChrome.tabsQuery({ url });
      const tabIds = tabs.map((tab) => tab.id).filter((item) => item !== undefined);
      chrome.tabs.remove(tabIds, () => {
        resolve(null);
      });
    });
  },

  createTabAndWaitForFinishLoading(url, maxWaitTimeInMs) {
    return new Promise(async (resolve) => {
      let tab = await gsChrome.tabsCreate(url);
      const retryUntil = Date.now() + (maxWaitTimeInMs || 1000);
      let loaded = false;
      while (tab && !loaded && Date.now() < retryUntil) {
        loaded = tab.status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
          tab = await gsChrome.tabsGet(tab.id);
        }
      }
      resolve(tab);
    });
  },

  createWindowAndWaitForFinishLoading(createData, maxWaitTimeInMs) {
    return new Promise(async (resolve) => {
      let window = await gsChrome.windowsCreate(createData);
      maxWaitTimeInMs = maxWaitTimeInMs || 1000;
      const retryUntil = Date.now() + maxWaitTimeInMs;
      let loaded = false;
      while (!loaded && Date.now() < retryUntil) {
        window = await gsChrome.windowsGet(window.id);
        loaded = window.tabs.length > 0 && window.tabs[0].status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
        }
      }
      resolve(window);
    });
  },

  checkWhiteList: async (url) => {
    const whitelist = await gsStorage.getOption(gsStorage.WHITELIST);
    return gsUtils.checkSpecificWhiteList(url, whitelist);
  },

  checkSpecificWhiteList(url, whitelistString) {
    const whitelistItems = whitelistString ? whitelistString.split(/[\s\n]+/) : [];
    const whitelisted = whitelistItems.some((item) => {
      return gsUtils.testForMatch(item, url);
    }, this);
    return whitelisted;
  },

  // URLs on this list always suspend after the normal timeout, bypassing the pinned/
  // audible/form-input protections that would otherwise keep them open (#103). Global
  // protections (offline, charging, "never suspend") and an explicit per-tab pause are
  // still respected, this only overrides the passive/automatic ones.
  checkAlwaysSuspendList: async (url) => {
    const list = await gsStorage.getOption(gsStorage.ALWAYS_SUSPEND_LIST);
    return gsUtils.checkSpecificAlwaysSuspendList(url, list);
  },

  checkSpecificAlwaysSuspendList(url, listString) {
    const listItems = listString ? listString.split(/[\s\n]+/) : [];
    return listItems.some((item) => gsUtils.testForMatch(item, url));
  },

  removeFromWhitelist: async (url) => {
    const oldWhitelistString = (await gsStorage.getOption(gsStorage.WHITELIST)) || '';
    const whitelistItems = oldWhitelistString.split(/[\s\n]+/).sort();
    let i;

    for (i = whitelistItems.length - 1; i >= 0; i--) {
      if (gsUtils.testForMatch(whitelistItems[i], url)) {
        whitelistItems.splice(i, 1);
      }
    }
    var whitelistString = whitelistItems.join('\n');
    await gsStorage.setOptionAndSync(gsStorage.WHITELIST, whitelistString);

    var key = gsStorage.WHITELIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldWhitelistString },
      { [key]: whitelistString },
    );
  },

  testForMatch(whitelistItem, word) {
    if (whitelistItem.length < 1) {
      return false;

      //test for regex ( must be of the form /foobar/ )
    }
    else if (
      whitelistItem.length > 2 &&
      whitelistItem.indexOf('/') === 0 &&
      whitelistItem.indexOf('/', whitelistItem.length - 1) !== -1
    ) {
      whitelistItem = whitelistItem.substring(1, whitelistItem.length - 1);
      try {
        new RegExp(whitelistItem);
      }
      catch (e) {
        return false;
      }
      return new RegExp(whitelistItem).test(word);

      // test as substring
    }
    else {
      return word.indexOf(whitelistItem) >= 0;
    }
  },

  saveToWhitelist: async (newString) => {
    const oldWhitelistString = (await gsStorage.getOption(gsStorage.WHITELIST)) || '';
    let newWhitelistString = oldWhitelistString + '\n' + newString;
    newWhitelistString = gsUtils.cleanupWhitelist(newWhitelistString);
    await gsStorage.setOptionAndSync(gsStorage.WHITELIST, newWhitelistString);

    const key = gsStorage.WHITELIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldWhitelistString },
      { [key]: newWhitelistString },
    );
  },

  cleanupWhitelist(whitelist) {
    var whitelistItems = whitelist ? whitelist.split(/[\s\n]+/).sort() : '',
      i,
      j;

    for (i = whitelistItems.length - 1; i >= 0; i--) {
      j = whitelistItems.lastIndexOf(whitelistItems[i]);
      if (j !== i) {
        whitelistItems.splice(i + 1, j - i);
      }
      if (!whitelistItems[i] || whitelistItems[i] === '') {
        whitelistItems.splice(i, 1);
      }
    }
    if (whitelistItems.length) {
      return whitelistItems.join('\n');
    }
    else {
      return whitelistItems;
    }
  },

  documentReadyAsPromised(doc) {
    return new Promise((resolve) => {
      if (doc.readyState !== 'loading') {
        resolve(null);
      }
      else {
        doc.addEventListener('DOMContentLoaded', () => {
          resolve(null);
        });
      }
    });
  },

  async loadLocaleMessages(locale) {
    if (!locale || locale === 'auto') {
      _localeMessages = null;
      return;
    }
    try {
      const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
      const response = await fetch(url);
      _localeMessages = response.ok ? await response.json() : null;
    } catch (e) {
      _localeMessages = null;
    }
  },

  initSelectArrows(parentEl) {
    parentEl.querySelectorAll('.select-wrapper select').forEach(sel => {
      const wrapper = sel.closest('.select-wrapper');
      sel.addEventListener('focus',     () => wrapper.classList.add('is-open'));
      sel.addEventListener('blur',      () => wrapper.classList.remove('is-open'));
      sel.addEventListener('change',    () => wrapper.classList.remove('is-open'));
      sel.addEventListener('mousedown', () => {
        if (document.activeElement === sel) wrapper.classList.remove('is-open');
      });
    });
  },

  getMessage(key, substitutions) {
    if (_localeMessages && _localeMessages[key]) {
      const entry = _localeMessages[key];
      let msg = entry.message || '';
      if (substitutions !== undefined && entry.placeholders) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        for (const [name, ph] of Object.entries(entry.placeholders)) {
          const idx = parseInt((ph.content || '').replace('$', ''), 10) - 1;
          if (!isNaN(idx) && subs[idx] !== undefined) {
            msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[idx]);
          }
        }
      }
      return msg;
    }
    return chrome.i18n.getMessage(key, substitutions) || '';
  },

  localiseHtml(parentEl) {
    const replaceTagFunc = function(match, p1) {
      if (!p1) return '';
      if (_localeMessages && _localeMessages[p1]) return _localeMessages[p1].message || '';
      return chrome.i18n.getMessage(p1) || '';
    };
    for (const el of parentEl.getElementsByTagName('*')) {
      if (el.hasAttribute('data-i18n')) {
        el.innerHTML = el
          .getAttribute('data-i18n')
          .replace(/__MSG_(\w+)__/g, replaceTagFunc)
          .replace(/\n/g, '<br />');
      }
      if (el.hasAttribute('data-i18n-tooltip')) {
        el.setAttribute(
          'data-i18n-tooltip',
          el
            .getAttribute('data-i18n-tooltip')
            .replace(/__MSG_(\w+)__/g, replaceTagFunc),
        );
      }
      if (el.hasAttribute('data-i18n-aria-label')) {
        el.setAttribute(
          'aria-label',
          el
            .getAttribute('data-i18n-aria-label')
            .replace(/__MSG_(\w+)__/g, replaceTagFunc),
        );
      }
    }
  },

  setPageTheme(win, theme) {
    if (win.document?.body) {
      // Set theme
      if (theme === 'system') {
        const isDark = win.matchMedia('(prefers-color-scheme: dark)').matches;
        theme = isDark ? 'dark' : 'light';
      }
      win.document.body.classList.remove('dark', 'light');
      win.document.body.classList.add(theme);
    }
  },

  async documentReadyAndLocalisedAsPromised(win) {
    await gsUtils.documentReadyAsPromised(win.document);
    const locale = await gsStorage.getOption(gsStorage.LANGUAGE);
    await gsUtils.loadLocaleMessages(locale);
    gsUtils.localiseHtml(win.document);
    await gsMascot.applyToDocument(win.document);

    const vEl = win.document.getElementById('headerVersion');
    if (vEl) vEl.textContent = 'v' + chrome.runtime.getManifest().version;

    if (win.document?.body) {
      const theme = await gsStorage.getOption(gsStorage.THEME);
      this.setPageTheme(win, theme);
      // Unhide the body
      setTimeout(() => {
        win.document.body.classList.add('visible');
      }, 100);
    }
  },

  generateSuspendedUrl: (url, title, scrollPos) => {
    const encodedTitle = gsUtils.encodeString(title);
    var args = `#ttl=${encodedTitle}&pos=${scrollPos || '0'}&uri=${url}`;
    return chrome.runtime.getURL('suspended.html' + args);
  },

  /**
   * @param {string | URL} url
   * @param {string | URL | undefined} [base]
   * @returns {URL | undefined}
   */
  getNewURL(url, base) {
    try {
      return new URL(url, base);
    }
    catch (error) { /* do nothing */ }
  },

  /**
   * @param {string | undefined} url
   * @returns string | undefined
   */
  getRootUrlNew(url) {
    // @TODO: Make some unit tests to verify getRootUrl vs getRootUrlNew
    if (!url || url.match('^(data|file):')) return;
    const fullURL = this.getNewURL(url);
    const newURL  = this.getNewURL(`//${fullURL?.host}`, fullURL);
    return newURL?.toString();
  },

  getRootUrl(url, includePath, includeScheme) {
    let rootUrlStr = url;
    let scheme;

    // temporarily remove scheme
    if (rootUrlStr.indexOf('//') > 0) {
      scheme = rootUrlStr.substring(0, rootUrlStr.indexOf('//') + 2);
      rootUrlStr = rootUrlStr.substring(rootUrlStr.indexOf('//') + 2);
    }

    // remove path
    if (!includePath) {
      if (scheme === 'file://') {
        rootUrlStr = rootUrlStr.replace(new RegExp('/[^/]*$', 'g'), '');
      }
      else {
        const pathStartIndex =
          rootUrlStr.indexOf('/') > 0
            ? rootUrlStr.indexOf('/')
            : rootUrlStr.length;
        rootUrlStr = rootUrlStr.substring(0, pathStartIndex);
      }
    }
    else {
      // remove query string
      var match = rootUrlStr.match(/\/?[?#]+/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
      // remove trailing slash
      match = rootUrlStr.match(/\/$/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
    }

    // readd scheme
    if (scheme && includeScheme) {
      rootUrlStr = scheme + rootUrlStr;
    }
    return rootUrlStr;
  },

  getHashVariable(key, urlStr) {
    var valuesByKey = {},
      keyPairRegEx = /^(.+)=(.+)/,
      hashStr;

    if (!urlStr || urlStr.length === 0 || urlStr.indexOf('#') === -1) {
      return false;
    }

    //extract hash component from url
    hashStr = urlStr.replace(/^[^#]+#+(.*)/, '$1');

    if (hashStr.length === 0) {
      return false;
    }

    //handle possible unencoded final var called 'uri'
    const uriIndex = hashStr.indexOf('uri=');
    if (uriIndex >= 0) {
      valuesByKey.uri = hashStr.substr(uriIndex + 4);
      hashStr = hashStr.substr(0, uriIndex);
    }

    hashStr.split('&').forEach((keyPair) => {
      if (keyPair && keyPair.match(keyPairRegEx)) {
        valuesByKey[keyPair.replace(keyPairRegEx, '$1')] = keyPair.replace(
          keyPairRegEx,
          '$2',
        );
      }
    });
    return valuesByKey[key] || false;
  },
  getSuspendedTitle(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('ttl', urlStr) || '');
  },
  getSuspendedScrollPosition(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('pos', urlStr) || '');
  },

  /**
   * @param   {chrome.tabs.Tab} tab
   * @returns {Promise<boolean>}
   */
  async resuspendSuspendedTab(tab) {
    gsUtils.log(tab.id, 'Resuspending unresponsive suspended tab.');
    if (await gsChrome.contextGetByTabId(tab.id)) {
      await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_DISABLE_UNSUSPEND_ON_RELOAD, true);
    }
    const reloadOk = await gsChrome.tabsReload(tab.id);
    return reloadOk;
  },

  /**
   * @param {string} urlStr
   * @returns {string}
   */
  getOriginalUrl(urlStr) {
    return (
      gsUtils.getHashVariable('uri', urlStr) ||
      gsUtils.decodeString(gsUtils.getHashVariable('url', urlStr) || '')
    );
  },
  getCleanTabTitle(tab) {
    let cleanedTitle = gsUtils.decodeString(tab.title);
    if (
      !cleanedTitle ||
      cleanedTitle === '' ||
      cleanedTitle === gsUtils.decodeString(tab.url) ||
      cleanedTitle === 'Suspended Tab'
    ) {
      if (gsUtils.isSuspendedTab(tab)) {
        cleanedTitle =
          gsUtils.getSuspendedTitle(tab.url) || gsUtils.getOriginalUrl(tab.url);
      }
      else {
        cleanedTitle = tab.url;
      }
    }
    return cleanedTitle;
  },
  decodeString(string) {
    try {
      return decodeURIComponent(string);
    }
    catch (e) {
      return string;
    }
  },
  encodeString(string) {
    try {
      return encodeURIComponent(string);
    }
    catch (e) {
      return string;
    }
  },

  formatHotkeyString(hotkeyString) {
    return hotkeyString
      .replace(/Command/, '⌘')
      .replace(/[⌘\u2318]/, ' ⌘ ')
      .replace(/[⇧\u21E7]/, ' Shift ')
      .replace(/[⌃\u8963]/, ' Ctrl ')
      .replace(/[⌥\u8997]/, ' Option ')
      .replace(/\+/g, ' ')
      .replace(/ +/g, ' ')
      .trim()
      .replace(/[ ]/g, ' \u00B7 ');
  },

  async getSuspendedTabCount() {
    const currentTabs = await gsChrome.tabsQuery();
    const currentSuspendedTabs = currentTabs.filter((tab) =>
      gsUtils.isSuspendedTab(tab),
    );
    return currentSuspendedTabs.length;
  },

  htmlEncode(text) {
    const pre = document.createElement('pre').appendChild(document.createTextNode(text));
    return pre.parentElement?.innerHTML;
  },

  getChromeVersion() {
    var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
    return raw ? parseInt(raw[2], 10) : false;
  },

  generateHashCode(text) {
    var hash = 0,
      i,
      chr,
      len;
    if (!text) return hash;
    for (i = 0, len = text.length; i < len; i++) {
      chr = text.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  },

  performPostSaveUpdates(changedSettingKeys, oldValueBySettingKey, newValueBySettingKey) {
    // gsUtils.log('gsUtils', 'performPostSaveUpdates');
    if (changedSettingKeys.includes(gsStorage.LEGACY_MASCOT)) {
      tgs.refreshDefaultIcon();
      tgs.setIconStatusForActiveTab();
    }
    chrome.tabs.query({}, async (tabs) => {
      for (const tab of tabs) {
        if (gsUtils.isSpecialTab(tab)) {
          continue;
        }

        if (gsUtils.isSuspendedTab(tab)) {
          //If toggling IGNORE_PINNED or IGNORE_ACTIVE_TABS to TRUE, then unsuspend any suspended pinned/active tabs
          if (
            (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) && (await gsUtils.isProtectedPinnedTab(tab))) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) && (await gsUtils.isProtectedActiveTab(tab)))
          ) {
            await tgs.unsuspendTab(tab);
            continue;
          }

          // if the legacy mascot setting has changed then refresh already-suspended tabs
          const updateMascot = changedSettingKeys.includes(gsStorage.LEGACY_MASCOT);
          if (updateMascot) {
            if (await gsChrome.contextGetByTabId(tab.id)) {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { action: 'updateMascot' });
              }
            }
          }

          // if theme or screenshot preferences have changed then refresh suspended tabs
          const updateTheme = changedSettingKeys.includes(gsStorage.THEME);
          const updatePreviewMode = changedSettingKeys.includes(gsStorage.SCREEN_CAPTURE);
          if (updateTheme || updatePreviewMode) {
            if (await gsChrome.contextGetByTabId(tab.id)) {
              if (updateTheme) {
                gsStorage.getOption(gsStorage.THEME).then((theme) => {
                  // @TODO favicon will probably fail here if it can't create a DOM Image
                  gsFavicon.getFaviconMeta(tab).then((faviconMeta) => {
                    const isLowContrastFavicon = faviconMeta.isDark || false;
                    if (tab.id) {
                      chrome.tabs.sendMessage(tab.id, { action: 'updateTheme', tab, theme, isLowContrastFavicon });
                    }
                  });
                });
              }
              if (updatePreviewMode) {
                gsStorage.getOption(gsStorage.SCREEN_CAPTURE).then((previewMode) => {
                  if (tab.id) {
                    chrome.tabs.sendMessage(tab.id, { action: 'updatePreviewMode', tab, previewMode });
                  }
                });
              }
            }
          }

          //if discardAfterSuspend has changed then updated discarded tabs
          const updateDiscardAfterSuspend = changedSettingKeys.includes(gsStorage.DISCARD_AFTER_SUSPEND);
          gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND).then((discardAfterSuspend) => {
            if (
              updateDiscardAfterSuspend &&
              discardAfterSuspend &&
              gsUtils.isSuspendedTab(tab) &&
              !gsUtils.isDiscardedTab(tab)
            ) {
              gsTabDiscardManager.queueTabForDiscard(tab);
            }
            return;
          });
        }

        if (!gsUtils.isNormalTab(tab, true)) {
          continue;
        }

        //update content scripts of normal tabs
        const updateIgnoreForms = changedSettingKeys.includes(
          gsStorage.IGNORE_FORMS,
        );
        if (updateIgnoreForms) {
          gsMessages.sendUpdateToContentScriptOfTab(tab); //async. unhandled error
        }

        gsStorage.getSettings().then(async (settings) => {
          //update suspend timers
          const updateSuspendTime =
            changedSettingKeys.includes(gsStorage.SUSPEND_TIME) ||
            (changedSettingKeys.includes(gsStorage.SUSPEND_TIME_ON_BATTERY) && (await tgs.isCharging()) === false) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) && tab.active) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) && !settings[gsStorage.IGNORE_PINNED] && tab.pinned) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_AUDIO) && !settings[gsStorage.IGNORE_AUDIO] && tab.audible) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_OFFLINE) && !settings[gsStorage.IGNORE_WHEN_OFFLINE] && !navigator.onLine) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_CHARGING) && !settings[gsStorage.IGNORE_WHEN_CHARGING] && await tgs.isCharging()) ||
            (changedSettingKeys.includes(gsStorage.WHITELIST) &&
              ( gsUtils.checkSpecificWhiteList(tab.url, oldValueBySettingKey[gsStorage.WHITELIST]) &&
               !gsUtils.checkSpecificWhiteList(tab.url, newValueBySettingKey[gsStorage.WHITELIST])
              )
            ) ||
            // A tab newly added to the "always suspend" list may currently be protected
            // (pinned/audible/active) with its timer already fired-and-rejected once, and
            // nothing else would re-arm it, it'd just sit open indefinitely (#103 review).
            (changedSettingKeys.includes(gsStorage.ALWAYS_SUSPEND_LIST) &&
              ( !gsUtils.checkSpecificAlwaysSuspendList(tab.url, oldValueBySettingKey[gsStorage.ALWAYS_SUSPEND_LIST]) &&
               gsUtils.checkSpecificAlwaysSuspendList(tab.url, newValueBySettingKey[gsStorage.ALWAYS_SUSPEND_LIST])
              )
            );
          if (updateSuspendTime) {
            await tgs.resetAutoSuspendTimerForTab(tab);
          }
        });

        //if SuspendInPlaceOfDiscard has changed then updated discarded tabs
        const updateSuspendInPlaceOfDiscard = changedSettingKeys.includes( gsStorage.SUSPEND_IN_PLACE_OF_DISCARD );
        if (updateSuspendInPlaceOfDiscard && gsUtils.isDiscardedTab(tab)) {
          gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.
          //note: this may cause the tab to suspend
        }

        //if we aren't resetting the timer on this tab, then check to make sure it does not have an expired timer
        //should always be caught by tests above, but we'll check all tabs anyway just in case
        // if (!updateSuspendTime) {
        //     gsMessages.sendRequestInfoToContentScript(tab.id, function (err, tabInfo) { // unhandled error
        //         await tgs.calculateTabStatus(tab, tabInfo, function (tabStatus) {
        //             if (tabStatus === STATUS_NORMAL && tabInfo && tabInfo.timerUp && (new Date(tabInfo.timerUp)) < new Date()) {
        //                 gsUtils.error(tab.id, 'Tab has an expired timer!', tabInfo);
        //                 gsMessages.sendUpdateToContentScriptOfTab(tab, true, false); // async. unhandled error
        //             }
        //         });
        //     });
        // }
      };
    });

    //if context menu has been disabled then remove from chrome
    if (gsUtils.contains(changedSettingKeys, gsStorage.ADD_CONTEXT)) {
      gsStorage.getOption(gsStorage.ADD_CONTEXT).then((addContextMenu) => {
        tgs.buildContextMenu(addContextMenu);
      });
    }

    //if screenshot preferences have changed then update the queue parameters
    if (
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE) ||
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE_FORCE)
    ) {
      gsTabSuspendManager.initAsPromised(); //async. unhandled promise
    }
  },

  getWindowFromSession(windowId, session) {
    var window = false;
    session.windows.some((curWindow) => {
      //leave this as a loose matching as sometimes it is comparing strings. other times ints
      if (curWindow.id == windowId) {
        window = curWindow;
        return true;
      }
    });
    return window;
  },

  removeInternalUrlsFromSession(session) {
    if (!session || !session.windows) { return; }
    for (var i = session.windows.length - 1; i >= 0; i--) {
      var curWindow = session.windows[i];
      for (var j = curWindow.tabs.length - 1; j >= 0; j--) {
        var curTab = curWindow.tabs[j];
        if (gsUtils.isInternalTab(curTab)) {
          curWindow.tabs.splice(j, 1);
        }
      }
      if (curWindow.tabs.length === 0) {
        session.windows.splice(i, 1);
      }
    }
  },

  getSimpleDate(date) {
    var d = new Date(date);
    return (
      ('0' + d.getDate()).slice(-2) +
      '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) +
      '-' +
      d.getFullYear() +
      ' ' +
      ('0' + d.getHours()).slice(-2) +
      ':' +
      ('0' + d.getMinutes()).slice(-2)
    );
  },

  getHumanDate(date) {
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      d = new Date(date),
      currentDate = d.getDate(),
      currentMonth = d.getMonth(),
      currentYear = d.getFullYear(),
      currentHours = d.getHours(),
      currentMinutes = d.getMinutes();

    var AMPM = currentHours >= 12 ? 'pm' : 'am';
    var hoursString = currentHours % 12 || 12;
    var minutesString = ('0' + currentMinutes).slice(-2);

    return ( `${currentDate} ${monthNames[currentMonth]} ${currentYear} ${hoursString}:${minutesString}${AMPM}`);
  },

  debounce(func, wait) {
    var timeout;
    return () => {
      var context = this,
        args = arguments;
      var later = function() {
        timeout = null;
        func.apply(context, args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  async setTimeout(timeout) {
    return new Promise((resolve) => {
      setTimeout(resolve, timeout);
    });
  },

  executeWithRetries: async ( promiseFn, fnArgsArray, maxRetries, retryWaitTime ) => {
    const retryFn = async (retries) => {
      try {
        return await promiseFn(...fnArgsArray);
      }
      catch (e) {
        if (retries >= maxRetries) {
          gsUtils.warning('gsUtils', 'Max retries exceeded');
          return Promise.reject(e);
        }
        retries += 1;
        await gsUtils.setTimeout(retryWaitTime);
        return await retryFn(retries);
      }
    };
    return await retryFn(0);
  },
};

// Every page (and the service worker) gets its own module instance and therefore its own
// copy of gsUtils.captureLogs — restoring the persisted flag only in background.js (as
// this used to do) meant every other context's warning()/log() calls never buffered
// anything even with captureLogs enabled, since each of those contexts' own captureLogs
// stayed at the hardcoded false default. Restoring it here instead of duplicating this
// in every page's own script covers all of them, including the service worker itself,
// with one copy of the logic. Runs on every module load (not just once per browser
// session), since the service worker's own in-memory flag also resets on every recycle.
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get(['gsCaptureVerbose'], (result) => {
    if (result.gsCaptureVerbose) gsUtils.captureLogs = true;
  });
  // The above only covers this module instance's state at load time. Toggling captureLogs
  // on the debug page only messages the service worker directly (background.js's
  // 'setCaptureLogs' case); it doesn't reach any options/suspended/etc. page already open
  // at the time, which would otherwise keep whatever value it loaded with until reloaded.
  // Every context already has a storage listener available for free, so keeping every
  // instance in sync live is just reading the new value here instead of also having to
  // route a message to every possible open page.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'gsCaptureVerbose' in changes) {
      gsUtils.captureLogs = !!changes.gsCaptureVerbose.newValue;
    }
  });
}
