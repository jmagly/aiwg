// Offline collection receipts, resolver fidelity, budget/resume and calibration integration.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { runOfflinePilot } from '../../../tools/eval/src/pilot.js';
import { calibrate } from '../../../tools/eval/src/calibration.js';
import { digest, hash } from '../../../tools/eval/src/pilot-files.js';
import { validateEvalContract } from '../../../tools/eval/src/contracts.js';
import { setupJudgeProject } from '../../../tools/eval/src/judge-project.js';
import { renderJudgePrompt } from '../../../tools/eval/src/judge-collect.js';
import { makeBundles } from '../../../tools/eval/src/calibration-validate.js';
const fixture = path.resolve('test/fixtures/eval-pilot');
const temporary: string[] = [];
let records: any[], study: any;
beforeAll(async () => {
  records = (await runOfflinePilot('tools/eval/datasets/composition-pilot.json', fixture)).pilot!.records;
  study = JSON.parse(await readFile(path.join(fixture, 'calibration.v1.json'), 'utf8'));
});
afterEach(async () => { delete process.env.FAKE_JUDGE_MODE; delete process.env.OPENROUTER_API_KEY; await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(overrides: any = {}) {
  const { collectJudges } = await import('../../../tools/eval/src/judge-collect.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'judge-collect-')); temporary.push(root);
  const options = { study, records, runDir: path.join(root, 'archive'), judgeProject: path.join(root, 'project'), tranche: 'dev', seed: 4240, maxCalls: 2, maxAttempts: 2,
    evaluators: [{ id: 'codex', transport: 'cli', group: 'workers', role: 'efficiency' }],
    resolver: { file: process.execPath, args: [path.join(fixture, 'fake-judge.mjs')] }, ...overrides };
  await setupJudgeProject(options.judgeProject, path.join(fixture, 'judge-project.config.json'), path.join(fixture, 'judge-project.models.json'), options.evaluators);
  for (const args of [['effect', 'keys', 'init'], ['doctor', '--probe-workers', '--qualify', '--yes']]) {
    await promisify(execFile)(options.resolver.file, [...options.resolver.args, ...args], { cwd: options.judgeProject });
  }
  return { collectJudges, options };
}
describe('T-OG-10 judge vote collection (partial)', () => {
  it('lists exactly the present non-null evidence span IDs in stable order and explains abstention citations', () => {
    const bundle = makeBundles(records, study)[0];
    const criterion = study.criteria[1];
    for (const extra of [{}, { zero: 0, false: false, empty: '', array: [], object: {}, missing: null }]) {
      const evidence = { ...bundle.evidence, ...extra };
      const reversed = Object.fromEntries(Object.entries(evidence).reverse());
      const prompt = renderJudgePrompt(study, { ...bundle, evidence: reversed }, criterion, Object.keys(criterion.anchors));
      const line = prompt.split('\n').find(row => row.startsWith('Citable evidence span IDs'))!;
      const ids = JSON.parse(line.slice(line.indexOf(': ') + 2));
      const expected = ['checks', 'input', 'output', 'output_status', 'request',
        ...('zero' in extra ? ['zero', 'false', 'empty', 'array', 'object'] : [])].sort();
      expect(ids).toEqual(expected);
      for (const [id, value] of Object.entries(evidence)) if (value === null) expect(ids).not.toContain(id);
      const reordered = renderJudgePrompt(study, { ...bundle, evidence }, criterion, Object.keys(criterion.anchors));
      expect(reordered.split('\n').find(row => row.startsWith('Citable evidence span IDs'))).toBe(line);
      expect(prompt).toContain('Express missing evidence with label CANNOT_ASSESS');
      expect(prompt).toContain('never cite an absent or null span ID');
      expect(prompt).toContain('may be empty only for CANNOT_ASSESS or, when permitted, NOT_APPLICABLE');
      expect(prompt).toContain('Every assessed label requires at least one listed span ID');
    }
  });
  it.each(['artifact', 'artifact-absolute'])('accepts envelope + %s and archives exact bytes and digest with the vote', async mode => {
    const { collectJudges, options } = await setup({ maxCalls: 1 });
    process.env.FAKE_JUDGE_MODE = mode;
    const result = await collectJudges(options);
    const vote = result.study.votes[0];
    expect(vote).toMatchObject({ status: 'completed', label: 'CANNOT_ASSESS', rationale: 'Synthetic missing evidence' });
    const archive = path.join(options.runDir, vote.execution_id);
    const envelope = JSON.parse(await readFile(path.join(archive, 'final.json'), 'utf8'));
    expect(envelope.summary).toBe('Judgment saved in the artifact.');
    const reference = vote.settings.judgment_artifact;
    const bytes = await readFile(path.join(archive, reference.ref));
    expect(bytes).toEqual(await readFile(path.join(archive, 'answer.json')));
    expect(reference.digest).toBe(hash(bytes));
    expect(reference.digest).toBe(envelope.artifacts[0].digest);
    expect(vote.settings_digest).toBe(digest(vote.settings));
    expect(vote.prompt).toContain('write this judgment to answer.json beside the requested final-output file');
    expect(vote.prompt).toContain('Declare exactly one artifact');
    expect(await readdir(path.join(options.judgeProject, '.judge-attempts'))).toEqual([]);
    validateEvalContract('CalibrationStudy', result.study);
    expect((await collectJudges(options)).study.votes).toHaveLength(1);
  });
  it.each([
    ['artifact-digest', 'digest mismatch'],
    ['artifact-escape', 'path escapes attempt staging directory'],
    ['artifact-absolute-escape', 'path escapes attempt staging directory'],
    ['artifact-symlink', 'symlink escapes attempt staging directory'],
    ['artifact-two', 'exactly one JSON artifact'],
    ['artifact-non-json', 'path must name a JSON file'],
    ['artifact-missing', 'ENOENT'],
    ['artifact-no-digest', 'digest must be sha256'],
  ])('rejects %s with a precise reason', async (mode, reason) => {
    const { collectJudges, options } = await setup({ maxCalls: 1 });
    process.env.FAKE_JUDGE_MODE = mode;
    const vote = (await collectJudges(options)).study.votes[0];
    expect(vote).toMatchObject({ status: 'partial', label: null, critical_flags: ['invalid-judgment'] });
    expect(vote.rationale).toContain(reason);
    if (mode === 'artifact-digest') {
      const reference = vote.settings.judgment_artifact;
      expect(reference.digest).toBe(hash(await readFile(path.join(options.runDir, vote.execution_id, reference.ref))));
      expect(reference.digest).not.toBe(reference.declared_digest);
    }
  });
  it('surfaces exclusion diagnostics when the blocked resolver has no top-level diagnostics', async () => {
    const { collectJudges, options } = await setup({ maxCalls: 6,
      evaluators: [{ id: 'muse', transport: 'cli', group: 'muse-external', role: 'efficiency' }] });
    process.env.FAKE_JUDGE_MODE = 'blocked-exclusions';
    const result = await collectJudges(options);
    expect(result.study.collection.stop_reason).toBe('resolver-blocked');
    expect(result.study.votes).toHaveLength(1);
    const vote = result.study.votes[0];
    expect(vote.settings.diagnostic.diagnostics).toEqual([{ group: 'muse-external', member: 'muse-worker',
      model: 'synthetic-muse', effort: 'low', code: 'OG_ADAPTER_UNQUALIFIED',
      message: 'Missing exact model, inference provider, observation or current installation evidence' }]);
    for (const value of ['muse-external', 'muse-worker', 'synthetic-muse', 'low', 'OG_ADAPTER_UNQUALIFIED',
      'Missing exact model, inference provider, observation or current installation evidence']) expect(vote.rationale).toContain(value);
  });
  it('sets up declared native inputs without overwriting an existing project', async () => {
    const { options } = await setup();
    expect(await readFile(path.join(options.judgeProject, '.aiwg/aiwg.config'), 'utf8'))
      .toBe(await readFile(path.join(fixture, 'judge-project.config.json'), 'utf8'));
    expect(await readFile(path.join(options.judgeProject, 'models.json'), 'utf8'))
      .toBe(await readFile(path.join(fixture, 'judge-project.models.json'), 'utf8'));
    expect(await readFile(path.join(options.judgeProject, '.fake-qualified'), 'utf8')).toBe(options.judgeProject);
    await expect(setupJudgeProject(options.judgeProject, path.join(fixture, 'judge-project.config.json'),
      path.join(fixture, 'judge-project.models.json'), options.evaluators)).rejects.toThrow(/EEXIST/);
  });
  it.each(['assessment', 'inventory'])('passes the configured %s task to the resolver', async task => {
    const { collectJudges, options } = await setup({ maxCalls: 1,
      evaluators: [{ id: 'custom', transport: 'cli', group: 'workers', role: 'efficiency', task }] });
    const vote = (await collectJudges(options)).study.votes[0];
    expect(vote.status).toBe('completed');
    expect(vote.settings.task).toBe(task);
    const args = vote.settings.resolver.args;
    expect(args[args.indexOf('--task') + 1]).toBe(task);
  });
  it.each(['blocked', 'blocked-stdout'])('stops immediately on %s, retains diagnostics and does not repeat on resume', async mode => {
    const { collectJudges, options } = await setup({ maxCalls: 12 });
    process.env.FAKE_JUDGE_MODE = mode;
    const result = await collectJudges(options);
    expect(result.study.votes).toHaveLength(1);
    expect(result.study.collection.stop_reason).toBe('resolver-blocked');
    expect(result.study.votes[0]).toMatchObject({ status: 'provider-error', cost_usd: 'unknown', critical_flags: ['resolver-blocked'] });
    expect(result.study.votes[0].rationale).toContain('OG_CONFIG_REFERENCE');
    expect(result.study.votes[0].rationale).toContain('Direct worker dispatch is off');
    await expect(readFile(path.join(options.runDir, result.study.votes[0].execution_id, 'final.json'))).rejects.toThrow();
    expect((await collectJudges(options)).study.votes).toHaveLength(1);
  });
  it('resumes a corrected block only on explicit retry, preserving lineage and cumulative caps', async () => {
    const { collectJudges, options } = await setup({ maxCalls: 2 });
    process.env.FAKE_JUDGE_MODE = 'blocked';
    const first = await collectJudges(options);
    delete process.env.FAKE_JUDGE_MODE;
    expect((await collectJudges(options)).study.votes).toHaveLength(1);
    const retried = await collectJudges({ ...options, retryBlocked: true });
    expect(retried.study.votes).toHaveLength(2);
    expect(retried.study.votes[1]).toMatchObject({ status: 'completed', retry_of: first.study.votes[0].execution_id });
    expect(retried.study.collection.stop_reason).toBe('max-calls');
    expect((await collectJudges({ ...options, maxCalls: 3 })).study.votes).toHaveLength(3);
  });
  it('archives isolated absolute attempt paths and removes previous outputs before the next launch', async () => {
    const { collectJudges, options } = await setup();
    const { study: result } = await collectJudges(options);
    expect(await readdir(path.join(options.judgeProject, '.judge-attempts'))).toEqual([]);
    for (const vote of result.votes) {
      const archive = path.join(options.runDir, vote.execution_id);
      const isolated = JSON.parse(await readFile(path.join(archive, 'brief.txt.isolation.json'), 'utf8'));
      expect(isolated).toMatchObject({ cwd: options.judgeProject, entries: [vote.execution_id] });
      expect(isolated.files).not.toContain('final.json');
      expect(JSON.parse(await readFile(path.join(archive, 'final.json'), 'utf8')).label).toBe('CANNOT_ASSESS');
      const args = vote.settings.resolver.args;
      for (const flag of ['--brief', '--final-output']) expect(path.isAbsolute(args[args.indexOf(flag) + 1])).toBe(true);
    }
    expect(result.votes[0].settings.command).not.toBe(result.votes[1].settings.command);
    expect(await readdir(options.judgeProject)).not.toContain('.judge-collector.lock');
  });
  it('requires a project and rejects unknown/conflicting tasks or nested archives before dispatch', async () => {
    const { collectJudges, options } = await setup();
    await expect(collectJudges({ ...options, judgeProject: undefined })).rejects.toThrow(/--judge-project/);
    for (const task of ['unknown-task', 'review', 'implementation', 'architecture']) {
      await expect(collectJudges({ ...options, evaluators: [{ ...options.evaluators[0], task }] })).rejects.toThrow(/task class or conflicting role/);
    }
    await expect(collectJudges({ ...options, runDir: path.join(options.judgeProject, 'archive') })).rejects.toThrow(/non-nested/);
    await expect(readFile(path.join(options.runDir, 'study.json'))).rejects.toThrow();
  });
  it('locks the shared project and refuses unreconciled staged outputs from an interrupted process', async () => {
    const { collectJudges, options } = await setup();
    const lock = path.join(options.judgeProject, '.judge-collector.lock');
    await writeFile(lock, '');
    await expect(collectJudges(options)).rejects.toThrow(/EEXIST/);
    await rm(lock);
    await mkdir(path.join(options.judgeProject, '.judge-attempts', 'interrupted'), { recursive: true });
    await expect(collectJudges(options)).rejects.toThrow(/interrupted staged attempt/);
    await expect(readFile(lock)).rejects.toThrow();
  });
  it('plans all blinded packet/criterion/config pairs without writes or launches', async () => {
    const { collectJudges, options } = await setup({ dryRun: true });
    const result = await collectJudges(options);
    expect(result.plan.estimated_calls).toBe(128 * 6);
    expect(result.plan.human_labels_needed).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
    await expect(readFile(path.join(options.runDir, 'study.json'))).rejects.toThrow();
  });
  it('archives exact resolver commands, prompts, all settings and unknown accounting; calibrates end to end', async () => {
    const { collectJudges, options } = await setup();
    const result = await collectJudges(options);
    expect(result.study.votes).toHaveLength(2);
    validateEvalContract('CalibrationStudy', result.study);
    const vote = result.study.votes[0];
    expect(vote).toMatchObject({ status: 'completed', label: 'CANNOT_ASSESS', cost_usd: 'unknown', tokens: 'unknown', retry_of: null, secondary_flags: ['fixture'] });
    expect(vote.raw_digest).toBe(digest(vote.raw_response));
    expect(vote.prompt_digest).toBe(digest(vote.prompt));
    expect(vote.settings_digest).toBe(digest(vote.settings));
    expect(vote.observed_model).toBe('unknown');
    expect(result.study.humans).toEqual([]);
    expect(result.study.collection.executable_references).toHaveLength(128);
    expect(result.study.collection.executable_references[0].type).toBe('executable-reference');
    expect(result.study.collection.executable_references[0].provenance.checker.ref).toBe('tools/eval/src/pilot-checks.ts');
    expect(result.study.collection.executable_references.every((r: any) => !/^Q[1-6]$/.test(r.criterion_id))).toBe(true);
    for (const row of result.study.votes) {
      const packet = JSON.parse(row.prompt.slice(row.prompt.indexOf('\n{') + 1)).packet;
      const rendered = JSON.parse(row.prompt.slice(row.prompt.indexOf('\n{') + 1));
      expect(rendered.criterion.anchors.map((a: any) => a.label)).toEqual(row.option_order);
      expect(Object.keys(packet)).toEqual(['episode_id', 'bundle_digest', 'evidence']);
      expect(row.prompt).not.toMatch(/arm_id|hypothesis|observed_model|h1-none|h2-|offline-fixture-model|task_id|corpus-verification/);
      const args = JSON.parse(await readFile(path.join(options.runDir, row.execution_id, 'brief.txt.resolve.json'), 'utf8'));
      const staged = path.join(options.judgeProject, '.judge-attempts', row.execution_id);
      expect(args).toEqual(['models', 'resolve', '--role', 'efficiency', '--task', 'inventory', '--group', 'workers', '--brief', path.join(staged, 'brief.txt'), '--workdir', options.judgeProject, '--final-output', path.join(staged, 'final.json'), '--transport', 'shell', '--format', 'shell']);
      expect(JSON.parse(await readFile(path.join(options.runDir, row.execution_id, 'brief.txt.cwd.json'), 'utf8'))).toBe(options.judgeProject);
      expect(row.settings.resolver.cwd).toBe(options.judgeProject);
    }
    const report = calibrate(result.study, records);
    expect(report.total_cost_usd).toBe('unknown');
    validateEvalContract('CalibrationReport', report);
    expect(report.claim_gate.state).toBe('BLOCKED');
  });
  it('retains retry lineage and never retries a completed judgment on resume', async () => {
    process.env.FAKE_JUDGE_MODE = 'retry';
    const { collectJudges, options } = await setup();
    const first = await collectJudges(options);
    expect(first.study.votes.map((v: any) => v.status)).toEqual(['provider-error', 'completed']);
    expect(first.study.votes[1].retry_of).toBe(first.study.votes[0].execution_id);
    const same = await collectJudges(options); expect(same.study.votes).toHaveLength(2);
    const resumed = await collectJudges({ ...options, maxCalls: 3 });
    expect(resumed.study.votes).toHaveLength(3);
    expect(resumed.study.votes[2].episode_id + resumed.study.votes[2].criterion_id).not.toBe(first.study.votes[0].episode_id + first.study.votes[0].criterion_id);
    expect(() => calibrate(resumed.study, records)).not.toThrow();
    await expect(collectJudges({ ...options, seed: 1 })).rejects.toThrow(/configuration/);
  });
  it.each(['partial', 'missing', 'error'])('keeps %s responses distinct and caps retries', async mode => {
    process.env.FAKE_JUDGE_MODE = mode;
    const { collectJudges, options } = await setup({ maxCalls: 3 });
    const result = await collectJudges(options);
    expect(result.study.votes[0].status).toBe(mode === 'error' ? 'provider-error' : mode);
    expect(result.study.votes[0].label).toBeNull();
    expect(result.study.votes[1].retry_of).toBe(result.study.votes[0].execution_id);
    expect(result.study.votes[2].retry_of).toBeNull();
    expect(() => calibrate(result.study, records)).not.toThrow();
  });
  it('archives NOT_APPLICABLE separately from CANNOT_ASSESS', async () => {
    process.env.FAKE_JUDGE_MODE = 'na';
    const { collectJudges, options } = await setup({ maxCalls: 6 });
    const result = await collectJudges(options);
    expect(result.study.votes.map((v: any) => v.label)).toEqual(['CANNOT_ASSESS', 'CANNOT_ASSESS', 'CANNOT_ASSESS', 'CANNOT_ASSESS', 'NOT_APPLICABLE', 'CANNOT_ASSESS']);
  });
  it.each(['cursor', 'muse-external'])('resolves %s through the same AIWG surface', async group => {
    const { collectJudges, options } = await setup({ maxCalls: 1, evaluators: [{ id: group, transport: 'cli', role: 'efficiency', group }] });
    expect((await collectJudges(options)).study.votes[0].status).toBe('completed');
  });
  it.each(['ok', 'unknown', 'partial', 'error', 'empty', 'disconnected'])('archives HTTP %s without leaking credentials and reserves costs', async mode => {
    const { fakeHttp } = await import('../../fixtures/eval-pilot/fake-http.mjs');
    const server = await fakeHttp(mode); process.env.OPENROUTER_API_KEY = 'fixture-secret';
    try {
      const { collectJudges, options } = await setup({ maxCalls: 4, maxUsd: 0.02, httpEndpoint: server.url,
        evaluators: [{ id: 'http', transport: 'openrouter', model: 'requested', max_call_usd: 0.02, max_tokens: 100 }] });
      const result = await collectJudges(options);
      expect(result.study.votes).toHaveLength(1);
      expect(result.study.votes[0].status).toBe(mode === 'error' ? 'provider-error' : ['partial', 'disconnected'].includes(mode) ? 'partial' : mode === 'empty' ? 'missing' : 'completed');
      expect(result.study.votes[0].cost_usd).toBe(['ok', 'partial'].includes(mode) ? 0.01 : 'unknown');
      expect(result.study.votes[0].observed_model).toBe(['error', 'empty', 'disconnected'].includes(mode) ? 'unknown' : 'observed-model');
      if (mode === 'disconnected') expect(result.study.votes[0].raw_response).toBe('{\"choices\":[');
      expect(JSON.stringify(result)).not.toContain('fixture-secret');
      expect(await readFile(path.join(options.runDir, 'study.json'), 'utf8')).not.toContain('fixture-secret');
      expect(server.requests[0].authorization).toBe('Bearer fixture-secret');
      expect(() => calibrate(result.study, records)).not.toThrow();
    } finally { await server.close(); }
  });
  it.each(['event-error', 'observed', 'wrapper'])('uses existing CLI observation and final handling for %s', async mode => {
    process.env.FAKE_JUDGE_MODE = mode;
    const { collectJudges, options } = await setup({ maxCalls: 1 });
    const vote = (await collectJudges(options)).study.votes[0];
    expect(vote.status).toBe(mode === 'event-error' ? 'provider-error' : 'completed');
    expect(vote.observed_model).toBe(mode === 'observed' ? 'observed-codex' : 'unknown');
  });
  it('stops before the first call at zero caps and freezes the held-out plan', async () => {
    const { collectJudges, options } = await setup({ maxCalls: 0, tranche: 'heldout' });
    const result = await collectJudges(options);
    expect(result.plan.estimated_calls).toBe(256 * 6);
    expect(result.study.votes).toEqual([]);
    expect(result.study.collection.stop_reason).toBe('max-calls');
    const report = calibrate(result.study, records);
    expect(report.candidates[0].criteria.Q1.missing).toBe(256);
    const http = await setup({ maxUsd: 0, evaluators: [{ id: 'h', transport: 'openrouter', model: 'x', max_tokens: 1, max_call_usd: 0.01 }] });
    const capped = await http.collectJudges(http.options);
    expect(capped.study.votes).toEqual([]);
    expect(capped.study.collection.stop_reason).toBe('max-usd');
  });
  it('recovers committed receipts and stops for an unresolved interrupted dispatch', async () => {
    const { collectJudges, options } = await setup({ maxCalls: 1 });
    const result = await collectJudges(options);
    const saved = structuredClone(result.study);
    Object.assign(saved.votes[0], { status: 'missing', label: null, critical_flags: ['in-flight'] });
    await writeFile(path.join(options.runDir, 'study.json'), JSON.stringify(saved));
    const recovered = await collectJudges(options);
    expect(recovered.study.votes[0].status).toBe('completed');
    await rm(path.join(options.runDir, saved.votes[0].execution_id, 'vote.json'));
    await writeFile(path.join(options.runDir, 'study.json'), JSON.stringify(saved));
    const stopped = await collectJudges({ ...options, maxCalls: 2 });
    expect(stopped.study.collection.stop_reason).toBe('in-flight');
    expect(stopped.study.votes).toHaveLength(1);
  });
  it('resumes HTTP using cumulative reservations and stops on unexpectedly high reported spend', async () => {
    const { fakeHttp } = await import('../../fixtures/eval-pilot/fake-http.mjs');
    const server = await fakeHttp('over-budget'); process.env.OPENROUTER_API_KEY = 'fixture-secret';
    try {
      const { collectJudges, options } = await setup({ maxUsd: 0.02, maxCalls: 3, httpEndpoint: server.url,
        evaluators: [{ id: 'h', transport: 'openrouter', model: 'x', max_tokens: 1, max_call_usd: 0.02 }] });
      const result = await collectJudges(options);
      expect(result.study.votes).toHaveLength(1);
      expect(result.study.collection.stop_reason).toBe('max-usd');
      await collectJudges(options); expect(server.requests).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('keeps the declared shuffle seed reproducible across fresh run directories', async () => {
    const first = await setup({ maxCalls: 6 });
    const second = await setup({ maxCalls: 6 });
    const third = await setup({ maxCalls: 6, seed: 88 });
    const a = (await first.collectJudges(first.options)).study.votes.map((v: any) => v.option_order);
    const b = (await second.collectJudges(second.options)).study.votes.map((v: any) => v.option_order);
    const c = (await third.collectJudges(third.options)).study.votes.map((v: any) => v.option_order);
    expect(a).toEqual(b); expect(a).not.toEqual(c);
  });
  it('rejects prompt/settings drift in collected archives', async () => {
    const { collectJudges, options } = await setup({ maxCalls: 1 });
    const result = await collectJudges(options);
    const changed = structuredClone(result.study); changed.votes[0].prompt += 'drift';
    expect(() => calibrate(changed, records)).toThrow(/prompt digest/);
    changed.votes[0] = { ...result.study.votes[0], settings: { drift: true } };
    expect(() => calibrate(changed, records)).toThrow(/settings digest/);
    const previous = structuredClone(result.study);
    previous.votes[0].prompt += '\nPrevious brief version';
    previous.votes[0].prompt_digest = digest(previous.votes[0].prompt);
    expect(() => calibrate(previous, records)).not.toThrow();
    await writeFile(path.join(options.runDir, 'study.json'), JSON.stringify(previous));
    await expect(collectJudges(options)).rejects.toThrow(/Resume prompt drift; use a fresh run directory/);
  });
  it('requires caps/tranche, rejects malformed configs and never treats unknown cost as zero', async () => {
    const { collectJudges, options } = await setup();
    for (const change of [{ maxCalls: undefined }, { tranche: undefined }, { maxCalls: -1 }, { tranche: 'all' }, { evaluators: [] },
      { evaluators: [{ id: 'x', transport: 'openrouter', model: 'x', max_call_usd: 0.1, max_tokens: 10 }] }]) {
      await expect(collectJudges({ ...options, ...change })).rejects.toThrow();
    }
  });
});
