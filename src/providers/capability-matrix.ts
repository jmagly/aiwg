/**
 * Provider Capability Matrix Loader
 *
 * Loads and queries the authoritative provider capability matrix from
 * agentic/code/providers/capability-matrix.yaml. Provides typed access
 * for the scheduler, agent teams, steward, and runtime-info CLI.
 *
 * @issue #604
 * @unblocks #597, #598, #599
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load as loadYaml } from 'js-yaml';
import { findPackageRoot } from '../cli/find-package-root.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderStatus = 'stable' | 'experimental' | 'deprecated';

export type FeatureKey =
  | 'cron'
  | 'agent_teams'
  | 'tasks'
  | 'mcp'
  | 'behaviors'
  | 'mission_control'
  | 'daemon';

/**
 * Daemon support tier for a provider.
 *
 * The current production CLI has no daemon lifecycle command, so bundled
 * providers resolve to `unsupported`. Other values remain in the type for
 * project-local provider manifests and future atomic CLI implementations.
 *
 * @issue #656
 */
export type DaemonTier = 'native' | 'pty-adapter' | 'unsupported';

export type EmulationStrategy =
  | 'native'
  | 'hooks'
  | 'aiwg-mc'
  | 'aiwg-schedule'
  | 'aiwg-daemon'
  | 'external-trigger'
  | null;

export function isExternalStrategy(strategy: EmulationStrategy): boolean {
  return strategy === 'external-trigger';
}

export type DeployTarget = 'project' | 'home' | 'mixed';

export interface ArtifactPaths {
  agents: string;
  commands: string;
  skills: string;
  skills_cross_agent?: string;
  rules: string;
  behaviors: string | null;
}

export interface HookWiring {
  at_link_support: boolean;
  hook_file?: string;
  hook_directive?: string;
  fallback?: string;
  context_file: string;
}

/**
 * S0 route-feasibility evidence (B-OG-27). One row per matrix provider:
 * whether the target is in or out of MVP worker scope, the identity
 * evidence class, the native evidence channel, hidden fan-out state, and
 * the synthetic probe budget and its operator authorization provenance.
 * Help text, flag acceptance and worker echoes never qualify; unknown fan-out blocks
 * strict use. Final qualification stays with B-OG-07/08/09/28.
 */
export type RouteFeasibilityScope = 'in' | 'out';

export type RouteIdentityClass =
  | 'backend-attested'
  | 'runtime-configured-only'
  | 'unavailable';

export type RouteEvidenceGrade = 'H' | 'R' | 'D';

export type RouteFanout = 'none' | 'controlled' | 'unknown';

export type RouteProbeBudget = {
  calls: number;
  tokens: number;
} & (
  | { status: 'proposed' }
  | {
    status: 'authorized';
    authorized_by: string;
    /** ISO calendar date (YYYY-MM-DD). */
    authorized_at: `${number}-${number}-${number}`;
    hosts: [string, ...string[]];
  }
);

/**
 * S1 coverage reconciliation (B-OG-47). One normalized row per matrix
 * provider: the profile-qualification issue for IN rows, the date its
 * evidence/sources were last checked, and whether authenticated live
 * qualification exists (doc/help/source evidence never sets it). OUT rows
 * carry the concrete interface gap; OUT and promoted rows carry the
 * upstream recheck result. No row stores a fabricated command.
 */
export interface RouteCoverage {
  profile_issue: `roctinam/aiwg#${number}` | null;
  /** ISO calendar date (YYYY-MM-DD) the cited evidence was last checked. */
  source_date: `${number}-${number}-${number}`;
  live_qualified: boolean;
  sources: [string, ...string[]];
  exclusion_gap?: string;
  recheck?: string;
}

export interface RouteFeasibility {
  scope: RouteFeasibilityScope;
  identity: RouteIdentityClass;
  evidence: RouteEvidenceGrade;
  channel: string;
  fanout: RouteFanout;
  probe_budget: RouteProbeBudget;
  coverage?: RouteCoverage;
}

