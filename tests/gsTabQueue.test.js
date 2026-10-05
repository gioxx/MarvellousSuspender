import { describe, it, expect, vi, afterEach } from 'vitest';
import { gsTabQueue } from '../src/js/gsTabQueue.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// Short timings so the suite stays fast; the queue adds a 50ms check interval on top.
function makeQueue(overrides = {}) {
  return gsTabQueue.init('testQueue', {
    concurrentExecutors: 1,
    jobTimeout: 200,
    processingDelay: 0,
    executorFn: (tab, props, resolve) => resolve(`done:${tab.id}`),
    exceptionFn: (tab, props, exceptionType, resolve) => resolve(`exception:${exceptionType}`),
    ...overrides,
  });
}

describe('gsTabQueue', () => {
  it('resolves the queued promise with the value the executor resolves', async () => {
    const queue = makeQueue();
    await expect(queue.queueTabAsPromise({ id: 1 })).resolves.toBe('done:1');
    expect(queue.getTotalQueueSize()).toBe(0);
  });

  it('runs at most concurrentExecutors jobs at once', async () => {
    let running = 0;
    let peak = 0;
    const queue = makeQueue({
      concurrentExecutors: 2,
      executorFn: async (tab, props, resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(30);
        running -= 1;
        resolve(true);
      },
    });
    await Promise.all([1, 2, 3, 4, 5].map((id) => queue.queueTabAsPromise({ id })));
    expect(peak).toBe(2);
  });

  it('routes a job that never settles to exceptionFn with EXCEPTION_TIMEOUT', async () => {
    const queue = makeQueue({ executorFn: () => { /* never resolves */ } });
    await expect(queue.queueTabAsPromise({ id: 7 })).resolves.toBe(`exception:${queue.EXCEPTION_TIMEOUT}`);
  });

  it('routes an executor that throws to exceptionFn instead of rejecting the caller', async () => {
    const queue = makeQueue({ executorFn: () => { throw new Error('boom'); } });
    const result = await queue.queueTabAsPromise({ id: 8 });
    expect(result).toMatch(/^exception:/);
  });

  it('rejects the caller when the tab is unqueued externally', async () => {
    const queue = makeQueue({ executorFn: () => { /* never resolves */ } });
    const promise = queue.queueTabAsPromise({ id: 9 });
    expect(queue.unqueueTab({ id: 9 })).toBe(true);
    await expect(promise).rejects.toBe('Queued tab job cancelled externally');
    expect(queue.getTotalQueueSize()).toBe(0);
  });

  it('returns false when unqueueing a tab that is not queued', () => {
    const queue = makeQueue();
    expect(queue.unqueueTab({ id: 404 })).toBe(false);
  });

  it('merges a second call for an already queued tab into the same job', async () => {
    let executions = 0;
    const queue = makeQueue({
      executorFn: async (tab, props, resolve) => {
        executions += 1;
        await tick(20);
        resolve(props.marker);
      },
    });
    const first = queue.queueTabAsPromise({ id: 10 }, { marker: 'a' }, 100);
    const second = queue.queueTabAsPromise({ id: 10 }, { marker: 'b' });
    expect(first).toBe(second);
    await expect(first).resolves.toBe('b');
    expect(executions).toBe(1);
  });

  it('runs a call arriving mid-execution as a fresh follow-up job afterwards', async () => {
    const seen = [];
    const queue = makeQueue({
      executorFn: async (tab, props, resolve) => {
        seen.push(props.marker);
        await tick(40);
        resolve(props.marker);
      },
    });
    const first = queue.queueTabAsPromise({ id: 11 }, { marker: 'first' });
    await tick(60); // past the 50ms check interval: the first job is now in progress
    const followUp = queue.queueTabAsPromise({ id: 11 }, { marker: 'second' });
    expect(followUp).not.toBe(first);
    await expect(first).resolves.toBe('first');
    await expect(followUp).resolves.toBe('second');
    expect(seen).toEqual(['first', 'second']);
  });

  it('promotes a follow-up when only the current job is unqueued', async () => {
    const queue = makeQueue({
      executorFn: (tab, props, resolve) => {
        if (props.marker === 'stalled') return; // never settles on its own
        resolve(props.marker);
      },
    });
    const stalled = queue.queueTabAsPromise({ id: 12 }, { marker: 'stalled' });
    await tick(60);
    const followUp = queue.queueTabAsPromise({ id: 12 }, { marker: 'focus' });
    expect(queue.unqueueTab({ id: 12 }, { keepFollowUp: true })).toBe(true);
    await expect(stalled).rejects.toBe('Queued tab job cancelled externally');
    await expect(followUp).resolves.toBe('focus');
  });

  it('re-runs the executor after a requeue and resolves with the final result', async () => {
    let attempts = 0;
    const queue = makeQueue({
      executorFn: (tab, props, resolve, reject, requeue) => {
        attempts += 1;
        if (attempts < 3) {
          requeue(10);
          return;
        }
        resolve(`after ${attempts} attempts`);
      },
    });
    await expect(queue.queueTabAsPromise({ id: 12 })).resolves.toBe('after 3 attempts');
  });

  it('rejects a non-function executorFn at construction', () => {
    expect(() => makeQueue({ executorFn: 'nope' })).toThrow(/executorFn/);
  });
});

