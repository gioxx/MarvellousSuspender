import { beforeEach, describe, expect, it } from 'vitest';
import { gsStorage } from '../src/js/gsStorage.js';

// The startup tab-check concurrency is user-tunable (#548), but never unbounded:
// raising it too far brings back the startup overload of #523.
describe('startup tab-check concurrency setting (#548)', () => {
  beforeEach(async () => {
    // saveSettings() drops the in-memory settings cache; then nothing is stored at all.
    await gsStorage.saveSettings({});
    await chrome.storage.local.clear();
  });

  it('defaults to 3, the value the #523 fix settled on, within 1..8', () => {
    expect(gsStorage.STARTUP_TAB_CHECKS_DEFAULT).toBe(3);
    expect(gsStorage.STARTUP_TAB_CHECKS_MIN).toBe(1);
    expect(gsStorage.STARTUP_TAB_CHECKS_MAX).toBe(8);
    expect(gsStorage.getSettingsDefaults()[gsStorage.STARTUP_TAB_CHECKS]).toBe(3);
  });

  it('reads the default when nothing is stored', async () => {
    expect(await gsStorage.getStartupTabChecks()).toBe(3);
  });

  it('reads the default for an existing install whose settings predate the key', async () => {
    await gsStorage.saveSettings({ [gsStorage.SUSPEND_TIME]: '60' });
    expect(await gsStorage.getStartupTabChecks()).toBe(3);
  });

  it.each([1, 2, 3, 5, 8])('reads the in-range value %s as stored', async (value) => {
    await gsStorage.saveSettings({ [gsStorage.STARTUP_TAB_CHECKS]: value });
    expect(await gsStorage.getStartupTabChecks()).toBe(value);
  });

  it.each([
    [0, 1],
    [-4, 1],
    [9, 8],
    [1000, 8],
    [Number.MAX_SAFE_INTEGER, 8],
  ])('clamps the out-of-range value %s to %s', async (value, expected) => {
    await gsStorage.saveSettings({ [gsStorage.STARTUP_TAB_CHECKS]: value });
    expect(await gsStorage.getStartupTabChecks()).toBe(expected);
  });

  it.each([
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['text', 'many'],
    ['an empty string', ''],
    ['a fractional string', '2.5'],
    ['an object', { value: 5 }],
  ])('falls back to the default for %s', async (_label, value) => {
    await gsStorage.saveSettings({ [gsStorage.STARTUP_TAB_CHECKS]: value });
    expect(await gsStorage.getStartupTabChecks()).toBe(3);
  });

  it('accepts an integer string, as the options page input yields one', async () => {
    await gsStorage.saveSettings({ [gsStorage.STARTUP_TAB_CHECKS]: ' 6 ' });
    expect(await gsStorage.getStartupTabChecks()).toBe(6);
    expect(gsStorage.normalizeStartupTabChecks('12')).toBe(8);
  });

  it('normalizes the same way without storage, for the options page', () => {
    expect(gsStorage.normalizeStartupTabChecks(undefined)).toBe(3);
    expect(gsStorage.normalizeStartupTabChecks(null)).toBe(3);
    expect(gsStorage.normalizeStartupTabChecks(4)).toBe(4);
    expect(gsStorage.normalizeStartupTabChecks(0)).toBe(1);
    expect(gsStorage.normalizeStartupTabChecks(99)).toBe(8);
  });
});
