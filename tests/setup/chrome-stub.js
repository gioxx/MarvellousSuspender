// Minimal, explicit stand-in for the `chrome.*` extension API so the ES modules under
// src/js can be imported in Node. It deliberately implements only what the modules touch
// at load time plus the small set of calls the unit tests exercise. Anything else is left
// undefined on purpose: a test that reaches an unstubbed API should fail loudly rather than
// pass against a silent no-op.

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    hasListeners: () => listeners.length > 0,
    // Test helper, not part of the real API.
    _fire: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

function storageArea() {
  let data = {};
  return {
    get: async (keys) => {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      }
      // object form: defaults
      return Object.fromEntries(Object.keys(keys).map((k) => [k, k in data ? data[k] : keys[k]]));
    },
    set: async (items) => { Object.assign(data, items); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
    clear: async () => { data = {}; },
    // Test helper, not part of the real API.
    _reset: () => { data = {}; },
  };
}

export function createChromeStub() {
  return {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ name: 'The Marvellous Suspender', version: '0.0.0-test' }),
      onMessage: event(),
      onMessageExternal: event(),
      onInstalled: event(),
      onStartup: event(),
      lastError: undefined,
    },
    extension: {
      inIncognitoContext: false,
      isAllowedFileSchemeAccess: (cb) => cb(false),
    },
    storage: {
      local: storageArea(),
      session: storageArea(),
      sync: storageArea(),
      onChanged: event(),
    },
    permissions: {
      contains: async () => false,
      onAdded: event(),
      onRemoved: event(),
    },
    i18n: {
      getMessage: (key) => key,
      getUILanguage: () => 'en',
    },
    tabs: {
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
      onReplaced: event(),
      onAttached: event(),
      onDetached: event(),
    },
    windows: {
      onFocusChanged: event(),
      onCreated: event(),
      onRemoved: event(),
    },
    alarms: {
      onAlarm: event(),
    },
    commands: {
      onCommand: event(),
    },
    contextMenus: {
      onClicked: event(),
    },
    tabGroups: {
      onUpdated: event(),
      onRemoved: event(),
    },
  };
}

globalThis.chrome = createChromeStub();
