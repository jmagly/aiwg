// Guard discovery order across provider bootstrap and workspace precedence text.
import { describe, expect, it } from 'vitest';
import { buildProviderBootstrapBlock, buildRuleStartupBootstrapBlock, buildCompactRuleStartupBootstrapBlock } from '../../../src/smiths/context-pipeline/workspace-bootstrap.js';
import { buildWorkspaceManagedBlock } from '../../../src/smiths/context-pipeline/workspace-document.js';

const lookup = (text: string) => {
  expect(text).toContain('never open `.agents/skills/**` or `agentic/code/**`');
  expect(text).toContain("including a discovered skill's mirror file or a template");
  expect(text).toContain('After discover, use `aiwg show <type> <name>` and its drill-ins');
};

describe('bootstrap discovery ordering (#4234, #4235)', () => {
  it.each(['claude', 'codex', 'cursor', 'muse', 'hermes', 'antigravity', 'copilot', 'grok-build',
    'deepseek-harness', 'factory', 'grokbot', 'opencode', 'openclaw', 'openhuman', 'pi', 'omp', 'warp', 'devin', 'generic'])(
    '%s preserves the current-turn no-tools exception in provider authority (#4514)', provider => {
      const text = buildProviderBootstrapBlock(provider);
      expect(text).toContain('explicit user prohibition on tools in the current turn');
      expect(text).toContain('Answer from loaded context');
      expect(text).toContain('disclose why in one line');
      expect(text).toContain('not an overridden session directive');
      expect(text).toContain('A decline request alone still requires discovery');
    });

  it('keeps full and compact rule-startup exceptions consistent with workspace precedence', () => {
    for (const text of [buildRuleStartupBootstrapBlock(), buildCompactRuleStartupBootstrapBlock()]) {
      expect(text).toMatch(/(?:current|this) turn/);
      expect(text.toLowerCase()).toContain('answer from loaded context');
      expect(text).toMatch(/(?:disclose why|say) in one line/);
    }
    const workspace = buildWorkspaceManagedBlock('/unused');
    expect(workspace).toContain('explicit user prohibition on actions for the current turn is not a session directive');
    expect(workspace).toContain('Only an explicit prohibition on tool use suspends discover-first');
    expect(workspace).toContain('A decline request alone is not a tool prohibition');
  });

  it.each(['codex', 'muse', 'antigravity'])('%s forbids mirror and template lookup even after discovery', provider => {
    lookup(buildProviderBootstrapBlock(provider));
  });

  it('Muse puts discovery ahead of explicit context reads for every new directive', () => {
    const text = buildProviderBootstrapBlock('muse');
    expect(text).toContain('On every new directive, run `aiwg discover "<intent>"` as the first information-gathering call');
    expect(text).toContain('before reading WORKSPACE.md, AIWG.md, the rules index, or quickrefs');
    expect(text.indexOf('first information-gathering call')).toBeLessThan(text.indexOf('[WORKSPACE.md]'));
    expect(text).toContain('After discovery, read and follow [WORKSPACE.md]');
    expect(text).not.toContain('Before improvising on any AIWG capability');
  });

  it('WORKSPACE precedence does not tell Muse to read context ahead of discovery', () => {
    const text = buildWorkspaceManagedBlock('/unused');
    expect(text).toContain('On every new directive, run `aiwg discover` before tool-based context reads');
    expect(text).toContain('then read WORKSPACE.md, then AIWG.md');
    expect(text).not.toContain('they direct the harness here first');
  });
});
