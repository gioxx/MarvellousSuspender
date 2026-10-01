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
    // Read before advancing: a stale timer left armed would still be counted here.
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(onTimeout).not.toHaveBeenCalled();
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

  it('keeps the timeout decided while a promise returned by onTimeout is pending', async () => {
    const operation = new Promise((resolve) => setTimeout(() => resolve('operation'), 5));
    const fallback = new Promise((resolve) => setTimeout(() => resolve('fallback'), 20));
    const result = gsUtils.withTimeout(operation, 0, () => fallback);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe('fallback');
  });

  it('settles a non-thenable input without arming a stray timer', async () => {
    const onTimeout = vi.fn();
    await expect(gsUtils.withTimeout('plain', 1000, onTimeout)).resolves.toBe('plain');
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('caps a delay above the setTimeout range instead of firing at once', async () => {
    const onTimeout = vi.fn(() => 'late');
    const result = gsUtils.withTimeout(new Promise(() => {}), Infinity, onTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 ** 31);
    await expect(result).resolves.toBe('late');
  });

  it('rejects a NaN delay', async () => {
    const onTimeout = vi.fn();
    await expect(gsUtils.withTimeout(new Promise(() => {}), NaN, onTimeout)).rejects.toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fires at once for a deadline already past', async () => {
    const result = gsUtils.withTimeout(new Promise(() => {}), -50, () => 'late');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('late');
  });
});
