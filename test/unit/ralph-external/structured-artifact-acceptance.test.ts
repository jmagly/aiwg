// T-OG-04/10 partial: deterministic semantic checks through the protected acceptance harness.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadFixtureManifest, candidateInput } from '../../../tools/ralph-external/lib/structured-artifact-manifest.mjs';
import { scoreArtifact, scoreFixtureAttempts, runStructuredArtifactCheck } from '../../../tools/ralph-external/lib/structured-artifact-acceptance.mjs';
import { verifyWorkerArtifact } from '../../../tools/ralph-external/lib/trusted-verification.mjs';
import { EvalHarness } from '../../../tools/ralph-external/eval-harness.mjs';

const root = fileURLToPath(new URL('../../fixtures/worker-acceptance/', import.meta.url));
const manifestPath = join(root, 'manifest.v1.json');
const hash = (value: any) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const manifestDigest = hash(readFileSync(manifestPath));
const load = () => loadFixtureManifest(manifestPath, manifestDigest);
const golden = () => load().cases.find((c: any) => c.id === 'golden/receipt');
const response = () => JSON.parse(readFileSync(join(root, 'golden-response.json'), 'utf8'));
const evaluate = (value: any, fixture = golden()) => scoreArtifact(fixture, JSON.stringify(value));
const outcome = (r: any, path: string) => r.fields.find((f: any) => f.path === path);
const dirs: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'aiwg-field-acceptance-')); dirs.push(p); return p; };
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));

describe('versioned independent manifest', () => {
  it('binds all 36 supplied cases, source/schema/policy/gold versions and keeps oracles evaluator-only', () => {
    const m = load();
    expect(m.cases).toHaveLength(37);
    expect(m.provenance.commit).toBe('7f92a62b99d62d14b9c3a4fe499087d654cf6234');
    expect(m.manifestDigest).toBe(manifestDigest);
    expect(Object.isFrozen(m.cases[0].fields[0].expected)).toBe(true);
    expect(Object.keys(candidateInput(m.cases[0]))).toEqual(['source', 'question', 'schema']);
  });
  it('fails closed on changed manifest bytes, source/schema hashes, unscored conclusions and invalid policies', () => {
    const dir = temp();
    copyFileSync(join(root, 'REF-3173-missing-evidence-fixtures.json'), join(dir, 'REF-3173-missing-evidence-fixtures.json'));
    const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const mutate of [
      (m: any) => { m.extra = true; },
      (m: any) => { m.cases[0].source += 'forged'; },
      (m: any) => { m.cases[0].schema.required = []; },
      (m: any) => { m.cases[36].fields.pop(); },
      (m: any) => { m.cases[36].fields[2].absTol = -1; },
      (m: any) => { m.cases[36].fields[0].metric = 'alias'; },
      (m: any) => { m.cases[36].fields[2].units.USD = 0; },
      (m: any) => { m.cases[3].fields[0].expected.evidence.end = 99999; },
      (m: any) => { m.cases[0].fields[0].path = '/bad~pointer'; },
      (m: any) => { m.cases[0].fields[0].expected.value = 'guessed'; },
      (m: any) => { m.cases[36].fields[7].expected.value = 'not-null'; },
      (m: any) => { m.cases[36].fields[9].expected.value = ['nonempty']; },
      (m: any) => { m.cases[36].fields[0].expected.value = null; },
      (m: any) => { delete m.cases[36].fields[5].aliases; },
      (m: any) => { m.cases[36].fields[2].expected.value = '100'; },
      (m: any) => { m.cases[36].fields[12].expected.value = 'invented'; },
      (m: any) => { delete m.cases[36].fields[10].ordered; },
      (m: any) => { delete m.cases[36].fields[10].itemKey; },
      (m: any) => { m.cases[36].fields[10].attributes[0].path = '/missing'; },
      (m: any) => { m.cases[36].fields[1].expected.value = true; },
      (m: any) => { m.cases.push(m.cases[0]); },
      (m: any) => { m.cases[36].fields.push(m.cases[36].fields[0]); },
      (m: any) => { m.cases[0].schema.type = 'nonsense'; m.cases[0].schemaDigest = hash(JSON.stringify(m.cases[0].schema)); },
    ]) {
      const m = structuredClone(original); mutate(m);
      const bytes = JSON.stringify(m); const path = join(dir, 'manifest.json'); writeFileSync(path, bytes);
      expect(() => loadFixtureManifest(path, hash(bytes))).toThrow();
    }
    expect(() => loadFixtureManifest(manifestPath, hash('wrong'))).toThrow(/digest/);
    const path = join(dir, 'manifest.json'); writeFileSync(path, JSON.stringify(original));
    writeFileSync(join(dir, original.suite.file), '{}');
    expect(() => loadFixtureManifest(path, hash(readFileSync(path)))).toThrow(/digest/);
  });
});

