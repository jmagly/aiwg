// Verify launch contracts across stdin and file-based prompt delivery.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { materializeWorkerArtifacts } from '../../../tools/ralph-external/lib/worker-artifacts.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { recordedWorkerStdinBytes, workerStdinBytes } from '../../../src/serve/worker-stdin-frame.mjs';
import * as installations from '../../../src/models/worker-installation.mjs';
import { validateWorkerPayload } from '../../../src/mission-protocol/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const finalPath = '/worker tree/.handoff/final "雪\n.json';
function assertContract(text: string) {
  expect(text).toContain(JSON.stringify(finalPath));
  const example = text.split('\n').find(line => line.startsWith('{"version":'))!;
  expect(validateWorkerPayload('workerClaims', JSON.parse(example))).toMatchObject({ valid: true });
  expect(text).toContain('all seven fields');
  expect(text).toContain('Task body');
}

describe('worker launch final-output preamble', () => {
  it('#4113 shows a schema-valid item for every array a worker may fill', () => {
    const text = workerPromptBrief('Task body', finalPath).toString();
    const item = (prefix: string) => {
      const line = text.split('\n').find(candidate => candidate.startsWith(prefix));
      expect(line, prefix).toBeDefined();
      return JSON.parse(line!.replaceAll('<64 lowercase hex characters>', 'a'.repeat(64)));
    };
    const base = JSON.parse(text.split('\n').find(line => line.startsWith('{"version":'))!);
    const payload = { ...base, claims: [item('{"id":')], artifacts: [item('{"path":')], checks: [item('{"checkId":')],
      limitations: ['Synthetic task only'] };
    expect(validateWorkerPayload('workerClaims', payload)).toMatchObject({ valid: true });
    // The #2918 Amendment 10 smoke worker wrote claims and checks as strings; that must stay invalid.
    expect(validateWorkerPayload('workerClaims', { ...payload, claims: ['Wrote the final'], checks: ['JSON valid'] }))
      .toMatchObject({ valid: false });
    expect(text).toContain('Each limitation is a plain string');
    // #2918 Amendment 10b direct-02: a worker copied the artifact {path, digest} shape into claim evidence.
    expect(payload.claims[0].evidence).toHaveLength(1);
    const pathEvidence = { ...payload, claims: [{ ...payload.claims[0], evidence: [{ path: 'answer.json', digest: `sha256:${'a'.repeat(64)}` }] }] };
    expect(validateWorkerPayload('workerClaims', pathEvidence)).toMatchObject({ valid: false });
    expect(text).toContain('Evidence items use "ref", not "path"');
  });

  it('#4073 reloads only the bound CLI for framing and retains adapter, scope and brief checks', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiwg-bound-worker-frame-')); roots.push(workspace);
    const filename = path.join(workspace, 'brief.md');
    const brief = 'Task body'; await writeFile(filename, brief);
    const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const input = { filename, workspace, cli: 'factory', adapterId: 'fixture-factory', scopeDigest: digest('scope'),
      briefDigest: digest(brief), storePath: path.join(workspace, 'host-store.json'), storeDigest: digest('store'),
      policy: undefined, model: 'synthetic' };
    const load = vi.spyOn(installations, 'loadRecordedWorkerInstallations').mockResolvedValue({
      registry: {}, installations: {}, observations: {}, drivers: { factory: {
        qualification: { adapterId: input.adapterId, adapter: { invocation: { stdin: 'adapter-frame' } },
          installation: { evidence: { scopeDigest: input.scopeDigest } } },
        buildWorkerStdinFrame: (bytes: Buffer) => JSON.stringify({ message: bytes.toString() }),
      } },
    } as any);
    expect(JSON.parse((await recordedWorkerStdinBytes(input))!.toString())).toEqual({ message: brief });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ cwd: workspace, cli: 'factory',
      storePath: input.storePath, storeDigest: input.storeDigest, policy: input.policy }));
    for (const changed of [{ cli: 'codex' }, { adapterId: 'other' }, { scopeDigest: digest('other') }]) {
      await expect(recordedWorkerStdinBytes({ ...input, ...changed })).rejects.toThrow('Adapter stdin binding changed');
    }
    await writeFile(filename, 'Changed task');
    await expect(recordedWorkerStdinBytes(input)).rejects.toThrow('Adapter stdin brief changed');
  });

  it.each(['brief-text', 'brief-json', 'adapter-frame'])('delivers the path and schema-valid wrapper via %s', stdin => {
    const prompt = workerPromptBrief(Buffer.from('Task body'), finalPath);
    const bytes = workerStdinBytes({ stdin, cwd: '/worker', selected: { model: 'synthetic' } }, prompt,
      { buildWorkerStdinFrame: (brief: Buffer) => JSON.stringify({ prompt: brief.toString() }) })!;
    assertContract(stdin === 'brief-text' ? bytes.toString() : JSON.parse(bytes.toString())[stdin === 'brief-json' ? 'message' : 'prompt']);
  });

  it.each([false, true])('materializes a derived file brief (embedded skill: %s) and preserves the source', async skill => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-prompt-')); roots.push(root);
    const cwd = path.join(root, 'worker'), runDir = path.join(root, 'run');
    await mkdir(cwd); await mkdir(runDir, { mode: 0o700 });
    const briefPath = path.join(cwd, 'brief.md'); await writeFile(briefPath, 'Task body');
    const invocationId = 'synthetic-prompt';
    const invocation = { cwd, briefPath, finalPath, invocationId, stdin: 'closed', argv: skill
      ? ['fake', '${artifact:brief-skill}'] : ['fake', '--prompt-file', briefPath],
      artifacts: skill ? [{ name: 'brief-skill', location: 'workspace-relative', prefix: '.agents/skills/aiwg-brief-',
        relativePath: `.agents/skills/aiwg-brief-${invocationId}/SKILL.md`, content: '---\nname: brief\n---\n\nTask body\n' }] : [] };
    const materialized = await materializeWorkerArtifacts(invocation, runDir, { brief: Buffer.from('Task body'), invocationId });
    const deliveredPath = materialized.argv.at(-1)!;
    assertContract(await readFile(deliveredPath, 'utf8'));
    if (skill) expect(await readFile(deliveredPath, 'utf8')).toMatch(/^---\nname: brief\n---/);
    expect(await readFile(briefPath, 'utf8')).toBe('Task body');
    expect(invocation.argv).not.toContain(deliveredPath);
    await materialized.cleanup();
    await expect(readFile(deliveredPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
