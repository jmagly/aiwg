/**
 * Muse Code provider (experimental).
 *
 * Muse-native skill roots (docs/architecture/adr-muse-provider-target.md):
 *   - Project scope: `<target>/.agents/skills/<id>/SKILL.md`
 *     (Muse project skills convention; kernel → `.agents/skills/`,
 *      standard tier → opt-in `.agents/.aiwg/skills/` via --copy-all).
 *   - User scope: `$XDG_CONFIG_HOME/muse/skills`
 *     (default `~/.config/muse/skills`; resolved fail-closed by
 *     muse-paths.mjs, which mirrors src/providers/muse-paths.ts).
 *
 * The CLI's `--scope user` mirror consumes `USER_SCOPE_PATHS.muse` for the
 * user landing path; a direct writer call with `opts.scope === 'user'`
 * deploys straight to the resolved XDG root.
 *
 * Guarantees:
 *   - Never targets `.cursor/` (any such resolution throws fail-closed).
 *   - Never invents `~/.muse`, `~/.config/muse` siblings outside
 *     `muse/skills`, or `~/.agents/skills` as a write target.
 *   - Operator-owned skills are preserved via the base.mjs managed markers
 *     (`.aiwg-managed` sidecar): only recorded AIWG entries are ever
 *     removed; unmanaged content is byte-identical across deploys.
 *   - `--dry-run` performs zero writes.
 *
 * The discover-first AGENTS.md bridge is written by `createAgentsMd`, rendered from
 * `agentic/code/frameworks/sdlc-complete/templates/muse/AGENTS.md.aiwg-template`
 * into an AIWG-managed section (operator content outside the markers is
 * preserved). Hooks/MCP settings are handled by muse-hooks.mjs:
 * managed project hooks merge additively into `.muse/hooks.json` (default
 * on, `--no-hooks` opts out), and the optional MCP settings profile enriches
 * user `mcp_servers` only with the explicit `--mcp` flag.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectFrameworkArtifacts,
  createAgentsMdFromTemplate,
  deploySkillsWithKernelRouting,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  resolveAiwgRoot,
} from './base.mjs';
import {
  resolveMuseXdgSkillsDir,
  museXdgSkillsDirRemediation,
} from './muse-paths.mjs';
import { deployMuseHooks, deployMuseMcp } from './muse-hooks.mjs';

export const name = 'muse';
export const aliases = []; // ADR: no aliases (no muse-spark, muse-code, spark, meta)

// Project-relative paths. Skills deploy into the Muse-native project skills
// root; agents/commands/rules have no file surface in this wave (indexed via
// aiwg discover / aiwg show). The discover-first AGENTS.md bridge renders
// via createAgentsMd below.
export const paths = {
  agents: '',
  commands: '',
  skills: '.agents/skills',
  rules: '',
};

// Kernel skills land at the project skills root itself.
export const kernelSkillsPath = '.agents/skills';

// Opt-in standard-tier mirror (only with --copy-all): siblings of the
// project skills root, never the user XDG root and never ~/.agents/skills.
const STANDARD_MIRROR_SUBDIR = '.agents/.aiwg/skills';

export const support = {
  agents: 'indexed',
  commands: 'indexed',
  skills: 'native',
  rules: 'indexed',
};

export const capabilities = {
  skills: true,
  rules: false,
  aggregatedOutput: false,
  yamlFormat: true,
  homeDirectoryDeploy: true, // --scope user lands under the operator's XDG home
};

export function mapModel(originalModel) {
  return originalModel;
}

export function transformAgent(_srcPath, content) {
  return content;
}

export function transformCommand(_srcPath, content) {
  return content;
}

export function deployAgents() {
  return 0;
}

export function deployCommands() {
  return 0;
}

export function deployRules() {
  return 0;
}

/**
 * Fail-closed guard: Muse never deploys into a `.cursor` tree — the
 * cursor-overload anti-pattern called out in the ADR.
 */
