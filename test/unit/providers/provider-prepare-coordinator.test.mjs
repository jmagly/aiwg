import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProviderDeployments } from '../../../tools/agents/providers/provider-prepare-coordinator.mjs';
import { main as deployProvider } from '../../../tools/agents/deploy-agents.mjs';
import { signalChild } from '../../../src/process/signal-child.mjs';

vi.mock('node:child_process', { spy: true });

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const workerPath = fileURLToPath(new URL('../../fixtures/providers/provider-prepare-worker-fixture.mjs', import.meta.url));
const parityRunner = fileURLToPath(new URL('../../fixtures/providers/provider-prepare-parity-runner.mjs', import.meta.url));

function inventory(dir) {
  const result = {};
  const visit = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(rel, entry.name), file = path.join(current, entry.name);
      // Required settings backups retain timestamps; compare all bytes and counts
      // while validating the nondeterministic timestamp rather than dropping files.
      let key = name;
      if (entry.name.startsWith('settings.json.bak.')) {
        expect(entry.name).toMatch(/^settings\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
        expect(entry.isFile()).toBe(true);
        key = path.join(rel, `settings.json.bak.${Object.keys(result).filter(item => item.startsWith(path.join(rel, 'settings.json.bak.'))).length}`);
      }
      result[key] = entry.isDirectory() ? 'directory' : createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (entry.isDirectory()) visit(file, name);
    }
  };
  visit(dir); return result;
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-coordinator-test-')); roots.push(root);
  const trace = path.join(root, 'trace');
  const committed = [];
  let stale = true;
  const transaction = {
    createPool: () => ({}),
    describePool: () => ({ version: 1 }),
    disposePool: () => {},
    adopt: plan => plan,
    disposePlan: () => {},
    commit: plan => {
      if (plan.order === 1 && stale) { stale = false; const error = new Error('stale'); error.code = 'AIWG_RULE_DEPLOYMENT_STALE'; throw error; }
      committed.push([plan.order, plan.attempt]);
      return { order: plan.order };
    },
    isStale: error => error?.code === 'AIWG_RULE_DEPLOYMENT_STALE',
  };
  return { root, trace, committed, transaction };
}

