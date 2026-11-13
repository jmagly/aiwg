/**
 * Ralph External Process Launcher
 *
 * Spawns the external Ralph supervisor as a detached background process
 * that survives terminal closure and can be managed across sessions.
 *
 * @implements @.aiwg/working/issue-ralph-external-completion.md
 * @issue #275
 * @security docs/ralph-external-security.md
 *
 * SECURITY WARNING
 * ================
 * This module launches Claude Code sessions with --dangerously-skip-permissions.
 * Spawned sessions can read/write ANY file and execute ANY command without
 * user confirmation. Sessions run as detached daemons for extended periods
 * without human oversight.
 *
 * BEFORE USING:
 * - Read docs/ralph-external-security.md
 * - Understand all security implications
 * - Set appropriate limits (budget, iterations, timeout)
 * - Ensure clean git state for rollback capability
 * - Have monitoring and abort procedures ready
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync,
  statSync, openSync, readSync, closeSync,
} from 'fs';
import { getProviderConfig } from '../agent-spawn.js';
import { AiwgError, EXIT_CODES } from '../errors.js';
import { projectAiwgPath } from '../../config/project-artifacts.js';

/** Wall budget for capturing a managed Ralph child's stable identity (#4153). */
export const MANAGED_IDENTITY_BUDGET_MS = 2000;

/**
 * Options for launching an external agent loop
 */
export interface RalphLaunchOptions {
  objective: string;
  completionCriteria: string;
  maxIterations?: number;
  model?: string;
  budget?: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxTotalCost?: number;
  maxWallClockMinutes?: number;
  explorationQuota?: number;
  budgetStopPolicy?: 'completion-wins' | 'budget-wins';
  timeout?: number;
  mcpConfig?: string;
  giteaIssue?: boolean;
  memory?: number | string;
  crossTask?: boolean;
  enableAnalytics?: boolean;
  enableBestOutput?: boolean;
  enableEarlyStopping?: boolean;
  loopId?: string;
  force?: boolean;
  provider?: string;
  /** Enable dangerous/unrestricted mode — passed to the orchestrator via env + flag */
  dangerous?: boolean;
  /** Raw args to append verbatim to the agent invocation inside the loop */
  params?: string;
  /** Enable verbose per-iteration detail (assessment, strategy, prompt preview) */
  verbose?: boolean;
  /** Write timestamped log to this file path (in addition to daemon-output.log) */
  logFile?: string;
  /** Current managed reservation; absent on direct and legacy launches. */
  managedAdmission?: { requestId: string; generation: number };
  /** Qualified one-shot execution; completion remains owned by the parent. */
  managedWorker?: { invocationPath: string; runDir: string };
}

/**
 * Result from launching a agent loop
 */
export interface RalphLaunchResult {
  success: boolean;
  loopId: string;
  pid: number;
  message: string;
  registryPath: string;
  execution?: { pid: number; startedAt: string };
}

/**
 * Registry entry for a running loop
 */
export interface LoopRegistryEntry {
  loopId: string;
  pid: number;
  objective: string;
  completionCriteria: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  lastUpdate: string;
  iteration: number;
  maxIterations: number;
  outputFile: string;
  sessionStdoutFile?: string;
  sessionStderrFile?: string;
  promptFile?: string;
  provider?: string;
  managedAdmission?: { requestId: string; generation: number; execution?: { pid: number; startedAt: string }; processIdentity?: Record<string, unknown> };
  managedWorker?: { invocationPath: string; runDir: string };
}

/**
 * Get the path to the external Ralph orchestrator
 */
export function getOrchestratorPath(frameworkRoot: string): string {
  return join(frameworkRoot, 'tools', 'ralph-external', 'index.mjs');
}

/**
 * Get the registry directory path
 */
export function getRegistryDir(projectRoot: string): string {
  return projectAiwgPath(projectRoot, 'ralph-external');
}

/**
 * Get the registry file path
 */
export function getRegistryPath(projectRoot: string): string {
  return join(getRegistryDir(projectRoot), 'registry.json');
}

