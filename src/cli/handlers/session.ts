/**
 * Session Command Handler
 *
 * Starts an agentic session for a configured provider with full pre-flight:
 *   1. Version check — updates aiwg if stale
 *   2. Doctor — auto-repairs fixable issues
 *   3. Deployment check — redeploys framework files if missing/stale
 *   4. MCP inject (optional, `aiwg session mcp`)
 *   5. Launch binary (spawnable providers) or print start instructions (IDE providers)
 *
 * Usage:
 *   aiwg session                        # default provider, full pre-flight + launch
 *   aiwg session mcp                    # inject configured MCPs first, then launch
 *   aiwg session --provider codex       # explicit provider
 *   aiwg session mcp --provider cursor  # MCP inject for cursor + start instructions
 *   aiwg session --no-repair            # skip auto-repair (still check and report)
 *
 * @issue #884
 */

import { spawnSync } from 'child_process';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { ensureRuntimeHome, writeProfileConfig, launchWithProfile } from '../../mcp/adapters/codex-runtime.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { forceUpdateCheck } from '../../update/checker.mjs';
import { updateInstallation } from '../../update/service.mjs';
import {
  readAiwgConfig,
  getDeploymentSummary,
  VALID_PROVIDERS,
} from '../../config/aiwg-config.js';
import {
  getProviderConfig,
  isSpawnableProvider,
  PROVIDER_CONFIGS,
} from '../agent-spawn.js';
import { useHandler as useFrameworkHandler } from './use.js';
import { debug } from '../log.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';

// ── Provider resolution ──────────────────────────────────────────────────────

/**
 * Resolve which provider to target.
 * Precedence: --provider flag > project config providers[0] > 'claude'
 */
async function resolveProvider(
  explicitProvider: string | undefined,
  cwd: string,
): Promise<string> {
  if (explicitProvider) {
    const normalized = normalizeProviderDefinitionId(explicitProvider);
    if (!normalized || normalized === 'generic' || !VALID_PROVIDERS.includes(normalized as never)) {
      throw new Error(`Unsupported provider '${explicitProvider}'`);
    }
    return normalized;
  }

  const config = await readAiwgConfig(cwd);
  if (config?.providers?.[0]) {
    return config.providers[0];
  }

  return 'claude';
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface SessionArgs {
  /** Inject MCP servers before launch */
  mcp: boolean;
  /** Target provider (undefined = resolve from config) */
  provider: string | undefined;
  /** Skip auto-repair — check only */
  noRepair: boolean;
  /** MCP profile name — launch with profile-scoped server set (#891) */
  profile: string | undefined;
  /** Persist profile injection to provider config (default: ephemeral) */
  persist: boolean;
}

function parseSessionArgs(args: string[]): SessionArgs {
  let mcp = false;
  let provider: string | undefined;
  let noRepair = false;
  let profile: string | undefined;
  let persist = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'mcp') {
      mcp = true;
    } else if (a === '--provider' && args[i + 1]) {
      provider = args[++i];
    } else if (a === '--no-repair') {
      noRepair = true;
    } else if (a === '--profile' && args[i + 1]) {
      profile = args[++i];
    } else if (a === '--persist') {
      persist = true;
    }
  }

  return { mcp, provider, noRepair, profile, persist };
}

// ── Pre-flight steps ─────────────────────────────────────────────────────────

/** Run `npm view aiwg version` and compare to current. Returns true if up-to-date. */
async function checkAndUpdateVersion(noRepair: boolean): Promise<boolean> {
  console.log('  Checking aiwg version...');
  try {
    await forceUpdateCheck();
    return true;
  } catch (err) {
    // forceUpdateCheck handles its own user-visible output — the underlying
    // error is only relevant for troubleshooting, gated behind AIWG_DEBUG.
    debug('cli:session:update', 'forceUpdateCheck failed', err);
    if (!noRepair) {
      console.log('  Version check failed — attempting sync...');
      try {
        await updateInstallation();
      } catch (updateError) {
        debug('cli:session:update', 'canonical installation update failed', updateError);
        console.warn('  WARN  Could not update aiwg — continuing with current version.');
        return false;
      }
    }
    return true;
  }
}

