/**
 * Runtime Info Command Handler
 *
 * Runtime environment discovery and tool catalog management.
 * Provides information about available tools, system resources, and runtime environment.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @source @src/cli/router.ts
 * @issue #33
 */

import path from 'path';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { AiwgError, EXIT_CODES, handlerResultFromError } from '../errors.js';
import { getPackageRoot } from '../../channel/manager.mjs';
import { inspectInstallation } from '../../installation/manager.mjs';

function isMissingRuntimeCatalogError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No catalog found');
}

/**
 * Runtime info command handler
 */
export const runtimeInfoHandler: CommandHandler = {
  id: 'runtime-info',
  name: 'Runtime Info',
  description: 'Runtime environment discovery and tool catalog',
  category: 'toolsmith',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      await handleRuntimeInfo(ctx.args, ctx.cwd);
      return { exitCode: 0 };
    } catch (error) {
      const err = error as Error;

      if (isMissingRuntimeCatalogError(err)) {
        console.log(`\nNo runtime catalog found.`);
        console.log(`Run 'aiwg runtime-info --discover' to create one.`);
        return { exitCode: 0 };
      }

      // AiwgError exitCode (USAGE=2, CONFIG=78, etc.) now propagates instead
      // of being flattened to 1. Non-AiwgError throws still map to GENERAL=1.
      return handlerResultFromError(err);
    }
  },
};

/**
 * Handle runtime info command logic
 */
