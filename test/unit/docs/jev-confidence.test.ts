// Guard the user-facing wording-shift decision and its evidence limitations (#2872).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decisionHandler } from '../../../src/cli/handlers/decision.js';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const decisionPath = 'docs/decision/jev-confidence-wording-shift.md';

describe('Jev confidence wording-shift caveat', () => {
  it('exposes the operational caveat through ask help without invoking a model', async () => {
    const result = await decisionHandler.help!({
      args: ['ask', '--help'], rawArgs: ['decision', 'ask', '--help'],
      cwd: process.cwd(), frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.message?.replace(/\s+/g, ' ')).toContain('confidence does not transfer across wording');
    expect(result.message?.replace(/\s+/g, ' ')).toContain('calibrated probability of correctness');
    expect(result.message).toContain(decisionPath);
  });

  it('states the probability caveat in both shipped ask entry points', () => {
    for (const file of ['docs/decision/jev-quickstart.md', 'docs/cli/reference.md']) {
      const doc = read(file).replace(/\s+/g, ' ');
      expect(doc).toContain('Confidence does not transfer across wording; do not use it as a calibrated probability of correctness.');
    }
  });

  it('makes the caveat discoverable when following the ask quickstart', () => {
    const ask = read('docs/decision/jev-quickstart.md').split('## 4. Ask')[1]?.split('### Passes')[0] ?? '';
    expect(ask).toContain('(jev-confidence-wording-shift.md)');
    expect(ask).toMatch(/wording.shift/i);
  });

  it('keeps issue-reported calibrated observations separate from native confidence evidence', () => {
    const doc = read(decisionPath).replace(/\s+/g, ' ');
    expect(doc).toContain('.aiwg/research/d17-multifact-results-2026-10-06.md');
    expect(doc).toMatch(/missing from this checkout/);
    expect(doc).toMatch(/issue-reported.*unverified/i);
    expect(doc).toContain('src/decision/ensemble-study/multifact-study.ts');
    expect(doc).toMatch(/native.*yes-no.*unknown/i);
    expect(doc).toMatch(/native.*multi-option choice.*unknown/i);
  });

  it('records the unchanged default, operational caveat, and expired-artifact follow-up', () => {
    const doc = read(decisionPath).replace(/\s+/g, ' ');
    expect(doc).toMatch(/Keep.*0\.8/);
    expect(doc).toMatch(/per-shape thresholds.*not supported/i);
    expect(doc).toMatch(/independent.*validation/i);
    expect(doc).toContain('2026-11-01T10:02:34.263Z');
    expect(doc).toMatch(/wording-diverse/i);
    expect(doc).toMatch(/refit/i);
    expect(doc).toMatch(/30 days/);
    expect(doc).toMatch(/held-out.*wording/i);
  });
});
