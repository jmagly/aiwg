// Paid, explicitly opted-in check; never selected by automatic or release lanes.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  test: {
    include: ['test/uat/flue-cloudflare-deployed.uat.ts'],
    globalSetup: ['./test/helpers/flue-cloudflare-deployed-process.mjs'],
    environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false,
    testTimeout: 300_000, hookTimeout: 600_000, reporters: ['verbose'],
  },
});