describe('gsTabQueue property validation', () => {
  it.each([
    ['concurrentExecutors', 0],
    ['concurrentExecutors', -1],
    ['concurrentExecutors', 1.5],
    ['concurrentExecutors', '3'],
    ['concurrentExecutors', null],
    ['concurrentExecutors', undefined],
    ['concurrentExecutors', NaN],
    ['concurrentExecutors', Infinity],
    ['jobTimeout', 0],
    ['jobTimeout', -200],
    ['jobTimeout', 0.5],
    ['jobTimeout', '200'],
    ['jobTimeout', null],
    ['processingDelay', -1],
    ['processingDelay', 0.5],
    ['processingDelay', '0'],
    ['processingDelay', null],
  ])('rejects %s = %s at construction', (prop, value) => {
    expect(() => makeQueue({ [prop]: value })).toThrow(new RegExp(prop));
  });

  it.each([
    ['concurrentExecutors', 1],
    ['concurrentExecutors', 5],
    ['jobTimeout', 1],
    ['jobTimeout', 5 * 60 * 1000],
    ['processingDelay', 0],
    ['processingDelay', 500],
  ])('accepts %s = %s', (prop, value) => {
    const queue = makeQueue({ [prop]: value });
    expect(queue.getQueueProperties()[prop]).toBe(value);
  });

  it('keeps the previous properties when an update is rejected', () => {
    const queue = makeQueue({ concurrentExecutors: 3, jobTimeout: 200 });
    expect(() => queue.setQueueProperties({ jobTimeout: 900, concurrentExecutors: 0 })).toThrow(/concurrentExecutors/);
    expect(queue.getQueueProperties().concurrentExecutors).toBe(3);
    expect(queue.getQueueProperties().jobTimeout).toBe(200);
  });

  it('still runs jobs after a rejected update', async () => {
    const queue = makeQueue();
    expect(() => queue.setQueueProperties({ concurrentExecutors: 0 })).toThrow();
    await expect(queue.queueTabAsPromise({ id: 31 })).resolves.toBe('done:31');
  });

  it('names exceptionFn when exceptionFn is not a function', () => {
    expect(() => makeQueue({ exceptionFn: 'nope' })).toThrow(/exceptionFn/);
  });

  it('hands out a copy of the properties, not the live object', () => {
    const queue = makeQueue({ concurrentExecutors: 2 });
    queue.getQueueProperties().concurrentExecutors = 0;
    expect(queue.getQueueProperties().concurrentExecutors).toBe(2);
  });
});

describe('gsTabQueue delays', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Settles to the resolved value, or to 'pending' when the promise has not settled yet.
  const stateOf = (promise) => Promise.race([promise, Promise.resolve('pending')]);

  it('sleeps the job for a valid delay', async () => {
    vi.useFakeTimers();
    const job = makeQueue().queueTabAsPromise({ id: 40 }, {}, 1000);
    await vi.advanceTimersByTimeAsync(900);
    expect(await stateOf(job)).toBe('pending');
    await vi.advanceTimersByTimeAsync(300);
    expect(await stateOf(job)).toBe('done:40');
  });

  it.each([1000.5, '1000', -1000, NaN, Infinity])('runs the job right away when the delay is %s', async (delay) => {
    vi.useFakeTimers();
    const job = makeQueue().queueTabAsPromise({ id: 41 }, {}, delay);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stateOf(job)).toBe('done:41');
  });

  it.each([0.5, '400', -100])('falls back to the default requeue delay when an executor asks for %s', async (requeueDelay) => {
    vi.useFakeTimers();
    let attempts = 0;
    const queue = makeQueue({
      jobTimeout: 60 * 1000,
      executorFn: (tab, props, resolve, reject, requeue) => {
        attempts += 1;
        if (attempts === 1) requeue(requeueDelay);
        else resolve(`attempt:${attempts}`);
      },
    });
    const job = queue.queueTabAsPromise({ id: 42 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(1);
    expect(await stateOf(job)).toBe('pending');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await stateOf(job)).toBe('attempt:2');
  });

  it('honours a valid requeue delay', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const queue = makeQueue({
      jobTimeout: 60 * 1000,
      executorFn: (tab, props, resolve, reject, requeue) => {
        attempts += 1;
        if (attempts === 1) requeue(300);
        else resolve(`attempt:${attempts}`);
      },
    });
    const job = queue.queueTabAsPromise({ id: 43 });
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(await stateOf(job)).toBe('attempt:2');
  });
});
