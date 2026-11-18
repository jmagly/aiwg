// Guard the shipped editorial guidance and its shared voice-profile handoff.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationRuleLoader } from '../../../src/writing/validation-rules.js';

const root = resolve(import.meta.dirname, '../../..');
const writing = 'agentic/code/addons/writing-quality';
const voice = 'agentic/code/addons/voice-framework';
const commonPath = `${writing}/patterns/common-ai-tells.md`;
const reviewPath = `${writing}/validation/banned-patterns.md`;
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const common = read(commonPath);
const review = read(reviewPath);
const patterns = [
  ['Negate-then-assert', 'cut'], ['Mirrored pairs', 'cut'], ['Moral endings', 'cut'],
  ['Labelled significance', 'cut'], ['Asserted importance openings', 'check'],
  ['Definition openings', 'watch'], ['Effect triads', 'watch'], ['Summary closers', 'check'],
  ['Colon reveals', 'watch'], ['Fragment runs', 'check'], ['Faux-casual quips', 'check'],
  ['Throat-clearing', 'cut'], ['Engagement bait', 'cut'],
];
const inherited = [
  `${voice}/docs/contextual-diagnostics.md`, `${voice}/skills/voice-apply/SKILL.md`,
  `${voice}/skills/voice-create/SKILL.md`, `${voice}/rules/voice-framework.md`,
];

describe('structural editing guidance (#4141)', () => {
  it.each(patterns)('%s has a tier, example and actionable fix in both review surfaces', (name, tier) => {
    const section = common.split(`### ${name}\n`)[1]?.split('\n### ')[0];
    expect(section, name).toBeDefined();
    expect(section).toContain(`**Tier: ${tier}**`);
    expect(section).toMatch(/\*\*Example:\*\* .+/);
    expect(section).toMatch(/\*\*Fix:\*\* .+/);
    const row = review.split('\n').find(line => line.startsWith(`| ${name} |`));
    expect(row, name).toBeDefined();
    const cells = row!.split('|').map(s => s.trim());
    expect(cells[2]).toBe(tier);
    expect(cells[3].length).toBeGreaterThan(15);
    expect(cells[4].length).toBeGreaterThan(15);
  });

  it.each([commonPath, reviewPath, `${writing}/core/philosophy.md`])('%s removes manufactured casualness', file => {
    expect(read(file)).not.toMatch(/typos \(occasionally\)|inside jokes|sometimes grumpy|some paragraphs are one sentence|use fragments\. start with conjunctions/i);
  });

  it.each([commonPath, reviewPath])('%s covers campaign reuse and substantive articles', file => {
    const text = read(file);
    expect(text).toMatch(/thesis line.*across channels/i);
    expect(text).toMatch(/rotate release-post openers and closers/i);
    expect(text).toMatch(/never reuse a joke or line in a later post/i);
    expect(text).toMatch(/signature move.*lede formula/i);
    expect(text).toMatch(/articles and how-tos/i);
    for (const item of ['configuration', 'command', 'prompt', 'script', 'result']) expect(text).toContain(item);
    expect(text).toMatch(/never invent/i);
  });

  it.each([commonPath, reviewPath])('%s states false positives and authorship limits', file => {
    const text = read(file);
    expect(text).toMatch(/not authorship detection/i);
    for (const item of ['em dashes', 'colons', 'semicolons', 'passive voice', 'plain transitions', 'real lists']) {
      expect(text.toLowerCase()).toContain(item);
    }
    expect(text).toMatch(/on their own/i);
    expect(text).not.toMatch(/answer.*B is AI|spot the AI|ANY of these exact phrases, rewrite/i);
  });

  it.each(inherited)('%s inherits shared rules without prescribing signature insertion', file => {
    const text = read(file);
    expect(text).toContain('writing-quality/patterns/common-ai-tells.md');
    expect(text).toMatch(/campaign/i);
    expect(text).toMatch(/substance/i);
    expect(text).toMatch(/not authorship detection/i);
    expect(text).not.toMatch(/2-4 signature phrases|Signature phrases that match the voice/);
  });

  it('uses the existing dated rotating lexical catalogue rather than a second word list', () => {
    const cataloguePath = `${writing}/skills/ai-pattern-detection/references/current-patterns.json`;
    const catalogue = JSON.parse(read(cataloguePath));
    expect(catalogue.reviewed).toBe('2026-11-12');
    expect(catalogue.nextReview).toBe('2027-02-12');
    expect(new Date(catalogue.nextReview).getTime() - new Date(catalogue.reviewed).getTime()).toBe(92 * 86400000);
    for (const text of [common, review]) {
      expect(text).toContain('current-patterns.json');
      expect(text).toMatch(/quarterly/i);
      expect(text).toContain('2027-02-12');
      expect(text).not.toContain('### Corporate/Marketing Speak');
    }
  });

  it('resolves the shared rules and lexicon links from every source guide', () => {
    for (const file of [commonPath, reviewPath, ...inherited]) {
      const text = read(file);
      const links = [...text.matchAll(/\]\(([^)]+(?:common-ai-tells\.md|current-patterns\.json))\)/g)];
      expect(links.length, file).toBeGreaterThan(0);
      for (const [, link] of links) expect(existsSync(resolve(root, dirname(file), link)), `${file}: ${link}`).toBe(true);
    }
  });

  it('keeps prose examples and instructions out of legacy executable phrase rules', async () => {
    const loader = new ValidationRuleLoader(root);
    for (const file of [commonPath, reviewPath]) {
      expect(await loader.loadFromMarkdown(resolve(root, file))).toEqual([]);
    }
  });

  it('documents the guidance change in the changelog and both addon overviews', () => {
    expect(read('CHANGELOG.md').split('## [2026.11.8]')[0]).toMatch(/#4141/);
    for (const file of [`${writing}/README.md`, `${voice}/README.md`]) {
      expect(read(file)).toMatch(/common-ai-tells\.md/);
      expect(read(file)).toMatch(/campaign/i);
      expect(read(file)).toMatch(/substance/i);
    }
  });

  it('ships shared rules and the dated catalogue with standalone writing and voice plugins', () => {
    const plugins = 'agentic/code/plugins';
    expect(read(`${plugins}/writing/patterns/common-ai-tells.md`)).toBe(common);
    expect(read(`${plugins}/writing/validation/banned-patterns.md`)).toBe(review);
    const packaged = read(`${plugins}/voice/docs/structural-editing.md`);
    expect(packaged).toContain('### Fragment runs');
    expect(packaged).toContain('](current-patterns.json)');
    expect(read(`${plugins}/voice/docs/current-patterns.json`)).toBe(
      read(`${writing}/skills/ai-pattern-detection/references/current-patterns.json`));
    for (const name of ['voice-apply', 'voice-create']) {
      const file = `${plugins}/voice/skills/${name}/SKILL.md`;
      expect(read(file)).toContain('](../../docs/structural-editing.md)');
      expect(existsSync(resolve(root, dirname(file), '../../docs/structural-editing.md'))).toBe(true);
    }
  });
});
