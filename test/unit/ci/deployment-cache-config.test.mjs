import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('deployment cache test-lane setup', () => {
  it('preserves both setup hooks, isolates per-file environment and cleans its owned cache', async () => {
    const config = (await import('../../../config/vitest.config.js')).default;
    expect(config.test.globalSetup).toEqual(['./test/helpers/default-home-setup.mjs', './test/helpers/prebuilt-relations-setup.mjs', './test/helpers/deployment-cache-setup.mjs']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-cache-config-'));
    try {
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
      const helpers = path.join(root, 'test/helpers');
      const events = path.join(dir, 'events');
      // Runtime paths are data, never JavaScript source literals.
      fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ helpers, events }));
      fs.writeFileSync(path.join(dir, 'prebuilt.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
const { events } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
export default () => appendFileSync(events, 'prebuilt\\n');
`);
      // The outer lane already runs the real prebuilt setup. Do not rebuild its
      // shared directory concurrently with readers in this nested runner.
      fs.writeFileSync(path.join(dir, 'cache.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { events, helpers } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const { default: setup } = await import(pathToFileURL(join(helpers, 'deployment-cache-setup.mjs')).href);
export default p => {
  appendFileSync(events, 'cache\\n');
  const end = setup(p);
  return () => { end(); appendFileSync(events, 'teardown\\n'); };
};
`);
      const names = ['test/integration/use-all-deployment.test.ts', 'test/integration/hermes-deployment.test.ts', 'test/integration/bundle-reconciliation-cli.test.ts', 'test/integration/bundle-reconciliation-codex-cli.test.ts', 'test/integration/project-local-deploy.test.ts', 'test/unit/mutable-fixture.test.ts'];
      for (const name of names) {
        const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
it('captures environment', () => writeFileSync(fileURLToPath(import.meta.url) + '.json', JSON.stringify({
  binding: process.env.AIWG_RULE_BINDING_INDEX_CACHE ?? null,
  framework: process.env.AIWG_FRAMEWORK_INDEX_CACHE ?? null,
  source: process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE ?? null,
})));
`);
      }
      fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { helpers } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('.', import.meta.url));
export default { root, cacheDir: join(root, '.vite'), test: {
  globalSetup: [join(root, 'prebuilt.mjs'), join(root, 'cache.mjs')],
  setupFiles: [join(helpers, 'deployment-cache-isolation.mjs')], maxWorkers: 1, pool: 'threads',
} };
`);
      // Embed the runner so this regression never starts a second Vitest process.
      const { startVitest } = await import('vitest/node');
      const run = await startVitest('test', [], { root: dir, config: path.join(dir, 'vitest.config.mjs'), watch: false, reporters: ['json'], outputFile: path.join(dir, 'report.json') });
      try {
        expect(run.state.getUnhandledErrors()).toEqual([]);
        expect(run.state.getFiles()).toHaveLength(names.length);
        for (const file of run.state.getFiles()) expect(file.result?.state, file.filepath).toBe('pass');
      } finally { await run.close(); }
      expect(run.state.getUnhandledErrors()).toEqual([]);
      expect(fs.readFileSync(events, 'utf8').trim().split('\n')).toEqual(['prebuilt', 'cache', 'teardown']);
      const results = names.map(name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')));
      for (const item of results.slice(0, 4)) expect(item).toMatchObject({ binding: expect.any(String), framework: expect.any(String), source: fs.realpathSync(root) });
      expect(results[0].binding).toBe(results[1].binding);
      expect(results[0].binding).toBe(results[2].binding);
      expect(results[0].binding).toBe(results[3].binding);
      expect(results[4]).toMatchObject({ binding: null, framework: expect.any(String) });
      expect(results[5]).toEqual({ binding: null, framework: null, source: null });
      expect(fs.existsSync(path.dirname(path.dirname(results[0].binding)))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 200_000);
});