/**
 * Generate a unique loop ID
 */
export function generateLoopId(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const shortId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `ralph-${slug}-${shortId}`;
}

/**
 * Build command-line arguments for the external Ralph process
 */
export function buildArgs(options: RalphLaunchOptions): string[] {
  if (options.managedWorker) {
    if (!options.managedAdmission) throw new Error('Managed worker execution requires admission');
    return ['--launch-worker', '--invocation', options.managedWorker.invocationPath,
      '--run-dir', options.managedWorker.runDir, '--managed-request', options.managedAdmission.requestId,
      '--managed-generation', String(options.managedAdmission.generation)];
  }
  const args: string[] = [options.objective];

  args.push('--completion', options.completionCriteria);

  if (options.maxIterations) {
    args.push('--max-iterations', String(options.maxIterations));
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.budget) {
    args.push('--budget', String(options.budget));
  }
  if (options.maxTotalTokens) {
    args.push('--max-total-tokens', String(options.maxTotalTokens));
  }
  if (options.maxOutputTokens) {
    args.push('--max-output-tokens', String(options.maxOutputTokens));
  }
  if (options.maxToolCalls) {
    args.push('--max-tool-calls', String(options.maxToolCalls));
  }
  if (options.maxTotalCost) {
    args.push('--max-total-cost', String(options.maxTotalCost));
  }
  if (options.maxWallClockMinutes) {
    args.push('--max-wall-clock-minutes', String(options.maxWallClockMinutes));
  }
  if (options.explorationQuota) {
    args.push('--exploration-quota', String(options.explorationQuota));
  }
  if (options.budgetStopPolicy) {
    args.push('--budget-stop-policy', options.budgetStopPolicy);
  }
  if (options.timeout) {
    args.push('--timeout', String(options.timeout));
  }
  if (options.mcpConfig) {
    args.push('--mcp-config', options.mcpConfig);
  }
  if (options.giteaIssue) {
    args.push('--gitea-issue');
  }
  if (options.memory !== undefined) {
    args.push('--memory', String(options.memory));
  }
  if (options.crossTask === false) {
    args.push('--no-cross-task');
  }
  if (options.enableAnalytics === false) {
    args.push('--no-analytics');
  }
  if (options.enableBestOutput === false) {
    args.push('--no-best-output');
  }
  if (options.enableEarlyStopping === false) {
    args.push('--no-early-stopping');
  }
  if (options.provider && options.provider !== 'claude') {
    args.push('--provider', options.provider);
  }
  if (options.dangerous) {
    args.push('--dangerous');
  }
  if (options.params) {
    args.push('--params', options.params);
  }
  if (options.verbose) {
    args.push('--verbose');
  }
  if (options.logFile) {
    args.push('--log-file', options.logFile);
  }

  return args;
}

/**
 * Enforce `parallelism.max_parallel_ralph_loops` from `.aiwg/aiwg.config`.
 * Hard-fails (throws AiwgError) when the count of running + live Ralph loops
 * already meets or exceeds the cap. Non-fatal when no config or config read
 * fails — caller proceeds with launch.
 *
 * Extracted so the cap-check logic is unit-testable independently of the
 * detached-process spawn machinery.
 *
 * @implements #1361
 */
export async function assertRalphParallelismCap(projectRoot: string): Promise<void> {
  let cfg: Awaited<ReturnType<typeof import('../../config/aiwg-config.js').readAiwgConfig>>;
  let resolveParallelism: typeof import('../../config/aiwg-config.js').resolveParallelism;
  try {
    const mod = await import('../../config/aiwg-config.js');
    resolveParallelism = mod.resolveParallelism;
    cfg = await mod.readAiwgConfig(projectRoot);
  } catch {
    return; // Config unreadable — non-fatal, let launch proceed
  }
  if (!cfg) return;

  const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
  const launcherRegistry = loadLauncherRegistry(projectRoot);
  const activeCount = Object.values(launcherRegistry.loops).filter(
    (l) => l.status === 'running' && isProcessAlive(l.pid),
  ).length;
  if (activeCount >= resolved.max_parallel_ralph_loops) {
    throw new AiwgError({
      code: 'ERR_RALPH_PARALLELISM_CAP',
      message: `Project parallelism cap reached: ${activeCount}/${resolved.max_parallel_ralph_loops} Ralph loops already running.`,
      hint: `Wait for an existing loop to finish ('aiwg ralph-status'), or bump the cap ('aiwg config set --project parallelism.max_parallel_ralph_loops N').`,
      exitCode: EXIT_CODES.GENERAL,
    });
  }
}

