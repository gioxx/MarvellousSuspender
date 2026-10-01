import { waitFor } from './waitFor.js';

// A small Chrome DevTools Protocol client over Node's own WebSocket and fetch: one
// connection to the browser, flat sessions for the targets it attaches to.
export async function connect(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the browser')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const thrown = [];

  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id === undefined) {
      // the one event anything here reads; the rest is not kept
      if (message.method === 'Runtime.exceptionThrown') thrown.push(message);
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error(`${call.method}: connection closed`));
    pending.clear();
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`${method}: the connection to the browser is closed`));
      return;
    }
    const id = ++nextId;
    pending.set(id, { method, resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const targets = async () => (await send('Target.getTargets')).targetInfos;

  const attach = async (targetId) => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    return sessionId;
  };

  const detach = (sessionId) => send('Target.detachFromTarget', { sessionId }).catch(() => {});

  // Evaluates in the target and returns the value; a promise is awaited.
  const evaluate = async (sessionId, expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  const urlOf = async (targetId) => (await targets()).find((target) => target.targetId === targetId)?.url;

  const waitForUrl = (targetId, what, matches, options) => waitFor(
    `${what} (target ${targetId})`,
    async () => {
      const url = await urlOf(targetId);
      return url !== undefined && matches(url) ? url : undefined;
    },
    options,
  );

  const openTab = async (url, options = {}) => {
    const { targetId } = await send('Target.createTarget', { url, ...options });
    const sessionId = await attach(targetId);
    await send('Page.enable', {}, sessionId);
    return { targetId, sessionId };
  };

  const closeTab = (tab) => send('Target.closeTarget', { targetId: tab.targetId });

  const activate = (tab) => send('Target.activateTarget', { targetId: tab.targetId });

  // A real click, through the browser's input pipeline, on the middle of the element.
  const click = async (sessionId, selector) => {
    const box = await waitFor(`${selector} to be on the page`, () => evaluate(sessionId, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
    }
  };

  // Every uncaught exception seen in an attached target, with where it was thrown.
  const exceptions = () => thrown
    .map(({ params: { exceptionDetails: details } }) => {
      const what = details.exception?.description ?? details.exception?.value ?? details.text;
      const frame = details.stackTrace?.callFrames[0];
      const where = frame ? `${frame.url}:${frame.lineNumber + 1}` : `${details.url ?? 'unknown'}:${details.lineNumber + 1}`;
      return `${details.text} ${JSON.stringify(what)} at ${where}`;
    });

  const close = () => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.addEventListener('close', resolve, { once: true });
    socket.close();
  });

  return {
    browser: version.Browser,
    send, targets, attach, detach, evaluate, urlOf, waitForUrl, openTab, closeTab, activate, click, exceptions, close,
  };
}
