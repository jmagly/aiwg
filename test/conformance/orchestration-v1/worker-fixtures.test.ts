import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdapter } from '../../../tools/ralph-external/lib/provider-adapter.mjs';

class FixtureAdapter extends ProviderAdapter {}
const adapter = new FixtureAdapter();
const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
beforeEach(() => vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'));

const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const roots: string[] = [];
const children: { child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }[] = [];
const syntheticSecret = 'fixture-secret-value-never-recorded';

function setup(scenario = 'success', extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-fixture-'));
  roots.push(root);
  const recordPath = path.join(root, 'record.json');
  const final = path.join(root, 'final output.jsonl');
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ scenario, recordPath, outputPaths: { final }, ...extra }));
  return { root, recordPath, final, configPath };
}

function launch(kind: 'cli' | 'mcp', settings: ReturnType<typeof setup>, args: string[] = [], timeoutMs = 5_000) {
  const child = spawn(process.execPath, [path.join(fixtureRoot, `ralph-worker-${kind}.mjs`), ...args], {
    cwd: settings.root, env: { AIWG_FAKE_WORKER_CONFIG: settings.configPath, SYNTHETIC_SECRET: syntheticSecret },
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }); });
  });
  children.push({ child, closed });
  return { child, closed, output: () => ({ stdout, stderr, timedOut }) };
}

function mcp(settings: ReturnType<typeof setup>) {
  const process = launch('mcp', settings);
  const responses = new Map<number, any>();
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let disconnected = false;
  createInterface({ input: process.child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    responses.set(message.id, message);
    waiting.get(message.id)?.resolve(message);
    waiting.delete(message.id);
  });
  void process.closed.then(() => {
    disconnected = true;
    for (const waiter of waiting.values()) waiter.reject(new Error('Fixture disconnected'));
    waiting.clear();
  });
  const notify = (method: string, params: unknown) => process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const send = (method: string, params: unknown = {}) => {
    const id = nextId++;
    process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  const response = (id: number): Promise<any> => {
    if (responses.has(id)) return Promise.resolve(responses.get(id));
    if (disconnected) return Promise.reject(new Error('Fixture disconnected'));
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  };
  return { ...process, send, notify, response, responses };
}

const worker = (invocationId: string, workspace: string, model = 'synthetic-model') => ({
  invocationId, workspace, selection: { provider: 'synthetic', model, effort: 'high' }, brief: `Synthetic brief ${invocationId}`,
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S0 reusable fake CLI mechanics (T-OG-03/15; no provider qualification)', () => {
  it('records exact argv/cwd/stdin, environment names and output paths after EOF', async () => {
    const settings = setup();
    const args = ['--model', 'quotes " and spaces', 'Unicode λ 🎉', 'line\nbreak', '--leading-dash', '$(touch should-not-exist)', '--final-output', settings.final];
    const input = 'synthetic stdin\nwith "quotes" and Unicode λ\n';
    const running = launch('cli', settings, args);
    running.child.stdin.end(input);
    expect(await running.closed).toEqual({ code: 0, signal: null });
    const record = JSON.parse(readFileSync(settings.recordPath, 'utf8'));
    expect(record).toMatchObject({ fixtureRevision: 2, scenarioId: 'success', argv: args, cwd: settings.root, stdin: input, outputPaths: { final: settings.final, '--final-output': settings.final } });
    expect(record.envNames).toEqual(['AIWG_FAKE_WORKER_CONFIG', 'SYNTHETIC_SECRET']);
    expect(JSON.stringify(record)).not.toContain(syntheticSecret);
    expect(existsSync(path.join(settings.root, 'should-not-exist'))).toBe(false);
    expect(JSON.parse(running.output().stdout)).toMatchObject({ type: 'result', result: { version: 1, status: 'completed' } });
    expect(readFileSync(settings.final, 'utf8')).toBe(running.output().stdout);
    expect(running.output().stderr).toBe('');
    expect(running.output().timedOut).toBe(false);
    expect(await adapter.parseWorkerOutput(running.output().stdout, { observation })).toMatchObject({ status: 'completed' });
  });

  it.each(['exit-zero-error', 'missing-final', 'double-final', 'truncated-final'])('emits the intended %s fault with exit zero', async scenario => {
    const settings = setup(scenario);
    const running = launch('cli', settings);
    running.child.stdin.end('synthetic input');
    expect(await running.closed).toEqual({ code: 0, signal: null });
    const { stdout, stderr, timedOut } = running.output();
    expect(stderr).toBe('');
    expect(timedOut).toBe(false);
    expect(JSON.parse(readFileSync(settings.recordPath, 'utf8')).scenario).toBe(scenario);
    expect(readFileSync(settings.final, 'utf8')).toBe(stdout);
    await expect(adapter.parseWorkerOutput(stdout, { observation })).rejects.toThrow();
    if (scenario === 'truncated-final') expect(() => JSON.parse(stdout)).toThrow();
    else {
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.type === 'result')).toHaveLength(scenario === 'double-final' ? 2 : 0);
      if (scenario === 'exit-zero-error') expect(events[0]).toMatchObject({ type: 'error' });
      if (scenario === 'missing-final') expect(events[0]).toMatchObject({ type: 'message' });
    }
  });

  // #3878: the ownership wait honours the caller's limit and says what it last saw.
  it('fails an unobserved ownership wait after waitForIdentityMs and reports the last record', async () => {
    const settings = setup('success');
    const processRecord = path.join(settings.root, 'process.json');
    writeFileSync(settings.configPath, JSON.stringify({ ...JSON.parse(readFileSync(settings.configPath, 'utf8')),
      waitForIdentity: processRecord, waitForIdentityMs: 300 }));
    writeFileSync(processRecord, JSON.stringify({ worker: { pid: 1 }, identityObservation: 'no-stable-owned-group' }));
    const running = launch('cli', settings);
    running.child.stdin.end('synthetic input');
    expect(await running.closed).toEqual({ code: 1, signal: null });
    const { stdout, stderr, timedOut } = running.output();
    expect(timedOut).toBe(false);
    expect(stdout).toBe('');
    expect(stderr).toContain('last process record {"workerPid":1,"identityObservation":"no-stable-owned-group"}');
    expect(stderr).toContain('Synthetic worker ownership was not observed within 300 ms');
    expect(existsSync(settings.final)).toBe(false);
  });

  it('hangs after EOF until the fixture-owned watchdog terminates it', async () => {
    const settings = setup('hang');
    const running = launch('cli', settings, [], 1_500);
    running.child.stdin.end('synthetic hang input');
    expect(await running.closed).toEqual({ code: null, signal: 'SIGKILL' });
    expect(running.output()).toEqual({ stdout: '', stderr: '', timedOut: true });
    expect(JSON.parse(readFileSync(settings.recordPath, 'utf8')).stdin).toBe('synthetic hang input');
  });
});

