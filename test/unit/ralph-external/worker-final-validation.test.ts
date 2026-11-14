// Synthetic launcher regressions for workerClaims schema and artifact digests (#3675).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { unlinkSync, writeFileSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { HermesAdapter } from '../../../tools/ralph-external/lib/hermes-adapter.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { workerFinalFailureMessage } from '../../../tools/ralph-external/lib/worker-launch-cli.mjs';

const roots: string[] = [];
const breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const valid = () => ({ version: 1, status: 'completed', summary: 'Synthetic claims',
  claims: [], artifacts: [], checks: [], limitations: [] });
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function fixture(recovery: boolean, adapter = new CodexAdapter()) {
  const f = await workerInvocationFixture({}, { roots, breakers });
  f.drivers.codex.extractFinal = (text: string) => adapter.parseOutput(text);
  const parseFinal = vi.fn((output: any, options: any) => adapter.parseWorkerFinal(output, options));
  f.drivers.codex.parseWorkerFinal = parseFinal;
  const launch = async (final: unknown, stdoutOnly = false, exitCode = 0, degraded = false, missing = false) => {
    const bytes = typeof final === 'string' ? final : JSON.stringify(final);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const result = await f.launch({ scopedBreaker: recovery ? f.options.scopedBreaker : null,
      launchIsolated: () => {
        queueMicrotask(() => {
          writeFileSync(f.final, stdoutOnly ? '' : bytes);
          if (missing) unlinkSync(f.final);
          child.stdout.end(stdoutOnly ? bytes : ''); child.stderr.end();
          child.emit('exit', exitCode, null); child.emit('close', exitCode, null);
        });
        return degraded ? { mode: 'degraded', child } : { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-final' };
      }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: exitCode, result: 'success' }) });
    const evidence = JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    }));
    const exit = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    return { result, evidence, exit };
  };
  return { ...f, launch, parseFinal };
}

const malformed = [
  { label: 'direct-27 string entries', final: { ...valid(), claims: ['claim'], artifacts: ['answer.txt'], checks: ['passed'] },
    pointers: ['/claims/0', '/artifacts/0', '/checks/0'] },
  { label: 'string collections', final: { ...valid(), claims: 'claim', artifacts: 'answer.txt', checks: 'passed' },
    pointers: ['/claims', '/artifacts', '/checks'] },
  { label: 'direct-24 missing fields', final: { claims: ['claim'] },
    pointers: ['/version', '/status', '/summary', '/artifacts', '/checks', '/limitations', '/claims/0'] },
  { label: 'direct-26/30 wrong version and claim shape', final: { ...valid(), version: '1', claims: [{ description: 'claim' }] },
    pointers: ['/version', '/claims/0/id', '/claims/0/text', '/claims/0/evidence'] },
];

