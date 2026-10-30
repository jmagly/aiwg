// Project command-shaped skills into provider command surfaces.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { addManagedMarker, collectFrameworkArtifacts, contentHash, extractFrameworkSlug, getAddonSkillDirs, listSkillDirs, parseFrontmatter, updateSidecarManifest } from "./providers/base.mjs";

const MIRRORED_STANDARD_COMMAND_SKILLS = new Set([
  'aiwg-setup-project',
  'aiwg-update-claude',
  'aiwg-update-agents-md',
  'sdlc-accelerate',
  'project-status',
  'intake-wizard',
  'intake-from-codebase',
  'intake-start',
  // Issue-workflow entry commands — invoked directly by users; mirror as
  // commands so they reach .opencode/command/, .claude/commands/, etc. (#1549).
  'address-issues',
  'issue-audit',
]);

const MIRRORED_KERNEL_COMMAND_SKILLS = new Set([
  'aiwg-refresh',
  'aiwg-doctor',
  'aiwg-status',
  'aiwg-help',
  'aiwg-regenerate',
  'aiwg-regenerate-claude',
  'aiwg-regenerate-codex',
  'aiwg-regenerate-opencode',
  'aiwg-regenerate-agents',
  'aiwg-issue',
  'aiwg-pr',
  'aiwg-mission',
  'use',
  'steward',
]);


const DEFAULT_COMMAND_MIRROR_POLICY = { standard: MIRRORED_STANDARD_COMMAND_SKILLS, kernel: MIRRORED_KERNEL_COMMAND_SKILLS };

function providerUsesSkillsNatively(providerName) {
  return ['antigravity', 'claude', 'cursor', 'deepseek-harness', 'hermes', 'openhuman', 'pi', 'omp'].includes(providerName);
}

function shouldMirrorStandardCommandSkill(skillName, policy) {
  return (
    skillName.startsWith('flow-') ||
    policy.standard.has(skillName)
  );
}

