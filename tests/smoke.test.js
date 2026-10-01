import { describe, it, expect } from 'vitest';

describe('module loading under Node', () => {
  it('imports gsUtils without touching a real browser', async () => {
    const { gsUtils } = await import('../src/js/gsUtils.js');
    expect(typeof gsUtils.getHashVariable).toBe('function');
  });
});
