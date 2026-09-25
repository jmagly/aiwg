import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  providerNeedsCommands,
  providerUsesSkillsNatively,
} from '../../src/plugin/skill-command-translator.js';

const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'aiwg-kernel-conformance-'));

const PROVIDERS = [
  { id: 'claude', root: (project: string) => join(project, '.claude/skills'), standardRoot: (project: string) => join(project, '.claude/.aiwg/skills') },
  { id: 'codex', root: (project: string) => join(project, '.agents/skills'), standardRoot: (project: string) => join(project, '.agents/skills') },
  { id: 'copilot', root: (project: string) => join(project, '.github/skills'), standardRoot: (project: string) => join(project, '.github/.aiwg/skills') },
  { id: 'cursor', root: (project: string) => join(project, '.cursor/skills'), standardRoot: (project: string) => join(project, '.cursor/.aiwg/skills') },
  { id: 'factory', root: (project: string) => join(project, '.factory/skills'), standardRoot: (project: string) => join(project, '.factory/.aiwg/skills') },
  { id: 'opencode', root: (project: string) => join(project, '.opencode/skill'), standardRoot: (project: string) => join(project, '.opencode/.aiwg/skill') },
  { id: 'warp', root: (project: string) => join(project, '.warp/skills'), standardRoot: (project: string) => join(project, '.warp/.aiwg/skills') },
  { id: 'windsurf', root: (project: string) => join(project, '.windsurf/skills'), standardRoot: (project: string) => join(project, '.windsurf/.aiwg/skills') },
  { id: 'grokbot', root: (_project: string, home: string) => join(home, 'configured-grokbot-skills'), standardRoot: (_project: string, home: string) => join(home, 'configured-grokbot-skills/.aiwg/skills') },
  { id: 'hermes', root: (_project: string, home: string) => join(home, '.hermes/skills'), standardRoot: (_project: string, home: string) => join(home, '.hermes/skills/.aiwg') },
  { id: 'openclaw', root: (_project: string, home: string) => join(home, '.openclaw/skills/aiwg'), standardRoot: (_project: string, home: string) => join(home, '.openclaw/.aiwg/skills') },
  { id: 'openhuman', root: (_project: string, home: string) => join(home, '.openhuman/skills'), standardRoot: (_project: string, home: string) => join(home, '.openhuman/.aiwg/skills') },
  { id: 'pi', root: (project: string) => join(project, '.agents/skills'), standardRoot: (project: string) => join(project, '.pi/.aiwg/skills') },
  // #236: Muse Code — project skills live at the Muse-native `.agents/skills`
  // root (ADR skill roots table); the opt-in standard tier mirrors to
  // `.agents/.aiwg/skills` (project scope only, never the user XDG root).
  { id: 'muse', root: (project: string) => join(project, '.agents/skills'), standardRoot: (project: string) => join(project, '.agents/.aiwg/skills') },
] as const;

function skillDirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .map(name => join(parent, name))
      .filter(candidate => statSync(candidate).isDirectory())
      .filter(candidate => {
        try {
          return statSync(join(candidate, 'SKILL.md')).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function canonicalKernelNames(): string[] {
  const codeRoot = join(REPO_ROOT, 'agentic/code');
  const containers = ['frameworks', 'addons'];
  const names = new Set<string>();

  for (const container of containers) {
    const root = join(codeRoot, container);
    for (const bundle of readdirSync(root)) {
      for (const skillDir of skillDirs(join(root, bundle, 'skills'))) {
        const source = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
        if (/^kernel:\s*true\s*$/m.test(source)) {
          names.add(skillDir.split('/').at(-1)!);
        }
      }
    }
  }
  return [...names].sort();
}

const EXPECTED_KERNEL = canonicalKernelNames();
const CODEX_LISTING_CHAR_CAP = 8_000;

function codexListingStats(root: string): { count: number; totalChars: number } {
  let count = 0;
  let totalChars = 0;

  for (const dir of skillDirs(root)) {
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const name = frontmatter.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const description = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1];

    expect(name, `${dir} name`).toBeTruthy();
    expect(description, `${dir} description`).toBeTruthy();
    expect(description!.length, `${dir} description`).toBeGreaterThan(10);

    totalChars += name!.length + description!.length + 5;
    count += 1;
  }

  return { count, totalChars };
}

function deploy(
  provider: string,
  options: { copyAll?: boolean; dryRun?: boolean; suffix?: string } = {},
): { project: string; home: string } {
  const suffix = options.suffix ? `-${options.suffix}` : '';
  const project = join(TEST_ROOT, `${provider}${suffix}-project`);
  const home = join(TEST_ROOT, `${provider}${suffix}-home`);
  execFileSync(process.execPath, [
    join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
    '--provider', provider,
    '--mode', 'all',
    '--target', project,
    '--deploy-skills',
    '--skills-only',
    '--skip-commands-migration',
    '--quiet',
    ...(options.copyAll ? ['--copy-all'] : []),
    ...(options.dryRun ? ['--dry-run'] : []),
  ], { timeout: 60_000,
    cwd: REPO_ROOT,
    // #2119: pin HERMES_HOME to the fake home too. Without this, a HERMES_HOME
    // inherited from the developer's environment (e.g. a per-role Hermes home)
    // redirects hermes skill deploys away from the test root and into the
    // real home — breaking test hermeticity and mutating user state.
    env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: join(home, '.hermes'), AIWG_GROKBOT_SKILLS_DIR: join(home, 'configured-grokbot-skills') },
    stdio: 'pipe',
  });
  return { project, home };
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('kernel deployment conformance', () => {
  it('has a non-empty, unique canonical kernel inventory', () => {
    expect(EXPECTED_KERNEL.length).toBe(26);
    expect(new Set(EXPECTED_KERNEL).size).toBe(EXPECTED_KERNEL.length);
  });

  it('keeps the full Codex kernel catalog useful and below its startup listing cap', () => {
    const { project, home } = deploy('codex', { suffix: 'budget' });
    const stats = codexListingStats(PROVIDERS[1].root(project, home));

    expect(stats.count).toBe(EXPECTED_KERNEL.length);
    expect(stats.totalChars).toBeLessThanOrEqual(CODEX_LISTING_CHAR_CAP);
  });

  for (const provider of PROVIDERS) {
    it(`${provider.id} deploys every canonical kernel skill and no standard skills`, () => {
      const { project, home } = deploy(provider.id);
      const deployedRoot = provider.root(project, home);
      const deployed = skillDirs(deployedRoot)
        .map(dir => dir.split('/').at(-1)!)
        .sort();

      expect(deployed).toEqual(EXPECTED_KERNEL);
      for (const name of deployed) {
        const content = readFileSync(join(deployedRoot, name, 'SKILL.md'), 'utf8');
        // Provider translators may intentionally remove AIWG-only routing
        // metadata such as `kernel` and `platforms`. The portable contract is
        // a valid named skill with a substantive body at the kernel location.
        expect(content, `${provider.id}/${name}`).toMatch(/^---\n[\s\S]*\n---\n/m);
        expect(content, `${provider.id}/${name}`).toMatch(
          new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm'),
        );
        expect(content.length, `${provider.id}/${name}`).toBeGreaterThan(100);
      }
    });

    it(`${provider.id} copies the standard tier only with --copy-all`, () => {
      const defaultDeploy = deploy(provider.id, { suffix: 'no-copy' });
      const defaultStandardRoot = provider.standardRoot(defaultDeploy.project, defaultDeploy.home);
      expect(existsSync(join(defaultStandardRoot, 'voice-apply', 'SKILL.md'))).toBe(false);

      const fullDeploy = deploy(provider.id, { copyAll: true, suffix: 'copy-all' });
      const fullRoot = provider.root(fullDeploy.project, fullDeploy.home);
      const fullStandardRoot = provider.standardRoot(fullDeploy.project, fullDeploy.home);
      expect(existsSync(join(fullStandardRoot, 'voice-apply', 'SKILL.md'))).toBe(true);
      for (const kernelName of EXPECTED_KERNEL) {
        expect(
          existsSync(join(fullRoot, kernelName, 'SKILL.md')),
          `${provider.id}/${kernelName}`,
        ).toBe(true);
      }
    });
  }

  it('repeat deploy prunes stale managed skills while preserving operator-owned skills', () => {
    const first = deploy('claude', { suffix: 'lifecycle' });
    const root = PROVIDERS[0].root(first.project, first.home);
    const stale = join(root, 'renamed-kernel-fixture');
    const operator = join(root, 'operator-owned-fixture');
    mkdirSync(stale, { recursive: true });
    mkdirSync(operator, { recursive: true });
    writeFileSync(join(stale, 'SKILL.md'), '---\nname: renamed-kernel-fixture\n---\nmanaged\n');
    writeFileSync(join(stale, '.aiwg-managed'), 'true\n');
    writeFileSync(join(operator, 'SKILL.md'), '---\nname: operator-owned-fixture\n---\noperator\n');

    deploy('claude', { suffix: 'lifecycle' });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(operator)).toBe(true);
    expect(skillDirs(root).map(dir => dir.split('/').at(-1)!).filter(name =>
      EXPECTED_KERNEL.includes(name)
    ).sort()).toEqual(EXPECTED_KERNEL);
  });

  for (const provider of PROVIDERS) {
    it(`${provider.id} repairs a full-copy deployment while preserving operator-owned skills`, () => {
      const first = deploy(provider.id, { copyAll: true, suffix: 'repair' });
      const kernelRoot = provider.root(first.project, first.home);
      const standardRoot = provider.standardRoot(first.project, first.home);
      const operator = join(kernelRoot, 'operator-owned-fixture');
      mkdirSync(operator, { recursive: true });
      writeFileSync(join(operator, 'SKILL.md'), '---\nname: operator-owned-fixture\ndescription: operator-owned skill\n---\noperator\n');
      expect(existsSync(join(standardRoot, 'voice-apply', 'SKILL.md'))).toBe(true);

      const repaired = deploy(provider.id, { suffix: 'repair' });
      const repairedKernelRoot = provider.root(repaired.project, repaired.home);
      const repairedStandardRoot = provider.standardRoot(repaired.project, repaired.home);

      expect(existsSync(join(repairedStandardRoot, 'voice-apply'))).toBe(false);
      expect(existsSync(operator)).toBe(true);
      expect(skillDirs(repairedKernelRoot).map(dir => dir.split('/').at(-1)!).filter(name =>
        EXPECTED_KERNEL.includes(name)
      ).sort()).toEqual(EXPECTED_KERNEL);

      if (provider.id === 'codex') {
        const stats = codexListingStats(repairedKernelRoot);
        expect(stats.count).toBe(EXPECTED_KERNEL.length + 1);
        expect(stats.totalChars).toBeLessThanOrEqual(CODEX_LISTING_CHAR_CAP);
      }
    });
  }

  it('moves managed skills cleanly across kernel and standard tiers', async () => {
    const root = join(TEST_ROOT, 'tier-transition');
    const source = join(root, 'source', 'transition-fixture');
    const kernelRoot = join(root, 'kernel');
    const standardRoot = join(root, 'standard');
    mkdirSync(source, { recursive: true });
    const skillFile = join(source, 'SKILL.md');
    const { deploySkillsWithKernelRouting } = await import(
      '../../tools/agents/providers/base.mjs'
    );

    writeFileSync(skillFile, '---\nname: transition-fixture\nnamespace: aiwg\nkernel: true\n---\nkernel body\n');
    deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, {
      copyStandardSkills: true,
    });
    expect(existsSync(join(kernelRoot, 'transition-fixture', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(standardRoot, 'transition-fixture'))).toBe(false);

    writeFileSync(skillFile, '---\nname: transition-fixture\nnamespace: aiwg\n---\nstandard body\n');
    deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, {
      copyStandardSkills: true,
    });
    expect(existsSync(join(kernelRoot, 'transition-fixture'))).toBe(false);
    expect(existsSync(join(standardRoot, 'transition-fixture', 'SKILL.md'))).toBe(true);

    writeFileSync(skillFile, '---\nname: transition-fixture\nnamespace: aiwg\nkernel: true\n---\nkernel again\n');
    deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, {
      copyStandardSkills: true,
    });
    expect(existsSync(join(kernelRoot, 'transition-fixture', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(standardRoot, 'transition-fixture'))).toBe(false);
  });

  it('dry-run leaves an existing provider surface unchanged', () => {
    const first = deploy('openhuman', { suffix: 'dry-run' });
    const root = PROVIDERS.find(provider => provider.id === 'openhuman')!
      .root(first.project, first.home);
    const sentinel = join(root, 'operator-sentinel', 'SKILL.md');
    mkdirSync(resolve(sentinel, '..'), { recursive: true });
    writeFileSync(sentinel, 'operator-owned\n');
    const before = readFileSync(sentinel, 'utf8');

    deploy('openhuman', { copyAll: true, dryRun: true, suffix: 'dry-run' });

    expect(readFileSync(sentinel, 'utf8')).toBe(before);
    expect(existsSync(join(root, 'voice-apply', 'SKILL.md'))).toBe(false);
  });

  it('matches the command mirror policy for every deployable provider', () => {
    const commandProviders = ['factory', 'opencode', 'warp', 'windsurf', 'copilot', 'codex', 'openclaw'];
    // #236: muse deploys skills natively (no command translation; writers land
    // agents/commands/rules as indexed-only), so it mirrors the native-only
    // peers (hermes/openhuman/grokbot).
    const nativeOnlyProviders = ['claude', 'cursor', 'grokbot', 'hermes', 'openhuman', 'pi', 'muse'];
    expect(PROVIDERS.map(provider => provider.id).sort()).toEqual(
      [...commandProviders, ...nativeOnlyProviders].sort(),
    );
    for (const provider of commandProviders) {
      expect(providerNeedsCommands(provider), provider).toBe(true);
      expect(providerUsesSkillsNatively(provider), provider).toBe(false);
    }
    for (const provider of nativeOnlyProviders) {
      expect(providerNeedsCommands(provider), provider).toBe(false);
      expect(providerUsesSkillsNatively(provider), provider).toBe(true);
    }
  });

  it('keeps primary architecture documentation aligned with canonical inventory', () => {
    for (const doc of [
      'docs/architecture-overview.md',
      'docs/how-it-works.md',
      'docs/cli/capability-routing.md',
    ]) {
      const content = readFileSync(join(REPO_ROOT, doc), 'utf8');
      expect(content, doc).toContain(`${EXPECTED_KERNEL.length} kernel skills`);
    }
  });
});