function shouldMirrorCommandSkill(providerName, skillName, policy) {
  if (policy.kernel.has(skillName)) {
    return !providerUsesSkillsNatively(providerName);
  }

  return shouldMirrorStandardCommandSkill(skillName, policy);
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

export function collectMirrorSkillDirs(srcRoot, mode, providerName) {
  const dirs = [];

  const directSkillsDir = path.join(srcRoot, 'skills');
  dirs.push(...listSkillDirs(directSkillsDir));

  // If --source itself is a skills directory, support that shape too.
  dirs.push(...listSkillDirs(srcRoot));

  const repoFrameworksRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(repoFrameworksRoot)) {
    const artifacts = collectFrameworkArtifacts(srcRoot, mode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    dirs.push(...artifacts.skills);
    // Pi's provider collector already deploys all eligible addon skills for
    // every root framework mode. Mirror the command-shaped addon skills in
    // that same root pass so `aiwg use` does not need to repeat the entire
    // deployment once per addon merely to produce these wrappers. Keep addon
    // skills after framework skills: this preserves the existing per-addon
    // winner when a framework and addon expose the same command name.
    if (mode === 'all'
      || (providerName === 'pi' && ['general', 'sdlc', 'both'].includes(mode))) {
      dirs.push(...getAddonSkillDirs(srcRoot));
    }
  }

  return uniquePaths(dirs);
}

function resolveCommandMirrorDir(provider, target) {
  const commandsPath = provider.paths?.commands;
  if (commandsPath) {
    return path.isAbsolute(commandsPath) ? commandsPath : path.join(target, commandsPath);
  }

  // Closest conventional location for providers whose primary command
  // surface is MCP/aggregation rather than a documented command directory.
  if (provider.name === 'hermes') {
    // #2119: HERMES_HOME is the single source of truth the running Hermes
    // runtime uses to locate its files — resolve the home the same way the
    // provider does instead of hardcoding $HOME/.hermes.
    const hermesHome = typeof provider.getHermesHome === 'function'
      ? provider.getHermesHome()
      : path.join(os.homedir(), '.hermes');
    return path.resolve(hermesHome, 'commands');
  }

  return null;
}

function commandFileExtensionForProvider(provider) {
  if (provider.name === 'copilot') return '.prompt.md';
  return '.md';
}

function resolveSkillCommandPolicy(commandHint = {}) {
  const legacy = String(commandHint.model || '').trim().toLowerCase();
  const legacyRole = legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency'
      : legacy ? 'coding' : null;
  const modelRole = commandHint.modelRole || legacyRole;
  if (!modelRole) return null;
  const modelTier = commandHint.modelTier
    || (modelRole === 'reasoning' ? 'premium'
      : modelRole === 'efficiency' ? 'economy' : 'standard');
  return {
    modelRole,
    modelTier,
    modelEffort: commandHint.modelEffort,
    modelRationale: commandHint.modelRationale,
  };
}

function parseSkillCommandHint(raw) {
  const { frontmatter } = parseFrontmatter(raw);
  const block = frontmatter?.match(/^commandHint:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] || '';
  const hint = {};
  for (const line of block.split('\n')) {
    const match = line.trim().match(/^(model|modelRole|modelTier|modelEffort|modelRationale):\s*(.+)$/);
    if (match) hint[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return hint;
}

function skillToCommandContent(skillDir) {
  const skillName = path.basename(skillDir);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { metadata, body } = parseFrontmatter(raw);
  const description = metadata.description || `Run AIWG skill ${skillName}`;
  const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
  const policyLines = policy ? [
    `aiwg-model-role: ${policy.modelRole}`,
    `aiwg-model-tier: ${policy.modelTier}`,
    ...(policy.modelEffort ? [`aiwg-model-effort: ${policy.modelEffort}`] : []),
    ...(policy.modelRationale ? [`aiwg-model-rationale: ${policy.modelRationale}`] : []),
  ] : [];

  return `---\nname: ${skillName}\ndescription: ${description}\n${policyLines.join('\n')}${policyLines.length ? '\n' : ''}---\n\n${body.trim()}\n`;
}

export function mirrorSkillsAsCommands(provider, target, srcRoot, opts) {
  if (!opts.deployCommands && !opts.commandsOnly) return 0;
  const policy = opts.commandMirrorPolicy ?? DEFAULT_COMMAND_MIRROR_POLICY;

  const targetDir = resolveCommandMirrorDir(provider, target);
  if (!targetDir) return 0;

  const skillDirs = collectMirrorSkillDirs(srcRoot, opts.mode, provider.name)
    .filter((dir) => shouldMirrorCommandSkill(provider.name, path.basename(dir), policy));

  if (skillDirs.length === 0) return 0;
  if (!opts.dryRun) fs.mkdirSync(targetDir, { recursive: true });

  const ext = commandFileExtensionForProvider(provider);
  const deployedEntries = [];
  let count = 0;

  for (const skillDir of skillDirs) {
    const skillName = path.basename(skillDir);
    let content = skillToCommandContent(skillDir);
    if (typeof provider.transformCommand === 'function') {
      content = provider.transformCommand(path.join(skillDir, `${skillName}.md`), content, opts);
    }
    // #2507: mirrored wrappers used to be written with no ownership signal, so
    // AIWG could neither count them as deployed nor prune them when the source
    // skill went away — a later run reported its own 46 wrappers as unmanaged
    // artifacts the operator should delete. They carry the same managed marker
    // and sidecar entry as any other deployed command now.
    content = addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');

    const filename = `${skillName}${ext}`;
    const dest = path.join(targetDir, filename);
    if (opts.dryRun) {
      if (opts.verbose) console.log(`[dry-run] mirror skill command ${skillName} -> ${dest}`);
      const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
      if (policy && opts.verbose) {
        const outcome = provider.name === 'claude' ? 'native'
          : provider.name === 'factory' ? 'informational' : 'unsupported';
        console.log(`[dry-run] skill model policy ${skillName}: ${outcome} (${policy.modelRole}/${policy.modelTier})`);
      }
    } else {
      fs.writeFileSync(dest, content, 'utf8');
    }
    const sourcePath = path.join(skillDir, 'SKILL.md');
    deployedEntries.push({ filename, hash: contentHash(content), kind: 'skill-command', sourcePath,
      frameworkSlug: extractFrameworkSlug(opts.logicalInputPath?.(sourcePath) || sourcePath) });
    count++;
  }

  if (deployedEntries.length > 0) {
    updateSidecarManifest(targetDir, deployedEntries, {
      dryRun: opts.dryRun,
      version: opts.deployVersion || 'unknown',
      source: opts.deploySource || 'bundled',
    });
  }

  return count;
}
