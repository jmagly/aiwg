// Release-only packed consumer; a provisioned graph supports offline worker verification.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { packFlue } from '../helpers/flue-package.mjs';
const root = path.resolve(import.meta.dirname, '../..');
let scratch: string;
afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
it('builds and runs a packed Flue skill, specialist and Node tools without network models', () => {
  const dependencies = path.resolve(process.env.AIWG_FLUE_DEPENDENCIES || path.join(root, 'examples/flue-node'), 'node_modules');
  expect(JSON.parse(fs.readFileSync(path.join(dependencies, '@flue/runtime/package.json'), 'utf8')).version).toBe('2.3.0');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-consumer-'));
  const { tarball, info } = packFlue(scratch);
  const project = path.join(scratch, 'app'); fs.mkdirSync(project);
  // Materialize preinstalled dependencies without package-manager mutations or network.
  fs.cpSync(dependencies, path.join(project, 'node_modules'), { recursive: true, filter: source => !source.split(path.sep).includes('.cache') });
  const packageDir = path.join(project, 'node_modules/@aiwg/flue'); fs.mkdirSync(packageDir, { recursive: true });
  expect(spawnSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDir], { timeout: 60_000 }).status).toBe(0);
  fs.mkdirSync(path.join(project, 'src/agents'), { recursive: true });
  fs.copyFileSync(path.join(root, 'test/fixtures/providers/flue/package-consumer-agent.ts'), path.join(project, 'src/agents/consumer.ts'));
  for (const file of ['vite.config.ts', 'flue.config.ts']) fs.copyFileSync(path.join(root, 'examples/flue-node', file), path.join(project, file));
  fs.writeFileSync(path.join(project, 'flue.config.ts'), "import { defineConfig } from '@flue/runtime/config';\nexport default defineConfig({ target: 'node', providers: [] });\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'examples/flue-node/package.json'), 'utf8'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ ...manifest, name: 'aiwg-flue-package-consumer' }));
  fs.writeFileSync(path.join(project, 'src/db.ts'), "import { sqlite } from '@flue/runtime/node';\nexport default sqlite('./state.db');\n");
  fs.writeFileSync(path.join(project, 'src/app.ts'), `import { Hono } from 'hono';
import { init } from '@flue/runtime';
import { Consumer } from './agents/consumer.ts';
const app = new Hono();
app.get('/probe', async c => {
  const agent = init(Consumer, { id: 'package-consumer' });
  const reply = await agent.read(await agent.dispatch('Run the synthetic package check'), { signal: AbortSignal.timeout(30000) });
  return c.text(reply.text);
});
export default app;
`);
  const home = path.join(scratch, 'home');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: scratch, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  // CI exercises npm's actual package installation. Implementation workers can
  // supply the locked graph above when network and package installs are forbidden.
  if (!process.env.AIWG_FLUE_DEPENDENCIES) {
    const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball, '@flue/runtime@2.3.0'],
      { cwd: project, env: { ...env, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_userconfig: path.join(scratch, 'absent.npmrc') }, encoding: 'utf8', timeout: 180_000 });
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
  }
  const run = (args: string[], timeout = 120_000) => {
    const result = spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`).toBe(0);
    return result.stdout;
  };
  run([path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions', 'src/app.ts']);
  run([path.join(project, 'node_modules/vite/bin/vite.js'), 'build']);
  fs.writeFileSync(path.join(project, 'probe.mjs'), `globalThis.fetch = () => { throw new Error('Network forbidden'); };
const { loadFlueNodeApplication } = await import('./dist/app.mjs');
const app = await loadFlueNodeApplication({ env: process.env });
try {
  const response = await app.fetch(new Request('http://localhost/probe'));
  const text = await response.text();
  if (response.status !== 200 || text !== 'PASS package consumer') throw new Error(text);
  console.log(text);
} finally { await app.stop(); }
`);
  expect(run(['probe.mjs'])).toContain('PASS package consumer');
  const size = (directory: string): number => fs.readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
    const file = path.join(directory, entry.name);
    return bytes + (entry.isDirectory() ? size(file) : entry.name.endsWith('.map') ? 0 : fs.statSync(file).size);
  }, 0);
  console.log(`Flue consumer: tarball=${info.size} bytes; built bundle=${size(path.join(project, 'dist'))} bytes (maps excluded)`);
}, 300_000);
