/**
 * Integration: project-local bundle deploy / remove (#1046)
 *
 * Drives `tools/agents/deploy-agents.mjs` against a synthesized project-local
 * bundle exactly the way `deployOneProjectLocalBundle` in `src/cli/handlers/use.ts`
 * does. Asserts that the bundle's source artifacts land at the provider's
 * deploy paths, and that re-running with no source removes them (revert).
 *
 * Covers matrix rows DP-1..DP-5 and R-1..R-3 from #1046.
 *
 * @see .aiwg/testing/test-strategy-project-local.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEPLOY_SCRIPT = path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs');
const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROJECT_LOCAL_PATHS',
] as const;

interface Env {
  projectDir: string;
  homeDir: string;
  bundleDir: string;
}

function runAiwg(env: Env, args: string[]): { stdout: string; status: number } {
  const aiwgBin = path.join(REPO_ROOT, 'bin/aiwg.mjs');
  try {
    const stdout = execFileSync(process.execPath, [aiwgBin, ...args], {
      cwd: env.projectDir,
      env: { ...projectLocalTestEnv(env), AIWG_ROOT: REPO_ROOT },
      encoding: 'utf-8',
      timeout: 180_000,
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

function makePluginWrapperEnv(label: string): Env {
  const env = makeEnv(label);
  const wrapper = path.join(env.projectDir, '.aiwg', 'plugins', 'bt6-maintainer');
  const payload = path.join(wrapper, 'payload');
  mkdirSync(payload, { recursive: true });
  writeFileSync(path.join(wrapper, 'manifest.json'), JSON.stringify({
    id: 'bt6-maintainer',
    type: 'plugin',
    name: 'BT6 Maintainer',
    version: '1.0.0',
    description: 'Wrapper round-trip fixture',
    manifestVersion: '1',
    platforms: { claude: 'full', codex: 'full' },
    keywords: ['test'],
    deployment: { pathTemplate: '.aiwg/plugins/bt6-maintainer' },
    pluginConfig: { payloadType: 'addon', payloadPath: 'payload/' },
  }, null, 2));
  writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify({
    id: 'bt6-maintainer-core',
    type: 'addon',
    name: 'BT6 Maintainer Core',
    version: '1.0.0',
    description: 'Wrapper payload fixture',
    manifestVersion: '1',
    platforms: { claude: 'full', codex: 'full' },
    keywords: ['test'],
    deployment: { pathTemplate: '.aiwg/addons/bt6-maintainer-core' },
    addonConfig: { entry: { agents: 'agents/', skills: 'skills/', rules: 'rules/' } },
  }, null, 2));
  mkdirSync(path.join(payload, 'agents'), { recursive: true });
  mkdirSync(path.join(payload, 'rules'), { recursive: true });
  writeFileSync(path.join(payload, 'agents', 'bt6-agent.md'), `---\nname: bt6-agent\ndescription: Wrapper agent\nmodel: claude-sonnet-4-6\ntools: Read\n---\n\n# Agent\n`);
  writeFileSync(path.join(payload, 'rules', 'bt6-rule.md'), `---\nid: bt6-rule\nname: bt6-rule\n---\n\n# Rule\n`);
  const skills = [
    ['bt6-issue-steward', ['templates/bt6-issue-response.md', 'templates/bt6-maintainer-action-items.md']],
    ['bt6-merge-train', ['templates/bt6-merge-train-report.md']],
    ['bt6-pr-audit', ['templates/bt6-public-input-threat-assessment.md', 'templates/bt6-pr-audit-review.md']],
    ['bt6-provider-review', ['references/bt6-provider-integration-checklist.md', 'templates/bt6-external-provider-assessment.md']],
    ['bt6-queue-audit', ['templates/bt6-public-input-threat-assessment.md', 'templates/bt6-queue-audit-report.md']],
  ] as const;
  mkdirSync(path.join(payload, 'templates'), { recursive: true });
  for (const [, refs] of skills) {
    for (const ref of refs.filter(value => value.startsWith('templates/'))) {
      const file = path.join(payload, ref);
      if (!existsSync(file)) writeFileSync(file, `# ${path.basename(ref)}\n`);
    }
  }
  for (const [name, refs] of skills) {
    mkdirSync(path.join(payload, 'skills', name), { recursive: true });
    for (const ref of refs.filter(value => value.startsWith('references/'))) {
      const file = path.join(payload, 'skills', name, ref);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `# ${path.basename(ref)}\n`);
    }
    writeFileSync(path.join(payload, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Wrapper skill ${name}\nplatforms: [all]\n---\n\n# ${name}\n\n${refs.map(ref => `Use \`${ref}\`.`).join('\n')}\n`);
  }
  rmSync(env.bundleDir, { recursive: true, force: true });
  return { ...env, bundleDir: payload };
}

/**
 * Project-local extension whose SKILL.md references a *directory* of support
 * assets rather than individual files (#2503).
 */
