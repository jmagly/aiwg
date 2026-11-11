/** Raw shell preflight shares launcher predecessor checks and durable output reservations. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reserveShellWorkerCapture } from '../../../tools/ralph-external/lib/worker-shell-capture.mjs';
import { stableTaskChainDigest } from '../../../tools/ralph-external/session-launcher.mjs';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-shell-guard-')); roots.push(root);
  const cwd = path.join(root, 'worker'); await mkdir(cwd);
  const briefPath = path.join(cwd, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
  const briefDigest = `sha256:${createHash('sha256').update('synthetic brief').digest('hex')}`;
  const paths = { final: path.join(root, 'final.json'), stdout: path.join(root, 'stdout'), stderr: path.join(root, 'stderr'),
    lastMessage: path.join(root, 'last-message') };
  const binding = { request: { role: 'coding', task: 'implementation', group: 'workers', workdir: cwd },
    invocation: { cwd, briefPath, briefDigest, stdin: 'brief-text', selected: { group: 'workers' } }, paths };
  return { root, binding };
}

describe('raw shell capture preflight', () => {
  it.each([true, false])('CLI entry reports reservation success or refusal (valid input: %s)', async valid => {
    const { binding } = await fixture();
    binding.invocation.stdin = 'closed'; await unlink(binding.invocation.briefPath);
    const argv = process.argv, exitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.argv = [process.execPath, fileURLToPath(new URL('../../../tools/ralph-external/lib/worker-shell-capture.mjs', import.meta.url)),
        valid ? JSON.stringify(binding) : '{invalid'];
      vi.resetModules();
      await import('../../../tools/ralph-external/lib/worker-shell-capture.mjs');
      if (valid) expect(JSON.parse(await readFile(`${binding.paths.final}.launch-owner`, 'utf8')).invocationId).toBeTruthy();
      else { expect(process.exitCode).toBe(1); expect(stderr).toHaveBeenCalledWith(expect.stringContaining('handoff refused')); }
    } finally { process.argv = argv; process.exitCode = exitCode; stderr.mockRestore(); }
  });
  it('reserves every output and refuses deleted deliverables even for another task', async () => {
    const { binding } = await fixture();
    await reserveShellWorkerCapture(binding);
    for (const filename of Object.values(binding.paths)) {
      expect(JSON.parse(await readFile(`${filename}.launch-owner`, 'utf8')).invocationId).toBeTruthy();
    }
    await writeFile(binding.paths.final, 'retained'); await unlink(binding.paths.final);
    binding.request.task = 'bugfix';
    await expect(reserveShellWorkerCapture(binding)).rejects.toThrow(/earlier attempt/);
  });

  it.each(['final', 'stdout', 'stderr', 'lastMessage'] as const)('refuses an existing %s without truncation or reservations', async key => {
    const { binding } = await fixture(); await writeFile(binding.paths[key], 'retained bytes');
    await expect(reserveShellWorkerCapture(binding)).rejects.toThrow(/Fresh worker output/);
    expect(await readFile(binding.paths[key], 'utf8')).toBe('retained bytes');
    await expect(readFile(`${binding.paths.final}.launch-owner`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a changed brief before reserving outputs', async () => {
    const { binding } = await fixture(); await writeFile(binding.invocation.briefPath, 'changed');
    await expect(reserveShellWorkerCapture(binding)).rejects.toThrow(/prompt digest changed/);
    await expect(readFile(`${binding.paths.final}.launch-owner`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses missing output parents and aliased outputs', async () => {
    const { binding, root } = await fixture();
    binding.paths.final = path.join(root, 'missing', 'final.json');
    await expect(reserveShellWorkerCapture(binding)).rejects.toThrow(/parent is missing/);
    binding.paths.final = path.join(root, 'link'); await symlink(binding.invocation.briefPath, binding.paths.final);
    await expect(reserveShellWorkerCapture(binding)).rejects.toThrow(/Symlink/);
  });

  it('atomically admits only one concurrent command, including fresh output names', async () => {
    const { binding } = await fixture(); const next = structuredClone(binding);
    for (const key of Object.keys(next.paths) as (keyof typeof next.paths)[]) next.paths[key] += '.next';
    const results = await Promise.allSettled([reserveShellWorkerCapture(binding), reserveShellWorkerCapture(next)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it.each(['launcher', 'shell-handoff'])('refuses an open %s predecessor after a brief/group correction with fresh output names', async origin => {
    const { binding, root } = await fixture(); const previous = path.join(root, 'previous'); await mkdir(previous, { mode: 0o700 });
    const oldRequest = { ...binding.request, group: 'old-group' };
    await writeFile(path.join(previous, 'invocation.json'), JSON.stringify({ origin, invocationId: 'previous',
      cwd: binding.invocation.cwd, selected: { group: oldRequest.group }, prompt: { digest: 'old-brief' },
      taskBindingDigest: await stableTaskChainDigest(oldRequest, 'old-brief') }), { mode: 0o600 });
    await expect(reserveShellWorkerCapture(binding)).rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR' });
    await expect(readFile(`${binding.paths.final}.launch-owner`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores unrelated task records and rejects output/reservation collisions', async () => {
    const { binding, root } = await fixture(); const previous = path.join(root, 'previous'); await mkdir(previous, { mode: 0o700 });
    await writeFile(path.join(previous, 'invocation.json'), JSON.stringify({ origin: 'unrelated' }), { mode: 0o600 });
    await reserveShellWorkerCapture(binding);
    const next = (await fixture()).binding;
    next.paths.stdout = `${next.paths.final}.launch-owner`;
    await expect(reserveShellWorkerCapture(next)).rejects.toThrow(/collide/);
  });
});
