// Exercise real user deployments from separate Vitest files with one lock held.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import base from '../../../config/vitest.config.js';

const repo = path.resolve(import.meta.dirname, '../../..');

it.each([2, 4])('isolates concurrent file deployments with %i workers, including a held lock', async maxWorkers => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-file-homes-'));
  const homes: Record<string, string>[] = [];
  const arrivals: ServerResponse[] = [];
  const locked: ServerResponse[] = [];
  let holding = false;
  let deployed = false;
  let finished: ServerResponse | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/homes') {
      homes.push(JSON.parse(url.searchParams.get('env')!));
      arrivals.push(response);
      if (arrivals.length === 2) arrivals.forEach(res => res.end(JSON.stringify(homes)));
    } else if (url.pathname === '/locked') {
      if (url.searchParams.has('hold')) holding = true;
      locked.push(response);
      if (holding) locked.splice(0).forEach(res => res.end('ready'));
    } else if (url.pathname === '/done') {
      deployed = true;
      finished?.end('done'); response.end('done');
    } else if (url.pathname === '/finish') {
      if (deployed) response.end('done'); else finished = response;
    }
    else { response.statusCode = 404; response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'skills/probe'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills/probe/SKILL.md'), '---\nname: probe\ndescription: Synthetic skill\nkernel: true\n---\nProbe.\n');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  // Each file inherits the real setup hooks. Neither creates or overrides HOME.
  const body = `
import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireProviderDeploymentLock, providerDeploymentLockEnvironment } from ${JSON.stringify(path.join(repo, 'src/providers/deployment-lock.ts'))};
const endpoint = 'http://127.0.0.1:${port}';
const request = async route => (await fetch(endpoint + route)).text();
it('deploys to its own user home while the other file holds a lock', async () => {
  const keys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
  const own = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const homes = JSON.parse(await request('/homes?env=' + encodeURIComponent(JSON.stringify(own))));
  for (const key of keys) expect(new Set(homes.map(env => env[key])).size, key).toBe(2);
  expect(os.homedir()).toBe(own.HOME);
  const holder = import.meta.url.includes('/a.test');
  const release = holder ? await acquireProviderDeploymentLock() : undefined;
  await request('/locked' + (holder ? '?hold' : ''));
  const finish = holder ? request('/finish') : undefined;
  try {
    const deploy = async () => {
      const result = await promisify(execFile)(process.execPath, [${JSON.stringify(path.join(repo, 'tools/agents/deploy-agents.mjs'))},
        '--source', ${JSON.stringify(source)}, '--provider', 'hermes', '--scope', 'user', '--target', own.HOME,
        '--deploy-skills', '--skip-commands-migration', '--quiet'], {
        env: { ...process.env, ...providerDeploymentLockEnvironment(), AIWG_RESOLVE_IMPL_FROM: 'dist' },
        timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      expect(result.stderr + result.stdout).not.toContain('Waiting for shared user-home');
      expect(existsSync(path.join(own.HOME, '.hermes/skills/probe/SKILL.md'))).toBe(true);
    };
    if (release) await release.run(deploy); else await deploy();
  } finally {
    if (holder) { await finish; await release(); } else await request('/done');
  }
}, 45_000);
`;
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(root, `${name}.test.mjs`), body);
  let run: Awaited<ReturnType<typeof import('vitest/node')['startVitest']>>;
  try {
    // Embed the runner: there is still only one Vitest process.
    const { startVitest } = await import('vitest/node');
    run = await startVitest('test', [], {
      root, config: false, watch: false, pool: base.test.pool, maxWorkers, minWorkers: 2,
      include: ['*.test.mjs'],
      globalSetup: [path.join(repo, 'test/helpers/default-home-setup.mjs')],
      setupFiles: base.test.setupFiles.map(file => path.join(repo, file)),
      reporters: ['json'], outputFile: path.join(root, 'report.json'),
    });
    expect(run!.state.getUnhandledErrors()).toEqual([]);
    expect(run!.state.getFiles()).toHaveLength(2);
    expect(run!.state.getFiles().map(file => file.result?.state),
      fs.readFileSync(path.join(root, 'report.json'), 'utf8')).toEqual(['pass', 'pass']);
  } finally {
    await run!?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(homes).toHaveLength(2);
  for (const env of homes) expect(fs.existsSync(env.HOME)).toBe(false);
}, 120_000);
