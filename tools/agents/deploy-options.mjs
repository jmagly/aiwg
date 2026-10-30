// Parse deploy options and resolve provider modules.
import path from "node:path";
export function parseArgs(args = process.argv.slice(2)) {
  const cfg = {
    source: null,
    userScope: false,
    target: process.cwd(),
    mode: 'all',  // 'general', 'sdlc', 'marketing', 'media-curator', 'research', 'both' (legacy), or 'all'
    dryRun: false,
    force: false,
    provider: 'claude',
    model: null,             // Blanket override for all tiers
    modelTier: null,         // Blanket canonical tier override
    reasoningModel: null,
    codingModel: null,
    efficiencyModel: null,
    asAgentsMd: false,
    createAgentsMd: false,
    contextFiles: true,
    projectScope: false,
    deployCommands: false,
    deploySkills: false,
    deployRules: false,
    deployBehaviors: false,      // Deploy behaviors (native on openclaw, emulated on others)
    commandsOnly: false,
    skillsOnly: false,
    rulesOnly: false,
    strict: false,
    reportOnly: true,
    kernelOnly: false,
    deferRuleProjection: false,
    additionalSources: [],
    filter: null,           // Glob pattern for agent names
    filterRole: null,       // Filter by role: reasoning|coding|efficiency
    save: false,            // Save model config to project models.json
    saveUser: false,        // Save model config to ~/.config/aiwg/models.json
    verbose: false,         // Show per-file deployment details
    quiet: false,           // Suppress all non-error output (for embedding in use.ts)
    asPlugin: false,        // Generate .factory-plugin/ bundle (Factory provider only)
    deployBehaviors: false, // Deploy behaviors in addition to agents
    skipCommandsMigration: false, // Skip commands → skills migration (warns about duplicates)
    warnOnSkippedCommandsMigration: true, // Emit the duplicate warning when the migration is skipped
    // Managed-marker provenance (#2502). Deployers that are not shipping the
    // bundled framework corpus (project-local bundles, in particular) must
    // override these so `aiwg refresh` does not mistake their artifacts for
    // stale copies of packaged ones.
    deploySource: null,           // Managed-marker source; defaults to 'bundled'
    listingBudget: false,         // Honor the provider startup-listing cap despite --copy-all (#2561)
    deployVersion: null,          // Managed-marker version; defaults to srcRoot package.json
    mcp: false,                   // #228: opt-in MCP settings profile (Muse provider)
    hooks: true,                  // #228: managed project hooks (Muse provider); --no-hooks opts out
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--additional-source') {
      const source = args[++i];
      if (!source || source.startsWith('--')) throw new Error('--additional-source requires a source directory');
      cfg.additionalSources.push(path.resolve(source));
    }
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--scope') {
      const scope = args[++i];
      if (scope !== 'user' && scope !== 'project') {
        throw new Error(`--scope expected 'user' or 'project', got '${scope ?? '(missing)'}'`);
      }
      cfg.userScope = scope === 'user';
      cfg.projectScope = scope === 'project';
    }
    else if (a === '--user') cfg.userScope = true;
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if ((a === '--provider' || a === '--platform') && args[i + 1]) cfg.provider = String(args[++i]).toLowerCase();
    else if (a === '--model' && args[i + 1]) cfg.model = args[++i];
    else if (a === '--model-tier' && args[i + 1]) cfg.modelTier = String(args[++i]).toLowerCase();
    else if ((a === '--reasoning-model' || a === '--reasoning') && args[i + 1]) cfg.reasoningModel = args[++i];
    else if ((a === '--coding-model' || a === '--coding') && args[i + 1]) cfg.codingModel = args[++i];
    else if ((a === '--efficiency-model' || a === '--efficiency') && args[i + 1]) cfg.efficiencyModel = args[++i];
    else if (a === '--as-agents-md') cfg.asAgentsMd = true;
    else if (a === '--create-agents-md') cfg.createAgentsMd = true;
    else if (a === '--deploy-commands') cfg.deployCommands = true;
    else if (a === '--deploy-skills') cfg.deploySkills = true;
    else if (a === '--deploy-rules') cfg.deployRules = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--commands-only') cfg.commandsOnly = true;
    else if (a === '--skills-only') cfg.skillsOnly = true;
    else if (a === '--rules-only') cfg.rulesOnly = true;
    else if (a === '--strict') { cfg.strict = true; cfg.reportOnly = false; }
    else if (a === '--allow-over-budget') cfg.allowOverBudget = true;
    else if (a === '--report-only') cfg.reportOnly = true;
    else if (a === '--kernel-only') cfg.kernelOnly = true;
    // Internal use orchestration: the final source owns rule presentation.
    else if (a === '--defer-rule-projection') cfg.deferRuleProjection = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--filter' && args[i + 1]) cfg.filter = args[++i];
    else if (a === '--filter-role' && args[i + 1]) cfg.filterRole = args[++i];
    else if (a === '--save') cfg.save = true;
    else if (a === '--save-user') cfg.saveUser = true;
    else if (a === '--verbose' || a === '-v') cfg.verbose = true;
    else if (a === '--quiet' || a === '-q') cfg.quiet = true;
    else if (a === '--as-plugin') cfg.asPlugin = true;
    else if (a === '--skip-commands-migration') cfg.skipCommandsMigration = true;
    // Structural opt-out: skip the migration without claiming the operator declined it (#2541).
    else if (a === '--no-commands-warning') cfg.warnOnSkippedCommandsMigration = false;
    else if (a === '--copy-all' || a === '--copy-standard-skills') cfg.copyStandardSkills = true;
    // #228: Muse provider — explicit opt-in MCP settings profile, and the
    // managed-hooks opt-out (default on, mirroring the Claude autoInstall policy).
    else if (a === '--mcp') cfg.mcp = true;
    else if (a === '--no-hooks') cfg.hooks = false;
    else if (a === '--no-attribution') cfg.attribution = false;
    else if (a === '--no-context-files') cfg.contextFiles = false;
    else if (a === '--deploy-source' && args[i + 1]) cfg.deploySource = String(args[++i]);
    else if (a === '--listing-budget') cfg.listingBudget = true;
    else if (a === '--deploy-version' && args[i + 1]) cfg.deployVersion = String(args[++i]);
    else if (a === '--help' || a === '-h') {
      cfg.help = true;
    }
  }
  return cfg;
}

