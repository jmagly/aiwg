/**
 * Muse discover-first AGENTS.md bridge tests (#227).
 *
 * Covers the context-pipeline side of the Muse bridge:
 * - bridge content: trust-gated load caveat, Muse-native instruction order,
 *   discover-first `aiwg discover` / `aiwg show` guidance, no false auto-load
 *   claims, Muse-accurate reload guidance (never Cursor/IDE reload copy),
 *   no CLAUDE.md shim.
 * - determinism: `aiwg regenerate --provider muse` produces byte-identical
 *   AGENTS.md output across runs (no timestamps/randomness).
 * - managed sections: project deploy updates only the AIWG-managed sections
 *   of AGENTS.md; operator content outside markers is byte-identical
 *   (clobber protection), and managed-block refresh is idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentsMd,
  buildMuseBridgeText,
  generate,
  buildProviderBootstrapBlock,
} from '../../../src/smiths/context-pipeline/index.js';
import type { ContextPipelineOptions } from '../../../src/smiths/context-pipeline/index.js';

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function museOpts(projectPath: string, extra: Partial<ContextPipelineOptions> = {}): ContextPipelineOptions {
  return { provider: 'muse', projectPath, sections: [], ...extra };
}

describe('muse bridge content (#227)', () => {
  it('states the trust-gated AGENTS.md load', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).toContain('first-run trust prompt');
    expect(content).toContain('Until the workspace is trusted, this');
    expect(content).toContain('file does not load');
  });

  it('uses Muse-native instruction order (AGENTS.md first)', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    const order = content.indexOf('this AGENTS.md first');
    const workspace = content.indexOf('[WORKSPACE.md](./WORKSPACE.md)');
    const aiwg = content.indexOf('[AIWG.md](./AIWG.md)');
    expect(order).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(order);
    expect(aiwg).toBeGreaterThan(workspace);
  });

  it('instructs discover-first with aiwg discover / aiwg show', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).toContain('`aiwg discover "<intent>"`');
    expect(content).toContain('`aiwg show <type> <name>`');
    expect(content).toContain('never paste full artifact');
  });

  it('makes no false auto-load claims', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).toContain('does not');
    expect(content).toContain('claim Muse auto-loads any other AIWG path');
    expect(content).not.toContain('auto-loads AIWG paths');
  });

  it('carries Muse-accurate trust/reload guidance, never Cursor copy', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).toContain('trust the workspace again if');
    expect(content).toMatch(/start a new Muse session/);
    expect(content).not.toContain('Cursor');
    expect(content).not.toContain('reload the window');
    expect(content).not.toContain('Reload Window');
  });

  it('ships no CLAUDE.md shim or foreign-provider surface', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).not.toContain('CLAUDE.md');
    expect(content).not.toContain('.cursor');
  });

  it('keeps the rule-authority invariant', async () => {
    const { content } = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(content).toContain('AIWG rules deployed to this project are binding');
  });

  it('is deterministic across builds', async () => {
    expect(buildMuseBridgeText()).toBe(buildMuseBridgeText());
    const first = await buildAgentsMd(museOpts('/tmp/unused'));
    const second = await buildAgentsMd(museOpts('/tmp/unused'));
    expect(second.content).toBe(first.content);
  });

  it('other providers keep the generic prose-directive text', async () => {
    const { content } = await buildAgentsMd({ provider: 'codex', projectPath: '/tmp/unused', sections: [] });
    expect(content).toContain('Plain Markdown links are not claimed to auto-load');
    expect(content).not.toContain('first-run trust prompt');
  });
});

describe('muse regenerate determinism (#227)', () => {
  it('produces byte-identical AGENTS.md across generate() runs', async () => {
    const project = temporaryRoot('aiwg-muse-determinism-');
    const opts = museOpts(project, { detectExistingFiles: true });
    await generate(opts);
    const first = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(first).toContain('first-run trust prompt');

    await generate(museOpts(project, { detectExistingFiles: true }));
    const second = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(second).toBe(first);

    // Canonical graph files are deterministic too.
    const workspaceFirst = readFileSync(join(project, 'WORKSPACE.md'), 'utf8');
    const aiwgFirst = readFileSync(join(project, 'AIWG.md'), 'utf8');
    await generate(museOpts(project, { detectExistingFiles: true }));
    expect(readFileSync(join(project, 'WORKSPACE.md'), 'utf8')).toBe(workspaceFirst);
    expect(readFileSync(join(project, 'AIWG.md'), 'utf8')).toBe(aiwgFirst);
  });

  it('emits the muse bootstrap block for operator-owned files via ensureManagedHook', async () => {
    const project = temporaryRoot('aiwg-muse-hook-');
    const operatorContent = '# Team Notes\n\nKeep this section.\n';
    writeFileSync(join(project, 'AGENTS.md'), operatorContent);

    await generate(museOpts(project, { detectExistingFiles: true }));
    const content = readFileSync(join(project, 'AGENTS.md'), 'utf8');

    // Operator content outside the managed block is byte-identical.
    expect(content.startsWith(operatorContent)).toBe(true);
    // Managed block carries the muse bridge.
    expect(content).toContain('<!-- AIWG:context-hook:start -->');
    expect(content).toContain('<!-- AIWG:context-hook:end -->');
    expect(content).toContain('first-run trust prompt');
    expect(content).toContain('AIWG rules deployed to this project are binding');

    // Managed-block refresh is idempotent: second run changes nothing.
    await generate(museOpts(project, { detectExistingFiles: true }));
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(content);
  });
});

describe('muse AGENTS.md managed sections (#227)', () => {
  it('updates only the managed block on drift, preserving operator content', async () => {
    const project = temporaryRoot('aiwg-muse-managed-');
    const operatorContent = '# Operator Handbook\n\nDo not touch.\n';
    writeFileSync(join(project, 'AGENTS.md'), operatorContent);

    await generate(museOpts(project, { detectExistingFiles: true }));
    const canonical = readFileSync(join(project, 'AGENTS.md'), 'utf8');

    // Simulate content drift inside the managed block only.
    const drifted = canonical.replace('first-run trust prompt', 'first-run trust promp');
    expect(drifted).not.toBe(canonical);
    writeFileSync(join(project, 'AGENTS.md'), drifted);

    await generate(museOpts(project, { detectExistingFiles: true }));
    const refreshed = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(refreshed).toBe(canonical);
    expect(refreshed.startsWith(operatorContent)).toBe(true);
  });

  it('full-writes a fresh AGENTS.md with the muse bootstrap markers', async () => {
    const project = temporaryRoot('aiwg-muse-fresh-');
    const result = await generate(museOpts(project, { detectExistingFiles: true }));
    expect(result.agentsMdPath).toBe(join(project, 'AGENTS.md'));
    const content = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(content).toContain('<!-- aiwg-managed -->');
    expect(content).toContain('<!-- AIWG:provider-bootstrap:start -->');
    expect(content).toContain('<!-- AIWG:provider-bootstrap:end -->');
    expect(content).toContain(buildMuseBridgeText());
  });

  it('buildProviderBootstrapBlock("muse") matches the policy bridge', () => {
    const block = buildProviderBootstrapBlock('muse');
    expect(block).toContain('<!-- AIWG:provider-bootstrap:start -->');
    expect(block).toContain('<!-- AIWG:provider-bootstrap:end -->');
    expect(block).toContain(buildMuseBridgeText());
  });
});
