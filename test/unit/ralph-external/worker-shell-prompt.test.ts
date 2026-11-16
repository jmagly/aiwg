// Exercise private shell prompt staging and the host-bound adapter framing path.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { frameShellWorkerJson, frameShellWorkerPrompt, shellWorkerPromptPath, stageShellWorkerPrompt } from '../../../src/serve/worker-shell-prompt.mjs';
import * as installations from '../../../src/models/worker-installation.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';

const roots: string[] = [];
const packageRoot = path.resolve('.');
const digest = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
beforeEach(() => vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'));
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-shell-prompt-')); roots.push(root);
  const workdir = path.join(root, 'work'); await mkdir(workdir);
  const briefPath = path.join(workdir, "brief '雪.md"), finalPath = path.join(root, "final '雪\n.json");
  const brief = '--task $(touch injected) 雪\nTask body'; await writeFile(briefPath, brief);
  const promptPath = shellWorkerPromptPath(finalPath);
  return { root, workdir, briefPath, finalPath, brief, promptPath,
    stage: () => stageShellWorkerPrompt(packageRoot, briefPath, digest(brief), finalPath) };
}

it('stages exact shared contract bytes privately beside the final, preserving the source', async () => {
  const f = await fixture();
  expect(await f.stage()).toBe(f.promptPath);
  expect(await readFile(f.promptPath)).toEqual(workerPromptBrief(f.brief, f.finalPath));
  expect((await lstat(f.promptPath)).mode & 0o777).toBe(0o600);
  expect(path.dirname(f.promptPath)).toBe(path.dirname(f.finalPath));
  expect(path.relative(f.workdir, f.promptPath).startsWith('..')).toBe(true);
  expect(await readFile(f.briefPath, 'utf8')).toBe(f.brief);
  await expect(f.stage()).rejects.toMatchObject({ code: 'EEXIST' });
});

it.each(['changed brief', 'symlink prompt'])('refuses %s without replacing existing data', async scenario => {
  const f = await fixture();
  if (scenario === 'changed brief') await writeFile(f.briefPath, 'Changed');
  else await symlink(f.briefPath, f.promptPath);
  await expect(f.stage()).rejects.toThrow();
  expect(await readFile(f.briefPath, 'utf8')).toBe(scenario === 'changed brief' ? 'Changed' : f.brief);
});

it('passes exact staged contract bytes to the bound adapter and retains all framing identity checks', async () => {
  const f = await fixture(); await f.stage();
  const args = [f.briefPath, f.workdir, 'fixture', 'fixture-adapter', digest('scope'), digest(f.brief),
    path.join(f.root, 'store.json'), digest('store'), 'null', 'synthetic-model', f.finalPath];
  const buildWorkerStdinFrame = vi.fn((bytes: Buffer) => JSON.stringify({ prompt: bytes.toString() }));
  const load = vi.spyOn(installations, 'loadRecordedWorkerInstallations').mockResolvedValue({ drivers: { fixture: {
    qualification: { adapterId: 'fixture-adapter', adapter: { invocation: { stdin: 'adapter-frame' } },
      installation: { evidence: { scopeDigest: digest('scope') } } }, buildWorkerStdinFrame,
  } } } as any);
  expect(JSON.parse((await frameShellWorkerPrompt(packageRoot, args)).toString())).toEqual({
    prompt: workerPromptBrief(f.brief, f.finalPath).toString(),
  });
  expect(buildWorkerStdinFrame).toHaveBeenCalledWith(workerPromptBrief(f.brief, f.finalPath),
    { stdin: 'adapter-frame', selected: { model: 'synthetic-model' } });
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.workdir, cli: 'fixture',
    storePath: args[6], storeDigest: args[7], policy: undefined }));
  for (const index of [2, 3, 4]) {
    const changed = [...args]; changed[index] = 'changed';
    await expect(frameShellWorkerPrompt(packageRoot, changed)).rejects.toThrow('Adapter stdin binding changed');
  }
  await writeFile(f.promptPath, 'Tampered');
  await expect(frameShellWorkerPrompt(packageRoot, args)).rejects.toThrow('Worker shell prompt changed');
});

it('frames JSON only from the exact shared contract and refuses a tampered staged file', async () => {
  const f = await fixture(); await f.stage();
  const args = [f.briefPath, digest(f.brief), f.finalPath, 'synthetic-model', f.workdir];
  expect(JSON.parse(await frameShellWorkerJson(packageRoot, args))).toEqual({
    message: workerPromptBrief(f.brief, f.finalPath).toString(), model_override: 'synthetic-model', cwd: f.workdir,
  });
  await writeFile(f.promptPath, 'Tampered staged prompt');
  await expect(frameShellWorkerJson(packageRoot, args)).rejects.toThrow('Worker shell prompt changed');
  await writeFile(f.briefPath, 'Changed source');
  await expect(frameShellWorkerJson(packageRoot, args)).rejects.toThrow('Worker prompt digest changed');
});
