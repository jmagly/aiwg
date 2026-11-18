/**
 * Regression tests for #2873 — hermes addon deploy of a bundle that requires
 * aiwg-utils.
 *
 * Uses a synthetic framework root (tiny addons), a temporary project
 * directory, a temporary HOME, and a temporary HERMES_HOME. Never touches the
 * real home directory or the real project. The real deploy-agents.mjs pipeline
 * runs in a subprocess so the hermes provider skill-routing fix is exercised
 * for real.
 *
 * @source @src/cli/handlers/use.ts
 * @source @tools/agents/providers/hermes.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Host values captured before the tests redirect HOME — used to prove the
// deploy pipeline never touches the operator's real home directory.
const HOST_HOME = process.env.HOME ?? homedir();

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => 'mock-framework-root'),
  // Mirrors a dev-checkout identity: devMode exempts the run from
  // signed-release receipt issuance (offline sandbox has no release cache).
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test', devMode: true })),
}));

// Run the REAL deploy pipeline from the repo checkout while letting use.ts
// resolve addon sources from the synthetic framework root under test.
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({
    run: async (script: string, args: string[] = []) => {
      try {
        execFileSync('node', [join(REPO_ROOT, script), ...args], {
          stdio: 'pipe',
          env: process.env,
          timeout: 60_000,
        });
        return { exitCode: 0 };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return {
          exitCode: typeof status === 'number' ? status : 1,
          message: (error as Error).message,
        };
      }
    },
  }),
}));

// Host environment variables the test must never inherit. HERMES_HOME,
// XDG_* and HOME/USERPROFILE are redirected at temp dirs per test;
// AIWG_ROOT and AIWG_HOME must stay absent so the pipeline resolves the
// synthetic framework root instead of the operator's checkout.
const SCRUBBED_ENV_VARS = [
  'AIWG_ROOT',
  'AIWG_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'HERMES_HOME',
  'HOME',
  'USERPROFILE',
] as const;

const savedEnv = new Map<string, string | undefined>();

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const VALID_PROBE_FRONTMATTER = `---
namespace: aiwg
name: sess-probe
platforms: [all]
description: synthetic session probe
metadata:
  entrypoint: session-entry.md
---
`;

/** Synthetic framework root with decision-engine → required aiwg-utils. */
function writeSyntheticFrameworkRoot(root: string): void {
  // An (empty) frameworks dir marks this as an AIWG source tree so the
  // post-deploy capability-index rebuild runs against the synthetic root
  // instead of being skipped as a non-source fixture.
  mkdirSync(join(root, 'agentic', 'code', 'frameworks'), { recursive: true });
  // Minimal static model catalog so the late model-wrapper check resolves
  // offline against the synthetic root (allowNetwork:false returns it
  // directly) instead of throwing on a missing catalog.
  mkdirSync(join(root, 'agentic', 'code', 'providers'), { recursive: true });
  writeFileSync(
    join(root, 'agentic', 'code', 'providers', 'model-catalog.v1.json'),
    JSON.stringify({ version: '1.0.0', refreshedAt: '2026-10-12', providers: { hermes: { roles: {} } } }),
  );
  const utilsDir = join(root, 'agentic', 'code', 'addons', 'aiwg-utils');
  const probeDir = join(utilsDir, 'skills', 'sess-probe');
  mkdirSync(join(probeDir, 'references'), { recursive: true });
  writeFileSync(join(utilsDir, 'manifest.json'), JSON.stringify({ id: 'aiwg-utils', version: '1.0.0' }));
  writeFileSync(
    join(probeDir, 'SKILL.md'),
    `${VALID_PROBE_FRONTMATTER}\nProbe body with [recipe](references/recipes.md).\n`,
  );
  writeFileSync(join(probeDir, 'session-entry.md'), '# synthetic session entrypoint\n');
  writeFileSync(join(probeDir, 'references', 'recipes.md'), '# synthetic recipes\n');

  // Kernel-tier skill: `kernel: true` routes to the platform-native skills
  // root ($HERMES_HOME/skills) instead of the standard .aiwg/ tier.
  const kernDir = join(utilsDir, 'skills', 'kern-probe');
  mkdirSync(join(kernDir, 'references'), { recursive: true });
  writeFileSync(
    join(kernDir, 'SKILL.md'),
    '---\nnamespace: aiwg\nname: kern-probe\nplatforms: [all]\nkernel: true\ndescription: synthetic kernel probe\n---\n\nKernel probe body with [notes](references/notes.md).\n',
  );
  writeFileSync(join(kernDir, 'references', 'notes.md'), '# synthetic kernel notes\n');

  const rulesDir = join(utilsDir, 'rules');
  mkdirSync(rulesDir);
  writeFileSync(join(rulesDir, 'critical-probe.md'),
    '---\nname: critical-probe\nactivation: kernel\nenforcement: critical\n---\n# Critical probe\n\nCRITICAL_ADDON_BODY must remain verbatim.\n');
  writeFileSync(join(rulesDir, 'fetch-probe.md'),
    '---\nname: fetch-probe\nactivation: kernel\nenforcement: high\nsummary: Follow the addon fetch policy.\n---\nNONCRITICAL_ADDON_BODY must be fetched.\n');

  const engineDir = join(root, 'agentic', 'code', 'addons', 'decision-engine');
  const checkDir = join(engineDir, 'skills', 'de-check');
  mkdirSync(checkDir, { recursive: true });
  writeFileSync(
    join(engineDir, 'manifest.json'),
    JSON.stringify({
      id: 'decision-engine',
      version: '1.0.0',
      dependencies: { required: ['aiwg-utils'] },
    }),
  );
  writeFileSync(
    join(checkDir, 'SKILL.md'),
    '---\nnamespace: aiwg\nname: de-check\nplatforms: [all]\ndescription: synthetic decision check\n---\n\nCheck body.\n',
  );
}