export function assertNotCursorTarget(dir, what) {
  const segments = path.normalize(String(dir)).split(path.sep);
  if (segments.includes('.cursor')) {
    throw new Error(
      `Refusing to deploy Muse ${what} into a .cursor path (${dir}). ` +
        'Muse skills deploy to .agents/skills (project) or $XDG_CONFIG_HOME/muse/skills (user).',
    );
  }
  return dir;
}

/**
 * Resolve the user-scope skills target for this writer. Fail closed: bad
 * XDG metadata throws with the remediation message instead of inventing a
 * bogus tree.
 */
export function assertMuseUserSkillsDir(env = process.env, userHome = os.homedir()) {
  const resolved = resolveMuseXdgSkillsDir(env, userHome);
  if (!resolved) {
    const err = new Error(museXdgSkillsDirRemediation(env, userHome));
    err.code = 'MUSE_XDG_UNSET';
    throw err;
  }
  return assertNotCursorTarget(resolved, 'user skills');
}

/**
 * Deploy skills to the Muse-native roots.
 *
 * Kernel skills → `<target>/.agents/skills/` at project scope, or the
 * resolved `$XDG_CONFIG_HOME/muse/skills` when `opts.scope === 'user'`.
 * Standard tier stays index-discovered unless `--copy-all` opts in, in
 * which case it mirrors to `<target>/.agents/.aiwg/skills/` (project scope
 * only — never silently into the user root or `~/.agents/skills`).
 */
export function deploySkills(skillDirs, targetDir, opts = {}) {
  const userScope = opts.scope === 'user';
  const userRoot = userScope
    ? assertMuseUserSkillsDir(opts.env || process.env, opts.userHome || os.homedir())
    : null;

  const kernelDest = userScope ? userRoot : path.join(targetDir, kernelSkillsPath);
  const standardDest = userScope ? null : path.join(targetDir, STANDARD_MIRROR_SUBDIR);

  assertNotCursorTarget(kernelDest, 'skills');
  if (standardDest) assertNotCursorTarget(standardDest, 'standard skills');

  if (!opts.quiet) {
    console.log(
      `\n  Muse skills root: ${kernelDest}` +
        (userScope ? ' (user scope, from XDG_CONFIG_HOME)' : ' (project scope)') +
        (opts.dryRun ? ' [dry-run]' : ''),
    );
  }

  const result = deploySkillsWithKernelRouting(skillDirs, standardDest, kernelDest, {
    ...opts,
    provider: name,
    copyStandardSkills: !userScope && opts.copyStandardSkills === true,
  });

  // Holistic post-deploy cleanup of stale AIWG-managed kernel skills, bound
  // by managed markers so operator-owned skills survive. computeAllKernelNames
  // returns null when no AIWG tree is locatable — skip rather than prune on
  // an empty desired set.
  if (!opts.dryRun && opts.srcRoot) {
    const kernelNames = computeAllKernelNames(opts.srcRoot);
    if (kernelNames != null) {
      pruneStaleAiwgSkills(kernelDest, [...kernelNames], opts);
    }
  }

  return result;
}

export function getFileExtension() {
  return '.md';
}

/**
 * Render the discover-first AGENTS.md bridge from the muse template (#227).
 * The template section is wrapped in AIWG-managed markers; operator content
 * outside the markers is preserved on redeploy, and the managed section is
 * updated in place when the template changes.
 */
export function createAgentsMd(target, srcRoot, dryRun) {
  assertSafeAgentsMd(target);
  const aiwgRoot = resolveAiwgRoot(srcRoot) || srcRoot;
  createAgentsMdFromTemplate(target, aiwgRoot, 'muse/AGENTS.md.aiwg-template', dryRun);
}

