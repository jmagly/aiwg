import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadGraphIndexFile } from '../../artifacts/index-reader.js';
import type { ArtifactIndex, IndexStats } from '../../artifacts/types.js';
import { readAiwgConfig, type DeployedArtifactCounts } from '../../config/aiwg-config.js';
import { readUserRegistry } from '../../config/user-registry.js';
import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
  resolveProviderPathValue,
} from '../../providers/provider-definitions.js';
import { diagnoseIntegratedProviderTransformationReceipt } from '../../providers/transformation-receipt-integration.js';
import type { ProviderDriftKind } from '../../providers/transformation-receipt.js';
import {
  diagnoseWorkspaceContext,
  providerContextContract,
} from '../../smiths/context-pipeline/workspace-context.js';
import { USER_SCOPE_PATHS } from '../scope-resolver.js';

export type DeploymentScope = 'project' | 'user';
export type DeploymentOutcome =
  | 'planned'
  | 'ready'
  | 'ready-restart-required'
  | 'degraded'
  | 'failed';
export type DeploymentExitClassification = 'preview' | 'success' | 'degraded' | 'failure';
export type DeploymentPhaseState = 'planned' | 'passed' | 'skipped' | 'failed';
export type DeploymentFindingSeverity = 'info' | 'advisory' | 'blocking';