describe('REF-3173 evidence absent/present pairs', () => {
  it.each(['required', 'nullable', 'explicit_unknown'])('%s retains impossible-schema conflict, escape use, fabrication and present controls', arm => {
    const cases = load().cases.filter((c: any) => c.arm === arm);
    expect(cases).toHaveLength(12);
    for (const c of cases) {
      const absent = c.id.includes('-absent');
      const values = Object.fromEntries(c.fields.map((f: any) => [f.path.slice(1), arm === 'explicit_unknown'
        ? absent ? { state: 'unknown', reason: 'evidence_absent' } : { state: 'known', value: f.expected.value }
        : f.expected.value]));
      const r = evaluate(values, c);
      expect(r.accepted).toBe(!absent || arm !== 'required');
      expect(r.structure.schemaValid).toBe(!absent || arm !== 'required');
      if (absent) {
        expect(r.fields.every((f: any) => f.outcome === (arm === 'required' ? 'unauthorized-abstention' : 'valid-abstention'))).toBe(true);
        const fabricated = { classification: c.schema.properties.classification.enum?.[0] ?? 'success', items: ['made up', 'another invention'], quote: 'Invented quotation.' };
        if (arm === 'explicit_unknown') for (const key of Object.keys(fabricated)) (fabricated as any)[key] = { state: 'known', value: (fabricated as any)[key] };
        const failed = evaluate(fabricated, c);
        expect(failed.accepted).toBe(false);
        expect(failed.fields.every((f: any) => f.outcome === 'unsupported-addition')).toBe(true);
      } else {
        const abstain = Object.fromEntries(c.fields.map((f: any) => [f.path.slice(1), arm === 'explicit_unknown' ? { state: 'unknown', reason: 'evidence_absent' } : null]));
        const failed = evaluate(abstain, c);
        expect(failed.accepted).toBe(false);
        expect(failed.fields.every((f: any) => f.outcome === 'over-abstention')).toBe(true);
      }
    }
  });
});

