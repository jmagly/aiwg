import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { missingTemplateSections, warnTemplateSections } from '../../../src/delivery/template-sections.js';
import { parseRuleFrontmatter } from '../../../src/rules/activation.mjs';
import { renderRuleKernelIndex } from '../../../tools/agents/providers/rule-presentation.mjs';

describe('template section advice (#3932)', () => {
  it('ignores optional sections, fenced examples and non-level-two headings', () => {
    const template = [
      '## Required', '## Suggested fix (optional but valued)',
      '<!-- optional -->', '', '## Extra context', '## Logs <!-- optional -->',
      '```md', '## Example', '```', '~~~md', '## Another example', '~~~', '### Detail',
    ].join('\n');
    expect(missingTemplateSections('## required\r\nObserved.', template)).toEqual([]);
    expect(missingTemplateSections('```\n## Required\n```', template)).toEqual(['Required']);
  });

  it('accepts short headings without template annotations but requires the same heading level', () => {
    const template = '## Environment (REQUIRED — supply every field)\n## Acceptance criteria';
    expect(missingTemplateSections('## Environment\n### Acceptance criteria', template)).toEqual(['Acceptance criteria']);
  });

  it('warns without throwing when a selected template cannot be read', () => {
    const warn = vi.fn();
    expect(warnTemplateSections('', 'agentic/code/missing-template-3932.md', warn)).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('required sections were not checked'));
  });

  it('projects the canonical description into native and prose kernel indexes', () => {
    const source = readFileSync(new URL('../../../agentic/code/addons/aiwg-utils/rules/artifact-output-policy.md', import.meta.url), 'utf8');
    const parsed = parseRuleFrontmatter(source);
    expect(parsed.valid).toBe(true);
    expect(parsed.rule.summary).toBe(parsed.data.description);
    expect(parsed.rule.activation).toBe('kernel');
    for (const index of [renderRuleKernelIndex([parsed.rule], true, true),
      renderRuleKernelIndex([parsed.rule], false, true, () => 'artifact-output-policy.md')]) {
      expect(index).toContain(`artifact-output-policy — ${parsed.data.description}`);
    }
    for (const phrase of ['Output template', 'observed facts', 'never drop it silently', 'no template exists']) {
      expect(parsed.body).toContain(phrase);
    }
  });
});
