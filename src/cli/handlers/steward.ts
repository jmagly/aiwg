/**
 * Steward Command Handler
 *
 * Provider capability awareness and command routing intelligence for the AIWG Steward.
 * Reads the canonical capability matrix and answers:
 *   - What does my current provider support natively?
 *   - What command should I use for feature X?
 *   - Which providers support feature Y?
 *
 * Subcommands:
 *   aiwg steward capabilities --provider <name>   Show capabilities for a provider
 *   aiwg steward capabilities --feature <name>    Show provider support for a feature
 *   aiwg steward capabilities --all               Full capability matrix
 *   aiwg steward find --capability <name>         Routing advice for current provider
 *
 * @source @src/cli/router.ts
 * @issue #599 #1261 #1262
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { AiwgError, EXIT_CODES, handlerResultFromError } from '../errors.js';
import {
  loadCapabilityMatrix,
  isExternalStrategy,
  type CapabilityMatrix,
  type ProviderCapabilities,
  type FeatureKey,
} from '../../providers/capability-matrix.js';
import { getProjectDir, readAiwgConfig, writeAiwgConfig } from '../../config/aiwg-config.js';
import {
  auditLegacyPermissions,
  archiveLegacyPermissionManifests,
  backupConfig,
  normalizeProjectPermissions,
} from '../../policy/authorization.js';
import { capabilityProviderId, normalizeProviderId, resolveActiveProvider } from '../provider-resolution.js';
import {
  discoverProjectLocalBundles,
  type ProjectLocalBundle,
} from '../../extensions/project-local-discovery.js';
import { printFullMatrix, permissionsUsage, formatProvider, emulationLabel } from './steward-format.js';
import { handleStewardModels } from './steward-models.js';

const BASELINE_PROVIDER = 'claude-code';

interface ResolvedStewardProvider {
  id: string;
  provider: ProviderCapabilities;
  projectLocal?: {
    id: string;
    baseAdapter: string;
  };
}

// ── Feature name normalization ────────────────────────────────────────────────

/**
 * Accept both hyphenated (agent-teams) and underscored (agent_teams) feature
 * names; the canonical YAML keys use underscores.
 */
function normalizeFeatureKey(input: string): string {
  return input.trim().toLowerCase().replace(/-/g, '_');
}

// ── Detect current provider ────────────────────────────────────────────────────

async function detectProvider(ctx?: HandlerContext): Promise<string | null> {
  const resolution = await resolveActiveProvider({
    cwd: ctx ? getProjectDir(ctx, ctx.args) : process.cwd(),
    detectProcess: true,
  });
  return capabilityProviderId(resolution.provider);
}

// ── Formatters ────────────────────────────────────────────────────────────────

async function findProjectLocalProvider(
  projectDir: string,
  requestedProvider: string,
): Promise<ProjectLocalBundle | undefined> {
  const discovery = await discoverProjectLocalBundles(projectDir);
  const requested = requestedProvider.trim().toLowerCase();
  return discovery.bundles.find((bundle) => {
    if (bundle.type !== 'provider') return false;
    const config = bundle.manifest.providerConfig;
    return bundle.id === requested || config?.aliases?.some((alias) => alias.toLowerCase() === requested);
  });
}

