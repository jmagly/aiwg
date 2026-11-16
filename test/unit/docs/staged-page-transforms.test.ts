import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped build helper
import { deriveSummary, excludedPageLinks, repositoryLinks, withDerivedSummary } from '../../../tools/docs/staged-page-transforms.mjs';

describe('staged documentation page transforms', () => {
  it('derives a summary from the first prose paragraph, skipping structure', () => {
    const body = [
      '# Title', '', '> **Note:** a callout that is not the summary.', '',
      '| a | b |', '|---|---|', '', '```bash', 'aiwg use all', '```', '',
      'Jev offloads **bounded decisions** such as a [yes/no gate](gates.md), so the model',
      'does not spend reasoning on them.', '', 'A later paragraph.',
    ].join('\n');
    expect(deriveSummary(body))
      .toBe('Jev offloads bounded decisions such as a yes/no gate, so the model does not spend reasoning on them.');
  });

  it('keeps summaries within 155 characters and ends on a sentence or an ellipsis', () => {
    const sentence = 'This sentence is exactly long enough to count as prose for a page summary. ';
    const long = deriveSummary(`# T\n\n${sentence.repeat(5)}`);
    expect(long.length).toBeLessThanOrEqual(155);
    expect(long.endsWith('.')).toBe(true);
    const unbroken = deriveSummary(`# T\n\n${'word '.repeat(80)}`);
    expect(unbroken.length).toBeLessThanOrEqual(155);
    expect(unbroken.endsWith('…')).toBe(true);
  });

  it('skips metadata blocks and never emits a command or flag as a description', () => {
    const prose = 'The provider is promoted to stable after the qualification run passed on Linux.';
    expect(deriveSummary(`# T\n\n**Date:** 2026-09-16 (America/New_York)\n**Host:** Linux\n\n${prose}\n`)).toBe(prose);
    expect(deriveSummary(`# T\n\nUse the operator-supplied \`aiwg\` source root for every deployment on this host.\n\n${prose}\n`))
      .toBe(prose);
    expect(deriveSummary(`# T\n\nPass \`--provider grokbot\` when you deploy to a Grok Bot fleet from this workspace.\n\n${prose}\n`))
      .toBe(prose);
    expect(deriveSummary('# T\n\nThe zone is America/New_York and the variable is AIWG_GROKBOT_SKILLS_DIR for this run.\n'))
      .toBe('The zone is America/New_York and the variable is AIWG_GROKBOT_SKILLS_DIR for this run.');
  });

  it('returns no summary when a page has no prose paragraph', () => {
    expect(deriveSummary('# Title\n\n- one\n- two\n\nShort.\n')).toBe('');
  });

  it('adds front matter only when a page declares neither summary nor description', () => {
    const prose = 'A paragraph that is comfortably long enough to be used as the page summary.';
    expect(withDerivedSummary(`# T\n\n${prose}\n`)).toBe(`---\nsummary: ${JSON.stringify(prose)}\n---\n\n# T\n\n${prose}\n`);
    expect(withDerivedSummary(`---\ntitle: T\n---\n# T\n\n${prose}\n`))
      .toBe(`---\ntitle: T\nsummary: ${JSON.stringify(prose)}\n---\n# T\n\n${prose}\n`);
    const declared = `---\ndescription: "Already described"\n---\n# T\n\n${prose}\n`;
    expect(withDerivedSummary(declared)).toBe(declared);
    expect(withDerivedSummary('# T\n\n- list only\n')).toBe('# T\n\n- list only\n');
  });

  it('points links that leave docs/ at the repository and leaves in-docs links alone', () => {
    const content = '[ops](../../agentic/code/addons/decision-engine/docs/operations.md#run) '
      + '[install](../getting-started/install-connect-verify.md) [sibling](gates.md) [site](https://aiwg.io)';
    expect(repositoryLinks(content, 'decision')).toBe(
      '[ops](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/decision-engine/docs/operations.md#run) '
      + '[install](../getting-started/install-connect-verify.md) [sibling](gates.md) [site](https://aiwg.io)',
    );
    expect(repositoryLinks('[fixture](../../test/fixtures/x.md)', 'decision'))
      .toBe('[fixture](https://github.com/jmagly/aiwg/blob/main/test/fixtures/x.md)');
  });
  it('points links to excluded-but-existing pages at the repository and leaves others alone', () => {
    const excluded = new Set(['architecture/cli/index.md', 'discovery-and-kernel-skills.md']);
    const options = {
      isExcluded: (page: string) => excluded.has(page),
      existsInSource: (page: string) => page !== 'architecture/cli/missing.md',
    };
    expect(excludedPageLinks('[a](../architecture/cli/index.md#flows)', 'cli', options))
      .toBe('[a](https://github.com/jmagly/aiwg/blob/main/docs/architecture/cli/index.md#flows)');
    expect(excludedPageLinks('[k](discovery-and-kernel-skills.md)', '.', options))
      .toBe('[k](https://github.com/jmagly/aiwg/blob/main/docs/discovery-and-kernel-skills.md)');
    // Public pages, external URLs and pages missing from source keep failing strict validation.
    expect(excludedPageLinks('[p](../project-local/overview.md)', 'cli', options)).toBe('[p](../project-local/overview.md)');
    expect(excludedPageLinks('[e](https://example.com/x.md)', 'cli', options)).toBe('[e](https://example.com/x.md)');
    const missing = { ...options, isExcluded: () => true, existsInSource: () => false };
    expect(excludedPageLinks('[m](../architecture/cli/missing.md)', 'cli', missing)).toBe('[m](../architecture/cli/missing.md)');
  });
});