describe('provider prepare subprocess coordinator', () => {
  it('starts no further worker after a failure closes the session, even when a sibling finishes cleanly', async () => {
    const h = harness();
    // signal is a no-op, so the in-flight sibling is not terminated and
    // finishes successfully after cleanup has begun. The old loop then took
    // the next job and spawned an untracked worker that outlived the session.
    const failed = prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [
        { order: 0, provider: 'fails', target: h.root, args: ['--fail'] },
        { order: 1, provider: 'slow', target: h.root, args: ['--delay=300'] },
        { order: 2, provider: 'late', target: h.root, args: [] },
      ],
      maxConcurrency: 2,
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
      signal: () => {},
    });
    await expect(failed).rejects.toThrow('fails: fixture failure');
    await new Promise(resolve => setTimeout(resolve, 700));
    const trace = fs.readFileSync(h.trace, 'utf8');
    expect(trace).toContain('start:1:');
    expect(trace).not.toContain('start:2:');
  }, 20_000);

  it.each([0, 7])('drains a response delivered after exit before settling (exit %i)', async exitCode => {
    const h = harness();
    const immediateWorker = path.join(h.root, 'immediate-worker.mjs');
    fs.writeFileSync(immediateWorker, `
      import fs from 'node:fs';
      import { createHash } from 'node:crypto';
      process.once('message', request => {
        const body = Buffer.from(JSON.stringify({ order: request.order, attempt: request.attempt }));
        const file = request.scratch + '/plan.json';
        fs.writeFileSync(file, body);
        process.send({ version: 1, type: 'prepared', capability: request.capability, jobId: request.jobId,
          plan: { path: file, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
        }, () => process.exit(${exitCode}));
      });
    `);
    const { fork: realFork } = await vi.importActual('node:child_process');
    const events = [];
    vi.mocked(fork).mockImplementationOnce((...args) => {
      const child = realFork(...args);
      const emit = child.emit;
      let exited = false;
      let pendingMessage;
      let pendingDisconnect = false;
      // Delay delivery at the parent's event boundary, simulating slow IPC
      // draining without relying on scheduler timing or machine load. Keep the
      // real process exit, IPC channel and close events intact.
      child.emit = function (event, ...values) {
        if (event === 'message' && !exited) { pendingMessage = values; return true; }
        if (event === 'disconnect' && !exited) { pendingDisconnect = true; return true; }
        if (event === 'exit') {
          exited = true;
          events.push(event);
          const result = emit.call(this, event, ...values);
          if (pendingMessage) this.emit('message', ...pendingMessage);
          if (pendingDisconnect) this.emit('disconnect');
          return result;
        }
        if (event === 'message' || event === 'disconnect' || event === 'close') events.push(event);
        return emit.call(this, event, ...values);
      };
      return child;
    });
    const preparing = prepareProviderDeployments({ srcRoot: h.root,
      jobs: [{ order: 0, provider: 'immediate', target: h.root, args: [] }],
      workerPath: immediateWorker, transaction: h.transaction });
    if (exitCode === 0) {
      const session = await preparing;
      try { expect(await session.commit(0)).toEqual({ order: 0 }); }
      finally { await session.dispose(); }
    } else {
      await expect(preparing).rejects.toThrow('worker exited 7 after responding for immediate');
      expect(h.committed).toEqual([]);
    }
    expect(events.slice(0, 3)).toEqual(['exit', 'message', 'disconnect']);
  });

  it('keeps a worker alive until an unref-only asynchronous preparation sends its reply', async () => {
    const h = harness();
    await expect(prepareProviderDeployments({ srcRoot: h.root,
      jobs: [{ order: 0, provider: 'fixture', target: h.root, args: ['--unref-delay-unheld', '--delay=100'] }],
      workerPath, workerEnv: { AIWG_COORDINATOR_TRACE: h.trace }, transaction: h.transaction }))
      .rejects.toThrow(/worker exited 0/);
    const session = await prepareProviderDeployments({ srcRoot: h.root,
      jobs: [{ order: 0, provider: 'fixture', target: h.root, args: ['--unref-delay', '--delay=100'] }],
      workerPath, workerEnv: { AIWG_COORDINATOR_TRACE: h.trace }, transaction: h.transaction });
    try { expect(await session.commit(0)).toEqual({ order: 0 }); }
    finally { await session.dispose(); }
  });

  it('matches serial provider projection bytes and directory membership', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-parity-test-')); roots.push(root);
    const source = path.join(root, 'source');
    const serial = path.join(root, 'serial');
    const concurrent = path.join(root, 'concurrent');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    for (const target of [serial, concurrent]) {
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{"version":"fixture"}\n');
    }
    fs.writeFileSync(path.join(source, 'rules', 'guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\n\nFollow the fixture.\n');
    const argsFor = (provider, target) => ['--source', source, '--target', target, '--provider', provider,
      '--rules-only', '--deploy-rules', '--quiet', '--skip-commands-migration'];
    await deployProvider(argsFor('cursor', serial));
    await deployProvider(argsFor('claude', serial));

    const session = await prepareProviderDeployments({
      srcRoot: source,
      jobs: ['cursor', 'claude'].map((provider, order) => ({ order, provider, target: concurrent, args: argsFor(provider, concurrent) })),
    });
    try { await session.commit(0); await session.commit(1); } finally { await session.dispose(); }
    expect(inventory(concurrent)).toEqual(inventory(serial));
  });

  it('retains boundary version and context opt-out across worker preparation (#3459, #3476)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-b3-worker-policy-')); roots.push(root);
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"source-version"}');
    fs.writeFileSync(path.join(source, 'rules', 'guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\nGuard.\n');
    const sentinel = 'SENTINEL\r\n<!-- AIWG:rule-startup:start -->\nOLD\n<!-- AIWG:rule-startup:end -->\n';
    for (const name of ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md']) fs.writeFileSync(path.join(target, name), sentinel);
    const jobs = ['claude', 'pi'].map((provider, order) => ({ order, provider, target,
      args: ['--source', source, '--target', target, '--provider', provider, '--kernel-only',
        '--no-context-files', '--deploy-version', 'boundary-version', '--skip-commands-migration', '--quiet'] }));
    const session = await prepareProviderDeployments({ srcRoot: source, jobs });
    try { for (const job of jobs) await session.commit(job.order); }
    finally { await session.dispose(); }
    for (const name of ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md']) expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(sentinel);
    for (const provider of ['claude', 'pi']) {
      for (const name of ['guard.md', 'RULES-INDEX.md']) {
        expect(fs.readFileSync(path.join(target, `.${provider}/rules`, name), 'utf8')).toContain('aiwg:managed vboundary-version bundled');
      }
    }
  }, 90_000);

  it('matches serial Codex, Hermes and Pi project deployment including shared roots and receipts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-real-parity-')); roots.push(root);
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(source, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'kernel-demo'), { recursive: true });
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'agents', 'demo.md'), '---\nname: demo\ndescription: Demo agent\nmodel: sonnet\n---\nDemo.\n');
    fs.writeFileSync(path.join(source, 'commands', 'demo.md'), '---\ndescription: Demo command\n---\nDo demo $@.\n');
    fs.writeFileSync(path.join(source, 'skills', 'kernel-demo', 'SKILL.md'), '---\nname: kernel-demo\ndescription: Demo kernel skill\nkernel: true\n---\nDemo skill.\n');
    fs.writeFileSync(path.join(source, 'rules', 'guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\nFollow fixture.\n');

    const scenario = path.join(root, 'scenario');
    const target = path.join(scenario, 'target');
    const home = path.join(scenario, 'home');
    let serialTarget;
    let serialHome;
    for (const mode of ['serial', 'concurrent']) {
      fs.rmSync(scenario, { recursive: true, force: true });
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      const run = spawnSync(process.execPath, ['--import', 'tsx', parityRunner, mode, source, target], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, HERMES_HOME: path.join(home, 'hermes'),
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
          AIWG_USER_REGISTRY_PATH: path.join(home, '.config', 'aiwg', 'installed.json') },
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      if (mode === 'serial') {
        serialTarget = inventory(target);
        serialHome = inventory(home);
      }
    }
    expect(inventory(target)).toEqual(serialTarget);
    expect(inventory(home)).toEqual(serialHome);
  }, 90_000);

  it('matches default serial command migration and full Claude/Cursor projection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-migration-parity-')); roots.push(root);
    const source = path.join(root, 'source');
    const scenario = path.join(root, 'scenario');
    const target = path.join(scenario, 'target');
    const home = path.join(scenario, 'home');
    fs.mkdirSync(path.join(source, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'kernel-demo'), { recursive: true });
    fs.writeFileSync(path.join(source, 'commands', 'demo.md'), '---\ndescription: Demo command\n---\nDo demo.\n');
    fs.writeFileSync(path.join(source, 'skills', 'kernel-demo', 'SKILL.md'), '---\nname: kernel-demo\ndescription: Demo kernel skill\nkernel: true\n---\nDemo skill.\n');
    let serialTarget;
    for (const mode of ['serial', 'concurrent']) {
      fs.rmSync(scenario, { recursive: true, force: true });
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{"version":"fixture"}\n');
      for (const provider of ['claude', 'cursor']) {
        const commands = path.join(target, `.${provider}`, 'commands');
        fs.mkdirSync(commands, { recursive: true });
        fs.writeFileSync(path.join(commands, 'legacy.md'), '<!-- aiwg:managed version=old source=bundled -->\nLegacy.\n');
      }
      const run = spawnSync(process.execPath, ['--import', 'tsx', parityRunner, mode, source, target, 'claude,cursor'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
          AIWG_USER_REGISTRY_PATH: path.join(home, '.config', 'aiwg', 'installed.json') },
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      if (mode === 'serial') serialTarget = inventory(target);
    }
    expect(inventory(target)).toEqual(serialTarget);
    expect(fs.existsSync(path.join(target, '.claude', 'commands', 'legacy.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.cursor', 'commands', 'legacy.md'))).toBe(false);
  }, 90_000);

  it('bounds child preparation at two and commits only in declared order', async () => {
    const h = harness();
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [0, 1, 2].map(order => ({ order, provider: `p${order}`, target: h.root, args: [`--delay=${order === 2 ? 5 : 80}`] })),
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    await session.commit(0);
    await session.commit(1);
    await session.commit(2);
    expect(h.committed).toEqual([[0, 0], [1, 1], [2, 0]]);
    const events = fs.readFileSync(h.trace, 'utf8').trim().split('\n').map(line => line.split(':'));
    const start2 = Number(events.find(([kind, order]) => kind === 'start' && order === '2')[2]);
    const firstEnd = Math.min(...events.filter(([kind]) => kind === 'end').map(([, , time]) => Number(time)));
    expect(start2).toBeGreaterThanOrEqual(firstEnd);
    await session.dispose();
  });

  it('does not expose a prepared plan until the responding worker has exited', async () => {
    const h = harness();
    const started = Date.now();
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [{ order: 0, provider: 'linger', target: h.root, args: ['--linger=80'] }],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    await session.dispose();
  });

  it('fails closed, terminates siblings and removes coordinator scratch', async () => {
    const h = harness();
    let scratch;
    await expect(prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [
        { order: 0, provider: 'bad', target: h.root, args: ['--fail', '--wait-for-sibling'] },
        { order: 1, provider: 'slow', target: h.root, args: ['--hold-for-termination'] },
      ],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
      timeoutMs: 60_000,
      onSessionRoot: root => { scratch = root; },
    })).rejects.toThrow(/fixture failure/);
    const events = fs.readFileSync(h.trace, 'utf8').trim().split('\n');
    expect(events.some(line => line.startsWith('start:1:'))).toBe(true);
    const term = events.find(line => line.startsWith('term:1:'));
    expect(term).toBeDefined();
    const pid = term.split(':')[2];
    expect(events.some(line => line.startsWith(`exit:1:${pid}:`))).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(h.committed).toEqual([]);
  });

  it.each(['throw', 'refuse'])('keeps scratch until sibling exits when TERM can %s', async mode => {
    const h = harness();
    let scratch, sawEscalation = false, sawExit = false;
    await expect(prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [
        { order: 0, provider: 'bad', target: h.root, args: ['--fail', '--wait-for-sibling'] },
        { order: 1, provider: 'slow', target: h.root, args: ['--hold-for-termination'] },
      ],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
      timeoutMs: 60_000,
      onSessionRoot: root => { scratch = root; },
      signal(child, name) {
        if (name === 'SIGTERM') {
          child.once('exit', () => { sawExit = true; });
          if (mode === 'throw') throw new Error('synthetic TERM failure');
          return false;
        }
        expect(name).toBe('SIGKILL');
        expect(fs.existsSync(scratch)).toBe(true);
        sawEscalation = true;
        return signalChild(child, name);
      },
    })).rejects.toThrow(/fixture failure/);
    expect(sawEscalation).toBe(true);
    expect(sawExit).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it('permits one stale retry and rejects a repeated stale result', async () => {
    const h = harness();
    h.transaction.commit = () => { const error = new Error('stale'); error.code = 'AIWG_RULE_DEPLOYMENT_STALE'; throw error; };
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [{ order: 0, provider: 'p0', target: h.root, args: [] }],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    await expect(session.commit(0)).rejects.toMatchObject({ code: 'AIWG_RULE_DEPLOYMENT_STALE' });
    expect(fs.readFileSync(h.trace, 'utf8').match(/start:0:/g)).toHaveLength(2);
    await session.dispose();
  });

  it('allows the next provider to commit after an owning provider exhausts its stale retry', async () => {
    const h = harness();
    h.transaction.commit = plan => {
      if (plan.order === 0) { const error = new Error('shared path changed'); error.code = 'AIWG_RULE_DEPLOYMENT_STALE'; throw error; }
      return { order: plan.order };
    };
    const session = await prepareProviderDeployments({ srcRoot: h.root,
      jobs: [0, 1].map(order => ({ order, provider: `p${order}`, target: h.root, args: [] })),
      workerPath, workerEnv: { AIWG_COORDINATOR_TRACE: h.trace }, transaction: h.transaction });
    try {
      await expect(session.commit(0)).rejects.toThrow('shared path changed');
      await expect(session.commit(1)).resolves.toEqual({ order: 1 });
    } finally { await session.dispose(); }
  });
});
