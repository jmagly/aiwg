// Materialize the locked example and supervise only temporary local workerd processes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { packFlue } from './flue-package.mjs';

const root = path.resolve(import.meta.dirname, '../..');
export async function prepareCloudflare(lab) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-cf-'));
  let worker;
  let logs = '';
  const project = path.join(scratch, 'app');
  const home = path.join(scratch, 'home');
  const env = { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home, USERPROFILE: home,
    TMPDIR: scratch, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_ROOT: root, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1',
    NO_UPDATE_NOTIFIER: '1', WRANGLER_SEND_METRICS: 'false', CI: '1' };
  async function run(command, args, timeout = 180_000) {
    const child = spawn(command, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), timeout);
    try {
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code}):\n${output}`);
      return output;
    } finally { clearTimeout(timer); }
  }
  const vite = path.join(project, 'node_modules/vite/bin/vite.js');
  async function stop() {
    if (!worker) return;
    const child = worker;
    worker = undefined;
    const closed = once(child, 'close');
    process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  async function start() {
    logs = '';
    worker = spawn(process.execPath, [vite, 'dev', '--host', '127.0.0.1', '--port', '0'], {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    worker.stdout.on('data', bytes => { logs += bytes; });
    worker.stderr.on('data', bytes => { logs += bytes; });
    let failure;
    worker.on('error', error => { failure = error; });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (failure || worker.exitCode !== null) throw new Error(`workerd startup failed: ${failure || ''}\n${logs}`);
      const match = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(logs.replace(/\x1b\[[0-9;]*m/g, ''));
      if (match) return match[1];
      await delay(50);
    }
    throw new Error(`workerd startup timeout:\n${logs}`);
  }
  const result = { scratch, project, env, run, start, stop, logs: () => logs,
    async close() { await stop(); fs.rmSync(scratch, { recursive: true, force: true }); } };
  try {
    fs.cpSync(path.join(root, 'examples/flue-cloudflare'), project, { recursive: true,
      filter: source => !['node_modules', 'dist', '.wrangler', '.flue-vite', '.flue-vite.wrangler.jsonc'].includes(path.basename(source))
        && !/^\.(?:dev\.vars|env)(?:\.|$)/.test(path.basename(source)) });
    fs.cpSync(path.join(lab, 'node_modules'), path.join(project, 'node_modules'), {
      recursive: true, filter: source => !source.split(path.sep).includes('.cache'),
    });
    const { tarball } = packFlue(scratch);
    const packageDir = path.join(project, 'node_modules/@aiwg/flue');
    fs.mkdirSync(packageDir, { recursive: true });
    await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDir]);
    fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: root, devMode: true }));
    await run(process.execPath, [path.join(root, 'bin/aiwg.mjs'), 'use', 'sdlc', '--provider', 'flue', '--package']);
    fs.copyFileSync(path.join(root, 'test/fixtures/providers/flue/cloudflare-provider.ts'), path.join(project, 'src/cf-test-provider.ts'));
    const agent = path.join(project, 'src/agents/assistant.ts');
    fs.writeFileSync(agent, fs.readFileSync(agent, 'utf8').replace("'use agent';", "'use agent';\nimport '../cf-test-provider.ts';"));
    const config = path.join(project, 'flue.config.ts');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace("target: 'cloudflare'", "target: 'cloudflare', providers: [], tracing: false"));
    return result;
  } catch (error) { await result.close(); throw error; }
}