describe('REF-3174 golden field metrics', () => {
  it('accepts exact supported values, declared descriptive aliases, units and reordered arrays', () => {
    const v = response(); v.name = 'Acme Corp.'; v.amount = { value: 10000, unit: 'cents' }; v.records.reverse();
    const r = evaluate(v);
    expect(r.accepted).toBe(true);
    expect(outcome(r, '/records').alignment).toEqual([{ gold: 0, prediction: 1 }, { gold: 1, prediction: 0 }]);
  });
  it.each([
    ['id', '17', 'wrong-value'], ['count', 3.9, 'wrong-type'], ['count', true, 'wrong-type'],
    ['count', '3', 'wrong-type'], ['zero', 0.001, 'wrong-value'], ['relative', 100.2, 'wrong-value'],
    ['amount', { value: 100, unit: 'EUR' }, 'wrong-value'], ['url', 'https://example.test/receipt/0017/', 'wrong-value'],
    ['unknown', [], 'unsupported-addition'], ['empty', ['invented'], 'spurious-addition'],
    ['quote', 'Receipt confirmed. plus disclaimer', 'wrong-value'], ['name', 'Similar organization', 'wrong-value'],
  ])('rejects %s=%j without coercion or inferred evidence', (key, value, expected) => {
    const v = response(); v[key] = value;
    const r = evaluate(v);
    expect(outcome(r, `/${key}`).outcome).toBe(expected);
    expect(r.accepted).toBe(false);
  });
  it('compares decimal tolerance boundaries without binary rounding artifacts', () => {
    const c = structuredClone(golden());
    const f = c.fields.find((f: any) => f.path === '/amount');
    f.expected.value = 1; f.absTol = 0.1;
    const v = response(); v.amount = 1.1;
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(true);
    v.amount = 1.100001;
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(false);
  });
  it('uses explicit absolute and relative tolerance; distinguishes null, missing, unknown and known-empty', () => {
    const v = response(); v.amount = 100.09; v.relative = 100.09;
    expect(evaluate(v).accepted).toBe(true);
    delete v.explicitNull;
    const r = evaluate(v);
    expect(outcome(r, '/explicitNull')).toMatchObject({ state: 'MISSING_KEY', outcome: 'omission', pass: false });
    expect(outcome(r, '/unknown').state).toBe('EXPLICIT_NULL');
    expect(outcome(r, '/empty')).toMatchObject({ state: 'KNOWN_EMPTY', outcome: 'supported-pass' });
  });
  it('penalizes duplicates/spurious items at perfect recall and retains wrong matched attributes', () => {
    const v = response(); v.records.splice(1, 0, { id: 'A', amount: 10 });
    let a = outcome(evaluate(v), '/records');
    expect(a).toMatchObject({ tp: 2, fp: 1, fn: 0, precision: 2 / 3, recall: 1, f1: 0.8, pass: false, duplicates: [1] });
    v.records = [{ id: 'A', amount: 10 }];
    expect(outcome(evaluate(v), '/records')).toMatchObject({ tp: 1, fp: 0, fn: 1, f1: 2 / 3 });
    v.records = [{ id: 'A', amount: 11 }, { id: 'B', amount: 20 }];
    a = outcome(evaluate(v), '/records');
    expect(a).toMatchObject({ tp: 2, fp: 0, fn: 0, f1: 1, pass: false });
    expect(a.content[0].fields[0]).toMatchObject({ outcome: 'wrong-value', pass: false });
  });
  it('keeps ordered alignment and known-empty precision explicit', () => {
    const c = structuredClone(golden()); c.fields.find((f: any) => f.path === '/records').ordered = true;
    const v = response(); v.records.reverse();
    expect(evaluate(v, c).accepted).toBe(false);
    expect(outcome(evaluate(response()), '/empty')).toMatchObject({ precision: 1, recall: 1, f1: 1, knownEmpty: true });
  });
  it('missing required conclusions, extra fields and extra item attributes fail despite valid JSON', () => {
    for (const v of [{ ...response(), task: {} }, { ...response(), invented: true }, { ...response(), records: [{ id: 'A', amount: 10, invented: true }, { id: 'B', amount: 20 }] }]) {
      const r = evaluate(v);
      expect(r.structure.parseable).toBe(true);
      expect(r.structure.schemaValid).toBe(false);
      expect(r.accepted).toBe(false);
      expect(r.supportedPasses).toBe(0);
    }
  });
});

