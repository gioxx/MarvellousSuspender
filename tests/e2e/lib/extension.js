import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// `grunt zip` names the zip after the version in the manifest, and leaves the zips of
// earlier versions where they are.
async function buildZip() {
  await run('npx', ['grunt', 'zip'], { cwd: ROOT });
  const { version } = JSON.parse(await readFile(join(ROOT, 'src', 'manifest.json'), 'utf8'));
  return join(ROOT, 'build', 'zip', `tms-${version}.zip`);
}

// The tests run against the package, not against src/: TMS_E2E_ZIP names a zip that is
// already built (CI passes the one its build job uploaded), otherwise one is built here.
export async function unpackExtension() {
  const zip = process.env.TMS_E2E_ZIP ? resolve(process.env.TMS_E2E_ZIP) : await buildZip();
  const dir = await mkdtemp(join(tmpdir(), 'tms-e2e-extension-'));
  await run('unzip', ['-q', zip, '-d', dir]);
  return {
    zip,
    dir,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
