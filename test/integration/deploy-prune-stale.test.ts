/**
 * #1627 — End-to-end: a deploy prunes stale AIWG-managed agents whose source
 * was removed, while preserving operator-authored agents. Validates the
 * orchestrator wiring in tools/agents/deploy-agents.mjs (pruneStaleAiwgArtifacts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordManagedCopy } from '../helpers/managed-copy-fixture.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEPLOY_SCRIPT = path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs');
const MARKER = '<!-- aiwg:managed v0.0.0 bundled -->\n';

let target: string;
let home: string;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prune-e2e-'));
  target = path.join(base, 'project');
  home = path.join(base, 'home');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => {
  // clean both target and home (their shared parent)
  try { fs.rmSync(path.dirname(target), { recursive: true, force: true }); } catch { /* ignore */ }
});

function runDeploy(): { status: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [DEPLOY_SCRIPT, '--mode', 'sdlc', '--provider', 'claude', '--target', target, '--quiet'],
      { timeout: 60_000, cwd: REPO_ROOT, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8' },
    );
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('#1627 deploy prunes stale AIWG agents and preserves user agents', () => {
  it('removes a stale marked AIWG agent, keeps the user agent and real agents', () => {
    const agentsDir = path.join(target, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // A stale AIWG agent (carries the managed marker, but no such source ships).
    const staleName = 'zzz-removed-by-1627-agent.md';
    fs.writeFileSync(path.join(agentsDir, staleName), MARKER + '# stale agent\n');
    recordManagedCopy(path.join(agentsDir, staleName));
    // An operator-authored agent (no marker) — must survive.
    const userName = 'my-private-agent.md';
    fs.writeFileSync(path.join(agentsDir, userName), '# my private agent\n');

    const res = runDeploy();
    expect(res.status).toBe(0);

    // Stale AIWG agent pruned.
    expect(fs.existsSync(path.join(agentsDir, staleName))).toBe(false);
    // User agent preserved.
    expect(fs.existsSync(path.join(agentsDir, userName))).toBe(true);
    // A real shipped agent is present (deployed, not pruned).
    expect(fs.existsSync(path.join(agentsDir, 'software-implementer.md'))).toBe(true);
  });
});