describe('strict raw structure and retained failure population', () => {
  it.each(['{}', '', 'I cannot answer.', '{"status":"refused"}', '{/* JSON5 */"id":"0017"}', '{"id":"0017",}', '{"id":"x","id":"0017"}', '{"id":"x","\\u0069d":"0017"}', '{"n":1e999}', '[NaN]', '{"items":[1,]}'])('retains raw %j and denies structural/escape credit', raw => {
    const r = scoreArtifact(golden(), Buffer.from(raw));
    expect(r.accepted).toBe(false);
    expect(r.supportedPasses).toBe(0);
    expect(r.raw).toEqual({ base64: Buffer.from(raw).toString('base64'), digest: hash(raw) });
    if (!['{}', '{"status":"refused"}'].includes(raw)) expect(r.structure.schemaValid).toBe(false);
  });
  it('repair-only success retains raw failure, separate hashes and transformation log', () => {
    const bytes = readFileSync(join(root, 'golden-response.json'), 'utf8').replace(/}\s*$/, ',}');
    const r = scoreArtifact(golden(), bytes, { repair: { raw: JSON.stringify(response()), transformation: 'remove final trailing comma' } });
    expect(r.accepted).toBe(false);
    expect(r.structure.outcome).toBe('parse-failure');
    expect(r.repair.accepted).toBe(true);
    expect(r.repair.intervention).toBe('repair');
    expect(r.repair.raw.digest).not.toBe(r.raw.digest);
    expect(r.repair.transformation).toBe('remove final trailing comma');
  });
  it.each(['transport-failure', 'schema-admission-rejection', 'truncation'])('keeps %s separate from parseability and end-to-end credit', operationalOutcome => {
    const r = scoreArtifact(golden(), JSON.stringify(response()), { operationalOutcome });
    expect(r.structure).toMatchObject({ outcome: operationalOutcome, parseable: true, schemaValid: true });
    expect(r.supportedPasses).toBe(0);
    expect(r.accepted).toBe(false);
  });
  it('reports scheduled failures, distinct denominators, valid-only, domain macro/micro, severity and arm strata', () => {
    const m = load(); const c = golden();
    const r = scoreFixtureAttempts({ ...m, cases: [c, { ...c, id: 'outage', domain: 'other' }] }, [{ id: c.id, raw: JSON.stringify(response()) }]);
    expect(r.denominators).toEqual({ attempts: 2, schema_field_positions: 26, expanded_leaf_values: 30, array_items: 4 });
    expect(r.micro).toEqual({ passes: 13, total: 26, rate: 0.5 });
    expect(r.macro).toEqual({ domains: 2, rate: 0.5 });
    expect(r.validOnly).toMatchObject({ label: 'schema-valid operational successes only', attempts: 1, passes: 13, total: 13, rate: 1 });
    expect(r.criticalGate).toBe(false);
    expect(r.results[1].structure.outcome).toBe('missing-output');
    expect(r.strata.arm.golden.attempts).toBe(2);
    expect(r.strata.severity.critical.total).toBe(24);
    expect(r.outcomes['structural-failure']).toBe(13);
    expect(() => scoreFixtureAttempts(m, [{ id: 'not-scheduled', raw: '{}' }])).toThrow();
    expect(() => scoreFixtureAttempts(m, [{ id: c.id, raw: '{}' }, { id: c.id, raw: '{}' }])).toThrow();
  });
});