describe('grokbot fail-closed kernel deploy (#219)', () => {
  it('does not invent ~/grokbot-skills when AIWG_GROKBOT_SKILLS_DIR is unset', () => {
    const project = join(TEST_ROOT, 'grokbot-unset');
    const home = join(TEST_ROOT, 'grokbot-unset-home');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.AIWG_GROKBOT_SKILLS_DIR;
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(
        'node',
        [join(REPO_ROOT, 'bin/aiwg.mjs'), 'use', 'all', '--provider', 'grokbot', '--scope', 'user', '--dry-run'],
        { cwd: project, env, encoding: 'utf8', timeout: 120_000 },
      );
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = err.status ?? 1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toMatch(/AIWG_GROKBOT_SKILLS_DIR/);
    expect(existsSync(join(home, 'grokbot-skills'))).toBe(false);
    expect(existsSync(join(home, '.grokbot'))).toBe(false);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });
});


describe('muse XDG user-scope kernel deploy (#236)', () => {
  const museEntry = PROVIDERS.find(provider => provider.id === 'muse')!;

  function museUserScopeDryRun(
    label: string,
    env: NodeJS.ProcessEnv,
  ): { exitCode: number; output: string; project: string; home: string } {
    const project = join(TEST_ROOT, `muse-userscope-${label}`);
    const home = join(TEST_ROOT, `muse-userscope-${label}-home`);
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        'node',
        [join(REPO_ROOT, 'bin/aiwg.mjs'), 'use', 'all', '--provider', 'muse', '--scope', 'user', '--dry-run'],
        { cwd: project, env, encoding: 'utf8', timeout: 120_000 },
      );
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = err.status ?? 1;
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    return { exitCode, output, project, home };
  }

  it('fails closed on unusable XDG_CONFIG_HOME instead of inventing ~/.muse', () => {
    const { exitCode, output, project, home } = museUserScopeDryRun('bad-xdg', {
      ...process.env,
      HOME: join(TEST_ROOT, 'muse-userscope-bad-xdg-home'),
      USERPROFILE: join(TEST_ROOT, 'muse-userscope-bad-xdg-home'),
      XDG_CONFIG_HOME: 'relative/path',
    });
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/XDG_CONFIG_HOME/);
    // Fail-closed: no invented ~/.muse tree, no foreign .cursor/ tree.
    expect(existsSync(join(home, '.muse'))).toBe(false);
    expect(existsSync(join(home, '.config', 'muse'))).toBe(false);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });

  it('passes the user-scope gate with a documented XDG root and invents no ~/.muse tree', () => {
    const xdg = join(TEST_ROOT, 'muse-userscope-xdg');
    mkdirSync(xdg, { recursive: true });
    const { exitCode, project, home } = museUserScopeDryRun('xdg', {
      ...process.env,
      HOME: join(TEST_ROOT, 'muse-userscope-xdg-home'),
      USERPROFILE: join(TEST_ROOT, 'muse-userscope-xdg-home'),
      XDG_CONFIG_HOME: xdg,
    });
    expect(exitCode).toBe(0);
    // Documented user root only — nothing invented under the fake home.
    expect(existsSync(join(home, '.muse'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });

  it('pins the documented user skill roots ($XDG_CONFIG_HOME/muse/skills, ~/.config/muse/skills default)', async () => {
    const { resolveMuseXdgSkillsDir } = await import('../../src/providers/muse-paths.js');
    const xdg = join(TEST_ROOT, 'muse-xdg-roots');
    const home = join(TEST_ROOT, 'muse-xdg-roots-home');
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, 'muse', 'skills'));
    expect(resolveMuseXdgSkillsDir({}, home)).toBe(join(home, '.config', 'muse', 'skills'));
    // Project scope never resolves a home-dir tree from the namespace default.
    expect(museEntry.root('project', 'home')).toBe(join('project', '.agents/skills'));
  });

  it('never writes a .cursor or ~/.muse tree on project deploy', () => {
    const { project, home } = deploy('muse', { suffix: 'no-cursor' });
    expect(existsSync(join(project, '.cursor'))).toBe(false);
    expect(existsSync(join(home, '.muse'))).toBe(false);
    expect(existsSync(join(museEntry.root(project, home), 'aiwg-issue', 'SKILL.md'))).toBe(true);
  });
});
