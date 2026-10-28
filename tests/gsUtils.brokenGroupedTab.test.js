import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';

// Tab Health must not flag healthy grouped tabs that the browser merely unloaded (#551).

const suspended = gsUtils.generateSuspendedUrl('https://example.com/', 'Example', 0);
const tab = (extra = {}) => ({ groupId: 7, discarded: true, url: suspended, ...extra });

describe('gsUtils.isBrokenGroupedDiscardedTab', () => {
  it('flags a grouped, discarded, suspended tab before Chrome 150', () => {
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab(), 149)).toBe(true);
  });

  it('does not flag it on Chrome 150+, where the browser bug is fixed', () => {
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab(), 150)).toBe(false);
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab(), 152)).toBe(false);
  });

  it('keeps the check on when the version is unknown', () => {
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab(), false)).toBe(true);
  });

  it('ignores ungrouped, non-discarded or non-suspended tabs', () => {
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab({ groupId: -1 }), 149)).toBe(false);
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab({ discarded: false }), 149)).toBe(false);
    expect(gsUtils.isBrokenGroupedDiscardedTab(tab({ url: 'https://example.com/' }), 149)).toBe(false);
  });
});

describe('gsUtils.findSavedSuspendedUrls', () => {
  const newtab   = (id, windowId, index) => ({ id, windowId, index, groupId: 7, url: 'chrome://newtab/' });
  const sessions = [
    { sessionId: 'current', windows: [{ id: 1, tabs: [{ index: 1, url: suspended }] }] },
    { sessionId: 'old',     windows: [
      { id: 50, tabs: [{ index: 0, url: 'https://example.com/' }] },
      { id: 40, tabs: [{ index: 1, url: suspended }] },
    ] },
  ];

  it('matches a New Tab page at a position that held a suspended tab in a saved session', () => {
    const urls = gsUtils.findSavedSuspendedUrls([newtab(10, 3, 1)], [3, 8], sessions, 'current');
    expect([...urls]).toEqual([[10, suspended]]);
  });

  it('skips real New Tab pages: wrong index, wrong window rank, unsuspended or current-session tab', () => {
    const tabs = [newtab(11, 3, 2), newtab(12, 8, 1), newtab(13, 8, 0), newtab(14, 99, 1)];
    expect(gsUtils.findSavedSuspendedUrls(tabs, [3, 8], sessions, 'current').size).toBe(0);
    expect(gsUtils.findSavedSuspendedUrls([newtab(10, 3, 1)], [3], sessions.slice(0, 1), 'current').size).toBe(0);
  });
});
