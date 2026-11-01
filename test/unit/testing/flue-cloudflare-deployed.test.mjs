// Offline contracts for the opt-in gate, secret handling and failure/signal teardown.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { globSync } from 'glob';
import { deployedCheck } from '../../helpers/flue-cloudflare-deployed.mjs';
import { createRedactor, processRunner, requireDeployedOptIn, startTunnel, tailEvents, tunnelUrl, workerName } from '../../helpers/flue-cloudflare-deployed-process.mjs';
import { fakeDeployedOptions } from '../../fixtures/providers/flue/cloudflare-deployed-fixture.mjs';
import * as lanes from '../../../config/test-lanes.mjs';
import { runDeployedVitest } from '../../../tools/testing/flue-cloudflare-deployed.mjs';
import manual from '../../../config/vitest.flue-cloudflare-deployed.config.js';
import { expandScripts } from '../../../tools/testing/workflow-commands.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const temporary = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-cf-unit-')); temporary.push(dir); return dir; };
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const credentials = { AIWG_FLUE_CF_DEPLOY: '1', CLOUDFLARE_API_TOKEN: 'synthetic-token', CLOUDFLARE_ACCOUNT_ID: 'synthetic-account' };
function fixture(mode) {
  const dir = scratch(), logs = [];
  const check = deployedCheck({ ...fakeDeployedOptions(dir, mode), signals: new EventEmitter(), log: line => logs.push(line) });
  temporary.push(path.dirname(check.resultsPath));
  return { check, dir, logs };
}