describe('S0 fake stdio MCP mechanics (T-OG-17; no managed services)', () => {
  it('initializes, lists a typed tool and rejects invalid worker calls', async () => {
    const server = mcp(setup());
    const init = await server.response(server.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture-test', version: '1' } }));
    expect(init.result.capabilities).toEqual({ tools: {} });
    server.notify('notifications/initialized', {});
    const listed = await server.response(server.send('tools/list'));
    expect(listed.result.tools[0]).toMatchObject({ name: 'fixture-worker', inputSchema: { required: ['invocationId', 'workspace', 'selection', 'brief'], additionalProperties: false } });
    const invalid = await server.response(server.send('tools/call', { name: 'fixture-worker', arguments: { command: 'untyped command' } }));
    expect(invalid.error).toMatchObject({ code: -32602 });
  });

  it('returns the same claims as CLI and isolates two concurrent workspace/model calls', async () => {
    const settings = setup('late-completion');
    const server = mcp(settings);
    const tasks = [worker('one', path.join(settings.root, 'workspace one'), 'model-one'), worker('two', path.join(settings.root, 'workspace two'), 'model-two')];
    const ids = tasks.map(task => server.send('tools/call', { name: 'fixture-worker', arguments: task }));
    await server.response(server.send('ping'));
    expect(ids.every(id => !server.responses.has(id))).toBe(true);
    // Release in reverse order to expose a shared current-workspace/model bug.
    for (const id of [...ids].reverse()) server.notify('fixture/release', { requestId: id });
    const results = await Promise.all(ids.map(id => server.response(id)));
    for (const [index, message] of results.entries()) {
      const task = tasks[index];
      expect(message.result.isError).toBe(false);
      expect(JSON.parse(message.result.content[0].text)).toEqual(message.result.structuredContent);
      expect(JSON.parse(message.result.structuredContent.summary)).toEqual(task);
      const cliSettings = setup('success', { worker: task });
      const cli = launch('cli', cliSettings);
      cli.child.stdin.end(task.brief);
      expect(await cli.closed).toEqual({ code: 0, signal: null });
      expect(JSON.parse(cli.output().stdout).result).toEqual(message.result.structuredContent);
      expect(await adapter.parseWorkerOutput(message.result, { format: 'mcp', observation: { ...observation, transport: 'mcp', exitCode: null } }))
        .toEqual(await adapter.parseWorkerOutput(cli.output().stdout, { observation }));
    }
    const records = readFileSync(settings.recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const calls = records.filter(record => record.event === 'call');
    expect(calls.map(record => record.worker)).toEqual(tasks);
    expect(calls.every(record => record.envNames.includes('SYNTHETIC_SECRET'))).toBe(true);
    expect(JSON.stringify(records)).not.toContain(syntheticSecret);
  });

  it.each(['isError', 'truncation'])('emits %s without disguising it as valid claims', async scenario => {
    const settings = setup(scenario);
    const server = mcp(settings);
    const message = await server.response(server.send('tools/call', { name: 'fixture-worker', arguments: worker('fault', settings.root) }));
    if (scenario === 'isError') expect(message.result.isError).toBe(true);
    else expect(() => JSON.parse(message.result.content[0].text)).toThrow();
    expect(message.result.structuredContent).toBeUndefined();
    await expect(adapter.parseWorkerOutput(message.result, { format: 'mcp', observation: { ...observation, transport: 'mcp', exitCode: null } })).rejects.toThrow();
  });

  it('advertises a changed input schema so consumers can detect digest drift', async () => {
    const normal = mcp(setup());
    const changed = mcp(setup('schema-change'));
    const baseline = await normal.response(normal.send('tools/list'));
    const drift = await changed.response(changed.send('tools/list'));
    expect(drift.result.tools[0].inputSchema).not.toEqual(baseline.result.tools[0].inputSchema);
  });

  it('stalls one call while continuing to serve ping', async () => {
    const settings = setup('stall');
    const server = mcp(settings);
    const id = server.send('tools/call', { name: 'fixture-worker', arguments: worker('stall', settings.root) });
    expect((await server.response(server.send('ping'))).result).toEqual({});
    expect(server.responses.has(id)).toBe(false);
    expect(JSON.parse(readFileSync(settings.recordPath, 'utf8')).scenario).toBe('stall');
  });

  it('disconnects with a call pending', async () => {
    const settings = setup('disconnect');
    const server = mcp(settings);
    const id = server.send('tools/call', { name: 'fixture-worker', arguments: worker('disconnect', settings.root) });
    await expect(server.response(id)).rejects.toThrow('Fixture disconnected');
    expect(await server.closed).toEqual({ code: 0, signal: null });
    expect(server.responses.has(id)).toBe(false);
    // An unrelated startup/stdio failure must not satisfy the disconnect case.
    expect(JSON.parse(readFileSync(settings.recordPath, 'utf8'))).toMatchObject({
      event: 'call', requestId: id, scenario: 'disconnect', worker: { invocationId: 'disconnect' },
    });
    expect(server.output().stderr).toBe('');
  });

  it('returns a correlated late completion after cancel delivery and an explicit barrier', async () => {
    const settings = setup('late-completion');
    const server = mcp(settings);
    const task = worker('late', settings.root);
    const id = server.send('tools/call', { name: 'fixture-worker', arguments: task });
    server.notify('notifications/cancelled', { requestId: id, reason: 'Synthetic cancellation' });
    await server.response(server.send('ping'));
    expect(server.responses.has(id)).toBe(false);
    server.notify('fixture/release', { requestId: id });
    const late = await server.response(id);
    expect(JSON.parse(late.result.structuredContent.summary)).toEqual(task);
    await expect(adapter.parseWorkerOutput(late.result, { format: 'mcp', observation: { ...observation, transport: 'mcp', exitCode: null, termination: 'uncertain' } })).rejects.toThrow();
    const records = readFileSync(settings.recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.event)).toEqual(['call', 'cancel-delivered', 'late-completion']);
    expect(records.every(record => record.requestId === id)).toBe(true);
  });
});
