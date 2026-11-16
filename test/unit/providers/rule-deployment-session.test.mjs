// Compare serial update pooling with standalone staging using identical output paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importImpl } from '../../../tools/_resolve-impl.mjs';
import * as codex from '../../../tools/agents/providers/codex.mjs';
import { deployWithRuleDelivery } from '../../../tools/agents/providers/rule-delivery.mjs';
import { measureProviderStaging, sessionInputPool } from '../../../tools/agents/providers/rule-deployment-input-session.mjs';

const { withDeploymentInputSession } = await importImpl(import.meta.url, 'providers/deployment-input-session.mjs');
let root, source, target;
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const tree = dir => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(dir, file), fs.readFileSync(file).toString('base64')];
  }));
const provider = { name: 'codex', paths: { agents: '.codex/agents', rules: '.codex/rules' }, kernelSkillsPath: '.agents/skills' };
const deploy = async opts => {
  const file = path.join(opts.target, '.codex/agents/demo.md');
  write(file, fs.readFileSync(path.join(opts.srcRoot, 'asset.md')));
  write(path.join(opts.target, '.agents/skills/demo/resource.bin'), fs.readFileSync(path.join(opts.srcRoot, 'resource.bin')));
  write(path.join(opts.target, 'AGENTS.md'), `Input: ${opts.srcRoot}\n`);
};
const options = () => ({ srcRoot: source, target, mode: 'sdlc', config: {}, deployVersion: '2026.11.7',
  deployBehaviors: false, ruleSources: [], bindingEntries: [], pinConfigs: { project: {}, user: {} }, quiet: true });
const run = () => deployWithRuleDelivery(options(), provider, deploy);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-staging-session-'));
  source = path.join(root, 'source'); target = path.join(root, 'project');
  fs.mkdirSync(target);
  write(path.join(source, 'asset.md'), '# original input\n');
  write(path.join(source, 'resource.bin'), Buffer.from([0, 255, 17, 0]));
  vi.stubEnv('AIWG_ROOT', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('serial deployment input reuse', () => {
  it.each([false, true])('correlates resolved corpus sources and snapshot status (failure %s)', async fail => {
    const bundle = path.join(source, 'agentic/code/addons/demo');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(path.join(source, 'agentic/code/frameworks'), { recursive: true });
    write(path.join(bundle, 'asset.md'), '# bundle\n');
    const failure = new Error('synthetic snapshot failure');
    if (fail) vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw failure; });
    const events = [];
    const timings = channel('aiwg.provider-staging');
    const listener = event => events.push(event);
    timings.subscribe(listener);
    try {
      const work = withDeploymentInputSession(() => measureProviderStaging({ srcRoot: bundle }, provider,
        async () => sessionInputPool(bundle)));
      if (fail) await expect(work).rejects.toBe(failure);
      else await work;
      expect(events).toEqual([
        { phase: 'snapshot-provider-inputs', source, durationMs: expect.any(Number), status: fail ? 'failed' : 'succeeded' },
        { phase: 'prepare-provider-staging', source, provider: 'codex', durationMs: expect.any(Number), status: fail ? 'failed' : 'prepared' },
      ]);
    } finally { timings.unsubscribe(listener); }
  });

  it('copies the corpus once for unchanged passes and preserves every output byte for fresh and changed inputs', async () => {
    await run();
    const fresh = tree(target);
    write(path.join(source, 'asset.md'), '# changed input\n');
    await run();
    const changed = tree(target);
    expect(changed).not.toEqual(fresh);
    fs.rmSync(target, { recursive: true }); fs.mkdirSync(target);
    write(path.join(source, 'asset.md'), '# original input\n');
    const copy = vi.spyOn(fs, 'copyFileSync');
    await withDeploymentInputSession(async () => {
      await run();
      expect(tree(target)).toEqual(fresh);
      await run();
      expect(tree(target)).toEqual(fresh);
    });
    const copies = () => copy.mock.calls.filter(([from]) => from === path.join(source, 'asset.md'));
    expect(copies()).toHaveLength(1);
    expect(fs.existsSync(path.dirname(copies()[0][1]))).toBe(false);
    write(path.join(source, 'asset.md'), '# changed input\n');
    await withDeploymentInputSession(run);
    expect(copies()).toHaveLength(2);
    expect(tree(target)).toEqual(changed);
  });

  it('keeps real Codex agent deployment byte-identical on fresh install and changed-input redeploy', async () => {
    const agent = path.join(source, 'agents/demo.md');
    const body = suffix => `---\nname: demo\ndescription: Synthetic agent\nmodel: sonnet\n---\n${suffix}\n`;
    const runCodex = () => codex.deploy({ ...options(), provider: 'codex' });
    write(agent, body('original'));
    await runCodex();
    const fresh = tree(target);
    expect(Object.keys(fresh)).toContain('.codex/agents/demo.toml');
    write(agent, body('changed'));
    await runCodex();
    const changed = tree(target);
    expect(changed).not.toEqual(fresh);
    fs.rmSync(target, { recursive: true }); fs.mkdirSync(target);
    write(agent, body('original'));
    await withDeploymentInputSession(runCodex);
    expect(tree(target)).toEqual(fresh);
    write(agent, body('changed'));
    await withDeploymentInputSession(runCodex);
    expect(tree(target)).toEqual(changed);
  });

  it('rejects live-source drift on reuse, cleans up, and measures each staging call', async () => {
    const events = [];
    const timings = channel('aiwg.provider-staging');
    const listener = event => events.push(event);
    timings.subscribe(listener);
    const copy = vi.spyOn(fs, 'copyFileSync');
    try {
      await expect(withDeploymentInputSession(async () => {
        await run();
        write(path.join(source, 'asset.md'), '# operator edit\n');
        await run();
      })).rejects.toThrow(/preimage changed/);
      const copies = copy.mock.calls.filter(([from]) => from === path.join(source, 'asset.md'));
      expect(copies).toHaveLength(1);
      expect(fs.existsSync(path.dirname(copies[0][1]))).toBe(false);
      expect(events.filter(event => event.phase === 'snapshot-provider-inputs')).toHaveLength(1);
      expect(events.filter(event => event.phase === 'prepare-provider-staging')).toHaveLength(2);
      expect(events.every(event => typeof event.durationMs === 'number')).toBe(true);
      await expect(withDeploymentInputSession(() => deployWithRuleDelivery(options(), provider, async () => {
        throw new Error('synthetic projection failure');
      }))).rejects.toThrow('synthetic projection failure');
      expect(events.at(-1)).toMatchObject({ phase: 'prepare-provider-staging', status: 'failed' });
      const lastCopy = copy.mock.calls.filter(([from]) => from === path.join(source, 'asset.md')).at(-1);
      expect(fs.existsSync(path.dirname(lastCopy[1]))).toBe(false);
    } finally { timings.unsubscribe(listener); }
  });
});
