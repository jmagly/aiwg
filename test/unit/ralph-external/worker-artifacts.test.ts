import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
/** Bounded execution-time artifact and invocation regression coverage. */
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, readdir, rename } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { resolveWorkerInvocation, revalidateWorkerInvocationPlan } from '../../../src/serve/worker-invocation.js';
import { materializeWorkerArtifacts } from '../../../tools/ralph-external/session-launcher.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const simulatePlatform = usePlatformSimulation({ afterEach });

const roots: string[] = [], breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = (options: any = {}) => workerInvocationFixture(options, { roots, breakers });
const withStopProof = (options: any) => {
  const launched = launchIsolatedWorker(options);
  const attach = (outcome: any) => ({ ...outcome, mode: 'systemd-unit', unit: 'aiwg-worker-artifact-fixture' });
  return launched?.then ? launched.then(attach) : attach(launched);
};

describe('T-OG-15 execution-time artifacts and adapter stdin (#3002/#2998)', () => {
  it('records substituted launch argv and artifact byte digests without contents', async () => {
    const content = 'private patch 雪';
    const f = await fixture({ artifacts: [{ name: 'patch', content }] });
    const launchIsolated = vi.fn((_options: any) => { throw new Error('stop after recording launch argv'); });
    await expect(f.launch({ launchIsolated })).rejects.toThrow('stop after recording launch argv');
    const launched = launchIsolated.mock.calls[0][0] as any;
    const argv = [launched.command, ...launched.args];
    expect(argv).toContain(path.join(f.runDir, 'artifact-patch'));
    const raw = await readFile(path.join(f.runDir, 'invocation.json'), 'utf8');
    const record = JSON.parse(raw);
    const { createHash } = await import('node:crypto');
    const bytesDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    expect(record.argv).toEqual(argv.map((token, i) => i === 0 ? token : `<argument:${bytesDigest(token)}>`));
    expect(record.commandDisplay).toBe(record.argv.map((token: string) => JSON.stringify(token)).join(' '));
    expect(record.executedArgvDigest).toBe(qualificationDigest(argv));
    expect(record.placeholderArgvDigest).toBe(qualificationDigest(f.plan.invocation!.argv));
    expect(record.argvDigest).toBe(record.placeholderArgvDigest);
    expect(record.artifacts).toEqual([{ name: 'patch', byteLength: Buffer.byteLength(content), sha256: bytesDigest(content) }]);
    expect(raw).not.toContain(content);
    expect(raw).not.toContain(f.prompt);
    expect(raw).not.toContain('secret-environment-value');
    expect((await readdir(f.runDir)).filter(name => name.startsWith('artifact-'))).toEqual([]);
  });
  it.each(['stdoutPath', 'stderrPath', 'finalPath'])('refuses %s in the reserved artifact namespace before writes or spawn', async field => {
    const f = await fixture({ artifacts: [{ name: 'patch', content: 'private patch' }] });
    await mkdir(f.runDir, { mode: 0o700 });
    const qualified = structuredClone(f.plan.invocation!);
    qualified[field as 'stdoutPath' | 'stderrPath' | 'finalPath'] = path.join(f.runDir, 'artifact-patch');
    const owner = await import('../../../src/serve/worker-invocation.js');
    vi.spyOn(owner, 'revalidateWorkerInvocationPlan').mockResolvedValue(qualified);
    const launchIsolated = vi.fn();
    await expect(f.launch({ launchIsolated })).rejects.toThrow(/distinct.*artifact/i);
    expect(launchIsolated).not.toHaveBeenCalled();
    expect(await readdir(f.runDir)).toEqual([]);
  });
  it.each(['', Buffer.alloc(0), new Uint8Array(0)])('rejects an empty adapter frame %j', async frame => {
    const { workerStdinBytes } = await import('../../../src/serve/worker-stdin-frame.mjs');
    expect(() => workerStdinBytes({ stdin: 'adapter-frame' }, 'brief', { buildWorkerStdinFrame: () => frame })).toThrow(/empty/i);
  });
  async function privateRun() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-artifacts-')); roots.push(root);
    const runDir = path.join(root, 'run'); await mkdir(runDir, { mode: 0o700 });
    return { root, runDir };
  }
  const declaration = (name = 'patch') => ({ argv: [process.execPath, `\${artifact:${name}}`],
    artifacts: [{ name, content: 'synthetic patch', location: 'run-directory' }] });
  it('creates distinct private paths concurrently, mode 0600, then cleans both', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const a = await privateRun(), b = await privateRun();
    const [first, second] = await Promise.all([materializeWorkerArtifacts(declaration(), a.runDir), materializeWorkerArtifacts(declaration(), b.runDir)]);
    expect(first.argv[1]).not.toBe(second.argv[1]);
    for (const result of [first, second]) {
      expect((await lstat(result.argv[1])).mode & 0o777).toBe(0o600);
      expect(await readFile(result.argv[1], 'utf8')).toBe('synthetic patch');
      await result.cleanup();
      expect(await readdir(path.dirname(result.argv[1]))).toEqual([]);
    }
  });
  it.each(['existing', 'symlink'])('refuses a %s path and cleans files created before the refusal', async scenario => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const { root, runDir } = await privateRun();
    const blocked = path.join(runDir, 'artifact-blocked');
    const target = path.join(root, 'target'); await writeFile(target, 'original');
    if (scenario === 'symlink') await symlink(target, blocked); else await writeFile(blocked, 'original');
    const invocation = declaration(); invocation.artifacts.push({ name: 'blocked', content: 'overwrite', location: 'run-directory' });
    await expect(materializeWorkerArtifacts(invocation, runDir)).rejects.toThrow();
    expect(await readdir(runDir)).toEqual(['artifact-blocked']);
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readFile(blocked, 'utf8')).toBe('original');
  });
  it.each(['../escape', '.hidden', 'a/b', 'a\\b', 'name\n', '', 'x'.repeat(65)])('refuses artifact name %j', async name => {
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    await expect(materializeWorkerArtifacts(declaration(name), '/nonexistent')).rejects.toThrow();
  });
  it('bounds count, per-file and total UTF-8 bytes, rejects unknown locations/placeholders before writes', async () => {
    const { materializeWorkerArtifacts } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const cases = [
      { ...declaration(), artifacts: Array.from({ length: 17 }, (_, i) => ({ name: `a${i}`, content: '' })) },
      { ...declaration(), artifacts: [{ name: 'patch', content: '雪'.repeat(400000) }] },
      { ...declaration(), artifacts: Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, content: 'x'.repeat(1048576) })) },
      { ...declaration(), artifacts: [{ name: 'patch', content: '', location: 'workspace' }] },
      { ...declaration(), artifacts: [] },
    ];
    for (const invocation of cases) await expect(materializeWorkerArtifacts(invocation, '/nonexistent')).rejects.toThrow();
  });
  it('bounds exact adapter bytes and rejects missing/nonbyte framers and unknown stdin', async () => {
    const { workerStdinBytes } = await import('../../../src/serve/worker-stdin-frame.mjs');
    const invocation = { stdin: 'adapter-frame' as const };
    expect(() => workerStdinBytes(invocation, 'brief')).toThrow(/framer/);
    expect(() => workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => ({}) as any })).toThrow(/bytes/);
    expect(() => workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => Buffer.alloc(1048577) })).toThrow(/bound/);
    const bytes = Buffer.from([0, 1, 255, 10]);
    expect(workerStdinBytes(invocation, 'brief', { buildWorkerStdinFrame: () => bytes })).toEqual(bytes);
    expect(() => workerStdinBytes({ stdin: 'other' } as any, 'brief')).toThrow(/Unsupported/);
  });
  it.each(['spawn', 'capture', 'gate'])('cleans launcher-written artifacts when %s preparation fails', async stage => {
    const f = await fixture({ artifacts: [{ name: 'patch', content: 'synthetic patch' }] });
    let calls = 0;
    const extra = stage === 'spawn' ? { launchIsolated: () => { throw new Error('synthetic spawn refusal'); } }
      : stage === 'capture' ? { openCapture: () => { throw new Error('synthetic capture refusal'); } }
      : { checkDispatch: () => ({ ok: calls++ === 0, enabled: true, failures: [] }) };
    await expect(f.launch(extra)).rejects.toThrow();
    expect((await readdir(f.runDir)).filter(name => name.startsWith('artifact-'))).toEqual([]);
  });
  it('the attached launcher delivers the adapter NDJSON frame and closes stdin', async () => {
    const f = await fixture({ stdin: 'brief-text' });
    const { AntigravityAdapter } = await import('../../../tools/ralph-external/lib/antigravity-adapter.mjs');
    const agy = new AntigravityAdapter();
    f.drivers.codex.buildWorkerStdinFrame = (brief: any) => agy.buildWorkerStdinFrame(brief);
    f.drivers.codex.qualification.stdinFramerBinding = { storePath: path.join(f.root, 'worker-installations.json'),
      storeDigest: qualificationDigest('synthetic store binding') };
    const build = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => ({ ...await build(input), stdin: 'adapter-frame' });
    const plan = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    expect(plan.invocation).toBeDefined();
    await writeFile(f.invocationPath, JSON.stringify(plan));
    await f.launch();
    expect(JSON.parse(await readFile(f.recordPath, 'utf8')).stdin).toBe(agy.buildWorkerStdinFrame(workerPromptBrief(f.prompt, f.final)).toString());
  });
});

