import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grunt = require('grunt');
const gruntfile = require('../Gruntfile.js');

// Runs the Gruntfile against a recording stand-in, so the test reads the real
// configuration and task lists without loading plugins or touching the disk.
function loadBuild() {
  const build = { config: null, tasks: {} };
  gruntfile({
    cli: { tasks: [] },
    file: { readJSON: () => ({ version: '0.0.0' }) },
    initConfig: (config) => { build.config = config; },
    loadNpmTasks: () => {},
    registerTask: (name, steps) => { build.tasks[name] = steps; },
  });
  return build;
}

const build = loadBuild();
const packaged = (paths) => grunt.file.match(build.config.copy.main.src, paths);

describe('build: what the copy step packages', () => {
  it('packages the extension sources', () => {
    const sources = ['src/manifest.json', 'src/js/gsUtils.js', 'src/_locales/en/messages.json'];
    expect(packaged(sources)).toEqual(sources);
  });

  it.each([
    'src/js/gsOauthSecrets.local.js',
    'src/probe.local.js',
    'src/js/deep/er/override.local.js',
  ])('leaves the local override %s out', (path) => {
    expect(packaged([path])).toEqual([]);
  });

  it.each([
    'src/key.pem',
    'src/js/signing.pem',
  ])('leaves the key file %s out', (path) => {
    expect(packaged([path])).toEqual([]);
  });
});

describe('build: every packaging task starts from an empty temp dir', () => {
  it.each(['default', 'zip', 'tgut'])('%s cleans before it copies', (task) => {
    const steps = build.tasks[task];
    expect(steps[0]).toBe('clean');
    expect(steps.indexOf('copy')).toBeGreaterThan(0);
    expect(steps[steps.length - 1]).toBe('clean');
  });

  it('cleans only the temp dir', () => {
    expect(build.config.clean).toEqual(['<%= config.tempDir %>']);
  });
});
