// Keep compound-name selection specific while accepting action/noun inflection.
import { describe, expect, it } from 'vitest';
import { skillNameIntent } from '../../../src/artifacts/query-engine-name-intent.js';
import { scoreEntryDetailed, tokenize } from '../../../src/artifacts/query-engine-scoring.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';

describe('compound skill name intent', () => {
  it.each([
    ['post-scorer', 'score a social media post before publishing'],
    ['seo-audit', 'seo audit for a docs site'],
    ['aiwg-issue', 'file issues for improvements into aiwg based on learnings'],
    ['seo-audit', 'audit SEO for the docs site'],
    ['post-builder', 'build a post'],
  ])('recognizes %s in %s', (name, text) => {
    expect(skillNameIntent(name, text, tokenize).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['aiwg-issue', 'address issues from the tracker'],
    ['seo-audit', 'audit the docs site'],
    ['post-scorer', 'post the scorecard'],
    ['audit', 'audit for a docs site'],
    ['seo-audit', 'write a test plan: later consider seo audit'],
    ['aiwg-refresh', 'file an issue about `aiwg refresh`'],
    ['aiwg-issue', 'file issues in an aiwgish project'],
    ['agent-skill', 'find an agent skill'],
  ])('does not promote %s from incomplete or trailing context: %s', (name, text) => {
    expect(skillNameIntent(name, text, tokenize)).toEqual([]);
  });

  it('reports the name evidence and keeps deliberate exact selection stronger', () => {
    const entry = { type: 'skill', name: 'post-scorer', title: 'Post Scorer', path: 'post-scorer/SKILL.md',
      summary: '', tags: [] } as unknown as MetadataEntry;
    const result = scoreEntryDetailed(entry, 'score a social media post before publishing');
    expect(result.score).toBeGreaterThan(1);
    expect(result.score).toBeLessThan(scoreEntryDetailed(entry, 'post-scorer').score);
    expect(result.diagnostic.matches).toEqual([expect.objectContaining({
      field: 'name', value: 'post-scorer', matched_tokens: ['post', 'score'],
    })]);
    expect(scoreEntryDetailed({ ...entry, type: 'template' }, 'score a social media post before publishing').score)
      .toBeLessThan(result.score);
  });

  it('keeps explicitly named subjects above incidental compound names', () => {
    const base = { type: 'skill', title: '', path: 'SKILL.md', summary: '', tags: [] } as unknown as MetadataEntry;
    const phrase = 'write a test plan for the checkpoint command and score my post';
    expect(scoreEntryDetailed({ ...base, name: 'checkpoint' }, phrase).score)
      .toBeGreaterThan(scoreEntryDetailed({ ...base, name: 'post-scorer' }, phrase).score);
  });
});