export interface ProviderCapabilities {
  display_name: string;
  byok?: {
    status: 'verified' | 'documented' | 'unverified';
    settings: string[];
    verification: string;
    notes: string;
    docs: string;
  };
  aliases?: string[];
  route_feasibility?: RouteFeasibility;
  status: ProviderStatus;
  /** Primary daemon support tier. @issue #656 */
  daemon_tier: DaemonTier;
  /** True if the provider also supports the PTY adapter as a secondary mode. @issue #656 */
  daemon_pty_adapter: boolean;
  artifact_paths: ArtifactPaths;
  native_features: Record<FeatureKey, boolean>;
  emulation: Record<FeatureKey, EmulationStrategy>;
  hook_wiring: HookWiring;
  deploy_target: DeployTarget;
  aggregated_output: boolean;
  agent_capabilities?: Record<string, AgentCapabilities>;
  /** Native interactive-question (UX) support. Absent => unknown / markdown fallback. @issue #1668 */
  interaction?: InteractionCapabilities;
}

/**
 * Describes how a provider supports structured interactive questions
 * (e.g. Claude Code's AskUserQuestion, Codex's request_user_input / MCP elicitation).
 * Consumed by the native-ux-tools rule and steward routing. @issue #1668
 */
export interface InteractionCapabilities {
  /**
   * - `native`     — agent may call a structured-question tool directly
   * - `mode_gated` — tool exists but is gated by mode/feature flag (often off by default)
   * - `mcp_only`   — structured questions reach the user only via MCP elicitation
   * - `none`       — no native mechanism; markdown fallback
   */
  structured_questions: 'native' | 'mode_gated' | 'mcp_only' | 'none';
  /** Name of the agent-facing tool, when one exists. */
  tool?: string;
  /** Feature flag gating the tool, when mode_gated. */
  feature_flag?: string;
  /** Whether the agent-facing tool is available by default. */
  default_available?: boolean;
  /** MCP elicitation support level, when applicable. */
  mcp_elicitation?: 'stable' | 'experimental' | 'none';
  /** Fallback mechanism when the native tool is unavailable. */
  fallback?: string;
  notes?: string;
}

export interface AgentCapabilities {
  context_window?: number;
  max_output_tokens?: number;
  max_tool_calls?: number;
  max_concurrent_subagents?: number;
  supports_streaming?: boolean;
  million_context_requires_extra_usage?: boolean;
  quota_available?: boolean;
  notes?: string;
  recovery?: Record<string, string>;
}

export type DispatchPreflightStatus =
  | 'ok'
  | 'would_overflow'
  | 'quota_unavailable'
  | 'tool_budget_exceeded'
  | 'unknown_provider';

export interface DispatchPreflightInput {
  provider: string;
  agentType?: string;
  promptTokens?: number;
  contextTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  requiresMillionContext?: boolean;
}

export interface DispatchPreflightResult {
  status: DispatchPreflightStatus;
  provider: string;
  agentType: string;
  estimatedTokens: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  maxToolCalls: number | null;
  recoveryHint: string | null;
  message: string;
}

export interface FeatureDefinition {
  description: string;
  native_example: string | null;
  emulation_strategies: Record<string, string>;
}

