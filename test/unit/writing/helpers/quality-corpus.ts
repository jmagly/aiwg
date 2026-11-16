// Adapt existing writing scanners and compare their findings with editorial annotations.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WritingValidationEngine } from '../../../../src/writing/validation-engine.js';
import { diagnoseWritingBatch } from '../../../../src/writing/contextual-diagnostics.js';

export type Tier = 'cut' | 'check' | 'watch';
export interface Finding { pattern: string; tier: Tier; line: number; scope: 'file' | 'cross' }
export interface Label extends Omit<Finding, 'tier'> { tier: Tier | null; quote: string; expected: boolean }
export interface Fixture { source: string; notes: string; labels: Label[]; group?: string }
export interface Corpus { version: number; groups: Record<string, { notes: string }>; files: Record<string, Fixture> }
export type Surface = 'python' | 'validation' | 'diagnostics';
export interface Gap extends Finding { fixture: string; surface: Surface; kind: 'miss' | 'flag'; issue: '#4138' | '#4139' | '#4140'; plannedBy?: '#4140' }
export const repo = fileURLToPath(new URL('../../../../', import.meta.url));
export const fixtureRoot = path.join(repo, 'test/fixtures/writing/quality-corpus');
export const corpus = JSON.parse(readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf8')) as Corpus;
export const baseline = JSON.parse(readFileSync(path.join(fixtureRoot, 'known-gaps.json'), 'utf8')) as { version: number; gaps: Gap[] };
export const surfaces: Surface[] = ['python', 'validation', 'diagnostics'];
export const severityTier = { critical: 'cut', warning: 'check', info: 'watch' } as const;
export const textOf = (fixture: string) => readFileSync(path.join(fixtureRoot, fixture), 'utf8');
export const findingKey = (f: Omit<Finding, 'tier'> & { tier: Tier | null }) => JSON.stringify([f.pattern, f.tier, f.line, f.scope]);
export const gapKey = (g: Gap) => JSON.stringify([g.surface, g.fixture, g.kind, findingKey(g)]);

// The legacy Python JSON omits pattern IDs. Observe its own PatternMatch constructor
// to retain those IDs without reproducing regex matching or changing scanner behavior.
const pythonAdapter = `
import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='corpus_adapter')
scan = module['scan_text']
globals_ = scan.__globals__
original = globals_['PatternMatch']
records = []
def record(*args, **kwargs):
    match = original(*args, **kwargs)
    records.append(match._asdict())
    return match
globals_['PatternMatch'] = record
out = {}
for name, text in json.load(sys.stdin).items():
    records.clear()
    result = scan(text)
    assert len(records) == len(result['matches'])
    out[name] = list(records)
print(json.dumps(out))
`;

function lineAt(text: string, offset: number) { return text.slice(0, offset).split('\n').length; }
export async function scanCorpus(): Promise<Record<Surface, Record<string, Finding[]>>> {
  const sources = Object.fromEntries(Object.keys(corpus.files).map(f => [f, textOf(f)]));
  const output: Record<Surface, Record<string, Finding[]>> = { python: {}, validation: {}, diagnostics: {} };
  const python = JSON.parse(execFileSync('python3', ['-I', '-c', pythonAdapter,
    path.join(repo, 'agentic/code/addons/writing-quality/skills/ai-pattern-detection/scripts/pattern_scanner.py')],
  { input: JSON.stringify(sources), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })) as Record<string,
    Array<{ pattern: string; severity: keyof typeof severityTier; position: number }>>;
  const engine = new WritingValidationEngine(repo);
  for (const [file, text] of Object.entries(sources)) {
    output.python[file] = python[file].map(f => ({ pattern: f.pattern, tier: severityTier[f.severity],
      // Python offsets count Unicode code points, unlike JavaScript offsets.
      line: Array.from(text).slice(0, f.position).filter(c => c === '\n').length + 1, scope: 'file' }));
    const result = await engine.validate(text);
    output.validation[file] = result.issues.filter(f => f.type !== 'missing_authenticity').map(f => ({ pattern: f.ruleId ?? `unidentified:${f.type}`, tier: severityTier[f.severity], line: f.location.line, scope: 'file' }));
  }
  // Each campaign is isolated; unrelated campaigns must never be compared together.
  const sets = new Map<string, string[]>();
  for (const [file, spec] of Object.entries(corpus.files)) {
    const group = spec.group ?? file;
    sets.set(group, [...(sets.get(group) ?? []), file]);
  }
  for (const files of sets.values()) {
    const results = diagnoseWritingBatch(files.map(id => ({ id, content: sources[id] })));
    for (const file of files) output.diagnostics[file] = results.get(file)!.diagnostics.map(f => ({
      pattern: f.ruleId, tier: f.tier ?? 'check', line: lineAt(sources[file], f.start),
      scope: f.explanation.includes('also occurs in document') ? 'cross' : 'file',
    }));
  }
  return output;
}

export function compareFindings(surface: Surface, fixture: string, actual: Finding[]): Gap[] {
  const remaining = [...actual];
  const misses: Gap[] = [];
  for (const label of corpus.files[fixture].labels.filter(l => l.expected)) {
    const index = remaining.findIndex(f => findingKey(f) === findingKey(label));
    if (index >= 0) remaining.splice(index, 1);
    else misses.push({ surface, fixture, kind: 'miss', pattern: label.pattern, tier: label.tier!, line: label.line, scope: label.scope,
      issue: label.scope === 'cross' ? '#4140' : '#4138' });
  }
  return [...misses, ...remaining.map(f => ({ ...f, surface, fixture, kind: 'flag' as const, issue: '#4139' as const }))];
}

export function baselineDifference(observed: Gap[], allowed: Gap[]) {
  const remaining = [...allowed];
  const added: Gap[] = [];
  for (const gap of observed) {
    const index = remaining.findIndex(a => gapKey(a) === gapKey(gap));
    if (index < 0) added.push(gap);
    else remaining.splice(index, 1);
  }
  return { added, stale: remaining };
}