function makeDirectoryAssetEnv(label: string): Env {
  const base = mkdtempSync(path.join(os.tmpdir(), `aiwg-pl-dirasset-${label}-`));
  const projectDir = path.join(base, 'project');
  const homeDir = path.join(base, 'home');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const bundleDir = path.join(projectDir, '.aiwg', 'extensions', 'dir-asset-ext');
  const skillDir = path.join(bundleDir, 'skills', 'dir-asset-skill');
  mkdirSync(path.join(skillDir, 'templates', 'pack', 'nested'), { recursive: true });
  mkdirSync(path.join(skillDir, 'scripts', 'bin'), { recursive: true });

  writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      id: 'dir-asset-ext',
      type: 'extension',
      name: 'Dir Asset Ext',
      version: '1.0.0',
      description: 'Extension referencing a directory-valued support asset.',
      manifestVersion: '1',
      platforms: { claude: 'full', codex: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    }, null, 2),
  );
  writeFileSync(path.join(skillDir, 'templates', 'pack', 'a.md'), '# A\n');
  writeFileSync(path.join(skillDir, 'templates', 'pack', 'nested', 'b.md'), '# B\n');
  writeFileSync(path.join(skillDir, 'scripts', 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
  chmodSync(path.join(skillDir, 'scripts', 'bin', 'run.sh'), 0o755);
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: dir-asset-skill\ndescription: Skill referencing a directory-valued support asset.\nplatforms: [all]\n---\n\n'
    + '# Dir Asset Skill\n\n## Resources\n\n- `templates/pack/`: a directory of templates.\n- `scripts/bin/`: a directory of scripts.\n',
  );

  return { projectDir, homeDir, bundleDir };
}

function makeEnv(label: string): Env {
  const base = mkdtempSync(path.join(os.tmpdir(), `aiwg-pl-deploy-${label}-`));
  const projectDir = path.join(base, 'project');
  const homeDir = path.join(base, 'home');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  // Project-local extension bundle with one agent + one rule + one skill.
  const bundleDir = path.join(projectDir, '.aiwg', 'extensions', 'pl-test');
  mkdirSync(path.join(bundleDir, 'agents'), { recursive: true });
  mkdirSync(path.join(bundleDir, 'rules'), { recursive: true });
  mkdirSync(path.join(bundleDir, 'skills', 'demo-skill'), { recursive: true });

  writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      id: 'pl-test',
      type: 'extension',
      name: 'PL Test',
      version: '1.0.0',
      description: 'Integration test bundle',
      manifestVersion: '1',
      platforms: { claude: 'full', cursor: 'full', factory: 'full', codex: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/rules/{id}.md' },
    }, null, 2),
  );

  writeFileSync(
    path.join(bundleDir, 'agents', 'pl-agent.md'),
    `---\nname: PL Agent\ndescription: Agent from project-local bundle\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n---\n\n# PL Agent\n`,
  );

  writeFileSync(
    path.join(bundleDir, 'rules', 'pl-rule.md'),
    `---\nid: pl-rule\nname: pl-rule\n---\n\n# PL Rule\n`,
  );

  writeFileSync(
    path.join(bundleDir, 'skills', 'demo-skill', 'SKILL.md'),
    `---\nname: demo-skill\ndescription: Demo skill from project-local bundle\n---\n\n# Demo Skill\n`,
  );

  return { projectDir, homeDir, bundleDir };
}

