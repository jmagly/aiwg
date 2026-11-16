// Keep the writing-quality corpus and its shrinking scanner-gap baseline executable.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseline, baselineDifference, compareFindings, corpus, findingKey, fixtureRoot,
  scanCorpus, surfaces, textOf, type Gap } from './helpers/quality-corpus.js';

let scans: Awaited<ReturnType<typeof scanCorpus>>;
beforeAll(async () => { scans = await scanCorpus(); });

const requiredPatterns = ['contrast-not-but', 'contrast-x-not-y', 'rather-than', 'mirrored-sentences',
  'aphorism-ending', 'colon-reveal', 'fragment-run', 'labelled-significance', 'throat-clearing',
  'engagement-bait', 'lexical-cluster', 'negate-then-assert', 'antithesis-pair', 'repeated-sentence', 'repeated-phrase', 'shared-skeleton'];

describe('annotated writing-quality corpus (#4142)', () => {
  it('covers every structural pattern with three positive and three negative locations', () => {
    expect(corpus.version).toBe(1);
    const labels = Object.values(corpus.files).flatMap(f => f.labels);
    for (const pattern of requiredPatterns) for (const expected of [true, false]) {
      expect(labels.filter(l => l.pattern === pattern && l.expected === expected).length,
        `${pattern}: expected=${expected}`).toBeGreaterThanOrEqual(3);
    }
    const disk = readdirSync(fixtureRoot, { recursive: true }).filter(f => String(f).endsWith('.md') && f !== 'README.md').map(String).sort();
    expect(disk).toEqual(Object.keys(corpus.files).sort());
    for (const [file, spec] of Object.entries(corpus.files)) {
      expect(spec.notes.length).toBeGreaterThan(0);
      expect(spec.source.length).toBeGreaterThan(0);
      if (spec.group) expect(corpus.groups[spec.group]).toBeDefined();
      expect(new Set(spec.labels.map(l => findingKey(l) + l.quote)).size, file).toBe(spec.labels.length);
      for (const label of spec.labels) {
        expect(requiredPatterns).toContain(label.pattern);
        expect(label.scope).toBe(spec.group ? 'cross' : 'file');
        expect(label.line).toBeGreaterThan(0);
        expect(textOf(file).split('\n')[label.line - 1], `${file}:${label.line}`).toContain(label.quote);
        if (label.expected) expect(['cut', 'check', 'watch']).toContain(label.tier);
        else expect(label.tier).toBeNull();
      }
    }
  });

  it('keeps baseline entries specific and assigned to the closing issue', () => {
    expect(baseline.version).toBe(1);
    for (const gap of baseline.gaps) {
      expect(surfaces).toContain(gap.surface);
      expect(corpus.files[gap.fixture]).toBeDefined();
      expect(['#4138', '#4139', '#4140']).toContain(gap.issue);
      expect(['miss', 'flag']).toContain(gap.kind);
    }
  });

  for (const surface of surfaces) {
    for (const file of Object.keys(corpus.files)) it(`${surface}: ${file}`, () => {
      const observed = compareFindings(surface, file, scans[surface][file]);
      const allowed = baseline.gaps.filter(g => g.surface === surface && g.fixture === file);
      expect(baselineDifference(observed, allowed), 'New regression or fixed gap still listed; inspect annotations and shrink baseline.').toEqual({ added: [], stale: [] });
    });
  }

  it('reports TP recall and TN false-positive counts per surface and pattern', () => {
    const metrics = [];
    for (const surface of surfaces) {
      const gaps = Object.keys(corpus.files).flatMap(file => compareFindings(surface, file, scans[surface][file]));
      const patterns = new Set([...requiredPatterns, ...gaps.filter(g => g.kind === 'flag').map(g => g.pattern)]);
      for (const pattern of patterns) {
        const positives = Object.values(corpus.files).flatMap(f => f.labels).filter(l => l.expected && l.pattern === pattern).length;
        const missed = gaps.filter(g => g.kind === 'miss' && g.pattern === pattern).length;
        const tnFlags = gaps.filter(g => g.kind === 'flag' && g.pattern === pattern && !corpus.files[g.fixture].labels.some(l => l.expected)).length;
        metrics.push({ surface, pattern, tp: positives - missed, positives, recall: positives ? (positives - missed) / positives : null, tnFlags });
      }
    }
    console.log(`WRITING_QUALITY_CORPUS_METRICS ${JSON.stringify(metrics)}`);
  });

  it('rejects a removed allowance and a stale fixed gap', () => {
    const gap: Gap = { surface: 'validation', fixture: 'positives/contrast.md', kind: 'miss',
      pattern: 'contrast-not-but', tier: 'cut', line: 1, scope: 'file', issue: '#4138' };
    expect(baselineDifference([gap], [])).toEqual({ added: [gap], stale: [] });
    expect(baselineDifference([], [gap])).toEqual({ added: [], stale: [gap] });
    const negative = 'negatives/contrast.md';
    const newFlag = { pattern: 'contrast-not-but', tier: 'cut' as const, line: 1, scope: 'file' as const };
    const flagged = compareFindings('validation', negative, [newFlag]);
    expect(baselineDifference(flagged, []).added).toHaveLength(1);
    expect(flagged[0].kind).toBe('flag');
  });
});
