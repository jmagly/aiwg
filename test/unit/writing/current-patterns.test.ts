// Exercise the public scanners' context, location and compatibility boundaries.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseWriting, writingContentHash } from '../../../src/writing/contextual-diagnostics.js';
import { WritingValidationEngine } from '../../../src/writing/validation-engine.js';

const scanner = path.resolve('agentic/code/addons/writing-quality/skills/ai-pattern-detection/scripts/pattern_scanner.py');
interface PythonResult {
  authenticity_score: number; word_count: number;
  matches: Array<{ pattern: string; text: string; severity: string; tier: string; position: number; line: number; column: number; suggestion: string }>;
  structural_issues: Record<string, number>;
}
function python(content: string): PythonResult {
  const root = mkdtempSync(path.join(tmpdir(), 'writing-current-'));
  try {
    const file = path.join(root, 'draft.md');
    writeFileSync(file, content);
    return JSON.parse(execFileSync('python3', ['-I', scanner, file], { encoding: 'utf8', timeout: 30_000 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('current writing patterns on the public surfaces', () => {
  it('keeps source positions after Unicode and protected regions', async () => {
    const content = '# 🧵 What do you think?\r\n\r\n🧵 The tests pass, which is the part I’d keep too.\r\n';
    const diagnostic = diagnoseWriting(content).diagnostics;
    expect(diagnostic).toHaveLength(1);
    expect(diagnostic[0]).toMatchObject({ ruleId: 'labelled-significance', tier: 'cut' });
    expect(content.slice(diagnostic[0].start, diagnostic[0].end)).toBe('which is the part I’d keep too');
    const issue = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.find(i => i.ruleId === 'labelled-significance')!;
    expect(issue.location).toMatchObject({ line: 3, start: diagnostic[0].start, end: diagnostic[0].end });
    const match = python(content).matches[0];
    expect(match).toMatchObject({ pattern: 'labelled-significance', line: 3, tier: 'cut', text: diagnostic[0].text });
    expect(Array.from(content).slice(match.position, match.position + Array.from(match.text).length).join('')).toBe(match.text);
    // Two astral characters precede the match; only one is on its source line.
    expect(diagnostic[0].start - match.position).toBe(2);
    expect(issue.location.column - match.column).toBe(1);
    expect(match.suggestion.length).toBeGreaterThan(0);
  });

  it('agrees on ASCII source positions across all three surfaces', async () => {
    const content = '# A heading\r\n\r\nThe tests pass, which is the part I would keep too.\r\n';
    const [diagnostic] = diagnoseWriting(content).diagnostics;
    const [match] = python(content).matches;
    const issue = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.find(i => i.ruleId === diagnostic.ruleId)!;
    expect(issue.location).toEqual({ start: match.position, end: match.position + match.text.length, line: match.line, column: match.column });
    expect({ start: diagnostic.start, end: diagnostic.end }).toEqual({ start: issue.location.start, end: issue.location.end });
    expect(diagnostic.text).toBe(match.text);
  });

  it('keeps remaining #4138 and #4140 misses explicitly justified', () => {
    const baseline = JSON.parse(readFileSync('test/fixtures/writing/quality-corpus/known-gaps.json', 'utf8'));
    for (const gap of baseline.gaps) {
      expect(gap.kind).toBe('miss');
      expect(['#4138', '#4140']).toContain(gap.issue);
      expect(gap.reason.length).toBeGreaterThan(20);
    }
  });

  it.each([
    '---\ntitle: What do you think?\n---',
    '# Let’s dive in.\n\nA factual paragraph.',
    'Let’s dive in.\n================',
    '![What do you think?](mark.png)',
    '![What do you think?][hero]\n\n[hero]: mark.png',
    '```text\nWhat do you think?\n````',
    '~~~~text\nWhat do you think?',
    '    What do you think?\n    Let’s dive in.',
    '`What do you think?` and ``Let’s dive in.``',
    '> What do you think?\n> Let’s dive in.',
    'They wrote “What do you think?” and "Let’s dive in."',
    '“What do you\nthink?”',
    '<!-- What do you think?\nLet’s dive in. -->',
    '| What do you think? | Let’s dive in. |',
    '- What do you think?\n- Let’s dive in.',
    'The package contains scripts, templates and rules.\n\nThe package contains scripts, templates, and rules.',
    'Use port 443 rather than port 80 because the server accepts TLS only.',
    'The file is not a supported alias. The cache was not shared.',
    'This correction uses a copy rather than a rename because the filesystems differ.',
  ])('protects a negative on all surfaces: %s', async content => {
    expect(python(content).matches).toEqual([]);
    expect(diagnoseWriting(content).diagnostics).toEqual([]);
    const result = await new WritingValidationEngine(process.cwd()).validate(content);
    expect(result.issues.filter(i => i.type !== 'missing_authenticity')).toEqual([]);
  });

  it('protects content without hiding later prose', async () => {
    const content = '~~~text\nWhat do you think?\n~~~~\n\n<!-- Let’s dive in. --> Thoughts?';
    expect(python(content).matches.map(m => [m.pattern, m.line])).toEqual([['engagement-bait', 5]]);
    expect(diagnoseWriting(content).diagnostics.map(d => d.ruleId)).toEqual(['engagement-bait']);
    expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(i => i.ruleId).map(i => i.ruleId)).toEqual(['engagement-bait']);
  });

  it.each(['The system is fast, reliable, and secure.', 'The system is fast, reliable and secure.'])('recognizes a rhetorical predicate with either comma style: %s', async content => {
    const matches = python(content).matches;
    expect(matches).toHaveLength(1);
    const [match] = matches;
    expect(match).toMatchObject({ pattern: 'three_item_list', tier: 'watch' });
    const diagnostics = diagnoseWriting(content).diagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ ruleId: 'struct_three_items', tier: 'watch', start: match.position, text: match.text });
    const issues = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(i => i.type !== 'missing_authenticity');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: 'struct_three_items', severity: 'info', location: { start: diagnostics[0].start, end: diagnostics[0].end } });
  });

  it.each([
    ['It is not just the score in 2026.', 'negate-then-assert'],
    ['In 2026, this is not a ritual but a promise.', 'contrast-not-but'],
    ['In 2026 we need action, not ceremony.', 'contrast-x-not-y'],
    ['In 2026 choose action rather than ceremony.', 'rather-than'],
    ['A quiet release note, loud relief in 2026.', 'antithesis-pair'],
    ['It is not just the score; because the year changed we reviewed it.', 'negate-then-assert'],
    ['Because the server restarted yesterday after the scheduled maintenance we choose action rather than ceremony.', 'rather-than'],
    ['It is not 8 workers but a promise.', 'contrast-not-but'],
  ])('retains a finding despite unrelated grounding: %s', async (content, pattern) => {
    expect(python(content).matches.map(m => m.pattern)).toContain(pattern);
    expect(diagnoseWriting(content).diagnostics.map(d => d.ruleId)).toContain(pattern);
    expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.map(i => i.ruleId)).toContain(pattern);
  });

  it.each([
    'Use port 443 rather than port 80.',
    'It uses not 8 workers but 4 workers.',
    'Use port 443, not port 80.',
    'A fast 8 ms response, slow 40 ms fallback.',
    'A fast response, slow fallback because the cache is cold.',
    'It is not just the score because the account also matters.',
    'Previously we chose a copy rather than a rename.',
    'This is not a rename but a copy because the filesystems differ.',
  ])('suppresses grounded comparisons on all surfaces: %s', async content => {
    expect(python(content).matches).toEqual([]);
    expect(diagnoseWriting(content).diagnostics).toEqual([]);
    expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(i => i.type !== 'missing_authenticity')).toEqual([]);
  });

  it.each([
    'Use port 443 rather than port 80; choose action rather than ceremony.',
    'Use a copy rather than a rename because filesystems differ; choose action rather than ceremony.',
  ])('grounds each comparison independently within one sentence: %s', async content => {
    const start = content.lastIndexOf('rather than');
    expect(python(content).matches).toMatchObject([{ pattern: 'rather-than', position: start }]);
    expect(python(content).matches).toHaveLength(1);
    expect(diagnoseWriting(content).diagnostics).toMatchObject([{ ruleId: 'rather-than', start }]);
    expect(diagnoseWriting(content).diagnostics).toHaveLength(1);
    const issues = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(i => i.type !== 'missing_authenticity');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: 'rather-than', location: { start } });
  });

  it('requires lexical clusters and retains spectral tiers', () => {
    expect(python('We leverage the cache.').matches).toEqual([]);
    for (const content of ['We leverage a multifaceted approach.', 'Quiet echoes hum.']) {
      const tier = content.startsWith('Quiet') ? 'watch' : 'check';
      expect(python(content).matches).toMatchObject([{ pattern: 'lexical-cluster', tier }]);
      expect(diagnoseWriting(content).diagnostics).toMatchObject([{ ruleId: 'lexical-cluster', tier }]);
    }
    const content = 'Teams leverage the cache.\n\nEnhance the pipeline.\n\nA meticulous review.\n\nA multifaceted approach.';
    expect(python(content).matches.filter(m => m.pattern === 'lexical-cluster')).toHaveLength(4);
    expect(diagnoseWriting(content).diagnostics.filter(d => d.ruleId === 'lexical-cluster')).toHaveLength(4);
  });

  it('applies existing exceptions, explicit contexts, language and overrides to new findings', () => {
    const content = 'What do you think?';
    const d = diagnoseWriting(content).diagnostics[0];
    expect(diagnoseWriting(content, { exceptions: [{ ...d, contentHash: writingContentHash(content), reason: 'Deliberate audience question' }] }).diagnostics[0].resolution).toBe('retained');
    expect(diagnoseWriting(content, { contexts: [{ start: 0, end: content.length, context: 'questionnaire' }] }).diagnostics).toEqual([]);
    expect(diagnoseWriting(content, { language: 'fr' }).diagnostics).toEqual([]);
    expect(diagnoseWriting(content, { overrides: [{ id: d.ruleId, phrase: content, authority: 'user', explanation: 'Intentional', suggestion: 'Retain', enabled: false }] }).diagnostics).toEqual([]);
    expect(diagnoseWriting(content, { overrides: [{ id: d.ruleId, phrase: content, authority: 'user', explanation: 'Author requirement', suggestion: 'Review' }] }).diagnostics).toHaveLength(1);
  });

  it('does not deduct for precise passives, standalone punctuation or document length', async () => {
    const passive = readFileSync('test/fixtures/writing/quality-corpus/negatives/passives.md', 'utf8');
    const engine = new WritingValidationEngine(process.cwd());
    const short = python(passive);
    const long = python(Array(20).fill(passive).join('\n\n'));
    expect(short.matches).toEqual([]);
    expect(long.matches).toEqual([]);
    expect(long.structural_issues).toEqual({});
    expect(short.authenticity_score).toBe(long.authenticity_score);
    expect((await engine.validate(passive)).score).toBe((await engine.validate(Array(20).fill(passive).join('\n\n'))).score);
    const text = 'Moreover, we chose the cache after the bug was fixed. '.repeat(30);
    const longer = Array(4).fill(text).join('\n\n');
    expect(python(text).authenticity_score).toBeCloseTo(python(longer).authenticity_score);
    expect((await engine.validate(text)).score).toBeCloseTo((await engine.validate(longer)).score);
    expect(python('The check — after approval — runs at 10:30; the result is stored.').matches).toEqual([]);
    const padded = '# A heading with many extra words\n\n```text\n' + 'a word '.repeat(100) + '\n```\n\n' + text;
    expect((await engine.validate(padded)).score).toBeCloseTo((await engine.validate(text)).score);
    expect(python(padded).authenticity_score).toBeCloseTo(python(text).authenticity_score);
  });
});
