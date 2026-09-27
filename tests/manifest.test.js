import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
const csp = manifest.content_security_policy.extension_pages;

describe('manifest.json content security policy', () => {
  it('forbids framing extension pages', () => {
    expect(csp).toMatch(/(^|;)\s*frame-ancestors 'none'\s*(;|$)/);
  });

  it('never allows inline or remote script', () => {
    expect(csp).toMatch(/(^|;)\s*script-src 'self'\s*(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
