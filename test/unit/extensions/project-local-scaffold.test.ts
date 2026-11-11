/**
 * Unit tests for project-local scaffolding (#1050)
 *
 * @source @src/extensions/project-local-scaffold.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PROJECT_AIWG_LOCATION_FILE } from '../../../src/config/project-artifacts.js';
import { scaffoldProjectLocalBundle } from '../../../src/extensions/project-local-scaffold.js';
import { BundleManifestSchema } from '../../../src/extensions/manifest.js';
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from '../../../src/extensions/project-local-paths.js';
import YAML from 'yaml';
import { listHandler } from '../../../src/cli/handlers/subcommands-list.js';

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
] as const;

let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aiwg-pls-'));
}

describe('scaffoldProjectLocalBundle (#1050)', () => {
  let projectDir: string;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ARTIFACT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    projectDir = tmp();
  });
  afterEach(() => {
    for (const key of ARTIFACT_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('rejects invalid kebab-case names', async () => {
    await expect(
      scaffoldProjectLocalBundle({ type: 'extension', name: 'BadName', projectDir }),
    ).rejects.toThrow(/kebab-case/);
  });

  it('creates extension bundle with skill starter by default', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'extension', name: 'foo', projectDir });
    expect(result.alreadyExists).toBe(false);
    expect(result.bundlePath).toContain('.aiwg/extensions/foo');
    expect(result.filesCreated).toContain('manifest.json');
    expect(result.filesCreated).toContain('README.md');
    expect(result.filesCreated).toContain('skills/foo-skill/SKILL.md');

    const manifestRaw = readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.id).toBe('foo');
    expect(manifest.type).toBe('extension');

    // Manifest must validate against the canonical schema
    const validated = BundleManifestSchema.safeParse(manifest);
    expect(validated.success).toBe(true);
  });

  it('creates bundles under the configured artifact root when .aiwg is relocated', async () => {
    const relocatedRoot = join(projectDir, 'private-artifacts', 'renamed-aiwg');
    mkdirSync(join(projectDir, 'private-artifacts'), { recursive: true });
    writeFileSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'private-artifacts/renamed-aiwg\n', 'utf-8');

    const result = await scaffoldProjectLocalBundle({ type: 'extension', name: 'relocated', projectDir });

    expect(result.bundlePath).toBe(join(relocatedRoot, 'extensions', 'relocated'));
    expect(existsSync(join(result.bundlePath, 'manifest.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.aiwg', 'extensions', 'relocated'))).toBe(false);
  });

  it('creates addon bundle with addonConfig', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'addon', name: 'bar', projectDir });
    expect(result.bundlePath).toContain('.aiwg/addons/bar');
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(manifest.type).toBe('addon');
    expect(manifest.addonConfig).toBeDefined();
    expect(BundleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each(['agent', 'skill'] as const)('creates an addon %s starter that passes the validate-addon contract and list (#4085)', async starter => {
    const result = await scaffoldProjectLocalBundle({ type: 'addon', name: 'ux-studio', starter, projectDir });
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(BundleManifestSchema.parse(manifest)).toMatchObject(manifest);
    // validate-addon Process 2: CalVer and explicit boolean flags.
    expect(manifest.version).toMatch(/^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/);
    expect(manifest.core).toBe(false);
    expect(manifest.autoInstall).toBe(false);
    expect(readFileSync(join(result.bundlePath, 'README.md'), 'utf-8').trim()).not.toBe('');
    // Process 4/5: declared inventory and entry paths must identify the created files.
    expect(manifest.agents).toEqual(starter === 'agent' ? ['ux-studio'] : []);
    expect(manifest.skills).toEqual(starter === 'skill' ? ['ux-studio-skill'] : []);
    expect(manifest.addonConfig.entry).toEqual(starter === 'agent' ? { agents: 'agents/' } : { skills: 'skills/' });
    const artifact = starter === 'agent' ? 'agents/ux-studio.md' : 'skills/ux-studio-skill/SKILL.md';
    const body = readFileSync(join(result.bundlePath, artifact), 'utf-8');
    const frontmatter = YAML.parse(body.split('---')[1]);
    expect(frontmatter.name).toBe(starter === 'agent' ? 'ux-studio' : 'ux-studio-skill');
    expect(frontmatter.description).toBeTruthy();
    if (starter === 'agent') {
      expect(frontmatter.model).toBeTruthy();
      expect(frontmatter.tools.length).toBeGreaterThan(0);
    } else {
      expect(body).toMatch(/^## (?:Behavior|Process)$/m);
    }
    expect(body).not.toContain('@.aiwg/');
    const listed = await listHandler.execute({ cwd: projectDir, args: ['--project-local'], rawArgs: ['list', '--project-local'] });
    expect(listed.exitCode).toBe(0);
    expect(listed.message).toContain('Project-local bundles (1)');
    expect(listed.message).toContain('ux-studio [project] [addon]');
    expect(listed.message).not.toContain('Validation errors');
  });

  it('lists an addon following validate-addon after adding its documented fields (#4085)', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'addon', name: 'ux-studio', projectDir });
    const manifestPath = join(result.bundlePath, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, core: false, autoInstall: false,
      agents: [], skills: ['ux-studio-skill'] }));
    const listed = await listHandler.execute({ cwd: projectDir, args: ['--project-local'], rawArgs: ['list', '--project-local'] });
    expect(listed.message).toContain('Project-local bundles (1)');
    expect(listed.message).not.toContain('Validation errors');
  });

  it('registers and indexes an addon rule starter and keeps dry-run file lists accurate (#4085)', async () => {
    const options = { type: 'addon' as const, name: 'policy', starter: 'rule' as const, projectDir };
    const preview = await scaffoldProjectLocalBundle({ ...options, dryRun: true });
    const result = await scaffoldProjectLocalBundle(options);
    expect(result.filesCreated).toEqual(preview.filesCreated);
    const manifest = BundleManifestSchema.parse(JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8')));
    expect(manifest.rules).toEqual(['policy']);
    expect(manifest.addonConfig?.entry).toEqual({ rules: 'rules/' });
    expect(readFileSync(join(result.bundlePath, 'rules/RULES-INDEX.md'), 'utf-8')).toContain('[policy](policy.md)');
  });

  it('creates framework bundle with frameworkConfig and src/ stub', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'framework', name: 'baz', projectDir });
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(manifest.type).toBe('framework');
    expect(manifest.frameworkConfig).toBeDefined();
    expect(existsSync(join(result.bundlePath, 'src', '.gitkeep'))).toBe(true);
    expect(BundleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('creates plugin bundle with pluginConfig and payload/ stub', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'plugin', name: 'qux', projectDir });
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(manifest.type).toBe('plugin');
    expect(manifest.pluginConfig).toBeDefined();
    expect(existsSync(join(result.bundlePath, 'payload', '.gitkeep'))).toBe(true);
    expect(BundleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('creates provider bundle with providerConfig and no starter artifact by default', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'provider', name: 'custom-provider', projectDir });
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(result.bundlePath).toContain('.aiwg/providers/custom-provider');
    expect(result.filesCreated).toEqual(['manifest.json', 'README.md']);
    expect(manifest.type).toBe('provider');
    expect(manifest.providerConfig).toEqual({ extends: 'claude', displayName: 'custom-provider' });
    expect(existsSync(join(result.bundlePath, 'skills'))).toBe(false);
    const readme = readFileSync(join(result.bundlePath, 'README.md'), 'utf-8');
    expect(readme).toContain('aiwg use sdlc --provider custom-provider');
    expect(readme).not.toContain('aiwg use custom-provider');
    expect(BundleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('honors --starter rule', async () => {
    const result = await scaffoldProjectLocalBundle({
      type: 'extension', name: 'rl', starter: 'rule', projectDir,
    });
    expect(result.filesCreated).toContain('rules/rl.md');
    expect(result.filesCreated.find(f => f.includes('SKILL.md'))).toBeUndefined();
  });

  it('honors --starter agent', async () => {
    const result = await scaffoldProjectLocalBundle({
      type: 'extension', name: 'ag', starter: 'agent', projectDir,
    });
    expect(result.filesCreated).toContain('agents/ag.md');
  });

  it('honors --starter minimal (no starter artifact)', async () => {
    const result = await scaffoldProjectLocalBundle({
      type: 'extension', name: 'mn', starter: 'minimal', projectDir,
    });
    expect(result.filesCreated).toEqual(['manifest.json', 'README.md']);
  });

  it('refuses to overwrite an existing bundle', async () => {
    await scaffoldProjectLocalBundle({ type: 'extension', name: 'twice', projectDir });
    const second = await scaffoldProjectLocalBundle({ type: 'extension', name: 'twice', projectDir });
    expect(second.alreadyExists).toBe(true);
    expect(second.filesCreated).toEqual([]);
  });

  it('README contains the identical-form portability reminder', async () => {
    const result = await scaffoldProjectLocalBundle({ type: 'extension', name: 'rd', projectDir });
    const readme = readFileSync(join(result.bundlePath, 'README.md'), 'utf-8');
    expect(readme.toLowerCase()).toContain('identical-form');
    expect(readme).toContain('aiwg promote');
  });

  it('honors a custom description', async () => {
    const result = await scaffoldProjectLocalBundle({
      type: 'addon', name: 'desc', description: 'My custom description here', projectDir,
    });
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, 'manifest.json'), 'utf-8'));
    expect(manifest.description).toBe('My custom description here');
  });
});
