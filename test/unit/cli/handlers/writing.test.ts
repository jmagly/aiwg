import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writingHandler } from '../../../../src/cli/handlers/writing.js';
import { parseWriterProfile } from '../../../../src/writing/writer-profile.js';
import { WriterProfileStore } from '../../../../src/writing/writer-profile-store.js';
import { writingBriefHash } from '../../../../src/writing/writing-brief.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'writing-cli-')); roots.push(cwd);
  vi.stubEnv('AIWG_CONFIG', path.join(cwd, 'user'));
  vi.stubEnv('AIWG_SESSION_ID', path.basename(cwd));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', path.join(cwd, 'canonical'));
  const profile = parseWriterProfile({ schemaVersion: 1, id: 'author', version: '1.0.0', name: 'Author', provenance: { source: 'author', license: 'author-owned' }, samples: [], preferences: [] });
  await new WriterProfileStore({ cwd }).save(profile, 0);
  const text = 'Hello teh reader. Support is experimental.';
  const at = text.indexOf('Support');
  const brief = { schemaVersion: 1, id: 'brief', operation: 'proofread-only', reader: { task: 'Understand support', audience: 'operators', requirements: [] }, intendedAction: 'Review limitations', exclusions: [],
    inputs: [{ id: 'draft', kind: 'existing-draft', text, sha256: writingBriefHash(text), provenance: { source: 'author', version: '1' }, authorApproved: true }],
    propositions: [{ id: 'support', text: 'Support is experimental.', evidenceStrength: 'experimental', evidence: [{ inputId: 'draft', start: at, end: text.length }], qualifiers: ['experimental'] }], limitations: [], authorClaims: [], sourceInputId: 'draft',
    permissions: { rephrase: false, reorder: false, addContent: false, corrections: [{ id: 'typo', start: 6, end: 9, expected: 'teh', replacement: 'the', reason: 'spelling', authorAuthorized: true }] } };
  const file = path.join(cwd, 'brief.json'); await writeFile(file, JSON.stringify(brief));
  const run = (args: string[], dryRun = false) => writingHandler.execute({ cwd, frameworkRoot: cwd, args, rawArgs: ['writing', ...args], dryRun });
  return { cwd, text, brief, file, run };
}

describe('writing CLI canonical proofread consumer', () => {
  it('reviews a campaign through the existing flag in readable and JSON formats', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'writing-cross-cli-')); roots.push(cwd);
    const sentence = 'Approve a task once and the agent remembers it.';
    for (const name of ['a', 'b', 'c']) await writeFile(path.join(cwd, `${name}.md`), sentence);
    const run = (args: string[]) => writingHandler.execute({ cwd, frameworkRoot: cwd, args, rawArgs: ['writing', ...args], dryRun: false });
    const report = await run(['--cross', cwd]);
    expect(report.exitCode).toBe(0);
    expect(report.message).toContain('[cut] repeated-sentence');
    expect(report.message).toContain('a.md:1:1');
    const json = await run(['--cross', '--json', cwd]);
    expect(json.exitCode).toBe(0);
    const results = JSON.parse(json.message!);
    expect(Object.keys(results)).toHaveLength(3);
    expect(results[path.join(cwd, 'a.md')].diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'repeated-sentence', tier: 'cut', scope: 'cross' })]));
    const findings = results[path.join(cwd, 'a.md')].diagnostics;
    expect(new Set(findings.map((f: { id: string }) => f.id)).size).toBe(findings.length);
    expect((await run(['--cross'])).exitCode).toBe(1);
    expect((await run(['--cross', '--unknown', cwd])).exitCode).toBe(1);
    for (let index = 0; index < 198; index++) await writeFile(path.join(cwd, `overflow-${index}.md`), 'Unique document.');
    expect(await run(['--cross', cwd])).toMatchObject({ exitCode: 1, message: 'Campaign exceeds 200 documents; split it into smaller campaign sets.' });
    expect((await writingHandler.help({ cwd, frameworkRoot: cwd, args: [], rawArgs: [], dryRun: false })).message).toContain('writing --cross');
  });
  it('applies an authorized correction, writes canonical output/receipt and exports explicitly', async () => {
    const { cwd, text, file, run } = await setup();
    await mkdir(path.join(cwd, 'canonical'));
    const exported = path.join(cwd, 'result.txt');
    const result = await run(['proofread', '--brief', file, '--profile', 'author', '--output', exported]);
    expect(result.exitCode).toBe(0);
    const metadata = JSON.parse(result.message!);
    expect(metadata.canonical.startsWith(path.join(cwd, 'canonical'))).toBe(true);
    expect(metadata.appliedModes).toEqual([]); expect(metadata.modelExecution).toBe('none');
    expect(await readFile(exported, 'utf8')).toBe(text.replace('teh', 'the'));
    expect(await readFile(metadata.canonical, 'utf8')).toBe(await readFile(exported, 'utf8'));
    const receipt = await readFile(metadata.receipt, 'utf8');
    expect(receipt).not.toContain(text); expect(receipt).not.toContain('Hello the reader');
    expect(result.message).not.toContain(text);
    const again = await run(['proofread', '--brief', file, '--profile', 'author', '--output', exported]);
    expect(again.exitCode).toBe(1);
    expect(await readFile(exported, 'utf8')).toBe(text.replace('teh', 'the'));
  });
  it('supports dry run, rejects unauthorized IDs and respects export policy', async () => {
    const { cwd, file, run } = await setup();
    expect((await run(['proofread', '--brief', file, '--profile', 'author'], true)).exitCode).toBe(0);
    await expect(access(path.join(cwd, 'canonical'))).rejects.toThrow();
    expect((await run(['proofread', '--brief', file, '--profile', 'author', '--correction', 'unknown'])).exitCode).toBe(1);
    await writeFile(path.join(cwd, '.aiwg', 'aiwg.config'), JSON.stringify({ version: '1', artifact_outputs: { canonical: 'aiwg', provider_native: 'disabled' } }));
    expect((await run(['proofread', '--brief', file, '--profile', 'author', '--output', path.join(cwd, 'blocked.txt')])).exitCode).toBe(1);
    await expect(access(path.join(cwd, 'blocked.txt'))).rejects.toThrow();
  });
});
