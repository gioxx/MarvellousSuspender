import { describe, it, expect } from 'vitest';
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
