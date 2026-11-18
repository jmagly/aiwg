// Regressions for summary-rule delivery and complete project-local skill assets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { countDeployedBundleRules } from '../../../../src/cli/handlers/use-bundle-counts.js';

const repository = resolve(import.meta.dirname, '../../../..');
const providers = ['claude', 'codex', 'pi', 'hermes'] as const;
let root: string;
let project: string;
let bundle: string;
let environment: NodeJS.ProcessEnv;

function write(relative: string, text: string): void {
  const file = join(bundle, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function skill(body: string): void {
  write('skills/repro-skill/SKILL.md', `---\nname: repro-skill\nplatforms: [all]\ndescription: Synthetic project-local helper.\n---\n\n# Repro skill\n\n${body}\n`);
  write('skills/repro-skill/scripts/helper.py', 'print("ok")\n');
}
function use(provider: string) {
  const result = spawnSync(process.execPath, [join(repository, 'bin/aiwg.mjs'),
    'use', 'repro-addon', '--copy-all', '--provider', provider, '--verbose'], {
    cwd: project, env: environment, encoding: 'utf8', timeout: 90_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
function skillRoot(provider: string): string {
  const prefixes = provider === 'codex' ? ['.agents', '.codex']
    : provider === 'pi' ? ['.agents', '.pi'] : [`.${provider}`];
  const tiers = prefixes.flatMap(prefix => [join(project, prefix, 'skills'), join(project, prefix, '.aiwg/skills')]);
  if (provider === 'hermes') tiers.unshift(join(environment.HERMES_HOME!, 'skills/.aiwg'), join(environment.HERMES_HOME!, 'skills'));
  const found = tiers.map(tier => join(tier, 'repro-skill')).find(candidate => {
    try { return readFileSync(join(candidate, 'SKILL.md')).length > 0; } catch { return false; }
  });
  if (!found) throw new Error(`Missing deployed repro-skill for ${provider}`);
  return found;
}
function supportTree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (base: string, prefix = '') => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(base, entry.name), `${relative}/`);
      else if (!['SKILL.md', '.aiwg-managed', '.aiwg-manifest.json', 'agents/openai.yaml'].includes(relative)) {
        result[relative] = readFileSync(join(base, entry.name), 'utf8');
      }
    }
  };
  walk(dir);
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-local-addon-assets-'));
  project = join(root, 'project');
  bundle = join(project, '.aiwg/addons/repro-addon');
  environment = { ...process.env, AIWG_ROOT: repository, AIWG_NO_UPDATE_CHECK: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH', 'OPENCLAW_PROFILE']) delete environment[key];
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'XDG_STATE_HOME', 'CODEX_HOME', 'HERMES_HOME', 'OPENHUMAN_HOME', 'OPENCLAW_HOME', 'GROK_HOME',
    'DSH_HOME', 'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'AIWG_GROKBOT_SKILLS_DIR', 'AIWG_CONFIG']) {
    environment[key] = join(root, key.toLowerCase());
    mkdirSync(environment[key]!, { recursive: true });
  }
  write('manifest.json', JSON.stringify({
    id: 'repro-addon', type: 'addon', name: 'repro-addon', version: '0.1.0', manifestVersion: '1',
    description: 'Synthetic addon', platforms: { claude: 'full', codex: 'full', generic: 'full' },
    keywords: ['addon'], deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    addonConfig: { entry: { skills: 'skills/', rules: 'rules/' } },
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('project-local addon delivery (#3725, #3726, #3727)', () => {
  it('counts a delivered summary rule through RULES-INDEX and records its artifact hash on each provider', { timeout: 240_000 }, async () => {
    write('rules/repro-addon.md', '---\nid: repro-addon\nname: repro-addon\nenforcement: high\nactivation: summary\nsummary: Synthetic summary rule.\n---\n\n# Repro rule\n\nBody.\n');
    for (const provider of providers) {
      const result = use(provider);
      expect(result.status, result.output).toBe(0);
      const config = JSON.parse(readFileSync(join(project, '.aiwg/aiwg.config'), 'utf8'));
      const installed = config.installed['repro-addon'];
      expect(installed.deployedTo[provider].rules, provider).toBe(1);
      expect(installed.deployedArtifactHashes[provider]['rules/repro-addon.md'], provider).toMatch(/^[a-f0-9]{64}$/);
      const rules = provider === 'pi' ? '.pi/rules' : `.${provider}/rules`;
      expect(readFileSync(join(project, rules, 'RULES-INDEX.md'), 'utf8')).toContain('`aiwg show rule repro-addon --body`');
      expect(await countDeployedBundleRules(bundle, project, rules)).toBe(1);
    }
  });

  it('copies the complete unreferenced support tree to Codex like Claude, Pi and Hermes, including updates', { timeout: 240_000 }, () => {
    skill('The helper lives in this skill folder.');
    write('skills/repro-skill/references/nested/guide.md', '# Synthetic guide\n');
    write('skills/repro-skill/templates/example.txt', 'Synthetic template\n');
    write('skills/repro-skill/assets/example.json', '{"synthetic":true}\n');
    write('skills/repro-skill/NOTICE', 'Synthetic notice\n');
    const expected = supportTree(join(bundle, 'skills/repro-skill'));
    for (const provider of providers) {
      const result = use(provider);
      expect(result.status, result.output).toBe(0);
      expect(supportTree(skillRoot(provider)), provider).toEqual(expected);
    }
    // Instructions stay unchanged while an unreferenced script changes.
    write('skills/repro-skill/scripts/helper.py', 'print("updated")\n');
    const updated = use('codex');
    expect(updated.status, updated.output).toBe(0);
    expect(readFileSync(join(skillRoot('codex'), 'scripts/helper.py'), 'utf8')).toBe('print("updated")\n');
  });

  it('resolves sentence punctuation and names genuinely missing assets under the documented fail-closed contract', { timeout: 240_000 }, () => {
    // docs/customization/project-local-quickstart.md: missing support assets fail deployment.
    skill('Run scripts/helper.py. Then read scripts/helper.py! Or scripts/helper.py?');
    for (const provider of ['claude', 'codex']) {
      const result = use(provider);
      expect(result.status, result.output).toBe(0);
      expect(result.output).not.toContain('missing skill support asset');
      expect(readFileSync(join(skillRoot(provider), 'scripts/helper.py'), 'utf8')).toBe('print("ok")\n');
    }
    skill('Run scripts/absent.py.');
    const missing = use('claude');
    expect(missing.status, missing.output).toBe(1);
    expect(missing.output).toContain("WARN Project-local skill asset deployment failed for 'repro-addon'");
    expect(missing.output).toContain("missing skill support asset 'scripts/absent.py' referenced by");
    expect(missing.output).toContain('skills/repro-skill/SKILL.md');
  });
});