describe('manual Cloudflare deployed check (offline)', () => {
  it.each(['AIWG_FLUE_CF_DEPLOY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])('refuses without %s before starting any resource', key => {
    const env = { ...credentials }; delete env[key];
    expect(() => deployedCheck({ env, prepare: () => { throw new Error('must not start'); } })).toThrow(/Refusing deployed Cloudflare check/);
  });
  it.each(['0', 'true', '', undefined])('rejects non-exact opt-in %s', value => {
    expect(() => requireDeployedOptIn({ ...credentials, AIWG_FLUE_CF_DEPLOY: value })).toThrow(/manual only/);
  });
  it('accepts only explicit opt-in with both credentials', () => {
    expect(() => requireDeployedOptIn(credentials)).not.toThrow();
    expect(() => requireDeployedOptIn({ ...credentials, CLOUDFLARE_API_TOKEN: '  ' })).toThrow(/CLOUDFLARE_API_TOKEN/);
  });
  it('refuses the explicit runner with no credentials and starts no children', () => {
    const result = spawnSync(process.execPath, ['tools/testing/flue-cloudflare-deployed.mjs'], {
      cwd: root, env: { PATH: process.env.PATH, HOME: scratch(), NO_UPDATE_NOTIFIER: '1' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing.*AIWG_FLUE_CF_DEPLOY=1.*CLOUDFLARE_API_TOKEN.*CLOUDFLARE_ACCOUNT_ID/);
    expect(result.stdout).toBe('');
  });
  it('parses the quick-tunnel URL across captured output chunks and ANSI noise', () => {
    const chunks = ['noise\n\u001b[32m| https://green-', 'fox-123.trycloudflare.com |\u001b[0m'];
    expect(tunnelUrl(chunks[0])).toBeUndefined();
    expect(tunnelUrl(chunks.join(''))).toBe('https://green-fox-123.trycloudflare.com');
  });
  it.each(['http://foo.trycloudflare.com', 'https://foo.trycloudflare.com.evil.test', 'https://trycloudflare.com', 'https://x.workers.dev'])('rejects non-tunnel URL %s', value => {
    expect(tunnelUrl(value)).toBeUndefined();
  });
  it('redacts literal, encoded, JSON-escaped and rotated secrets', () => {
    const secret = 'sensitive /"value';
    const redact = createRedactor([secret]);
    redact.add('rotated-token');
    for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), 'rotated-token', 'Bearer unknown-token']) {
      expect(redact(value)).toContain('[REDACTED]');
    }
    expect(redact('safe diagnostic')).toBe('safe diagnostic');
  });
  it('generates unique legal Worker names distinct from the checked-in example', () => {
    const names = Array.from({ length: 1000 }, workerName);
    expect(new Set(names).size).toBe(1000);
    expect(names.every(name => /^aiwg-flue-check-[a-f0-9]{24}$/.test(name) && name.length <= 63)).toBe(true);
  });
  it('bounds tunnel startup and reaps a silent process', async () => {
    const dir = scratch();
    const executable = path.join(dir, 'silent');
    fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const runner = processRunner({ cwd: dir, env: { PATH: process.env.PATH } });
    await expect(startTunnel(runner, executable, 'http://127.0.0.1:12345/mcp', 100)).rejects.toThrow(/URL timeout/);
    await runner.stopAll();
  });

  it('reads the serving script version per request from chunked wrangler tail output', () => {
    const a = JSON.stringify({ scriptVersion: { id: 'v-old' }, event: { request: { url: 'https://w.example/agents/assistant/x1' } }, logs: [{ message: ['brace } in "text"'] }] });
    const b = JSON.stringify({ scriptVersion: { id: 'v-new' }, event: { request: { url: 'https://w.example/agents/assistant/x2' } } });
    expect(tailEvents(`noise\n${a}\n${b.slice(0, 20)}`)).toEqual([{ version: 'v-old', url: 'https://w.example/agents/assistant/x1' }]);
    expect(tailEvents(`${a}\n${b}\n{"scheduled":true}`)).toEqual([
      { version: 'v-old', url: 'https://w.example/agents/assistant/x1' },
      { version: 'v-new', url: 'https://w.example/agents/assistant/x2' },
    ]);
  });

  it('redacts a tunnel URL printed before cloudflared exits early', async () => {
    const { check } = fixture('tunnel-exit');
    await expect(check.start()).rejects.toThrow(/cloudflared exited before tunnel readiness/);
    const json = fs.readFileSync(check.resultsPath, 'utf8');
    expect(json).toContain('[REDACTED]');
    expect(json).not.toContain('synthetic-check.trycloudflare.com');
  });

  it('presents the loopback Host to the D9 listener through the tunnel', async () => {
    const dir = scratch();
    const executable = path.join(dir, 'echo-args');
    fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error(JSON.stringify(process.argv.slice(2)));\nconsole.error('https://abc-def.trycloudflare.com');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const runner = processRunner({ cwd: dir, env: { PATH: process.env.PATH } });
    const tunnel = await startTunnel(runner, executable, 'http://127.0.0.1:12345/mcp', 5000);
    expect(tunnel.url).toBe('https://abc-def.trycloudflare.com/mcp');
    expect(tunnel.output()).toContain(JSON.stringify(['tunnel', '--url', 'http://127.0.0.1:12345', '--http-host-header', '127.0.0.1:12345']));
    await runner.stopAll();
  });
  it('rejects a tunnel that prints its URL and then exits', async () => {
    const dir = scratch();
    const executable = path.join(dir, 'url-then-exit');
    fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error('https://abc-def.trycloudflare.com');\nsetTimeout(() => process.exit(1), 200);\n`, { mode: 0o755 });
    const runner = processRunner({ cwd: dir, env: { PATH: process.env.PATH } });
    await expect(startTunnel(runner, executable, 'http://127.0.0.1:12345/mcp', 5000)).rejects.toThrow(/cloudflared exited before tunnel readiness/);
    await runner.stopAll();
  });
  it('deletes a possibly uploaded Worker and removes resources after deployment failure', async () => {
    const { check, dir, logs } = fixture('deploy-fail');
    check.record('synthetic case', 'pending', 0);
    await expect(check.start()).rejects.toThrow(/synthetic upload failure \[REDACTED\]/);
    await check.close(); // cleanup is idempotent
    const trace = fs.readFileSync(path.join(dir, 'trace'), 'utf8');
    expect(trace).toContain(`delete delete ${check.name} --force`);
    expect(trace.match(/delete delete/g)).toHaveLength(1);
    expect(trace).toContain('tunnel stopped');
    expect(trace).toContain('server stopped');
    expect(trace).toContain('app removed');
    expect(fs.existsSync(path.join(dir, 'app'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'server'))).toBe(false);
    const json = fs.readFileSync(check.resultsPath, 'utf8');
    expect(json).not.toContain('synthetic-cloudflare-api-token');
    expect(json).not.toContain('synthetic-mcp-token');
    expect(JSON.parse(json)).toMatchObject({ versions: { '@aiwg/flue': JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, wrangler: '4.152.0', cloudflared: 'cloudflared synthetic-test' },
      cases: [{ status: 'fail', durationMs: 0 }], teardown: { worker: 'ok', tunnel: 'ok', server: 'ok', app: 'ok' } });
    expect(logs.join('\n')).toContain('Teardown:');
    expect(logs.join('\n')).toContain(check.resultsPath);
  });
  it('sends both MCP secrets over stdin and records timings without persisting secrets', async () => {
    const { check, dir } = fixture('success');
    try {
      const state = await check.start();
      await state.restart();
      await state.setToken('synthetic-wrong-token');
      check.record('synthetic case', 'pass', 12);
      const trace = fs.readFileSync(path.join(dir, 'trace'), 'utf8');
      expect(trace).toContain('secret AIWG_MCP_URL stdin=true');
      expect(trace).toContain('secret AIWG_MCP_TOKEN stdin=true');
      expect(trace).toContain(`deployments deployments status --json --name ${check.name}`);
      expect(trace).toContain(`tail ${check.name}`);
      expect(trace).not.toContain('synthetic-mcp-token');
      expect(trace).not.toContain('synthetic-check.trycloudflare.com');
      const config = fs.readFileSync(path.join(dir, 'app/wrangler.jsonc'), 'utf8');
      expect(config).toContain('aiwg-cf-test/scripted');
      expect(config).not.toMatch(/AIWG_MCP_URL|AIWG_MCP_TOKEN/);
      expect(JSON.parse(config).name).toBe(check.name);
    } finally { await check.close(); }
    expect(JSON.parse(fs.readFileSync(check.resultsPath, 'utf8')).cases).toEqual([{ name: 'synthetic case', status: 'pass', durationMs: 12 }]);
  });
  it('continues cleanup and prints an executable manual deletion command if deletion fails', async () => {
    const { check, dir, logs } = fixture('delete-fail');
    await check.start();
    await expect(check.close()).rejects.toThrow(/teardown failed/);
    const result = JSON.parse(fs.readFileSync(check.resultsPath, 'utf8'));
    expect(result.teardown.manualCleanup).toContain(`delete ${check.name} --force`);
    expect(result.teardown.manualCleanup).toContain(path.join(dir, 'app/node_modules/wrangler/bin/wrangler.js'));
    expect(result.teardown).toMatchObject({ tunnel: 'ok', server: 'ok', app: 'ok' });
    expect(logs.join('\n')).toContain('Manual cleanup');
  });
  it.each(['SIGINT', 'SIGTERM'])('runs teardown when interrupted with %s during upload', async signal => {
    const dir = scratch();
    const child = spawn(process.execPath, ['test/fixtures/providers/flue/cloudflare-deployed-signal.mjs', dir], {
      cwd: root, env: { PATH: process.env.PATH, HOME: dir, NO_UPDATE_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const closed = once(child, 'close');
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !fs.readFileSync(path.join(dir, 'trace'), { encoding: 'utf8', flag: 'a+' }).includes('deploy ')) await delay(25);
      expect(fs.readFileSync(path.join(dir, 'trace'), 'utf8')).toContain('deploy ');
      child.kill(signal);
      const [code] = await closed;
      expect(code, output).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(fs.readFileSync(path.join(dir, 'trace'), 'utf8')).toContain('delete delete aiwg-flue-check-');
      expect(output).toContain('Teardown:');
      const resultPath = /Results JSON: (.+)/.exec(output)?.[1];
      expect(resultPath).toBeTruthy();
      temporary.push(path.dirname(resultPath));
      expect(JSON.parse(fs.readFileSync(resultPath, 'utf8')).teardown).toMatchObject({ worker: 'ok', server: 'ok', app: 'ok' });
    } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await closed; } }
  }, 10_000);
  it('lets the npm runner wait for the cleanup owner on interruption', async () => {
    const dir = scratch(), signals = new EventEmitter();
    const run = runDeployedVitest({ env: { ...credentials, PATH: process.env.PATH, HOME: dir, FAKE_CF_SCRATCH: dir },
      signals, stdio: ['ignore', 'pipe', 'pipe'], executable: path.join(root, 'test/fixtures/providers/flue/cloudflare-deployed-signal.mjs') });
    let output = '';
    run.child.stdout.on('data', bytes => { output += bytes; });
    run.child.stderr.on('data', bytes => { output += bytes; });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !fs.readFileSync(path.join(dir, 'trace'), { encoding: 'utf8', flag: 'a+' }).includes('deploy ')) await delay(25);
      expect(fs.readFileSync(path.join(dir, 'trace'), 'utf8')).toContain('deploy ');
      signals.emit('SIGTERM');
      expect(await run.completed, output).toBe(143);
      expect(output).toContain('Teardown:');
      expect(fs.readFileSync(path.join(dir, 'trace'), 'utf8')).toContain('delete delete aiwg-flue-check-');
      expect(fs.existsSync(path.dirname(run.controlPath))).toBe(false);
      temporary.push(path.dirname(/Results JSON: (.+)/.exec(output)[1]));
    } finally { if (run.child.exitCode === null) { run.child.kill('SIGKILL'); await run.completed; } }
  }, 10_000);
  it('is owned solely by the explicit config and manual metadata; no automatic selector reaches it', async () => {
    const suite = 'test/uat/flue-cloudflare-deployed.uat.ts';
    const config = 'config/vitest.flue-cloudflare-deployed.config.js';
    const script = 'test:flue-cloudflare-deployed';
    expect(manual.test.include).toEqual([suite]);
    expect(lanes.unavailableLanes[config]).toMatch(/Manual only.*paid/);
    expect(lanes.scriptLaneExemptions.find(entry => entry.script === script)?.kind).toBe('manual');
    for (const [key, value] of Object.entries(lanes)) if (!['unavailableLanes', 'scriptLaneExemptions'].includes(key)) {
      expect(JSON.stringify(value), key).not.toContain('flue-cloudflare-deployed');
    }
    for (const file of globSync('config/vitest*.config.js', { cwd: root }).filter(file => file !== config)) {
      const { default: other } = await import(path.join(root, file));
      expect(globSync(other.test.include, { cwd: root, ignore: other.test.exclude ?? [] }), file).not.toContain(suite);
    }
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    for (const name of ['test', 'test:ci', 'test:release-slow', 'test:release:routine-deployment']) {
      expect(expandScripts(`npm run ${name}`, scripts).names).not.toContain(script);
    }
    for (const file of globSync(['.github/workflows/**/*', '.gitea/workflows/**/*', '**/cut-tag.sh'], { cwd: root, nodir: true, ignore: ['node_modules/**'] })) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(/flue-cloudflare-deployed|AIWG_FLUE_CF_DEPLOY/);
    }
  });
});