async function handleRuntimeInfo(args: string[], cwd = process.cwd()): Promise<void> {
  const hasDiscover = args.includes('--discover');
  const hasVerify = args.includes('--verify');
  const hasJson = args.includes('--json');
  const checkIndex = args.indexOf('--check');
  const hasCheck = checkIndex >= 0;
  const hasCapabilities = args.includes('--capabilities');
  const hasProviders = args.includes('--providers');
  const hasTransports = args.includes('--transports');
  const featureIndex = args.indexOf('--feature');
  const hasFeature = featureIndex >= 0;

  if (hasTransports) {
    const { readAiwgConfig } = await import('../../config/aiwg-config.js');
    const config = await readAiwgConfig(cwd);
    const profiles = Object.entries(config?.uhp?.profiles ?? {}).map(([name, profile]) => ({
      name,
      transport: 'uhp' as const,
      protocolVersion: profile.version,
      experimental: true,
      configured: true,
      enabled: config?.uhp?.enabled === true,
      endpointOrigin: new URL(profile.endpoint).origin,
      credentialSource: profile.credential.source,
      credentialReference: profile.credential.name,
    }));
    const output = { providersAreTransports: false, transports: { uhp: { experimental: true, enabled: config?.uhp?.enabled === true, profiles } } };
    if (hasJson) console.log(JSON.stringify(output, null, 2));
    else {
      console.log('\nTransport Inventory');
      console.log('===================');
      console.log('UHP is a remote execution transport, not an AIWG provider.');
      if (!profiles.length) console.log('  UHP: not configured (experimental)');
      for (const profile of profiles) console.log(`  UHP/${profile.name}: ${profile.enabled ? 'enabled' : 'disabled'}, ${profile.protocolVersion}, ${profile.endpointOrigin}`);
    }
    return;
  }

  // --- Capability matrix queries (no RuntimeDiscovery needed) ---
  if (hasProviders) {
    const { collectProviderInventory } = await import('../../providers/provider-inventory.js');
    const inventory = await collectProviderInventory(cwd);
    const selected = args[args.indexOf('--provider') + 1];
    const ompSelected = args.includes('--provider') && ['omp', 'oh-my-pi'].includes(selected);
    const ompRuntime = ompSelected
      ? await (await import('../../providers/omp-diagnostics.mjs')).diagnoseOmpRuntime({ cwd })
      : undefined;
    if (hasJson) {
      console.log(JSON.stringify({ ...inventory, ...(ompRuntime ? { ompRuntime } : {}) }, null, 2));
    } else {
      console.log('\nProvider Inventory');
      console.log('==================');
      for (const provider of inventory.providers) {
        const states = [
          provider.configured ? 'configured' : null,
          provider.deployed ? 'deployed' : null,
          provider.detected ? 'detected' : null,
          provider.available ? 'available' : 'unavailable',
          provider.active ? 'active' : null,
        ].filter(Boolean).join(', ');
        console.log(`\n${provider.displayName} (${provider.id}): ${states}`);
        for (const evidence of provider.evidence) {
          console.log(`  evidence: ${evidence.kind}/${evidence.scope} — ${evidence.value}`);
        }
        for (const reason of provider.reasons) console.log(`  note: ${reason}`);
      }
      if (ompRuntime) console.log(`\nOMP runtime: ${JSON.stringify(ompRuntime, null, 2)}`);
    }
    return;
  }

  if (hasCapabilities || hasFeature) {
    const {
      loadCapabilityMatrix,
      formatCapabilityTable,
      formatFeatureSupport,
      getProviderCapabilities,
    } = await import('../../providers/capability-matrix.js');

    if (hasFeature) {
      const featureName = args[featureIndex + 1];
      if (!featureName) {
        throw new AiwgError({
          code: 'ERR_USAGE_MISSING_VALUE',
          message: '--feature requires a feature name',
          hint: 'Known: cron, agent_teams, tasks, mcp, behaviors, mission_control',
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (hasJson) {
        const matrix = loadCapabilityMatrix();
        const featureDef = matrix.features[featureName as keyof typeof matrix.features];
        const support: Record<string, { native: boolean; emulation: string | null }> = {};
        for (const [key, caps] of Object.entries(matrix.providers)) {
          support[key] = {
            native: caps.native_features[featureName as keyof typeof caps.native_features] ?? false,
            emulation: caps.emulation[featureName as keyof typeof caps.emulation] ?? null,
          };
        }
        console.log(JSON.stringify({ feature: featureName, definition: featureDef, providers: support }, null, 2));
      } else {
        console.log('\n' + formatFeatureSupport(featureName as any));
      }
      return;
    }

    // --capabilities: show full matrix or provider-specific
    const providerIndex = args.indexOf('--provider');
    if (providerIndex >= 0) {
      const providerName = args[providerIndex + 1];
      if (!providerName) {
        throw new AiwgError({
          code: 'ERR_USAGE_MISSING_VALUE',
          message: '--provider requires a provider name',
          hint: 'Example: aiwg runtime-info --capabilities --provider claude',
          exitCode: EXIT_CODES.USAGE,
        });
      }
      const caps = getProviderCapabilities(providerName);
      if (!caps) {
        throw new AiwgError({
          code: 'ERR_USAGE_UNKNOWN_PROVIDER',
          message: `Unknown provider: ${providerName}`,
          hint: `Known: ${Object.keys(loadCapabilityMatrix().providers).join(', ')}`,
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (hasJson) {
        console.log(JSON.stringify({ provider: providerName, ...caps }, null, 2));
      } else {
        console.log(`\nProvider: ${caps.display_name} (${caps.status})`);
        console.log(`Deploy target: ${caps.deploy_target}`);
        console.log(`Aggregated output: ${caps.aggregated_output}`);
        console.log(`\nArtifact paths:`);
        for (const [type, path] of Object.entries(caps.artifact_paths)) {
          console.log(`  ${type}: ${path || 'Indexed (aiwg discover / aiwg show)'}`);
        }
        console.log(`\nFeatures:`);
        for (const [feat, native] of Object.entries(caps.native_features)) {
          const emu = caps.emulation[feat as keyof typeof caps.emulation];
          console.log(`  ${feat}: ${native ? 'NATIVE' : emu ? `emulated (${emu})` : '--'}`);
        }
      }
      return;
    }

    // Full matrix
    if (hasJson) {
      console.log(JSON.stringify(loadCapabilityMatrix(), null, 2));
    } else {
      console.log('\n' + formatCapabilityTable());
    }
    return;
  }

  // --- Original RuntimeDiscovery logic ---
  const { RuntimeDiscovery } = await import('../../smiths/toolsmith/runtime-discovery.mjs');
  const discovery = new RuntimeDiscovery();

  if (hasDiscover) {
    // Full discovery
    const catalog = await discovery.discover();

    if (hasJson) {
      console.log(JSON.stringify(catalog, null, 2));
    } else {
      console.log(`\nDiscovery complete!`);
      console.log(`Discovered ${catalog.tools.length} tools`);
      console.log(`Unavailable: ${catalog.unavailable.length}`);
      console.log(`\nCatalog saved to: ${path.join(discovery.basePath, 'runtime.json')}`);
      console.log(`Human-readable: ${path.join(discovery.basePath, 'runtime-info.md')}`);
    }
  } else if (hasVerify) {
    // Verify existing catalog
    const result = await discovery.verify();

    if (hasJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nVerification complete!`);
      console.log(`Valid: ${result.valid}/${result.total}`);

      if (result.failed.length > 0) {
        console.log(`\nFailed tools:`);
        result.failed.forEach((tool: { name: string; id: string }) => {
          console.log(`  - ${tool.name} (${tool.id})`);
        });
      }
    }
  } else if (hasCheck) {
    // Check specific tool
    const toolName = args[checkIndex + 1];

    if (!toolName) {
      throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: '--check requires a tool name',
        hint: 'Example: aiwg runtime-info --check git',
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const check = await discovery.checkTool(toolName);

    if (hasJson) {
      console.log(JSON.stringify(check, null, 2));
    } else {
      console.log(`\nTool: ${toolName}`);

      if (check.available) {
        console.log(`Status: Available`);
        console.log(`Version: ${check.version}`);
        console.log(`Path: ${check.path}`);
        console.log(`Verified: ${check.lastVerified}`);
      } else {
        console.log(`Status: Not Available`);
        console.log(`Install: ${check.installHint}`);
      }
    }
  } else {
    // Show summary (default)
    let summary;
    try {
      summary = await discovery.getSummary();
    } catch (error) {
      if (!isMissingRuntimeCatalogError(error)) throw error;
      if (!hasJson) {
        console.log(`\nNo runtime catalog found; bootstrapping catalog...`);
      }
      await discovery.discover();
      summary = await discovery.getSummary();
    }

    const installation = inspectInstallation({ actualRoot: getPackageRoot() });
    if (hasJson) {
      console.log(JSON.stringify({ ...summary, installation }, null, 2));
    } else {
      console.log(`\nRuntime Environment Summary`);
      console.log(`===========================`);
      console.log(`\nOS: ${summary.environment.os} (${summary.environment.osVersion}) ${summary.environment.arch}`);
      console.log(`Shell: ${summary.environment.shell}`);
      console.log(`Memory: ${summary.resources.memoryAvailableGb} GB available / ${summary.resources.memoryTotalGb} GB total`);
      console.log(`Disk: ${summary.resources.diskFreeGb} GB free`);
      console.log(`CPU Cores: ${summary.resources.cpuCores}`);

      console.log(`\nTool Categories:`);
      console.log(`  Core:       ${summary.toolCounts.core} tools`);
      console.log(`  Languages:  ${summary.toolCounts.languages} tools`);
      console.log(`  Utilities:  ${summary.toolCounts.utilities} tools`);
      console.log(`  Custom:     ${summary.toolCounts.custom} tools`);

      console.log(`\nTotal: ${summary.totalTools} verified tools`);
      console.log(`\nLast Discovery: ${summary.lastDiscovery}`);
      console.log(`Catalog: ${summary.catalogPath}`);
      console.log(`\nAIWG Installation:`);
      console.log(`  Canonical: ${installation.identity?.method ?? 'unrecorded'} at ${installation.identity?.root ?? '(unrecorded)'}`);
      console.log(`  Actual:    ${installation.actualMethod} at ${installation.actualRoot}`);
      if (installation.launcher) {
        console.log(`  Launcher:  ${installation.launcher.method} at ${installation.launcher.root} (edge redirect)`);
      }
      console.log(`  Run mode:  ${installation.identity?.runMode ?? '(unrecorded)'}`);
      console.log(`  State:     ${installation.state}`);

      // Scheduler backend detection
      const { execSync } = await import('child_process');
      let schedulerBackend = 'external trigger required (system cron/systemd/CI)';
      let chronyInstalled = false;

      try {
        execSync('which chronyc 2>/dev/null || which chronyd 2>/dev/null', { stdio: 'pipe' });
        chronyInstalled = true;
      } catch {
        // chrony not found
      }

      // Native CronCreate is only available when running inside a Claude Code agent context.
      // The CLI itself cannot call agent tools, so we report based on platform heuristics.
      // When invoked from within an agent, the schedule skill performs live detection.
      const isClaudeCodeContext =
        process.env.CLAUDE_CODE_VERSION !== undefined ||
        process.env.ANTHROPIC_API_KEY !== undefined;

      if (isClaudeCodeContext) {
        schedulerBackend = 'native-cron (CronCreate); external trigger outside agent sessions';
      }

      console.log(`\nScheduler:`);
      console.log(`  Backend:  ${schedulerBackend}`);
      console.log(`  Chrony:   ${chronyInstalled ? '✓ installed (precise NTP)' : '✗ not installed (install for precise timing)'}`);

      if (!chronyInstalled) {
        console.log(`\n  To install chrony for more precise cron scheduling:`);
        console.log(`    Ubuntu/Debian: sudo apt install chrony`);
        console.log(`    RHEL/Fedora:   sudo dnf install chrony`);
        console.log(`    macOS:         brew install chrony`);
      }

      // Team backend detection
      const teamBackend = isClaudeCodeContext
        ? 'native (Claude Code agent teams)'
        : 'aiwg mc emulation';

      console.log(`\nAgent Teams:`);
      console.log(`  Backend:  ${teamBackend}`);

      if (!isClaudeCodeContext) {
        console.log(`  Note:     Run 'aiwg team run <name>' to dispatch via Mission Control`);
      }

      console.log(`\nRun 'aiwg runtime-info --discover' to refresh catalog`);
      console.log(`\nRun 'aiwg runtime-info --check <tool>' to check a specific tool`);
    }
  }
}
