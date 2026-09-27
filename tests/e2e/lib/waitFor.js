// Polls until check() returns something truthy and resolves with it. A check that throws
// counts as "not yet": pages navigate, and their contexts come and go, while they are
// being asked. When the time runs out, rejects with what was being waited for and the
// last thing seen, value or error.
export async function waitFor(what, check, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = { value: await check() };
      if (last.value) return last.value;
    }
    catch (error) {
      last = { error };
    }
    if (Date.now() >= deadline) {
      const seen = last.error ? `last error: ${last.error.message}` : `last value: ${JSON.stringify(last.value)}`;
      throw new Error(`Timed out after ${timeout}ms waiting for ${what} (${seen})`, { cause: last.error });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