async function resolveStewardProvider(
  matrix: CapabilityMatrix,
  requestedProvider: string,
  ctx?: HandlerContext,
): Promise<ResolvedStewardProvider | null> {
  const normalizedProvider = normalizeProviderId(requestedProvider);
  const builtInCapabilityId = capabilityProviderId(normalizedProvider);
  if (builtInCapabilityId && matrix.providers[builtInCapabilityId]) {
    return {
      id: builtInCapabilityId,
      provider: matrix.providers[builtInCapabilityId],
    };
  }

  const projectDir = ctx ? getProjectDir(ctx, ctx.args) : process.cwd();
  const bundle = await findProjectLocalProvider(projectDir, requestedProvider);
  const providerConfig = bundle?.manifest.providerConfig;
  if (!bundle || !providerConfig) return null;

  const baseCapabilityId = capabilityProviderId(normalizeProviderId(providerConfig.extends)) ?? providerConfig.extends;
  const baseProvider = matrix.providers[baseCapabilityId];
  if (!baseProvider) return null;

  const overrides = providerConfig.capabilities;
  const provider: ProviderCapabilities = {
    ...baseProvider,
    display_name: providerConfig.displayName ?? bundle.manifest.name ?? bundle.id,
    aliases: providerConfig.aliases,
    native_features: {
      ...baseProvider.native_features,
      ...(overrides?.nativeFeatures ?? {}),
    },
    emulation: {
      ...baseProvider.emulation,
      ...(overrides?.emulation ?? {}),
    },
  };

  return {
    id: bundle.id,
    provider,
    projectLocal: {
      id: bundle.id,
      baseAdapter: providerConfig.extends,
    },
  };
}

