import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './waitFor.js';

const BINARIES = [
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome',
  'chrome.exe',
];

// Where Puppeteer and Playwright keep the Chrome for Testing builds they download.
const CACHES = [
  join(homedir(), '.cache', 'puppeteer', 'chrome'),
  join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  join(homedir(), '.cache', 'ms-playwright'),
];

// [154, 0, 8037, 57] for "Google Chrome for Testing 154.0.8037.57", [] when it will not say.
function versionOf(executable) {
  try {
    const output = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return (/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(output) ?? []).slice(1).map(Number);
  }
  catch {
    return [];
  }
}

function newerFirst(a, b) {
  for (let i = 0; i < 4; i++) {
    const difference = (b.version[i] ?? -1) - (a.version[i] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

function findInCaches() {
  const found = [];
  for (const cache of CACHES) {
    if (!existsSync(cache)) continue;
    for (const build of readdirSync(cache, { withFileTypes: true })) {
      if (!build.isDirectory() || build.name.includes('headless')) continue;
      const buildDir = join(cache, build.name);
      for (const platformDir of readdirSync(buildDir, { withFileTypes: true })) {
        if (!platformDir.isDirectory()) continue;
        for (const binary of BINARIES) {
          const candidate = join(buildDir, platformDir.name, binary);
          if (existsSync(candidate)) found.push(candidate);
        }
      }
    }
  }
  return found
    .map((executable) => ({ executable, version: versionOf(executable) }))
    .filter(({ version }) => version.length === 4)
    .sort(newerFirst)[0]?.executable;
}

// Branded Chrome no longer honours --load-extension, so this needs Chrome for Testing
// (or Chromium): CHROME_BIN names one, otherwise the newest one in the usual caches.
export function findChrome() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_BIN points at ${fromEnv}, which does not exist`);
    return fromEnv;
  }
  const cached = findInCaches();
  if (cached) return cached;
  throw new Error(
    'No Chrome for Testing found. Download one from https://googlechromelabs.github.io/chrome-for-testing/ '
    + 'and set CHROME_BIN to its executable. Branded Chrome will not do: it ignores --load-extension.',
  );
}

export async function launchChrome({ extensionDir }) {
  const executable = findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'tms-e2e-profile-'));
  const args = [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    // Nothing leaves the machine: every name but the fixture server's address fails to
    // resolve. The extension fetches its news feed at startup, and Chrome has traffic of
    // its own.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--disable-background-networking',
    // Asked for by name, never inferred: GitHub's runners do not allow the unprivileged
    // user namespaces the sandbox needs, a developer's machine does.
    ...(process.env.TMS_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(executable, args, { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // a run that dies without reaching close() must not leave a browser behind
  const killWithParent = () => child.kill('SIGKILL');
  process.once('exit', killWithParent);
  let failure;
  child.once('error', (error) => { failure = error; });

  const close = async () => {
    process.removeListener('exit', killWithParent);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    // Chrome writes the port it picked to this file. A browser that has stopped will never
    // write it: that ends the wait at once, and is reported instead of a timeout.
    const stopped = () => failure
      ?? (child.exitCode !== null || child.signalCode !== null
        ? new Error(`${executable} stopped at startup (exit code ${child.exitCode}, signal ${child.signalCode})`)
        : undefined);
    const port = await waitFor('Chrome to open its debugging port', async () => {
      if (stopped()) return -1;
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      return Number(text.split('\n')[0]) || undefined;
    }, { timeout: 30000 });
    const reason = stopped();
    if (reason) throw reason;
    return { executable, port, close };
  }
  catch (error) {
    await close();
    throw error;
  }
}
