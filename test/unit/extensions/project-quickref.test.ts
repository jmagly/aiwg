import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PROJECT_AIWG_LOCATION_FILE, projectAiwgPath } from '../../../src/config/project-artifacts.js';
import {
  deployProjectQuickref,
  generateProjectQuickref,
  projectQuickrefSkillName,
  resolveProjectQuickref,
  renderProjectQuickref,
  type ProjectQuickref,
} from '../../../src/extensions/project-quickref.js';
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from '../../../src/extensions/project-local-paths.js';
import { isOwnedByNamespace, checkCollisions } from '../../../src/smiths/skillsmith/collision-detector.js';

const roots: string[] = [];
const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  'HERMES_HOME',
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
] as const;
let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

async function fixture(): Promise<{ projectDir: string; homeDir: string; definition: ProjectQuickref }> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const homeDir = join(root, 'home');
  await mkdir(projectAiwgPath(projectDir), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const definition: ProjectQuickref = {
    version: '1',
    project: {
      id: 'acme-console',
      name: 'Acme Console',
      description: 'Repository-specific orientation for Acme Console.',
    },
    precedence: 'Use listed project processes before generic AIWG workflows when they apply.',
    entries: [{
      title: 'Issue handling',
      summary: 'Use the repository issue workflow before generic issue tooling.',
      discover: ['project issue handling'],
      show: [{ type: 'skill', name: 'project-issue-workflow' }],
    }],
  };
  await writeFile(projectAiwgPath(projectDir, 'quickref.json'), JSON.stringify(definition, null, 2) + '\n');
  return { projectDir, homeDir, definition };
}

async function writeBundle(
  projectDir: string,
  id: string,
  options: { name?: string; description?: string; keyword?: string; skill?: string } = {},
): Promise<void> {
  const dir = projectAiwgPath(projectDir, 'extensions', id);
  const skill = options.skill ?? `${id}-skill`;
  await mkdir(join(dir, 'skills', skill), { recursive: true });
  await writeFile(join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n\n# ${skill}\n`);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    id,
    type: 'extension',
    name: options.name ?? id,
    version: '1.0.0',
    description: options.description ?? `${id} project capability`,
    manifestVersion: '1',
    platforms: { claude: 'full' },
    keywords: [options.keyword ?? id],
    deployment: { pathTemplate: '.{platform}/skills/{id}' },
  }, null, 2));
}

