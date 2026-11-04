import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { gsChrome } from '../src/js/gsChrome.js';
import { gsTabSuspendManager } from '../src/js/gsTabSuspendManager.js';
import { gsUtils } from '../src/js/gsUtils.js';

// What another installed extension can ask through chrome.runtime.onMessageExternal.
// A suspend request is queued at the force level that keeps the user's protections
// (whitelist, pinned, audible, active, protected groups, unsaved form input): level 1
// would skip them all.

beforeAll(async () => {
  // background.js checks for a service worker scope at load; Node has none.
  globalThis.self ??= globalThis;
  globalThis.ServiceWorkerGlobalScope ??= function ServiceWorkerGlobalScope() {};
  // What background.js and its startup chain reach for at load, beyond the shared stub.
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  chrome.runtime.onSuspend = event();
  chrome.runtime.onSuspendCanceled = event();
  chrome.tabGroups.onCreated = event();
  chrome.alarms.get = async () => undefined;
  chrome.alarms.getAll = async () => [];
  chrome.alarms.create = async () => {};
  chrome.alarms.clear = async () => true;
  chrome.tabs.query = async () => [];
  chrome.windows.getLastFocused = async () => undefined;
  globalThis.addEventListener ??= () => {};
  chrome.action = { setIcon: (details, cb) => cb?.(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} };
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'error').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  await import('../src/js/background.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function askFromAnotherExtension(request) {
  const sendResponse = vi.fn();
  chrome.runtime.onMessageExternal._fire(request, { id: 'another-extension-id' }, sendResponse);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse;
}

describe('suspend requests from other extensions', () => {
  it('queue the tab at the force level that applies the user\'s protections', async () => {
    const tab = { id: 7, windowId: 1, url: 'https://example.com/', pinned: true, active: false, status: 'complete' };
    vi.spyOn(gsChrome, 'tabsGet').mockResolvedValue(tab);
    const queue = vi.spyOn(gsTabSuspendManager, 'queueTabForSuspension').mockImplementation(() => {});

    const sendResponse = await askFromAnotherExtension({ action: 'suspend', tabId: 7 });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith(tab, 2);
    expect(sendResponse).toHaveBeenCalledWith();
  });
});
