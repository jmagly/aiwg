// Displays tier election policy and compiles steward wrapper routing advice.
import type { HandlerContext } from './types.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AiwgError, EXIT_CODES } from '../errors.js';
import { getProjectDir } from '../../config/aiwg-config.js';
import { capabilityProviderId, normalizeProviderId, resolveActiveProvider } from '../provider-resolution.js';
import type { CapabilityMatrix } from '../../providers/capability-matrix.js';
import { resolveModelTier } from '../../models/router.js';
import { ConfigLoader } from '../../models/config-loader.js';
import { buildWrapperRouteEnvelope, type RoutedCapabilityType } from '../../models/wrapper-route.js';
import { loadProviderModelCatalog, type ModelPolicyProvider, type ProviderModelCatalog } from '../../models/provider-policy.js';
import { CapabilityResolutionError, resolveRoutableCapability } from '../../artifacts/capability-resolver.js';
function isModelPolicyProvider(provider: string): provider is ModelPolicyProvider {
  return Object.hasOwn(loadProviderModelCatalog().providers, provider);
}

export async function handleStewardModels(args: string[], matrix: CapabilityMatrix, ctx?: HandlerContext): Promise<void> {
    const flagValue = (name: string): string | undefined => {
      const index = args.indexOf(name);
      if (index < 0) return undefined;
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: `${name} requires a value.`,
        exitCode: EXIT_CODES.USAGE,
      });
      return value;
    };
    if (args.includes('--route')) {
      const rawProvider = flagValue('--provider') ?? await resolveActiveProvider({
        cwd: ctx ? getProjectDir(ctx, ctx.args) : process.cwd(),
        detectProcess: true,
      }).then(result => result.provider ?? undefined);
      const provider = normalizeProviderId(rawProvider);
      if (!provider || provider === 'generic') throw new AiwgError({
        code: 'ERR_USAGE_UNKNOWN_PROVIDER',
        message: `Cannot compile a wrapper route for provider: ${rawProvider ?? '(undetected)'}`,
        hint: 'Pass --provider with a supported provider id.',
        exitCode: EXIT_CODES.USAGE,
      });
      if (!isModelPolicyProvider(provider)) throw new AiwgError({
        code: 'ERR_USAGE_UNSUPPORTED_PROVIDER',
        message: `Model wrapper routing is not implemented for provider: ${provider}`,
        hint: 'Use `aiwg steward capabilities --provider pi` for current Pi capability routing; model routing is tracked separately.',
        exitCode: EXIT_CODES.USAGE,
      });
      const capabilityType = flagValue('--capability-type') as RoutedCapabilityType | undefined;
      const capability = flagValue('--capability');
      const assignment = flagValue('--assignment');
      if (!capabilityType || !['agent', 'skill', 'rule', 'workflow'].includes(capabilityType)) throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: '--capability-type requires agent, skill, rule, or workflow.',
        exitCode: EXIT_CODES.USAGE,
      });
      if (!capability || !assignment) throw new AiwgError({
        code: 'ERR_USAGE_MISSING_VALUE',
        message: '--route requires both --capability <id> and --assignment <bounded text>.',
        exitCode: EXIT_CODES.USAGE,
      });
      const capabilityProvider = capabilityProviderId(provider);
      const providerCapabilities = capabilityProvider ? matrix.providers[capabilityProvider] : undefined;
      const launchMechanism = providerCapabilities?.native_features.tasks
        ? 'native-subagent'
        : providerCapabilities?.emulation.tasks === 'aiwg-mc' ? 'aiwg-mc' : 'manual';
      const premiumAuthorized = args.includes('--allow-premium');
      const { collectProviderInventory } = await import('../../providers/provider-inventory.js');
      const { resolveDynamicModelCatalog } = await import('../../models/model-discovery.js');
      const projectDir = ctx ? getProjectDir(ctx, ctx.args) : process.cwd();
      const requestedAiwgRoot = ctx?.frameworkRoot ?? process.cwd();
      const aiwgRoot = await access(join(
        requestedAiwgRoot,
        'agentic/code/providers/model-catalog.v1.json',
      )).then(() => requestedAiwgRoot).catch(() => process.cwd());
      const resolvedCapability = await resolveRoutableCapability(
        aiwgRoot,
        capabilityType,
        capability,
      ).catch(error => {
        if (!(error instanceof CapabilityResolutionError)) throw error;
        throw new AiwgError({
          code: error.kind === 'ambiguous'
            ? 'ERR_USAGE_AMBIGUOUS_CAPABILITY'
            : 'ERR_USAGE_UNKNOWN_CAPABILITY',
          message: error.message,
          hint: 'Run aiwg discover "<capability>" --json and pass an exact name or stable id.',
          exitCode: EXIT_CODES.USAGE,
        });
      });
      const catalog = await resolveDynamicModelCatalog({
        aiwgRoot,
        inventory: await collectProviderInventory(projectDir),
        allowNetwork: false,
      });
      const baselineCatalog = loadProviderModelCatalog();
      const effectiveCatalog = {
        ...baselineCatalog,
        ...catalog,
        refreshedAt: catalog.refreshedAt ?? baselineCatalog.refreshedAt,
        staleAfterDays: baselineCatalog.staleAfterDays,
        providers: { ...baselineCatalog.providers, ...catalog.providers },
      } as ProviderModelCatalog;
      const envelope = buildWrapperRouteEnvelope({
        provider,
        capability: resolvedCapability,
        assignment,
        launchMechanism,
        deterministic: args.includes('--deterministic'),
        routine: args.includes('--routine'),
        complex: args.includes('--complex'),
        highImpact: args.includes('--high-impact'),
        requestedPremium: args.includes('--premium'),
        unattended: args.includes('--unattended'),
        premiumAuthorized,
        maxAutoTier: premiumAuthorized ? 3 : undefined,
        catalog: effectiveCatalog,
      }, await new ConfigLoader(projectDir).load());
      if (args.includes('--json')) console.log(JSON.stringify(envelope, null, 2));
      else {
        console.log('\n  Model wrapper route');
        console.log(`  Provider:   ${envelope.provider}`);
        console.log(`  Capability: ${envelope.capability.type} ${envelope.capability.name} (${envelope.capability.id})`);
        console.log(`  Tier/role:  ${envelope.tier ?? 'deterministic'}/${envelope.role ?? 'none'}`);
        console.log(`  Wrapper:    ${envelope.wrapper ?? 'none'}`);
        console.log(`  Model:      ${envelope.model?.effectiveModel ?? 'inherited or no model call'} (${envelope.model?.outcome ?? 'deterministic'})`);
        console.log(`  Launch:     ${envelope.launch.mechanism}`);
        console.log(`  Confirmation: ${envelope.decision.requiresConfirmation ? 'required' : 'not required'}`);
        console.log('\n  Wrapper prompt:\n');
        console.log(envelope.launch.prompt);
      }
      return;
    }
    const tiers = Object.fromEntries(Object.entries(loadProviderModelCatalog().providers)
      .filter(([, entry]) => entry.tiers)
      .map(([provider, entry]) => [provider, Object.fromEntries(Object.entries(entry.tiers!)
        .map(([tier, model]) => [tier, { ...model, label: model.selection === 'user-elected' ? 'user-elected only' : tier }]))]));
    const decision = await resolveModelTier({
      deterministic: args.includes('--deterministic'),
      routine: args.includes('--routine'),
      complex: args.includes('--complex'),
      highImpact: args.includes('--high-impact'),
      requestedPremium: args.includes('--premium'),
      unattended: args.includes('--unattended'),
      premiumAuthorized: args.includes('--allow-premium'),
      maxAutoTier: args.includes('--allow-premium') ? 3 : undefined,
    }, ctx ? getProjectDir(ctx, ctx.args) : process.cwd());
    if (args.includes('--json')) { console.log(JSON.stringify({ decision, tiers }, null, 2)); return; }
    for (const [provider, ladder] of Object.entries(tiers)) {
      for (const [tier, entry] of Object.entries(ladder)) console.log(`  ${provider} ${tier}: ${entry.id} (${entry.label})`);
    }
    console.log('\n  Model policy routing');
    console.log(`  Default stance: cheap-first role/tier intent, compiled per provider from the effective catalog.`);
    console.log(`  Suggested tier: ${decision.tier}${decision.modelTier ? ` (${decision.modelTier})` : ' (no model call)'}`);
    console.log(`  Confirmation: ${decision.requiresConfirmation ? 'required' : 'not required'}`);
    console.log(`  Summary before escalation: ${decision.summaryRequired ? 'required' : 'not required'}`);
    console.log(`  Rationale: ${decision.rationale.join('; ')}`);
    console.log('\n  Commands:');
    console.log('    aiwg models sources --json        # inspect effective cache/static/remote catalog provenance');
    console.log('    aiwg models refresh --json        # refresh dynamic provider catalog where supported');
    console.log('    aiwg models audit --provider P    # compile artifact policy and diagnostics');
    console.log('    aiwg models resolve --provider P  # show selected provider model for matching artifacts');
    console.log('\n  Authoring:');
    console.log('    Agents: use model-role/model-tier; avoid exact provider IDs in source scaffolds.');
    console.log('    Skills/commands: use commandHint.modelRole and commandHint.modelTier.');
    return;
}