/**
 * Run `aiwg doctor` and return whether it passed.
 * Uses the same script runner path as doctorHandler to avoid duplication.
 */
function runDoctor(_frameworkRoot: string, cwd: string): boolean {
  const result = spawnSync(
    process.execPath,
    [process.argv[1]!, 'doctor'],
    { stdio: 'inherit', cwd },
  );
  return (result.status ?? 1) === 0;
}

/**
 * Attempt to repair a failed doctor result.
 * Strategy: `aiwg sync`; package repair remains bound to the canonical update
 * strategy and never falls through to an arbitrary npm on PATH.
 * Returns true if repair succeeded (doctor now passes).
 */
function repairInstallation(
  frameworkRoot: string,
  cwd: string,
  provider: string,
): boolean {
  // Strategy 1: sync (update + redeploy)
  console.log('\n  Attempting auto-repair via `aiwg sync`...');
  const syncResult = spawnSync(
    process.execPath,
    [process.argv[1]!, 'sync'],
    { stdio: 'inherit', cwd },
  );

  if (syncResult.status === 0) {
    // Re-check doctor
    const doctorOk = runDoctor(frameworkRoot, cwd);
    if (doctorOk) {
      console.log('  OK  Auto-repair succeeded.');
      return true;
    }
  }

  // Could not auto-repair
  console.log(`
  ✗  Auto-repair could not resolve all issues.

  Manual options:
    aiwg installation show          — inspect canonical install drift
    aiwg refresh                    — update and redeploy canonically
    aiwg use all --provider ${provider.padEnd(10)} — redeploy all frameworks

  Report this issue:
    aiwg feedback --type bug
`);
  return false;
}

/**
 * Check whether framework files are deployed for the given provider.
 * Returns list of framework names that need (re)deployment.
 */
async function checkDeployment(
  cwd: string,
  provider: string,
): Promise<string[]> {
  const config = await readAiwgConfig(cwd);
  if (!config || Object.keys(config.installed).length === 0) {
    return []; // no frameworks configured — nothing to check
  }

  const summary = getDeploymentSummary(config, provider);
  const total = summary.agents + summary.commands + summary.skills + summary.rules;

  if (total === 0) {
    // Frameworks are registered but not deployed to this provider
    return Object.keys(config.installed);
  }

  return []; // deployed OK
}

/**
 * Redeploy all given frameworks to the provider.
 */
async function redeployFrameworks(
  ctx: HandlerContext,
  frameworks: string[],
  provider: string,
): Promise<void> {
  console.log(`\n  Redeploying ${frameworks.join(', ')} to ${provider}...`);
  for (const fw of frameworks) {
    await useFrameworkHandler.execute({
      ...ctx,
      args: [fw, '--provider', provider],
    });
  }
}

// ── MCP inject ────────────────────────────────────────────────────────────────

function injectMcp(provider: string, cwd: string): boolean {
  console.log(`\n  Injecting configured MCP servers into ${provider}...`);
  const result = spawnSync(
    process.execPath,
    [process.argv[1]!, 'mcp', 'inject', '--provider', provider],
    { stdio: 'inherit', cwd },
  );
  if (result.status !== 0) {
    console.warn(
      '  WARN  MCP inject reported issues — continuing. Run `aiwg mcp list` to check registered servers.',
    );
    return false;
  }
  return true;
}

/**
 * Profile-aware inject (#891).
 * Default is ephemeral (no persistent config mutation).
 *
 * For Claude: returns the ephemeral config path (for claude --mcp-config).
 * For Codex: sets up the runtime home via the codex-runtime adapter (#892).
 * Returns null for persistent mode or on failure.
 */