function runDeploy(env: Env, provider: string, extra: string[] = []): { stdout: string; status: number } {
  if (!extra.includes("--copy-all")) extra = [...extra, "--copy-all"];
  const args = [
    DEPLOY_SCRIPT,
    '--source', env.bundleDir,
    '--deploy-commands', '--deploy-skills', '--deploy-rules',
    '--provider', provider,
    '--target', env.projectDir,
    '--skip-commands-migration',
    ...extra,
  ];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env: projectLocalTestEnv(env),
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '') + (e.stderr || ''), status: e.status ?? 1 };
  }
}

function projectLocalTestEnv(env: Env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir };
  for (const key of ARTIFACT_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

function cleanup(env: Env): void {
  try {
    rmSync(path.dirname(env.projectDir), { recursive: true, force: true });
  } catch { /* noop */ }
}

describe('project-local deploy integration (#1046)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv('main');
  });

  afterEach(() => {
    cleanup(env);
  });

  it.each(['relative', 'absolute'])('indexes external bundle sources in a nested member via %s roots (#2308)', (source) => {
    const memberDir = path.join(env.projectDir, 'member');
    const member = { ...env, projectDir: memberDir };
    mkdirSync(path.join(memberDir, '.aiwg'), { recursive: true });
    const externalRoot = path.join(env.projectDir, '.aiwg');
    writeFileSync(path.join(memberDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['codex'], installed: {}, scripts: {},
      projectLocal: { searchPaths: [source === 'relative' ? '../.aiwg' : externalRoot] },
    }));
    // Unrelated parent artifacts do not belong in the member's surface.
    const unrelated = path.join(externalRoot, 'unrelated.md');
    writeFileSync(unrelated, '# Unrelated parent artifact\n');
    expect(existsSync(path.join(memberDir, '.aiwg', '.index'))).toBe(false);

    const deployed = runAiwg(member, ['use', 'pl-test', '--provider', 'codex', '--json']);
    expect(deployed.status, deployed.stdout).toBe(0);
    expect(deployed.stdout).not.toContain('index-surface-missing:project');
    expect(existsSync(path.join(memberDir, '.codex', 'agents', 'pl-agent.toml'))).toBe(true);
    const quickref = path.join(memberDir, '.agents', 'skills', 'aiwg-project-member-quickref', 'SKILL.md');
    expect(existsSync(quickref), deployed.stdout).toBe(true);
    expect(readFileSync(quickref, 'utf-8')).toContain('aiwg show agent PL Agent');

    const rebuilt = runAiwg(member, ['index', 'build', '--graph', 'project']);
    expect(rebuilt.status, rebuilt.stdout).toBe(0);
    const metadata = JSON.parse(readFileSync(path.join(memberDir, '.aiwg', '.index', 'project', 'metadata.json'), 'utf-8'));
    expect(metadata.entries[path.join(env.bundleDir, 'agents', 'pl-agent.md')]).toMatchObject({ type: 'agent' });
    expect(Object.keys(metadata.entries).some(file => /unrelated|escaped/.test(file))).toBe(false);
    for (const backend of [[], ['--backend', 'local']]) {
      const discovery = runAiwg(member, ['discover', 'pl-agent', '--json', ...backend]);
      expect(discovery.status, discovery.stdout).toBe(0);
      expect(JSON.parse(discovery.stdout).results).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent', name: 'PL Agent', provenance: { graph: 'project', scope: 'project' } }),
      ]));
      const shown = runAiwg(member, ['show', 'agent', 'PL Agent', '--json', ...backend]);
      expect(shown.status, shown.stdout).toBe(0);
      expect(shown.stdout).toContain('Agent from project-local bundle');
    }
  }, 180_000);

  it.each([
    ['use', ['use', 'sdlc', '--provider', 'claude', '--quiet']],
    ['refresh', ['refresh', '--skip-update', '--provider', 'claude', '--quiet']],
    ['upgrade', ['upgrade', '--skip-check', '--provider', 'claude']],
  ])('%s synchronizes existing project-local skills without a project cache (#2155)', (_command, args) => {
    // Model an established workspace whose bundles predate the Fortemi cache.
    // No scaffold command or named local install has populated its index.
    writeFileSync(path.join(env.projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1',
      providers: ['claude'],
      installed: { sdlc: {
        version: '1.0', source: 'bundled', installedAt: '2026-01-01T00:00:00Z',
        deployedTo: { claude: { agents: 0, commands: 0, skills: 0, rules: 0 } },
      } },
    }));
    mkdirSync(path.join(env.projectDir, '.aiwg', 'frameworks'), { recursive: true });
    writeFileSync(path.join(env.projectDir, '.aiwg', 'frameworks', 'registry.json'), JSON.stringify({
      version: '1.0',
      frameworks: [{ id: 'sdlc-complete', installed: '2026-01-01', version: '1.0' }],
    }));
    const cache = path.join(env.projectDir, '.aiwg', '.index', 'fortemi-core', 'project', 'aiwg-fortemi-index-v2.json');
    expect(existsSync(cache)).toBe(false);

    const result = runAiwg(env, args);

    expect(result.status, result.stdout).toBe(0);
    expect(existsSync(cache), result.stdout).toBe(true);
    const exported = JSON.parse(readFileSync(cache, 'utf8'));
    expect(exported.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demo-skill' }),
    ]));
  }, 180_000);

  it('automatic local reconciliation leaves the project cache absent on dry-run (#2155)', () => {
    writeFileSync(path.join(env.projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['claude'] }));
    const result = runAiwg(env, ['use', 'sdlc', '--provider', 'claude', '--dry-run', '--quiet']);
    expect(result.status, result.stdout).toBe(0);
    expect(existsSync(path.join(env.projectDir, '.aiwg', '.index', 'fortemi-core', 'project'))).toBe(false);
  }, 180_000);

  it('bootstraps a managed quickref preview from bundles with zero dry-run writes', () => {
    writeFileSync(
      path.join(env.projectDir, '.aiwg', 'aiwg.config'),
      JSON.stringify({ version: '1', providers: ['codex'], installed: {}, scripts: {} }, null, 2),
    );
    const result = runAiwg(env, ['quickref', 'generate', '--project', '--dry-run']);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('aiwg-project-project-quickref');
    expect(result.stdout).toContain('aiwg show skill demo-skill');
    expect(existsSync(path.join(env.projectDir, '.aiwg', 'generated', 'project-quickref'))).toBe(false);
  });

  it('DP-1: deploys a project-local bundle to .claude/ paths', () => {
    const result = runDeploy(env, 'claude');
    expect(result.status).toBe(0);

    // Per-type provider paths verified. Skills live under .claude/.aiwg/skills/
    // for Claude (#1212 — index-driven discovery to side-step the platform's
    // flat-namespace skill-listing budget). Rules stay platform-native.
    const ruleFile = path.join(env.projectDir, '.claude', 'rules', 'pl-rule.md');
    const skillFile = path.join(env.projectDir, '.claude', '.aiwg', 'skills', 'demo-skill', 'SKILL.md');
    expect(existsSync(ruleFile), `rule should exist at ${ruleFile}`).toBe(true);
    expect(existsSync(skillFile), `skill should exist at ${skillFile}`).toBe(true);
  });

  it('DP-2: deploys to a second provider (cursor) with same bundle', () => {
    const result = runDeploy(env, 'cursor');
    expect(result.status).toBe(0);

    const ruleFile = path.join(env.projectDir, '.cursor', 'rules', 'pl-rule.md');
    const skillFile = path.join(env.projectDir, '.cursor', '.aiwg', 'skills', 'demo-skill', 'SKILL.md');
    // Cursor uses .mdc rule extension via translation; either .md or .mdc may
    // appear depending on deploy-agents.mjs version. Accept either.
    const ruleAlt = path.join(env.projectDir, '.cursor', 'rules', 'pl-rule.mdc');
    expect(existsSync(ruleFile) || existsSync(ruleAlt), `cursor rule should exist at ${ruleFile} or ${ruleAlt}`).toBe(true);
    expect(existsSync(skillFile), `cursor skill should exist at ${skillFile}`).toBe(true);
  });

  it('DP-3: --dry-run does not write provider files', () => {
    const result = runDeploy(env, 'claude', ['--dry-run']);
    expect(result.status).toBe(0);

    const ruleFile = path.join(env.projectDir, '.claude', 'rules', 'pl-rule.md');
    expect(existsSync(ruleFile), 'dry-run must not write').toBe(false);
  });

  it('DP-4: deploys to two providers in sequence (multi-provider)', () => {
    expect(runDeploy(env, 'claude').status).toBe(0);
    expect(runDeploy(env, 'cursor').status).toBe(0);

    expect(existsSync(path.join(env.projectDir, '.claude', 'rules', 'pl-rule.md'))).toBe(true);
    const cursorRule = path.join(env.projectDir, '.cursor', 'rules', 'pl-rule.md');
    const cursorRuleAlt = path.join(env.projectDir, '.cursor', 'rules', 'pl-rule.mdc');
    expect(existsSync(cursorRule) || existsSync(cursorRuleAlt)).toBe(true);
  });

  // #124: factory.mjs and codex.mjs must honor the isAddonSource short-circuit
  // so project-local bundles deploy their agents + rules (previously 0/0).
  it('DP-FACTORY (#124): deploys project-local agent + rule to .factory/ paths', () => {
    const result = runDeploy(env, 'factory');
    expect(result.status, result.stdout).toBe(0);

    const agentFile = path.join(env.projectDir, '.factory', 'droids', 'pl-agent.md');
    const ruleFile = path.join(env.projectDir, '.factory', 'rules', 'pl-rule.md');
    expect(existsSync(agentFile), `factory agent should exist at ${agentFile}`).toBe(true);
    expect(existsSync(ruleFile), `factory rule should exist at ${ruleFile}`).toBe(true);
  });

  it('DP-CODEX (#124): deploys project-local agent + rule to .codex/ paths', () => {
    const result = runDeploy(env, 'codex');
    expect(result.status, result.stdout).toBe(0);

    const agentFile = path.join(env.projectDir, '.codex', 'agents', 'pl-agent.toml');
    const skillFile = path.join(env.projectDir, '.agents', 'skills', 'demo-skill', 'SKILL.md');
    const ruleFile = path.join(env.projectDir, '.codex', 'rules', 'pl-rule.md');
    expect(existsSync(agentFile), `codex agent should exist at ${agentFile}`).toBe(true);
    expect(existsSync(skillFile), `codex skill should exist at ${skillFile}`).toBe(true);
    expect(existsSync(ruleFile), `codex rule should exist at ${ruleFile}`).toBe(true);
  });

  // #123: deploying a project-local bundle WITHOUT AIWG_ROOT must not empty the
  // provider's kernel skill directory. computeAllKernelNames returns null when
  // no AIWG framework/addon tree is locatable, and pruneStaleAiwgSkills skips
  // pruning rather than treating the empty set as "delete every AIWG skill".
  it('KERNEL-SAFE (#123): project-local deploy without AIWG_ROOT preserves existing kernel skills', () => {
    // Pre-seed an AIWG-managed kernel skill in the provider's kernel dir.
    const kernelDir = path.join(env.projectDir, '.claude', 'skills', 'preexisting-kernel');
    mkdirSync(kernelDir, { recursive: true });
    writeFileSync(
      path.join(kernelDir, 'SKILL.md'),
      `---\nnamespace: aiwg\nname: preexisting-kernel\ndescription: A pre-existing AIWG-managed kernel skill\n---\n\n# Preexisting Kernel\n`,
    );
    writeFileSync(path.join(kernelDir, '.aiwg-managed'), '');

    // Deploy the project-local bundle with AIWG_ROOT explicitly unset so the
    // walk-up cannot find the repo tree (the bug scenario from #123).
    const args = [
      DEPLOY_SCRIPT,
      '--source', env.bundleDir,
      '--deploy-commands', '--deploy-skills', '--deploy-rules',
      '--provider', 'claude',
      '--target', env.projectDir,
      '--skip-commands-migration',
      '--copy-all',
    ];
    let status = 0;
    let out = '';
    try {
      // AIWG_ROOT unset + --source under the project's .aiwg/ tree means
      // computeAllKernelNames walks up from the bundle path, finds no
      // agentic/code/{frameworks,addons}, and returns null → prune skipped.
      const cleanEnv = projectLocalTestEnv(env);
      delete cleanEnv.AIWG_ROOT;
      out = execFileSync(process.execPath, args, {
        cwd: REPO_ROOT,
        env: cleanEnv,
        encoding: 'utf-8',
        timeout: 120_000,
      });
    } catch (e: any) {
      status = e.status ?? 1;
      out = (e.stdout || '') + (e.stderr || '');
    }

    expect(status, out).toBe(0);
    // The pre-existing AIWG-managed kernel skill must survive — it was NOT in
    // the bundle, and with no resolvable AIWG root the prune must be skipped.
    expect(
      existsSync(path.join(kernelDir, 'SKILL.md')),
      'pre-existing kernel skill must not be pruned when AIWG_ROOT is unresolvable',
    ).toBe(true);
  });

  it('R-3: source bundle under .aiwg/ is preserved after deploy', () => {
    expect(runDeploy(env, 'claude').status).toBe(0);

    // The source under .aiwg/extensions/pl-test/ must remain intact
    expect(existsSync(path.join(env.bundleDir, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(env.bundleDir, 'rules', 'pl-rule.md'))).toBe(true);
    expect(existsSync(path.join(env.bundleDir, 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);
  });

  it('R-1/R-2: removing the deployed rule and re-running keeps idempotent state', () => {
    expect(runDeploy(env, 'claude').status).toBe(0);
    const ruleFile = path.join(env.projectDir, '.claude', 'rules', 'pl-rule.md');
    expect(existsSync(ruleFile)).toBe(true);

    // Operator removes the deployed file out-of-band; re-running deploy should
    // restore it (idempotent), proving deploy itself is safe to re-run.
    rmSync(ruleFile, { force: true });
    expect(existsSync(ruleFile)).toBe(false);

    expect(runDeploy(env, 'claude').status).toBe(0);
    expect(existsSync(ruleFile), 'deploy is idempotent — restores missing file').toBe(true);
  });

  // #1228 follow-up: `aiwg use` must invoke deploy-agents.mjs with --copy-all
  // for project-local bundles. The default deploy mode (#1217) is no-copy +
  // index-driven discovery, which assumes upstream skills at $AIWG_ROOT.
  // Project-local bundles live under the project's .aiwg/ tree and aren't in
  // the framework graph, so without --copy-all their skills never reach the
  // standard-tier sequestered path and become unreachable from both the
  // platform and the index.
  it('PL-COPY-ALL: project-local skills land at <provider>/.aiwg/skills/ via aiwg use', () => {
    const aiwgBin = path.join(REPO_ROOT, 'bin/aiwg.mjs');

    // Minimal aiwg.config so `aiwg use` doesn't try to run init wizard
    writeFileSync(
      path.join(env.projectDir, '.aiwg', 'aiwg.config'),
      JSON.stringify({ providers: ['claude'] }, null, 2),
    );
    writeFileSync(
      path.join(env.projectDir, '.aiwg', 'quickref.json'),
      JSON.stringify({
        version: '1',
        project: {
          id: 'integration-project',
          name: 'Integration Project',
          description: 'Project-specific integration test orientation.',
        },
        precedence: 'Use the project workflow before generic workflows.',
        entries: [{
          title: 'Issue workflow',
          summary: 'Retrieve the project issue workflow before acting.',
          discover: ['project issue workflow'],
          show: [{ type: 'skill', name: 'demo-skill' }],
        }],
      }, null, 2),
    );

    let result: { status: number; stdout: string };
    try {
      const stdout = execFileSync(
        process.execPath,
        [aiwgBin, 'use', 'sdlc', '--provider', 'claude', '--quiet'],
        {
          cwd: env.projectDir,
          env: {
            ...projectLocalTestEnv(env),
            AIWG_ROOT: REPO_ROOT,
          },
          encoding: 'utf-8',
          timeout: 180_000,
        },
      );
      result = { status: 0, stdout };
    } catch (e: any) {
      result = { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
    }

    expect(result.status, `aiwg use stdout:\n${result.stdout}`).toBe(0);

    // The project-local bundle's skill must land at the standard-tier
    // sequestered path — this is what was broken before the fix.
    const projectLocalSkill = path.join(
      env.projectDir,
      '.claude',
      '.aiwg',
      'skills',
      'demo-skill',
      'SKILL.md',
    );
    expect(
      existsSync(projectLocalSkill),
      `project-local skill must deploy to ${projectLocalSkill}`,
    ).toBe(true);

    // And the bundle's rule must still land alongside platform rules.
    const projectLocalRule = path.join(
      env.projectDir,
      '.claude',
      'rules',
      'pl-rule.md',
    );
    expect(existsSync(projectLocalRule)).toBe(true);

    const projectQuickref = path.join(
      env.projectDir,
      '.claude',
      'skills',
      'aiwg-project-integration-project-quickref',
      'SKILL.md',
    );
    expect(existsSync(projectQuickref), 'aiwg use must refresh the project quickref kernel skill').toBe(true);
  }, 180_000);

  it('PL-CODEX (#766): aiwg use deploys project-local addon skills to .agents/skills and records deployed counts', () => {
    const aiwgBin = path.join(REPO_ROOT, 'bin/aiwg.mjs');

    writeFileSync(
      path.join(env.projectDir, '.aiwg', 'aiwg.config'),
      JSON.stringify({ providers: ['codex'] }, null, 2),
    );

    let result: { status: number; stdout: string };
    try {
      const stdout = execFileSync(
        process.execPath,
        [aiwgBin, 'use', 'pl-test', '--provider', 'codex', '--quiet'],
        {
          cwd: env.projectDir,
          env: {
            ...projectLocalTestEnv(env),
            AIWG_ROOT: REPO_ROOT,
          },
          encoding: 'utf-8',
          timeout: 180_000,
        },
      );
      result = { status: 0, stdout };
    } catch (e: any) {
      result = { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
    }

    expect(result.status, `aiwg use stdout:\n${result.stdout}`).toBe(0);

    const codexSkill = path.join(env.projectDir, '.agents', 'skills', 'demo-skill', 'SKILL.md');
    expect(existsSync(codexSkill), `project-local Codex skill must deploy to ${codexSkill}`).toBe(true);
    const managedQuickref = path.join(
      env.projectDir,
      '.agents',
      'skills',
      'aiwg-project-project-quickref',
      'SKILL.md',
    );
    expect(existsSync(managedQuickref), 'bundle-only project should receive a managed project quickref').toBe(true);

    const legacyStandardSkill = path.join(env.projectDir, '.codex', '.aiwg', 'skills', 'demo-skill', 'SKILL.md');
    expect(existsSync(legacyStandardSkill), 'Codex project-local skill should use the native .agents/skills discovery path').toBe(false);

    const config = JSON.parse(readFileSync(path.join(env.projectDir, '.aiwg', 'aiwg.config'), 'utf-8'));
    expect(config.installed?.['pl-test']?.deployedTo?.codex?.skills).toBe(1);
    // Spawns a real `aiwg use`; the default 5s budget is not enough under load.
  }, 180_000);

  it.each([
    ['claude', false],
    ['codex', false],
    ['claude', true],
    ['codex', true],
  ] as const)(
    'PL-REMOVE (#1998): %s %s deployment immediately removes pristine transformed skills',
    (provider, wrapper) => {
      const roundTripEnv = wrapper ? makePluginWrapperEnv(`${provider}-wrapper`) : makeEnv(`${provider}-direct`);
      try {
        writeFileSync(
          path.join(roundTripEnv.projectDir, '.aiwg', 'aiwg.config'),
          JSON.stringify({ version: '1', providers: [provider], installed: {}, scripts: {} }, null, 2),
        );
        const bundleId = wrapper ? 'bt6-maintainer' : 'pl-test';
        const use = runAiwg(roundTripEnv, ['use', bundleId, '--provider', provider, '--quiet']);
        expect(use.status, use.stdout).toBe(0);

        const configAfterUse = JSON.parse(readFileSync(path.join(roundTripEnv.projectDir, '.aiwg', 'aiwg.config'), 'utf-8'));
        expect(configAfterUse.installed[bundleId].deployedArtifactHashes[provider]).toBeDefined();

        const remove = runAiwg(roundTripEnv, ['remove', bundleId]);
        expect(remove.status, remove.stdout).toBe(0);
        expect(remove.stdout).not.toContain('[mutated]');

        const skillRoot = provider === 'codex'
          ? path.join(roundTripEnv.projectDir, '.agents', 'skills')
          : path.join(roundTripEnv.projectDir, '.claude', '.aiwg', 'skills');
        const skills = wrapper
          ? ['bt6-issue-steward', 'bt6-merge-train', 'bt6-pr-audit', 'bt6-provider-review', 'bt6-queue-audit']
          : ['demo-skill'];
        for (const skill of skills) {
          expect(existsSync(path.join(skillRoot, skill, 'SKILL.md'))).toBe(false);
        }
        const configAfterRemove = JSON.parse(readFileSync(path.join(roundTripEnv.projectDir, '.aiwg', 'aiwg.config'), 'utf-8'));
        expect(configAfterRemove.installed?.[bundleId]).toBeUndefined();
      } finally {
        cleanup(roundTripEnv);
      }
    },
    240_000,
  );

  it('PL-DIRASSET (#2503): deploys directory-valued support asset references recursively', () => {
    const dirEnv = makeDirectoryAssetEnv('claude');
    try {
      writeFileSync(path.join(dirEnv.projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['claude'], installed: {}, scripts: {},
      }, null, 2));

      const deploy = runAiwg(dirEnv, ['use', 'dir-asset-ext', '--provider', 'claude', '--quiet']);
      // A directory that exists on disk is not a missing asset — rejecting it
      // aborted the whole bundle deploy with a WARN and exit 1.
      expect(deploy.stdout).not.toMatch(/missing skill support asset/);
      expect(deploy.status, deploy.stdout).toBe(0);

      const skillRoot = path.join(dirEnv.projectDir, '.claude', '.aiwg', 'skills', 'dir-asset-skill');
      expect(existsSync(path.join(skillRoot, 'SKILL.md'))).toBe(true);
      for (const ref of ['templates/pack/a.md', 'templates/pack/nested/b.md', 'scripts/bin/run.sh']) {
        expect(existsSync(path.join(skillRoot, ref)), `missing deployed asset: ${ref}`).toBe(true);
      }
      // Executable bits survive the recursive copy the same way they do for
      // single-file references.
      expect(statSync(path.join(skillRoot, 'scripts', 'bin', 'run.sh')).mode & 0o111).not.toBe(0);
    } finally {
      cleanup(dirEnv);
    }
  }, 240_000);

  it('PL-ASSETS (#2109): deploys every referenced BT6 asset and repairs drift', () => {
    const bt6 = makePluginWrapperEnv('codex-assets');
    try {
      writeFileSync(path.join(bt6.projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['codex'], installed: {}, scripts: {},
      }, null, 2));
      const first = runAiwg(bt6, ['use', 'bt6-maintainer', '--provider', 'codex', '--quiet']);
      expect(first.status, first.stdout).toBe(0);
      const root = path.join(bt6.projectDir, '.agents', 'skills');
      const expected = [
        ['bt6-issue-steward', 'templates/bt6-issue-response.md'],
        ['bt6-issue-steward', 'templates/bt6-maintainer-action-items.md'],
        ['bt6-merge-train', 'templates/bt6-merge-train-report.md'],
        ['bt6-pr-audit', 'templates/bt6-public-input-threat-assessment.md'],
        ['bt6-pr-audit', 'templates/bt6-pr-audit-review.md'],
        ['bt6-provider-review', 'references/bt6-provider-integration-checklist.md'],
        ['bt6-provider-review', 'templates/bt6-external-provider-assessment.md'],
        ['bt6-queue-audit', 'templates/bt6-public-input-threat-assessment.md'],
        ['bt6-queue-audit', 'templates/bt6-queue-audit-report.md'],
      ];
      for (const [skill, ref] of expected) {
        const deployed = path.join(root, skill, ref);
        expect(existsSync(deployed), `missing deployed support asset: ${skill}/${ref}`).toBe(true);
      }

      const drifted = path.join(root, 'bt6-merge-train', 'templates', 'bt6-merge-train-report.md');
      rmSync(drifted);
      const repair = runAiwg(bt6, ['use', 'bt6-maintainer', '--provider', 'codex', '--quiet']);
      expect(repair.status, repair.stdout).toBe(0);
      expect(existsSync(drifted)).toBe(true);
    } finally {
      cleanup(bt6);
    }
  }, 240_000);
});