/** Refuse to write AGENTS.md through a symlink or onto a non-file. */
function assertSafeAgentsMd(target) {
  const dest = path.join(target, 'AGENTS.md');
  let stat;
  try {
    stat = fs.lstatSync(dest);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Muse AGENTS.md target: ${dest}`);
  }
}

export async function postDeploy(targetDir, opts = {}) {
  const fullDeploy = !opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly;
  if (opts.createAgentsMd || fullDeploy) {
    createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }

  // #228 — managed project hooks (.muse/hooks.json). Default on, mirroring
  // the Claude provider's autoInstall policy; the operator opts out with
  // --no-hooks (opts.hooks === false). Project-scoped only: at user scope
  // there is no project hooks.json to manage.
  if (fullDeploy && opts.hooks !== false && opts.scope !== 'user') {
    deployMuseHooks(targetDir, opts);
  }

  // #228 — optional MCP settings profile. Explicit opt-in only (--mcp);
  // default `aiwg use --provider muse` never touches user settings.
  if (fullDeploy && opts.mcp === true) {
    deployMuseMcp(opts);
  }

  if (!opts.quiet) {
    const root = opts.scope === 'user'
      ? assertMuseUserSkillsDir(opts.env || process.env, opts.userHome || os.homedir())
      : path.join(targetDir, kernelSkillsPath);
    console.log(`\nMuse Code: skills deployed to ${root}`);
    console.log('  Rules/agents surface through `aiwg discover` / `aiwg show`; the discover-first');
    console.log('  AGENTS.md bridge is managed above.');
    if (opts.hooks === false) {
      console.log('  Hooks skipped (--no-hooks).');
    } else if (opts.scope !== 'user') {
      console.log('  Managed hooks merged into .muse/hooks.json (--no-hooks to skip).');
    }
    if (opts.mcp === true) {
      console.log('  MCP profile merged into user settings mcp_servers (--mcp).');
    } else {
      console.log('  MCP profile not installed (opt in with --mcp).');
    }
    console.log('  Trust the workspace when prompted, then start a new Muse session to load the bridge.');
  }
}

export async function deploy(opts = {}) {
  const {
    srcRoot,
    target,
    mode,
    deploySkills: shouldDeploySkills,
    skillsOnly,
    commandsOnly,
    rulesOnly,
  } = opts;

  if (!opts.quiet) {
    console.log(`\n=== Muse Code Provider (experimental) ===`);
    console.log(`Target: ${target}`);
    console.log(`Mode: ${mode}`);
    if (opts.dryRun) console.log('Dry-run: no filesystem mutations');
  }

  // Fail closed when a direct caller requests user scope without usable XDG
  // metadata — the CLI's --scope user mirror handles the normal path via
  // USER_SCOPE_PATHS.muse.
  if (opts.scope === 'user') {
    assertMuseUserSkillsDir(opts.env || process.env, opts.userHome || os.homedir());
  }

  const skillDirs = [];
  const normalizedMode = normalizeDeploymentMode(mode);

  if (['general', 'sdlc', 'both', 'all'].includes(normalizedMode)) {
    if (shouldDeploySkills || skillsOnly) skillDirs.push(...getAddonSkillDirs(srcRoot));
  }

  const fw = collectFrameworkArtifacts(srcRoot, normalizedMode, {
    includeAgents: false,
    includeCommands: false,
    includeSkills: shouldDeploySkills || skillsOnly,
    includeRules: false,
  });
  skillDirs.push(...(fw.skills || []));

  let count = 0;
  if ((shouldDeploySkills || skillsOnly) && !commandsOnly && !rulesOnly) {
    const result = deploySkills(skillDirs, target, opts);
    count += result.kernel + result.standardCopied;
  } else if (!opts.quiet) {
    console.log('  No skills requested for deploy');
  }

  await postDeploy(target, opts);
  return count;
}

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  support,
  capabilities,
  mapModel,
  transformAgent,
  transformCommand,
  deployAgents,
  deployCommands,
  deploySkills,
  deployRules,
  assertNotCursorTarget,
  assertMuseUserSkillsDir,
  createAgentsMd,
  postDeploy,
  getFileExtension,
  deploy,
};
