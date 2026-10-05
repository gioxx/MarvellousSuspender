import { vi } from 'vitest';
import { EXTENSION_ID } from './chrome-stub.js';

// Shared ground of the gsTabSuspendManager characterisation files that drive the real
// queue: the chrome.* fakes the suspension flow calls, and the helpers that observe it.
//
// chrome-stub.js stays the stand-in for what the modules touch at load time. The calls
// below are made by the flow once a job runs, and what they answer is decided per case,
// so they are installed on the fresh stub by the file's beforeEach, through
// installSuspensionFakes(), and overridden by the case that needs another answer.

export const NORMAL_URL = 'https://example.com/page';
export const QUEUE_CHECK_INTERVAL = 50;
export const JOB_TIMEOUT = 60 * 1000;
export const CANCELLED = 'Queued tab job cancelled externally';

// What gsUtils.generateSuspendedUrl() builds for a tab.
export function suspendedUrlOf(url, title, scrollPos) {
  return `chrome-extension://${EXTENSION_ID}/suspended.html#ttl=${title}&pos=${scrollPos}&uri=${url}`;
}

// Fakes the timers the flow sets and the clock it reads, and leaves setImmediate real:
// flush() below needs it to run once every pending microtask has drained.
export function installFakeTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

export function makeTab(overrides = {}) {
  return {
    id: 5,
    windowId: 1,
    index: 3,
    url: NORMAL_URL,
    title: 'Example',
    favIconUrl: 'https://example.com/favicon.ico',
    status: 'complete',
    active: false,
    pinned: false,
    audible: false,
    groupId: -1,
    ...overrides,
  };
}

// Installs, on globalThis.chrome, the calls the flow makes, in the callback or promise
// form the source uses, each answering what a healthy browser would.
export function installSuspensionFakes() {
  chrome.tabGroups.get = vi.fn((groupId, callback) => callback({ id: groupId, color: 'blue', title: 'Work' }));
  chrome.windows.get = vi.fn(async () => ({ id: 1, type: 'normal' }));
  chrome.alarms.clear = vi.fn(async () => true);
  chrome.tabs.get = vi.fn((tabId, callback) => callback(makeTab({ id: tabId })));
  chrome.tabs.update = vi.fn((tabId, props, callback) => callback({ id: tabId, ...props }));
  // gsMessages calls sendMessage with four arguments, and with three when the first call
  // throws: the callback is the last argument either way.
  chrome.tabs.sendMessage = vi.fn((...args) => args.at(-1)({ status: 'normal', scrollPos: '0' }));
  // An injection succeeds and the page says nothing: a preview response is a call to
  // handlePreviewImageResponse() made by the case.
  chrome.scripting = { executeScript: vi.fn((injection, callback) => callback([{ result: undefined }])) };
}

// Runs once every pending microtask has drained; see installFakeTimers().
export const flush = () => new Promise((resolve) => setImmediate(resolve));

// Records how a promise settles without leaving a rejection unhandled.
export function track(promise) {
  const outcome = { state: 'pending', value: undefined };
  promise.then(
    (value) => { outcome.state = 'resolved'; outcome.value = value; },
    (error) => { outcome.state = 'rejected'; outcome.value = error; },
  );
  return outcome;
}

export function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

export async function advance(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

// By the name of the constant in gsStorage. A name that is not one fails the case: a
// setting written under `undefined` would leave the default in place and prove nothing.
export async function setOptions(gsStorage, options) {
  for (const [key, value] of Object.entries(options)) {
    if (typeof gsStorage[key] !== 'string') throw new Error(`gsStorage has no option named ${key}`);
    await gsStorage.setOption(gsStorage[key], value);
  }
}

// Queues the tab and lets the queue hand it to the executor.
export async function queueAndRun(manager, tab, forceLevel) {
  const outcome = track(manager.queueTabForSuspensionAsPromise(tab, forceLevel));
  await flush();
  await advance(QUEUE_CHECK_INTERVAL);
  return outcome;
}

// chrome reports a failed call through chrome.runtime.lastError, readable only while the
// callback runs.
export function withLastError(message, run) {
  chrome.runtime.lastError = { message };
  try {
    run();
  }
  finally {
    chrome.runtime.lastError = undefined;
  }
}
