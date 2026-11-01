// Release-only packed remote export against the project-bound HTTP CLI fixture.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';
import { packFlue } from '../helpers/flue-package.mjs';

const root = path.resolve(import.meta.dirname, '../..');
let scratch: string;
let service: Awaited<ReturnType<typeof launchHttp>>;
afterEach(async () => {
  await service?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

it('builds a packed remote agent, checks discovery/show/write results and rejects a wrong token', async () => {
  const dependencies = path.resolve(process.env.AIWG_FLUE_DEPENDENCIES || path.join(root, 'examples/flue-node'), 'node_modules');
  expect(JSON.parse(fs.readFileSync(path.join(dependencies, '@flue/runtime/package.json'), 'utf8')).version).toBe('2.3.0');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-remote-consumer-'));
  const { tarball } = packFlue(scratch);
  const project = path.join(scratch, 'app');
  fs.mkdirSync(project);
  fs.cpSync(dependencies, path.join(project, 'node_modules'), { recursive: true, filter: source => !source.split(path.sep).includes('.cache') });
  const packageDir = path.join(project, 'node_modules/@aiwg/flue');
  fs.mkdirSync(packageDir, { recursive: true });
  const home = path.join(scratch, 'home');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: scratch,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  // Keep the parent event loop live: the HTTP fixture's CLI proxy is a child.
  const run = async (command: string, args: string[], extraEnv = {}) => {
    const child = spawn(command, args, { cwd: project, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(status, output).toBe(0);
      return output;
    } finally { clearTimeout(timer); }
  };
  await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDir]);
  fs.mkdirSync(path.join(project, 'src/agents'), { recursive: true });
  fs.copyFileSync(path.join(root, 'test/fixtures/providers/flue/remote-consumer-agent.ts'), path.join(project, 'src/agents/consumer.ts'));
  fs.copyFileSync(path.join(root, 'test/fixtures/providers/flue/remote-consumer-probe.mjs'), path.join(project, 'probe.mjs'));
  fs.copyFileSync(path.join(root, 'examples/flue-node/vite.config.ts'), path.join(project, 'vite.config.ts'));
  fs.writeFileSync(path.join(project, 'flue.config.ts'), "import { defineConfig } from '@flue/runtime/config';\nexport default defineConfig({ target: 'node', providers: [] });\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'examples/flue-node/package.json'), 'utf8'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ ...manifest, name: 'aiwg-flue-remote-consumer' }));
  fs.writeFileSync(path.join(project, 'src/db.ts'), "import { sqlite } from '@flue/runtime/node';\nexport default sqlite('./state.db');\n");
  fs.writeFileSync(path.join(project, 'src/app.ts'), `import { Hono } from 'hono';
import { init } from '@flue/runtime';
import { RemoteConsumer } from './agents/consumer.ts';
const app = new Hono();
app.get('/probe', async c => {
  try {
    const agent = init(RemoteConsumer, { id: process.env.AIWG_REMOTE_MODE! });
    const reply = await agent.read(await agent.dispatch('Run remote package check'), { signal: AbortSignal.timeout(30000) });
    return c.text(reply.text);
  } catch (error) {
    const messages = [];
    for (let cause: any = error; cause; cause = cause.cause) messages.push(cause.message || String(cause));
    return c.text(messages.join(' / '), 500);
  }
});
export default app;
`);
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions', 'src/app.ts']);
  await run(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js'), 'build']);
  service = await launchHttp(); // Generates its own token and isolates HOME/project.
  const artifact = path.join(service.project, '.aiwg/flue/remote.md');
  const remoteEnv = { AIWG_REMOTE_URL: service.url, AIWG_REMOTE_ARTIFACT: artifact };
  expect(await run(process.execPath, ['probe.mjs', 'wrong-token'], { ...remoteEnv,
    AIWG_REMOTE_TOKEN: 'synthetic-wrong-token', AIWG_REMOTE_MODE: 'wrong-token' })).toContain('PASS wrong token');
  expect(fs.existsSync(artifact)).toBe(false);
  expect(await run(process.execPath, ['probe.mjs'], { ...remoteEnv,
    AIWG_REMOTE_TOKEN: service.token, AIWG_REMOTE_MODE: 'authorized' })).toContain('PASS packed remote consumer');
  expect(fs.readFileSync(artifact, 'utf8')).toBe('Packed remote Flue write\n');
  expect(fs.existsSync(path.join(project, '.aiwg/flue/remote.md'))).toBe(false);
}, 300_000);
