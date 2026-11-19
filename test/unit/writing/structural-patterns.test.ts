// Verify structural boundaries and campaign findings through the shipped public surfaces.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseWriting, diagnoseWritingBatch, writingContentHash } from '../../../src/writing/contextual-diagnostics.js';
import { performance } from 'node:perf_hooks';
import { scanCampaignPatterns } from '../../../src/writing/campaign-patterns.js';
import { WritingValidationEngine } from '../../../src/writing/validation-engine.js';

const script = path.resolve('agentic/code/addons/writing-quality/skills/ai-pattern-detection/scripts/pattern_scanner.py');
interface Match { pattern: string; tier: string; position: number; line: number; scope: string; text: string; suggestion: string }
function python(text: string): Match[] {
  return JSON.parse(execFileSync('python3', ['-I', script, '--text', text], { encoding: 'utf8', timeout: 30_000 })).matches;
}

describe('structural sequence checks', () => {
  it.each([
    ['The rule for tracker work is simple: send once.', 'colon-reveal', 'watch'],
    ['The advice for publishing is clear: check first.', 'colon-reveal', 'watch'],
    ['This is slower. Less noise. Fewer retries.', 'fragment-run', 'check'],
    ['This is faster. Fewer errors. Less waiting.', 'fragment-run', 'check'],
  ])('detects bounded corpus gaps on every surface: %s', async (content, pattern, tier) => {
    const start = pattern === 'colon-reveal' ? content.indexOf(':') : 0;
    const end = pattern === 'colon-reveal' ? start + 1 : content.length;
    expect(python(content).filter(f => f.pattern === pattern)).toEqual([
      expect.objectContaining({ position: start, text: content.slice(start, end), tier }),
    ]);
    expect(diagnoseWriting(content).diagnostics.filter(f => f.ruleId === pattern)).toEqual([
      expect.objectContaining({ start, end, tier }),
    ]);
    expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(f => f.ruleId === pattern)).toEqual([
      expect.objectContaining({ location: expect.objectContaining({ start, end }), tier }),
    ]);
  });

  it.each([
    'The rule for tracker work is simple: send once.',
    'This is slower. Less noise. Fewer retries.',
  ])('preserves protected Markdown around gap candidates: %s', async content => {
    for (const protectedText of [`\`${content}\``, `"${content}"`, `> ${content}`, `- ${content}`,
      `# ${content}`, `---\ntitle: ${content}\n---`, `![${content}](image.png)`, `\`\`\`text\n${content}\n\`\`\``]) {
      expect(python(protectedText)).toEqual([]);
      expect(diagnoseWriting(protectedText).diagnostics).toEqual([]);
      expect((await new WritingValidationEngine(process.cwd()).validate(protectedText)).issues.filter(f => f.type !== 'missing_authenticity')).toEqual([]);
    }
  });

  it('recognizes a withheld complement without requiring a pattern cluster on every surface', async () => {
    const content = 'The release now makes a promise: the queue drains.';
    const matches = python(content);
    const diagnostics = diagnoseWriting(content).diagnostics;
    const issues = (await new WritingValidationEngine(process.cwd()).validate(content)).issues;
    expect(matches.find(f => f.pattern === 'colon-reveal')).toMatchObject({ tier: 'watch', position: content.indexOf(':') });
    expect(diagnostics.find(f => f.ruleId === 'colon-reveal')).toMatchObject({ tier: 'watch', start: content.indexOf(':') });
    expect(issues.find(f => f.ruleId === 'colon-reveal')).toMatchObject({ tier: 'watch', location: { start: content.indexOf(':') } });
  });
  it.each([
    ['The queue stalled. Always check the queue.', ['aphorism-ending']],
    ['The queue stalled. This is the lesson.', ['aphorism-ending']],
    ['The queue stalled. That’s the lesson.', ['aphorism-ending']],
    ['The worker does not choose. The worker does obey.', []],
    ['The worker does not retry. The worker does log.', []],
    ['The worker does not retry. The worker does retry.', ['mirrored-sentences']],
    ['The worker is fast. The worker is slow.', ['mirrored-sentences']],
    ['The worker is not fast. The worker is not slow.', ['mirrored-sentences']],
    ['The worker never logs. The worker never retries.', []],
    ['Ready.\nWaiting.\nDone.', []],
    ['Ready. Waiting. Done.', []],
    ['This is slower. Less noise.', []],
    ['This is slower. Less noise. Retry later.', []],
    ['This is version 2. Less noise. Fewer retries.', []],
    ['The protocol is simple: a request identifier.', []],
    ['The rule is simple: send once, check twice.', []],
    ['The rule is simple: send once and check twice.', []],
    ['The rule is simple: `send once`.', []],
    ['The rule is simple: "send once".', []],
    ['The rule is simple: send 3 requests.', []],
    ['The rule is simple: send.', []],
    ['The rule is simple: send once?', []],
    ['Ready. Waiting. Done. Verified.', ['fragment-run']],
    ['First wait. Then check. Finally send. Afterward verify.', ['fragment-run']],
    ['The worker had one bug: the switch vanished. Always test the switch.', ['colon-reveal', 'aphorism-ending']],
    ['Ready. Dr. Li waits for the approval record. Done.', []],
    ['Ready. Version 3.14 remains in use. Done.', []],
    ['Ready.\n\nWaiting. Done.', []],
    ['What happened? Why? Use — or ; intentionally.', []],
    ['Valid content. Valid content. Valid content.', []],
    ['Ready.\n# A boundary\nWaiting. Done.', []],
    ['Ready.\n```text\nWaiting.\n```\nDone.', []],
    ['A factual status: waiting for approval.', []],
    ['The method 10: continuity-free Wilson approximation.', []],
    ['The helpers fail closed: NaN or non-finite values are rejected.', []],
    ['The gate statuses: G0, G1, G2.', []],
    ['The study appears at 17:2635.', []],
    ['The queue stalled. This is the result.', []],
    ['The queue stalled. That is the decision.', []],
    ['The queue stalled. All done here.', []],
    ['Never remove user-authored `.pi` resources.', []],
    ['The worker has one requirement: approval, review and testing.', []],
    ['The worker has one requirement: `approval`.', []],
    ['The worker has one requirement: pass 3 checks.', []],
    ['The output has one field: request identifier.', []],
    ['The worker has one resource: shared memory.', []],
    ['The output has one field: a request identifier.', []],
    ['The helper completes its work: the queue drains. '.repeat(4), []],
    ['The worker reads the queue. The response takes 12ms.', []],
    ['The worker reads the queue. The agent waits for approval.', []],
    ['The worker does not wait. The publisher does wait.', []],
    ['The command takes five parameters: alpha, beta, gamma.', []],
    ['The next check starts at 10:30. Always check version 2.', []],
    ['`Always test the switch case.`', []],
    ['Nothing stopped. Fixed. Always test it.', ['fragment-run', 'aphorism-ending']],
    ['Nothing stopped. Fixed. Always test it.\n', ['fragment-run', 'aphorism-ending']],
    ['It failed. Nothing stopped. Fixed. Always test it.', ['fragment-run', 'aphorism-ending']],
    ['It failed. Patched. Remember the missing switch.', ['fragment-run', 'aphorism-ending']],
    ['The queue failed. Repaired. Never trust the switch.', ['fragment-run', 'aphorism-ending']],
    ['It stopped. Resolved. The lesson is clear.', ['fragment-run', 'aphorism-ending']],
    ['We repaired the switch. Always test the “switch is gone” case.', ['aphorism-ending']],
    ['Always test the `switch is gone` case.', []],
    ['"Always test the switch case."', []],
    ['«Always test the switch case.»', []],
    ['> Always test the "switch is gone" case.', []],
    ['The worker had one bug: if the switch vanished, nothing stopped.', ['colon-reveal']],
    ['The worker had one bug: if the switch vanished, nothing stopped and nothing logged.', []],
    ['The worker had one bug: if `switch` vanished, nothing stopped.', []],
    ['The worker had one bug: if the switch vanished, nothing stopped at 10:30.', []],
    ['The worker has one field: if present, the identifier is required.', []],
  ] as Array<[string, string[]]>)('agrees on structural rules: %s', async (content, patterns) => {
    const matches = python(content);
    const diagnostics = diagnoseWriting(content).diagnostics;
    const issues = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(f => f.type !== 'missing_authenticity');
    expect(matches.map(m => m.pattern).sort()).toEqual([...patterns].sort());
    expect(diagnostics.map(m => m.ruleId).sort()).toEqual([...patterns].sort());
    expect(issues.map(m => m.ruleId).sort()).toEqual([...patterns].sort());
    for (const d of diagnostics) {
      const m = matches.find(m => m.pattern === d.ruleId)!;
      expect({ text: d.text, start: d.start, tier: d.tier }).toEqual({ text: m.text, start: m.position, tier: m.tier });
      expect(content.slice(d.start, d.end)).toBe(d.text);
      expect(m.suggestion.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['negate-then-assert', "It doesn't anymore.", 'It does not support this alias.'],
    ['negate-then-assert', 'Being signed in is not evidence of the right account.', 'Being signed in identifies the account.'],
    ['contrast-x-not-y', 'Read the capability line, not just the score.', 'Read the capability line alongside the score.'],
    ['antithesis-pair', 'Quiet release note, loud relief.', 'Quiet release note, short summary.'],
    ['aphorism-ending', 'We repaired the switch. Always test the "switch is gone" case.', 'We repaired the switch. The "switch is gone" case passes.'],
    ['colon-reveal', 'Our kill switch had one bug: if the switch itself went missing, nothing stopped.', 'The worker has one requirement: approval, review and testing.'],
    ['fragment-run', 'Nothing stopped. Fixed. Always test the "switch is gone" case.', 'Nothing stopped. Fixed. The next test passed.'],
    ['labelled-significance', "It still asks, which is the part I'd keep too.", 'It still asks when the account changes.'],
  ])('reviews #4138 %s with a positive and a negative on every surface', async (pattern, positive, negative) => {
    for (const [content, expected] of [[positive, true], [negative, false]] as const) {
      expect(python(content).some(f => f.pattern === pattern), `python: ${content}`).toBe(expected);
      expect(diagnoseWriting(content).diagnostics.some(f => f.ruleId === pattern), `diagnostics: ${content}`).toBe(expected);
      expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.some(f => f.ruleId === pattern), `validation: ${content}`).toBe(expected);
    }
  });

  it('retains explicit quote contexts and exceptions around a moral containing a scenario name', () => {
    const content = 'Always test the "switch is gone" case.';
    const finding = diagnoseWriting(content).diagnostics.find(d => d.ruleId === 'aphorism-ending')!;
    expect(finding).toMatchObject({ text: content, context: 'prose', start: 0, end: content.length });
    expect(diagnoseWriting(content, { contexts: [{ start: 0, end: content.length, context: 'quote' }] }).diagnostics).toEqual([]);
    expect(diagnoseWriting(content, { exceptions: [{ ruleId: finding.ruleId, start: finding.start, end: finding.end,
      contentHash: writingContentHash(content), reason: 'Required operator test instruction.' }] }).diagnostics[0]).toMatchObject({ resolution: 'retained' });
  });

  it('reports every requested pattern in the original #4138 reproduction', async () => {
    const content = `approve it once and the agent stops asking. it still asks about secrets and prod, which is the part i'd keep too

installing one addon used to be able to delete another addon's rules, safety ones included. it doesn't anymore. quiet release note, loud relief

our kill switch had one bug: if the switch itself went missing, nothing stopped. fixed. always test the "switch is gone" case

Being signed in is not evidence of being signed in as the right account. Read the capability line, not just the score.`;
    const patterns = python(content).map(m => m.pattern);
    expect(patterns).toEqual(expect.arrayContaining(['labelled-significance', 'antithesis-pair', 'negate-then-assert', 'contrast-x-not-y']));
    expect(patterns).toEqual(expect.arrayContaining(['colon-reveal', 'aphorism-ending', 'fragment-run']));
    expect(python(content).some(m => m.pattern === 'negate-then-assert' && m.text === "it doesn't anymore")).toBe(true);
    expect(diagnoseWriting(content).diagnostics.map(f => f.ruleId).sort()).toEqual([...patterns].sort());
    expect((await new WritingValidationEngine(process.cwd()).validate(content)).issues.filter(f => f.type !== 'missing_authenticity').map(f => f.ruleId).sort()).toEqual([...patterns].sort());
  });
});

