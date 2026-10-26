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
