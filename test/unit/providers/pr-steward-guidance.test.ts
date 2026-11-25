// Exercise opt-in PR guidance through real Claude deploys using only temp project/HOME data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploy } from '../../../tools/agents/providers/claude.mjs';
import { migrateClaudeReservedSkills } from '../../../tools/agents/providers/claude-skill-names.mjs';
import { deployPrStewardGuidance, renderPrStewardGuidance } from '../../../tools/agents/providers/claude-pr-steward.mjs';
import { planDeploymentRemoval } from '../../../src/providers/deployment-removal.js';
import { resolveDelivery } from '../../../src/config/aiwg-config.js';

let root: string, project: string, home: string, file: string;
const write = (name: string, body: string) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, body); };
const receipt = () => JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.aiwg-manifest.json'), 'utf8'));
const hash = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const policy = { pr_steward_guidance: true, mode: 'pr-required', default_branch: 'trunk',
  committer: { name: 'Fixture Operator', email: 'operator@example.invalid' },
  signing: { key: 'FIXTURE_KEY', format: 'ssh', enforce: 'commits' }, force_push_policy: 'never', require_ci_green: true };
function config(delivery: object = policy, forge = 'gitea') {
  write(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1.0', providers: ['claude'], installed: {},
    delivery, remotes: { issue_provider: forge } }));
}
const run = (extra = {}) => deploy({ target: project, srcRoot: root, mode: 'all', deploySkills: true,
  contextFiles: false, attribution: false, hooks: false, quiet: true, ...extra });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-pr-steward-'));
  project = path.join(root, 'project'); home = path.join(root, 'home');
  file = path.join(project, '.claude/skills/steward/SKILL.md');
  fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
  write(path.join(root, 'agentic/code/providers/capability-matrix.yaml'), fs.readFileSync('agentic/code/providers/capability-matrix.yaml', 'utf8'));
  write(path.join(root, 'agentic/code/addons/fixture/skills/safe/SKILL.md'), '---\nname: safe\nkernel: true\n---\nSynthetic skill\n');
  vi.stubEnv('AIWG_ROOT', root); vi.stubEnv('HOME', home); vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  write(path.join(project, 'WORKSPACE.md'), fs.readFileSync('test/fixtures/providers/pr-steward/WORKSPACE.md', 'utf8'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude PR Steward guidance (#4383)', () => {
  it.each([{}, { pr_steward_guidance: false }])('keeps all deploys and refreshes off by default: %j', async delivery => {
    config(delivery);
    await run(); await run();
    for (const base of [project, home]) for (const name of ['steward', 'babysit']) {
      expect(fs.existsSync(path.join(base, '.claude/skills', name))).toBe(false);
    }
  });
  it('derives policy and declared inputs, stamps and receipts the sole guidance output, then refreshes', async () => {
    config(); await run({ deployVersion: '2026.11.9-fixture' });
    const first = fs.readFileSync(file, 'utf8');
    for (const text of ['Fixture Operator <operator@example.invalid>', 'FIXTURE_KEY', 'ssh', 'never force-push',
      'pr-required', 'trunk', 'npm run typecheck', 'npm run build:cli', '.github/workflows/', 'CHANGELOG.md',
      'Gitea', 'only git-state watching', 'Never merge', 'No AI attribution']) expect(first).toContain(text);
    expect(first).not.toContain('never infer this command');
    expect(first).not.toMatch(/Co-Authored-By:|Generated with /i);
    expect(fs.existsSync(path.join(path.dirname(file), '.aiwg-managed'))).toBe(true);
    expect(receipt().managed['SKILL.md']).toMatchObject({ hash: hash(first), kind: 'pr-steward-guidance' });
    expect(first).toContain('aiwg:managed v2026.11.9-fixture');
    expect(receipt().managed['SKILL.md'].version).toBe('2026.11.9-fixture');
    expect(fs.lstatSync(file).isFile()).toBe(true); expect(fs.statSync(file).nlink).toBe(1);
    migrateClaudeReservedSkills(path.dirname(path.dirname(file)), {});
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    config({ ...policy, mode: 'direct', force_push_policy: 'own-branch-only', committer: { name: 'Other', email: 'other@example.invalid' },
      signing: { key: 'SECOND_KEY', format: 'openpgp', enforce: 'all' } }, 'github');
    await run();
    const second = fs.readFileSync(file, 'utf8');
    for (const text of ['Other <other@example.invalid>', 'SECOND_KEY', 'openpgp', 'own-branch-only', 'direct', 'GitHub']) expect(second).toContain(text);
    expect(second).not.toContain('FIXTURE_KEY');
    expect(receipt().managed['SKILL.md'].hash).toBe(hash(second));
    expect(fs.existsSync(path.join(project, '.claude/skills/babysit'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude/skills/steward'))).toBe(false);
  });
  it('preserves unmanaged and operator-edited guidance with a notice, even under force', async () => {
    config(); write(file, 'Operator guidance');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run({ force: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('Operator guidance');
    expect(warn.mock.calls.flat().join()).toMatch(/guidance.*(untouched|skip)/i);
    fs.unlinkSync(file); await run();
    fs.appendFileSync(file, '\nOperator addition\n');
    await run({ force: true });
    expect(fs.readFileSync(file, 'utf8')).toContain('Operator addition');
    config({ pr_steward_guidance: false }); await run();
    expect(fs.readFileSync(file, 'utf8')).toContain('Operator addition');
  });
  it('disables only verified managed guidance and leaves unrelated files and receipts', async () => {
    config(); await run();
    write(path.join(path.dirname(file), 'local.txt'), 'Keep');
    write(path.join(project, '.claude/skills/babysit/SKILL.md'), 'Other operator guidance');
    config({ pr_steward_guidance: false }); await run();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(path.dirname(file), 'local.txt'), 'utf8')).toBe('Keep');
    expect(fs.readFileSync(path.join(project, '.claude/skills/babysit/SKILL.md'), 'utf8')).toBe('Other operator guidance');
    expect(fs.existsSync(path.join(path.dirname(file), '.aiwg-managed'))).toBe(false);
    await run(); expect(fs.existsSync(file)).toBe(false);
  });
  it('records normal removal ownership and disables in copy mode without restoring guidance', async () => {
    config(); await run({ copyMode: true });
    const plan = planDeploymentRemoval(project, 'claude', 'all');
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: file, action: 'remove' }));
    config({}); await run({ copyMode: true });
    expect(fs.existsSync(file)).toBe(false);
  });
  it('never emits guidance for user scope and rejects unsafe direct output locations', async () => {
    config(); await deployPrStewardGuidance(project, { scope: 'user' });
    expect(fs.existsSync(file)).toBe(false);
    await deployPrStewardGuidance(project, { userScope: true });
    expect(fs.existsSync(file)).toBe(false);
    const other = path.join(root, 'external'); fs.mkdirSync(other);
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
    fs.symlinkSync(other, path.dirname(file));
    await deployPrStewardGuidance(project);
    expect(fs.readdirSync(other)).toEqual([]);
  });
  it('omits missing inputs, does not treat tag-only signing as commit signing, and obeys dry-run', async () => {
    config({ pr_steward_guidance: true }); fs.unlinkSync(path.join(project, 'WORKSPACE.md'));
    await run({ dryRun: true }); expect(fs.existsSync(file)).toBe(false);
    await run();
    const text = fs.readFileSync(file, 'utf8');
    for (const section of ['## Verification', '## Signing', '## Off-limits']) expect(text).not.toContain(section);
    expect(text).toContain('No verification commands declared'); expect(text).toContain('No commit signing configuration declared');
    expect(text).not.toContain('npm ');
    config({ ...policy, signing: { key: 'TAG_KEY', enforce: 'tags' } }); await run();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sign every commit');
    config({ pr_steward_guidance: false }); await run({ dryRun: true }); expect(fs.existsSync(file)).toBe(true);
    await run(); expect(fs.existsSync(file)).toBe(false);
  });
  it('renders the other declared delivery policies without inventing keys, commands or a forge', () => {
    const rendered = renderPrStewardGuidance({ delivery: { mode: 'feature-branch', force_push_policy: 'allowed',
      require_ci_green: false, require_signed_commits: true, signing: { key_file: 'keys/repo.pub', program: 'fixture-signer' } },
      remotes: { issue_provider: 'local' } }, '', resolveDelivery);
    for (const text of ['feature-branch', 'Policy allowed', 'not a delivery completion requirement', 'key file keys/repo.pub',
      'fixture-signer', 'every commit must be signed', 'Local tracker']) expect(rendered).toContain(text);
    expect(rendered).not.toContain('npm ');
    expect(renderPrStewardGuidance({}, '', resolveDelivery)).toContain('Forge undeclared');
  });
  it.each(['symlink', 'hardlink', 'parent-symlink'])('preserves unsafe %s guidance locations', async kind => {
    config(); const outside = path.join(root, 'operator'); write(outside, 'Operator file');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (kind === 'symlink') fs.symlinkSync(outside, file);
    else if (kind === 'hardlink') fs.linkSync(outside, file);
    else { const other = path.join(root, 'external'); fs.mkdirSync(other); fs.rmdirSync(path.dirname(file)); fs.symlinkSync(other, path.dirname(file)); }
    await run({ force: true }); expect(fs.readFileSync(outside, 'utf8')).toBe('Operator file');
    expect(fs.existsSync(path.join(home, '.claude/skills/steward'))).toBe(false);
  });
  it('runs the deployment CLI offline against temp HOME and refreshes the same managed file', () => {
    config();
    const args = ['--import', 'tsx', 'tools/agents/deploy-agents.mjs', '--source', path.join(root, 'agentic/code/addons/fixture'),
      '--target', project, '--provider', 'claude', '--skills-only', '--no-context-files'];
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AIWG_RESOLVE_IMPL_FROM: 'src' };
    execFileSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
    expect(fs.readFileSync(file, 'utf8')).toContain('FIXTURE_KEY');
    config({ pr_steward_guidance: false });
    execFileSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
    expect(fs.existsSync(file)).toBe(false);
  }, 130_000);
});