beforeEach(() => {
  originalEnv = {};
  for (const key of ARTIFACT_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ARTIFACT_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('project quickref generation and deployment (#1788)', () => {
  it('synthesizes a managed project quickref from discovered bundles without a legacy source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-managed-'));
    roots.push(root);
    const projectDir = join(root, 'managed-project');
    await writeBundle(projectDir, 'team-tools', { name: 'Team Tools', skill: 'team-workflow' });

    const resolved = await resolveProjectQuickref(projectDir);
    expect(resolved.exists).toBe(true);
    expect(resolved.provenance).toBe('managed');
    expect(resolved.definition?.project.id).toBe('managed-project');
    expect(resolved.definition?.entries).toEqual([expect.objectContaining({
      title: 'Team Tools',
      show: [{ type: 'skill', name: 'team-workflow' }],
    })]);

    const generated = await generateProjectQuickref(projectDir, { dryRun: true });
    expect(generated.content).toContain('name: aiwg-project-managed-project-quickref');
    expect(generated.content).toContain('aiwg show skill team-workflow');
    expect(existsSync(projectAiwgPath(projectDir, 'generated'))).toBe(false);
  });

  it('applies managed exclusions and overrides without rewriting operator config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-config-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    await writeBundle(projectDir, 'alpha');
    await writeBundle(projectDir, 'beta');
    const configPath = projectAiwgPath(projectDir, 'quickref.config.json');
    const config = {
      version: '1',
      project: { id: 'org-project', name: 'Org Project', description: 'Managed orientation.' },
      precedence: 'Prefer repository workflows.',
      entries: [{ title: 'Manual', summary: 'Curated route.', discover: ['manual route'], show: [] }],
      discovery: {
        enabled: true,
        excludeBundles: ['beta'],
        overrides: { alpha: { title: 'Alpha Override', discover: ['alpha custom'] } },
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    const before = await readFile(configPath, 'utf8');
    const generated = await generateProjectQuickref(projectDir);
    expect(generated.content).toContain('# Org Project Quick Reference');
    expect(generated.content).toContain('## Alpha Override');
    expect(generated.content).toContain('## Manual');
    expect(generated.content).not.toContain('## beta');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(existsSync(projectAiwgPath(projectDir, 'generated', 'project-quickref', 'definition.json'))).toBe(true);
  });

  it('sorts discovered bundles deterministically and fails closed on discovery errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-sort-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    await writeBundle(projectDir, 'zeta');
    await writeBundle(projectDir, 'alpha');
    const resolved = await resolveProjectQuickref(projectDir);
    expect(resolved.definition?.entries.map(entry => entry.title)).toEqual(['alpha', 'zeta']);

    const invalid = projectAiwgPath(projectDir, 'extensions', 'broken');
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, 'manifest.json'), '{"id":"broken"}');
    await expect(resolveProjectQuickref(projectDir)).rejects.toThrow(/broken/);
  });

  it('enumerates plugin payload capabilities once through the validated artifact path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-plugin-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const wrapper = projectAiwgPath(projectDir, 'plugins', 'team-plugin');
    await mkdir(join(wrapper, 'payload', 'skills', 'payload-skill'), { recursive: true });
    await writeFile(join(wrapper, 'payload', 'skills', 'payload-skill', 'SKILL.md'), '---\nname: payload-skill\n---\n');
    await writeFile(join(wrapper, 'payload', 'manifest.json'), JSON.stringify({
      id: 'team-plugin-core', type: 'addon', name: 'Team Plugin Core', version: '1.0.0',
      description: 'Payload', manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['team'],
      deployment: { pathTemplate: '.aiwg/addons/team-plugin-core' },
      addonConfig: { entry: { skills: 'skills/' } },
    }));
    await writeFile(join(wrapper, 'manifest.json'), JSON.stringify({
      id: 'team-plugin', type: 'plugin', name: 'Team Plugin', version: '1.0.0',
      description: 'Wrapper', manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['team'],
      deployment: { pathTemplate: '.aiwg/plugins/team-plugin' },
      pluginConfig: { payloadType: 'addon', payloadPath: 'payload/' },
    }));

    const resolved = await resolveProjectQuickref(projectDir);
    expect(resolved.definition?.entries).toHaveLength(1);
    expect(resolved.definition?.entries[0].show).toEqual([{ type: 'skill', name: 'payload-skill' }]);
  });

  it('bounds kernel entries and show hints with deterministic diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-bounds-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const bundle = projectAiwgPath(projectDir, 'extensions', 'many-tools');
    for (let index = 0; index < 9; index += 1) {
      const name = `skill-${index}`;
      await mkdir(join(bundle, 'skills', name), { recursive: true });
      await writeFile(join(bundle, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    }
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({
      id: 'many-tools', type: 'extension', name: 'Many Tools', version: '1.0.0',
      description: 'Many capabilities', manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['many'],
      deployment: { pathTemplate: '.{platform}/skills/{id}' },
    }));
    const manualEntries = Array.from({ length: 50 }, (_, index) => ({
      title: `Manual ${index}`,
      summary: `Manual route ${index}`,
      discover: [`manual ${index}`],
      show: [],
    }));
    await writeFile(projectAiwgPath(projectDir, 'quickref.config.json'), JSON.stringify({
      version: '1', entries: manualEntries,
    }));

    const resolved = await resolveProjectQuickref(projectDir);
    expect(resolved.definition?.entries).toHaveLength(50);
    expect(resolved.definition?.entries[0].show).toHaveLength(8);
    expect(resolved.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('show hints truncated'),
      expect.stringContaining('entries truncated'),
    ]));
  });

  it('renders deterministic preview output without writing in dry-run mode', async () => {
    const { projectDir, definition } = await fixture();
    const first = await generateProjectQuickref(projectDir, { dryRun: true });
    const second = await generateProjectQuickref(projectDir, { dryRun: true });

    expect(first.content).toBe(second.content);
    expect(first.content).toBe(renderProjectQuickref(definition));
    expect(first.content).toContain('aiwg discover "project issue handling"');
    expect(first.content).toContain('aiwg show skill project-issue-workflow');
    expect(existsSync(first.outputPath)).toBe(false);
  });

  it('deploys to a file-based project provider and is idempotent', async () => {
    const { projectDir } = await fixture();
    const first = await deployProjectQuickref(projectDir, 'claude');
    const second = await deployProjectQuickref(projectDir, 'claude');

    expect(first.targetPath).toBe(join(projectDir, '.claude', 'skills', first.skillName, 'SKILL.md'));
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(await readFile(first.targetPath, 'utf8')).toContain('kernel: true');
  });

  it('deploys a quickref the collision scan recognizes as AIWG-owned (#2504)', async () => {
    const { projectDir } = await fixture();
    const deployed = await deployProjectQuickref(projectDir, 'claude');
    const skillDir = join(projectDir, '.claude', 'skills', deployed.skillName);

    // AIWG generated and deployed this skill. Without the ownership marker the
    // scan reported AIWG's own artifact as an unowned overwrite on every run,
    // and the suggested fix regenerated the same unowned file.
    expect(await readFile(deployed.targetPath, 'utf8')).toContain('namespace: aiwg');
    expect(await isOwnedByNamespace(skillDir, 'aiwg')).toBe(true);

    const collisions = await checkCollisions({
      platform: 'claude',
      projectPath: projectDir,
      skillNames: [deployed.skillName],
      namespace: 'aiwg',
      skillsBaseDir: join(projectDir, '.claude', 'skills'),
    });
    expect(collisions.filter(r => r.severity === 'warn' || r.severity === 'error')).toEqual([]);
  });

  it('prunes obsolete output beneath the generated quickref root', async () => {
    const { projectDir } = await fixture();
    const obsolete = projectAiwgPath(projectDir, 'generated', 'project-quickref', 'old-project-quickref');
    await mkdir(obsolete, { recursive: true });
    await writeFile(join(obsolete, 'SKILL.md'), '# stale generated output\n');

    await generateProjectQuickref(projectDir);
    expect(existsSync(obsolete)).toBe(false);
  });

  it('loads and generates quickrefs from a relocated artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-project-quickref-relocated-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const artifactRoot = join(root, 'private', 'renamed-aiwg');
    const definition: ProjectQuickref = {
      version: '1',
      project: {
        id: 'relocated-console',
        name: 'Relocated Console',
        description: 'Quickref in a relocated project artifact root.',
      },
      precedence: 'Use relocated project instructions first.',
      entries: [{
        title: 'Relocated flow',
        summary: 'Read the relocated source.',
        discover: ['relocated flow'],
        show: [],
      }],
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, PROJECT_AIWG_LOCATION_FILE), '../private/renamed-aiwg\n');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(projectAiwgPath(projectDir, 'quickref.json'), JSON.stringify(definition, null, 2) + '\n');

    const generated = await generateProjectQuickref(projectDir);

    expect(generated.sourcePath).toBe(join(artifactRoot, 'quickref.json'));
    expect(generated.outputPath).toBe(join(
      artifactRoot,
      'generated',
      'project-quickref',
      'aiwg-project-relocated-console-quickref',
      'SKILL.md',
    ));
    expect(existsSync(generated.outputPath)).toBe(true);
  });

  it('namespaces a user-global provider target by canonical project id', async () => {
    const { projectDir, homeDir } = await fixture();
    const result = await deployProjectQuickref(projectDir, 'openhuman', { homeDir });

    expect(result.skillName).toBe(projectQuickrefSkillName('acme-console'));
    expect(result.targetPath).toBe(join(homeDir, '.openhuman', 'skills', result.skillName, 'SKILL.md'));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it('uses the supported kernel target for an aggregated provider', async () => {
    const { projectDir } = await fixture();
    const result = await deployProjectQuickref(projectDir, 'warp');

    expect(result.targetPath).toBe(join(projectDir, '.warp', 'skills', result.skillName, 'SKILL.md'));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it('uses the generic skill surface as explicit emulation when no kernel target exists', async () => {
    const { projectDir } = await fixture();
    const result = await deployProjectQuickref(projectDir, 'generic');

    expect(result.emulated).toBe(true);
    expect(result.targetPath).toBe(join(projectDir, 'skills', result.skillName, 'SKILL.md'));
  });

  it('deploys Hermes quickrefs to the active HERMES_HOME skills surface', async () => {
    const { projectDir, homeDir } = await fixture();
    const hermesHome = join(homeDir, 'hermes-profile');
    process.env.HERMES_HOME = hermesHome;

    const result = await deployProjectQuickref(projectDir, 'hermes', { homeDir });

    expect(result.targetPath).toBe(join(hermesHome, 'skills', result.skillName, 'SKILL.md'));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it('deploys to the current kernel surface for every supported provider', async () => {
    const { projectDir, homeDir } = await fixture();
    const skillName = projectQuickrefSkillName('acme-console');
    const expectedRoots: Record<string, string> = {
      claude: join(projectDir, '.claude', 'skills'),
      codex: join(projectDir, '.agents', 'skills'),
      copilot: join(projectDir, '.github', 'skills'),
      cursor: join(projectDir, '.cursor', 'skills'),
      factory: join(projectDir, '.factory', 'skills'),
      hermes: join(homeDir, '.hermes', 'skills'),
      opencode: join(projectDir, '.opencode', 'skill'),
      openclaw: join(homeDir, '.openclaw', 'skills', 'aiwg'),
      openhuman: join(homeDir, '.openhuman', 'skills'),
      warp: join(projectDir, '.warp', 'skills'),
      windsurf: join(projectDir, '.windsurf', 'skills'),
      generic: join(projectDir, 'skills'),
    };

    for (const [provider, root] of Object.entries(expectedRoots)) {
      const result = await deployProjectQuickref(projectDir, provider, { homeDir });
      expect(result.targetPath, provider).toBe(join(root, skillName, 'SKILL.md'));
      expect(existsSync(result.targetPath), provider).toBe(true);
    }
  });

  it('prunes only stale quickrefs carrying this project ownership marker', async () => {
    const { projectDir } = await fixture();
    const current = await deployProjectQuickref(projectDir, 'claude');
    const root = join(projectDir, '.claude', 'skills');
    const stale = join(root, 'aiwg-project-old-id-quickref');
    const operator = join(root, 'operator-skill');
    await mkdir(stale, { recursive: true });
    await mkdir(operator, { recursive: true });
    await writeFile(join(stale, '.aiwg-project-quickref.json'), JSON.stringify({
      version: 1,
      projectId: 'old-id',
      sourceProject: projectDir,
      sourcePath: projectAiwgPath(projectDir, 'quickref.json'),
      contentHash: 'old',
    }));
    await writeFile(join(operator, 'SKILL.md'), '# operator owned\n');

    const result = await deployProjectQuickref(projectDir, 'claude');
    expect(result.pruned).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(operator)).toBe(true);
    expect(existsSync(current.targetPath)).toBe(true);
  });
});
