// @ts-check

// A promise-chain mutex. Each call's fn starts once every earlier call's has settled, resolved
// or not, and the caller gets fn's own result. Per context, like all module state: a page and
// the service worker each hold their own chain. Not reentrant: fn awaiting its own lock waits
// for itself, forever.
//
// No imports on purpose. gsStorage.js and tgs.js create their locks while their modules are
// still evaluating, and both sit in import cycles with gsUtils.js, which every entry point
// evaluates after them, so a helper on the gsUtils object would not exist yet at that point.
export function createAsyncLock() {
  let chain = Promise.resolve();
  return function withLock(fn) {
    const result = chain.then(fn, fn);
    chain = result.then(() => {}, () => {});
    return result;
  };
}
