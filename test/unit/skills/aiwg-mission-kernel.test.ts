/**
 * aiwg-mission kernel skill — wiring + contract.
 *
 * #1544: AIWG ships its OWN orchestration command (/aiwg-mission) to Codex as a
 * prompt (mirrored via MIRRORED_KERNEL_COMMAND_SKILLS → ~/.codex/prompts/), NOT
 * the plugin-provided /workflow. This test proves:
 *   1. the skill source exists with kernel:true frontmatter,
 *   2. it is a member of MIRRORED_KERNEL_COMMAND_SKILLS in BOTH the TS handler
 *      (src/cli/handlers/use.ts) and the JS deployer (tools/agents/deploy-command-mirrors.mjs, used by deploy-agents.mjs)
 *      — the duplicated set is a known drift risk, so assert parity,
 *   3. the body encodes the Mission → external/durable route + retained-ownership
 *      contract (#1537 ADR), so /aiwg-mission maps to a Mission, not a no-op.
 *
 * @issue #1544, #1534 (epic)
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILL = path.join(
  REPO_ROOT,
  'agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md',
);

function readKernelSet(file: string): string {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const m = src.match(/MIRRORED_KERNEL_COMMAND_SKILLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  expect(m, `${file} should declare MIRRORED_KERNEL_COMMAND_SKILLS`).toBeTruthy();
  return m![1];
}

describe('aiwg-mission kernel skill (#1544)', () => {
  it('exists with kernel:true + aiwg namespace frontmatter', () => {
    expect(fs.existsSync(SKILL), 'aiwg-mission/SKILL.md exists').toBe(true);
    const body = fs.readFileSync(SKILL, 'utf8');
    expect(body).toMatch(/^name:\s*aiwg-mission\s*$/m);
    expect(body).toMatch(/^kernel:\s*true\s*$/m);
    expect(body).toMatch(/^namespace:\s*aiwg\s*$/m);
  });

  it('is mirrored as a kernel command-skill in BOTH deploy paths (→ ~/.codex/prompts/)', () => {
    const tsSet = readKernelSet('src/cli/handlers/use.ts');
    const jsSet = readKernelSet('tools/agents/deploy-command-mirrors.mjs');
    expect(tsSet).toContain("'aiwg-mission'");
    expect(jsSet).toContain("'aiwg-mission'");
  });

  it('body maps a Mission to AIWG\'s durable external route + retained ownership (#1537)', () => {
    const body = fs.readFileSync(SKILL, 'utf8');
    // Mission = dynamic orchestration via the external/durable route
    expect(body.toLowerCase()).toMatch(/external|ralph-external|mc dispatch|durable/);
    // Retained-ownership invariant — AIWG owns bookkeeping, native drives mechanism
    expect(body.toLowerCase()).toContain('activity-log');
    expect(body.toLowerCase()).toMatch(/checkpoint|resume|durab/);
    expect(body.toLowerCase()).toContain('best-output');
    // AIWG-owned, explicitly NOT the plugin-provided /workflow
    expect(body).toMatch(/not\s+the\s+plugin-provided\s+`?\/workflow`?/i);
    // Cross-stack awareness (the corrected center of gravity, #1546)
    expect(body.toLowerCase()).toContain('cross-stack');
  });
});

describe('issue-workflow commands mirror as commands (#1549)', () => {
  function readStandardSet(file: string): string {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const m = src.match(/MIRRORED_STANDARD_COMMAND_SKILLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m, `${file} should declare MIRRORED_STANDARD_COMMAND_SKILLS`).toBeTruthy();
    return m![1];
  }

  it('address-issues + issue-audit are in the standard mirror set in BOTH deploy paths', () => {
    // These skills are NOT kernel and NOT flow-*, so without an explicit entry
    // they never mirror to .opencode/command/ / .claude/commands/ (#1549).
    const tsSet = readStandardSet('src/cli/handlers/use.ts');
    const jsSet = readStandardSet('tools/agents/deploy-command-mirrors.mjs');
    for (const set of [tsSet, jsSet]) {
      expect(set).toContain("'address-issues'");
      expect(set).toContain("'issue-audit'");
    }
  });

  it('the two mirror sets stay in sync (parity guard for the duplicated declaration)', () => {
    const norm = (s: string) =>
      [...s.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
    expect(norm(readStandardSet('src/cli/handlers/use.ts')))
      .toEqual(norm(readStandardSet('tools/agents/deploy-command-mirrors.mjs')));
  });
});
