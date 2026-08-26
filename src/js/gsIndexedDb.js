import { openDB }    from './idb.js';
import { gsSession } from './gsSession.js';
import { gsUtils }   from './gsUtils.js';

'use strict';

export const gsIndexedDb = {
  DB_SERVER:   'tgs',
  DB_VERSION:  4,
  DB_PREVIEWS:             'gsPreviews',
  DB_SUSPENDED_TABINFO:    'gsSuspendedTabInfo',
  DB_FAVICON_META:         'gsFaviconMeta',
  DB_CURRENT_SESSIONS:     'gsCurrentSessions',
  DB_SAVED_SESSIONS:       'gsSavedSessions',
  DB_LOG_ENTRIES:          'gsLogEntries',
  DB_SESSION_PRE_UPGRADE_KEY: 'preUpgradeVersion',

  _db: null,

  getDb: async function() {
    if (!gsIndexedDb._db) {
      gsIndexedDb._db = await openDB(gsIndexedDb.DB_SERVER, gsIndexedDb.DB_VERSION, {
        upgrade(db) {
          const stores = [
            { name: gsIndexedDb.DB_PREVIEWS,          indexes: ['url'] },
            { name: gsIndexedDb.DB_SUSPENDED_TABINFO, indexes: ['url'] },
            { name: gsIndexedDb.DB_FAVICON_META,      indexes: ['url'] },
            { name: gsIndexedDb.DB_CURRENT_SESSIONS,  indexes: ['sessionId'] },
            { name: gsIndexedDb.DB_SAVED_SESSIONS,    indexes: ['sessionId'] },
            { name: gsIndexedDb.DB_LOG_ENTRIES,       indexes: [] },
          ];
          for (const { name, indexes } of stores) {
            if (!db.objectStoreNames.contains(name)) {
              const store = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
              for (const idx of indexes) store.createIndex(idx, idx);
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
  addLogEntries: async function(entries) {
    if (!entries || entries.length === 0) return;
    try {
      const db = await gsIndexedDb.getDb();
      for (const entry of entries) {
        await db.add(gsIndexedDb.DB_LOG_ENTRIES, entry);
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  // Most-recent `limit` entries, oldest first — a cursor walking backward from the end
  // (autoIncrement ids are inserted in chronological order) rather than getAll() + slice(),
  // so this doesn't have to read the entire store just to keep the live debug view's most
  // recent window.
  fetchLogEntries: async function(limit) {
    const results = [];
    try {
      const db = await gsIndexedDb.getDb();
      const tx = db.transaction(gsIndexedDb.DB_LOG_ENTRIES, 'readonly');
      let cursor = await tx.store.openCursor(null, 'prev');
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

  // Every entry, oldest first (insertion order), for the downloadable/copyable report.
  fetchAllLogEntries: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      return await db.getAll(gsIndexedDb.DB_LOG_ENTRIES);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
      return [];
    }
  },

  // Same shape as trimDbItems() below for the other stores — deletes the oldest entries
  // once the store grows past maxCount, keeping only the most recent window.
  trimLogEntries: async function(maxCount) {
    try {
      const db = await gsIndexedDb.getDb();
      const keys = await db.getAllKeys(gsIndexedDb.DB_LOG_ENTRIES);
      if (keys.length > maxCount) {
        for (const key of keys.slice(0, keys.length - maxCount)) {
          await db.delete(gsIndexedDb.DB_LOG_ENTRIES, key);
        }
      }
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
    }
  },

  clearLogEntries: async function() {
    try {
      const db = await gsIndexedDb.getDb();
      await db.clear(gsIndexedDb.DB_LOG_ENTRIES);
    } catch (e) {
      gsUtils.error('gsIndexedDb', e);
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