describe('campaign entry points', () => {
  it('reports every affected document with parity, related locations, and stable input ordering', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'writing-campaign-'));
    try {
      const fixtures = ['x-thread.md', 'linkedin.md', 'telegram.md'];
      const docs = fixtures.map(id => ({ id: path.join(root, id), content: readFileSync(path.resolve('test/fixtures/writing/quality-corpus/campaign', id), 'utf8') }));
      for (const d of docs) writeFileSync(d.id, d.content);
      const results = diagnoseWritingBatch(docs, { cross: true });
      const reversed = diagnoseWritingBatch([...docs].reverse(), { cross: true });
      const engine = new WritingValidationEngine(process.cwd());
      const validation = await engine.validateBatch(docs.map(d => d.id), undefined, { cross: true });
      const reports = JSON.parse(execFileSync('python3', ['-I', script, '--cross', root], { encoding: 'utf8', timeout: 30_000 })) as Record<string, { matches: Match[] }>;
      const readable = execFileSync('python3', ['-I', script, '--cross', '--report', root], { encoding: 'utf8', timeout: 30_000 });
      expect(readable).toContain('[cut] repeated-sentence');
      for (const d of docs) {
        const findings = results.get(d.id)!.diagnostics;
        expect(findings).toHaveLength(3);
        expect(findings.map(f => [f.ruleId, f.start, f.tier])).toEqual(reversed.get(d.id)!.diagnostics.map(f => [f.ruleId, f.start, f.tier]));
        expect(reports[d.id].matches.map(m => [m.pattern, m.position, m.tier])).toEqual(findings.map(f => [f.ruleId, f.start, f.tier]));
        expect(validation.get(d.id)!.issues.filter(f => f.scope === 'cross').map(f => [f.ruleId, f.location.start])).toEqual(findings.map(f => [f.ruleId, f.start]));
        expect(validation.get(d.id)!.summary.totalIssues).toBe(validation.get(d.id)!.issues.length);
        for (const f of findings) {
          expect(f.scope).toBe('cross');
          expect(f.related).toHaveLength(2);
          expect(d.content.slice(f.start, f.end)).toBe(f.text);
        }
      }
      expect(diagnoseWritingBatch(docs).get(docs[0].id)!.diagnostics).toEqual([]);
      const f = results.get(docs[0].id)!.diagnostics.find(f => f.ruleId === 'repeated-sentence')!;
      const retained = diagnoseWritingBatch(docs, { cross: true, exceptions: [{ ruleId: f.ruleId, start: f.start, end: f.end, contentHash: writingContentHash(docs[0].content), reason: 'Required thesis' }] });
      expect(retained.get(docs[0].id)!.diagnostics.find(d => d.id === f.id)!.resolution).toBe('retained');
      const override = { id: f.ruleId, phrase: f.text, authority: 'user' as const, explanation: 'Required', suggestion: 'Retain', enabled: false };
      expect(diagnoseWritingBatch(docs, { cross: true, overrides: [override] }).get(docs[0].id)!.diagnostics.map(d => d.ruleId)).not.toContain(f.ruleId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires distinct documents for shingles and skeletons, and protects nonprose', async () => {
    const sentence = 'Approve a task once and the agent remembers it.';
    const docs = ['a', 'b', 'c'].map(id => ({ id, content: `# ${sentence}\n\n> ${sentence}\n\n\`${sentence}\`\n\nA unique ${id} ending.` }));
    for (const result of diagnoseWritingBatch(docs, { cross: true }).values()) expect(result.diagnostics).toEqual([]);
    const root = mkdtempSync(path.join(tmpdir(), 'writing-masked-campaign-'));
    try {
      const files = docs.map(d => path.join(root, `${d.id}.md`));
      docs.forEach((d, i) => writeFileSync(files[i], d.content));
      const validation = await new WritingValidationEngine(process.cwd()).validateBatch(files, undefined, { cross: true });
      for (const result of validation.values()) expect(result.issues.filter(f => f.scope === 'cross')).toEqual([]);
      const reports = JSON.parse(execFileSync('python3', ['-I', script, '--cross', root], { encoding: 'utf8', timeout: 30_000 }));
      for (const report of Object.values(reports) as Array<{ matches: Match[] }>) expect(report.matches).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const two = [{ id: 'a', content: `First readers can ${sentence} Today ends here.` }, { id: 'b', content: `Second readers can ${sentence} Tomorrow ends here.` }];
    for (const result of diagnoseWritingBatch(two, { cross: true }).values()) expect(result.diagnostics).toEqual([]);
    expect(() => diagnoseWritingBatch([two[0], two[0]], { cross: true })).toThrow('Duplicate');
    const repeats = diagnoseWritingBatch([{ id: 'a', content: sentence + ' ' + sentence }], { cross: true }).get('a')!.diagnostics;
    expect(repeats.filter(f => f.ruleId === 'repeated-sentence')).toHaveLength(2);
    expect(repeats.some(f => ['shared-skeleton', 'repeated-phrase'].includes(f.ruleId))).toBe(false);
  });

  it('bounds campaign size and scans 200 synthetic documents within ten seconds per surface', async () => {
    const docs = Array.from({ length: 200 }, (_, i) => ({ id: `doc-${i}`, content: `Channel ${i} reports its individual change. Approve a task once and the agent remembers it.\n\nEach team reviews this shared process before the release starts for reader ${i}.` }));
    const started = performance.now();
    const findings = scanCampaignPatterns(docs);
    expect(findings.size).toBe(200);
    expect([...findings.values()].every(f => f.some(m => m.ruleId === 'repeated-sentence'))).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
    const root = mkdtempSync(path.join(tmpdir(), 'writing-campaign-timing-'));
    try {
      for (const d of docs) writeFileSync(path.join(root, `${d.id}.md`), d.content);
      const began = performance.now();
      const reports = JSON.parse(execFileSync('python3', ['-I', script, '--cross', root], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }));
      expect(Object.keys(reports)).toHaveLength(200);
      expect(performance.now() - began).toBeLessThan(10_000);
      writeFileSync(path.join(root, 'overflow.md'), 'Extra document.');
      expect(() => execFileSync('python3', ['-I', script, '--cross', root], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })).toThrow('Campaign exceeds 200 documents');
    } finally { rmSync(root, { recursive: true, force: true }); }
    const overflow = [...docs, { id: 'overflow', content: '' }];
    expect(() => scanCampaignPatterns(overflow)).toThrow('Campaign exceeds 200 documents');
    expect(() => diagnoseWritingBatch(overflow, { cross: true })).toThrow('Campaign exceeds 200 documents');
    await expect(new WritingValidationEngine(process.cwd()).validateBatch(overflow.map(d => d.id), undefined, { cross: true })).rejects.toThrow('Campaign exceeds 200 documents');
  });

  it('uses native Unicode position units for structural and campaign findings', async () => {
    const content = '🧵 The switch stopped. Always test the switch.';
    const match = python(content).find(f => f.pattern === 'aphorism-ending')!;
    const diagnostic = diagnoseWriting(content).diagnostics.find(f => f.ruleId === match.pattern)!;
    const issue = (await new WritingValidationEngine(process.cwd()).validate(content)).issues.find(f => f.ruleId === match.pattern)!;
    expect(diagnostic.start).toBe(match.position + 1);
    expect(issue.location.start).toBe(diagnostic.start);
    const docs = ['a', 'b'].map(id => ({ id, content: '🧵 Ready. Approve a task once and the agent remembers it.' }));
    const cross = diagnoseWritingBatch(docs, { cross: true }).get('a')!.diagnostics.find(f => f.ruleId === 'repeated-sentence')!;
    expect(cross.start).toBe(docs[0].content.indexOf('Approve'));
  });

});