function injectMcpProfile(
  provider: string,
  profileName: string,
  cwd: string,
  persist: boolean,
): string | null {
  console.log(`\n  Resolving profile "${profileName}" for ${provider}...`);

  if (persist) {
    // Persistent: write to provider's default config
    const result = spawnSync(
      process.execPath,
      [process.argv[1]!, 'mcp', 'inject', '--provider', provider, '--profile', profileName],
      { stdio: 'inherit', cwd },
    );
    if (result.status !== 0) {
      if (provider === 'codex' || provider === 'openai') {
        throw new Error('Codex profile injection failed; refusing to launch.');
      }
      console.warn('  WARN  Profile inject failed — continuing without profile.');
    }
    return null; // persistent mode, no ephemeral path
  }

  // Codex: runtime-home adapter handles ephemeral config (#892)
  // The codex launch is also handled specially in launchProvider.
  if (provider === 'codex' || provider === 'openai') {
    return null; // signal handled via runtime home (see launchProvider)
  }

  // Claude/others: generate a temp config file
  const tmpPath = `${process.env.TMPDIR ?? '/tmp'}/aiwg-mcp-${profileName}-${provider}-${Date.now()}.json`;

  const result = spawnSync(
    process.execPath,
    [
      process.argv[1]!, 'mcp', 'inject',
      '--provider', provider,
      '--profile', profileName,
      '--ephemeral',
      '--out', tmpPath,
    ],
    { stdio: 'inherit', cwd },
  );

  if (result.status !== 0) {
    console.warn('  WARN  Ephemeral profile inject failed — launching without profile MCP config.');
    return null;
  }

  return tmpPath;
}

// ── Launch ────────────────────────────────────────────────────────────────────

/**
 * Launch a spawnable provider binary, replacing the current process (exec-style).
 * For IDE-integrated providers, print guidance and exit.
 */
