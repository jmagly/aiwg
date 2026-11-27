/**
 * Parallelism Cap Section — context-file injector
 *
 * Generates the markdown section that surfaces the project's
 * `.aiwg/aiwg.config` `parallelism` cap in regenerated context files
 * (AIWG.md, CLAUDE.md, AGENTS.md). Agents read context at session start;
 * having the cap inline means no extra IO every session.
 *
 * Wrapped in managed-block markers so future regenerations replace the
 * section in-place without disturbing operator additions outside it.
 *
 * Env var `AIWG_HIDE_PARALLELISM_IN_CONTEXT=1` suppresses injection.
 *
 * @implements #1362
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../../cli/find-package-root.js';
import { readAiwgConfigCandidate, validateWorkerConfigCandidate, resolveParallelism, PROVIDER_PARALLELISM_DEFAULTS, type AiwgConfig, type ParallelismConfig, type SetupConfig, type WorkerGroup } from '../../config/aiwg-config.js';
import { ConfigLoader } from '../../models/config-loader.js';
import type { DynamicModelCatalog } from '../../models/model-discovery.js';
import { validateWorkerCatalogDiscovery } from '../../models/provider-policy.js';
import { wrapperEnforcementReport } from '../../models/wrapper-enforcement.js';
import { DELEGATION_BLOCK_START, DELEGATION_BLOCK_END, readDelegationPolicy, renderDelegationRubric } from './delegation-rubric.js';

export const PARALLELISM_BLOCK_START = DELEGATION_BLOCK_START;
export const PARALLELISM_BLOCK_END = DELEGATION_BLOCK_END;

/** Plain-path pointer (not an `@` import) to the long health/supervision explanation. */
export const WORKER_HEALTH_DOC_POINTER = '`docs/getting-started/worker-dispatch.md` ("Worker health windows and supervision")';

/**
 * One-line note rendered when the bundled model defaults cannot be loaded.
 * The orchestration health block is omitted; the rest of the section renders
 * unchanged so context regeneration never throws for a missing home install.
 */
export const PARALLELISM_HEALTH_UNRESOLVED_NOTE =
  'Health values could not be resolved from the bundled defaults, so the orchestration health block is omitted.';

/** Injectable loaders for `buildParallelismSection` (tests inject failures). */
export interface ParallelismSectionDeps {
  /** The project config, independently validated except for worker-model defaults. */
  readConfig?: (projectPath: string) => Promise<AiwgConfig | null>;
  /** Worker-model defaults validation; only called when `worker_dispatch` is true. */
  validateWorkerConfig?: (projectPath: string, config: AiwgConfig) => Promise<void>;
  /** Read existing discovery only; context generation never refreshes or probes. */
  readCatalog?: () => Promise<DynamicModelCatalog | null>;
  now?: () => Date;
}

/**
 * Locate this package's bundled AIWG defaults (`models-v2.json` under
 * `agentic/...`) from the running code, whether it runs from a source
 * checkout or an installed package. Uses the canonical package-root walk
 * shared with the rest of src/ (`findPackageRoot`), never a hand-rolled
 * relative path and never the user's home install.
 */