export function printHelp() {
  console.log(`
Deploy Agents and Commands

Usage:
  node tools/agents/deploy-agents.mjs [options]
  aiwg -deploy-agents [options]

Options:
  --source <path>          Source directory (defaults to repo root)
  --target <path>          Target directory (defaults to cwd)
  --scope <user|project>   Deployment scope (default: project)
  --user                  Shorthand for --scope user
  --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
  --deploy-commands        Deploy commands in addition to agents
  --deploy-skills          Deploy skills in addition to agents
  --deploy-rules           Deploy rules in addition to agents
  --commands-only          Deploy only commands (skip agents)
  --skills-only            Deploy only skills (skip agents)
  --rules-only             Deploy only rules (skip agents)
  --kernel-only            Deploy kernel skills and rules; prune managed bulk agents/commands
  --dry-run                Show what would be deployed without writing
  --force                  Overwrite existing files
  --provider <name>        Target provider (see below)
  --model <name>           Override model for all tiers (blanket)
  --reasoning-model <name> Override model for reasoning tasks (alias: --reasoning)
  --coding-model <name>    Override model for coding tasks (alias: --coding)
  --efficiency-model <name> Override model for efficiency tasks (alias: --efficiency)
  --model-tier <tier>      Override all artifacts with economy|standard|premium
  --filter <pattern>       Only deploy agents matching pattern (glob)
  --filter-role <role>     Only deploy agents of role: reasoning|coding|efficiency
  --save                   Save model config to project models.json
  --save-user              Save model config to ~/.config/aiwg/models.json
  --mcp                    Muse provider: opt in to the AIWG MCP settings profile
                           (merges the aiwg stdio server into user settings
                           mcp_servers; default off)
  --no-hooks               Muse provider: skip managed project hooks
                           (.muse/hooks.json; installed by default)
  --no-attribution         Claude provider: leave attribution settings untouched
  --as-agents-md               Aggregate to single AGENTS.md (Codex)
  --create-agents-md           Create/update AGENTS.md template
  --no-context-files           Preserve WORKSPACE.md, AIWG.md and AGENTS.md (including managed blocks)
  --skip-commands-migration    Skip deleting the commands directory before skills deployment
  --listing-budget             Honor the provider startup-listing cap even with --copy-all
  --deploy-source <name>       Managed-marker source stamped into deployed artifacts.
                               Defaults to 'bundled'. Deploys that do not ship the packaged
                               framework corpus (e.g. project-local bundles) MUST override
                               this so refresh's stale-artifact prune skips them (#2502).
  --deploy-version <version>   Managed-marker version stamped into deployed artifacts.
                               Defaults to the --source tree's package.json version.
  --copy-all                   Copy ALL skills per-project (legacy mirror at <provider>/.aiwg/skills/).
                               For aiwg use all, this also restores the legacy full agent,
                               command, and expanded-rule copy. Default bulk deployment is
                               kernel-only + index-driven discovery for the rest (#1217).
                               Use this for sandboxed runtimes / air-gapped corpora where
                               $AIWG_ROOT isn't readable from the agent's working dir.
                               Alias: --copy-standard-skills — rc.29 era).
                               (warns about duplicate entries in the provider command palette)

Model Override Examples:
  # Use sonnet for everything
  aiwg use sdlc --model sonnet

  # Override individual tiers
  aiwg use sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Use a specific model ID for coding tier
  aiwg use sdlc --provider factory --coding-model gpt-5.6-terra

  # Blanket with per-tier override (reasoning uses opus, others use sonnet)
  aiwg use sdlc --model sonnet --reasoning opus

  # Save overrides to project models.json for future deployments
  aiwg use sdlc --model sonnet --save

Model Precedence:
  CLI flags > project models.json > user ~/.config/aiwg/models.json > AIWG defaults

Shorthand Values:
  opus, sonnet, haiku, inherit — resolved per provider to full model IDs

Providers (all deploy agents, commands, skills, and rules):
  claude    - Claude Code (default)
              Paths: .claude/agents/, .claude/commands/, .claude/skills/, .claude/rules/
  factory   - Factory AI
              Paths: .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
  codex     - OpenAI Codex (alias: openai)
              Paths: .codex/agents/, .codex/commands/, .codex/skills/, .codex/rules/
  opencode  - OpenCode
              Paths: .opencode/skill/, .opencode/rule/ (agents/commands not file-based in OpenCode)
  copilot   - GitHub Copilot
              Paths: .github/agents/, .github/commands/, .github/skills/, .github/copilot-rules/
  cursor    - Cursor IDE
              Paths: .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
  warp      - Warp Terminal
              Paths: .warp/agents/, .warp/commands/, .warp/skills/, .warp/rules/ + WARP.md
  deepseek-harness - DeepSeek Harness (alias: dsh; experimental)
              Paths: AGENTS.md, .agents/skills/, .dsh/aiwg.cordis.patch.yml
  devin     - Devin Desktop (preferred; aliases: devin-desktop, windsurf)
              Paths: .windsurf/agents/, .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/
  grokbot   - Grok Bot (AGENTS.md bridge; skills only with AIWG_GROKBOT_SKILLS_DIR)
  grok-build - Grok Build (experimental; .grok paths + $GROK_HOME; no bare grok alias)
  muse      - Muse Code (stable; AGENTS.md bridge; .agents/skills + XDG user root; managed hooks, opt-in --mcp; no aliases)
  hermes    - Hermes Agent (MCP-based integration)
              Skills: $HERMES_HOME/skills/ (user-global; defaults to ~/.hermes/skills/) | Agents: AGENTS.md
              Commands/Rules: served via MCP, not file-deployed

Modes:
  general       - Writing-quality addon agents and commands (alias: writing)
  sdlc          - SDLC Complete framework agents and commands
  marketing     - Media/Marketing Kit framework agents and commands (alias: mmk)
  media-curator - Media Curator framework agents and commands
  research      - Research Complete framework agents and commands
  both          - writing + SDLC (legacy compatibility)
  all           - All frameworks + addons (default)

Examples:
  # Deploy SDLC framework to Claude Code
  aiwg -deploy-agents --mode sdlc

  # Deploy to Factory with commands and AGENTS.md
  aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands --create-agents-md

  # Deploy to GitHub Copilot
  aiwg -deploy-agents --provider copilot --mode sdlc

  # Override model for all tiers
  aiwg -deploy-agents --mode sdlc --model sonnet

  # Override individual tiers
  aiwg -deploy-agents --mode sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Dry run to preview deployment
  aiwg -deploy-agents --provider cursor --mode sdlc --dry-run
`);
}
