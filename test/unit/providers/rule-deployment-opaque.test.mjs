// Verify provider runtime entries stay outside staged deployment output.
import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  prepareRuleDeployment, commitRuleDeploymentPlan, disposeRuleDeploymentPlan,
  detachRuleDeploymentPlan, adoptRuleDeploymentPlan, RuleDeploymentStaleError,
} from '../../../tools/agents/providers/rule-delivery.mjs';
import {
  capturePreimage, materializeInput, materializedPreimage, validPreimageState,
} from '../../../tools/agents/providers/rule-deployment-state.mjs';
import { createStagedDirectoryReference } from '../../../tools/agents/providers/staged-directory-reference.mjs';

const simulatePlatform = usePlatformSimulation({ afterEach });

const roots = [], plans = [], servers = [];
const nativePlatform = process.platform;
afterEach(async () => {
  vi.restoreAllMocks();
  plans.splice(0).forEach(disposeRuleDeploymentPlan);
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture(name = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-opaque-'));
  roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'home');
  const mounted = path.join(target, `.${name}`);
  fs.mkdirSync(source);
  fs.mkdirSync(mounted, { recursive: true });
  fs.writeFileSync(path.join(source, 'asset.md'), 'source');
  fs.writeFileSync(path.join(target, 'AGENTS.md'), 'original');
  const provider = { name, paths: { rules: `.${name}/rules` } };
  const opts = { srcRoot: source, target, mode: 'all', deployVersion: '2026.11.4', ruleSources: [], bindingEntries: [],
    deployBehaviors: false, pinConfigs: { project: {}, user: {} }, quiet: true };
  const deploy = async ({ target: stage }) => {
    fs.writeFileSync(path.join(stage, 'AGENTS.md'), 'updated');
    fs.mkdirSync(path.join(stage, `.${name}`, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(stage, `.${name}`, 'rules', 'generated.md'), 'generated');
  };
  return { root, source, target, mounted, provider, opts, deploy };
}

// Reading link targets may update atime; identity and mutation times must stay fixed.
function entryIdentity(file) {
  const { dev, ino, mode, size, mtimeNs, ctimeNs } = fs.lstatSync(file, { bigint: true });
  return { dev, ino, mode, size, mtimeNs, ctimeNs };
}

async function prepare(f, check = () => {}) {
  const plan = await prepareRuleDeployment(f.opts, f.provider, async opts => {
    check(path.join(opts.target, `.${f.provider.name}`));
    await f.deploy(opts);
  });
  plans.push(plan);
  return plan;
}

function dangling(f, windows = false) {
  const dir = path.join(f.mounted, 'debug');
  fs.mkdirSync(dir);
  const link = path.join(dir, 'latest');
  if (windows) {
    simulatePlatform('win32');
    const spy = vi.spyOn(fs, 'symlinkSync');
    createStagedDirectoryReference(path.join(dir, 'missing directory'), link);
    expect(spy).toHaveBeenCalledWith(path.resolve(dir, 'missing directory'), link, 'junction');
    spy.mockRestore();
  } else fs.symlinkSync('missing.txt', link);
  return link;
}

describe('dangling provider links (#4025)', () => {
  it.each([false, true])('deploys with an untouched dangling link (emulated win32: %s)', async windows => {
    const f = fixture(), link = dangling(f, windows);
    const before = entryIdentity(link), target = fs.readlinkSync(link);
    const plan = await prepare(f, stage => {
      expect(capturePreimage(path.join(stage, 'debug', 'latest'))).toEqual({ kind: 'missing' });
    });
    expect(plan.preimages.find(item => item.path === f.mounted).state.entries[0][1].entries[0][1])
      .toMatchObject({ kind: 'symlink', target, resolved: { kind: 'missing' } });
    commitRuleDeploymentPlan(plan);
    expect(entryIdentity(link)).toEqual(before);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toContain('updated');
    expect(fs.readFileSync(path.join(f.mounted, 'rules', 'generated.md'), 'utf8')).toBe('generated');
  });

  it.each(['retargeted', 'resolved', 'removed'])('rejects a dangling link %s between capture and promotion', async change => {
    const f = fixture(), link = dangling(f);
    const plan = await prepare(f);
    if (change === 'resolved') fs.writeFileSync(path.join(path.dirname(link), 'missing.txt'), 'new content');
    else {
      fs.unlinkSync(link);
      if (change === 'retargeted') fs.symlinkSync('different-missing.txt', link);
    }
    expect(() => commitRuleDeploymentPlan(plan)).toThrowError(RuleDeploymentStaleError);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(f.mounted, 'rules', 'generated.md'))).toBe(false);
  });
});

