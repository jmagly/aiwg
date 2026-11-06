// Verify launch contracts across stdin and file-based prompt delivery.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { materializeWorkerArtifacts } from '../../../tools/ralph-external/lib/worker-artifacts.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { workerStdinBytes } from '../../../src/serve/worker-stdin-frame.mjs';
import { validateWorkerPayload } from '../../../src/mission-protocol/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const finalPath = '/worker tree/.handoff/final "雪\n.json';
function assertContract(text: string) {
  expect(text).toContain(JSON.stringify(finalPath));
  const example = text.split('\n').find(line => line.startsWith('{"version":'))!;
  expect(validateWorkerPayload('workerClaims', JSON.parse(example))).toMatchObject({ valid: true });
  expect(text).toContain('all seven fields');
  expect(text).toContain('Task body');
}

describe('worker launch final-output preamble', () => {
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
