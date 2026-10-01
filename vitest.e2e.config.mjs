import { defineConfig } from 'vitest/config';

// End-to-end tests: a real browser and the packaged extension, so no chrome stub, one
// file at a time, and room for a browser to start.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.js'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