async function handleSteward(args: string[], ctx?: HandlerContext): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === 'help') {
    console.log(`
  aiwg steward — Provider capability awareness and command routing

  Usage:
    aiwg steward signed-merges [--apply|--skip]   Optional signed local merge setup
    aiwg steward decision-offload [--json]         Offline advisory readiness and adoption report
    aiwg steward capabilities --provider <name>   Capabilities for a specific provider
    aiwg steward capabilities --feature <name>    Provider support matrix for a feature
    aiwg steward capabilities --all               Full matrix (all providers x features)
    aiwg steward find --capability <name>         Routing advice for your current provider
    aiwg steward transports                       Report transport capabilities separately from providers
    aiwg steward models [--complex|--high-impact] Model policy/discovery routing advice
    aiwg steward models --route --capability-type <agent|skill|rule|workflow>
      --capability <id> --assignment <text> [--provider <name>] [--json]
                                                  Emit a capability-bound wrapper launch envelope
    aiwg steward authorization                    HITL policy and grants: inspect/validate/preview/enable/revoke/list/show/search/explain/verify
    aiwg steward permissions audit                Find normalized-model errors and legacy grants
    aiwg steward permissions migrate --dry-run    Preview legacy permission normalization
    aiwg steward permissions migrate --apply      Back up and atomically normalize config

  Providers:
    antigravity (agy), claude-code, codex, copilot, cursor, deepseek-harness (dsh), factory, opencode, pi, omp, warp, windsurf, hermes, openclaw

  Features:
    cron, agent_teams, tasks, mcp, behaviors, mission_control, daemon
    (hyphens accepted: agent-teams → agent_teams)

  Models:
    Use aiwg models sources|refresh for effective catalogs, audit|resolve for
    provider-compiled role/tier policy, and cheap-first defaults unless policy
    or human rationale escalates.
`);
    return;
  }

  if (subcommand === 'signed-merges') {
    const { stewardSignedMerges } = await import('./steward-signing.js');
    return stewardSignedMerges(args.slice(1), ctx ? getProjectDir(ctx, args) : process.cwd());
  }

  if (subcommand === 'decision-offload') {
    const unknown = args.slice(1).filter(arg => arg !== '--json');
    if (unknown.length) throw new AiwgError({ code: 'ERR_USAGE_UNKNOWN_ARGUMENT',
      message: `Unknown decision-offload argument: ${unknown[0]}`, exitCode: EXIT_CODES.USAGE });
    const { buildDecisionOffloadSnapshot } = await import('../../decision/offload.js');
    const decisionOffload = await buildDecisionOffloadSnapshot({ projectRoot: ctx?.cwd ?? process.cwd(), frameworkRoot: ctx?.frameworkRoot });
    console.log(JSON.stringify(args.includes('--json') ? { decisionOffload } : decisionOffload, null, 2));
    return;
  }

  if (subcommand === 'authorization') {
    const { authorizationCli } = await import('../../config/authorization-cli.js');
    await authorizationCli(args.slice(1), ctx?.cwd);
    return;
  }

  if (subcommand === 'permissions') {
    const operation = args[1];
    // `<namespace> --help` must reach the same usage block bare invocation prints (#2533).
    if (!operation || operation === 'help' || operation === '--help' || operation === '-h') {
      console.log(permissionsUsage());
      return;
    }
    const projectDir = ctx ? getProjectDir(ctx, args) : process.cwd();
    const config = await readAiwgConfig(projectDir);
    if (!config) throw new AiwgError({
      code: 'ERR_CONFIG_NOT_FOUND',
      message: `No .aiwg/aiwg.config found in ${projectDir}`,
      exitCode: EXIT_CODES.CONFIG,
    });
    if (operation === 'audit') {
      const diagnostics = await auditLegacyPermissions(projectDir, config);
      if (!diagnostics.length) console.log('  ✓ Permission model is normalized and valid.');
      for (const item of diagnostics) console.log(`  ${item.severity === 'error' ? '✗' : item.severity === 'warning' ? '⚠' : '·'} [${item.code}] ${item.message}${item.source ? ` (${item.source})` : ''}`);
      if (diagnostics.some(item => item.severity === 'error')) throw new AiwgError({
        code: 'ERR_AUTHORIZATION_INVALID',
        message: 'Normalized permission model has errors.',
        hint: 'Correct the reported references; authorization remains fail-closed.',
        exitCode: EXIT_CODES.CONFIG,
      });
      return;
    }
    if (operation === 'migrate') {
      const apply = args.includes('--apply');
      const dryRun = args.includes('--dry-run');
      if (apply === dryRun) throw new AiwgError({
        code: 'ERR_USAGE_PERMISSION_MIGRATION_MODE',
        message: 'Choose exactly one of --dry-run or --apply.',
        exitCode: EXIT_CODES.USAGE,
      });
      const normalized = await normalizeProjectPermissions(projectDir, config);
      if (normalized === config) {
        console.log('  ✓ Permission model is already normalized; no changes needed.');
        return;
      }
      const diagnostics = await auditLegacyPermissions(projectDir, config);
      const legacyCount = diagnostics.filter(d => d.code.startsWith('legacy-')).length;
      if (legacyCount === 0 && !config.authorization) {
        // Nothing legacy to convert: the only work is writing the initial
        // default-deny block, which is what clears doctor's warning (#2563).
        console.log(`  ${dryRun ? 'Would write' : 'Writing'} an initial default-deny authorization block (no legacy permission sources found).`);
      } else {
        console.log(`  ${dryRun ? 'Would normalize' : 'Normalizing'} ${legacyCount} legacy permission source(s).`);
      }
      console.log(`  Result: ${Object.keys(normalized.authorization?.permissions ?? {}).length} permissions, ${Object.keys(normalized.authorization?.roles ?? {}).length} roles, ${normalized.authorization?.assignments.length ?? 0} assignments; default deny.`);
      if (apply) {
        const backup = await backupConfig(projectDir);
        await writeAiwgConfig(projectDir, normalized);
        const archived = await archiveLegacyPermissionManifests(projectDir);
        console.log(`  ✓ Migration applied atomically. Backup: ${backup}`);
        if (archived.length) console.log(`  ✓ Archived legacy manifests: ${archived.join(', ')}`);
      }
      return;
    }
    throw new AiwgError({
      code: 'ERR_USAGE_UNKNOWN_PERMISSION_OPERATION',
      message: `Unknown permissions operation: ${operation}`,
      hint: 'Use audit or migrate --dry-run|--apply.',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (subcommand === 'transports') {
    const projectDir = ctx ? getProjectDir(ctx, args) : process.cwd();
    const config = await readAiwgConfig(projectDir);
    const profiles = Object.keys(config?.uhp?.profiles ?? {});
    console.log('\n  Remote execution transports');
    console.log('  ───────────────────────────');
    console.log(`  UHP ${config?.uhp?.enabled ? 'enabled' : 'disabled'} (experimental client transport; not a provider capability)`);
    console.log(`  Profiles: ${profiles.length ? profiles.join(', ') : 'none'}`);
    console.log('  Routing: explicit `aiwg uhp <operation> --profile <name>`; no UHP↔A2A fallback.');
    return;
  }

  const matrix = loadCapabilityMatrix();

  if (subcommand === 'capabilities') {
    const providerFlag = args.indexOf('--provider');
    const featureFlag = args.indexOf('--feature');
    const allFlag = args.includes('--all');

    if (allFlag) {
      printFullMatrix(matrix);
      return;
    }

    if (providerFlag >= 0) {
      const requestedProvider = args[providerFlag + 1];
      if (!requestedProvider) throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: '--provider requires a provider name',
        hint: 'Example: aiwg steward capabilities --provider claude-code',
        exitCode: EXIT_CODES.USAGE,
      });
      const resolved = await resolveStewardProvider(matrix, requestedProvider, ctx);
      if (!resolved) {
        const known = Object.keys(matrix.providers).join(', ');
        throw new AiwgError({
          code: 'ERR_USAGE_UNKNOWN_PROVIDER',
          message: `Unknown provider: ${requestedProvider}`,
          hint: `Known providers: ${known}. Project-local providers must live under .aiwg/providers/<id>/manifest.json.`,
          exitCode: EXIT_CODES.USAGE,
        });
      }
      console.log(formatProvider(resolved.id, resolved.provider, matrix, resolved.projectLocal));
      return;
    }

    if (featureFlag >= 0) {
      const rawFeatureId = args[featureFlag + 1];
      if (!rawFeatureId) throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: '--feature requires a feature name',
        hint: "Example: aiwg steward capabilities --feature cron",
        exitCode: EXIT_CODES.USAGE,
      });
      const featureId = normalizeFeatureKey(rawFeatureId);
      const feat = matrix.features[featureId as FeatureKey];
      if (!feat) {
        const known = Object.keys(matrix.features).join(', ');
        throw new AiwgError({
          code: 'ERR_USAGE_UNKNOWN_FEATURE',
          message: `Unknown feature: ${rawFeatureId}`,
          hint: `Known features: ${known}`,
          exitCode: EXIT_CODES.USAGE,
        });
      }

      console.log(`\n  Feature: ${featureId}`);
      if (feat.description) console.log(`  ${feat.description}`);
      if (feat.native_example) console.log(`  Native example: ${feat.native_example}`);
      console.log(`\n  Provider support:\n`);

      for (const [providerId, provider] of Object.entries(matrix.providers)) {
        const isNative = provider.native_features?.[featureId as FeatureKey] === true;
        const emulation = provider.emulation?.[featureId as FeatureKey] ?? null;
        const status = isNative
          ? `✓ native`
          : isExternalStrategy(emulation)
            ? `↗ external trigger (system cron/systemd/CI)`
            : (emulation ? `~ emulated (${emulationLabel(emulation)})` : `- not supported`);
        console.log(`    ${provider.display_name.padEnd(20)} (${providerId.padEnd(12)}) ${status}`);
      }
      console.log('');
      return;
    }

    // No flag — show current provider
    const detected = await detectProvider(ctx);
    if (!detected) {
      console.log(`  Could not detect active provider. Specify with --provider <name>.`);
      console.log(`  Detection checks explicit env, runtime markers, process ancestry, and unambiguous project config.`);
      console.log(`  Run 'aiwg runtime-info' to verify provider detection.`);
      return;
    }
    const provider = matrix.providers[detected];
    if (!provider) {
      console.log(`  Detected provider ${detected} not found in capability matrix.`);
      return;
    }
    console.log(`  (Detected provider: ${detected})`);
    console.log(formatProvider(detected, provider, matrix));
    return;
  }

  if (subcommand === 'find') {
    const capFlag = args.indexOf('--capability');
    if (capFlag < 0) throw new AiwgError({
      code: 'ERR_USAGE_MISSING_FLAG',
      message: "'aiwg steward find' requires --capability <name>",
      hint: 'Example: aiwg steward find --capability cron',
      exitCode: EXIT_CODES.USAGE,
    });

    const rawCapId = args[capFlag + 1];
    if (!rawCapId) throw new AiwgError({
      code: 'ERR_USAGE_MISSING_VALUE',
      message: '--capability requires a feature name',
      hint: 'Example: aiwg steward find --capability cron',
      exitCode: EXIT_CODES.USAGE,
    });

    const capabilityId = normalizeFeatureKey(rawCapId);
    const feat = matrix.features[capabilityId as FeatureKey];
    if (!feat) {
      const known = Object.keys(matrix.features).join(', ');
      throw new AiwgError({
        code: 'ERR_USAGE_UNKNOWN_CAPABILITY',
        message: `Unknown capability: ${rawCapId}`,
        hint: `Known capabilities: ${known}`,
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const detected = await detectProvider(ctx) ?? BASELINE_PROVIDER;
    const provider = matrix.providers[detected];

    console.log(`\n  Routing advice for: ${capabilityId}`);
    console.log(`  Provider: ${provider?.display_name ?? detected}`);
    console.log('');

    if (!provider) {
      console.log(`  No capability data for provider ${detected}.`);
      return;
    }

    const isNative = provider.native_features?.[capabilityId as FeatureKey] === true;
    const emulation = provider.emulation?.[capabilityId as FeatureKey] ?? null;

    if (isNative) {
      console.log(`  ✓ Native support available`);
      if (feat.native_example) console.log(`  Example: ${feat.native_example}`);
    } else if (isExternalStrategy(emulation)) {
      console.log(`  ↗ Use an external trigger`);
      console.log(`  Strategy: system cron, systemd timer, or CI launches a reviewed provider command`);
      console.log(`  Boundary: AIWG does not provide or own the clock/scheduler`);
    } else if (emulation) {
      console.log(`  ~ Use AIWG emulation`);
      console.log(`  Strategy: ${emulationLabel(emulation)}`);
      const strategyDetail = feat.emulation_strategies?.[emulation];
      if (strategyDetail) console.log(`  Detail:   ${strategyDetail}`);
    } else {
      console.log(`  - Not supported on this provider`);
      const strategies = feat.emulation_strategies ?? {};
      const available = Object.keys(strategies);
      if (available.length) {
        console.log(`  Available strategies in matrix: ${available.join(', ')}`);
      }
    }
    return;
  }

  if (subcommand === 'models' || subcommand === 'model-routing') return handleStewardModels(args, matrix, ctx);

  throw new AiwgError({
    code: 'ERR_USAGE_UNKNOWN_SUBCOMMAND',
    message: `Unknown steward subcommand: ${subcommand}`,
    hint: "Run 'aiwg steward --help' for usage",
    exitCode: EXIT_CODES.USAGE,
  });
}

// ── Handler export ────────────────────────────────────────────────────────────

export const stewardHandler: CommandHandler = {
  id: 'steward',
  name: 'Steward',
  description: 'Provider capability routing and permission normalization',
  category: 'maintenance',
  aliases: [],

  // The router intercepts --help before execute(), so a handler without this
  // property gets the generic "no detailed help" stub even when its own usage
  // text exists. Route to the same block bare invocation prints, and keep
  // sub-namespace help reachable, without executing anything (#2533).
  async help(ctx: HandlerContext): Promise<HandlerResult> {
    const positional = ctx.args.filter((arg) => !arg.startsWith('-'));
    if (positional[0] === 'authorization') {
      const { authorizationUsage } = await import('../../config/authorization-cli.js');
      return { exitCode: 0, message: authorizationUsage, rawOutput: true };
    }
    if (positional[0] === 'permissions') {
      return { exitCode: 0, message: permissionsUsage(), rawOutput: true };
    }
    await handleSteward([], ctx);
    return { exitCode: 0 };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      await handleSteward(ctx.args, ctx);
      return { exitCode: 0 };
    } catch (error) {
      // Preserve AiwgError.exitCode (USAGE=2, etc.) through the catch.
      return handlerResultFromError(error);
    }
  },
};

export const stewardHandlers: CommandHandler[] = [stewardHandler];