/**
 * Launch the external Ralph process as a detached daemon
 */
export async function launchExternalRalph(
  frameworkRoot: string,
  projectRoot: string,
  options: RalphLaunchOptions
): Promise<RalphLaunchResult> {
  const orchestratorPath = options.managedWorker
    ? join(frameworkRoot, 'tools', 'ralph-external', 'session-launcher.mjs')
    : getOrchestratorPath(frameworkRoot);

  if (!existsSync(orchestratorPath)) {
    throw new AiwgError({
      code: 'ERR_RALPH_ORCHESTRATOR_MISSING',
      message: `External Ralph orchestrator not found at: ${orchestratorPath}`,
      hint: 'Run `aiwg use ralph` to deploy the orchestrator, or `npm run build` in the dev repo',
      exitCode: EXIT_CODES.GENERAL,
    });
  }

  const registryDir = getRegistryDir(projectRoot);
  mkdirSync(registryDir, { recursive: true });

  // #1361: Enforce project-level max_parallel_ralph_loops cap. Hard fail
  // (not queue) — Ralph loops are long-running, silent queueing would be
  // surprising. Tell the operator what's running and how to lift the cap.
  await assertRalphParallelismCap(projectRoot);

  const loopId = options.loopId || generateLoopId(options.objective);
  if (loadLauncherRegistry(projectRoot).loops[loopId]?.managedAdmission) {
    throw new Error('Managed loop identity cannot be relaunched before admission reconciliation');
  }
  const loopDir = join(registryDir, 'loops', loopId);
  mkdirSync(loopDir, { recursive: true });

  // Create output file for the detached process
  const outputFile = join(loopDir, 'daemon-output.log');
  const sessionStdoutFile = join(loopDir, 'outputs', '001-stdout.log');
  const sessionStderrFile = join(loopDir, 'outputs', '001-stderr.log');
  const promptFile = join(loopDir, 'prompts', '001-prompt.md');

  // Build arguments
  const args = buildArgs(options);

  if (options.managedAdmission) {
    const registry = loadLauncherRegistry(projectRoot);
    registry.loops[loopId] = { loopId, pid: 0, objective: options.objective,
      completionCriteria: options.completionCriteria, status: 'running',
      startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString(),
      iteration: 0, maxIterations: options.managedWorker ? 1 : options.maxIterations || 5, outputFile,
      sessionStdoutFile, sessionStderrFile, promptFile, provider: options.provider,
      managedAdmission: { ...options.managedAdmission },
      ...(options.managedWorker ? { managedWorker: { ...options.managedWorker } } : {}) };
    saveLauncherRegistry(projectRoot, registry);
  }

  // Create output file descriptors
  const { openSync, closeSync } = await import('fs');
  const outFd = openSync(outputFile, 'w');

  // Spawn detached process
  const child: ChildProcess = spawn('node', [orchestratorPath, ...args], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd: projectRoot,
    env: {
      ...process.env,
      RALPH_LOOP_ID: loopId,
      RALPH_DETACHED: 'true',
      ...(options.provider ? { RALPH_PROVIDER: options.provider } : {}),
      ...(options.dangerous ? {
        RALPH_DANGEROUS: 'true',
        RALPH_DANGEROUS_FLAG: getProviderConfig(options.provider ?? 'claude').dangerousFlag ?? '',
      } : {}),
      ...(options.params ? { RALPH_EXTRA_PARAMS: options.params } : {}),
    },
  });

  // Detach from parent - let it run independently
  child.unref();
  closeSync(outFd);

  const pid = child.pid;
  if (!pid) {
    throw new AiwgError({
      code: 'ERR_RALPH_SPAWN_FAILED',
      message: 'Failed to start external Ralph process — no PID returned by spawn',
      hint: 'Check system resources (ulimit -u) and that `node` is on PATH',
      exitCode: EXIT_CODES.GENERAL,
    });
  }

  let managedAdmission: LoopRegistryEntry['managedAdmission'];
  if (options.managedAdmission) {
    const { sampleWorkerIdentity, createWorkerIdentityCapture } = await import(join(frameworkRoot, 'tools', 'ralph-external', 'process-monitor.mjs'));
    // Two stable samples are needed. A loaded host can delay the 10 ms poll by
    // hundreds of milliseconds, so a 250 ms window failed healthy launches
    // (#4153). The child's own exit is checked every pass, so a wider window
    // cannot bind a reused PID.
    const capture = createWorkerIdentityCapture({ timeoutMs: MANAGED_IDENTITY_BUDGET_MS });
    const identityDeadline = process.hrtime.bigint() + BigInt(MANAGED_IDENTITY_BUDGET_MS) * 1_000_000n;
    let identity;
    while (!identity && process.hrtime.bigint() < identityDeadline) {
      if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) break;
      identity = capture.observe(sampleWorkerIdentity(pid, { includeExited: true }));
      if (!identity) await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!identity?.bootId || !identity.startTicks || !Number.isSafeInteger(identity.uid)) {
      throw new Error('managed Ralph execution identity unavailable; reconcile uncertain launch');
    }
    managedAdmission = { ...options.managedAdmission,
      execution: { pid, startedAt: `${identity.bootId}:${identity.startTicks}:${identity.uid}` }, processIdentity: identity };
  }

  // Record the loop in our launcher registry (backup to the external-multi-loop-state-manager)
  const launcherRegistry = loadLauncherRegistry(projectRoot);
  launcherRegistry.loops[loopId] = {
    loopId,
    pid,
    objective: options.objective,
    completionCriteria: options.completionCriteria,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    iteration: 0,
    maxIterations: options.managedWorker ? 1 : options.maxIterations || 5,
    outputFile,
    sessionStdoutFile,
    sessionStderrFile,
    promptFile,
    provider: options.provider,
    ...(managedAdmission ? { managedAdmission } : {}),
    ...(options.managedWorker ? { managedWorker: { ...options.managedWorker } } : {}),
  };
  saveLauncherRegistry(projectRoot, launcherRegistry);

  return {
    success: true,
    loopId,
    pid,
    message: `agent loop started (${loopId}). Check status: aiwg ralph-status`,
    registryPath: getRegistryPath(projectRoot),
    ...(managedAdmission ? { execution: managedAdmission.execution } : {}),
  };
}