export interface DeploymentPhaseResult {
  id: 'resolve' | 'deploy' | 'index' | 'context' | 'verify' | 'report';
  state: DeploymentPhaseState;
  required: boolean;
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface DeploymentVerificationFinding {
  id: string;
  provider: string;
  severity: DeploymentFindingSeverity;
  message: string;
  remediation?: string;
  evidence?: Record<string, unknown>;
}

export interface ProviderDeploymentVerification {
  provider: string;
  scope: DeploymentScope;
  outcome: DeploymentOutcome;
  restartRequired: boolean;
  restartAction: string | null;
  restartReason: string | null;
  counts: DeployedArtifactCounts & { behaviors: number };
  phases: DeploymentPhaseResult[];
  findings: DeploymentVerificationFinding[];
}

export interface DiscoveryInventory {
  graph: 'framework';
  totalArtifacts: number;
  byType: Record<string, number>;
  builtAt: string;
}

export interface UseDeploymentResult {
  schema: 'aiwg.use.result.v1';
  generatedAt: string;
  projectRoot: string;
  frameworkRoot: string;
  scope: DeploymentScope;
  requestedBundles: string[];
  dryRun: boolean;
  providers: ProviderDeploymentVerification[];
  phases: DeploymentPhaseResult[];
  findings: DeploymentVerificationFinding[];
  outcome: DeploymentOutcome;
  restartRequired: boolean;
  discovery: DiscoveryInventory | null;
  exitClassification: DeploymentExitClassification;
  exitCode: number;
}

export interface VerifyProviderDeploymentOptions {
  projectRoot: string;
  /** Provider output root when it is split from the local project control root. */
  outputRoot?: string;
  frameworkRoot: string;
  provider: string;
  scope: DeploymentScope;
  requestedBundles: string[];
  contextOptOut?: boolean;
  invocationStartedAt?: string;
  deploymentExitCode?: number;
  deploymentMessage?: string;
  /** Suppress first-run receipt absence while retaining diagnosis in doctor/status. */
  reportMissingReceipt?: boolean;
}

const RESTART_NOTICES: Readonly<Record<string, { action: string; reason: string }>> = {
  claude: {
    action: 'Restart Claude Code so the running session reloads deployed agents and skills.',
    reason: 'Claude Code reads its agent and skill registries when a session starts.',
  },
  codex: {
    action: 'Restart or reopen Codex in this workspace so it reloads deployed agents and skills.',
    reason: 'Codex scans project agent and skill registries when a session starts.',
  },
  copilot: {
    action: 'Reload the VS Code window so Copilot reloads workspace agents and instructions.',
    reason: 'Copilot caches workspace agent definitions until the VS Code window reloads.',
  },
  cursor: {
    action: 'Reload the Cursor workspace so it reloads agents and rules.',
    reason: 'Cursor reads workspace agents and rules when the workspace opens.',
  },
  factory: {
    action: 'Restart the Factory droid runtime so it reloads deployed droids.',
    reason: 'Factory loads its droid registry when the runtime starts.',
  },
  opencode: {
    action: 'Restart the OpenCode session so it reloads deployed agents.',
    reason: 'OpenCode scans its agent directory when the session starts.',
  },
  openclaw: {
    action: 'Restart OpenClaw so it reloads its home-directory registry.',
    reason: 'OpenClaw loads its home-directory registry when the process starts.',
  },
  warp: {
    action: 'Open a fresh Warp tab so it reloads project context.',
    reason: 'Warp reads project context when a tab starts.',
  },
  windsurf: {
    action: 'Reload Devin Desktop so it reparses project context.',
    reason: 'Devin Desktop reads the Windsurf-compatible project context when the workspace opens.',
  },
};

const INVENTORY_TYPE_ORDER = [
  'agent',
  'skill',
  'command',
  'rule',
  'behavior',
  'template',
  'flow',
  'runbook',
  'schema',
] as const;

export function normalizeFrameworkDiscoveryInventory(stats: IndexStats): DiscoveryInventory {
  const byType: Record<string, number> = {};
  for (const type of INVENTORY_TYPE_ORDER) byType[type] = Number(stats.byType[type] ?? 0);
  for (const type of Object.keys(stats.byType).sort()) {
    if (!(type in byType)) byType[type] = Number(stats.byType[type] ?? 0);
  }
  return {
    graph: 'framework',
    totalArtifacts: stats.totalArtifacts,
    byType,
    builtAt: stats.builtAt,
  };
}

function frameworkDiscoveryInventory(frameworkRoot: string): DiscoveryInventory | null {
  const stats = loadGraphIndexFile<IndexStats>(frameworkRoot, 'stats.json', 'framework');
  return stats ? normalizeFrameworkDiscoveryInventory(stats) : null;
}

const BUNDLE_INDEX_TOKENS: Readonly<Record<string, string[]>> = {
  all: [],
  sdlc: ['sdlc-complete'],
  marketing: ['marketing'],
  'media-curator': ['media-curator'],
  research: ['research-complete'],
  forensics: ['forensics-complete'],
  dfir: ['forensics-complete'],
  'security-engineering': ['security-engineering'],
  ops: ['ops-complete'],
  validation: ['validation-complete'],
  'knowledge-base': ['knowledge-base'],
};

function finding(
  provider: string,
  id: string,
  severity: DeploymentFindingSeverity,
  message: string,
  remediation?: string,
  evidence?: Record<string, unknown>,
): DeploymentVerificationFinding {
  return { id, provider, severity, message, remediation, evidence };
}

async function exists(candidate: string): Promise<boolean> {
  if (!candidate) return false;
  return access(candidate).then(() => true).catch(() => false);
}

async function countEntries(candidate: string): Promise<number> {
  if (!candidate) return 0;
  try {
    return (await readdir(candidate, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith('.'))
      .length;
  } catch {
    return 0;
  }
}

function emptyCounts(): DeployedArtifactCounts & { behaviors: number } {
  return { agents: 0, commands: 0, skills: 0, rules: 0, behaviors: 0 };
}

/**
 * Flat-artifact attribution (#2507).
 *
 * Deployment counts used to be a plain `readdir` of the provider directory, so
 * a run that wrote nothing still reported every pre-existing file as deployed —
 * a no-op deploy over a stale, unmanaged tree was indistinguishable from a
 * successful one. An artifact now counts as deployed only when this run wrote
 * it (mtime at or after the invocation start) or AIWG owns it (sidecar entry or
 * in-file managed marker). Everything else is reported as unmanaged.
 */
const MANAGED_SIDECAR = '.aiwg-manifest.json';
const MANAGED_MARKER_PATTERN = /^(?:<!--\s*aiwg:managed\s|#\s*aiwg:managed\s)/m;
const FLAT_ARTIFACT_KINDS = ['agents', 'commands', 'rules'] as const;
const FLAT_ARTIFACT_EXTENSIONS = ['.md', '.mdc', '.toml'];
/** Clock skew tolerance between the recorded invocation start and file mtimes. */
const WRITE_ATTRIBUTION_SKEW_MS = 2_000;

type FlatArtifactKind = (typeof FLAT_ARTIFACT_KINDS)[number];

const FLAT_ARTIFACT_NOUNS: Readonly<Record<FlatArtifactKind, string>> = {
  agents: 'agent',
  commands: 'command',
  rules: 'rule',
};

interface FlatArtifactTally {
  deployed: number;
  unmanaged: string[];
}

async function readManagedSidecarNames(dir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(path.join(dir, MANAGED_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as { managed?: Record<string, unknown> };
    return new Set(Object.keys(parsed.managed ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * Split one flat artifact directory into artifacts this deployment accounts for
 * and artifacts it does not. Returns `null` when the directory cannot be
 * attributed (missing, unreadable, or no invocation boundary to compare
 * against), so callers fall back to the plain entry count.
 */
async function tallyFlatArtifacts(dir: string, writtenSince: number | null): Promise<FlatArtifactTally | null> {
  if (!dir || writtenSince === null) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const managedNames = await readManagedSidecarNames(dir);
  const tally: FlatArtifactTally = { deployed: 0, unmanaged: [] };

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isFile()) {
      // Nested directories (e.g. deployed behaviors under rules/) are counted
      // as-is; they are not flat artifacts and have their own lifecycle.
      tally.deployed += 1;
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!FLAT_ARTIFACT_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue;

    const absolute = path.join(dir, entry.name);
    if (managedNames.has(entry.name)) {
      tally.deployed += 1;
      continue;
    }

    let writtenThisRun = false;
    try {
      const info = await stat(absolute);
      writtenThisRun = info.mtimeMs + WRITE_ATTRIBUTION_SKEW_MS >= writtenSince;
    } catch {
      writtenThisRun = false;
    }
    if (writtenThisRun) {
      tally.deployed += 1;
      continue;
    }

    let owned = false;
    try {
      owned = MANAGED_MARKER_PATTERN.test(await readFile(absolute, 'utf8'));
    } catch {
      // Unreadable files are not claimed as deployed, but neither are they
      // reported as shadowing artifacts we could not inspect.
      continue;
    }
    if (owned) tally.deployed += 1;
    else tally.unmanaged.push(entry.name);
  }

  tally.unmanaged.sort((a, b) => a.localeCompare(b));
  return tally;
}

function phase(
  id: DeploymentPhaseResult['id'],
  state: DeploymentPhaseState,
  required: boolean,
  summary: string,
  evidence?: Record<string, unknown>,
): DeploymentPhaseResult {
  return { id, state, required, summary, evidence };
}

function classifyOutcome(
  findings: DeploymentVerificationFinding[],
  restartRequired: boolean,
): Exclude<DeploymentOutcome, 'planned'> {
  if (findings.some((item) => item.severity === 'blocking')) return 'failed';
  if (findings.some((item) => item.severity === 'advisory')) return 'degraded';
  return restartRequired ? 'ready-restart-required' : 'ready';
}

const RECEIPT_DRIFT_POLICY: Readonly<Record<ProviderDriftKind, {
  severity: DeploymentFindingSeverity;
  remediation?: string;
}>> = {
  'source-verification-failure': {
    severity: 'blocking',
    remediation: 'Restore or reverify the canonical source before regenerating provider outputs.',
  },
  'transformation-mismatch': {
    severity: 'blocking',
    remediation: 'Review the active provider adapter change, then re-run the same aiwg use command.',
  },
  'user-modification': {
    severity: 'blocking',
    remediation: 'Back up the changed managed output if needed, then re-run the same aiwg use command.',
  },
  'stale-output': {
    severity: 'blocking',
    remediation: 'Re-run the same aiwg use command to complete a verified regeneration.',
  },
  'missing-receipt': {
    severity: 'advisory',
    remediation: 'Re-run the same aiwg use command to establish provider transformation evidence.',
  },
  'policy-exempt': {
    severity: 'info',
  },
  'source-evidence-unavailable': {
    severity: 'advisory',
    remediation: 'Run aiwg auth login, then aiwg versions resolve <installed-version> once online to warm the verified cache; re-run the same aiwg use command afterward.',
  },
};

async function collectProviderReceiptFindings(
  options: VerifyProviderDeploymentOptions,
  provider: string,
): Promise<DeploymentVerificationFinding[]> {
  try {
    const diagnosis = await diagnoseIntegratedProviderTransformationReceipt({
      projectRoot: options.projectRoot,
      outputRoot: options.outputRoot,
      frameworkRoot: options.frameworkRoot,
      provider,
      scope: options.scope,
      requestedBundles: options.requestedBundles,
    });
    return diagnosis.findings
      .filter((drift) => options.reportMissingReceipt !== false || drift.kind !== 'missing-receipt')
      .map((drift, index) => {
        const policy = RECEIPT_DRIFT_POLICY[drift.kind];
        return finding(
          provider,
          `provider-drift:${drift.kind}:${index}`,
          policy.severity,
          drift.message,
          policy.remediation,
          {
            driftClass: drift.kind,
            receiptPath: diagnosis.receiptPath,
            checkedOutputs: diagnosis.checkedOutputs,
            ...(drift.path ? { path: drift.path } : {}),
            ...(drift.expected ? { expected: drift.expected } : {}),
            ...(drift.actual ? { actual: drift.actual } : {}),
          },
        );
      });
  } catch (error) {
    return [finding(
      provider,
      'provider-drift:missing-receipt:0',
      'advisory',
      `Provider transformation evidence could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      RECEIPT_DRIFT_POLICY['missing-receipt'].remediation,
      { driftClass: 'missing-receipt' },
    )];
  }
}

function indexContainsRequestedBundles(index: ArtifactIndex, requestedBundles: string[]): boolean {
  if (requestedBundles.includes('all')) return Object.keys(index.entries).length > 0;
  const entryPaths = Object.keys(index.entries);
  return requestedBundles.every((bundle) => {
    const tokens = BUNDLE_INDEX_TOKENS[bundle] ?? [bundle];
    return tokens.some((token) => entryPaths.some((entryPath) => entryPath.includes(token)));
  });
}

async function readManagedMarker(candidate: string): Promise<boolean> {
  try {
    return (await readFile(candidate, 'utf8')).includes('<!-- aiwg-managed -->');
  } catch {
    return false;
  }
}

async function collectRegistryFindings(
  options: VerifyProviderDeploymentOptions,
  provider: string,
  actualCounts: DeployedArtifactCounts & { behaviors: number },
): Promise<DeploymentVerificationFinding[]> {
  const findings: DeploymentVerificationFinding[] = [];
  const projectConfig = await readAiwgConfig(options.projectRoot);
  const useUserRegistry = options.scope === 'user' && provider !== 'openhuman';
  const userRegistry = useUserRegistry ? await readUserRegistry() : null;

  for (const bundle of options.requestedBundles) {
    const projectRecord = projectConfig?.installed[bundle]?.deployedTo[provider];
    const userRecord = userRegistry?.installed[bundle]?.deployedTo[provider];
    const record = useUserRegistry ? userRecord : projectRecord;
    if (!record) {
      findings.push(finding(
        provider,
        `registry-missing:${bundle}`,
        'blocking',
        `Installed-state record is missing for '${bundle}' on ${provider} at ${options.scope} scope.`,
        `Re-run aiwg use ${bundle} --provider ${provider}${options.scope === 'user' ? ' --scope user' : ''}.`,
      ));
      continue;
    }

    const comparedTypes = ['agents', 'commands', 'skills', 'rules'] as const;
    for (const type of comparedTypes) {
      const recorded = Number(record[type] ?? 0);
      if (!Number.isSafeInteger(recorded) || recorded < 0) {
        findings.push(finding(
          provider,
          `registry-count-invalid:${bundle}:${type}`,
          'blocking',
          `Installed-state count for '${bundle}' ${type} is invalid: ${String(record[type])}.`,
          `Re-run aiwg use ${bundle} --provider ${provider} to repair the managed deployment.`,
          { bundle, type, recorded: record[type] },
        ));
      }
    }

    const recordedTotal = comparedTypes.reduce((sum, type) => sum + Number(record[type] ?? 0), 0);
    const actualTotal = Object.values(actualCounts).reduce((sum, count) => sum + count, 0);
    if (recordedTotal > 0 && actualTotal === 0) {
      findings.push(finding(
        provider,
        `registry-artifacts-missing:${bundle}`,
        'blocking',
        `Installed state records artifacts for '${bundle}', but no managed artifacts were found for ${provider}.`,
        `Re-run aiwg use ${bundle} --provider ${provider} to repair the managed deployment.`,
        { bundle, recordedTotal, actualTotal },
      ));
    }

    if (useUserRegistry && !projectRecord) {
      findings.push(finding(
        provider,
        `project-registry-missing:${bundle}`,
        'advisory',
        `Project registry does not describe the additive user-scope deployment for '${bundle}'.`,
        'Run aiwg status --probe --json from the originating project to inspect both registries.',
      ));
    }
  }
  return findings;
}

export async function verifyProviderDeployment(
  options: VerifyProviderDeploymentOptions,
): Promise<ProviderDeploymentVerification> {
  const normalized = normalizeProviderDefinitionId(options.provider) ?? options.provider;
  const definition = getProviderDefinition(normalized);
  const findings: DeploymentVerificationFinding[] = [];
  const counts = emptyCounts();
  const restartNotice = RESTART_NOTICES[normalized] ?? null;
  const restartAction = restartNotice?.action ?? null;
  const restartReason = restartNotice?.reason ?? null;
  const restartRequired = restartAction !== null;

  if (!definition) {
    findings.push(finding(
      normalized,
      'provider-unknown',
      'blocking',
      `No provider definition is available for '${options.provider}'.`,
      'Choose a supported provider or repair the project-local provider adapter.',
    ));
  }

  if ((options.deploymentExitCode ?? 0) !== 0) {
    findings.push(finding(
      normalized,
      'deployment-command-failed',
      'blocking',
      options.deploymentMessage || `Deployment exited with code ${options.deploymentExitCode}.`,
      'Review the deployment error, correct it, and re-run the same aiwg use command.',
      { exitCode: options.deploymentExitCode },
    ));
  }

  if (!(await exists(options.projectRoot))) {
    findings.push(finding(
      normalized,
      'project-root-missing',
      'blocking',
      `Resolved project root does not exist: ${options.projectRoot}`,
      'Select an existing project root and run aiwg use again.',
    ));
  }

  if (definition) {
    const deploymentRoot = options.outputRoot ?? options.projectRoot;
    const artifactPaths = options.scope === 'user'
      ? USER_SCOPE_PATHS[normalized] ?? definition.paths.artifacts
      : definition.paths.artifacts;
    const writtenSince = options.invocationStartedAt
      ? Date.parse(options.invocationStartedAt)
      : Number.NaN;
    const attributionBoundary = Number.isFinite(writtenSince) ? writtenSince : null;
    for (const type of ['agents', 'commands', 'skills', 'rules', 'behaviors'] as const) {
      const resolved = resolveProviderPathValue(artifactPaths[type], deploymentRoot);
      counts[type] = await countEntries(resolved);
      // #2507: flat artifact directories report what this deployment accounts
      // for, not whatever happens to be sitting in the directory.
      const flatKind: FlatArtifactKind | undefined = FLAT_ARTIFACT_KINDS.find((kind) => kind === type);
      if (!flatKind) continue;
      const tally = await tallyFlatArtifacts(resolved, attributionBoundary);
      if (!tally) continue;
      counts[flatKind] = tally.deployed;
      if (tally.unmanaged.length === 0) continue;
      const shown = tally.unmanaged.slice(0, 3).join(', ');
      const remainder = tally.unmanaged.length - 3;
      findings.push(finding(
        normalized,
        `unmanaged-artifacts:${flatKind}`,
        'advisory',
        `${tally.unmanaged.length} unmanaged ${FLAT_ARTIFACT_NOUNS[flatKind]} file(s) left in place at ${artifactPaths[flatKind]}: `
        + `${shown}${remainder > 0 ? `, and ${remainder} more` : ''}. `
        + 'They are not managed by AIWG and were not counted as deployed.',
        `Re-run aiwg use ${options.requestedBundles[0] ?? 'all'} --provider ${normalized} --force to replace them, `
        + `or delete ${artifactPaths[flatKind]} so AIWG can reclaim the directory.`,
        { kind: flatKind, unmanaged: tally.unmanaged },
      ));
    }
    const resolvedSkillsPath = resolveProviderPathValue(artifactPaths.skills, deploymentRoot);
    const kernelPath = options.scope === 'user'
      ? ''
      : resolveProviderPathValue(definition.paths.kernelSkills, deploymentRoot);
    const kernelCount = await countEntries(kernelPath);
    if (kernelPath && kernelPath !== resolvedSkillsPath) counts.skills += kernelCount;
    const artifactTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (artifactTotal === 0) {
      findings.push(finding(
        normalized,
        'provider-artifacts-missing',
        'blocking',
        `No deployed provider or kernel artifacts were found for ${normalized}.`,
        `Re-run aiwg use ${options.requestedBundles[0] ?? 'all'} --provider ${normalized}.`,
        { kernelPath, kernelCount, counts },
      ));
    }
  }

  findings.push(...await collectRegistryFindings(options, normalized, counts));
  findings.push(...await collectProviderReceiptFindings(options, normalized));

  const projectConfig = await readAiwgConfig(options.projectRoot);
  const scopedRegistry = options.scope === 'user'
    ? await readUserRegistry()
    : projectConfig;
  const projectLocalBundles = options.requestedBundles.filter((bundle) =>
    scopedRegistry?.installed[bundle]?.source === 'project-local');
  const frameworkBundles = options.requestedBundles.filter((bundle) => !projectLocalBundles.includes(bundle));
  const indexesToVerify: Array<{
    index: ArtifactIndex | null;
    stats?: IndexStats | null;
    graph: 'framework' | 'project' | 'user';
    bundles: string[];
  }> = [];
  if (frameworkBundles.length > 0) {
    indexesToVerify.push({
      index: loadGraphIndexFile<ArtifactIndex>(options.frameworkRoot, 'metadata.json', 'framework'),
      stats: loadGraphIndexFile<IndexStats>(options.frameworkRoot, 'stats.json', 'framework'),
      graph: 'framework',
      bundles: frameworkBundles,
    });
  }
  if (projectLocalBundles.length > 0) {
    const graph = options.scope === 'user' ? 'user' : 'project';
    indexesToVerify.push({
      index: loadGraphIndexFile<ArtifactIndex>(options.projectRoot, 'metadata.json', graph),
      graph,
      bundles: projectLocalBundles,
    });
  }

  for (const { index, stats, graph, bundles } of indexesToVerify) {
    if (!index || !index.entries || Object.keys(index.entries).length === 0) {
      findings.push(finding(
        normalized,
        `index-unreadable:${graph}`,
        'blocking',
        `The ${graph} capability index is missing, unreadable, or empty.`,
        `Run aiwg index build --graph ${graph}, then re-run the same aiwg use command.`,
      ));
      continue;
    }

    if (graph === 'framework') {
      if (!stats || !stats.byType || !Number.isSafeInteger(stats.totalArtifacts)) {
        findings.push(finding(
          normalized,
          'index-stats-unreadable:framework',
          'blocking',
          'The framework discovery inventory is missing or unreadable.',
          'Run aiwg index build --graph framework, then re-run the same aiwg use command.',
        ));
      } else {
        const counts = Object.values(stats.byType);
        const validCounts = counts.every((count) => Number.isSafeInteger(count) && count >= 0);
        const countedTotal = counts.reduce((sum, count) => sum + count, 0);
        if (!validCounts || stats.totalArtifacts < 0 || countedTotal !== stats.totalArtifacts) {
          findings.push(finding(
            normalized,
            'index-stats-invalid:framework',
            'blocking',
            'The framework discovery inventory contains invalid or inconsistent counts.',
            'Run aiwg index build --graph framework, then re-run the same aiwg use command.',
            { totalArtifacts: stats.totalArtifacts, countedTotal },
          ));
        }
      }
    }

    const entryPaths = Object.keys(index.entries);
    const surfacePresent = graph === 'framework'
      ? indexContainsRequestedBundles(index, bundles)
      : bundles.every((bundle) => entryPaths.some((entryPath) => entryPath.includes(bundle)));
    if (!surfacePresent) {
      findings.push(finding(
        normalized,
        `index-surface-missing:${graph}`,
        'blocking',
        `The ${graph} capability index does not contain the requested bundle surface.`,
        `Rebuild the ${graph} index from the selected AIWG source and re-run aiwg use.`,
        { requestedBundles: bundles, entryCount: entryPaths.length },
      ));
    }
    if (options.invocationStartedAt) {
      const builtAt = Date.parse(index.builtAt);
      const startedAt = Date.parse(options.invocationStartedAt);
      if (!Number.isFinite(builtAt) || builtAt + 2_000 < startedAt) {
        findings.push(finding(
          normalized,
          `index-stale:${graph}`,
          'blocking',
          `The ${graph} capability index was not refreshed during this deployment.`,
          `Re-run aiwg use after correcting the ${graph} index build failure.`,
          { graph, builtAt: index.builtAt, invocationStartedAt: options.invocationStartedAt },
        ));
      }
    }
  }

  if (options.contextOptOut) {
    findings.push(finding(
      normalized,
      'context-opt-out',
      'advisory',
      'Canonical context verification was intentionally skipped by an explicit context opt-out.',
      'Run aiwg regenerate when canonical project context is desired.',
    ));
  } else {
    const contextContract = providerContextContract(normalized);
    const providerContextUnsupported = contextContract?.loadMode === 'unsupported';
    if (providerContextUnsupported) {
      findings.push(finding(
        normalized,
        'context-provider-unsupported',
        'advisory',
        `${normalized} has no verified project-local automatic context loader; canonical context remains available for audit and explicit use.`,
        'Use the provider home-scope adapter and inspect WORKSPACE.md explicitly when project context is needed.',
      ));
    }
    const requiredContext = [
      path.join(options.projectRoot, 'WORKSPACE.md'),
      path.join(options.projectRoot, 'AIWG.md'),
      path.join(options.projectRoot, '.aiwg', 'AIWG.md'),
    ];
    for (const contextPath of requiredContext) {
      if (!(await exists(contextPath))) {
        findings.push(finding(
          normalized,
          `context-missing:${path.relative(options.projectRoot, contextPath)}`,
          providerContextUnsupported ? 'advisory' : 'blocking',
          `Required canonical context file is missing: ${path.relative(options.projectRoot, contextPath)}`,
          'Re-run aiwg regenerate or the same aiwg use command.',
        ));
      }
    }
    const managedContextCount = (await Promise.all(requiredContext.map(readManagedMarker)))
      .filter(Boolean).length;
    if (managedContextCount === 0) {
      findings.push(finding(
        normalized,
        'context-unmanaged',
        'advisory',
        'Canonical context exists but no managed marker was detected; operator-owned content was preserved.',
        'Review the context graph and adopt managed markers only when appropriate.',
      ));
    }

    const diagnostics = await diagnoseWorkspaceContext(options.projectRoot);
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === 'info') continue;
      findings.push(finding(
        normalized,
        `context-diagnostic:${diagnostic.code}`,
        diagnostic.severity === 'error' ? 'blocking' : 'advisory',
        diagnostic.message,
        diagnostic.severity === 'error'
          ? 'Run aiwg regenerate after correcting the reported context graph problem.'
          : 'Review the context advisory; operator-owned files are never overwritten implicitly.',
        diagnostic.path ? { path: diagnostic.path } : undefined,
      ));
    }
  }

  const outcome = classifyOutcome(findings, restartRequired);
  const indexFailed = findings.some((item) => item.id.startsWith('index-'));
  const contextFailed = findings.some((item) => item.id.startsWith('context-') && item.severity === 'blocking');
  const deployFailed = findings.some((item) =>
    item.severity === 'blocking'
      && (item.id.startsWith('deployment-') || item.id === 'provider-unknown' || item.id === 'provider-artifacts-missing' || item.id.startsWith('registry-'))
  );
  const phases: DeploymentPhaseResult[] = [
    phase('resolve', 'passed', true, `Resolved ${options.projectRoot}, ${normalized}, ${options.scope} scope.`),
    phase('deploy', deployFailed ? 'failed' : 'passed', true, deployFailed ? 'Deployment invariants failed.' : 'Provider artifacts and installed state verified.', { counts }),
    phase('index', indexFailed ? 'failed' : 'passed', true, indexFailed ? 'Capability index verification failed.' : 'Capability index is readable, current, and contains the requested surface.'),
    phase('context', options.contextOptOut ? 'skipped' : contextFailed ? 'failed' : 'passed', !options.contextOptOut, options.contextOptOut ? 'Context generation was explicitly suppressed.' : contextFailed ? 'Canonical context verification failed.' : 'Canonical context and provider wiring verified.'),
    phase('verify', outcome === 'failed' ? 'failed' : 'passed', true, `${findings.filter((item) => item.severity === 'blocking').length} blocking and ${findings.filter((item) => item.severity === 'advisory').length} advisory finding(s).`),
    phase('report', 'passed', true, `Final provider outcome: ${outcome}.`),
  ];

  return {
    provider: normalized,
    scope: options.scope,
    outcome,
    restartRequired,
    restartAction,
    restartReason,
    counts,
    phases,
    findings,
  };
}

export function buildDryRunUseResult(options: {
  projectRoot: string;
  frameworkRoot: string;
  providers: string[];
  scope: DeploymentScope;
  requestedBundles: string[];
  contextOptOut?: boolean;
}): UseDeploymentResult {
  const providers = options.providers.map((provider) => {
    const normalized = normalizeProviderDefinitionId(provider) ?? provider;
    const restartNotice = RESTART_NOTICES[normalized] ?? null;
    const restartAction = restartNotice?.action ?? null;
    const phases: DeploymentPhaseResult[] = [
      phase('resolve', 'planned', true, `Would resolve ${options.projectRoot}, ${normalized}, ${options.scope} scope.`),
      phase('deploy', 'planned', true, 'Would deploy the requested managed artifact surface.'),
      phase('index', 'planned', true, 'Would refresh and verify the framework capability index.'),
      phase('context', options.contextOptOut ? 'skipped' : 'planned', !options.contextOptOut, options.contextOptOut ? 'Context generation explicitly suppressed.' : 'Would generate and verify canonical context and provider wiring.'),
      phase('verify', 'planned', true, 'Would run scoped deployment verification.'),
      phase('report', 'planned', true, 'Would report a stable final outcome.'),
    ];
    return {
      provider: normalized,
      scope: options.scope,
      outcome: 'planned' as const,
      restartRequired: restartAction !== null,
      restartAction,
      restartReason: restartNotice?.reason ?? null,
      counts: emptyCounts(),
      phases,
      findings: [],
    };
  });
  return {
    schema: 'aiwg.use.result.v1',
    generatedAt: new Date().toISOString(),
    projectRoot: path.resolve(options.projectRoot),
    frameworkRoot: path.resolve(options.frameworkRoot),
    scope: options.scope,
    requestedBundles: options.requestedBundles,
    dryRun: true,
    providers,
    phases: providers[0]?.phases ?? [],
    findings: [],
    outcome: 'planned',
    restartRequired: providers.some((provider) => provider.restartRequired),
    discovery: frameworkDiscoveryInventory(options.frameworkRoot),
    exitClassification: 'preview',
    exitCode: 0,
  };
}

export function aggregateUseDeploymentResult(options: {
  projectRoot: string;
  frameworkRoot: string;
  scope: DeploymentScope;
  requestedBundles: string[];
  providers: ProviderDeploymentVerification[];
}): UseDeploymentResult {
  const findings = options.providers.flatMap((provider) => provider.findings);
  const hasFailed = options.providers.some((provider) => provider.outcome === 'failed');
  const hasDegraded = options.providers.some((provider) => provider.outcome === 'degraded');
  const restartRequired = options.providers.some((provider) => provider.restartRequired);
  const outcome: DeploymentOutcome = hasFailed
    ? 'failed'
    : hasDegraded
      ? 'degraded'
      : restartRequired
        ? 'ready-restart-required'
        : 'ready';
  const phaseIds: DeploymentPhaseResult['id'][] = ['resolve', 'deploy', 'index', 'context', 'verify', 'report'];
  const phases = phaseIds.map((id) => {
    const matching = options.providers.map((provider) => provider.phases.find((item) => item.id === id)).filter((item): item is DeploymentPhaseResult => Boolean(item));
    const state: DeploymentPhaseState = matching.some((item) => item.state === 'failed')
      ? 'failed'
      : matching.every((item) => item.state === 'skipped')
        ? 'skipped'
        : 'passed';
    return phase(
      id,
      state,
      matching.some((item) => item.required),
      `${matching.filter((item) => item.state === 'passed').length}/${matching.length} provider result(s) passed.`,
      { providers: matching.map((item, index) => ({ provider: options.providers[index]?.provider, state: item.state })) },
    );
  });
  return {
    schema: 'aiwg.use.result.v1',
    generatedAt: new Date().toISOString(),
    projectRoot: path.resolve(options.projectRoot),
    frameworkRoot: path.resolve(options.frameworkRoot),
    scope: options.scope,
    requestedBundles: options.requestedBundles,
    dryRun: false,
    providers: options.providers,
    phases,
    findings,
    outcome,
    restartRequired,
    discovery: frameworkDiscoveryInventory(options.frameworkRoot),
    exitClassification: hasFailed ? 'failure' : hasDegraded ? 'degraded' : 'success',
    exitCode: hasFailed ? 1 : 0,
  };
}

export async function verifyConfiguredDeployments(
  projectRoot: string,
  filters: { provider?: string; bundle?: string; scope?: DeploymentScope } = {},
  frameworkRoot = process.env.AIWG_ROOT || projectRoot,
): Promise<UseDeploymentResult> {
  const config = await readAiwgConfig(projectRoot);
  const userRegistry = filters.scope === 'user' ? await readUserRegistry() : null;
  const installed = userRegistry?.installed ?? config?.installed ?? {};
  const registeredProviders = [...new Set(
    Object.values(installed).flatMap((entry) => Object.keys(entry.deployedTo ?? {})),
  )];
  const providers = filters.provider
    ? [filters.provider]
    : filters.scope === 'user'
      ? registeredProviders
      : config?.providers?.length ? config.providers : registeredProviders;
  const bundles = filters.bundle ? [filters.bundle] : Object.keys(installed);
  const results: ProviderDeploymentVerification[] = [];
  for (const provider of providers) {
    const providerBundles = bundles.filter((bundle) => Boolean(installed[bundle]?.deployedTo[provider]));
    if (providerBundles.length === 0) continue;
    results.push(await verifyProviderDeployment({
      projectRoot,
      frameworkRoot,
      provider,
      scope: filters.scope ?? 'project',
      requestedBundles: providerBundles,
    }));
  }
  if (results.length === 0) {
    const fallback = providers[0] ?? 'generic';
    results.push({
      provider: fallback,
      scope: filters.scope ?? 'project',
      outcome: 'failed',
      restartRequired: false,
      restartAction: null,
      restartReason: null,
      counts: emptyCounts(),
      phases: [phase('verify', 'failed', true, 'No installed provider deployment could be resolved.')],
      findings: [finding(fallback, 'deployment-not-configured', 'blocking', 'No installed provider deployment could be resolved.', 'Run aiwg use all --provider <provider>.')],
    });
  }
  return aggregateUseDeploymentResult({ projectRoot, frameworkRoot, scope: filters.scope ?? 'project', requestedBundles: bundles, providers: results });
}

export async function buildDeploymentStatusProbe(
  projectRoot: string,
  frameworkRoot = process.env.AIWG_ROOT || projectRoot,
  filters: { provider?: string; bundle?: string; scope?: DeploymentScope } = {},
): Promise<Record<string, unknown>> {
  const result = await verifyConfiguredDeployments(projectRoot, filters, frameworkRoot);
  const notConfigured = result.requestedBundles.length === 0
    && result.findings.length > 0
    && result.findings.every((item) => item.id === 'deployment-not-configured');
  const engaged = result.outcome === 'ready' || result.outcome === 'ready-restart-required' || result.outcome === 'degraded';
  return {
    schema: 'aiwg.status.probe.v1',
    generated_at: result.generatedAt,
    project_root: result.projectRoot,
    engaged,
    status: notConfigured ? 'not-configured' : result.outcome === 'failed' ? 'needs-repair' : result.outcome,
    checks: {
      workspace_exists: await exists(path.join(projectRoot, '.aiwg')),
      framework_count: result.requestedBundles.length,
      provider_deployment_count: notConfigured ? 0 : result.providers.length,
      health: notConfigured ? 'not-configured' : result.outcome === 'failed' ? 'error' : result.outcome === 'degraded' ? 'warning' : 'healthy',
      malformed_config: result.findings.some((item) => item.id.includes('registry')),
      artifact_health: notConfigured ? 'not-configured' : result.outcome,
      external_artifact_reachable: true,
    },
    verification: {
      required: true,
      action: engaged
        ? 'AIWG deployment is verified on disk.'
        : notConfigured
          ? 'Choose a provider and bundle to configure AIWG for this project.'
          : 'Repair the blocking deployment findings, then run this probe again.',
      command: 'aiwg status --probe --json',
      next_command: engaged ? null : notConfigured ? 'aiwg wizard --dry-run' : 'aiwg doctor --deployment',
    },
    provider_deployments: result.providers,
    deployment_verification: result,
  };
}

export interface RenderUseDeploymentOptions {
  verbose?: boolean;
  width?: number;
  version?: { version: string; repository: string };
  nextSteps?: string[];
}

const DEPLOYED_COUNT_LABELS: Readonly<Record<keyof ProviderDeploymentVerification['counts'], string>> = {
  agents: 'Agents',
  commands: 'Commands',
  skills: 'Skills',
  rules: 'Rules',
  behaviors: 'Behaviors',
};

function displayProvider(provider: string): string {
  const definition = getProviderDefinition(provider);
  return definition ? `${definition.displayName} (${provider})` : provider;
}

function wrapTokens(tokens: string[], width: number, indent = '    '): string[] {
  if (tokens.length === 0) return [`${indent}None`];
  const max = Math.max(24, width - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line ? `${line}  ·  ${token}` : token;
    if (line && candidate.length > max) {
      lines.push(indent + line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

function wrapParagraph(text: string, width: number, indent = '    '): string[] {
  const max = Math.max(24, width - indent.length);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > max) {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

function outcomeHeading(result: UseDeploymentResult): string {
  if (result.outcome === 'ready') return 'AIWG ready';
  if (result.outcome === 'ready-restart-required') return 'AIWG ready — provider reload required';
  if (result.outcome === 'degraded') return 'AIWG ready with advisories';
  return 'AIWG needs repair';
}

export function renderUseDeploymentResult(
  result: UseDeploymentResult,
  options: RenderUseDeploymentOptions = {},
): string {
  if (result.dryRun) {
    const providers = result.providers.map((provider) => provider.provider).join(', ');
    return `Deployment preview: ${result.requestedBundles.join(', ')} for ${providers}\nNo files were changed and no verification pass is claimed.`;
  }

  const width = Math.max(60, Math.min(160, Math.floor(options.width ?? 100)));
  const lines = ['', outcomeHeading(result)];
  for (const provider of result.providers) {
    lines.push('', `Deployed to ${displayProvider(provider.provider)}`);
    lines.push(...wrapTokens(
      Object.entries(DEPLOYED_COUNT_LABELS).map(([type, label]) =>
        `${label} ${provider.counts[type as keyof typeof provider.counts].toLocaleString('en-US')}`),
      width,
    ));
  }

  lines.push('', 'Indexed for discovery');
  if (result.discovery) {
    lines.push(`    ${result.discovery.totalArtifacts.toLocaleString('en-US')} artifacts · ${result.discovery.graph} graph`);
    lines.push(...wrapTokens(
      Object.entries(result.discovery.byType).map(([type, count]) =>
        `${type} ${count.toLocaleString('en-US')}`),
      width,
    ));
  } else {
    lines.push('    Unavailable — the framework index could not be read.');
  }

  const visibleFindings = result.findings.filter((candidate) => candidate.severity !== 'info');
  if (visibleFindings.length > 0) {
    lines.push('', result.outcome === 'failed' ? 'Blocking findings' : 'Advisories');
    for (const item of visibleFindings) {
      lines.push(...wrapParagraph(`${item.provider}: ${item.message}`, width));
      if (item.remediation) lines.push(...wrapParagraph(`Fix: ${item.remediation}`, width, '      '));
    }
  }

  if (options.verbose) {
    lines.push('', 'Verification details');
    for (const provider of result.providers) {
      for (const item of provider.phases) {
        lines.push(...wrapParagraph(`${provider.provider}/${item.id}: ${item.state} — ${item.summary}`, width));
      }
      if (provider.restartReason) {
        lines.push(...wrapParagraph(`${provider.provider} reload rationale: ${provider.restartReason}`, width));
      }
    }
    if (result.discovery) {
      lines.push(...wrapParagraph(`Framework index built: ${result.discovery.builtAt}`, width));
    }
  }

  const restartActions = result.providers
    .filter((provider) => provider.restartRequired && provider.restartAction)
    .map((provider) => provider.restartAction as string);
  const next = options.nextSteps?.length
    ? options.nextSteps
    : result.outcome === 'failed'
      ? ['Repair the blocking findings above, then run the same aiwg use command again.']
      : restartActions.length > 0
        ? [...restartActions, 'Ask your AI tool to verify AIWG and recommend one useful next action.']
        : ['Ask your AI tool to verify AIWG and recommend one useful next action.'];
  lines.push('', 'Next');
  for (const step of next) lines.push(...wrapParagraph(step, width));

  if (options.version) {
    lines.push('', ...wrapParagraph(`AIWG v${options.version.version} · ${options.version.repository}`, width, '  '));
  }

  return lines.join('\n');
}