describe('opaque provider entries (#4026)', () => {
  it.each([false, true])('treats an unrecognized special type as opaque (emulated win32: %s)', async windows => {
    const f = fixture('codex'), opaque = path.join(f.mounted, 'runtime-entry');
    fs.writeFileSync(opaque, 'opaque sentinel');
    const before = entryIdentity(opaque);
    for (const method of ['lstatSync', 'statSync']) {
      const original = fs[method];
      vi.spyOn(fs, method).mockImplementation((file, options) => {
        const stat = original(file, options);
        if (String(file) !== opaque || options?.bigint) return stat;
        return { ...stat, mode: stat.mode & ~fs.constants.S_IFMT,
          isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
      });
    }
    if (windows) simulatePlatform('win32');
    const state = capturePreimage(opaque);
    expect(state).toMatchObject({ kind: 'special', type: 0 });
    expect(validPreimageState(state)).toBe(true);
    const plan = await prepare(f, stage => {
      expect(capturePreimage(path.join(stage, 'runtime-entry'))).toEqual({ kind: 'missing' });
    });
    commitRuleDeploymentPlan(plan);
    expect(entryIdentity(opaque)).toEqual(before);
    expect(fs.readFileSync(opaque, 'utf8')).toBe('opaque sentinel');
  });

  // Real Unix socket/FIFO fixtures require POSIX; Windows opaque handling is exercised below.
  it.runIf(nativePlatform !== 'win32').each([false, true])('deploys while IPC is listening and preserves the socket (emulated win32: %s)', async windows => {
    const f = fixture('codex'), ipc = path.join(f.mounted, 'ipc');
    fs.mkdirSync(ipc);
    const socket = path.join(ipc, 'ipc.sock'), server = net.createServer(client => client.end('alive'));
    servers.push(server);
    server.listen(socket);
    await once(server, 'listening');
    const before = fs.lstatSync(socket, { bigint: true });
    if (windows) simulatePlatform('win32');
    const plan = await prepare(f, stage => {
      expect(capturePreimage(path.join(stage, 'ipc', 'ipc.sock'))).toEqual({ kind: 'missing' });
    });
    const state = capturePreimage(socket);
    expect(state).toMatchObject({ kind: 'special', type: fs.constants.S_IFSOCK });
    expect(validPreimageState(state)).toBe(true);
    commitRuleDeploymentPlan(plan);
    expect(fs.lstatSync(socket, { bigint: true })).toEqual(before);
    const client = net.createConnection(socket);
    let reply = '';
    client.on('data', data => { reply += data; });
    await once(client, 'close');
    expect(reply).toBe('alive');
    expect(fs.readFileSync(path.join(f.mounted, 'rules', 'generated.md'), 'utf8')).toBe('generated');
  });

  it.runIf(nativePlatform !== 'win32')('records a FIFO without reading or copying it and accepts a transferred plan', async () => {
    const f = fixture('codex'), fifo = path.join(f.mounted, 'runtime.pipe');
    execFileSync('mkfifo', [fifo], { timeout: 10_000 });
    const before = fs.lstatSync(fifo, { bigint: true });
    const scratch = path.join(f.root, 'scratch');
    fs.mkdirSync(scratch);
    f.opts.ruleDeploymentScratch = scratch;
    const child = await prepare(f, stage => {
      expect(capturePreimage(path.join(stage, 'runtime.pipe'))).toEqual({ kind: 'missing' });
    });
    const detached = JSON.parse(JSON.stringify(detachRuleDeploymentPlan(child)));
    const adopted = adoptRuleDeploymentPlan(detached, {
      scratch, target: f.target, cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }),
    });
    plans.push(adopted);
    expect(capturePreimage(fifo)).toMatchObject({ kind: 'special', type: fs.constants.S_IFIFO });
    commitRuleDeploymentPlan(adopted);
    expect(fs.lstatSync(fifo, { bigint: true })).toEqual(before);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toContain('updated');
  });

  it.runIf(nativePlatform !== 'win32')('detects replacement of an opaque entry before promoting any output', async () => {
    const f = fixture('codex'), fifo = path.join(f.mounted, 'runtime.pipe');
    execFileSync('mkfifo', [fifo], { timeout: 10_000 });
    const plan = await prepare(f);
    fs.unlinkSync(fifo);
    fs.writeFileSync(fifo, 'operator replacement');
    expect(() => commitRuleDeploymentPlan(plan)).toThrowError(RuleDeploymentStaleError);
    expect(fs.readFileSync(fifo, 'utf8')).toBe('operator replacement');
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
  });

  it.runIf(nativePlatform !== 'win32')('keeps normalization consistent for nested links to missing and special entries', () => {
    const f = fixture('codex');
    const pipe = path.join(f.mounted, 'pipe');
    execFileSync('mkfifo', [pipe], { timeout: 10_000 });
    fs.symlinkSync('pipe', path.join(f.mounted, 'pipe-alias'));
    fs.symlinkSync('absent', path.join(f.mounted, 'missing-alias'));
    const state = capturePreimage(f.mounted), staged = path.join(f.root, 'materialized');
    materializeInput(f.mounted, staged);
    expect(capturePreimage(staged)).toEqual(materializedPreimage(state));
    expect(fs.readdirSync(staged)).toEqual([]);
    expect(validPreimageState(state)).toBe(true);
    expect(validPreimageState({ kind: 'special', mode: 0o600, type: 'socket' })).toBe(false);
  });
});
