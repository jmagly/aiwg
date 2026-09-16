/**
 * Grok Bot provider (experimental).
 *
 * Discover-first project bridge + fail-closed user skill root.
 * Never targets `.cursor/**` or invents `~/.grokbot`.
 *
 * User-scope skill writes require AIWG_GROKBOT_SKILLS_DIR (absolute path).
 * See `docs/architecture/adr-grokbot-provider-target.md` and #203–#208.
 */

import path from 'path';
import os from 'os';
import {
  collectFrameworkArtifacts,
  createAgentsMdFromTemplate,
  deploySkillsWithKernelRouting,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  resolveAiwgRoot,
} from './base.mjs';

export const name = 'grokbot';
export const aliases = [];

const SKILLS_DIR_ENV = 'AIWG_GROKBOT_SKILLS_DIR';

/**
 * Resolve configured Grok Bot skills directory (fail-closed).
 * Mirrors src/providers/grokbot-paths.ts for the JS deploy path.
 */
export function resolveGrokbotSkillsDir(env = process.env, userHome = os.homedir()) {
  const raw = (env[SKILLS_DIR_ENV] || '').trim();
  if (!raw) return null;
  let expanded = raw;
  if (raw === '~') return null;
  if (raw.startsWith('~/')) expanded = path.join(userHome, raw.slice(2));
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  if (!resolved || resolved === path.sep) return null;
  return resolved;
}

export function getGrokbotMissingRootMessage(env = process.env) {
  const raw = (env[SKILLS_DIR_ENV] || '').trim();
  if (!raw) {
    return (
      `Grok Bot user-scope skill root is not configured. Set ${SKILLS_DIR_ENV} ` +
      'to the absolute path of the Grok Bot skills/workflows directory before ' +
      'using --scope user or --global. AIWG does not invent ~/.grokbot.'
    );
  }
  if (raw === '~' || (!raw.startsWith('~/') && !path.isAbsolute(raw))) {
    return (
      `${SKILLS_DIR_ENV} must be an absolute path (got '${raw}'). ` +
      'Relative values and bare ~ are rejected.'
    );
  }
  if (raw.startsWith('~/')) {
    const expanded = path.join(os.homedir(), raw.slice(2));
    if (!path.isAbsolute(path.resolve(expanded))) {
      return `${SKILLS_DIR_ENV} must resolve to an absolute path (got '${raw}').`;
    }
  }
  return (
    `Grok Bot skill root '${raw}' is not usable. Set ${SKILLS_DIR_ENV} to a ` +
    'valid absolute directory.'
  );
}

// Project-relative paths stay empty: agents/commands/rules are indexed.
// Skills path is absolute only when the operator configured the env override;
// otherwise '' so project deploy skips native skill copies.
function configuredSkillsPath() {
  return resolveGrokbotSkillsDir() || '';
}

export const paths = {
  agents: '',
  commands: '',
  get skills() {
    return configuredSkillsPath();
  },
  rules: '',
};

// Empty when unset — deploySkills resolves AIWG_GROKBOT_SKILLS_DIR dynamically.
// Never default to ~/.grokbot.
export const kernelSkillsPath = '';

export const support = {
  agents: 'indexed',
  commands: 'indexed',
  skills: 'native-when-configured',
  rules: 'indexed',
};

export const capabilities = {
  skills: true,
  rules: false,
  aggregatedOutput: false,
  yamlFormat: false,
  homeDirectoryDeploy: true,
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
 * Deploy skills only when AIWG_GROKBOT_SKILLS_DIR is configured.
 * Kernel → configured root; standard → index/discovery unless --copy-all
 * (then `<root>/.aiwg/skills`).
 */
export function deploySkills(skillDirs, targetDir, opts = {}) {
  const root = resolveGrokbotSkillsDir(opts.env || process.env);
  if (!root) {
    if (!opts.quiet) {
      console.log(
        `\n  Grok Bot: skipping native skill copy (${SKILLS_DIR_ENV} unset). ` +
          'Skills remain available via aiwg discover / aiwg show.',
      );
    }
    return 0;
  }

  if (root.includes(`${path.sep}.cursor${path.sep}`) || root.endsWith(`${path.sep}.cursor`) || root.includes('/.cursor/') || root.endsWith('/.cursor')) {
    throw new Error(
      `Refusing to deploy Grok Bot skills into a .cursor path (${root}). ` +
        `Set ${SKILLS_DIR_ENV} to the Grok Bot skills root, not Cursor.`,
    );
  }

  const kernelDest = root;
  const standardDest = path.join(root, '.aiwg', 'skills');
  if (!opts.quiet) {
    console.log(
      `\n  Grok Bot skills root: ${root} (from ${SKILLS_DIR_ENV})` +
        (opts.dryRun ? ' [dry-run]' : ''),
    );
  }
  return deploySkillsWithKernelRouting(skillDirs, standardDest, kernelDest, {
    ...opts,
    copyStandardSkills: opts.copyStandardSkills === true,
  });
}

export function createAgentsMd(target, srcRoot, dryRun) {
  const aiwgRoot = resolveAiwgRoot(srcRoot) || srcRoot;
  createAgentsMdFromTemplate(target, aiwgRoot, 'grokbot/AGENTS.md.aiwg-template', dryRun);
}

export async function postDeploy(targetDir, opts = {}) {
  if (
    opts.createAgentsMd ||
    (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)
  ) {
    createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    const root = resolveGrokbotSkillsDir(opts.env || process.env);
    if (root) {
      console.log(
        'Grok Bot: after deploy, start a new agent chat or re-read skills. ' +
          'Live refresh is not claimed until product behavior is verified.',
      );
    } else {
      console.log(
        `Grok Bot: project bridge only. Set ${SKILLS_DIR_ENV} for user-scope skill deploy.`,
      );
    }
  }
}

export function getFileExtension() {
  return '.md';
}

/**
 * Assert user-scope is allowed. Called when the orchestrator is mirroring
 * to user scope or when opts.scope === 'user'.
 */
export function assertUserScopeConfigured(opts = {}) {
  const root = resolveGrokbotSkillsDir(opts.env || process.env);
  if (!root) {
    const err = new Error(getGrokbotMissingRootMessage(opts.env || process.env));
    err.code = 'GROKBOT_SKILLS_DIR_UNSET';
    throw err;
  }
  return root;
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
    scope,
  } = opts;

  if (!opts.quiet) {
    console.log(`\n=== Grok Bot Provider (experimental) ===`);
    console.log(`Target: ${target}`);
    console.log(`Mode: ${mode}`);
    const root = resolveGrokbotSkillsDir(opts.env || process.env);
    console.log(
      `Skills root: ${root || `(unset — set ${SKILLS_DIR_ENV} for user-scope writes)`}`,
    );
    if (opts.dryRun) console.log('Dry-run: no filesystem mutations');
  }

  // Fail closed when caller explicitly requested user scope without a root.
  if (scope === 'user' || opts.userScope === true) {
    assertUserScopeConfigured(opts);
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
  skillDirs.push(...fw.skills);

  let count = 0;
  if ((shouldDeploySkills || skillsOnly) && !commandsOnly && !rulesOnly) {
    count += deploySkills(skillDirs, target, opts);
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
  createAgentsMd,
  postDeploy,
  getFileExtension,
  deploy,
  resolveGrokbotSkillsDir,
  getGrokbotMissingRootMessage,
  assertUserScopeConfigured,
};
