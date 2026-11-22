// Exercise optional semantic review on the shipped corpus without a network provider.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { diagnoseWriting, diagnoseWritingAssisted, diagnoseWritingBatchAssisted } from '../../../src/writing/contextual-diagnostics.js';
import { structuralCandidates } from '../../../src/writing/structural-patterns.js';
import { maskProse } from '../../../src/writing/prose-mask.js';
import { campaignReport } from '../../../src/writing/campaign-report.js';
import * as decision from '../../../src/decision/ask.js';
import { modelAssistedPatterns } from '../../../src/writing/structural-judgment.js';
import type { DecisionAdapter, DecisionAdapterRequest } from '../../../src/decision/types.js';
import { WritingValidationEngine } from '../../../src/writing/validation-engine.js';
import { baseline, compareFindings, corpus, fixtureRoot, repo, scanCorpus, severityTier, textOf } from './helpers/quality-corpus.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'writing-judgment-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const env = { HOME: home, XDG_CONFIG_HOME: home, AIWG_DECISION_ENABLED: '1' };
// These seven editorial answers are a stub oracle, not a replacement detector.
const yes = [
  'The tool does not remember. The tool does repeat.',
  'A score does not explain the failure. A score does reassure.',
  'The agent does not decide. The agent does comply.',
  'The standard for',
  'Recording the check before a post goes out:',
  'Use the command below to start:',
  'Ready. Waiting. Done.',
];
const result = (answer: boolean, confidence: number | null = 0.94) => ({
  schema: 'aiwg-decision-ask/v1' as const, status: 'answered' as const, answer,
  confidence, fallback: null, reason: 'none', model: 'offline-stub', usage: null, latencyMs: 0,
});
const ask = vi.fn(async (input: { context?: string }) => result(yes.some(s => JSON.parse(input.context!).excerpt.startsWith(s))));
const runtime = () => ({ env, ask });
const scanner = path.join(repo, 'agentic/code/addons/writing-quality/skills/ai-pattern-detection/scripts/pattern_scanner.py');
const python = `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
data = json.load(sys.stdin)
def ask(payload):
    excerpt = json.loads(payload['context'])['excerpt']
    return dict(status='answered', answer=any(excerpt.startswith(s) for s in data['yes']), confidence=0.94)
print(json.dumps({name: m['scan_text'](text, judgment=ask) for name, text in data['sources'].items()}))
`;

