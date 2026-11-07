import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { missingTemplateSections, warnTemplateSections } from '../../../src/delivery/template-sections.js';
import { parseRuleFrontmatter } from '../../../src/rules/activation.mjs';
import { renderRuleKernelIndex } from '../../../tools/agents/providers/rule-presentation.mjs';

describe('template section advice (#3932)', () => {
  const comments = new URL('../../../agentic/code/frameworks/sdlc-complete/templates/issue-comments/', import.meta.url);

  it.each(readdirSync(comments).filter(file => file.endsWith('.md') && file !== 'README.md'))(
    '%s uses scope instead of time and percentages (#3944)', file => {
      const forbidden = /percentage|%|time spent|timeline|\{hours\}|\{time_estimate\}|\{delay_estimate\}|\{date_or_duration\}|\{date_or_timeline\}|Expected: \{date\}/i;
      expect(readFileSync(new URL(file, comments), 'utf8')).not.toMatch(forbidden);
    });

  it('reports acceptance criteria met and pending and blockers (#3944)', () => {
    const progress = readFileSync(new URL('progress-update.md', comments), 'utf8');
    expect(progress).toContain('**Acceptance criteria**: {met} of {total} met');
    expect(progress).toContain('### Acceptance Criteria Pending');
    expect(progress).toContain('## Blockers and Dependencies');
  });

  it.each(['progress-update', 'blocker-found', 'feedback-needed', 'task-completed'])(
    'accepts a complete %s body and still warns for a missing section (#3936)', name => {
      const templatePath = `agentic/code/frameworks/sdlc-complete/templates/issue-comments/${name}.md`;
      const template = readFileSync(new URL(`${name}.md`, comments), 'utf8');
      const complete = template.replace(/\{[^{}]+\}/g, 'Observed scope and verification');
      const warn = vi.fn();
      expect(warnTemplateSections(complete, templatePath, warn)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      const firstHeading = template.match(/^## (.+)$/m)![1];
      expect(warnTemplateSections(complete.replace(`## ${firstHeading}\n`, ''), templatePath, warn))
        .toEqual([firstHeading]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(firstHeading));
    });

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
