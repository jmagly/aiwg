/**
 * Command Extension Definitions
 *
 * Defines Extension objects for all CLI commands. Maps command handlers to the
 * unified Extension schema for discovery, semantic search, and help generation.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @architecture @.aiwg/architecture/unified-extension-schema.md
 * @source @src/cli/handlers/index.ts
 * @tests @test/unit/extensions/commands/definitions.test.ts
 * @issue #42
 */

import type { CommandMetadata, Extension, SkillMetadata } from '../types.js';

// ============================================
// Individual Command Definitions
// ============================================

// Maintenance Commands

export const helpCommand: Extension = {
  id: 'help',
  type: 'skill',
  name: 'Help',
  description: 'Show all CLI commands, arguments, and usage examples',
  version: '1.0.0',
  capabilities: ['cli', 'help', 'documentation'],
  keywords: ['help', 'usage', 'commands', 'documentation'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['help', 'show commands', 'usage', 'what commands are available'],
    commandHint: {
      template: 'utility',
      allowedTools: [],
    },
  } satisfies SkillMetadata,
};

export const versionCommand: Extension = {
  id: 'version',
  type: 'skill',
  name: 'Version',
  description: 'Show version and channel information',
  version: '1.0.0',
  capabilities: ['cli', 'version', 'info'],
  keywords: ['version', 'info', 'channel'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['version', 'what version', 'show version', 'current version'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const authCommand: Extension = {
  id: 'auth',
  type: 'command',
  name: 'Authentication',
  description: 'Log in, inspect access, and log out of paid AIWG web resources',
  version: '1.0.0',
  capabilities: ['cli', 'authentication', 'resources'],
  keywords: ['auth', 'login', 'logout', 'status', 'releases'],
  category: 'maintenance',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<login|status|logout> [--device] [--json] [--all]',
    allowedTools: ['Bash'],
  } satisfies CommandMetadata,
};

export const doctorCommand: Extension = {
  id: 'doctor',
  type: 'skill',
  name: 'Doctor',
  description: 'Check installation health and diagnose issues',
  version: '1.0.0',
  capabilities: ['cli', 'diagnostics', 'health-check'],
  keywords: ['doctor', 'health', 'diagnostics', 'troubleshooting'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['doctor', 'check health', 'diagnose', 'troubleshoot installation'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--deployment] [--provider <p>] [--bundle <id>] [--scope project|user] [--json]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const contextFirewallCommand: Extension = {
  id: 'context-firewall',
  type: 'skill',
  name: 'Context Firewall',
  description: 'Audit provider context and manage its reviewed digest baseline',
  version: '1.0.0',
  capabilities: ['cli', 'diagnostics', 'security', 'context-budget', 'memory-review'],
  keywords: ['context', 'memory', 'firewall', 'baseline', 'poisoning', 'budget', 'trust'],
  category: 'maintenance',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['audit context', 'context firewall', 'review memory baseline', 'context budget'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const updateCommand: Extension = {
  id: 'update',
  type: 'skill',
  name: 'Update',
  description: 'Update AIWG and re-deploy installed frameworks from registry',
  version: '1.0.0',
  capabilities: ['cli', 'update', 'maintenance', 'deploy', 'refresh'],
  keywords: ['update', 'upgrade', 'maintenance', 'refresh', 'redeploy'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['update', 'upgrade aiwg', 'update aiwg', 'refresh frameworks'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read'],
      argumentHint: '[--all] [--dry-run] [--provider <name>] [--skip-check]',
      executionSteps: [
        'Check for npm/git updates',
        'Read .aiwg/frameworks/registry.json',
        'Re-deploy installed frameworks',
        'Report update summary',
      ],
    },
  } satisfies SkillMetadata,
};

export const installationCommand: Extension = {
  id: 'installation',
  type: 'command',
  name: 'Installation Identity',
  description: 'Inspect, adopt, or deliberately switch the canonical global AIWG installation',
  version: '1.0.0',
  capabilities: ['cli', 'installation', 'update', 'diagnostics', 'recovery'],
  keywords: ['installation', 'canonical', 'adopt', 'switch', 'package-manager', 'drift'],
  category: 'maintenance',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<show|adopt|switch> [--root <path>] [--method <npm|web|source>] [--manager <absolute-path>] [--json]',
    allowedTools: ['Read', 'Write'],
  } satisfies CommandMetadata,
};

// Renamed from `refreshCommand` as part of #694 (avoid collision with git sync
// semantics) and re-linked to `refreshHandler` in #919. Users who type
// `aiwg sync` still reach this handler via its 'sync' alias and see a
// deprecation notice.
export const refreshCommand: Extension = {
  id: 'refresh',
  type: 'skill',
  name: 'Refresh',
  description: 'Refresh AIWG to latest version and re-deploy all frameworks to active provider (formerly: sync)',
  version: '1.0.0',
  capabilities: ['cli', 'refresh', 'sync', 'maintenance', 'deploy', 'self-maintenance'],
  keywords: ['refresh', 'sync', 'update', 'redeploy', 'current', 'latest'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['sync', 'sync aiwg', 'sync to latest', 'redeploy frameworks'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read'],
      argumentHint: '[--provider <name>] [--dry-run] [--frameworks <list>] [--channel <stable|next>] [--skip-update] [--quiet]',
      executionSteps: [
        'Detect active provider via runtime-info',
        'Check current version vs latest on channel',
        'Update package if newer available',
        'Re-deploy all installed frameworks to provider',
        'Run doctor health check',
        'Output sync summary',
      ],
    },
  } satisfies SkillMetadata,
};

// #1266/#1811 — Regenerate the canonical graph and provider adapters without
// redeploying frameworks. Narrower than refresh; faster for context-drift fixes.
export const regenerateCommand: Extension = {
  id: 'regenerate',
  type: 'skill',
  name: 'Regenerate Context Files',
  description: 'Regenerate or transactionally adopt WORKSPACE.md, AIWG.md, and provider adapters without redeploying frameworks',
  version: '1.0.0',
  capabilities: ['cli', 'regenerate', 'context', 'maintenance', 'self-maintenance'],
  keywords: ['regenerate', 'context', 'workspace.md', 'aiwg.md', 'agents.md', 'existing-project', 'redeploy-context'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['regenerate context', 'extract existing project context', 'refresh WORKSPACE.md', 'rewrite AIWG.md', 'fix context files'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read', 'Write'],
      argumentHint: '[--workspace|--existing-project|--full-inject] [--provider <name>] [--dry-run|--apply] [--force]',
      executionSteps: [
        'Detect active provider (or accept --provider override)',
        'Select canonical refresh, transactional existing-project extraction, or legacy inline compatibility',
        'Discover deployed artifacts under provider paths',
        'Refresh the managed WORKSPACE.md graph while preserving its operator region',
        'Regenerate AIWG.md and minimal provider startup adapters',
        'Report which files were written, skipped, or backed up',
      ],
    },
  } satisfies SkillMetadata,
};

export const workspaceContextCommand: Extension = {
  id: 'workspace-context',
  type: 'skill',
  name: 'Workspace Context',
  description: 'Audit, migrate, diagnose, and roll back canonical WORKSPACE.md context',
  version: '1.0.0',
  capabilities: ['cli', 'context', 'audit', 'migration', 'rollback'],
  keywords: ['workspace.md', 'context', 'migration', 'provider', 'doctor'],
  category: 'maintenance',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['audit workspace context', 'migrate context to WORKSPACE.md', 'rollback context migration'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write', 'Bash'],
      argumentHint: 'audit|migrate|rollback|doctor [--dry-run] [--apply] [--json]',
      executionSteps: [
        'Audit provider and nested context sources',
        'Preview deterministic migration output',
        'Apply only when explicitly requested and retain transaction preimages',
        'Run context graph diagnostics or rollback a transaction',
      ],
    },
  } satisfies SkillMetadata,
};

// Framework Management Commands

export const useCommand: Extension = {
  id: 'use',
  type: 'skill',
  name: 'Use',
  description: 'Deploy SDLC, marketing, or writing framework (or addon) to workspace',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'deployment', 'addon'],
  keywords: ['framework', 'install', 'deploy', 'use', 'addon', 'rlm'],
  category: 'framework',
  platforms: {
    claude: 'full',
    copilot: 'full',
    factory: 'full',
    cursor: 'full',
    windsurf: 'full',
    openclaw: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['use framework', 'deploy framework', 'install framework', 'use sdlc', 'use addon'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<framework|addon> [--provider <p>] [--scope project|user] [--dry-run] [--json]',
      allowedTools: ['Read', 'Write', 'Bash', 'Glob'],
      executionSteps: [
        'Validate framework name',
        'Check dependencies',
        'Deploy framework files',
        'Register installed state and deploy platform-specific adaptations',
        'Refresh the applicable capability index and canonical context',
        'Verify required invariants and report readiness or repair findings',
      ],
    },
  } satisfies SkillMetadata,
};

export const modelsCommand: Extension = {
  id: 'models',
  type: 'command',
  name: 'Models',
  description: 'Audit, resolve, validate, migrate, and safely update model policy',
  version: '1.0.0',
  capabilities: ['cli', 'models', 'audit', 'configuration'],
  keywords: ['models', 'model policy', 'tier', 'audit', 'resolve', 'migrate'],
  category: 'catalog',
  platforms: { generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<audit|list|resolve|set-default|set|validate|migrate> [options]',
    allowedTools: ['Read', 'Write', 'Glob'],
  } satisfies CommandMetadata,
};

export const jobCommand: Extension = {
  id: 'job',
  type: 'command',
  name: 'External Job',
  description: 'Validate, render, or run one externally triggered provider job',
  version: '1.0.0',
  capabilities: ['cli', 'jobs', 'external-trigger', 'orchestration'],
  keywords: ['job', 'cron', 'systemd', 'gitea actions', 'codex exec', 'single shot'],
  category: 'orchestration',
  platforms: { generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'orchestration',
    argumentHint: '<validate|render-cron|run> <flow> [--format cron|systemd|gitea-actions] [--once]',
    allowedTools: ['Read', 'Write', 'Bash'],
  } satisfies CommandMetadata,
};

export const cockpitCommand: Extension = {
  id: 'cockpit',
  type: 'command',
  name: 'Cockpit',
  description: 'Launch the opt-in AIWG Cockpit control plane',
  version: '1.0.0',
  capabilities: ['cli', 'cockpit', 'control-plane'],
  keywords: ['cockpit', 'control plane', 'operator wall', 'ui'],
  category: 'utility',
  platforms: {
    claude: 'full',
    copilot: 'full',
    factory: 'full',
    cursor: 'full',
    windsurf: 'full',
    openclaw: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '[--install|--status] [cockpit args...]',
    allowedTools: ['Bash'],
    executionSteps: [
      'Check whether @aiwg/cockpit is installed in the user Cockpit home',
      'Verify the opt-in package version matches the core aiwg package',
      'Launch the Cockpit bridge entrypoint, or show the acquisition command if absent',
    ],
  } satisfies CommandMetadata,
};

export const listCommand: Extension = {
  id: 'list',
  type: 'skill',
  name: 'List',
  description: 'List installed frameworks and addons',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'query'],
  keywords: ['list', 'frameworks', 'addons', 'installed'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['list frameworks', 'show installed', 'list addons', 'what is installed'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const removeCommand: Extension = {
  id: 'remove',
  type: 'skill',
  name: 'Remove',
  description: 'Remove a framework or addon',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'uninstall'],
  keywords: ['remove', 'uninstall', 'framework', 'addon'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['remove framework', 'uninstall framework', 'remove addon', 'uninstall addon'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<id>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const newBundleCommand: Extension = {
  id: 'new-bundle',
  type: 'skill',
  name: 'New Bundle',
  description: 'Scaffold a project-local bundle under the configured AIWG artifact root',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'project-local'],
  keywords: ['new', 'bundle', 'scaffold', 'project-local', 'extension', 'addon', 'framework', 'plugin', 'provider'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['new bundle', 'scaffold project-local', 'new extension', 'new addon', 'new provider'],
    commandHint: {
      template: 'utility',
      argumentHint: '<name> [--type extension|addon|framework|plugin|provider] [--starter skill|rule|agent|minimal] [--description "..."]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const quickrefCommand: Extension = {
  id: 'quickref',
  type: 'skill',
  name: 'Project Quickref',
  description: 'Generate and deploy an always-visible project quickref from the configured AIWG artifact root',
  version: '1.0.0',
  capabilities: ['cli', 'project-local', 'quickref', 'kernel'],
  keywords: ['project', 'quickref', 'orientation', 'kernel', 'generate', 'deploy'],
  category: 'project',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['generate project quickref', 'deploy project quickref'],
    commandHint: {
      template: 'utility',
      argumentHint: 'generate|deploy --project [--provider <id>] [--dry-run]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const promoteCommand: Extension = {
  id: 'promote',
  type: 'skill',
  name: 'Promote',
  description: 'Graduate a project-local bundle to upstream or a corpus path',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'graduate', 'project-local'],
  keywords: ['promote', 'graduate', 'upstream', 'corpus', 'project-local', 'bundle'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['promote bundle', 'graduate to upstream', 'promote project-local'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name> [--to upstream|corpus <path>] [--dry-run] [--cleanup] [--force]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const installCommand: Extension = {
  id: 'install',
  type: 'skill',
  name: 'Install Package',
  description: 'Install a framework, addon, or extension from a Git repository',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'install', 'git'],
  keywords: ['install', 'package', 'git', 'remote', 'addon', 'framework'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['install package', 'install addon from git', 'install remote package'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<ref>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const packagesCommand: Extension = {
  id: 'packages',
  type: 'skill',
  name: 'Packages',
  description: 'Manage installed remote packages (list, info, remove)',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'query', 'uninstall'],
  keywords: ['packages', 'list', 'installed', 'remote', 'registry'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['list packages', 'show packages', 'package info', 'remove package'],
    commandHint: {
      template: 'utility',
      argumentHint: '[list|info|remove]',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const marketplaceCommand: Extension = {
  id: 'marketplace',
  type: 'skill',
  name: 'Marketplace',
  description: 'Search and manage marketplace packages (search, list)',
  version: '1.0.0',
  capabilities: ['cli', 'marketplace', 'search', 'discovery'],
  keywords: ['marketplace', 'search', 'packages', 'clawhub', 'openclaw', 'discover'],
  category: 'framework',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'marketplace search',
      'search marketplace',
      'marketplace list',
      'find packages',
      'discover skills',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '[search|list]',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const initCommand: Extension = {
  id: 'init',
  type: 'skill',
  name: 'Init',
  description: 'Initialise project with .aiwg/aiwg.config (provider registry + scripts)',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'config', 'setup'],
  keywords: ['init', 'setup', 'config', 'providers', 'wizard'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['init project', 'setup project config', 'configure providers'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const setupCommand: Extension = {
  id: 'setup',
  type: 'skill',
  name: 'Setup',
  description: 'CLI helper for agent-led project setup policy previews and writes',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'config', 'setup', 'issues', 'delivery-policy'],
  keywords: ['setup', 'agent-led setup', 'repo policy', 'tracker', 'delivery', 'signing', 'remotes'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'setup project',
      'configure repo policy',
      'configure issue tracker',
      'configure delivery policy',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: 'project [--yes] [--dry-run] [--target <dir>]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const setupGenerateCommand: Extension = {
  id: 'setup-generate',
  type: 'skill',
  name: 'Setup Generate',
  description: 'Generate starter setup.aiwg.io/v1 SetupManifest assets for agentic installer automation',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'setup', 'setup-manifest', 'agentic-installer', 'generation', 'automation'],
  keywords: ['setup-generate', 'setup generate', 'SetupManifest', 'setup.aiwg.io/v1', 'agentic-installer', 'manifest generation', 'starter manifest'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'generate setup manifest',
      'create setup.manifest.yaml',
      'setup-generate',
      'scaffold installer manifest',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '[--output <path>] [--name <name>] [--type user|developer|ci] [--platform <os>] [--force] [--json]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const setupValidateCommand: Extension = {
  id: 'setup-validate',
  type: 'skill',
  name: 'Setup Validate',
  description: 'Validate setup.aiwg.io/v1 SetupManifest files against the canonical schema and installer consistency checks',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'setup', 'setup-manifest', 'agentic-installer', 'validation', 'schema'],
  keywords: ['setup-validate', 'setup validate', 'SetupManifest', 'setup.aiwg.io/v1', 'agentic-installer', 'manifest validation', 'schema validation', 'installer consistency'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'validate setup manifest',
      'check setup.manifest.yaml',
      'setup-validate',
      'lint installer manifest',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '[manifest-path] [--manifest <path>] [--strict] [--fix] [--json]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const setupRunCommand: Extension = {
  id: 'setup-run',
  type: 'skill',
  name: 'Setup Run',
  description: 'Validate and execute setup.aiwg.io/v1 SetupManifest files with installer safety gates',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'setup', 'setup-manifest', 'agentic-installer', 'installer', 'dry-run'],
  keywords: ['setup-run', 'setup run', 'SetupManifest', 'setup.aiwg.io/v1', 'agentic-installer', 'installer runner', 'dry run', 'recovery', 'params'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'run setup manifest',
      'execute installer manifest',
      'setup-run',
      'run dev setup',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '[manifest-path] [--manifest <path>] [--dry-run] [--platform <os>] [--params-file <path>] [--param KEY=VALUE] [--step <id>] [--skip <ids>] [--yes]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const issueCommand: Extension = {
  id: 'issue',
  type: 'skill',
  name: 'Issue',
  description: 'Policy-plan and manage local project issues under .aiwg/issues/',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'issues', 'local-provider'],
  keywords: ['issue', 'issues', 'local', 'tracker', 'tickets', 'policy', 'segmentation'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['local issues', 'issue init', 'issue list', 'issue create', 'plan issue draft'],
    commandHint: {
      template: 'utility',
      argumentHint: '<init|plan|new|list|show|comment|close|index> [--provider local]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const issueAuditCommand: Extension = {
  id: 'issue-audit',
  type: 'skill',
  name: 'Issue Audit',
  description: 'Audit issue backlogs; local provider mode reads .aiwg/issues/',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'issues', 'audit', 'local-provider'],
  keywords: ['issue-audit', 'audit-issues', 'triage', 'backlog', 'local'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['issue-audit', 'audit open issues', 'triage issue backlog'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--provider local] [--filter "status:open label:bug"] [--limit N]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const addressIssuesCommand: Extension = {
  id: 'address-issues',
  type: 'skill',
  name: 'Address Issues',
  description: 'Address selected issues via the address-issues skill (auto-detects the project tracker)',
  version: '1.1.0',
  capabilities: ['project', 'issues', 'agent-loop'],
  keywords: ['address-issues', 'fix issues', 'issue loop'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['address issues', 'fix open issues', 'work issue backlog'],
    commandHint: {
      template: 'utility',
      argumentHint: '<issue-id...> [--all-open] [--limit N] [--guidance "..."]',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const runCommand: Extension = {
  id: 'run',
  type: 'skill',
  name: 'Run Script or Skill',
  description:
    'Run a user-defined script from .aiwg/aiwg.config, or execute a script-bearing skill via `aiwg run skill <name>` (#1227)',
  version: '1.1.0',
  capabilities: ['cli', 'utility', 'scripts', 'skills'],
  keywords: ['run', 'script', 'execute', 'npm-run', 'skill'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['run script', 'aiwg run', 'list scripts', 'run skill', 'aiwg run skill'],
    commandHint: {
      template: 'utility',
      argumentHint: '[script-name] | skill <name> [-- <args...>]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Project Setup Commands

export const newCommand: Extension = {
  id: 'new',
  type: 'skill',
  name: 'New Project',
  description: 'Scaffold new project with .aiwg/ directory and templates',
  version: '1.0.0',
  capabilities: ['cli', 'project', 'scaffolding'],
  keywords: ['new', 'project', 'create', 'init', 'scaffold'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['new project', 'create project', 'init project', 'scaffold project'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Read', 'Write', 'Bash'],
      executionSteps: [
        'Create .aiwg/ directory structure',
        'Deploy SDLC templates',
        'Deploy agents',
        'Initialize framework registry',
      ],
    },
  } satisfies SkillMetadata,
};

// Serve Command

export const serveCommand: Extension = {
  id: 'serve',
  type: 'skill',
  name: 'Serve',
  description: 'Start local HTTP dashboard server with WebSocket PTY bridge',
  version: '1.0.0',
  capabilities: ['cli', 'web', 'dashboard'],
  keywords: ['serve', 'dashboard', 'web', 'server', 'browser'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['serve dashboard', 'start server', 'open dashboard', 'aiwg serve'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--port <n>] [--bind <host>] [--no-open] [--read-only] [--a2a-protocol <0.3|1.0|auto>] [--a2a-protocol-fallback] [--no-a2a-legacy-executor-fallback]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Local Executor Command (#1181)

export const localExecutorCommand: Extension = {
  id: 'local-executor',
  type: 'skill',
  name: 'Local Executor',
  description: 'Start a no-sandbox host-process executor (isolation:none, Core+HITL conformance) registered with aiwg serve',
  version: '1.0.0',
  capabilities: ['cli', 'executor', 'missions', 'hitl'],
  keywords: ['local-executor', 'executor', 'missions', 'dispatch', 'hitl', 'no-sandbox'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'local executor',
      'start executor',
      'aiwg local-executor serve',
      'no-sandbox executor',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: 'serve [--port <n>] [--bind <host>] [--aiwg-serve <url>] [--max-concurrency <n>] [--executor-id <uuid>]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

export const localExecutorServeCommand: Extension = {
  id: 'local-executor-serve',
  type: 'skill',
  name: 'Local Executor Serve',
  description: 'Serve subcommand for the local executor — boots DaemonSupervisor + ExecutorShim and registers with aiwg serve',
  version: '1.0.0',
  capabilities: ['cli', 'executor', 'serve'],
  keywords: ['local-executor-serve', 'executor', 'serve'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['aiwg local-executor serve'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--port <n>] [--bind <host>] [--aiwg-serve <url>] [--max-concurrency <n>]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Diagnose Command (#925)

export const diagnoseCommand: Extension = {
  id: 'diagnose',
  type: 'skill',
  name: 'Diagnose',
  description: 'Produce a shareable support bundle (logs + env + config) for bug reports',
  version: '1.0.0',
  capabilities: ['cli', 'diagnostics', 'troubleshooting', 'support', 'bundle'],
  keywords: ['diagnose', 'troubleshoot', 'bundle', 'support', 'bug-report', 'logs'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['diagnose', 'collect logs', 'bug report', 'support bundle', 'what is wrong'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--stdout] [--include-secrets]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Feedback Command (#885)

export const feedbackCommand: Extension = {
  id: 'feedback',
  type: 'skill',
  name: 'Feedback',
  description: 'Submit a bug report, feature request, or doc gap to the AIWG GitHub repo (auto-prefilled with system context)',
  version: '1.0.0',
  capabilities: ['cli', 'feedback', 'bug-report', 'feature-request', 'github-integration'],
  keywords: ['feedback', 'bug', 'report', 'issue', 'feature-request', 'gh', 'github'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['report a bug', 'feature request', 'submit feedback', 'file an issue'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--type bug|feature|doc] [--title T --body B] [--no-context]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Session Command (#884)

export const sessionCommand: Extension = {
  id: 'session',
  type: 'skill',
  name: 'Session',
  description: 'Start an agentic session with pre-flight checks (version, doctor, deployment, optional MCP inject) and provider launch',
  version: '1.0.0',
  capabilities: ['cli', 'session', 'pre-flight', 'provider-launch', 'mcp-inject'],
  keywords: ['session', 'start', 'launch', 'pre-flight', 'mcp', 'provider'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['start session', 'launch session', 'session mcp', 'agentic session'],
    commandHint: {
      template: 'utility',
      argumentHint: '[mcp] [--provider P] [--no-repair] [--profile name]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

export const writingCommand: Extension = {
  id: 'writing', type: 'command', name: 'Writing',
  description: 'Prepare grounded writing plans and apply authorized proofreading corrections with canonical receipts',
  version: '1.0.0', capabilities: ['cli', 'voice', 'writing', 'proofread'],
  keywords: ['writing', 'brief', 'proofread', 'author', 'receipt'],
  category: 'project', platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: { type: 'command', template: 'utility', argumentHint: '<plan|proofread> --brief <file> --profile <id> [--output <new-file>]', allowedTools: ['Read', 'Write', 'Bash'] } satisfies CommandMetadata,
};

export const writerProfileCommand: Extension = {
  id: 'writer-profile', type: 'command', name: 'Writer Profiles',
  description: 'Import, inspect, export, version, compile, revoke, and delete author-controlled writer sidecars',
  version: '1.0.0', capabilities: ['cli', 'voice', 'writer-profile'],
  keywords: ['writer-profile', 'author', 'voice', 'sample', 'provenance'],
  category: 'project', platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command', template: 'utility',
    argumentHint: '<list|import|inspect|export|version|compile|revoke|delete> [id] [--scope project|user]',
    allowedTools: ['Read', 'Write', 'Bash'],
  } satisfies CommandMetadata,
};

export const botHandoffCommand: Extension = {
  id: 'bot-handoff', type: 'command', name: 'Bot Handoff',
  description: 'Generate operator-reviewed routine, teammate, connector and memory drafts; no native installation',
  version: '1.0.0', capabilities: ['cli', 'providers', 'handoff'],
  keywords: ['provider', 'handoff', 'routines', 'teammates', 'connectors', 'memory'],
  category: 'utility', platforms: { generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: { type: 'command', template: 'utility', argumentHint: '--input <proposal.json> [--provider <id>] [--dry-run]', allowedTools: ['Read'] } satisfies CommandMetadata,
};

export const buildVerifyCommand: Extension = {
  id: 'build-verify', type: 'command', name: 'Build Verification',
  description: 'Verify AIWG deployment and supported native discovery before any provider runs a build or CI task',
  version: '1.0.0', capabilities: ['cli', 'providers', 'verification'],
  keywords: ['provider', 'inspect', 'ci', 'verification'],
  category: 'utility', platforms: { generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: { type: 'command', template: 'utility', argumentHint: '[--provider <id>]', allowedTools: ['Read', 'Bash'] } satisfies CommandMetadata,
};

export const outputModeCommand: Extension = {
  id: 'output-mode',
  type: 'command',
  name: 'Output Modes',
  description: 'List, inspect, enable, disable, clear, and report composable output modes',
  version: '1.0.0',
  capabilities: ['cli', 'voice', 'output-mode', 'controlled-language', 'presentation'],
  keywords: ['output-mode', 'output-mask', 'voice', 'style', 'syntax', 'wittgenstein', 'asd-ste', 'engineering-language', 'controlled-language', 'presentation'],
  category: 'project',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<list|show|enable|disable|clear|status> [id] [--scope invocation|session|project]',
    allowedTools: ['Read', 'Write'],
  } satisfies CommandMetadata,
};

export const schemaCommand: Extension = {
  id: 'schema',
  type: 'command',
  name: 'Schema Control Plane',
  description: 'Discover, validate, compare, and verify governed schema artifacts',
  version: '1.0.0',
  capabilities: ['cli', 'schema', 'catalog', 'validation', 'compatibility', 'projections'],
  keywords: ['schema', 'catalog', 'validate', 'lint', 'references', 'compatibility', 'projection', 'policy'],
  category: 'utility',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<list|show|graph|policy|validate|lint|check-refs|diff|compatibility|generate|verify-projections> [options]',
    allowedTools: ['Read', 'Write'],
  } satisfies CommandMetadata,
};

export const datasetCommand: Extension = {
  id: 'dataset', type: 'command', name: 'Dataset Intelligence', description: 'Register, preview, plan, ingest, verify, query, and trace governed datasets', version: '1.0.0',
  capabilities: ['cli', 'dataset', 'ingest', 'index', 'traceability', 'provenance'], keywords: ['dataset', 'source', 'preview', 'plan', 'ingest', 'verify', 'query', 'lineage', 'export'], category: 'index',
  platforms: { claude: 'full', generic: 'full' }, deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: { type: 'command', template: 'utility', argumentHint: '<source|check|preview|plan|ingest|status|show|verify|query|lineage|export|cancel|retry> [options]', allowedTools: ['Read', 'Write'] } satisfies CommandMetadata,
};

// Session Catalog Command (#1903)

export const sessionsCommand: Extension = {
  id: 'sessions',
  type: 'skill',
  name: 'Sessions',
  description: 'Manage the normalized session catalog, analytics, and authorized forensic evidence with versioned JSON',
  version: '1.0.0',
  capabilities: [
    'cli', 'session-catalog', 'session-import', 'session-lifecycle',
    'session-analytics', 'session-forensics', 'doctor',
  ],
  keywords: [
    'sessions', 'catalog', 'import', 'source', 'tag', 'reindex', 'delete',
    'analytics', 'forensics', 'timeline', 'indicators',
  ],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['list sessions', 'import sessions', 'session catalog', 'sessions doctor'],
    commandHint: {
      template: 'utility',
      argumentHint: '<sources|import|list|show|analytics|forensics|tag|relocate|reindex|delete|doctor> [--json] [--dry-run]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Sandbox Management Commands (#917)

export const sandboxCommand: Extension = {
  id: 'sandbox',
  type: 'skill',
  name: 'Sandbox',
  description: 'Sandbox agent management — alias, resolve, and list agent identities',
  version: '1.0.0',
  capabilities: ['cli', 'sandbox', 'agent-identity', 'agent-routing'],
  keywords: ['sandbox', 'alias', 'agent', 'identity', 'resolve', 'logical-name'],
  category: 'project',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['sandbox alias', 'alias agent', 'sandbox resolve', 'agent identities'],
    commandHint: {
      template: 'utility',
      argumentHint: 'alias|resolve|identities [options]',
      allowedTools: ['Bash'],
    },
  } satisfies SkillMetadata,
};

// Workspace Management Commands

export const statusCommand: Extension = {
  id: 'status',
  type: 'skill',
  name: 'Status',
  description: 'Show workspace health, installed frameworks, and artifacts',
  version: '1.0.0',
  capabilities: ['cli', 'workspace', 'status'],
  keywords: ['status', 'workspace', 'health', 'info'],
  category: 'workspace',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['status', 'workspace status', 'show health', 'project status'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const wizardCommand: Extension = {
  id: 'wizard',
  type: 'skill',
  name: 'Onboarding Wizard',
  description: 'Guide first-run provider, project, framework, deploy, and verification steps',
  version: '1.0.0',
  capabilities: ['cli', 'workspace', 'onboarding', 'wizard', 'verification'],
  keywords: ['wizard', 'onboarding', 'first-run', 'setup', 'verify'],
  category: 'workspace',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['wizard', 'onboarding wizard', 'first run', 'guided setup'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--goal <text>] [--profile <preset>] [--provider <name>] [--framework <name>] [--non-interactive] [--dry-run] [--json]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const migrateWorkspaceCommand: Extension = {
  id: 'migrate-workspace',
  type: 'skill',
  name: 'Migrate Workspace',
  description: 'Upgrade .aiwg/ structure to support multi-framework layout',
  version: '1.0.0',
  capabilities: ['cli', 'workspace', 'migration'],
  keywords: ['migrate', 'workspace', 'migration', 'upgrade'],
  category: 'workspace',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['migrate workspace', 'upgrade workspace', 'migrate aiwg directory'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const rollbackWorkspaceCommand: Extension = {
  id: 'rollback-workspace',
  type: 'skill',
  name: 'Rollback Workspace',
  description: 'Restore workspace to pre-migration state from backup',
  version: '1.0.0',
  capabilities: ['cli', 'workspace', 'rollback'],
  keywords: ['rollback', 'workspace', 'restore', 'backup'],
  category: 'workspace',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['rollback workspace', 'restore workspace', 'undo migration', 'workspace backup'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// MCP Commands

export const mcpCommand: Extension = {
  id: 'aiwg-mcp-server',
  type: 'skill',
  name: 'AIWG MCP Server',
  description: 'AIWG MCP server operations (serve, install, add, remove, update, list, inject, info)',
  version: '1.0.0',
  capabilities: ['cli', 'mcp', 'server'],
  keywords: ['mcp', 'server', 'protocol', 'aiwg'],
  category: 'mcp',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['aiwg mcp', 'aiwg mcp server', 'start aiwg mcp', 'aiwg mcp serve', 'aiwg mcp install'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<subcommand>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Catalog Commands

export const catalogCommand: Extension = {
  id: 'catalog',
  type: 'skill',
  name: 'Catalog',
  description: 'Model catalog operations (list, info, search)',
  version: '1.0.0',
  capabilities: ['cli', 'catalog', 'models'],
  keywords: ['catalog', 'models', 'search', 'info'],
  category: 'catalog',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['catalog', 'model catalog', 'list models', 'search catalog'],
    commandHint: {
      template: 'utility',
      argumentHint: '<subcommand>',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

// Skills Commands

export const skillsCommand: Extension = {
  id: 'skills',
  type: 'skill',
  name: 'Skills Registry',
  description: 'Skill registry commands (search, info, list, install, publish)',
  version: '1.0.0',
  capabilities: ['cli', 'skills', 'registry', 'search', 'install', 'publish'],
  keywords: ['skills', 'registry', 'search', 'install', 'publish', 'clawhub', 'openclaw'],
  category: 'catalog',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['skills', 'skills registry', 'search skills', 'install skill', 'publish skill'],
    commandHint: {
      template: 'utility',
      argumentHint: '<subcommand>',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Index Commands

export const indexCommand: Extension = {
  id: 'index',
  type: 'skill',
  name: 'Artifact Index',
  description: 'Artifact index commands (build, query, deps, stats)',
  version: '1.0.0',
  capabilities: ['cli', 'index', 'artifacts', 'search', 'dependencies'],
  keywords: ['index', 'artifacts', 'query', 'deps', 'dependencies', 'stats', 'search'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['index', 'build index', 'query index', 'artifact index', 'index stats'],
    commandHint: {
      template: 'utility',
      argumentHint: '<subcommand> [options]',
      allowedTools: ['Read', 'Glob', 'Grep'],
    },
  } satisfies SkillMetadata,
};

export const artifactsCommand: Extension = {
  id: 'artifacts',
  type: 'skill',
  name: 'Project Artifacts',
  description: 'Move or inspect the configured project AIWG artifact root',
  version: '1.0.0',
  capabilities: ['cli', 'artifacts', 'relocation', 'repair', 'configuration', 'index'],
  keywords: ['artifacts', 'aiwg artifacts', 'move .aiwg', 'relocate .aiwg', 'rename .aiwg', 'repair artifact root', 'external corpus', 'split root', 'artifact root', 'AIWG_ARTIFACTS_PATH'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['move .aiwg', 'relocate .aiwg', 'rename .aiwg', 'move aiwg artifacts', 'repair external corpus', 'externalize corpus', 'artifact root'],
    commandHint: {
      template: 'utility',
      argumentHint: 'move|attach|repair [--to <path>] [--dry-run|--apply]',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const effectCommand: Extension = {
  id: 'effect',
  type: 'skill',
  name: 'Effect Ledger',
  description: 'Record, look up, reconcile and verify side effects in the signed effect ledger',
  version: '1.0.0',
  capabilities: ['cli', 'effects', 'idempotency', 'verification', 'signing', 'provenance'],
  keywords: ['effect', 'aiwg effect', 'effect ledger', 'record an effect', 'sign an effect', 'reconcile effect', 'did this PR merge', 'idempotent side effect', 'effect id', 'stale ledger lock'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['record an effect', 'sign an effect', 'reconcile effect', 'did this PR merge', 'effect ledger', 'idempotent side effect', 'look up an effect', 'verify the effect ledger'],
    commandHint: {
      template: 'utility',
      argumentHint: 'id|intent|record|lookup|reconcile|verify|checkpoint|kinds|keys|recover-lock [options]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Research-corpus tools — radar/freshness subsystem (#1498)
export const corpusCommand: Extension = {
  id: 'corpus',
  type: 'skill',
  name: 'Research Corpus Tools',
  description: 'Research-corpus tools for freshness, profiles, provenance, and retrieval benchmarks',
  version: '1.1.0',
  capabilities: ['cli', 'research', 'corpus', 'radar', 'freshness', 'profiles', 'discovery', 'retrieval-benchmark'],
  keywords: ['corpus', 'radar', 'freshness', 'staleness', 'radar-init', 'radar-status', 'radar-report', 'profile-status', 'profile-generate', 'profile-metrics', 'profile-temporal', 'profile-communities', 'h-index', 'PageRank', 'CD-index', 'centrality', 'community detection', 'hot streak', 'funder-network', 'funder analytics', 'co-funding', 'novelty bias', 'curator-status', 'curator-init', 'discovery-log', 'PROF-S', 'source tracking', 'discovery provenance', 'stale profiles', 'hub authors', 'refresh cadence', 'GRADE trajectory', 'retrieval-lab', 'BM25', 'vector retrieval', 'concept graph', 'PPR', 'RRF', 'source selection'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['radar', 'radar status', 'radar report', 'scaffold radar', 'stale radars', 'corpus freshness', 'stale profiles', 'profile status', 'curator yield', 'discovery source', 'log discovery', 'benchmark corpus retrieval', 'hybrid retrieval lab'],
    commandHint: {
      template: 'utility',
      argumentHint: '<radar-*|profile-*|curator-*|discovery-log|funder-network|retrieval-lab> [options]',
      allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const researchQueryCommand: Extension = {
  id: 'research-query',
  type: 'skill',
  name: 'Research Query',
  description: 'Select local or Fortemi Core-backed research sources for a question',
  version: '1.0.0',
  capabilities: ['cli', 'research', 'corpus', 'query', 'citations', 'fortemi-core'],
  keywords: ['research-query', 'research query', 'corpus query', 'sources-only', 'GRADE', 'REF', 'Fortemi Core'],
  category: 'index',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['research query', 'query the corpus', 'what does the research say', 'search research'],
    commandHint: {
      template: 'utility',
      argumentHint: '<question> [--backend local|fortemi-core] [--depth quick|thorough] [--sources-only] [--max-sources N] [--json] [--save]',
      allowedTools: ['Bash', 'Read', 'Write'],
      executionSteps: [
        'Parse question and retrieval options',
        'Load local or Fortemi Core static index records',
        'Rank research REF/PROF/synthesis sources',
        'Emit source-selection table or JSON for skill-mediated synthesis',
      ],
    },
  } satisfies SkillMetadata,
};

// Discovery — first-class top-level verb (#1212)
//
// Discovery is the operator surface for finding AIWG skills, agents, commands,
// and rules by capability. It heavily leverages the artifact index machinery
// but is exposed as its own top-level command (`aiwg discover`) rather than a
// subcommand of `aiwg index` to avoid agentic confusion between the project's
// general-purpose graph indices (project / codebase / framework / user-defined)
// and the specific AIWG capability-search surface.
export const discoverCommand: Extension = {
  id: 'discover',
  type: 'skill',
  name: 'Discover',
  description: 'Find AIWG operational assets by capability — index-driven on-demand discovery',
  version: '1.0.0',
  capabilities: ['cli', 'discovery', 'search', 'capability', 'skills'],
  keywords: ['discover', 'find skill', 'capability', 'search skills', 'what skill does', 'skill for'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'discover',
      'find a skill',
      'find skill for',
      'what skill handles',
      'capability search',
      'aiwg discover',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '"<phrase>" [--limit N] [--type skill,agent,...] [--json] [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

// Show: companion to `discover`. Where `discover` ranks candidates,
// `show` fetches the full body of one specific artifact (#1218). This
// closes the loop so consumers never need to navigate AIWG's storage
// paths themselves — the CLI is the access point.
export const showCommand: Extension = {
  id: 'show',
  type: 'skill',
  name: 'Show',
  description: 'Print the full text of a specific AIWG skill, agent, command, or rule by name',
  version: '1.0.0',
  capabilities: ['cli', 'discovery', 'read', 'capability', 'skills'],
  keywords: ['show', 'cat', 'read skill', 'print skill', 'get skill content', 'aiwg show'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'show skill',
      'print skill',
      'read skill',
      'get skill content',
      'aiwg show',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '<type> <name> [--json] [--first] [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]   # type: skill | agent | command | rule',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const versionsCommand: Extension = {
  id: 'versions',
  type: 'skill',
  name: 'Resource Versions',
  description: 'Browse and resolve signed AIWG web resource releases',
  version: '1.0.0',
  capabilities: ['cli', 'resources', 'versions', 'release', 'integrity', 'cache'],
  keywords: ['versions', 'resource versions', 'aiwg version', 'release manifest', 'web resources', 'stable channel'],
  category: 'index',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'aiwg versions',
      'resource versions',
      'resolve aiwg version',
      'show release manifest',
      'list AIWG resource channels',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: 'list|resolve|show [version|range|digest|channel] [--json] [--pretty] [--offline] [--channels stable,latest]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Features: list, inspect (and eventually install) AIWG's optional
// runtime features — embeddings, sqlite, pty, webserver. (#1219)
export const featuresCommand: Extension = {
  id: 'features',
  type: 'skill',
  name: 'Features',
  description: 'List, inspect, and (eventually) install AIWG\'s optional runtime features',
  version: '1.0.0',
  capabilities: ['cli', 'maintenance', 'install', 'optional-deps'],
  keywords: ['features', 'optional', 'install', 'embeddings', 'sqlite', 'pty', 'webserver', 'graph', 'terminal'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'aiwg features',
      'optional features',
      'install optional',
      'enable embeddings',
    ],
    commandHint: {
      template: 'utility',
      argumentHint: '[status|info|install|remove] [name] [--json]',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Toolsmith Commands

export const runtimeInfoCommand: Extension = {
  id: 'runtime-info',
  type: 'skill',
  name: 'Runtime Info',
  description: 'Display runtime environment, available tools, and capabilities',
  version: '1.0.0',
  capabilities: ['cli', 'toolsmith', 'discovery'],
  keywords: ['runtime', 'info', 'discovery', 'tools'],
  category: 'toolsmith',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['runtime info', 'show runtime', 'available tools', 'runtime environment'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const agentcardCommand: Extension = {
  id: 'agentcard',
  type: 'skill',
  name: 'AgentCard',
  description: 'Fetch and verify an agentic-sandbox AgentCard JWS signature',
  version: '1.0.0',
  capabilities: ['cli', 'a2a', 'security'],
  keywords: ['agentcard', 'a2a', 'jws', 'verify', 'sandbox'],
  category: 'toolsmith',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'verify agentcard',
      'fetch agent card',
      'verify a2a signature',
      'check executor signature',
    ],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const uhpCommand: Extension = {
  id: 'uhp',
  type: 'command',
  name: 'Unified Harness Protocol',
  description: 'Inspect discovery and run smoke tasks through an explicit experimental UHP endpoint profile',
  version: '1.0.0',
  capabilities: ['cli', 'uhp', 'remote-harness', 'transport'],
  keywords: ['uhp', 'unified harness protocol', 'remote harness', 'responses'],
  category: 'toolsmith',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<discover|harnesses|models|run> --profile <name> [--harness <id>] [--model <id>] [--input <text>] [--stream]',
    allowedTools: ['Read', 'Bash'],
  } satisfies CommandMetadata,
};

// Utility Commands

export const prefillCardsCommand: Extension = {
  id: 'prefill-cards',
  type: 'skill',
  name: 'Prefill Cards',
  description: 'Auto-populate SDLC artifact metadata from team configuration',
  version: '1.0.0',
  capabilities: ['cli', 'sdlc', 'automation'],
  keywords: ['prefill', 'cards', 'sdlc', 'metadata'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['prefill cards', 'populate metadata', 'fill sdlc cards', 'auto-populate artifacts'],
    commandHint: {
      template: 'transformation',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const contributeStartCommand: Extension = {
  id: 'contribute-start',
  type: 'skill',
  name: 'Contribute Start',
  description: 'Initialize contribution with branch, issue tracking, and DCO',
  version: '1.0.0',
  capabilities: ['cli', 'contribution', 'workflow'],
  keywords: ['contribute', 'contribution', 'workflow'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['contribute start', 'start contribution', 'new contribution', 'init contribution'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const validateMetadataCommand: Extension = {
  id: 'validate-metadata',
  type: 'skill',
  name: 'Validate Metadata',
  description: 'Validate extension metadata against schema requirements',
  version: '1.0.0',
  capabilities: ['cli', 'validation', 'metadata'],
  keywords: ['validate', 'metadata', 'quality'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['validate metadata', 'check metadata', 'validate extensions', 'metadata quality'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const skillLintCommand: Extension = {
  id: 'skill-lint',
  type: 'skill',
  name: 'Skill Lint',
  description: 'Score SKILL.md files against a quality rubric (schema, description, discoverability, body)',
  version: '1.0.0',
  capabilities: ['cli', 'validation', 'metadata', 'quality'],
  keywords: ['lint', 'quality', 'skill', 'rubric'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['skill lint', 'lint skills', 'score skills', 'skill quality'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path> [--rubric strict|standard|lenient] [--json]',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

// Plugin Commands

export const installPluginCommand: Extension = {
  id: 'install-plugin',
  type: 'skill',
  name: 'Install Plugin',
  description: 'Install Claude Code plugin',
  version: '1.0.0',
  capabilities: ['cli', 'plugin', 'install'],
  keywords: ['install', 'plugin', 'claude'],
  category: 'plugin',
  platforms: {
    claude: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['install plugin', 'add plugin', 'plugin install'],
    commandHint: {
      template: 'utility',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const uninstallPluginCommand: Extension = {
  id: 'uninstall-plugin',
  type: 'skill',
  name: 'Uninstall Plugin',
  description: 'Uninstall Claude Code plugin',
  version: '1.0.0',
  capabilities: ['cli', 'plugin', 'uninstall'],
  keywords: ['uninstall', 'plugin', 'claude'],
  category: 'plugin',
  platforms: {
    claude: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['uninstall plugin', 'remove plugin', 'plugin uninstall'],
    commandHint: {
      template: 'utility',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const pluginStatusCommand: Extension = {
  id: 'plugin-status',
  type: 'skill',
  name: 'Plugin Status',
  description: 'Show Claude Code plugin status',
  version: '1.0.0',
  capabilities: ['cli', 'plugin', 'status'],
  keywords: ['status', 'plugin', 'claude'],
  category: 'plugin',
  platforms: {
    claude: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['plugin status', 'show plugins', 'list plugins'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const packagePluginCommand: Extension = {
  id: 'package-plugin',
  type: 'skill',
  name: 'Package Plugin',
  description: 'Bundle plugin for Claude Code marketplace distribution',
  version: '1.0.0',
  capabilities: ['cli', 'plugin', 'packaging'],
  keywords: ['package', 'plugin', 'marketplace'],
  category: 'plugin',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['package plugin', 'bundle plugin', 'publish plugin'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const packageAllPluginsCommand: Extension = {
  id: 'package-all-plugins',
  type: 'skill',
  name: 'Package All Plugins',
  description: 'Bundle all plugins for marketplace in batch operation',
  version: '1.0.0',
  capabilities: ['cli', 'plugin', 'packaging'],
  keywords: ['package', 'plugin', 'marketplace', 'all'],
  category: 'plugin',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['package all plugins', 'bundle all plugins', 'publish all plugins'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

// Scaffolding Commands

export const addAgentCommand: Extension = {
  id: 'add-agent',
  type: 'skill',
  name: 'Add Agent',
  description: 'Add agent to addon/framework',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'agent'],
  keywords: ['add', 'agent', 'scaffold', 'create'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['add agent', 'create agent', 'scaffold agent', 'new agent'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const addCommandCommand: Extension = {
  id: 'add-command',
  type: 'skill',
  name: 'Add Command',
  description: 'Add command to addon/framework',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'command'],
  keywords: ['add', 'command', 'scaffold', 'create'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['add command', 'create command', 'scaffold command', 'new command'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const addSkillCommand: Extension = {
  id: 'add-skill',
  type: 'skill',
  name: 'Add Skill',
  description: 'Add skill to addon/framework',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'skill'],
  keywords: ['add', 'skill', 'scaffold', 'create'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['add skill', 'create skill', 'scaffold skill', 'new skill'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const addBehaviorCommand: Extension = {
  id: 'add-behavior',
  type: 'skill',
  name: 'Add Behavior',
  description: 'Scaffold a new behavior with BEHAVIOR.md and scripts',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'behavior'],
  keywords: ['add', 'behavior', 'scaffold', 'create', 'hooks', 'reactive'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    openclaw: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['add behavior', 'create behavior', 'scaffold behavior', 'new behavior'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const addTemplateCommand: Extension = {
  id: 'add-template',
  type: 'skill',
  name: 'Add Template',
  description: 'Add template to addon/framework',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'template'],
  keywords: ['add', 'template', 'scaffold', 'create'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['add template', 'create template', 'scaffold template', 'new template'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const scaffoldAddonCommand: Extension = {
  id: 'scaffold-addon',
  type: 'skill',
  name: 'Scaffold Addon',
  description: 'Create new addon package',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'addon'],
  keywords: ['scaffold', 'addon', 'create', 'package'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['scaffold addon', 'create addon', 'new addon package'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const scaffoldExtensionCommand: Extension = {
  id: 'scaffold-extension',
  type: 'skill',
  name: 'Scaffold Extension',
  description: 'Create new extension package',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'extension'],
  keywords: ['scaffold', 'extension', 'create', 'package'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['scaffold extension', 'create extension', 'new extension package'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const scaffoldFrameworkCommand: Extension = {
  id: 'scaffold-framework',
  type: 'skill',
  name: 'Scaffold Framework',
  description: 'Create new framework package',
  version: '1.0.0',
  capabilities: ['cli', 'scaffolding', 'framework'],
  keywords: ['scaffold', 'framework', 'create', 'package'],
  category: 'scaffolding',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['scaffold framework', 'create framework', 'new framework package'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<name>',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

// Ralph Commands

export const ralphCommand: Extension = {
  id: 'ralph',
  type: 'skill',
  name: 'Ralph',
  description: 'Start Ralph task execution loop',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'orchestration'],
  keywords: ['ralph', 'loop', 'task', 'orchestration'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph', 'start ralph', 'run ralph', 'ralph loop', 'agent loop', 'start task loop'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<task-description>',
      allowedTools: ['Read', 'Write', 'Bash'],
    },
  } satisfies SkillMetadata,
};

export const ralphStatusCommand: Extension = {
  id: 'ralph-status',
  type: 'skill',
  name: 'Ralph Status',
  description: 'Show agent loop status',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'status'],
  keywords: ['ralph', 'status', 'info'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph status', 'show ralph status', 'loop status'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
    },
  } satisfies SkillMetadata,
};

export const ralphAbortCommand: Extension = {
  id: 'ralph-abort',
  type: 'skill',
  name: 'Ralph Abort',
  description: 'Abort running agent loop',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'control'],
  keywords: ['ralph', 'abort', 'stop', 'cancel'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph abort', 'abort ralph', 'stop ralph', 'cancel ralph'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const ralphResumeCommand: Extension = {
  id: 'ralph-resume',
  type: 'skill',
  name: 'Ralph Resume',
  description: 'Resume paused agent loop',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'control'],
  keywords: ['ralph', 'resume', 'continue'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph resume', 'resume ralph', 'continue ralph', 'unpause ralph'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const ralphAttachCommand: Extension = {
  id: 'ralph-attach',
  type: 'skill',
  name: 'Ralph Attach',
  description: 'Attach to a running agent loop\'s live output stream. Press Ctrl+C to detach.',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'control', 'monitoring'],
  keywords: ['ralph', 'attach', 'follow', 'watch', 'tail', 'output', 'stream'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph attach', 'attach to ralph', 'follow ralph', 'watch ralph output'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
      argumentHint: '[--loop-id <id>]',
    },
  } satisfies SkillMetadata,
};

export const agentLoopExtCommand: Extension = {
  id: 'agent-loop-ext',
  legacyId: 'ralph-external',
  type: 'skill',
  name: 'Agent Loop External',
  description: 'Crash-resilient external loop with state persistence and CI/CD integration',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'orchestration', 'external', 'crash-recovery'],
  keywords: ['ralph', 'external', 'crash', 'recovery', 'persistent', 'background', 'cicd', 'agent-loop'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'agent-loop-ext', 'external agent loop', 'out-of-session loop', 'persistent agent loop',
      'ralph external', 'external ralph', 'crash-resilient loop', 'persistent ralph',
      'long-running ralph', 'start background ralph', 'ralph with crash recovery',
    ],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read', 'Write'],
      argumentHint: '"<objective>" --completion "<criteria>"',
    },
  } satisfies SkillMetadata,
};

export const ralphMemoryCommand: Extension = {
  id: 'ralph-memory',
  type: 'skill',
  name: 'Ralph Memory',
  description: 'Manage Ralph semantic memory entries (list, query, clear)',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'memory', 'semantic'],
  keywords: ['ralph', 'memory', 'semantic', 'learning', 'list', 'query'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph memory', 'ralph memories', 'list ralph memory', 'query ralph memory'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write'],
      argumentHint: '<list|query|clear> [options]',
    },
  } satisfies SkillMetadata,
};

export const ralphConfigCommand: Extension = {
  id: 'ralph-config',
  type: 'skill',
  name: 'Ralph Config',
  description: 'View and configure agent loop settings (show, set, reset, preset)',
  version: '1.0.0',
  capabilities: ['cli', 'ralph', 'configuration'],
  keywords: ['ralph', 'config', 'configuration', 'settings', 'show', 'set', 'reset'],
  category: 'ralph',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ralph config', 'configure ralph', 'ralph settings', 'show ralph config'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Write'],
      argumentHint: '<show|set|reset|preset> [key] [value]',
    },
  } satisfies SkillMetadata,
};

// Mission Control Commands

export const mcCommand: Extension = {
  id: 'mc',
  type: 'skill',
  name: 'Mission Control',
  description: 'Multi-loop background orchestration dashboard (start, dispatch, status, watch, stop)',
  version: '1.0.0',
  capabilities: ['cli', 'orchestration', 'ralph', 'background', 'multi-loop', 'mission-control'],
  keywords: ['mission', 'control', 'mc', 'background', 'parallel', 'orchestration', 'dispatch', 'monitor'],
  category: 'orchestration',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['mission control', 'mc', 'start mission control', 'background orchestration', 'mc dispatch'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Bash', 'Read', 'Write'],
      argumentHint: '<subcommand> [options]',
      executionSteps: [
        'Parse subcommand (start, dispatch, status, watch, abort, pause, resume, stop, list)',
        'Route to appropriate subcommand handler',
        'Read/write session state from .aiwg/ralph-external/mc/',
        'Display results or status dashboard',
      ],
    },
  } satisfies SkillMetadata,
};

export const missionCommand: Extension = {
  id: 'mission',
  type: 'command',
  name: 'Mission Protocol',
  description: 'Preview, apply, verify, resume, and roll back versioned Mission workspace migrations',
  version: '1.0.0',
  capabilities: ['cli', 'orchestration', 'mission-protocol', 'migration', 'rollback'],
  keywords: ['mission', 'migrate', 'migration', 'preview', 'resume', 'rollback'],
  category: 'orchestration',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'orchestration',
    allowedTools: ['Bash', 'Read', 'Write'],
    argumentHint: 'migrate [--dry-run|--apply|--verify|--resume|--rollback]',
  } satisfies CommandMetadata,
};

// Steward Commands

export const stewardCommand: Extension = {
  id: 'steward',
  type: 'skill',
  name: 'Steward',
  description: 'Provider capability awareness and command routing intelligence (capabilities, find)',
  version: '1.0.0',
  capabilities: ['cli', 'maintenance', 'capability-matrix', 'provider-routing', 'diagnostics'],
  keywords: ['steward', 'capabilities', 'provider', 'routing', 'native', 'emulated', 'feature', 'matrix'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'steward capabilities',
      'steward find',
      'what does my provider support',
      'does my provider support',
      'what command should I use',
      'provider capability',
      'capability matrix',
    ],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read'],
      argumentHint: 'capabilities [--provider <p>] [--feature <f>] [--all] | find --capability <c>',
      executionSteps: [
        'Read agentic/code/providers/capability-matrix.yaml',
        'Detect current provider via runtime-info or env heuristics',
        'Return native vs emulated routing advice for the requested feature/provider',
      ],
    },
  } satisfies SkillMetadata,
};

export const repoAccessCommand: Extension = {
  id: 'repo-access',
  type: 'skill',
  name: 'Repo Access',
  description: 'Resolve workspace members and validate deny-by-default authorization before cross-repo operations',
  version: '1.0.0',
  capabilities: ['cli', 'policy', 'repo-access', 'authorization', 'preflight'],
  keywords: ['repo', 'access', 'manifest', 'authorization', 'permissions', 'preflight', 'handoff'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: [
      'repo access check',
      'repo access manifest',
      'can I edit this repo',
      'check repo permissions',
      'preflight repo access',
    ],
    commandHint: {
      template: 'utility',
      allowedTools: ['Bash', 'Read'],
      argumentHint: 'list | status | explain --path <repo> | check --path <repo> --action <action>',
      executionSteps: [
        'Load .aiwg/aiwg.config workspace + repos, with legacy YAML fallback',
        'Resolve the requested repo/path against manifest entries',
        'Load the matched member config for delivery, remotes, actor, and signing',
        'Return member status or ALLOW/DENY with the matching repo and reason',
      ],
    },
  } satisfies SkillMetadata,
};

// Agent Team Commands

export const teamCommand: Extension = {
  id: 'team',
  type: 'skill',
  name: 'Agent Teams',
  description: 'Multi-agent team orchestration across all providers (run, list, info)',
  version: '1.0.0',
  capabilities: ['cli', 'orchestration', 'agent-teams', 'multi-provider', 'mission-control'],
  keywords: ['team', 'teams', 'agents', 'multi-agent', 'orchestration', 'provider', 'dispatch'],
  category: 'orchestration',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['team run', 'team list', 'team info', 'agent team', 'run team', 'list teams'],
    commandHint: {
      template: 'orchestration',
      allowedTools: ['Bash', 'Read', 'Write'],
      argumentHint: '<subcommand> [options]',
      executionSteps: [
        'Parse subcommand (run, list, info)',
        'Detect provider (native Claude Code vs emulated via aiwg mc)',
        'Load team definition from .aiwg/teams/ or framework source',
        'Dispatch natively or emit aiwg mc commands for emulation',
      ],
    },
  } satisfies SkillMetadata,
};

// Cost & Metrics Commands

export const evidenceCommand: Extension = {
  id: 'evidence',
  type: 'skill',
  name: 'Evidence',
  description: 'Export and verify portable evaluation evidence bundles',
  version: '1.0.0',
  capabilities: ['cli', 'evidence', 'provenance', 'verification', 'evaluation'],
  keywords: ['evidence', 'bundle', 'provenance', 'verify', 'evaluation', 'activity-export'],
  category: 'metrics',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['evidence bundle', 'export evidence', 'verify evidence', 'evaluation provenance'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
      argumentHint: '<export|verify> [options]',
      cliDisabled: false,
    },
  } satisfies SkillMetadata,
};

export const artifactVerifyCommand: Extension = {
  id: 'verify',
  type: 'command',
  name: 'Artifact Verification',
  description: 'Verify cross-asset DSSE provenance and manage versioned trust roots',
  version: '1.0.0',
  capabilities: ['cli', 'security', 'dsse', 'sigstore', 'provenance', 'trust-policy'],
  keywords: ['verify', 'artifact', 'attestation', 'dsse', 'sigstore', 'trust-root', 'revocation'],
  category: 'utility',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<artifact> --attestation <path> --policy <root.json> [--offline] [--json] | trust <bootstrap|update|status>',
    allowedTools: ['Read', 'Bash'],
  } satisfies CommandMetadata,
};

export const costReportCommand: Extension = {
  id: 'cost-report',
  type: 'skill',
  name: 'Cost Report',
  description: 'Generate session or OpenRouter fleet cost and spending reports',
  version: '1.1.0',
  capabilities: ['cli', 'metrics', 'cost-tracking', 'reporting', 'fleet', 'openrouter'],
  keywords: ['cost', 'report', 'tokens', 'spending', 'budget', 'metrics', 'fleet', 'openrouter'],
  category: 'metrics',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['cost report', 'show costs', 'token spending', 'cost summary', 'budget report', 'fleet spend'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
      cliDisabled: false,
    },
  } satisfies SkillMetadata,
};

export const costHistoryCommand: Extension = {
  id: 'cost-history',
  type: 'skill',
  name: 'Cost History',
  description: 'Show historical cost data across workflow sessions',
  version: '1.0.0',
  capabilities: ['cli', 'metrics', 'cost-tracking', 'history'],
  keywords: ['cost', 'history', 'trends', 'spending', 'budget'],
  category: 'metrics',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['cost history', 'historical costs', 'spending history', 'cost trends'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const metricsTokensCommand: Extension = {
  id: 'metrics-tokens',
  type: 'skill',
  name: 'Metrics Tokens',
  description: 'Analyze token efficiency and compare to MetaGPT baseline',
  version: '1.0.0',
  capabilities: ['cli', 'metrics', 'token-efficiency', 'analysis'],
  keywords: ['metrics', 'tokens', 'efficiency', 'baseline', 'metagpt'],
  category: 'metrics',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['metrics tokens', 'token efficiency', 'token metrics', 'analyze tokens'],
    commandHint: {
      template: 'utility',
      allowedTools: ['Read', 'Bash'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

// Documentation Commands

export const docSyncCommand: Extension = {
  id: 'doc-sync',
  type: 'skill',
  name: 'Doc Sync',
  description: 'Synchronize documentation and code to eliminate drift with parallel audit and auto-fix',
  version: '1.0.0',
  capabilities: ['cli', 'documentation', 'synchronization', 'audit'],
  keywords: ['doc-sync', 'documentation', 'sync', 'drift', 'audit', 'reconcile'],
  category: 'documentation',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['doc sync', 'sync docs', 'documentation sync', 'fix doc drift', 'reconcile docs'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '<direction> [--dry-run --scope <path> --incremental]',
      allowedTools: ['Task', 'Read', 'Write', 'Bash', 'Glob', 'Grep', 'Edit'],
      executionSteps: [
        'Parse direction and options',
        'Dispatch parallel domain auditors',
        'Run cross-reference validation',
        'Generate drift report',
        'Apply auto-fixes and Ralph refinement',
        'Validate changes',
      ],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const docConsolidateCommand: Extension = {
  id: 'doc-consolidate',
  type: 'skill',
  name: 'Doc Consolidate',
  description: 'Crawl repository for scattered docs and consolidate into categorized reference index',
  version: '1.0.0',
  capabilities: ['cli', 'documentation', 'discovery', 'classification'],
  keywords: ['doc-consolidate', 'consolidate', 'docs', 'documentation', 'inventory', 'catalog'],
  category: 'documentation',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['consolidate docs', 'doc consolidate', 'find all docs', 'catalog docs', 'inventory docs', 'doc inventory'],
    commandHint: {
      template: 'orchestration',
      argumentHint: '[--dry-run] [--scope <path>] [--incremental] [--prefix <dir>]',
      allowedTools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
      executionSteps: [
        'Discover doc-like files across repository',
        'Classify each doc by purpose category',
        'Generate consolidated manifest',
        'Create stub files with source references',
        'Write run report and incremental state',
      ],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

// Lint Commands

export const lintCommand: Extension = {
  id: 'lint',
  type: 'skill',
  name: 'Lint',
  description: 'Lint AIWG artifacts against declarative rule sets',
  version: '1.0.0',
  capabilities: ['cli', 'lint', 'validation', 'quality'],
  keywords: ['lint', 'validate', 'check', 'rules', 'quality', 'integrity'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['lint', 'lint corpus', 'check research', 'validate artifacts', 'run lint'],
    commandHint: {
      template: 'utility',
      argumentHint: '<target> [--ruleset <name>] [--format full|summary|json] [--ci] [--fail-on error|warn|info] [--list-rulesets] [--list-rules <name>] [--dry-run]',
      allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
      executionSteps: [
        'Discover available rulesets from installed frameworks',
        'Auto-detect or select rulesets for target path',
        'Collect files matching rule glob patterns',
        'Run checks (frontmatter, references, patterns, cross-refs)',
        'Report diagnostics with severity and fix suggestions',
      ],
    },
  } satisfies SkillMetadata,
};

// Code Analysis Commands

export const cleanupAuditCommand: Extension = {
  id: 'cleanup-audit',
  type: 'skill',
  name: 'Cleanup Audit',
  description: 'Audit codebase for dead code, unused exports, orphaned files, and stale manifests',
  version: '1.0.0',
  capabilities: ['cli', 'analysis', 'code-quality', 'dead-code', 'cleanup'],
  keywords: ['cleanup', 'dead-code', 'unused', 'orphan', 'audit', 'depcheck'],
  category: 'maintenance',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['cleanup audit', 'dead code audit', 'find dead code', 'orphan files', 'unused exports'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--scope <path>] [--type <exports|files|deps|manifests>] [--json] [--fix] [--dry-run]',
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
      executionSteps: [
        'Determine analysis scope',
        'Analyze unused exports',
        'Detect orphaned files',
        'Audit dependencies',
        'Check manifest entries',
        'Compile confidence-rated report',
      ],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

// SDLC Orchestration Commands

export const bestPracticesAuditCommand: Extension = {
  id: 'best-practices-audit',
  type: 'skill',
  name: 'Best-Practices Audit',
  description: 'Research-grounded validation of a target against current external best practices, vendor documentation, and practitioner discussion',
  version: '1.0.0',
  capabilities: ['cli', 'research', 'validation', 'audit', 'citations'],
  keywords: ['best-practices-audit', 'audit', 'validate', 'research', 'practices', 'compare'],
  category: 'research-validation',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['best practices audit', 'audit best practices', 'validate against current practice', 'research-grounded validation'],
    commandHint: {
      template: 'orchestration',
      executedViaSkillRunner: true,
      argumentHint: '<target> [--focus <area> --standard <name> --depth quick|standard|deep --cite-threshold <N> --dissent --validate --output <path>]',
      allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
      executionSteps: [
        'Scope target and inventory claims',
        'Research fan-out via research-complete agents',
        'Source quality gating (citation-guard, GRADE, recency)',
        'Comparison and alignment determination',
        'Report writeup with full citations',
      ],
    },
  } satisfies SkillMetadata,
};

export const sdlcAccelerateCommand: Extension = {
  id: 'sdlc-accelerate',
  type: 'skill',
  name: 'SDLC Accelerate',
  description: 'End-to-end SDLC ramp-up from idea to construction-ready with automated phase transitions',
  version: '1.0.0',
  capabilities: ['cli', 'sdlc', 'orchestration', 'pipeline', 'accelerate'],
  keywords: ['sdlc-accelerate', 'accelerate', 'bootstrap', 'ramp-up', 'construction-ready', 'pipeline'],
  category: 'sdlc-orchestration',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['sdlc accelerate', 'accelerate sdlc', 'bootstrap project', 'ramp up sdlc', 'construction ready'],
    commandHint: {
      template: 'orchestration',
      executedViaSkillRunner: true,
      argumentHint: '<description> [--from-codebase <path> --resume --dry-run]',
      allowedTools: ['Task', 'Read', 'Write', 'Glob', 'TodoWrite'],
      executionSteps: [
        'Detect entry point',
        'Execute intake phase',
        'Evaluate LOM gate',
        'Execute elaboration phase',
        'Evaluate ABM gate',
        'Execute construction prep',
        'Generate Construction Ready Brief',
      ],
    },
  } satisfies SkillMetadata,
};

// Reproducibility Commands

export const executionModeCommand: Extension = {
  id: 'execution-mode',
  type: 'skill',
  name: 'Execution Mode',
  description: 'Set reproducibility mode for deterministic workflow execution',
  version: '1.0.0',
  capabilities: ['cli', 'reproducibility', 'configuration', 'execution-mode'],
  keywords: ['execution', 'mode', 'strict', 'seeded', 'reproducibility', 'determinism'],
  category: 'reproducibility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['execution mode', 'set execution mode', 'reproducibility mode', 'deterministic mode'],
    commandHint: {
      template: 'utility',
      argumentHint: '<mode> [--seed <value>]',
      allowedTools: ['Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const snapshotCommand: Extension = {
  id: 'snapshot',
  type: 'skill',
  name: 'Snapshot',
  description: 'Capture, list, or replay workflow execution snapshots',
  version: '1.0.0',
  capabilities: ['cli', 'reproducibility', 'snapshot', 'replay'],
  keywords: ['snapshot', 'replay', 'capture', 'execution', 'reproducibility'],
  category: 'reproducibility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['snapshot', 'capture snapshot', 'list snapshots', 'replay snapshot'],
    commandHint: {
      template: 'utility',
      argumentHint: '<list|show|capture> [options]',
      allowedTools: ['Read', 'Write', 'Bash'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const checkpointCommand: Extension = {
  id: 'checkpoint',
  type: 'skill',
  name: 'Checkpoint',
  description: 'Create, list, or restore workflow checkpoints for recovery',
  version: '1.0.0',
  capabilities: ['cli', 'reproducibility', 'checkpoint', 'recovery'],
  keywords: ['checkpoint', 'recovery', 'restore', 'state', 'reproducibility'],
  category: 'reproducibility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['checkpoint', 'create checkpoint', 'list checkpoints', 'recover checkpoint'],
    commandHint: {
      template: 'utility',
      argumentHint: '<list|recover|create> [options]',
      allowedTools: ['Read', 'Write', 'Bash'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const reproducibilityValidateCommand: Extension = {
  id: 'reproducibility-validate',
  type: 'skill',
  name: 'Reproducibility Validate',
  description: 'Verify workflow outputs match across multiple execution runs',
  version: '1.0.0',
  capabilities: ['cli', 'reproducibility', 'validation', 'compliance'],
  keywords: ['reproducibility', 'validate', 'verify', 'compare', 'compliance'],
  category: 'reproducibility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['reproducibility validate', 'validate reproducibility', 'verify reproducibility', 'compare workflow runs'],
    commandHint: {
      template: 'utility',
      argumentHint: '<workflow-id> [--runs <count>] [--threshold <value>]',
      allowedTools: ['Read', 'Bash'],
      cliDisabled: true,
    },
  } satisfies SkillMetadata,
};

export const behaviorCommand: Extension = {
  id: 'behavior',
  type: 'skill',
  name: 'Behavior',
  description: 'Manage behavior YAML bundles that bind directives and toolsets to agent types',
  version: '1.0.0',
  capabilities: ['cli', 'behavior', 'daemon', 'configuration'],
  keywords: ['behavior', 'directive', 'toolset', 'daemon', 'ops', 'agent-type'],
  category: 'daemon',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['behavior', 'list behaviors', 'apply behavior', 'manage behaviors'],
    commandHint: {
      template: 'utility',
      argumentHint: '<list|info|apply|remove> [name] [--to <agent>] [--from <agent>]',
      allowedTools: ['Read', 'Bash', 'Write'],
    },
  } satisfies SkillMetadata,
};

export const daemonInitCommand: Extension = {
  id: 'daemon-init',
  type: 'skill',
  name: 'Daemon Init',
  description: 'Initialize daemon config from a profile template (default: manager)',
  version: '1.0.0',
  capabilities: ['cli', 'daemon', 'configuration', 'scaffolding'],
  keywords: ['daemon', 'init', 'profile', 'manager', 'orchestrator', 'config'],
  category: 'daemon',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['daemon init', 'init daemon', 'initialize daemon', 'daemon setup'],
    commandHint: {
      template: 'utility',
      argumentHint: '[profile-name] [--force]',
      allowedTools: ['Bash', 'Read', 'Write'],
    },
  } satisfies SkillMetadata,
};

// Config Commands

export const configCommand: Extension = {
  id: 'config',
  type: 'skill',
  name: 'Config',
  description: 'Manage user-level AIWG configuration (get, set, list, validate, reset, path, edit)',
  version: '1.0.0',
  capabilities: ['cli', 'configuration', 'user-config', 'preferences'],
  keywords: ['config', 'configuration', 'settings', 'preferences', 'get', 'set', 'validate'],
  category: 'config',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['config', 'aiwg config', 'show config', 'get config', 'set config', 'configuration'],
    commandHint: {
      template: 'utility',
      argumentHint: '<get|set|list|validate|reset|path|edit> [key] [value] [--config-dir <path>]',
      allowedTools: ['Read', 'Write', 'Bash'],
      executionSteps: [
        'Parse subcommand and flags',
        'Resolve config directory (AIWG_CONFIG → --config-dir → ~/.aiwg → ~/.config/aiwg)',
        'Execute subcommand operation',
        'Display results',
      ],
    },
  } satisfies SkillMetadata,
};

// Ops Commands

export const opsCommand: Extension = {
  id: 'ops',
  type: 'skill',
  name: 'Ops',
  description: 'Manage ops ecosystem — init workspaces, deploy frameworks, manage multi-repo ops suites',
  version: '1.0.0',
  capabilities: ['cli', 'ops', 'infrastructure', 'workspace', 'multi-repo'],
  keywords: ['ops', 'operations', 'init', 'workspace', 'sysops', 'devops', 'itops'],
  category: 'ops',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['ops', 'ops init', 'ops status', 'manage ops', 'ops workspace'],
    commandHint: {
      template: 'utility',
      argumentHint: '<init|status|use|list|push> [options]',
      allowedTools: ['Bash', 'Read', 'Write'],
      executionSteps: [
        'Parse subcommand and options',
        'Resolve ops workspace from registry',
        'Execute workspace operation',
        'Update ops registry',
        'Display results',
      ],
    },
  } satisfies SkillMetadata,
};

// Provenance Subsystem Commands

export const provenanceCommand: Extension = {
  id: 'provenance',
  type: 'skill',
  name: 'Provenance',
  description: 'Storage operations on the AIWG provenance subsystem — used by provenance-* skills for W3C PROV records',
  version: '1.0.0',
  capabilities: ['cli', 'provenance', 'storage', 'audit', 'w3c-prov'],
  keywords: ['provenance', 'prov', 'lineage', 'audit'],
  category: 'utility',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['provenance path', 'list provenance', 'aiwg provenance'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path|list|get|put|delete|append-log> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and arguments',
        'Resolve storage adapter for provenance subsystem',
        'Read/write/list/delete/append-log via the adapter',
        'Print result',
      ],
    },
  } satisfies SkillMetadata,
};

// Research Store Commands

export const researchStoreCommand: Extension = {
  id: 'research-store',
  type: 'skill',
  name: 'Research Store',
  description: 'Storage operations on the AIWG research subsystem — corpus pages, source archives, and citation indexes',
  version: '1.0.0',
  capabilities: ['cli', 'research', 'corpus', 'storage'],
  keywords: ['research', 'corpus', 'research-store'],
  category: 'utility',
  platforms: { claude: 'full', generic: 'full' },
  deployment: { pathTemplate: '.{platform}/commands/{id}.md', core: true },
  metadata: {
    type: 'skill',
    triggerPhrases: ['research-store path', 'list research', 'aiwg research-store'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path|list|get|put|delete|append-log> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and arguments',
        'Resolve storage adapter for research subsystem',
        'Read/write/list/delete/append-log via the adapter',
        'Print result',
      ],
    },
  } satisfies SkillMetadata,
};

// Reflections Subsystem Commands

export const reflectionsCommand: Extension = {
  id: 'reflections',
  type: 'skill',
  name: 'Reflections',
  description: 'Storage operations on the AIWG reflections subsystem — used by ralph-reflect / reflection-injection',
  version: '1.0.0',
  capabilities: ['cli', 'reflections', 'agent-loop', 'storage'],
  keywords: ['reflections', 'ralph-reflect', 'reflection-injection', 'agent-loop'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['where are reflections', 'reflections path', 'list reflections', 'aiwg reflections'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path|list|get|put|delete|append-log> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and arguments',
        'Resolve storage adapter for reflections subsystem',
        'Read/write/list/delete/append-log via the adapter',
        'Print result',
      ],
    },
  } satisfies SkillMetadata,
};

// Memory Subsystem Commands

export const memoryCommand: Extension = {
  id: 'memory',
  type: 'skill',
  name: 'Memory',
  description: 'Storage operations on the AIWG memory subsystem, plus user-level project memory registry commands under ~/.aiwg/projects',
  version: '1.0.0',
  capabilities: ['cli', 'memory', 'semantic-memory', 'storage', 'pkm', 'project-memory', 'user-registry'],
  keywords: ['memory', 'semantic-memory', 'project-memory', 'registry', 'reflections', 'pages'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['where is memory', 'memory path', 'list memory', 'project memory', 'aiwg memory'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path|list|get|put|delete|append-log|project> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and arguments',
        'Resolve storage adapter for memory subsystem',
        'Read/write/list/delete/append-log via the adapter or manage project-memory mappings',
        'Print result',
      ],
    },
  } satisfies SkillMetadata,
};

// Knowledge Base Commands

export const kbCommand: Extension = {
  id: 'kb',
  type: 'skill',
  name: 'Knowledge Base',
  description: 'Storage operations on the AIWG knowledge base — resolve paths, list pages, get/put/delete entries through the configured backend',
  version: '1.0.0',
  capabilities: ['cli', 'kb', 'knowledge-base', 'storage', 'pkm'],
  keywords: ['kb', 'knowledge-base', 'pages', 'entities', 'concepts'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['where is the kb', 'kb path', 'list kb pages', 'aiwg kb'],
    commandHint: {
      template: 'utility',
      argumentHint: '<path|list|get|put|delete> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and arguments',
        'Resolve storage adapter for kb subsystem',
        'Read/write/list/delete via the adapter',
        'Print result',
      ],
    },
  } satisfies SkillMetadata,
};

// Activity Log Commands

export const activityLogCommand: Extension = {
  id: 'activity-log',
  type: 'skill',
  name: 'Activity Log',
  description: 'Query and manage .aiwg/activity.log — show entries, append new ones, summarize stats',
  version: '1.0.0',
  capabilities: ['cli', 'activity-log', 'audit', 'self-maintenance'],
  keywords: ['activity', 'log', 'audit', 'history', 'timeline'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['activity log', 'show activity', 'log this', 'audit timeline'],
    commandHint: {
      template: 'utility',
      argumentHint: '<show|append|stats> [options]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand and options',
        'Resolve storage adapter for activity_log subsystem',
        'Read or write entries via the adapter',
        'Format output (newest-first for show, table for stats)',
      ],
    },
  } satisfies SkillMetadata,
};

export const commandLogCommand: Extension = {
  id: 'command-log',
  type: 'skill',
  name: 'Command Log',
  description: 'Report opt-in local CLI command invocation logs with project/global scope summaries and JSON output',
  version: '1.0.0',
  capabilities: ['cli', 'command-log', 'telemetry', 'analysis', 'self-maintenance'],
  keywords: ['command', 'log', 'usage', 'telemetry', 'analysis', 'invocation'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['command log', 'show command usage', 'cli usage analysis', 'which aiwg commands are used'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--json] [--scope project|global|all] [--limit N]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Read project and/or global command-log JSONL stores',
        'Summarize command frequency, failures, and recent invocations',
        'Print a human report or JSON for automation',
      ],
    },
  } satisfies SkillMetadata,
};

export const skillUsageCommand: Extension = {
  id: 'skill-usage',
  type: 'skill',
  name: 'Skill Usage',
  description: 'Report opt-in local skill, agent, and command utilization with project/global scope summaries and JSON output',
  version: '1.0.0',
  capabilities: ['cli', 'skill-usage', 'telemetry', 'analysis', 'self-maintenance'],
  keywords: ['skill', 'agent', 'usage', 'telemetry', 'analysis', 'heatmap', 'invocation'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['skill usage', 'show skill usage', 'agent usage analysis', 'which aiwg skills are used'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--json] [--scope project|global|all] [--limit N] [--suggest-for "query"] | ingest-transcript <path> --provider claude-code [--project-root <path>] [--dry-run] [--json]',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Read project and/or global skill-usage JSONL stores',
        'Optionally parse a targeted Claude Code JSONL transcript for structural skill/agent invocations',
        'Summarize artifact frequency, recency heatmap, cold spots, failures, actions, and recent usage',
        'Suggest relevant under-used skills when --suggest-for is provided',
        'Print a human report or JSON for automation',
      ],
    },
  } satisfies SkillMetadata,
};

// Storage Commands

export const storageCommand: Extension = {
  id: 'storage',
  type: 'skill',
  name: 'Storage',
  description: 'Manage AIWG storage adapters — show effective config, list compiled-in backends, round-trip-test a subsystem',
  version: '1.0.0',
  capabilities: ['cli', 'storage', 'configuration', 'pkm', 'self-maintenance'],
  keywords: ['storage', 'backend', 'adapter', 'obsidian', 'logseq', 'notion', 'fortemi', 'pkm'],
  category: 'utility',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['storage show', 'storage backends', 'where do my notes go', 'aiwg storage'],
    commandHint: {
      template: 'utility',
      argumentHint: '<show|list-backends|test <subsystem>>',
      allowedTools: ['Bash', 'Read'],
      executionSteps: [
        'Parse subcommand',
        'Load .aiwg/storage.config (or default to fs)',
        'Resolve backend per subsystem',
        'Execute requested operation',
        'Print results',
      ],
    },
  } satisfies SkillMetadata,
};

// Agentic Tools Commands (RLM support tools)

export const chunkCommand: Extension = {
  id: 'chunk',
  type: 'skill',
  name: 'Chunk',
  description: 'Split a file into overlapping chunks for parallel fanout processing',
  version: '1.0.0',
  capabilities: ['rlm', 'chunking', 'agentic-tools', 'context-decomposition'],
  keywords: ['chunk', 'split', 'fanout', 'rlm', 'decompose', 'context'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['chunk file', 'split file', 'prepare for fanout', 'chunk for rlm'],
    commandHint: {
      template: 'utility',
      argumentHint: '<file> [--size N] [--overlap N] [--format json|text] [--output <dir>]',
      allowedTools: ['Read', 'Write', 'Bash'],
      executionSteps: [
        'Read source file',
        'Apply chunking strategy (semantic-boundary or fixed-count)',
        'Write chunk files with overlap',
        'Output JSON manifest of chunk locations',
      ],
    },
  } satisfies SkillMetadata,
};

export const fanoutCommand: Extension = {
  id: 'fanout',
  type: 'skill',
  name: 'Fanout',
  description: 'Dispatch parallel subagent queries across a chunk manifest',
  version: '1.0.0',
  capabilities: ['rlm', 'fanout', 'agentic-tools', 'parallel-search'],
  keywords: ['fanout', 'parallel', 'search', 'rlm', 'subagent', 'dispatch'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['fanout search', 'parallel search chunks', 'dispatch across chunks'],
    commandHint: {
      template: 'utility',
      argumentHint: '<query> --chunks <dir|manifest.json> [--parallel N] [--model haiku|sonnet|opus]',
      allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
      executionSteps: [
        'Read chunk manifest',
        'Dispatch parallel subagents up to --parallel limit',
        'Each subagent queries one chunk',
        'Collect and aggregate results with provenance',
      ],
    },
  } satisfies SkillMetadata,
};

export const rlmPrepCommand: Extension = {
  id: 'rlm-prep',
  type: 'skill',
  name: 'RLM Prep',
  description: 'Prepare source content for RLM processing (chunk + index + manifest)',
  version: '1.0.0',
  capabilities: ['rlm', 'prep', 'agentic-tools', 'indexing'],
  keywords: ['rlm-prep', 'prepare', 'index', 'rlm', 'manifest', 'chunk'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['prepare for rlm', 'rlm prep', 'index for recursive search'],
    commandHint: {
      template: 'utility',
      argumentHint: '<file|dir> [--output <dir>] [--strategy semantic-boundary|fixed-count|adaptive] [--size N]',
      allowedTools: ['Read', 'Write', 'Glob', 'Bash'],
      executionSteps: [
        'Discover all files in source path',
        'Apply chunking strategy per file',
        'Build searchable index',
        'Write manifest.json with chunk locations and metadata',
      ],
    },
  } satisfies SkillMetadata,
};

export const rlmSearchCommand: Extension = {
  id: 'rlm-search',
  type: 'skill',
  name: 'RLM Search',
  description: 'Full recursive search pipeline: decompose source, fanout query, synthesize results',
  version: '1.0.0',
  capabilities: ['rlm', 'search', 'agentic-tools', 'recursive', 'synthesis'],
  keywords: ['rlm-search', 'recursive', 'search', 'fanout', 'synthesize', 'rlm'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['rlm search', 'recursive search', 'search large codebase', 'fanout and synthesize'],
    commandHint: {
      template: 'utility',
      argumentHint: '<query> --source <file|dir> [--depth N] [--parallel N] [--budget N]',
      allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'Bash'],
      executionSteps: [
        'Run rlm-prep on source if not already prepped',
        'Fanout query across all chunks (respecting --parallel)',
        'If results exceed context: chunk again and recurse',
        'When synthesis fits in single window: produce final answer',
        'Output result with provenance and cost summary',
      ],
    },
  } satisfies SkillMetadata,
};

export const rlmStatusCommand: Extension = {
  id: 'rlm-status',
  type: 'skill',
  name: 'RLM Status',
  description: 'Show active RLM task tree, progress, and cost breakdown',
  version: '1.0.0',
  capabilities: ['rlm', 'status', 'agentic-tools', 'monitoring'],
  keywords: ['rlm-status', 'status', 'task-tree', 'progress', 'cost', 'rlm'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ['rlm status', 'show rlm progress', 'rlm task tree', 'rlm cost'],
    commandHint: {
      template: 'utility',
      argumentHint: '[--cost] [--tree] [--json] [--task-id <id>]',
      allowedTools: ['Read', 'Bash'],
      executionSteps: [
        'Read active task tree from .aiwg/ralph/rlm-state.json',
        'Show progress per node (pending/running/complete/failed)',
        'Display cost breakdown if --cost flag set',
        'Output as JSON if --json flag set',
      ],
    },
  } satisfies SkillMetadata,
};

export const rlmCacheCommand: Extension = {
  id: 'rlm-cache',
  type: 'command',
  name: 'RLM Cache',
  description: 'Manage cached RLM results (list, stats, evict, clear) — keyed by index content-hash (#1203)',
  version: '1.0.0',
  capabilities: ['rlm', 'cache', 'agentic-tools', 'efficiency'],
  keywords: ['rlm-cache', 'cache', 'rlm', 'evict', 'list', 'stats'],
  category: 'agentic-tools',
  platforms: {
    claude: 'full',
    generic: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: false,
  },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '<list|stats|evict|clear> [args]',
    allowedTools: ['Read', 'Bash'],
  } satisfies CommandMetadata,
};

// ============================================
// Aggregated Exports
// ============================================

/**
 * All command definitions
 *
 * Organized by category:
 * - Maintenance (5): help, version, doctor, update, sync
 * - Framework (3): use, list, remove
 * - Project (4): new, init, run, serve
 * - Workspace (4): status, wizard, migrate-workspace, rollback-workspace
 * - MCP (1): mcp
 * - Catalog (1): catalog
 * - Toolsmith (1): runtime-info
 * - Utility (3): prefill-cards, contribute-start, validate-metadata
 * - Plugin (5): install-plugin, uninstall-plugin, plugin-status, package-plugin, package-all-plugins
 * - Scaffolding (8): add-agent, add-command, add-skill, add-behavior, add-template, scaffold-addon, scaffold-extension, scaffold-framework
 * - Ralph (8): ralph, ralph-status, ralph-abort, ralph-resume, ralph-attach, agent-loop-ext, ralph-memory, ralph-config
 * - Mission Control (1): mc
 * - Metrics (3): cost-report, cost-history, metrics-tokens
 * - Documentation (1): doc-sync
 * - Code Analysis (1): cleanup-audit
 * - SDLC Orchestration (1): sdlc-accelerate
 * - Index (1): index
 * - Reproducibility (4): execution-mode, snapshot, checkpoint, reproducibility-validate
 * - Daemon (2): behavior, daemon-init
 * - Config (1): config
 * - Ops (1): ops
 * - Agentic Tools (5): chunk, fanout, rlm-prep, rlm-search, rlm-status
 */
export const commandDefinitions: Extension[] = [
  // Maintenance (7)
  helpCommand,
  versionCommand,
  authCommand,
  doctorCommand,
  contextFirewallCommand,
  updateCommand,
  installationCommand,
  refreshCommand,
  regenerateCommand,
  workspaceContextCommand,

  // Framework (6)
  useCommand,
  modelsCommand,
  jobCommand,
  cockpitCommand,
  listCommand,
  removeCommand,
  promoteCommand,
  newBundleCommand,
  quickrefCommand,
  installCommand,
  packagesCommand,
  marketplaceCommand,

  // Project
  newCommand,
  initCommand,
  setupCommand,
  setupGenerateCommand,
  setupValidateCommand,
  setupRunCommand,
  issueCommand,
  issueAuditCommand,
  addressIssuesCommand,
  runCommand,
  serveCommand,
  localExecutorCommand,
  localExecutorServeCommand,

  // Workspace (4)
  statusCommand,
  wizardCommand,
  migrateWorkspaceCommand,
  rollbackWorkspaceCommand,

  // MCP (1)
  mcpCommand,

  // Catalog (2)
  catalogCommand,
  skillsCommand,

  // Toolsmith (1)
  runtimeInfoCommand,
  agentcardCommand,
  uhpCommand,

  // Utility (5)
  prefillCardsCommand,
  contributeStartCommand,
  validateMetadataCommand,
  skillLintCommand,
  repoAccessCommand,

  // Plugin (5)
  installPluginCommand,
  uninstallPluginCommand,
  pluginStatusCommand,
  packagePluginCommand,
  packageAllPluginsCommand,

  // Scaffolding (8)
  addAgentCommand,
  addCommandCommand,
  addSkillCommand,
  addBehaviorCommand,
  addTemplateCommand,
  scaffoldAddonCommand,
  scaffoldExtensionCommand,
  scaffoldFrameworkCommand,

  // Ralph (8)
  ralphCommand,
  ralphStatusCommand,
  ralphAbortCommand,
  ralphResumeCommand,
  ralphAttachCommand,
  agentLoopExtCommand,
  ralphMemoryCommand,
  ralphConfigCommand,

  // Mission Control (1)
  mcCommand,
  missionCommand,

  // Steward (1)
  stewardCommand,

  // Agent Teams (1)
  teamCommand,

  // Metrics (4)
  evidenceCommand,
  artifactVerifyCommand,
  costReportCommand,
  costHistoryCommand,
  metricsTokensCommand,

  // Documentation (2)
  docSyncCommand,
  docConsolidateCommand,

  // Lint (1)
  lintCommand,

  // Code Analysis (1)
  cleanupAuditCommand,

  // SDLC Orchestration (1)
  sdlcAccelerateCommand,

  // Research Validation (1)
  bestPracticesAuditCommand,

  // Index + Discovery
  indexCommand,
  artifactsCommand,
  effectCommand,
  corpusCommand,
  researchQueryCommand,
  discoverCommand,
  showCommand,
  versionsCommand,

  // Optional Features (1)
  featuresCommand,

  // Reproducibility (4)
  executionModeCommand,
  snapshotCommand,
  checkpointCommand,
  reproducibilityValidateCommand,

  // Daemon (2)
  behaviorCommand,
  daemonInitCommand,

  // Config (1)
  configCommand,

  // Ops (1)
  opsCommand,

  // Storage (1)
  storageCommand,

  // Activity Log (1)
  activityLogCommand,
  commandLogCommand,
  skillUsageCommand,

  // Knowledge Base (1)
  kbCommand,

  // Memory subsystem (1)
  memoryCommand,

  // Reflections subsystem (1)
  reflectionsCommand,

  // Provenance subsystem (1)
  provenanceCommand,

  // Research subsystem (1)
  researchStoreCommand,

  // Agentic Tools (5) — RLM support tools
  chunkCommand,
  fanoutCommand,
  rlmPrepCommand,
  rlmSearchCommand,
  rlmStatusCommand,
  rlmCacheCommand,

  // Sandbox management (#917)
  sandboxCommand,

  // Diagnose (#925)
  diagnoseCommand,

  // Feedback (#885)
  feedbackCommand,

  // Session (#884)
  sessionCommand,
  sessionsCommand,
  outputModeCommand,
  writerProfileCommand,
  botHandoffCommand,
  buildVerifyCommand,
  writingCommand,
  schemaCommand,
  datasetCommand,
];

// ============================================
// Helper Functions
// ============================================

/**
 * Get command definition by ID
 *
 * @param id - Command ID
 * @returns Command definition or undefined
 */
export function getCommandDefinition(id: string): Extension | undefined {
  return commandDefinitions.find((cmd) => cmd.id === id);
}

/**
 * Get command definitions by category
 *
 * @param category - Command category
 * @returns Array of matching command definitions
 */
export function getCommandsByCategory(category: string): Extension[] {
  return commandDefinitions.filter((cmd) => cmd.category === category);
}

/**
 * Get total command count
 *
 * @returns Total number of command definitions
 */
export function getCommandCount(): number {
  return commandDefinitions.length;
}

/**
 * Get all command IDs
 *
 * @returns Array of command IDs
 */
export function getCommandIds(): string[] {
  return commandDefinitions.map((cmd) => cmd.id);
}

/**
 * Search commands by keyword
 *
 * @param keyword - Keyword to search for
 * @returns Array of matching command definitions
 */
export function searchCommandsByKeyword(keyword: string): Extension[] {
  const lowercaseKeyword = keyword.toLowerCase();
  return commandDefinitions.filter((cmd) =>
    cmd.keywords.some((k) => k.toLowerCase().includes(lowercaseKeyword))
  );
}

/**
 * Search commands by capability
 *
 * @param capability - Capability to search for
 * @returns Array of matching command definitions
 */
export function searchCommandsByCapability(capability: string): Extension[] {
  const lowercaseCapability = capability.toLowerCase();
  return commandDefinitions.filter((cmd) =>
    cmd.capabilities.some((c) => c.toLowerCase().includes(lowercaseCapability))
  );
}