/**
 * Launcher's own registry (supplement to external-multi-loop-state-manager)
 */
export interface LauncherRegistry {
  version: string;
  loops: Record<string, LoopRegistryEntry>;
  updatedAt: string;
}

/**
 * Load the launcher registry
 */
export function loadLauncherRegistry(projectRoot: string): LauncherRegistry {
  const registryPath = join(getRegistryDir(projectRoot), 'launcher-registry.json');

  if (!existsSync(registryPath)) {
    return {
      version: '1.0.0',
      loops: {},
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    return {
      version: '1.0.0',
      loops: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Save the launcher registry
 */
export function saveLauncherRegistry(projectRoot: string, registry: LauncherRegistry): void {
  const registryDir = getRegistryDir(projectRoot);
  mkdirSync(registryDir, { recursive: true });

  const registryPath = join(registryDir, 'launcher-registry.json');
  registry.updatedAt = new Date().toISOString();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Check if a process is still running
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get status of all agent loops.
 * Detects stale entries (>24h without heartbeat) and auto-cleans completed entries.
 */
export function getLoopStatuses(
  projectRoot: string,
  options: { autoCleanCompleted?: boolean } = {}
): LoopRegistryEntry[] {
  const registry = loadLauncherRegistry(projectRoot);
  const statuses: LoopRegistryEntry[] = [];
  const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
  let registryDirty = false;

  for (const [loopId, entry] of Object.entries(registry.loops)) {
    // Update status based on process liveness
    if (entry.status === 'running' && !isProcessAlive(entry.pid)) {
      // Process died - mark as failed unless we can determine it completed
      const stateFile = join(getRegistryDir(projectRoot), 'loops', loopId, 'session-state.json');
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf8'));
          entry.status = state.status || 'failed';
          entry.iteration = state.currentIteration || entry.iteration;
        } catch {
          entry.status = 'failed';
        }
      } else {
        entry.status = 'failed';
      }
      registryDirty = true;
    }

    // Detect stale entries (>24h since last update)
    const lastUpdateAge = Date.now() - new Date(entry.lastUpdate).getTime();
    if (lastUpdateAge > staleThresholdMs && entry.status === 'running') {
      (entry as LoopRegistryEntry & { stale?: boolean }).stale = true;
    }

    // Auto-clean completed entries if requested
    if (options.autoCleanCompleted && !entry.managedAdmission && (entry.status === 'completed')) {
      cleanupCompletedLoop(projectRoot, loopId);
      registryDirty = true;
      continue; // Don't include in statuses
    }

    statuses.push(entry);
  }

  if (registryDirty) {
    saveLauncherRegistry(projectRoot, registry);
  }

  return statuses;
}

/**
 * Abort a running agent loop by killing its process
 */
export function abortLoop(projectRoot: string, loopId?: string): { success: boolean; message: string } {
  const registry = loadLauncherRegistry(projectRoot);

  // If no loopId specified, find the most recent running loop
  if (!loopId) {
    const runningLoops = Object.values(registry.loops)
      .filter((l) => l.status === 'running' && isProcessAlive(l.pid))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (runningLoops.length === 0) {
      return { success: false, message: 'No running agent loops found' };
    }
    loopId = runningLoops[0].loopId;
  }

  const entry = registry.loops[loopId];
  if (!entry) {
    return { success: false, message: `Loop not found: ${loopId}` };
  }

  if (entry.managedAdmission) return { success: false, message: 'Managed loop cancellation requires its current admission generation' };

  if (!isProcessAlive(entry.pid)) {
    entry.status = 'aborted';
    saveLauncherRegistry(projectRoot, registry);
    return { success: true, message: `Loop ${loopId} was already stopped` };
  }

  try {
    process.kill(entry.pid, 'SIGTERM');
    entry.status = 'aborted';
    entry.lastUpdate = new Date().toISOString();
    saveLauncherRegistry(projectRoot, registry);
    return { success: true, message: `Aborted loop ${loopId} (PID: ${entry.pid})` };
  } catch (error) {
    return {
      success: false,
      message: `Failed to kill process ${entry.pid}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Signal only the birth identity bound to this current managed reservation.
 * Native Ralph exit/status cannot prove descendant termination, so cancellation
 * always leaves its admission reservation uncertain for explicit reconciliation.
 */
export async function cancelManagedRalph(
  frameworkRoot: string, projectRoot: string, loopId: string,
  binding: { requestId: string; generation: number; execution: { pid: number; startedAt: string } },
): Promise<{ state: 'uncertain'; signalled: boolean }> {
  const entry = loadLauncherRegistry(projectRoot).loops[loopId];
  const owned = entry?.managedAdmission;
  if (!owned?.execution || !owned.processIdentity || owned.requestId !== binding.requestId || owned.generation !== binding.generation
    || owned.execution.pid !== binding.execution.pid || owned.execution.startedAt !== binding.execution.startedAt) {
    return { state: 'uncertain', signalled: false };
  }
  const { sampleWorkerIdentity } = await import(join(frameworkRoot, 'tools', 'ralph-external', 'process-monitor.mjs'));
  const identity = sampleWorkerIdentity(owned.execution.pid);
  const expected = owned.processIdentity;
  if (!identity || ['pid', 'uid', 'bootId', 'startTicks', 'executable', 'pgid', 'sessionId']
    .some(key => identity[key] !== expected[key])) return { state: 'uncertain', signalled: false };
  const { signalOwnedWorker } = await import(join(frameworkRoot, 'tools', 'ralph-external', 'session-launcher.mjs'));
  return { state: 'uncertain', signalled: signalOwnedWorker(identity, 'SIGTERM') };
}

/**
 * Resume an interrupted agent loop
 */
export async function resumeLoop(
  frameworkRoot: string,
  projectRoot: string,
  loopId?: string,
  overrides?: { maxIterations?: number }
): Promise<RalphLaunchResult> {
  const orchestratorPath = getOrchestratorPath(frameworkRoot);

  if (!existsSync(orchestratorPath)) {
    throw new AiwgError({
      code: 'ERR_RALPH_ORCHESTRATOR_MISSING',
      message: `External Ralph orchestrator not found at: ${orchestratorPath}`,
      hint: 'Run `aiwg use ralph` to deploy the orchestrator',
      exitCode: EXIT_CODES.GENERAL,
    });
  }

  // Build resume arguments
  const args = ['--resume'];
  if (overrides?.maxIterations) {
    args.push('--max-iterations', String(overrides.maxIterations));
  }

  const registryDir = getRegistryDir(projectRoot);
  mkdirSync(registryDir, { recursive: true });

  // Find loop to resume
  const registry = loadLauncherRegistry(projectRoot);
  let targetLoopId = loopId;

  if (!targetLoopId) {
    // Find most recent non-running loop
    const resumable = Object.values(registry.loops)
      .filter((l) => l.status !== 'running' || !isProcessAlive(l.pid))
      .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());

    if (resumable.length === 0) {
      throw new AiwgError({
        code: 'ERR_RALPH_NO_RESUMABLE',
        message: 'No loops available to resume',
        hint: 'Start a new loop with: aiwg ralph "<objective>"',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    targetLoopId = resumable[0].loopId;
  }

  const entry = registry.loops[targetLoopId];
  if (!entry) {
    throw new AiwgError({
      code: 'ERR_RALPH_LOOP_NOT_FOUND',
      message: `Loop not found: ${targetLoopId}`,
      hint: 'List available loops with: aiwg ralph-status',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (entry.managedAdmission) throw new Error('Managed loops require policy and admission reconciliation before resume');

  const loopDir = join(registryDir, 'loops', targetLoopId);
  const outputFile = join(loopDir, 'daemon-output.log');

  // Create output file descriptor
  const { openSync, closeSync } = await import('fs');
  const outFd = openSync(outputFile, 'a'); // Append mode for resume

  // Spawn detached process
  const child: ChildProcess = spawn('node', [orchestratorPath, ...args], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd: projectRoot,
    env: {
      ...process.env,
      RALPH_LOOP_ID: targetLoopId,
      RALPH_DETACHED: 'true',
    },
  });

  child.unref();
  closeSync(outFd);

  const pid = child.pid;
  if (!pid) {
    throw new AiwgError({
      code: 'ERR_RALPH_SPAWN_FAILED',
      message: 'Failed to start external Ralph process — no PID returned by spawn',
      hint: 'Check system resources (ulimit -u) and that `node` is on PATH',
      exitCode: EXIT_CODES.GENERAL,
    });
  }

  // Update registry
  entry.pid = pid;
  entry.status = 'running';
  entry.lastUpdate = new Date().toISOString();
  if (overrides?.maxIterations) {
    entry.maxIterations = overrides.maxIterations;
  }
  saveLauncherRegistry(projectRoot, registry);

  return {
    success: true,
    loopId: targetLoopId,
    pid,
    message: `Resumed agent loop (${targetLoopId}). Check status: aiwg ralph-status`,
    registryPath: getRegistryPath(projectRoot),
  };
}

/**
 * Clean up a completed loop: remove from launcher-registry and delete working state.
 * Preserves completion reports by moving them to the ralph-external root before deletion.
 *
 * @param projectRoot - Project root directory
 * @param loopId - Loop ID to clean up
 * @param options - Cleanup options
 * @returns Object with success status and details
 */
export function cleanupCompletedLoop(
  projectRoot: string,
  loopId: string,
  options: { archive?: boolean } = {}
): { success: boolean; message: string; preserved: string[] } {
  const registryDir = getRegistryDir(projectRoot);
  const loopDir = join(registryDir, 'loops', loopId);
  const preserved: string[] = [];
  if (loadLauncherRegistry(projectRoot).loops[loopId]?.managedAdmission) {
    return { success: false, message: 'Managed loop artifacts require admission reconciliation before cleanup', preserved };
  }

  // Preserve completion reports before deleting the loop directory
  if (existsSync(loopDir)) {
    try {
      const files = readdirSync(loopDir);
      for (const file of files) {
        if (file.startsWith('completion-') && file.endsWith('.md')) {
          const dest = join(registryDir, file);
          copyFileSync(join(loopDir, file), dest);
          preserved.push(dest);
        }
      }
    } catch {
      // Non-fatal: proceed with cleanup even if report preservation fails
    }

    if (options.archive) {
      // Move to archive instead of deleting
      const archiveDir = join(registryDir, 'archive', loopId);
      mkdirSync(join(registryDir, 'archive'), { recursive: true });
      try {
        const { renameSync } = require('fs');
        renameSync(loopDir, archiveDir);
      } catch {
        // If rename fails (cross-device), fall through to deletion
      }
    } else {
      // Delete working state
      try {
        rmSync(loopDir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }

  // Remove entry from launcher registry
  const registry = loadLauncherRegistry(projectRoot);
  if (registry.loops[loopId]) {
    delete registry.loops[loopId];
    saveLauncherRegistry(projectRoot, registry);
  }

  return {
    success: true,
    message: `Cleaned up loop ${loopId}`,
    preserved,
  };
}

/**
 * Clean up internal Ralph state after successful completion.
 * Deletes current-loop.json, heartbeats, and iteration working state.
 * Preserves completion report files.
 *
 * @param projectRoot - Project root directory
 * @returns Object with success status and what was cleaned
 */
export function cleanupInternalRalph(projectRoot: string): {
  success: boolean;
  cleaned: string[];
  preserved: string[];
} {
  const ralphDir = projectAiwgPath(projectRoot, 'ralph');
  const cleaned: string[] = [];
  const preserved: string[] = [];

  if (!existsSync(ralphDir)) {
    return { success: true, cleaned: [], preserved: [] };
  }

  // Check if current-loop.json exists and is completed
  const currentLoopPath = join(ralphDir, 'current-loop.json');
  if (existsSync(currentLoopPath)) {
    try {
      const state = JSON.parse(readFileSync(currentLoopPath, 'utf8'));
      if (state.status === 'completed' || state.status === 'success') {
        rmSync(currentLoopPath, { force: true });
        cleaned.push('current-loop.json');
      }
    } catch {
      // If we can't parse it, leave it alone
    }
  }

  // Clean up heartbeats directory
  const heartbeatsDir = join(ralphDir, 'heartbeats');
  if (existsSync(heartbeatsDir)) {
    try {
      rmSync(heartbeatsDir, { recursive: true, force: true });
      cleaned.push('heartbeats/');
    } catch {
      // Non-fatal
    }
  }

  // Clean up iterations working state (but preserve completion reports)
  const iterationsDir = join(ralphDir, 'iterations');
  if (existsSync(iterationsDir)) {
    try {
      rmSync(iterationsDir, { recursive: true, force: true });
      cleaned.push('iterations/');
    } catch {
      // Non-fatal
    }
  }

  // Log preserved completion reports
  try {
    const files = readdirSync(ralphDir);
    for (const file of files) {
      if (file.startsWith('completion-') && file.endsWith('.md')) {
        preserved.push(file);
      }
    }
  } catch {
    // Non-fatal
  }

  return { success: true, cleaned, preserved };
}

/**
 * Clean up completed/failed loops from registry
 */
export function cleanupRegistry(projectRoot: string, keepDays: number = 7): number {
  const registry = loadLauncherRegistry(projectRoot);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [loopId, entry] of Object.entries(registry.loops)) {
    if (entry.status !== 'running' && !entry.managedAdmission) {
      const lastUpdate = new Date(entry.lastUpdate).getTime();
      if (lastUpdate < cutoff) {
        delete registry.loops[loopId];
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    saveLauncherRegistry(projectRoot, registry);
  }

  return cleaned;
}

/**
 * Attach to a running agent loop's output stream.
 *
 * Tails the loop's daemon-output.log to stdout in real-time.
 * Ctrl+C detaches (the background loop keeps running).
 * Returns a Promise that resolves when the user detaches or the loop exits.
 */
export function attachToLoopOutput(projectRoot: string, loopId?: string): Promise<void> {
  const registry = loadLauncherRegistry(projectRoot);
  const entries = Object.values(registry.loops);

  let entry: LoopRegistryEntry | undefined;

  if (loopId) {
    entry = registry.loops[loopId];
    if (!entry) {
      return Promise.reject(new Error(`Loop not found: ${loopId}`));
    }
  } else {
    // Use most recently started running loop
    const running = entries
      .filter((e) => e.status === 'running' && isProcessAlive(e.pid))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (running.length === 0) {
      return Promise.reject(new Error('No running loops to attach to. Use --loop-id to specify a loop.'));
    }
    entry = running[0];
  }

  const outputFile = entry.outputFile;
  const attachedLoopId = entry.loopId;

  return new Promise<void>((resolve) => {
    let offset = 0;

    // Print any existing content
    try {
      const stats = statSync(outputFile);
      if (stats.size > 0) {
        const fd = openSync(outputFile, 'r');
        const buf = Buffer.alloc(stats.size);
        readSync(fd, buf, 0, stats.size, 0);
        closeSync(fd);
        process.stdout.write(buf);
        offset = stats.size;
      }
    } catch {
      // Log file may not exist yet — will appear shortly
    }

    // Poll for new content every 250 ms. .unref() so the interval cannot
    // outlive the resolve() path and hold the event loop alive.
    const interval = setInterval(() => {
      try {
        const stats = statSync(outputFile);
        if (stats.size > offset) {
          const newBytes = stats.size - offset;
          const fd = openSync(outputFile, 'r');
          const buf = Buffer.alloc(newBytes);
          readSync(fd, buf, 0, newBytes, offset);
          closeSync(fd);
          process.stdout.write(buf);
          offset = stats.size;
        }

        // Stop polling if the process has exited
        if (!isProcessAlive(registry.loops[attachedLoopId]?.pid ?? 0)) {
          clearInterval(interval);
          process.removeListener('SIGINT', onSigint);
          process.stdout.write('\n[ralph-attach] Loop process has exited.\n');
          resolve();
        }
      } catch {
        // File may be temporarily unavailable during rotation — ignore
      }
    }, 250);
    interval.unref?.();

    // Ctrl+C detaches without stopping the loop. Registered with named handler
    // + process.once so we can remove it cleanly on process-exit path and so
    // it does not accumulate across re-attach cycles within a single CLI run.
    const onSigint = () => {
      clearInterval(interval);
      process.stdout.write('\n\nDetached from loop output. Loop continues in background.\n');
      process.stdout.write(`  Status:     aiwg ralph-status\n`);
      process.stdout.write(`  Re-attach:  aiwg ralph-attach --loop-id ${attachedLoopId}\n`);
      process.stdout.write(`  Abort:      aiwg ralph-abort --loop-id ${attachedLoopId}\n`);
      resolve();
    };
    process.once('SIGINT', onSigint);
  });
}
