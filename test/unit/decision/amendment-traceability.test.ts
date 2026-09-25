import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintPatternMarkdown } from '../../../tools/decision/pattern-operational-gate.mjs';
import { DECISION_GATE_SUITES } from '../../../src/decision/qualification/gate-evidence.js';

// M11 (#2604): every security/operations amendment and scored risk links to executable evidence.
const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURE = 'test/fixtures/decision/amendment-traceability-v1.json';
const DOC = 'docs/decision/qualification-traceability.md';
interface Evidence { testId: string; file: string }
interface Amendment { id: string; title: string; gate: string; issues: string[]; status: string;
  evidence: Evidence[]; liveTracking?: string[] }
interface Risk { id: string; description: string; issues: string[]; amendments: string[]; evidence: Evidence[] }
const trace = JSON.parse(readFileSync(path.join(ROOT, FIXTURE), 'utf8')) as {
  schemaVersion: string; amendments: Amendment[]; risks: Risk[];
};
const AMENDMENTS = Array.from({ length: 11 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`);
const RISKS = Array.from({ length: 8 }, (_, i) => `R-${23 + i}`);
const TITLE = /\b(?:it|describe|test)(?:\.(?:only|skip|concurrent|fails|todo))*(?:\.each\((?:[^()]|\([^()]*\))*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const titles = new Map<string, string[]>();
const titlesOf = (file: string): string[] => {
  if (!titles.has(file)) titles.set(file, [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(TITLE)].map(match => match[2]!));
  return titles.get(file)!;
};
const allEvidence = (): Array<Evidence & { owner: string }> => [...trace.amendments, ...trace.risks]
  .flatMap(item => item.evidence.map(evidence => ({ ...evidence, owner: item.id })));

describe('M11 amendment and risk traceability', () => {
  it('M11-TRACE-01 lists M01-M11 and R-23..R-30 exactly once under the v1 schema', () => {
    expect(trace.schemaVersion).toBe('decision-amendment-traceability/v1');
    expect(trace.amendments.map(item => item.id)).toEqual(AMENDMENTS);
    expect(trace.risks.map(item => item.id)).toEqual(RISKS);
    for (const item of [...trace.amendments, ...trace.risks])
      expect(item.issues.length, item.id).toBeGreaterThan(0);
    for (const issue of [...trace.amendments, ...trace.risks].flatMap(item => item.issues)) expect(issue).toMatch(/^#\d+$/);
  });

  it('M11-TRACE-02 every evidence file exists and contains its testId inside a test title', () => {
    for (const { testId, file, owner } of allEvidence()) {
      expect(existsSync(path.join(ROOT, file)), `${owner} ${file}`).toBe(true);
      expect(file, owner).toMatch(/^test\/.+\.test\.ts$/);
      expect(testId.trim().length, owner).toBeGreaterThan(0);
      expect(titlesOf(file).some(title => title.includes(testId)), `${owner}: '${testId}' in ${file}`).toBe(true);
    }
  });

  it('M11-TRACE-03 each amendment has a G2/G4 gate, evidence, and only M08 may be live-pending under #2684', () => {
    for (const amendment of trace.amendments) {
      expect(['G2', 'G4'], amendment.id).toContain(amendment.gate);
      expect(amendment.title.length, amendment.id).toBeGreaterThan(0);
      expect(amendment.evidence.length, amendment.id).toBeGreaterThan(0);
      expect(new Set(amendment.evidence.map(e => `${e.file}#${e.testId}`)).size, amendment.id).toBe(amendment.evidence.length);
      expect(['offline-covered', 'offline-guard-live-pending'], amendment.id).toContain(amendment.status);
    }
    const pending = trace.amendments.filter(item => item.status === 'offline-guard-live-pending');
    expect(pending.map(item => item.id)).toEqual(['M08']);
    expect(pending[0]!.liveTracking).toContain('#2684');
    for (const amendment of trace.amendments.filter(item => item.id !== 'M08')) expect(amendment.liveTracking).toBeUndefined();
  });

  it('M11-TRACE-04 each risk maps to known amendments and executable evidence', () => {
    const known = new Set(AMENDMENTS);
    for (const risk of trace.risks) {
      expect(risk.description.length, risk.id).toBeGreaterThan(0);
      expect(risk.amendments.length + risk.evidence.length, risk.id).toBeGreaterThan(0);
      for (const id of risk.amendments) expect(known.has(id), `${risk.id} -> ${id}`).toBe(true);
    }
    const covered = new Set(trace.risks.flatMap(risk => risk.amendments));
    for (const id of AMENDMENTS.filter(id => id !== 'M11')) expect(covered.has(id), id).toBe(true);
  });

  it('M11-TRACE-05 the traceability document mirrors the fixture and passes Markdown lint', () => {
    const source = readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(lintPatternMarkdown(DOC, source)).toEqual([]);
    const row = (id: string) => source.split('\n').find(line => line.startsWith(`| ${id} |`));
    for (const amendment of trace.amendments) {
      const line = row(amendment.id);
      expect(line, amendment.id).toBeDefined();
      expect(line).toContain(` ${amendment.gate} `);
      expect(line).toContain(amendment.status);
      for (const issue of amendment.issues) expect(line).toContain(issue);
    }
    for (const risk of trace.risks) {
      const line = row(risk.id);
      expect(line, risk.id).toBeDefined();
      for (const id of risk.amendments) expect(line).toContain(id);
      for (const issue of risk.issues) expect(line).toContain(issue);
    }
    expect(source).toContain('#2684');
  });

  it('M11-TRACE-06 links every amendment into the G2/G4 suite that the release gates derive from', () => {
    const linked = new Map<string, string>();
    for (const suite of Object.values(DECISION_GATE_SUITES)) {
      for (const id of suite.amendments ?? []) {
        expect(linked.has(id), `${id} linked to two suites`).toBe(false);
        linked.set(id, suite.gate);
      }
    }
    expect([...linked.keys()].sort()).toEqual(AMENDMENTS);
    for (const amendment of trace.amendments) expect(linked.get(amendment.id), amendment.id).toBe(amendment.gate);
  });
});