function resolveBundledAiwgHome(): string | undefined {
  try {
    return findPackageRoot(dirname(fileURLToPath(import.meta.url))) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the AIWG home to pass to `ConfigLoader` for this generator's own
 * read: an explicit, non-empty `AIWG_HOME` always wins; otherwise fall back
 * to this package's own bundled defaults so regeneration does not depend on
 * what (if anything) is installed at the user's home. This function only
 * ever READS `process.env.AIWG_HOME` — it never sets or deletes it, so
 * concurrent callers and any spawned children never observe a value this
 * generator did not itself receive from the real environment.
 */
function resolveAiwgHome(): string | undefined {
  return process.env.AIWG_HOME || resolveBundledAiwgHome();
}

function isBundledDefaultsFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Failed to load AIWG default config');
}

function oneLine(value: string, maxLen: number): string {
  return value.replace(/[\r\n|]+/g, ' ').trim().slice(0, maxLen);
}

/** At most this many group summaries render; the rest collapse to "+N more". */
export const MAX_SHOWN_GROUPS = 8;

/**
 * Config-level member exclusions for one group, mirroring the static gates
 * in `resolveWorkerPlan()` (`src/models/resolver.ts`): a member or its CLI
 * installation flagged `enabled: false` is statically excluded. This is
 * NOT the live eligibility verdict — `resolveWorkerPlan()` resolves
 * eligibility per (group, member, effort) tuple against the current
 * catalog and request, so a member excluded nowhere here can still be
 * excluded for a specific role/task/effort, and vice versa is never true
 * (a statically excluded member is always excluded live too). Only the
 * per-member reasons render; the group itself is never labeled
 * "eligible"/"not eligible" — see the request-scoped resolve guidance
 * below the group list.
 *
 * A `requiredRoles` entry with no enabled covering member is a config
 * error `validateParallelismConfig()` (and `resolveParallelism()` /
 * `ConfigLoader.load()`, both called earlier in `buildParallelismSection()`)
 * already rejects outright — a config reaching this function can never
 * have one, so that case is not re-rendered here.
 */
function excludedMembers(parallelism: ParallelismConfig | undefined, group: WorkerGroup): string[] {
  const excluded: string[] = [];
  for (const member of (group.members ?? [])) {
    if (member.enabled === false) excluded.push(`${member.id} (member disabled)`);
    else if (parallelism?.clis?.[member.cli]?.enabled === false) excluded.push(`${member.id} (installation ${member.cli} disabled)`);
  }
  return excluded;
}

function groupSummaries(entries: Array<[string, WorkerGroup]>, parallelism: ParallelismConfig | undefined): string[] {
  return entries.map(([id, group]) => {
    const roles = [...new Set((group.members ?? []).flatMap(m => m.roles ?? []))].join('/');
    const clis = [...new Set((group.members ?? []).map(m => m.cli))].join('/');
    const parts = [`${oneLine(id, 64)} (members: ${(group.members ?? []).length}`];
    if (clis) parts.push(`clis: ${oneLine(clis, 96)}`);
    if (roles) parts.push(`roles: ${oneLine(roles, 96)}`);
    if (group.maxParallel !== undefined) parts.push(`maxParallel: ${group.maxParallel}`);
    if (group.efforts) parts.push(`efforts: ${oneLine(group.efforts.join('/'), 96)}`);
    if (group.dataPolicy) parts.push(`dataPolicy: ${oneLine(JSON.stringify(group.dataPolicy), 240)}`);
    if (group.requiredRoles?.length) parts.push(`requiredRoles: ${group.requiredRoles.join('/')}`);
    parts.push('configured');
    const excluded = excludedMembers(parallelism, group);
    if (excluded.length) parts.push(`excluded members: ${oneLine(excluded.join(', '), 160)}`);
    return parts.join('; ') + ')';
  });
}

/** Same cache used by model discovery; absence/corruption cannot invent evidence. */
async function readCachedCatalog(): Promise<DynamicModelCatalog | null> {
  try {
    return JSON.parse(await readFile(join(homedir(), '.cache/aiwg/model-catalog.v1.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function observationSummaries(entries: Array<[string, WorkerGroup]>, deps: ParallelismSectionDeps): Promise<string[]> {
  const candidate = await (deps.readCatalog ?? readCachedCatalog)();
  const catalog = candidate?.version && candidate.providers && !validateWorkerCatalogDiscovery(candidate.discovery).length
    ? candidate : null;
  const readAt = (deps.now ?? (() => new Date()))();
  const stamp = (value: string | undefined): string => {
    const time = value === undefined ? NaN : Date.parse(value);
    if (!Number.isFinite(time)) return 'unknown';
    const age = readAt.getTime() - time;
    return `${new Date(time).toISOString()} (${age < 0 ? 'future timestamp; age unavailable' : `${Math.floor(age / 1000)}s old`})`;
  };
  const range = (values: string[]): string => {
    if (!values.length) return 'unknown';
    values.sort((a, b) => Date.parse(a) - Date.parse(b));
    const oldest = stamp(values[0]);
    return Date.parse(values[0]) === Date.parse(values[values.length - 1]) ? oldest : `${oldest} to ${stamp(values[values.length - 1])}`;
  };
  return [
    `Cached model observations read at ${readAt.toISOString()}; catalog fetchedAt: ${stamp(catalog?.discovery?.fetchedAt)}. Ages are measured at this read and grow afterward. This cache may differ from the resolver's current installation observations; no eligibility read is performed by context generation. Missing or ambiguous observations have unknown age.`,
    '',
    ...entries.map(([id, group]) => {
      const observations = (group.members ?? []).flatMap(member => {
        // Mirror the resolver's exact, unambiguous id/API-id lookup per installation.
        const rows = catalog?.discovery?.instances?.[member.cli]?.models
          .filter(row => row.id === member.model || row.apiModelId === member.model) ?? [];
        return rows.length === 1 && rows[0].worker ? [rows[0].worker] : [];
      });
      return `- ${oneLine(id, 64)} cached observations: ${observations.length}/${(group.members ?? []).length} members; observedAt: ${range(observations.map(row => row.observedAt))}; verifiedAt: ${range(observations.map(row => row.verifiedAt))}.`;
    }),
    '',
  ];
}

function capacitySummary(parallelism: ParallelismConfig): string {
  const caps = parallelism.admission;
  const summaries = (['groupCaps', 'memberCaps', 'cliCaps', 'modelCaps', 'quotaCaps'] as const).map(field => {
    const entries = Object.entries(caps?.[field] ?? {});
    const shown = entries.slice(0, MAX_SHOWN_GROUPS).map(([key, value]) => `${oneLine(key, 96)}=${value}`).join(', ');
    return `${field}: ${shown || 'none configured'}${entries.length > MAX_SHOWN_GROUPS ? ` (+${entries.length - MAX_SHOWN_GROUPS} more)` : ''}`;
  });
  return `Configured concurrency ceilings (\`parallelism.admission\`): ${summaries.join('; ')}. Local/self-hosted models obey these same ceilings: CLI caps use installation IDs, model caps use canonical inference-provider/API-model keys, and quota caps use the installation's quotaScope. Unset caps add no extra ceiling; a current/request capacity ceiling of zero blocks selection. The resolver returns the minimum applicable ceiling as \`effectiveMaxParallel\`; Tier 0 conductors must self-count active workers, including workers sharing a local server.`;
}

/**
 * One configured health window with its origin. The origin mirrors
 * `resolveWorkerEffectiveHealth()` (`src/serve/worker-invocation.ts`): a
 * field the project config leaves unset resolves from the built-in defaults.
 */
function healthValue(health: ParallelismConfig['health'],
  field: 'checkSeconds' | 'startupSeconds' | 'quietSeconds' | 'stallSeconds' | 'hardTimeoutSeconds',
  fallback: number): { value: number; origin: string } {
  const value = health?.[field] ?? fallback;
  return { value, origin: health?.[field] === undefined ? 'default' : 'project config' };
}

/**
 * Plain-language dispatch state line (#3050 item 5). Agents must not assume
 * other worker CLIs are unavailable just because dispatch is off — they
 * should detect them and offer the opt-in, not silently work around it.
 */
function workerDispatchStateLine(parallelism: ParallelismConfig | undefined, setup: SetupConfig | undefined): string {
  if (parallelism?.worker_dispatch === true) {
    return '**Direct worker dispatch**: on (`parallelism.worker_dispatch`).';
  }
  // A recorded decline (#3050 review item 3) means a person already said no
  // to this offer — render the plain off state without repeating the
  // detect-and-offer instruction, so agents stop re-litigating a settled
  // decision every session. The decline is a setup/onboarding preference,
  // not worker policy, so it lives in `setup`, not in the frozen
  // `parallelism` contract fragment (B-OG-29).
  if (setup?.worker_dispatch_offer === 'declined') {
    return '**Direct worker dispatch**: off (`parallelism.worker_dispatch`); a prior offer was declined '
      + '(`setup.worker_dispatch_offer`). Do not re-offer it. It can still be turned on with '
      + '`aiwg config set --project parallelism.worker_dispatch true` if the user asks for it directly.';
  }
  return '**Direct worker dispatch**: off (`parallelism.worker_dispatch`). Do not assume other worker CLIs '
    + 'are unavailable — detect them yourself and offer `aiwg config set --project parallelism.worker_dispatch true` '
    + 'to the user if it would help.';
}

function delegationSupport(provider: string | undefined): string {
  switch (provider) {
    case 'antigravity':
      return '**Provider behavior (antigravity)**: Native invoke_subagent supports Model inherit|flash_lite|flash|pro; swarm supports per-worker model and workspace inherit|share|branch; run_workflow coordinates tasks. Installed 1.3.3 embedded schemas establish these surfaces, not account availability or live execution. AIWG team execution still uses aiwg-mc; its conservative cap is four workers.';
    case 'claude':
    case 'codex':
    case 'copilot':
    case 'cursor':
    case 'factory':
    case 'opencode':
      return `**Provider behavior (${provider})**: native custom subagents can select the deployed model-worker wrapper. Verify the resolved model when provider or account policy may substitute it.`;
    case 'openclaw':
      return '**Provider behavior (openclaw)**: wrapper Markdown is a reference mirror; native model controls require separate subagent configuration.';
    case 'openhuman':
      return '**Provider behavior (openhuman)**: wrapper roles compile to OpenHuman agent definitions; exact pins validate while semantic hints may be routed dynamically.';
    case 'warp':
    case 'hermes':
    case 'grokbot':
      return `**Provider behavior (${provider})**: delegation is available, but model selection is global/run-scoped. Use the wrapper rubric for task selection while reporting that heterogeneous per-worker pinning is not enforced.`;
    case 'grok-build':
      return '**Provider behavior (grok-build)**: native per-worker model enforcement is pending (#2577); do not claim model pinning from reference wrappers.';
    case 'devin':
      return '**Provider behavior (devin)**: portable subagent model selection is unsupported. Apply the decomposition rubric in the primary agent and do not claim wrapper pinning or parallel delegation.';
    default:
      return `**Provider behavior (${provider ?? 'unknown'})**: delegation and per-worker model selection are unverified. Apply the rubric only where the active provider exposes those capabilities, and state any fallback explicitly.`;
  }
}

/**
 * Build the parallelism-cap markdown section for injection into context files.
 * Returns `''` when injection should be skipped:
 *   - `AIWG_HIDE_PARALLELISM_IN_CONTEXT=1` is set
 *   - No `.aiwg/aiwg.config` exists at the project path
 */
export async function buildParallelismSection(projectPath: string, deps: ParallelismSectionDeps = {}): Promise<string> {
  if (process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT === '1') return '';

  // Step 1: the project config, independently validated except for the
  // worker-model defaults (never throws solely because bundled defaults are
  // unreachable — any error here is a genuine config problem and stays fatal).
  const candidate: AiwgConfig | null = deps.readConfig
    ? await deps.readConfig(projectPath)
    : await readAiwgConfigCandidate(projectPath);
  const cfg = candidate ?? { providers: [] } as unknown as AiwgConfig;
  const rubric = await renderDelegationRubric(await readDelegationPolicy(projectPath), !candidate);

  // Step 2: worker-model defaults validation, attempted only when dispatch
  // is enabled. A bundled-defaults failure degrades (health/group details
  // are omitted below with a one-line note); every other error stays fatal.
  let healthUnresolved = false;
  if (cfg.parallelism?.worker_dispatch === true) {
    try {
      if (deps.validateWorkerConfig) await deps.validateWorkerConfig(projectPath, cfg);
      else await validateWorkerConfigCandidate(projectPath, cfg, { aiwgHome: resolveAiwgHome() });
    } catch (error) {
      if (!isBundledDefaultsFailure(error)) throw error;
      healthUnresolved = true;
    }
  }

  const primary = cfg.providers[0];
  const resolved = resolveParallelism(cfg.parallelism, primary);
  const providerDefaults = primary && PROVIDER_PARALLELISM_DEFAULTS[primary];

  const isOverride = (field: keyof typeof resolved): boolean => {
    if (!providerDefaults) return false;
    if (field === 'rationale') return false;
    const def = providerDefaults[field as 'max_parallel_subagents' | 'max_parallel_ralph_loops' | 'max_parallel_mc_missions'];
    return resolved[field] !== def;
  };

  const label = (field: 'max_parallel_subagents' | 'max_parallel_ralph_loops' | 'max_parallel_mc_missions'): string => {
    const value = resolved[field];
    if (isOverride(field)) return `${value} (operator override)`;
    if (primary) return `${value} (provider default for ${primary})`;
    return `${value} (conservative default — unknown provider)`;
  };

  const lines: string[] = [];
  lines.push(PARALLELISM_BLOCK_START);
  lines.push('## Parallelism Cap');
  lines.push('');
  lines.push('This project caps parallel agent fan-out (#1359):');
  lines.push('');
  lines.push(`- **max_parallel_subagents**: ${label('max_parallel_subagents')}`);
  lines.push(`- **max_parallel_ralph_loops**: ${label('max_parallel_ralph_loops')}`);
  lines.push(`- **max_parallel_mc_missions**: ${label('max_parallel_mc_missions')}`);
  if (resolved.rationale) {
    lines.push('');
    lines.push(`*Rationale*: ${resolved.rationale}`);
  }
  lines.push('');
  lines.push(rubric);
  lines.push('After changing project parallelism with `aiwg config set/reset --project`, follow the emitted provider-specific regeneration commands and run `aiwg workspace-context doctor`.');
  lines.push('');
  for (const provider of cfg.providers.length ? cfg.providers : ['unknown']) {
    lines.push(`${delegationSupport(provider)} ${wrapperEnforcementReport(provider)}`);
  }
  lines.push('');
  lines.push(workerDispatchStateLine(cfg.parallelism, cfg.setup));
  lines.push('');
  // Group dispatch disabled (worker_dispatch unset/false): the resolver reports
  // `disabled`, so no group block renders — the subagent-scoping pointer above
  // remains available.
  if (cfg.parallelism?.worker_dispatch === true && healthUnresolved) {
    lines.push(PARALLELISM_HEALTH_UNRESOLVED_NOTE);
    lines.push('');
  } else if (cfg.parallelism?.worker_dispatch === true) {
    const health = cfg.parallelism?.health;
    const check = healthValue(health, 'checkSeconds', 15);
    const startup = healthValue(health, 'startupSeconds', 60);
    const quiet = healthValue(health, 'quietSeconds', 90);
    const stall = healthValue(health, 'stallSeconds', 300);
    const hard = healthValue(health, 'hardTimeoutSeconds', 1800);
    lines.push('### Orchestration groups (group dispatch enabled)');
    lines.push('');
    const entries = Object.entries(resolved.groups ?? {});
    if (entries.length > 0) {
      // Slice before summarizing so at most MAX_SHOWN_GROUPS summaries are built.
      const shown = groupSummaries(entries.slice(0, MAX_SHOWN_GROUPS), cfg.parallelism).join(' | ');
      const hidden = entries.length - MAX_SHOWN_GROUPS;
      lines.push(`Configured groups: ${shown}${hidden > 0 ? ` (+${hidden} more)` : ''}`);
    } else {
      lines.push('Configured groups: none — group dispatch is enabled but no groups are configured; the subagent-scoping rule applies.');
    }
    lines.push('');
    lines.push('A group above shown as configured, with excluded members or an uncovered required role listed, is a static config read — not a live eligibility verdict. Eligibility is resolved per (group, member, effort) tuple against the current catalog and request; see `aiwg models resolve` below to check a specific role/task/group.');
    lines.push('');
    lines.push(...await observationSummaries(entries.slice(0, MAX_SHOWN_GROUPS), deps));
    const models = await new ConfigLoader(projectPath, { aiwgHome: resolveAiwgHome() }).load(cfg.parallelism);
    for (const [pointer, origins] of Object.entries(models.workerPolicyOrigins ?? {})) {
      if (!pointer.startsWith('/parallelism/groups/') || !pointer.endsWith('/template')) continue;
      lines.push(`Template expansion ${oneLine(pointer, 160)}: ${origins.map(origin => `${oneLine(origin.source, 240)}#${oneLine(origin.pointer, 160)} (${origin.digest})`).join(' → ')}. Contributions are retained in workerPolicyOrigins; inherited ceilings remain binding.`);
    }
    const aliases = Object.entries(models.defaults.workerSelection?.roleGuidance ?? {}).filter(([, guidance]) => guidance.baseRole);
    for (const [role, guidance] of aliases) lines.push(`Project role ${role} aliases ${guidance.baseRole}; ordered groups: ${guidance.groups.join(', ')}. Resolver eligibility and base-role qualification remain required.`);
    const freshness = models.defaults.workerSelection!.freshness!;
    lines.push(`Resolver freshness limits from merged model policy: observation warning after ${freshness.warnHours} hours; observation blocked after ${freshness.blockHours} hours; verification blocked after ${freshness.policyDays} days. Future-dated evidence is blocked. Re-resolve before launch; cached ages do not establish eligibility.`);
    lines.push('');
    lines.push('Cross-family review: when required, the reviewer must use a different observed model family from the writer. Different CLI names do not prove different families. The resolver requires unambiguous writer lineage in `reviewOf` with `requireDifferentFamily`; missing, conflicting, unknown, or same-family lineage blocks required review. The direct CLI does not accept review-lineage flags. Family diversity does not establish independent errors; same-vendor or cross-vendor agreement is not proof. Consequential claims require an executable check or human acceptance. Record observed evaluator model/vendor/family, criteria, disagreements and re-review links. Calibration guide: `$AIWG_ROOT/docs/decision/evaluator-calibration.md`.');
    lines.push('');
    lines.push(capacitySummary(cfg.parallelism));
    lines.push('');
    lines.push('Tier 0 direct handoff is the default: use your own shell or a qualified MCP worker tool. Run the rendered command from your own shell outside your own harness sandbox (Claude Code `sandbox.excludedCommands` or an unsandboxed Bash call). The worker CLI native sandbox, per-task worktree and resource scope provide isolation; never nest sandboxes: a CLI sandbox inside a conductor sandbox fails; do not route Tier 0 workers through `aiwg ralph-external --launch-worker`, whose systemd-unit isolation and namespace probe apply only to that launcher and managed launches. No Mission/MC session, scheduler, daemon, or activation marker is needed. Self-count active native + CLI + MCP workers, take the minimum of the project, group, CLI, model, and context caps, and launch each writing task once.');
    lines.push('');
    lines.push('Before resolving, qualify the installed CLIs and configured model roles with `aiwg doctor --probe-workers --qualify` (`--yes` for headless confirmation).');
    lines.push('Agents pass `--authorize-premium` to `aiwg models resolve` only after the human explicitly confirmed the premium escalation (escalation-discipline rule); authorization applies to that resolution only.');
    lines.push('Resolve each bounded brief with `aiwg models resolve --role <role> --task <class> --group <group> --brief <file> --workdir <tree> --final-output <file> --transport shell --format shell`. Copy the exact rendered command or the MCP server/tool/arguments byte-for-byte; never assemble vendor flags from memory. Re-resolve after any brief, profile, model, or workspace change. `--format shell` prints only the launch command: to see the resolved health windows for an attempt, use `--format json` (the default) and read `invocation.health` with its per-field `origins`.');
    lines.push('');
    // #3451: the long window-scaling and supervision explanation lives in the
    // worker-dispatch doc (and the subagent-scoping rule); keep a summary here.
    lines.push(`Worker health windows (origin in parentheses): check every ${check.value}s (${check.origin}); startup ${startup.value}s (${startup.origin}); quiet ${quiet.value}s (${quiet.origin}); stall ${stall.value}s (${stall.origin}); hard stop ${hard.value}s (${hard.origin}). Resolved values win. Supervise by observer state: only \`hung\` authorizes a no-progress stop, and only of a worker you own; read status with \`aiwg ralph-external --status --workers --runs-root <dir> --json\` (read-only). Details: ${WORKER_HEALTH_DOC_POINTER} and \`aiwg show rule subagent-scoping\`.`);
    lines.push('');
  }
  lines.push(PARALLELISM_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

/**
 * Replace an existing parallelism-cap block inside `content` (between the
 * managed-block markers) with `newSection`. If no block exists yet, appends
 * the new section. If `newSection` is empty (cap is hidden), strips any
 * existing block in-place.
 *
 * Used by AIWG.md and AGENTS.md generators when reprocessing a file that
 * already has a parallelism block from a prior regeneration.
 */
export function replaceOrAppendParallelismBlock(content: string, newSection: string): string {
  // Consume old and new blocks together, retaining one insertion position and
  // preserving all operator text. Regenerate is idempotent even after a mixed migration.
  const blocks = /<!-- (AIWG-PARALLELISM-CAP|AIWG-DELEGATION):START -->[\s\S]*?<!-- \1:END -->\r?\n?/g;
  let inserted = false;
  const result = content.replace(blocks, () => {
    if (inserted) return '';
    inserted = true;
    return newSection;
  });
  return inserted || !newSection ? result : content.trimEnd() + '\n\n' + newSection;
}