describe('T-OG-15/23 workspace-relative artifacts (#2905)', () => {
  const prefix = '.agents/skills/aiwg-brief-';
  function artifact(id: string, content = 'synthetic brief 雪') {
    return { name: 'patch', content, location: 'workspace-relative' as const, prefix, relativePath: `${prefix}${id}/SKILL.md` };
  }
  async function workspace() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-workspace-artifacts-')); roots.push(root);
    const runDir = path.join(root, 'run'), cwd = path.join(root, 'work');
    await mkdir(runDir, { mode: 0o700 }); await mkdir(cwd);
    return { root, runDir, cwd, invocationId: 'invocation-1', argv: [process.execPath, '${artifact:patch}'], artifacts: [artifact('invocation-1')] };
  }
  async function launchFixture(scenario = 'success', gated = true) {
    const f = await fixture({ scenario });
    const original = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => ({ ...await original(input), artifacts: [artifact(input.invocationId, input.brief)] });
    const plan = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
    await writeFile(f.invocationPath, JSON.stringify(plan));
    const options = { ...f.options, ...(gated ? {} : { scopedBreaker: null }) };
    return { ...f, plan, filename: path.join(f.cwd, artifact(plan.invocation!.invocationId!).relativePath),
      launch: (extra: any = {}) => f.launcher.launchWorker({ ...options,
        launchIsolated: withStopProof,
        isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }), ...extra }) };
  }
  it('creates one private file under cwd, substitutes its path and keeps shared prefixes', async () => {
    const f = await workspace();
    const result = await materializeWorkerArtifacts(f, f.runDir);
    expect(result.argv[1]).toBe(path.join(f.cwd, f.artifacts[0].relativePath));
    expect(await readFile(result.argv[1], 'utf8')).toBe(f.artifacts[0].content);
    expect((await lstat(result.argv[1])).mode & 0o777).toBe(0o600);
    await result.cleanup(); await result.cleanup();
    expect(await readdir(path.join(f.cwd, '.agents/skills'))).toEqual([]);
  });
  it.each(['../escape', '/tmp/escape', '.agents//skills/aiwg-brief-invocation-1/SKILL.md',
    '.agents/./skills/aiwg-brief-invocation-1/SKILL.md', '.agents/skills/../escape',
    '.agents/skills/aiwg-brief-wrong-id/SKILL.md', '.agents/skills/aiwg-brief-invocation-1/extra/SKILL.md',
    '.agents\\skills\\aiwg-brief-invocation-1\\SKILL.md'])(
    'refuses an absolute, traversal, non-normalized or unbound path: %s', async relativePath => {
      const f = await workspace(); f.artifacts[0].relativePath = relativePath;
      await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow(/path/);
      expect(await readdir(f.cwd)).toEqual([]);
    });
  it.each(['prefix', 'id', 'oversize', 'second-file'])('refuses %s before filesystem writes', async scenario => {
    const f = await workspace();
    if (scenario === 'prefix') f.artifacts[0].prefix = '../escape-';
    if (scenario === 'id') f.invocationId = 'other-id';
    if (scenario === 'oversize') f.artifacts[0].content = '雪'.repeat(349526);
    if (scenario === 'second-file') f.artifacts.push({ ...artifact(f.invocationId), name: 'second' });
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow();
    expect(await readdir(f.cwd)).toEqual([]);
  });
  it.each(['.agents', '.agents/skills', '.agents/skills/aiwg-brief-invocation-1', 'cwd', 'ancestor', 'leaf'])(
    'refuses symlinked %s without touching its target', async component => {
      const f = await workspace();
      const outside = path.join(f.root, 'outside'); await mkdir(outside);
      if (component === 'cwd') { await rm(f.cwd, { recursive: true }); await symlink(outside, f.cwd); }
      else if (component === 'ancestor') {
        const link = path.join(f.root, 'alias'); await symlink(f.root, link); f.cwd = path.join(link, 'work');
      } else {
        const target = component === 'leaf' ? path.join(f.cwd, f.artifacts[0].relativePath) : path.join(f.cwd, component);
        await mkdir(path.dirname(target), { recursive: true }); await symlink(outside, target);
      }
      await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    });
  it('reports a collision and preserves the existing file and a preceding run artifact is cleaned', async () => {
    const f: any = await workspace();
    const filename = path.join(f.cwd, f.artifacts[0].relativePath);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, 'original');
    f.artifacts.unshift({ name: 'first', content: 'temporary' });
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toMatchObject({ code: 'EEXIST', message: expect.stringMatching(/collision.*preserved/) });
    expect(await readFile(filename, 'utf8')).toBe('original');
    expect(await readdir(f.runDir)).toEqual([]);
  });
  it('cleans the pinned original parent after an ancestor is swapped for a symlink', async () => {
    const f = await workspace(), result = await materializeWorkerArtifacts(f, f.runDir);
    const moved = path.join(f.root, 'moved'), outside = path.join(f.root, 'outside');
    await mkdir(outside); await writeFile(path.join(outside, 'SKILL.md'), 'unrelated');
    await rename(path.join(f.cwd, '.agents'), moved); await symlink(outside, path.join(f.cwd, '.agents'));
    await result.cleanup();
    await expect(lstat(path.join(moved, 'skills/aiwg-brief-invocation-1/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('unrelated');
  });
  it('preserves and reports a replacement file during cleanup', async () => {
    const f = await workspace(), result = await materializeWorkerArtifacts(f, f.runDir);
    await rename(result.argv[1], `${result.argv[1]}.old`); await writeFile(result.argv[1], 'replacement');
    await expect(result.cleanup()).rejects.toThrow(/cleanup failed/);
    const preserved = await readdir(f.runDir, { recursive: true });
    const contents = await Promise.all(preserved.map(name => readFile(path.join(f.runDir, name), 'utf8').catch(() => '')));
    expect(contents).toContain('replacement');
  });
  it.each(['file', 'directory'])('quarantines a %s swapped at the cleanup syscall boundary', async kind => {
    const f = await workspace(), result = await materializeWorkerArtifacts(f, f.runDir);
    const target = kind === 'file' ? result.argv[1] : path.dirname(result.argv[1]);
    const suffix = kind === 'file' ? '/SKILL.md' : '/aiwg-brief-invocation-1';
    const replacement = path.join(f.root, 'unrelated');
    if (kind === 'file') await writeFile(replacement, 'unrelated'); else await mkdir(replacement);
    const identity = await lstat(replacement);
    const original = { lstat: fs.lstat, rename: fs.rename };
    let hit = false;
    const swap = async () => {
      hit = true;
      await original.rename(target, path.join(f.root, 'owned'));
      await original.rename(replacement, target);
    };
    // Old code swaps after inspection; fixed code swaps immediately before capture.
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: any[]) => {
      const stat = await (original.lstat as any)(...args);
      if (!hit && String(args[0]).endsWith(suffix)) await swap();
      return stat;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      if (!hit && String(args[0]).endsWith(suffix)) await swap();
      return (original.rename as any)(...args);
    });
    syncBuiltinESMExports();
    await expect(result.cleanup()).rejects.toThrow(/cleanup failed/);
    expect(hit).toBe(true);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    const candidates = [target, ...(await readdir(f.runDir, { recursive: true })).map(name => path.join(f.runDir, name))];
    const stats = await Promise.all(candidates.map(name => lstat(name).catch(() => null)));
    expect(stats.some(stat => stat?.dev === identity.dev && stat?.ino === identity.ino)).toBe(true);
  });
  it('fails closed when an opened invocation directory is relocated outside cwd', async () => {
    const f = await workspace(), original = fs.open;
    const moved = path.join(f.root, 'outside-workspace');
    let hit = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (original as any)(...args);
      if (!hit && String(args[0]).endsWith('/aiwg-brief-invocation-1')) {
        hit = true;
        await rename(path.join(f.cwd, '.agents/skills/aiwg-brief-invocation-1'), moved);
      }
      return handle;
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow(/path changed|containment/i);
    expect(hit).toBe(true);
    await expect(lstat(path.join(moved, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rechecks the entire cwd chain after exclusive leaf creation', async () => {
    const f = await workspace(), original = fs.open;
    const moved = path.join(f.root, 'outside-workspace');
    let hit = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (original as any)(...args);
      if (!hit && String(args[0]).endsWith('/SKILL.md')) {
        hit = true;
        await rename(path.join(f.cwd, '.agents'), moved);
      }
      return handle;
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow(/containment/);
    expect(hit).toBe(true);
    await expect(lstat(path.join(moved, 'skills/aiwg-brief-invocation-1/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cannot overwrite an empty directory raced against exclusive mkdir', async () => {
    const f = await workspace(), original = fs.mkdir;
    const target = path.dirname(path.join(f.cwd, f.artifacts[0].relativePath));
    let identity: any;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: any[]) => {
      if (!identity && String(args[0]).endsWith('/aiwg-brief-invocation-1')) {
        await original(target); identity = await lstat(target);
      }
      return (original as any)(...args);
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(identity).toBeDefined();
    expect((await lstat(target)).ino).toBe(identity.ino);
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(f.runDir)).toEqual([]);
  });
  it.each(['empty', 'populated'])('EEXIST preserves an existing %s invocation directory without adopting or deleting it', async kind => {
    const f = await workspace(), target = path.dirname(path.join(f.cwd, f.artifacts[0].relativePath));
    await mkdir(target, { recursive: true });
    if (kind === 'populated') await writeFile(path.join(target, 'unrelated'), 'preserve');
    const identity = await lstat(target);
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await lstat(target)).ino).toBe(identity.ino);
    expect(await readdir(target)).toEqual(kind === 'empty' ? [] : ['unrelated']);
    expect(await readdir(f.runDir)).toEqual([]);
  });
  it.each(['linux', 'darwin'])('materializes through Node alone on the %s path strategy', async platform => {
    const f = await workspace();
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('external interpreter forbidden'); });
    syncBuiltinESMExports();
    simulatePlatform(platform);
    const result = await materializeWorkerArtifacts(f, f.runDir);
    expect(await readFile(result.argv[1], 'utf8')).toBe(f.artifacts[0].content);
    await result.cleanup();
    expect(await readdir(path.join(f.cwd, '.agents/skills'))).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('retains an unproven nonempty directory without deleting its entries', async () => {
    const f = await workspace(), original = fs.open;
    let hit = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (original as any)(...args);
      if (!hit && String(args[0]).endsWith('/aiwg-brief-invocation-1')) {
        hit = true; await writeFile(path.join(f.cwd, path.dirname(f.artifacts[0].relativePath), 'unrelated'), 'preserve');
      }
      return handle;
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow(/identity.*retained/);
    expect(hit).toBe(true);
    expect(await readFile(path.join(f.cwd, path.dirname(f.artifacts[0].relativePath), 'unrelated'), 'utf8')).toBe('preserve');
  });
  it('never adopts or prunes a shared prefix substituted after mkdir', async () => {
    const f = await workspace(), original = fs.mkdir;
    const replacement = path.join(f.root, 'unrelated-directory'); await mkdir(replacement);
    const identity = await lstat(replacement);
    let hit = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: any[]) => {
      const value = await (original as any)(...args);
      if (!hit && String(args[0]).endsWith('/.agents')) {
        hit = true;
        await rename(path.join(f.cwd, '.agents'), path.join(f.root, 'created-directory'));
        await rename(replacement, path.join(f.cwd, '.agents'));
      }
      return value;
    });
    syncBuiltinESMExports();
    const result = await materializeWorkerArtifacts(f, f.runDir);
    await result.cleanup();
    expect(hit).toBe(true);
    expect((await lstat(path.join(f.cwd, '.agents'))).ino).toBe(identity.ino);
  });
  it('rejects a substituted invocation directory after mkdir before open', async () => {
    const f = await workspace(), original = fs.open;
    const replacement = path.join(f.root, 'unrelated-directory'); await mkdir(replacement);
    const identity = await lstat(replacement);
    let hit = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      if (!hit && String(args[0]).endsWith('/aiwg-brief-invocation-1')) {
        hit = true;
        await rename(path.join(f.cwd, '.agents/skills/aiwg-brief-invocation-1'), path.join(f.root, 'owned-directory'));
        await rename(replacement, path.join(f.cwd, '.agents/skills/aiwg-brief-invocation-1'));
      }
      return (original as any)(...args);
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow();
    expect(hit).toBe(true);
    const candidates = await readdir(f.runDir, { recursive: true });
    const stats = await Promise.all([lstat(path.join(f.cwd, '.agents/skills/aiwg-brief-invocation-1')).catch(() => null),
      ...candidates.map(name => lstat(path.join(f.runDir, name)))]);
    expect(stats.some(stat => stat?.ino === identity.ino && stat?.dev === identity.dev)).toBe(true);
  });
  it('rejects coherently rewritten identity using the conductor-owned saved plan', async () => {
    const f = await launchFixture();
    const saved = structuredClone(f.plan);
    saved.invocation!.invocationId = 'worker-chosen-id';
    saved.invocation!.artifacts![0].relativePath = `${prefix}worker-chosen-id/SKILL.md`;
    await expect(revalidateWorkerInvocationPlan(saved, f.snapshot, f.drivers, f.request.now, f.invocationPath)).rejects.toThrow(/identity|conductor/i);
  });
  it('rejects coherently rewritten Warp skill argv, path, frontmatter and identity', async () => {
    const f = await fixture();
    const { buildWarpBriefSkillFile, buildWarpBriefSkillName } = await import('../../../tools/ralph-external/lib/warp-adapter.mjs');
    const original = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => {
      const transport = await original(input);
      transport.argv.splice(transport.argv.indexOf('--'), 0, '--skill', buildWarpBriefSkillName(input.invocationId));
      return { ...transport, artifacts: [{ name: 'patch', location: 'workspace-relative', prefix,
        ...buildWarpBriefSkillFile(input.brief, input.invocationId) }] };
    };
    const plan = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
    await writeFile(f.invocationPath, JSON.stringify(plan));
    const saved = structuredClone(plan), invocation = saved.invocation!;
    invocation.invocationId = 'worker-chosen-id';
    invocation.argv[invocation.argv.indexOf('--skill') + 1] = buildWarpBriefSkillName(invocation.invocationId);
    Object.assign(invocation.artifacts![0], buildWarpBriefSkillFile(f.prompt, invocation.invocationId));
    // Keep derived shell syntax coherent as well, so identity authority is the rejection.
    invocation.shellCommand = invocation.shellCommand!.replaceAll(plan.invocation!.invocationId!, invocation.invocationId);
    await expect(revalidateWorkerInvocationPlan(saved, f.snapshot, f.drivers, f.request.now, f.invocationPath)).rejects.toThrow(/identity|conductor/i);
    await expect(revalidateWorkerInvocationPlan(plan, f.snapshot, f.drivers, f.request.now)).rejects.toThrow(/conductor/i);
  });
  it.each(['cwd', 'qualified-root', 'symlink-root'])('launcher refuses plans inside %s', async location => {
    const f = await launchFixture();
    let root = f.cwd;
    if (location !== 'cwd') {
      root = path.join(f.root, 'writable'); await mkdir(root);
      let declared = root;
      if (location === 'symlink-root') { declared = path.join(f.root, 'alias'); await symlink(root, declared); }
      f.drivers.codex.qualification.installation = { workerWritableRoots: [declared] };
    }
    const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(f.plan));
    const launchIsolated = vi.fn();
    await expect(f.launch({ invocationPath, launchIsolated })).rejects.toThrow(/worker-writable/);
    expect(launchIsolated).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps the same id during revalidation, rejects tampered bindings and uses a fresh id for a new plan', async () => {
    const f = await launchFixture();
    expect((await revalidateWorkerInvocationPlan(f.plan, f.snapshot, f.drivers, f.request.now, f.invocationPath)).invocationId).toBe(f.plan.invocation!.invocationId);
    const again = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    expect(again.invocation!.invocationId).not.toBe(f.plan.invocation!.invocationId);
    for (const field of ['prefix', 'relativePath', 'invocationId']) {
      const saved = structuredClone(f.plan);
      if (field === 'invocationId') saved.invocation!.invocationId = 'wrong-id';
      else (saved.invocation!.artifacts![0] as any)[field] = field === 'prefix' ? '.other/brief-' : `${prefix}wrong-id/SKILL.md`;
      await expect(revalidateWorkerInvocationPlan(saved, f.snapshot, f.drivers, f.request.now, f.invocationPath)).rejects.toThrow();
    }
  });
  it.each([true, false])('launcher uses the declaration id and cleans after completion (recovery gate %s)', async gated => {
    const f = await launchFixture('success', gated);
    let seen = false;
    const launchIsolated = (options: any) => {
      // Synchronous launch boundary observes the already materialized file.
      seen = true;
      return withStopProof(options);
    };
    const result = await f.launch({ launchIsolated });
    expect(seen).toBe(true); expect(result.invocationId).toBe(f.plan.invocation!.invocationId);
    expect(JSON.parse(await readFile(path.join(f.runDir, 'invocation.json'), 'utf8')).invocationId).toBe(result.invocationId);
    await expect(lstat(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['spawn', 'capture', 'gate'])('launcher cleans the workspace artifact on %s failure', async stage => {
    const f = await launchFixture();
    let calls = 0;
    const options = stage === 'spawn' ? { launchIsolated: () => { throw new Error('synthetic launch failure'); } }
      : stage === 'capture' ? { openCapture: () => { throw new Error('synthetic capture failure'); } }
      : { checkDispatch: () => ({ ok: calls++ === 0, enabled: true, failures: [] }) };
    await expect(f.launch(options)).rejects.toThrow();
    await expect(lstat(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('launcher cleans the artifact after an owned stop', async () => {
    const f = await launchFixture('hang');
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    f.launcher.once('launched', () => f.launcher.kill());
    await f.launch({ launchIsolated: () => ({ child, mode: 'systemd-unit', unit: 'aiwg-worker-artifact-fixture' }),
      stopUnit: () => { queueMicrotask(() => { child.stdout.end(); child.stderr.end();
        child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); return { ok: true }; } });
    await expect(lstat(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
