import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gsUtils.withTimeout (#544)', () => {
  it('settles with the promise when it settles first', async () => {
    const onTimeout = vi.fn();
    const result = gsUtils.withTimeout(Promise.resolve('value'), 1000, onTimeout);
    await expect(result).resolves.toBe('value');
    await vi.runAllTimersAsync();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes on a rejection that comes first', async () => {
    const result = gsUtils.withTimeout(Promise.reject(new Error('boom')), 1000, vi.fn());
    await expect(result).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves with what onTimeout returns when the timer fires first', async () => {
    const result = gsUtils.withTimeout(new Promise(() => {}), 1000, () => 'fallback');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('fallback');
  });

  it('rejects with what onTimeout throws', async () => {
    const result = gsUtils.withTimeout(new Promise(() => {}), 1000, () => { throw new Error('timed out'); });
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('does not report a rejection of the raced promise after the timeout as unhandled', async () => {
    // Node reports unhandled rejections on a real macrotask, so this one runs on real timers.
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate;
      const late = new Promise((resolve, reject) => { rejectLate = reject; });
      await expect(gsUtils.withTimeout(late, 5, () => 'fallback')).resolves.toBe('fallback');
      rejectLate(new Error('late'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    }
    finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects with a rejected promise onTimeout returns', async () => {
    const sentinel = Symbol('timed out');
    const result = gsUtils.withTimeout(new Promise(() => {}), 1000, () => Promise.reject(sentinel));
    const assertion = expect(result).rejects.toBe(sentinel);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('fires at once for a deadline already past', async () => {
    const result = gsUtils.withTimeout(new Promise(() => {}), -50, () => 'late');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('late');
  });
});
