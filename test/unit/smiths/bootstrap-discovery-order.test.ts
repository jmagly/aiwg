// Guard discovery order across provider bootstrap and workspace precedence text.
import { describe, expect, it } from 'vitest';
import { buildProviderBootstrapBlock } from '../../../src/smiths/context-pipeline/workspace-bootstrap.js';
import { buildWorkspaceManagedBlock } from '../../../src/smiths/context-pipeline/workspace-document.js';

const lookup = (text: string) => {
  expect(text).toContain('never open `.agents/skills/**` or `agentic/code/**`');
  expect(text).toContain("including a discovered skill's mirror file or a template");
  expect(text).toContain('After discover, use `aiwg show <type> <name>` and its drill-ins');
};

describe('bootstrap discovery ordering (#4234, #4235)', () => {
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