async function freshUseHandler() {
  vi.resetModules();
  return (await import('../../../../src/cli/handlers/use.js')).useHandler;
}

/** `~/.hermes` state under the operator's real home: null when absent. */
function realHomeHermesState(): string | null {
  const dir = join(HOST_HOME, '.hermes');
  if (!existsSync(dir)) return null;
  return JSON.stringify(readdirSync(dir).sort());
}

describe('aiwg use decision-engine --provider hermes (#2873)', () => {
  let projectDir: string;
  let frameworkRoot: string;
  let hermesHome: string;
  let tmpHome: string;
  let tempDirs: string[];

  beforeEach(async () => {
    for (const name of SCRUBBED_ENV_VARS) savedEnv.set(name, process.env[name]);
    projectDir = tmp('aiwg-2873-project-');
    frameworkRoot = tmp('aiwg-2873-fwroot-');
    tmpHome = tmp('aiwg-2873-home-');
    const hermesBase = tmp('aiwg-2873-hermes-');
    hermesHome = join(hermesBase, '.hermes');
    tempDirs = [projectDir, frameworkRoot, tmpHome, hermesBase];
    // Isolate the process home (os.homedir() honors $HOME on POSIX, and the
    // spawned deploy subprocesses inherit env) plus every shared/config root
    // the pipeline could otherwise resolve against the operator's machine.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.HERMES_HOME = hermesHome;
    process.env.XDG_DATA_HOME = tmp('aiwg-2873-xdg-data-');
    process.env.XDG_CONFIG_HOME = tmp('aiwg-2873-xdg-config-');
    process.env.XDG_CACHE_HOME = tmp('aiwg-2873-xdg-cache-');
    process.env.XDG_STATE_HOME = tmp('aiwg-2873-xdg-state-');
    tempDirs.push(
      process.env.XDG_DATA_HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_CACHE_HOME,
      process.env.XDG_STATE_HOME,
    );
    delete process.env.AIWG_ROOT;
    delete process.env.AIWG_HOME;
    await writeAiwgConfig(projectDir, emptyConfig(['hermes']));
  });

  afterEach(() => {
    for (const name of SCRUBBED_ENV_VARS) {
      const saved = savedEnv.get(name);
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
    savedEnv.clear();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('deploys an addon requiring aiwg-utils to hermes with support assets', { timeout: 120000 }, async () => {
    writeSyntheticFrameworkRoot(frameworkRoot);
    // The legacy migration must act inside the HERMES_HOME-derived tree only:
    // seed both the legacy path and the populated new path up front so the
    // first deploy already performs the migration.
    mkdirSync(join(hermesHome, '.aiwg', 'skills'), { recursive: true });
    writeFileSync(join(hermesHome, '.aiwg', 'skills', 'legacy-sentinel.md'), '# legacy\n');
    mkdirSync(join(hermesHome, 'skills', '.aiwg', 'seed'), { recursive: true });
    writeFileSync(join(hermesHome, 'skills', '.aiwg', 'seed', 'SKILL.md'), '# seed\n');
    const realHomeBefore = realHomeHermesState();
    const useHandler = await freshUseHandler();
    const args = ['decision-engine', '--copy-all', '--provider', 'hermes', '--target', projectDir];

    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.exitCode).toBe(0);
    const agents = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    const routing = readFileSync(join(projectDir, '.hermes.md'), 'utf8');
    console.info(`Hermes decision-engine addon: AGENTS.md=${agents.length}, .hermes.md=${routing.length} chars`);
    expect(agents.length).toBeLessThanOrEqual(19000);
    expect(routing.length).toBeLessThanOrEqual(19000);
    expect(agents).toContain('hermes: Before every task and subagent task, read and follow `.hermes/rules/RULES-INDEX.md`');
    expect(readFileSync(join(projectDir, '.hermes/rules/critical-probe.md'), 'utf8')).toContain('# Critical probe\n\nCRITICAL_ADDON_BODY must remain verbatim.');
    expect(readFileSync(join(projectDir, '.hermes/rules/fetch-probe.md'), 'utf8')).toContain('NONCRITICAL_ADDON_BODY must be fetched.');
    expect(readFileSync(join(projectDir, '.hermes/rules/RULES-INDEX.md'), 'utf8')).toContain('[fetch-probe.md](./fetch-probe.md)');
    expect(agents).not.toContain('CRITICAL_ADDON_BODY');
    expect(agents).not.toContain('NONCRITICAL_ADDON_BODY');
    // Kernel-tier skill lands at the platform-native skills root...
    expect(existsSync(join(hermesHome, 'skills', 'kern-probe', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(hermesHome, 'skills', 'kern-probe', 'SKILL.md'), 'utf8')).toContain('Kernel probe body');
    expect(readFileSync(join(hermesHome, 'skills', 'kern-probe', 'references', 'notes.md'))).toEqual(
      readFileSync(join(frameworkRoot, 'agentic', 'code', 'addons', 'aiwg-utils', 'skills', 'kern-probe', 'references', 'notes.md')),
    );
    // ...while standard-tier skills land under the namespaced tier with
    // byte-identical support assets.
    expect(existsSync(join(hermesHome, 'skills', '.aiwg', 'sess-probe', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(hermesHome, 'skills', '.aiwg', 'sess-probe', 'SKILL.md'), 'utf8')).toContain('Probe body');
    expect(readFileSync(join(hermesHome, 'skills', '.aiwg', 'sess-probe', 'references', 'recipes.md'))).toEqual(
      readFileSync(join(frameworkRoot, 'agentic', 'code', 'addons', 'aiwg-utils', 'skills', 'sess-probe', 'references', 'recipes.md')),
    );
    expect(existsSync(join(hermesHome, 'skills', '.aiwg', 'de-check', 'SKILL.md'))).toBe(true);
    // Installed-state record is written for the requested addon.
    const config = await readAiwgConfig(projectDir);
    expect(config?.installed?.['decision-engine']).toBeDefined();
    // Existing legacy payload remains for review; no process-home writes escape HERMES_HOME.
    expect(readFileSync(join(hermesHome, '.aiwg', 'skills', 'legacy-sentinel.md'), 'utf8')).toBe('# legacy\n');
    expect(existsSync(join(tmpHome, '.hermes'))).toBe(false);
    // Nothing under the operator's real home was touched.
    expect(realHomeHermesState()).toBe(realHomeBefore);
    // No host configuration leaked into the run.
    expect(process.env.AIWG_ROOT).toBeUndefined();
    expect(process.env.AIWG_HOME).toBeUndefined();
    expect(process.env.HOME).toBe(tmpHome);
    expect(process.env.XDG_DATA_HOME?.startsWith(tmpdir())).toBe(true);
  });
});
