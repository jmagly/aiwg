// Resolve existing provider skill roots and projection limits.
import os from 'node:os';
import path from 'node:path';
import { getProviderDefinition, normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { resolveHermesHomePath } from '../providers/hermes-home.js';
import { museXdgSkillsDirRemediation, resolveMuseXdgSkillsDir } from '../providers/muse-paths.js';
import { GROKBOT_SKILLS_DIR_ENV, grokbotMissingRootRemediation, resolveGrokbotSkillsDir } from '../providers/grokbot-paths.js';
import type { AgentSkillDeploymentOptions } from './types.js';
import type { AgentSkillProjectionStatus } from './agent-skills.js';
import { fail, type ProjectionPolicy } from './deployment-types.js';

function resolvedHome(options: AgentSkillDeploymentOptions): string {
  return path.resolve(options.homeDir ?? os.homedir());
}

export function resolvePolicy(
  target: string,
  options: AgentSkillDeploymentOptions,
): ProjectionPolicy {
  const provider = normalizeProviderDefinitionId(target);
  if (!provider) {
    fail('AS_DEPLOY_PROVIDER', `unknown Agent Skills target "${target}"`);
  }
  const definition = getProviderDefinition(provider);
  if (!definition) {
    fail('AS_DEPLOY_PROVIDER', `provider definition is unavailable for "${provider}"`);
  }

  const namespace = definition.skillNamespace;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let root = namespace.pathType === 'home-dir'
    ? path.join(resolvedHome(options), namespace.skillsBaseDir)
    : path.join(path.resolve(options.projectDir), namespace.skillsBaseDir);
  let status: AgentSkillProjectionStatus = 'native';
  let supported = true;
  let appendToDescription: string | undefined;
  let maxDescriptionLength: number | undefined;

  switch (provider) {
    case 'codex':
      root = path.join(path.resolve(options.projectDir), '.agents', 'skills');
      status = 'projected';
      maxDescriptionLength = namespace.maxDescriptionLength;
      reasons.push(
        'uses the project .agents/skills compatibility surface without the legacy 100/500 truncation transform',
      );
      break;
    case 'flue':
      maxDescriptionLength = namespace.maxDescriptionLength;
      reasons.push('uses the project-only .agents/skills surface; app skills must be explicitly mounted');
      if (options.scope === 'user') {
        status = 'unsupported';
        supported = false;
        reasons.push('Flue (experimental) supports project scope only');
      }
      break;
    case 'factory':
      status = 'projected';
      appendToDescription = namespace.appendToDescription;
      reasons.push('applies the Factory description guidance before strict validation');
      break;
    case 'grokbot': {
      // Fail closed: never invent ~/grokbot-skills or ~/.grokbot.
      const configured = resolveGrokbotSkillsDir(process.env);
      if (!configured) {
        root = '';
        status = 'unsupported';
        supported = false;
        reasons.push(grokbotMissingRootRemediation(process.env));
        warnings.push(
          `Agent Skills deploy for grokbot requires absolute ${GROKBOT_SKILLS_DIR_ENV}; no filesystem root was invented`,
        );
      } else {
        root = configured;
        reasons.push(
          `uses the operator-configured ${GROKBOT_SKILLS_DIR_ENV} skills root with strict managed ownership markers`,
        );
      }
      break;
    }
    case 'hermes':
      if (options.homeDir === undefined) {
        root = resolveHermesHomePath('skills');
      }
      reasons.push(
        'uses the active HERMES_HOME skills surface with strict managed ownership markers',
      );
      break;
    case 'muse': {
      // ADR scope rule 1: the default projection is the project
      // <repo>/.agents/skills surface shared with antigravity, codex, and
      // deepseek-harness. Muse reads both that root and its XDG user root,
      // so writing the user root by default would list a skill twice.
      // #234: an explicit user scope resolves the documented XDG root at
      // deploy time — never ~/.muse — and bad XDG metadata fails closed.
      if (options.scope === 'user') {
        const home = resolvedHome(options);
        const configured = resolveMuseXdgSkillsDir(process.env, home);
        if (!configured) {
          root = '';
          status = 'unsupported';
          supported = false;
          reasons.push(museXdgSkillsDirRemediation(process.env, home));
          warnings.push(
            'Agent Skills deploy for muse requires a valid absolute XDG_CONFIG_HOME; no filesystem root was invented',
          );
        } else {
          root = configured;
          reasons.push(
            'uses the Muse XDG user skills root ($XDG_CONFIG_HOME/muse/skills, default ~/.config/muse/skills) with strict managed ownership markers',
          );
        }
      } else {
        reasons.push(
          'uses the project .agents/skills surface shared with antigravity, codex, and deepseek-harness',
        );
      }
      break;
    }
    case 'openhuman':
      status = 'projected';
      reasons.push(
        'uses the verified global one-level ~/.openhuman/skills layout',
      );
      break;
    case 'windsurf':
      status = 'projected';
      reasons.push(
        'uses one skill bundle directly below the one-level .windsurf/skills surface',
      );
      break;
    default:
      reasons.push('provider exposes a native recursive Agent Skills bundle surface');
  }

  return {
    provider,
    root,
    status,
    supported,
    reasons,
    warnings,
    appendToDescription,
    maxDescriptionLength,
  };
}