describe.each([false, true])('#3675 launcher final validation, recovery=%s', recovery => {
  it('preserves FINAL_OUTPUT_INVALID for an empty final without candidate evidence', async () => {
    const f = await fixture(recovery);
    const { result, evidence, exit } = await f.launch('');
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(exit.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(exit.finalOutputFailure).toMatchObject({ kind: 'missing-file', expectedPath: f.final, candidates: [] });
    expect(evidence).toBeNull();
  });

  it.each([false, true])('reports a missing final and root-level candidates (file removed: %s)', async missing => {
    const f = await fixture(recovery);
    const candidate = path.join(f.cwd, 'answer.json');
    await writeFile(candidate, JSON.stringify({ facts: ['synthetic'], warning: '' }));
    await symlink(candidate, path.join(f.cwd, 'linked.json'));
    const { result, exit } = await f.launch('', false, 0, false, missing);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(exit.finalOutputFailure).toEqual(result.finalOutputFailure);
    expect(exit.finalOutputFailure).toMatchObject({ kind: 'missing-file', expectedPath: f.final,
      candidates: [{ path: candidate, location: 'worker-tree-root', candidate: true, verified: false }] });
    expect(workerFinalFailureMessage(result)).toContain(candidate);
    expect(workerFinalFailureMessage(result)).toContain('missing-file');
    expect(await readFile(candidate, 'utf8')).toContain('facts');
    expect(result.attemptOutcome).not.toBe('succeeded');
  });

  it('flags a possible wrong location without accepting a root-level wrapper', async () => {
    const f = await fixture(recovery);
    const candidate = path.join(f.cwd, path.basename(f.final));
    await writeFile(candidate, JSON.stringify(valid()));
    const { result, exit } = await f.launch('');
    expect(exit.finalOutputFailure.kind).toBe('wrong-location');
    expect(workerFinalFailureMessage(result)).toContain(candidate);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(await readFile(f.final, 'utf8')).toBe('');
  });

  it('names a task answer with no wrapper as wrong-shape', async () => {
    const f = await fixture(recovery);
    const { result, exit } = await f.launch({ facts: [], warning: '' });
    expect(exit.finalOutputFailure).toMatchObject({ kind: 'wrong-shape', expectedPath: f.final });
    expect(workerFinalFailureMessage(result)).toContain('wrong-shape');
    expect(exit.finalOutputErrors).toContainEqual(expect.stringContaining('/version'));
  });

  it.each(malformed)('rejects $label with JSON pointers', async ({ final, pointers }) => {
    const f = await fixture(recovery);
    const { result, evidence, exit } = await f.launch(final);
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(exit.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence).toMatchObject({ terminalSuccess: false, errorCode: 'FINAL_OUTPUT_INVALID' });
    for (const pointer of pointers) expect(evidence.errors.some((error: string) => error.startsWith(`${pointer} `))).toBe(true);
    expect(result.finalOutputErrors).toEqual(evidence.errors);
    expect(exit.finalOutputErrors).toEqual(evidence.errors);
    expect(result.attemptOutcome).not.toBe('succeeded');
  });

  it.each(['0'.repeat(64), '1'.repeat(64)])('rejects a syntactically valid but incorrect artifact digest %s', async hex => {
    const f = await fixture(recovery);
    await writeFile(path.join(f.cwd, 'answer.txt'), 'actual artifact');
    const final = { ...valid(), artifacts: [{ path: 'answer.txt', digest: `sha256:${hex}`, change: 'created' }] };
    const { result, evidence } = await f.launch(final);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence.terminalSuccess).toBe(false);
    expect(evidence.errors).toEqual([expect.stringContaining('/artifacts/0/digest Artifact digest mismatch')]);
    expect(evidence.errors[0]).toContain(digest('actual artifact'));
  });

  it('accepts schema-valid claims whose artifact digest matches the file', async () => {
    const f = await fixture(recovery);
    await writeFile(path.join(f.cwd, 'answer.txt'), 'actual artifact');
    const final = { ...valid(), artifacts: [{ path: 'answer.txt', digest: digest('actual artifact'), change: 'created' }] };
    const { result, evidence } = await f.launch(final);
    expect(result.errorCode).toBeFalsy();
    expect(await readFile(f.final, 'utf8')).toBe(JSON.stringify(final));
    expect(result.finalOutputFailure).toBeUndefined();
    expect(evidence.terminalSuccess).toBe(true);
    expect(evidence.verified).toBe(false);
    expect(evidence.errors).toBeUndefined();
  });

  it.each(['missing.txt', '../outside.txt', 'linked.txt'])('refuses an artifact unavailable within the worker tree: %s', async filename => {
    const f = await fixture(recovery);
    await writeFile(path.join(f.root, 'outside.txt'), 'outside');
    await symlink(path.join(f.root, 'outside.txt'), path.join(f.cwd, 'linked.txt'));
    const { result, evidence } = await f.launch({ ...valid(),
      artifacts: [{ path: filename, digest: digest('outside'), change: 'created' }] });
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence.terminalSuccess).toBe(false);
    expect(evidence.errors[0]).toMatch(/^\/artifacts\/0\/path /);
  });

  it('rejects a duplicate-key final before candidate extraction can hide it', async () => {
    const f = await fixture(recovery);
    const bytes = JSON.stringify(valid()).replace('"version":1', '"version":2,"version":1');
    const { result, evidence } = await f.launch(bytes);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence.terminalSuccess).toBe(false);
    expect(evidence.errors[0]).toContain('Duplicate');
  });

  it('#4158 uses a worker-written workerClaims final as written when the adapter extractor would reshape it', async () => {
    const f = await fixture(recovery);
    // Muse-style extraction parses the vendor JSONL event stream and would discard plain claims.
    f.drivers.codex.extractFinal = () => ({ events: [], text: null });
    const { result, evidence } = await f.launch(JSON.stringify(valid()));
    expect(result.errorCode ?? null).toBeNull();
    expect(evidence).toMatchObject({ source: 'worker-output', terminalSuccess: true });
  });

  it('validates the schema after stdout extraction too', async () => {
    const f = await fixture(recovery);
    f.drivers.codex.extractFinal = (text: string) => JSON.parse(text).result;
    const { result, evidence } = await f.launch(JSON.stringify({ type: 'result', result: { ...valid(), version: '1' } }), true);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence).toMatchObject({ source: 'adapter-extraction', terminalSuccess: false });
    expect(evidence.errors[0]).toMatch(/^\/version /);
  });
});