function launchProvider(
  provider: string,
  mcpInjected: boolean,
  mcpConfigPath?: string | null,
  profile?: string | null,
): HandlerResult {
  const cfg = getProviderConfig(provider);

  if (!isSpawnableProvider(provider)) {
    // Not spawnable — print context-aware guidance
    const mcpNote = mcpInjected
      ? '\n  MCP servers have been injected into your provider config.\n'
      : '';
    const ephemeralNote = mcpConfigPath
      ? `\n  MCP config (ephemeral): ${mcpConfigPath}\n`
      : '';

    console.log(`
── Ready to start ${cfg.name} ──
${mcpNote}${ephemeralNote}
${cfg.guidanceMessage ?? `Open ${cfg.name} in your project directory to begin.`}
`);
    return { exitCode: 0 };
  }

  // Spawnable — hand off the terminal
  console.log(`\n── Launching ${cfg.name} ──\n`);

  // Codex + profile: use runtime-home adapter (#892)
  if ((provider === 'codex' || provider === 'openai') && profile) {
    console.log(`  Using runtime home for profile "${profile}"`);
    const result = launchWithProfile(profile);
    return { exitCode: result.status ?? 0 };
  }

  // Claude: if we have an ephemeral MCP config, pass it via --mcp-config
  const binaryArgs: string[] = [];
  if (mcpConfigPath && (provider === 'claude' || provider === 'claude-code')) {
    binaryArgs.push('--mcp-config', mcpConfigPath);
    console.log(`  Using ephemeral MCP config: ${mcpConfigPath}`);
  }

  const result = spawnSync(cfg.binary!, binaryArgs, {
    stdio: 'inherit',
    env: process.env as Record<string, string>,
  });

  return { exitCode: result.status ?? 0 };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const sessionHandler: CommandHandler = {
  id: 'session',
  name: 'Session',
  description:
    'Start an agentic session — pre-flight check, auto-repair, optional MCP inject, then launch',
  category: 'project',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const { mcp, provider: explicitProvider, noRepair, profile, persist } = parseSessionArgs(ctx.args);
    const cwd = ctx.cwd || process.cwd();

    // ── Resolve provider ─────────────────────────────────────────
    const provider = await resolveProvider(explicitProvider, cwd);
    const providerCfg = PROVIDER_CONFIGS[provider];

    const profileSuffix = profile ? ` · profile: ${profile}` : '';
    console.log(`\n── aiwg session ── provider: ${providerCfg?.name ?? provider}${profileSuffix} ──\n`);

    const frameworkRoot = await getFrameworkRoot();

    // ── Step 1: Version check ─────────────────────────────────────
    if (!noRepair) {
      await checkAndUpdateVersion(noRepair);
    }

    // ── Step 2: Doctor ────────────────────────────────────────────
    console.log('\n  Running health checks...');
    const doctorOk = runDoctor(frameworkRoot, cwd);

    if (!doctorOk && !noRepair) {
      const repaired = repairInstallation(frameworkRoot, cwd, provider);
      if (!repaired) {
        // Repair failed — still continue (user was already informed)
      }
    } else if (!doctorOk && noRepair) {
      console.log(
        '\n  WARN  Health checks found issues. Run without --no-repair to auto-fix, or `aiwg feedback` to report.',
      );
    }

    // ── Step 3: Deployment check ──────────────────────────────────
    const undeployed = await checkDeployment(cwd, provider);
    if (undeployed.length > 0 && !noRepair) {
      console.log(
        `\n  Frameworks not deployed to ${provider}: ${undeployed.join(', ')}`,
      );
      await redeployFrameworks(ctx, undeployed, provider);
    }

    // ── Step 4: MCP inject ────────────────────────────────────────
    let mcpInjected = false;
    let mcpConfigPath: string | null = null;

    if (profile) {
      // Profile-aware injection (#891) — ephemeral by default

      // Codex profiles must pass policy and setup before any launch (#892)
      if (provider === 'codex' || provider === 'openai') {
        try {
          console.log(`\n  Setting up Codex ${persist ? 'persistent config' : 'runtime home'} for profile "${profile}"...`);
          // Import server list for this profile
          const { McpProfileRegistry } = await import('../../mcp/profiles.js');
          const { McpServerRegistry } = await import('../../mcp/registry.js');
          const profiles = new McpProfileRegistry();
          const registry = new McpServerRegistry();
          const resolvedServers = await profiles.resolveServers(profile, registry) as import('../../mcp/registry.js').McpServerDefinition[];
          const { assertCredentialPolicy, resolveCredentialPolicy } = await import('../../mcp/credentials.mjs');
          const registryPolicy = await registry.getCredentialPolicy();
          let credentialPolicy;
          try {
            credentialPolicy = resolveCredentialPolicy({ registryPolicy });
            assertCredentialPolicy(resolvedServers, credentialPolicy);
          } catch (err) {
            console.error(`  ${err instanceof Error ? err.message : String(err)}`);
            return { exitCode: 1 };
          }
          if (persist) {
            injectMcpProfile(provider, profile, cwd, true);
          } else {
            await ensureRuntimeHome(profile);
            await writeProfileConfig(profile, resolvedServers, { credentialPolicy });
            console.log(`  Runtime home ready. Profile servers: ${resolvedServers.map((s) => s.name).join(', ') || '(none)'}`);
          }
          mcpInjected = true;
        } catch (err) {
          console.warn(`  WARN  Codex runtime home setup failed: ${err instanceof Error ? err.message : String(err)}`);
          return { exitCode: 1 };
        }
      } else {
        mcpConfigPath = injectMcpProfile(provider, profile, cwd, persist);
        mcpInjected = mcpConfigPath !== null || persist;
      }
    } else if (mcp) {
      mcpInjected = injectMcp(provider, cwd);
    }

    // ── Step 5: Launch ────────────────────────────────────────────
    return launchProvider(provider, mcpInjected, mcpConfigPath,
      persist && (provider === 'codex' || provider === 'openai') ? null : profile);
  },
};