describe('model-assisted structural review (#4137)', () => {
  it('recovers all 56 annotations per surface and keeps all 22 wholly negative files clean', async () => {
    const scans = await scanCorpus();
    const sources = Object.fromEntries(Object.keys(corpus.files).map(f => [f, textOf(f)]));
    const py = JSON.parse(execFileSync('python3', ['-I', '-c', python, scanner], {
      input: JSON.stringify({ sources, yes }), encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
    }));
    const engine = new WritingValidationEngine(repo, runtime());
    let positiveCount = 0, negativeCount = 0;
    for (const [file, spec] of Object.entries(corpus.files)) {
      positiveCount += spec.labels.filter(l => l.expected).length;
      if (!spec.labels.some(l => l.expected)) negativeCount++;
      // Campaign rules are deterministic and covered by the existing corpus adapter.
      if (spec.group) continue;
      const content = sources[file];
      const validation = await engine.validate(content);
      const diagnostics = await diagnoseWritingAssisted(content, {}, runtime());
      const assisted = {
        python: py[file].matches.map((f: any) => ({ pattern: f.pattern, tier: f.tier, line: f.line, scope: f.scope })),
        validation: validation.issues.filter(f => f.type !== 'missing_authenticity').map(f => ({ pattern: f.ruleId!, tier: severityTier[f.severity], line: f.location.line, scope: f.scope ?? 'file' as const })),
        diagnostics: diagnostics.diagnostics.map(f => ({ pattern: f.ruleId, tier: f.tier!, line: content.slice(0, f.start).split('\n').length, scope: f.scope ?? 'file' as const })),
      };
      for (const surface of ['python', 'validation', 'diagnostics'] as const) {
        scans[surface][file] = assisted[surface];
        expect(compareFindings(surface, file, assisted[surface]), `${surface}: ${file}`).toEqual([]);
      }
      const models = diagnostics.diagnostics.filter(f => f.confidence.kind === 'model-assisted');
      for (const f of models) expect(f.confidence).toMatchObject({ value: 0.94, calibrated: false });
      expect(validation.contextualDiagnostics?.diagnostics).toEqual(diagnostics.diagnostics);
      for (const f of py[file].matches.filter((f: any) => f.modelAssisted)) expect(f.confidence).toBe(0.94);
    }
    expect({ positiveCount, negativeCount }).toEqual({ positiveCount: 56, negativeCount: 22 });
    for (const surface of ['python', 'validation', 'diagnostics'] as const) {
      expect(Object.keys(corpus.files).flatMap(file => compareFindings(surface, file, scans[surface][file]))).toEqual([]);
    }
    expect(ask).toHaveBeenCalled();
    expect(ask.mock.calls.every(([input]) => JSON.stringify(input).includes('excerpt'))).toBe(true);
  });

  it('keeps disabled results byte-identical and does not invoke judgment', async () => {
    const off = { env: { ...env, AIWG_DECISION_ENABLED: '0' }, ask };
    const engine = new WritingValidationEngine(repo, off);
    ask.mockClear();
    const sources = Object.fromEntries(Object.keys(corpus.files).map(f => [f, textOf(f)]));
    const golden = JSON.parse(readFileSync(path.join(fixtureRoot, '../deterministic-output-sha256.json'), 'utf8'));
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const py = JSON.parse(execFileSync('python3', ['-I', '-c', `import json,runpy,sys
m=runpy.run_path(sys.argv[1])
print(json.dumps({f:m['scan_text'](t) for f,t in json.load(sys.stdin).items()}))`, scanner], {
      input: JSON.stringify(sources), encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...off.env },
    }));
    for (const file of Object.keys(corpus.files)) {
      const content = textOf(file);
      expect(JSON.stringify(await diagnoseWritingAssisted(content, {}, off))).toBe(JSON.stringify(diagnoseWriting(content)));
      const validation = await engine.validate(content);
      expect(JSON.stringify(validation)).toBe(JSON.stringify(await new WritingValidationEngine(repo).validate(content)));
      expect({ python: hash(py[file]), validation: hash(validation), diagnostics: hash(await diagnoseWritingAssisted(content, {}, off)) }, file).toEqual(golden[file]);
    }
    expect(ask).not.toHaveBeenCalled();
    expect(baseline.gaps).toHaveLength(21);
  });

  it.each([result(false), result(true, 0.79), result(true, null), result(true, NaN), result(true, Infinity), result(true, 1.1),
    { ...result(true), status: 'fallback' as const, fallback: 'llm' as const },
  ])('retains deterministic findings for rejected judgment %j', async answer => {
    const content = textOf('positives/mirrored.md');
    expect(await modelAssistedPatterns(content, { env, ask: async () => answer })).toEqual([]);
  });

  it('uses askDecision with the existing sampling config and a stubbed provider, without network calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    let evaluations = 0;
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      async capabilities() { return { answerKinds: ['truth-probability'], features: ['typed-output', 'structured-entries'],
        maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-truth-v1'], executable: true,
        egress: { mode: 'network', origin: 'https://api.typesafe.ai', region: 'us' } }; },
      async evaluate(request: DecisionAdapterRequest) {
        evaluations++;
        expect(request.definition.spec.question).toContain('manufacture a rhetorical contrast');
        return { status: 'success', reason: 'none', value: 0.94,
          uncertainty: { source: 'provider', profile: 'typesafe-truth-v1', calibration: 'vendor-claimed', confidence: null, distribution: null, calibrationRef: null },
          actualModel: 'offline-stub', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: null };
      },
    };
    const findings = await modelAssistedPatterns(yes[0], { adapter, cwd: home, env: { ...env, JEV_API_KEY: 'synthetic-fixture-only' } });
    expect(findings).toHaveLength(1);
    expect(findings[0].modelAssisted).toBe(true);
    expect(findings[0].confidence).toBeCloseTo(0.94);
    expect(evaluations).toBe(5);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares candidate and question semantics with Python and carries section context', async () => {
    const contents = Object.keys(corpus.files).map(textOf).concat([
      '🧵 The worker can read. The worker can write.\n\nReady. Waiting. Done.',
      'A technical field is named here: request identifier.\n\nThe tool will wait. The tool will not wait.',
    ]);
    const code = `import json,runpy,sys
m=runpy.run_path(sys.argv[1])
print(json.dumps([m['STRUCTURAL']['structural_candidates'](m['mask_prose'](s)) for s in json.load(sys.stdin)]))`;
    const py = JSON.parse(execFileSync('python3', ['-I', '-c', code, scanner], {
      input: JSON.stringify(contents), encoding: 'utf8', timeout: 30_000,
    }));
    for (const [index, content] of contents.entries()) {
      const candidates = structuralCandidates(maskProse(content)).map(c => ({ ...c,
        start: Array.from(content.slice(0, c.start)).length, end: Array.from(content.slice(0, c.end)).length }));
      expect(candidates).toEqual(py[index]);
    }
    expect(readFileSync(path.join(repo, 'src/writing/structural-judgment.catalogue.json'), 'utf8')).toBe(readFileSync(path.join(path.dirname(scanner), '../references/structural-judgment.json'), 'utf8'));
    const contextual = vi.fn(async (input: { context?: string }) => result(!JSON.parse(input.context!).section.includes('Runbook')));
    expect(await modelAssistedPatterns('# Runbook\n\nReady. Waiting. Done.', { env, ask: contextual })).toEqual([]);
    expect(contextual).toHaveBeenCalledOnce();
    expect(await modelAssistedPatterns('The tool will wait. The tool will not wait.', runtime())).toEqual([]);
    expect((await diagnoseWritingAssisted(yes[0], { language: 'fr' }, runtime())).diagnostics).toEqual([]);
    await expect(diagnoseWritingAssisted(yes[0], { contexts: [{ start: -1, end: 5, context: 'literal' }] }, runtime())).rejects.toThrow('Invalid context span');
  });

  it('Python rejects low, unavailable and malformed judgments and bounds the existing CLI bridge', () => {
    const code = `import json,os,runpy,sys,subprocess
from types import SimpleNamespace
from unittest.mock import patch
m=runpy.run_path(sys.argv[1])
os.environ['AIWG_DECISION_ENABLED']='1'
j=m['JUDGMENT']
text='The tool does not remember. The tool does repeat.'
for answer in [dict(status='answered',answer=False,confidence=0.99),dict(status='answered',answer=True,confidence=0.79),dict(status='fallback',answer=True,confidence=0.99),dict(status='answered',answer=True,confidence=None),dict(status='answered',answer=True,confidence=True),dict(status='answered',answer=True,confidence=float('nan')),None]:
    assert m['scan_text'](text,judgment=lambda payload:answer)['matches']==[]
def unavailable(payload): raise OSError('fixture unavailable')
assert m['scan_text'](text,judgment=unavailable)['matches']==[]
os.environ['AIWG_DECISION_ENABLED']='1'
with patch('subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(dict(status='answered',answer=True,confidence=0.94)))) as call:
    report=m['scan_text'](text)
    assert report['matches'][0]['modelAssisted'] and report['matches'][0]['confidence']==0.94
    args,kwargs=call.call_args
    assert args[0][:3]==['aiwg','decision','ask'] and '--context-stdin' in args[0]
    assert kwargs['timeout']==20 and json.loads(kwargs['input'])['excerpt']==text
for error in [OSError('missing'),subprocess.TimeoutExpired('fixture',20),ValueError('bad json')]:
    with patch('subprocess.run',side_effect=error): assert m['scan_text'](text)['matches']==[]
os.environ['AIWG_DECISION_ENABLED']='0'
with patch('subprocess.run',side_effect=AssertionError('must not invoke CLI')):
    assert j['ask'](dict()) is None and m['scan_text'](text)['matches']==[]
    assert m['scan_text'](text,judgment=lambda _:dict(status='answered',answer=True,confidence=0.99))['matches']==[]
print('Python judgment fallback and CLI bridge: PASS')`;
    expect(execFileSync('python3', ['-I', '-c', code, scanner], { encoding: 'utf8', timeout: 30_000 })).toContain('PASS');
  });

  it('labels assisted CLI campaign text and preserves local judgments in validation batches', async () => {
    const prose = path.join(home, 'prose.md'), phrase = path.join(home, 'phrase.md');
    writeFileSync(prose, yes[0] + '\n\n' + yes[6]);
    writeFileSync(phrase, 'Delve into the result.');
    const engine = new WritingValidationEngine(repo, runtime());
    const batch = await engine.validateBatch([prose, phrase], undefined, { cross: true });
    expect(batch.get(prose)?.issues.filter(f => f.modelAssisted)).toHaveLength(2);
    expect(batch.get(prose)?.contextualDiagnostics?.diagnostics.filter(f => f.confidence.kind === 'model-assisted')).toHaveLength(2);
    vi.stubEnv('AIWG_DECISION_ENABLED', '1');
    vi.spyOn(decision, 'askDecision').mockImplementation(ask);
    try {
      const text = await campaignReport(home, ['--cross', prose, phrase]);
      expect(text).toContain('mirrored-sentences (model-assisted; confidence 0.94)');
      expect(text).toContain('[check] phrase:delve');
      const json = JSON.parse(await campaignReport(home, ['--cross', '--json', prose]));
      expect(json[prose].diagnostics[0].confidence).toEqual({ kind: 'model-assisted', value: 0.94, calibrated: false });
    } finally { vi.unstubAllEnvs(); }
  });

  it('tolerates unavailable judgment and respects diagnostics contexts, overrides and exceptions', async () => {
    const content = yes[0];
    expect(await modelAssistedPatterns(content, { env, ask: async () => { throw new Error('offline'); } })).toEqual([]);
    ask.mockClear();
    expect((await diagnoseWritingAssisted(content, { contexts: [{ start: 0, end: content.length, context: 'literal' }] }, runtime())).diagnostics).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    const options = { overrides: [{ id: 'mirrored-sentences', phrase: 'Unused phrase', explanation: 'Intentional', suggestion: 'Retain', authority: 'advisory' as const, enabled: false }] };
    expect((await diagnoseWritingAssisted(content, options, runtime())).diagnostics).toEqual([]);
    const found = (await diagnoseWritingAssisted(content, {}, runtime())).diagnostics[0];
    const reviewed = await diagnoseWritingAssisted(content, { exceptions: [{ ruleId: found.ruleId, start: found.start, end: found.end, contentHash: diagnoseWriting(content).contentHash, reason: 'Deliberate contrast.' }] }, runtime());
    expect(reviewed.diagnostics[0].resolution).toBe('retained');
    const batch = await diagnoseWritingBatchAssisted([{ id: 'prose', content }], { cross: true }, runtime());
    expect(batch.get('prose')?.diagnostics).toEqual((await diagnoseWritingAssisted(content, {}, runtime())).diagnostics);
  });
});