// Exercise installed-style extraction: Hermes returns { response: stdout },
// while its strict hook alone owns preamble stripping and claims decoding.
describe.each([false, true])('#3675 adapter stdout validation, recovery=%s', recovery => {
  const preamble = '⚠ tirith security scanner enabled but not available\n';

  it.each(malformed)('rejects stdout $label through the adapter hook', async ({ final, pointers }) => {
    const f = await fixture(recovery, new HermesAdapter());
    const { result, evidence } = await f.launch(preamble + JSON.stringify(final), true);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence).toMatchObject({ source: 'adapter-extraction', terminalSuccess: false });
    for (const pointer of pointers) expect(evidence.errors.some((error: string) => error.startsWith(`${pointer} `))).toBe(true);
  });

  it.each([false, true])('accepts stdout claims with listed artifacts=%s', async listed => {
    const f = await fixture(recovery, new HermesAdapter());
    await writeFile(path.join(f.cwd, 'answer.txt'), 'actual artifact');
    const final = { ...valid(), artifacts: listed
      ? [{ path: 'answer.txt', digest: digest('actual artifact'), change: 'created' }] : [] };
    const { result, evidence } = await f.launch(preamble + JSON.stringify(final), true);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBeFalsy();
    expect(evidence).toMatchObject({ source: 'adapter-extraction', terminalSuccess: true, verified: false });
    expect(result.health.state).toBe('completed');
  });

  it.each(['0'.repeat(64), '1'.repeat(64)])('rejects stdout artifact digest %s even with degraded termination', async hex => {
    const f = await fixture(recovery, new HermesAdapter());
    await writeFile(path.join(f.cwd, 'answer.txt'), 'actual artifact');
    const final = { ...valid(), artifacts: [{ path: 'answer.txt', digest: `sha256:${hex}`, change: 'created' }] };
    const { result, evidence } = await f.launch(preamble + JSON.stringify(final), true, 0, true);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence.errors).toEqual([expect.stringContaining('/artifacts/0/digest Artifact digest mismatch')]);
    expect(result.attemptOutcome).not.toBe('succeeded');
  });

  it('preserves strict rejection of a duplicate key after adapter framing', async () => {
    const f = await fixture(recovery, new HermesAdapter());
    const bytes = JSON.stringify(valid()).replace('"version":1', '"version":2,"version":1');
    const { result, evidence } = await f.launch(preamble + bytes, true);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(evidence.errors[0]).toContain('Duplicate');
  });

  it('keeps valid degraded stdout claims separate from confirmed termination', async () => {
    const f = await fixture(recovery, new HermesAdapter());
    const { result, evidence } = await f.launch(preamble + JSON.stringify(valid()), true, 0, true);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBeFalsy();
    expect(evidence.terminalSuccess).toBe(true);
    expect(result.termination).toBe('uncertain');
    expect(result.health.state).not.toBe('completed');
  });

  it.each([0, 1])('calls the strict adapter hook for a text final on exit %s', async exitCode => {
    const f = await fixture(recovery, new HermesAdapter());
    const { result, evidence } = await f.launch('partial free text', true, exitCode);
    expect(f.parseFinal).toHaveBeenCalledTimes(1);
    expect(f.parseFinal.mock.calls[0][1].observation.status).toBe(exitCode === 0 ? 'completed' : 'failed');
    await expect(f.parseFinal.mock.results[0].value).rejects.toThrow(exitCode === 0 ? /Malformed/ : /did not complete/);
    expect(evidence.terminalSuccess).toBe(exitCode === 0);
    expect(result.health.state).not.toBe('completed');
    expect(result.attemptOutcome).not.toBe('succeeded');
  });
});