describe('additional strict failure and metric boundaries', () => {
  it('keeps malformed bytes, nested duplicates and excessive depth as strict parse failures', () => {
    for (const raw of [Buffer.from([0xff]), Buffer.from('{"outer":{"x":1,"x":2}}'), Buffer.from('['.repeat(258) + '0' + ']'.repeat(258))]) {
      expect(scoreArtifact(golden(), raw).structure.outcome).toBe('parse-failure');
    }
    expect(() => scoreArtifact(golden(), Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(/exceeds/);
    expect(() => scoreArtifact(golden(), '{}', { operationalOutcome: 'unrecognized' })).toThrow();
    expect(() => scoreArtifact(golden(), '{}', { repair: { raw: '{}' } })).toThrow(/transformation/);
  });
  it('honors signed, exponential and decimal unit boundaries, nested item misses and exact quote whitespace', () => {
    const c = structuredClone(golden()); const v = response();
    const amount = c.fields.find((f: any) => f.path === '/amount');
    amount.expected.value = -1; amount.absTol = 0.1; v.amount = -1.1;
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(true);
    amount.expected.value = 1e21; amount.absTol = 0; v.amount = 1e21;
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(true);
    amount.expected.value = 1e-7; v.amount = 1e-7;
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(true);
    amount.expected.value = 1; amount.absTol = 0.1; v.amount = { value: 110, unit: 'cents' };
    expect(outcome(evaluate(v, c), '/amount').pass).toBe(true);
    v.amount = '100'; expect(outcome(evaluate(v, c), '/amount').outcome).toBe('wrong-type');
    v.records = [{ amount: 10 }, { id: 'B', amount: 20 }];
    expect(outcome(evaluate(v), '/records')).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    const quote = c.fields.find((f: any) => f.path === '/quote');
    quote.whitespace = 'collapse'; v.quote = ' Receipt   confirmed. ';
    expect(outcome(evaluate(v, c), '/quote').pass).toBe(true);
    expect(outcome(evaluate(v), '/quote').pass).toBe(false);
    v.explicitNull = 'invented';
    expect(outcome(evaluate(v), '/explicitNull').outcome).toBe('wrong-value');
  });
  it('denies malformed unknown reasons and retains present/absent fabrication strata with intervals', () => {
    const m = load(); const unknown = m.cases.find((c: any) => c.id === 'social-absent/explicit_unknown');
    const malformed = { classification: { state: 'unknown', reason: 'guess' }, items: { state: 'known', value: [] }, quote: { state: 'unknown', reason: 'evidence_absent', extra: true } };
    const r = evaluate(malformed, unknown);
    expect(r.fields.map((f: any) => f.outcome)).toEqual(['unauthorized-abstention', 'unsupported-addition', 'unauthorized-abstention']);
    const report = scoreFixtureAttempts({ ...m, cases: [unknown] }, [{ id: unknown.id, raw: JSON.stringify(malformed) }]);
    const s = report.missingEvidence['social/explicit_unknown'];
    expect(s).toMatchObject({ fabricatedCases: 1, fabricatedFields: 1, absentAttempts: 1, absentPositions: 3, validAbstentions: 0, failedOutputs: 1 });
    expect(s.intervals.fieldFabrication).toMatchObject({ method: 'wilson-95', passes: 1, total: 3 });
    expect(s.intervals.presentCorrectness).toBeNull();
    expect(s.intervals.fieldFabrication.lower).toBeLessThan(1 / 3);
    expect(s.intervals.fieldFabrication.upper).toBeGreaterThan(1 / 3);
    const empty = scoreFixtureAttempts({ ...m, cases: [] }, []);
    expect(empty.micro.rate).toBeNull(); expect(empty.macro.rate).toBeNull(); expect(empty.criticalGate).toBe(false);
  });
  it('fails closed on instrument usage, missing artifacts and unknown case identifiers', () => {
    const output: string[] = [];
    for (const args of [[], [manifestPath, manifestDigest, 'not-a-case', '/missing'], [manifestPath, manifestDigest, 'golden/receipt', '/missing']]) {
      expect(runStructuredArtifactCheck(args, (s: string) => output.push(s))).toBe(1);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ score: 0, pass_count: 0, total_count: 1 });
    }
  });
});

describe('protected semantic instrument in existing acceptance harness', () => {
  const instrument = fileURLToPath(new URL('../../../tools/ralph-external/lib/structured-artifact-acceptance.mjs', import.meta.url));
  it('rejects parseable unsupported critical values, retains artifacts, and lets EvalHarness expose aggregates only', () => {
    const tree = temp(); const output = temp(); const artifact = join(tree, 'answer.json');
    for (const [value, status] of [[response(), 'accepted'], [{ ...response(), id: '17' }, 'rejected'], [{ ...response(), task: {} }, 'rejected']] as const) {
      writeFileSync(artifact, JSON.stringify(value));
      const args = [instrument, manifestPath, manifestDigest, 'golden/receipt', artifact];
      const result = verifyWorkerArtifact({ worktreeRoot: tree, artifactPath: artifact, outputDirReal: output,
        allowedCheckBinaries: [process.execPath], checks: [{ id: 'independent-fields', command: process.execPath, args, allowWorktreeInterpreterArgs: true,
          runConfined: (opts: any) => ({ ...spawnSync(opts.command, opts.args, { encoding: 'utf8', timeout: 10000 }), isolation: { mode: 'systemd-unit', degraded: [] } }) }] });
      expect(result.status).toBe(status);
      expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual(value);
      const r = new EvalHarness({ score: { command: 'protected-semantic-instrument' } }, { workingDir: tree,
        runner: { run: () => { const s = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 }); return { code: s.status, stdout: s.stdout, stderr: s.stderr }; } } }).run();
      expect(r.optimizer_feedback.status).toBe(status === 'accepted' ? 'pass' : 'error');
      expect(r.optimizer_feedback).not.toHaveProperty('fields');
      expect(r.optimizer_feedback).not.toHaveProperty('raw');
    }
  });
});
