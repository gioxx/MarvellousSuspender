import { openDB }    from './idb.js';
import { gsSession } from './gsSession.js';
import { gsUtils }   from './gsUtils.js';

'use strict';

export const gsIndexedDb = {
  DB_SERVER:   'tgs',
  // Bumped to 5 specifically to force upgrade() to actually run again for anyone who'd
  // already opened DB_VERSION 4 before the 'ts' index below existed on DB_LOG_ENTRIES —
  // IndexedDB only ever fires onupgradeneeded when the *requested* version is higher than
  // the database's current stored one, never merely different. Adding the index while
  // leaving DB_VERSION unchanged (the original assumption behind this upgrade()'s
  // transaction.objectStore() handling for already-existing stores) silently meant that
  // handling could never run for anyone already at 4: their on-disk database kept no 'ts'
  // index at all, and fetchLogEntries()'s index('ts') call failed outright, caught by its
  // own try/catch and returning an empty array — the live view showing "No entries" while
  // countLogEntries() (a plain store-level count, no index needed) kept climbing normally.
  DB_VERSION:  5,
  DB_PREVIEWS:             'gsPreviews',
  DB_SUSPENDED_TABINFO:    'gsSuspendedTabInfo',
  DB_FAVICON_META:         'gsFaviconMeta',
  DB_CURRENT_SESSIONS:     'gsCurrentSessions',
  DB_SAVED_SESSIONS:       'gsSavedSessions',
  DB_LOG_ENTRIES:          'gsLogEntries',
  DB_SESSION_PRE_UPGRADE_KEY: 'preUpgradeVersion',

  // Downloadable/copyable report window for the log-entries store (see gsUtils.js's
  // log-buffer section for what writes here).
  LOG_ENTRIES_MAX: 10000,
  LOG_TRIM_ALARM_NAME: 'tms-log-trim',

  _db: null,

  getDb: async function() {
    if (!gsIndexedDb._db) {
      gsIndexedDb._db = await openDB(gsIndexedDb.DB_SERVER, gsIndexedDb.DB_VERSION, {
        // transaction (the versionchange transaction idb.js's own upgrade() wrapper
        // already passes as its 4th argument) is what lets an *existing* store pick up a
        // newly-added index below — db.createObjectStore() only works for a store being
        // created in this same upgrade pass; an already-existing store's own object
        // needs transaction.objectStore(name) instead. Without this, a store shipped
        // once without a given index (e.g. DB_LOG_ENTRIES's 'ts' index, added after that
        // store's own DB_VERSION bump) could never pick it up for anyone who'd already
        // opened that version, even after a later version bump added the index here.
        upgrade(db, oldVersion, newVersion, transaction) {
          const stores = [
            { name: gsIndexedDb.DB_PREVIEWS,          indexes: ['url'] },
            { name: gsIndexedDb.DB_SUSPENDED_TABINFO, indexes: ['url'] },
            { name: gsIndexedDb.DB_FAVICON_META,      indexes: ['url'] },
            { name: gsIndexedDb.DB_CURRENT_SESSIONS,  indexes: ['sessionId'] },
            { name: gsIndexedDb.DB_SAVED_SESSIONS,    indexes: ['sessionId'] },
            // ts: insertion order (the autoIncrement 'id') doesn't match chronological
            // order once multiple contexts flush independently — a throttled context can
            // persist an older-ts batch after another context has already persisted
            // newer entries. fetchLogEntries()/trimLogEntries() below order and trim by
            // this index instead of by 'id', so "most recent" and "oldest to evict"
            // both mean what they say regardless of which context wrote what when.
            { name: gsIndexedDb.DB_LOG_ENTRIES,       indexes: ['ts'] },
          ];
          for (const { name, indexes } of stores) {
            const store = db.objectStoreNames.contains(name)
              ? transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
            for (const idx of indexes) {
              if (!store.indexNames.contains(idx)) store.createIndex(idx, idx);
            }
          }
        },
      });
    }
    return gsIndexedDb._db;
  },

  fetchPreviewImage: async function(tabUrl) {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = await db.getAllFromIndex(gsIndexedDb.DB_PREVIEWS, 'url', tabUrl);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      return results[0];
    }
    return null;
  },

  addPreviewImage: async function(tabUrl, previewUrl) {
    try {
      const db = await gsIndexedDb.getDb();
      const existing = await db.getAllFromIndex(gsIndexedDb.DB_PREVIEWS, 'url', tabUrl);
      for (const item of existing) {
        await db.delete(gsIndexedDb.DB_PREVIEWS, item.id);
      }
      await db.add(gsIndexedDb.DB_PREVIEWS, { url: tabUrl, img: previewUrl });
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  addSuspendedTabInfo: async function(tabProperties) {
    try {
      if (!tabProperties.url) {
        gsUtils.error('gsIndexedDb', 'tabProperties.url not set.');
        return;
      }
      const db = await gsIndexedDb.getDb();
      const existing = await db.getAllFromIndex(gsIndexedDb.DB_SUSPENDED_TABINFO, 'url', tabProperties.url);
      for (const item of existing) {
        await db.delete(gsIndexedDb.DB_SUSPENDED_TABINFO, item.id);
      }
      await db.add(gsIndexedDb.DB_SUSPENDED_TABINFO, tabProperties);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  fetchTabInfo: async function(tabUrl) {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = (await db.getAllFromIndex(gsIndexedDb.DB_SUSPENDED_TABINFO, 'url', tabUrl)).reverse();
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      const tabInfo = results[0];
      if (tabInfo.favicon) {
        if (!tabInfo.favIconUrl) {
          tabInfo.favIconUrl = tabInfo.favicon;
        }
        delete tabInfo.favicon;
      }
      return tabInfo;
    }
    return null;
  },

  addFaviconMeta: async function(url, faviconMeta) {
    try {
      if (!url) {
        gsUtils.error('gsIndexedDb', 'url not set.');
        return;
      }
      const faviconMetaWithUrl = Object.assign(faviconMeta, { url });
      const db = await gsIndexedDb.getDb();
      const existing = await db.getAllFromIndex(gsIndexedDb.DB_FAVICON_META, 'url', url);
      for (const item of existing) {
        await db.delete(gsIndexedDb.DB_FAVICON_META, item.id);
      }
      await db.add(gsIndexedDb.DB_FAVICON_META, faviconMetaWithUrl);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  fetchFaviconMeta: async function(url) {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = (await db.getAllFromIndex(gsIndexedDb.DB_FAVICON_META, 'url', url)).reverse();
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      return results[0];
    }
    return null;
  },

  clearFaviconMeta: async function() {
    const db = await gsIndexedDb.getDb();
    await db.clear(gsIndexedDb.DB_FAVICON_META);
  },

  // Every context (every suspended tab included) writes its own logged entries directly
  // here — unlike the chrome.storage.local-backed buffer this replaced, which had to funnel
  // every write through the service worker as the sole writer of one shared JSON blob per
  // key. IndexedDB gives each entry its own record (this store's usual keyPath/autoIncrement
  // pattern) rather than one big read-modify-write blob, so concurrent writers from
  // different contexts never race each other the way two overlapping reads of the same
  // blob could. Critically, an IndexedDB write here also never reaches chrome.storage's own
  // onChanged listeners — those fire in *every* context with any listener registered
  // (e.g. suspended.js's, present in every suspended tab), delivering a full copy of
  // whatever changed regardless of whether that context's callback cares. A live crash
  // dump confirmed this was the actual OOM mechanism: dozens of near-duplicate multi-MB
  // JSON-stringified copies of the old chrome.storage.local-backed buffer, retained across
  // every one of dozens of suspended tabs sharing one renderer process, each one a side
  // effect of Chrome constructing that broadcast payload for a context that never asked
  // for it.
  // Deliberately does not catch-and-report like every other method in this file: a
  // failure logged via gsUtils.error() would itself append a new pending log entry and
  // immediately trigger another flush attempt (error() calls _flushNow() unconditionally)
  // — if the underlying failure persists (IndexedDB genuinely unavailable, a quota error),
  // that new entry fails to persist too, logs its own error, and triggers yet another
  // flush, a tight loop with no natural end. Letting this reject instead lets
  // gsUtils.js's own _flushNowCore() catch it, requeue the batch, and retry on its normal
  // 1.5s schedule, without ever routing the failure back through the pipe that just failed.
  // One readwrite transaction for the whole batch, not a sequential db.add() per entry:
  // if a later entry in a large batch fails (e.g. approaching a storage quota), the
  // per-entry version would still have already committed every earlier one in its own
  // separate transaction — the batch as a whole still reads as failed to the caller
  // (addLogEntries() rejects either way), which requeues the *entire* batch, so those
  // already-committed entries would get duplicated on retry, compounding whatever made
  // the batch fail in the first place instead of ever letting it succeed. One shared
  // transaction rolls every add() in this call back together on any single failure.
  addLogEntries: async function(entries) {
    if (!entries || entries.length === 0) return;
    const db = await gsIndexedDb.getDb();
    const tx = db.transaction(gsIndexedDb.DB_LOG_ENTRIES, 'readwrite');
    await Promise.all([
      ...entries.map((entry) => tx.store.add(entry)),
      tx.done,
    ]);
  },

  // Most-recent `limit` entries, oldest first — a cursor walking the 'ts' index backward
  // from the end, not getAll() + slice(), so this doesn't have to read the entire store
  // just to keep the live debug view's most recent window. Ordered by 'ts', not by
  // insertion order (the autoIncrement primary key): multiple contexts flush
  // independently, so a throttled context's older-ts batch can land (and get higher
  // primary keys) after another context's newer entries — walking by primary key order
  // would then show those stale entries as the "most recent" instead of what actually
  // happened last.
  fetchLogEntries: async function(limit) {
    const results = [];
    try {
      const db = await gsIndexedDb.getDb();
      const tx = db.transaction(gsIndexedDb.DB_LOG_ENTRIES, 'readonly');
      let cursor = await tx.store.index('ts').openCursor(null, 'prev');
      while (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor = await cursor.continue();
      }
      await tx.done;
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    return results.reverse();
  },

  // Cheap total count, e.g. for a UI counter that doesn't need the actual entries.
  countLogEntries: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      return await db.count(gsIndexedDb.DB_LOG_ENTRIES);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      return 0;
    }
  },

  // Every entry, oldest first by 'ts' (not insertion order — see fetchLogEntries() above
  // for why those can differ), for the downloadable/copyable report.
  fetchAllLogEntries: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      return await db.getAllFromIndex(gsIndexedDb.DB_LOG_ENTRIES, 'ts');
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      return [];
    }
  },

  // Same shape as trimDbItems() below for the other stores — deletes the oldest entries
  // once the store grows past maxCount, keeping only the most recent window. Oldest by
  // 'ts', not by primary key: getAllKeysFromIndex() returns primary keys ordered by the
  // *index's* key order, so this deletes what's actually chronologically oldest instead
  // of risking evicting a newer entry that simply landed with a lower autoIncrement id.
  trimLogEntries: async function(maxCount) {
    try {
      const db = await gsIndexedDb.getDb();
      const keys = await db.getAllKeysFromIndex(gsIndexedDb.DB_LOG_ENTRIES, 'ts');
      if (keys.length > maxCount) {
        for (const key of keys.slice(0, keys.length - maxCount)) {
          await db.delete(gsIndexedDb.DB_LOG_ENTRIES, key);
        }
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  // Called once from background.js's own init (the service worker, alarms only ever
  // fire there) rather than triggered from the log-flush path itself: every context
  // flushing to this store (every suspended tab included) has its own gsUtils.js module
  // instance, so a per-context throttle there still meant dozens of pages could each
  // independently decide "trim needed" on their own first flush after a restore burst,
  // producing dozens of concurrent 10,000-key scans and delete transactions — a real
  // CPU/IndexedDB-contention burst in the exact path meant to prevent one. A single
  // periodic alarm (idempotent create — a second call with the same name just replaces
  // the existing schedule, so calling this on every service worker start is safe)
  // decouples trimming entirely from how often, or from where, entries get logged.
  syncLogTrimAlarm: async function() {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    chrome.alarms.create(gsIndexedDb.LOG_TRIM_ALARM_NAME, { periodInMinutes: 5 });
  },

  // Returns whether the clear actually succeeded — debug.js's "Clear log" button checks
  // this via gsUtils.clearLogBuffer()'s own return value to show "clear failed" rather
  // than silently reporting success while every persisted record is still there.
  clearLogEntries: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      await db.clear(gsIndexedDb.DB_LOG_ENTRIES);
      return true;
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      return false;
    }
  },

  updateSession: async function(session) {
    try {
      const db = await gsIndexedDb.getDb();
      const tableName = session.sessionId.indexOf('_') === 0
        ? gsIndexedDb.DB_SAVED_SESSIONS
        : gsIndexedDb.DB_CURRENT_SESSIONS;

      const matchingSession = await gsIndexedDb.fetchSessionBySessionId(session.sessionId);
      if (matchingSession) {
        gsUtils.log('gsIndexedDb', 'Updating existing session: ' + session.sessionId);
        session.id   = matchingSession.id;
        session.date = new Date().toISOString();
        await db.put(tableName, session);
      } else {
        gsUtils.log('gsIndexedDb', 'Creating new session: ' + session.sessionId);
        await db.add(tableName, session);
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  fetchCurrentSessions: async function() {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = (await db.getAll(gsIndexedDb.DB_CURRENT_SESSIONS)).reverse();
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      results = [];
    }
    return results;
  },

  fetchSessionBySessionId: async function(sessionId) {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      const tableName = sessionId.indexOf('_') === 0
        ? gsIndexedDb.DB_SAVED_SESSIONS
        : gsIndexedDb.DB_CURRENT_SESSIONS;
      results = (await db.getAllFromIndex(tableName, 'sessionId', sessionId)).reverse();

      if (results.length > 1) {
        gsUtils.warning('gsIndexedDb', 'Duplicate sessions found for sessionId: ' + sessionId + '! Removing older ones..');
        for (const session of results.slice(1)) {
          await db.delete(tableName, session.id);
        }
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      return results[0];
    }
    return null;
  },

  createOrUpdateSessionRestorePoint: async function(session, version) {
    const existingSessionRestorePoint = await gsIndexedDb.fetchSessionRestorePoint(version);
    if (existingSessionRestorePoint) {
      existingSessionRestorePoint.windows = session.windows;
      await gsIndexedDb.updateSession(existingSessionRestorePoint);
      gsUtils.log('gsIndexedDb', 'Updated automatic session restore point');
    } else {
      session.name = gsUtils.getMessage('js_session_save_point') + version;
      session[gsIndexedDb.DB_SESSION_PRE_UPGRADE_KEY] = version;
      await gsIndexedDb.addToSavedSessions(session);
      gsUtils.log('gsIndexedDb', 'Created automatic session restore point');
    }
    const newSessionRestorePoint = await gsIndexedDb.fetchSessionRestorePoint(version);
    gsUtils.log('gsIndexedDb', 'New session restore point:', newSessionRestorePoint);
    return newSessionRestorePoint || null;
  },

  fetchSessionRestorePoint: async function(versionValue) {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      const all = await db.getAll(gsIndexedDb.DB_SAVED_SESSIONS);
      results = all.filter(r => r[gsIndexedDb.DB_SESSION_PRE_UPGRADE_KEY] === versionValue);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      return results[0];
    }
    return null;
  },

  fetchLastSession: async () => {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = (await db.getAll(gsIndexedDb.DB_CURRENT_SESSIONS)).reverse();
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
    if (results && results.length > 0) {
      const currentSessionId = await gsSession.getSessionId();
      return results.find(o => o.sessionId !== currentSessionId);
    }
    return null;
  },

  fetchSavedSessions: async function() {
    let results;
    try {
      const db = await gsIndexedDb.getDb();
      results = await db.getAll(gsIndexedDb.DB_SAVED_SESSIONS);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      results = [];
    }
    return results;
  },

  addToSavedSessions: async function(session) {
    if (session.sessionId.indexOf('_') < 0) {
      session.sessionId = '_' + gsUtils.generateHashCode(session.name);
    }
    delete session.id;
    await gsIndexedDb.updateSession(session);
  },

  // For testing only!
  clearGsDatabase: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      await db.clear(gsIndexedDb.DB_CURRENT_SESSIONS);
      await db.clear(gsIndexedDb.DB_SAVED_SESSIONS);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  removeTabFromSessionHistory: async function(sessionId, windowId, tabId) {
    const session = await gsIndexedDb.fetchSessionBySessionId(sessionId);
    if (!session) return null;
    session.windows.some(function(curWindow, windowIndex) {
      const matched = curWindow.tabs.some(function(curTab, tabIndex) {
        if (curTab.id == tabId || curTab.url == tabId) {
          curWindow.tabs.splice(tabIndex, 1);
          return true;
        }
      });
      if (matched) {
        if (curWindow.tabs.length === 0) {
          session.windows.splice(windowIndex, 1);
        }
        return true;
      }
    });

    if (session.windows.length > 0) {
      await gsIndexedDb.updateSession(session);
    } else {
      await gsIndexedDb.removeSessionFromHistory(sessionId);
    }
    return await gsIndexedDb.fetchSessionBySessionId(sessionId);
  },

  removeSessionFromHistory: async function(sessionId) {
    const tableName = sessionId.indexOf('_') === 0
      ? gsIndexedDb.DB_SAVED_SESSIONS
      : gsIndexedDb.DB_CURRENT_SESSIONS;

    try {
      const db = await gsIndexedDb.getDb();
      const results = await db.getAllFromIndex(tableName, 'sessionId', sessionId);
      if (results.length > 0) {
        await db.delete(tableName, results[0].id);
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  trimDbItems: async function() {
    const maxTabItems = 1000;
    const maxHistories = 5;

    try {
      const db = await gsIndexedDb.getDb();

      const tabInfoKeys = await db.getAllKeys(gsIndexedDb.DB_SUSPENDED_TABINFO);
      if (tabInfoKeys.length > maxTabItems) {
        for (const key of tabInfoKeys.slice(0, tabInfoKeys.length - maxTabItems)) {
          await db.delete(gsIndexedDb.DB_SUSPENDED_TABINFO, key);
        }
      }

      const faviconKeys = await db.getAllKeys(gsIndexedDb.DB_FAVICON_META);
      const maxFaviconItems = parseInt(maxTabItems + maxTabItems * 0.3);
      if (faviconKeys.length > maxFaviconItems) {
        for (const key of faviconKeys.slice(0, faviconKeys.length - maxFaviconItems)) {
          await db.delete(gsIndexedDb.DB_FAVICON_META, key);
        }
      }

      const previewKeys = await db.getAllKeys(gsIndexedDb.DB_PREVIEWS);
      if (previewKeys.length > maxTabItems) {
        for (const key of previewKeys.slice(0, previewKeys.length - maxTabItems)) {
          await db.delete(gsIndexedDb.DB_PREVIEWS, key);
        }
      }

      const sessionKeys = await db.getAllKeys(gsIndexedDb.DB_CURRENT_SESSIONS);
      if (sessionKeys.length > maxHistories) {
        for (const key of sessionKeys.slice(0, sessionKeys.length - maxHistories)) {
          await db.delete(gsIndexedDb.DB_CURRENT_SESSIONS, key);
        }
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  /**
   * MIGRATIONS
   */

  performMigration: async function(oldVersion) {
    try {
      // 2025: v8.1.0: Migration if-blocks have been removed, but preserved here as examples if needed in the future
    }
    catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },
};