export interface CapabilityMatrix {
  version: string;
  providers: Record<string, ProviderCapabilities>;
  features: Record<FeatureKey, FeatureDefinition>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _cached: CapabilityMatrix | null = null;

/**
 * Resolve the path to capability-matrix.yaml relative to the package root.
 * The lightweight CLI embeds the matrix next to the compiled loader. Full and
 * source layouts retain the canonical agentic path.
 *
 * @issue #1261
 */
function resolveMatrixPath(): string {
  if (process.env.AIWG_ROOT) {
    return resolve(process.env.AIWG_ROOT, 'agentic', 'code', 'providers', 'capability-matrix.yaml');
  }

  const thisDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  const embeddedMatrix = resolve(thisDir, 'capability-matrix.yaml');
  if (existsSync(embeddedMatrix)) return embeddedMatrix;

  const packageRoot = findPackageRoot(thisDir);
  if (!packageRoot) {
    throw new Error(
      `Cannot locate aiwg package root from ${thisDir}. ` +
      `Set AIWG_ROOT environment variable as a workaround.`
    );
  }
  return resolve(packageRoot, 'agentic', 'code', 'providers', 'capability-matrix.yaml');
}

/**
 * Load the capability matrix from disk (cached after first load).
 */
export function loadCapabilityMatrix(): CapabilityMatrix {
  if (_cached) return _cached;

  const matrixPath = resolveMatrixPath();
  const raw = readFileSync(matrixPath, 'utf-8');
  _cached = loadYaml(raw) as CapabilityMatrix;
  return _cached;
}

/**
 * Force-reload the matrix (e.g. after edits during validate-metadata).
 */
export function reloadCapabilityMatrix(): CapabilityMatrix {
  _cached = null;
  return loadCapabilityMatrix();
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get the full capabilities object for a provider by key or alias.
 */
export function getProviderCapabilities(
  providerKey: string,
): ProviderCapabilities | undefined {
  const matrix = loadCapabilityMatrix();

  // Direct match
  if (matrix.providers[providerKey]) {
    return matrix.providers[providerKey];
  }

  // Search aliases
  for (const [key, caps] of Object.entries(matrix.providers)) {
    if (caps.aliases?.includes(providerKey)) {
      return matrix.providers[key];
    }
  }

  return undefined;
}

/**
 * Get the S0 route-feasibility row for a provider by key or alias.
 * Returns undefined when the matrix carries no row (e.g. registry-only
 * `generic`, which is not a matrix provider).
 */
export function getRouteFeasibility(
  providerKey: string,
): RouteFeasibility | undefined {
  return getProviderCapabilities(providerKey)?.route_feasibility;
}

export function getAgentCapabilities(
  providerKey: string,
  agentType = 'default',
): AgentCapabilities | undefined {
  const caps = getProviderCapabilities(providerKey);
  if (!caps?.agent_capabilities) return undefined;
  const defaults = caps.agent_capabilities.default || {};
  const override = caps.agent_capabilities[agentType] || {};
  return {
    ...defaults,
    ...override,
    recovery: {
      ...(defaults.recovery || {}),
      ...(override.recovery || {}),
    },
  };
}

/**
 * Pre-flight a provider subagent dispatch before spawning work. The helper is
 * intentionally deterministic: callers pass token/tool estimates and receive a
 * structured routing signal instead of pattern-matching provider error strings.
 */
export function preflightSubagentDispatch(input: DispatchPreflightInput): DispatchPreflightResult {
  const agentType = input.agentType || 'default';
  const provider = input.provider;
  const caps = getProviderCapabilities(provider);
  const agentCaps = getAgentCapabilities(provider, agentType);
  const estimatedTokens =
    (input.promptTokens || 0) +
    (input.contextTokens || 0) +
    (input.outputTokens || 0);
  const contextWindow = agentCaps?.context_window ?? null;
  const maxOutputTokens = agentCaps?.max_output_tokens ?? null;
  const maxToolCalls = agentCaps?.max_tool_calls ?? null;

  const base = {
    provider,
    agentType,
    estimatedTokens,
    contextWindow,
    maxOutputTokens,
    maxToolCalls,
  };

  if (!caps) {
    return {
      ...base,
      status: 'unknown_provider',
      recoveryHint: 'escalate_to_human',
      message: `Unknown provider: ${provider}`,
    };
  }

  if (
    input.requiresMillionContext === true &&
    agentCaps?.million_context_requires_extra_usage === true &&
    agentCaps?.quota_available !== true
  ) {
    return {
      ...base,
      status: 'quota_unavailable',
      recoveryHint: agentCaps?.recovery?.quota_exhausted || 'retry_with_standard_context',
      message: `${provider}/${agentType} requires 1M-context extra usage, but quota is not marked available.`,
    };
  }

  if (contextWindow !== null && estimatedTokens > contextWindow) {
    return {
      ...base,
      status: 'would_overflow',
      recoveryHint: agentCaps?.recovery?.context_overflow || 'retry_with_prefiltered_context',
      message: `Estimated dispatch size ${estimatedTokens} tokens exceeds ${provider}/${agentType} context window ${contextWindow}.`,
    };
  }

  if (maxOutputTokens !== null && (input.outputTokens || 0) > maxOutputTokens) {
    return {
      ...base,
      status: 'would_overflow',
      recoveryHint: 'reduce_expected_output',
      message: `Requested output budget ${input.outputTokens || 0} exceeds ${provider}/${agentType} max output ${maxOutputTokens}.`,
    };
  }

  if (maxToolCalls !== null && (input.toolCalls || 0) > maxToolCalls) {
    return {
      ...base,
      status: 'tool_budget_exceeded',
      recoveryHint: 'split_task_or_prefilter_context',
      message: `Estimated tool calls ${input.toolCalls || 0} exceeds ${provider}/${agentType} max tool calls ${maxToolCalls}.`,
    };
  }

  return {
    ...base,
    status: 'ok',
    recoveryHint: null,
    message: `${provider}/${agentType} dispatch fits declared provider budget.`,
  };
}

/**
 * Check whether a provider supports a feature natively (without emulation).
 */
export function supportsNative(
  caps: ProviderCapabilities,
  feature: FeatureKey,
): boolean {
  return caps.native_features[feature] === true;
}

/**
 * Get the emulation strategy for a feature on a provider.
 * Returns 'native' if the provider supports it natively, or the
 * emulation strategy string, or null if unsupported entirely.
 */
export function getEmulationStrategy(
  caps: ProviderCapabilities,
  feature: FeatureKey,
): EmulationStrategy {
  return caps.emulation[feature] ?? null;
}

/**
 * List all provider keys.
 */
export function listProviders(): string[] {
  return Object.keys(loadCapabilityMatrix().providers);
}

/**
 * List all providers that natively support a given feature.
 */
export function providersWithNativeSupport(feature: FeatureKey): string[] {
  const matrix = loadCapabilityMatrix();
  return Object.entries(matrix.providers)
    .filter(([, caps]) => caps.native_features[feature])
    .map(([key]) => key);
}

/**
 * Get the feature definition (description, examples, strategies).
 */
export function getFeatureDefinition(
  feature: FeatureKey,
): FeatureDefinition | undefined {
  return loadCapabilityMatrix().features[feature];
}

/**
 * Get the daemon tier for a provider.
 * Returns 'unsupported' if the provider is not found or has no daemon_tier.
 *
 * @issue #656
 */
export function getDaemonTier(providerKey: string): DaemonTier {
  const caps = getProviderCapabilities(providerKey);
  return caps?.daemon_tier ?? 'unsupported';
}

/**
 * List all providers that support daemon mode (Tier 1: native).
 *
 * @issue #656
 */
export function daemonCapableProviders(): string[] {
  const matrix = loadCapabilityMatrix();
  return Object.entries(matrix.providers)
    .filter(([, caps]) => caps.daemon_tier === 'native')
    .map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Display helpers (for CLI output)
// ---------------------------------------------------------------------------

/**
 * Format the full capability matrix as a human-readable table string.
 */
export function formatCapabilityTable(): string {
  const matrix = loadCapabilityMatrix();
  const features: FeatureKey[] = [
    'cron',
    'agent_teams',
    'tasks',
    'mcp',
    'behaviors',
    'mission_control',
    'daemon',
  ];

  const lines: string[] = [];
  lines.push('Provider Capability Matrix (v' + matrix.version + ')');
  lines.push('='.repeat(90));
  lines.push('');

  // Header
  const hdr = [
    padRight('Provider', 18),
    ...features.map((f) => padRight(f, 15)),
  ].join('| ');
  lines.push(hdr);
  lines.push('-'.repeat(hdr.length));

  // Rows
  for (const [, caps] of Object.entries(matrix.providers)) {
    const cells = features.map((f) => {
      if (caps.native_features[f]) return padRight('NATIVE', 15);
      const emu = caps.emulation[f];
      if (isExternalStrategy(emu)) return padRight('EXTERNAL', 15);
      if (emu) return padRight(emu, 15);
      return padRight('--', 15);
    });
    lines.push([padRight(caps.display_name, 18), ...cells].join('| '));
  }

  lines.push('');
  lines.push('Legend: NATIVE = built-in support, aiwg-* = AIWG emulation, EXTERNAL = host/CI owns the trigger, -- = unsupported');

  return lines.join('\n');
}

/**
 * Format a single feature's support across all providers.
 */
export function formatFeatureSupport(feature: FeatureKey): string {
  const matrix = loadCapabilityMatrix();
  const def = matrix.features[feature];
  const lines: string[] = [];

  lines.push(`Feature: ${feature}`);
  if (def) {
    lines.push(`Description: ${def.description}`);
    if (def.native_example) {
      lines.push(`Native example: ${def.native_example}`);
    }
  }
  lines.push('');

  for (const [, caps] of Object.entries(matrix.providers)) {
    const native = caps.native_features[feature];
    const strategy = caps.emulation[feature];
    const status = native
      ? 'NATIVE'
      : isExternalStrategy(strategy)
        ? 'external trigger'
        : strategy
          ? `emulated (${strategy})`
          : 'unsupported';
    lines.push(`  ${padRight(caps.display_name, 18)} ${status}`);
  }

  return lines.join('\n');
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}
