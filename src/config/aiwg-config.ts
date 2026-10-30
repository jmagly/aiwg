import { preserveInstalledSelection } from './installed-selection.js';
import { validateHitlPolicy } from '../policy/hitl-validation.js';
import { normalizeAiwgConfigCandidate } from './config-normalization.js';
import { atomicConfigWrite, withWorkerWriteLock } from './worker-write.js';
import { workerConfigDigest } from './worker-config-digest.js';
export { workerConfigDigest } from './worker-config-digest.js';
import { validateParallelismConfig, type WorkerMember, type WorkerGroup, type WorkerActivation, type WorkerParallelism } from './worker-parallelism.js';
export { validateParallelismConfig, validateWorkerHealthConfig, resolveWorkerGroupInstallation } from './worker-parallelism.js';
export type { WorkerInstallation, WorkerMember, WorkerExecution, WorkerGroup, WorkerActivation, WorkerParallelism } from './worker-parallelism.js';
import { expandWorkerGroupTemplates } from './worker-group-templates.js';
import { validateDecisionConfig, type DecisionConfig } from './decision-config.js';
/**
 * Project-Level AIWG Config
 *
 * Manages `.aiwg/aiwg.config` — the project-level record of:
 *   - Which AI provider toolchains this project targets
 *   - Which frameworks/addons are deployed (with uninstall metadata)
 *   - User-defined scripts callable via `aiwg run`
 *
 * @implements #621
 */

import { validateImportExclusions } from '../sessions/import-exclusions.js';
import type { DispatchHostThresholds } from './dispatch-host-thresholds.js';
export type { DispatchHostThresholds } from './dispatch-host-thresholds.js';
export { DEFAULT_DISPATCH_HOST_THRESHOLDS, resolveDispatchHostThresholds } from './dispatch-thresholds-runtime.mjs';

import { validateIndexGraphOverrides, type IndexBuiltinGraphOverride } from './index-graph-overrides.js';
export type { IndexBuiltinGraphOverride } from './index-graph-overrides.js';

import { DEFAULT_RULES_INLINE_BUDGET_TOKENS } from '../rules/inline-budget.mjs';
import type { RulesConfig } from '../rules/inline-budget.mjs';
export { validateRulesConfig, resolveRulesInlineBudget } from '../rules/inline-budget.mjs';
export type { RulesConfig } from '../rules/inline-budget.mjs';

import { loadRulePinConfigs, installedRuleCapabilities, validateRulePinCapabilities } from '../rules/pins.mjs';

import { readFileSync, existsSync } from 'node:fs';
import { readFile, access, readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { resolve, join, isAbsolute } from 'path';
import type { ProjectLocalType } from '../extensions/manifest.js';
import { normalizeNamedCaptures } from '../artifacts/index-builder.js';
import {
  getProviderDefinition,
  getProviderKernelSkillPath,
  PROVIDER_IDS,
  resolveProviderPathValue,
} from '../providers/provider-definitions.js';
import type { Platform } from '../agents/types.js';
import {
  validateAuthorization,
  type AuthorizationConfig,
} from '../policy/authorization.js';
import {
  projectAiwgPath,
  projectControlPath,
  resolveProjectAiwgDir,
} from './project-artifacts.js';
import {
  defaultThreatAssessmentConfig,
  validateThreatAssessmentConfig,
  type SecurityConfig,
} from '../security/threat-assessment-config.js';
import { defaultArtifactOutputs, validateArtifactOutputs, type ArtifactOutputsConfig } from '../artifacts/output-policy.js';
import { validateGatesConfig, type ProjectFloors } from '../gates/floors.js';
import { validateUhpConfig } from '../uhp/config.js';
import type { UhpConfig } from '../uhp/types.js';
export type { UhpConfig, UhpEndpointProfile } from '../uhp/types.js';
export type { ArtifactOutputsConfig } from '../artifacts/output-policy.js';

export type {
  SecurityConfig,
  ThreatAction,
  ThreatAssessmentConfig,
  ThreatAssessmentMode,
  ThreatPolicyStatement,
  ThreatProfileConfig,
  ThreatRulePackConfig,
  ThreatSeverity,
  ThreatSurface,
  ThreatSurfaceConfig,
} from '../security/threat-assessment-config.js';

const CONFIG_FILENAME = 'aiwg.config';

/**
 * Artifact counts for one provider deployment
 */
export interface DeployedArtifactCounts {
  agents: number;
  commands: number;
  skills: number;
  rules: number;
}

/**
 * One entry in the `installed` map
 */
export interface InstalledEntry {
  /** Deployed version (CalVer or semver) */
  version: string;

  /**
   * Source of the deployment:
   *   "bundled"       — came from the npm package
   *   "cache"         — came from ~/.cache/aiwg/packages/ (#557)
   *   "project-local" — came from .aiwg/{extensions,addons,frameworks,plugins,providers}/<id>/ (#1035)
   *   git URL         — direct source URL
   */
  source: 'bundled' | 'cache' | 'project-local' | string;

  /** ISO-8601 timestamp of last deployment */
  installedAt: string;

  /** Provider → artifact counts */
  deployedTo: Record<string, DeployedArtifactCounts>;

  /** SHA-256 of manifest.json at deploy time; used for stale detection */
  manifestHash?: string;

  /**
   * Project-local-only fields (set when `source === 'project-local'`).
   *
   * Per @.aiwg/architecture/adr-unified-registry-shape.md (ADR companion to
   * #1035). These three fields MUST be present together when source is
   * `'project-local'` and SHOULD be absent otherwise.
   */
  /** Path of the bundle directory relative to project root (e.g., ".aiwg/extensions/foo/"). */
  localPath?: string;
  /** Bundle type from the manifest. */
  localType?: ProjectLocalType;
  /** Schema version of the manifest.json this entry was written from (currently `'1'`). */
  manifestVersion?: string;

  /**
   * Hashes of source artifacts at deploy time, keyed by source-relative path
   * (e.g., "rules/my-rule.md", "skills/my-skill/SKILL.md"). Used by
   * `aiwg remove` to detect pristine vs. mutated vs. replaced deployed
   * files per the design at @.aiwg/architecture/design-aiwg-remove-revert.md.
   *
   * Optional — older entries without this field fall back to "always-prompt"
   * remove behavior until the next `aiwg use` re-records them.
   *
   * @implements #1037
   */
  artifactHashes?: Record<string, string>;

  /**
   * Hashes of the provider-transformed artifacts actually written by a
   * project-local deployment. The outer key is the provider and the inner
   * key uses the same source-relative artifact path as `artifactHashes`.
   *
   * Provider deployers may rewrite frontmatter or translate formats, so a
   * source hash cannot reliably classify the deployed file. Older registry
   * entries continue to use `artifactHashes` as a compatibility fallback.
   *
   * @implements #1998
   */
  deployedArtifactHashes?: Record<string, Record<string, string>>;
}

/**
 * One secondary remote: a mirror, fork base, or publishing target.
 */
export interface SecondaryRemote {
  /** Must match a name from `git remote` */
  name: string;
  /** Free-form tag (mirror | upstream | publish | replica | …) */
  purpose?: string;
  /** Hint to release workflows: push tags here on stable cuts */
  push_on_release?: boolean;
}

/** Which account/tool should perform tracker writes for deliveries. */
export interface TrackerActorConfig {
  /** Forge login that should author issue/PR/comment/label writes. */
  login?: string;
  /** Tooling route to use for writes. */
  via?: 'tea' | 'gh' | 'mcp' | 'api';
  /** Forge logins that must not author delivery mutations. */
  forbid_actors?: string[];
}

/** Explicit issue-tracker provider hint for self-hosted or local trackers. */
export type IssueProviderConfig = 'gitea' | 'github' | 'local';

/** Git transport identity and the project-local helper that enforces it. */
export interface RemoteTransportConfig {
  /** Forge login expected to authenticate git pushes. */
  login?: string;
  /** Transport used by the primary remote. */
  protocol?: 'ssh' | 'https';
  /** Project-relative command used for authenticated push/check operations. */
  helper?: string;
  /** Public SSH host/account key fingerprint expected by the helper. */
  key_fingerprint?: string;
}

/**
 * Repo origin topology — declares which remote is primary (CI / issues / PRs)
 * and which are secondary (mirrors, publishing targets).
 *
 * @implements #994
 */
export interface RemotesConfig {
  /** git remote name driving CI / PRs by default. Defaults to "origin". */
  primary?: string;
  /** Where issues live. Defaults to `primary`. */
  issue_tracker?: string;
  /** Explicit tracker provider for ambiguous self-hosted or local issue stores. */
  issue_provider?: IssueProviderConfig;
  /** Where CI runs. Defaults to `primary`. */
  ci?: string;
  /** Which forge account/tool performs delivery writes. */
  tracker_actor?: TrackerActorConfig;
  /** Optional customer-facing issue intake remote, distinct from internal engineering work. */
  customer_issue_tracker?: string;
  /** Explicit provider hint for the customer-facing tracker. */
  customer_issue_provider?: IssueProviderConfig;
  /** Account/tool used for customer acknowledgements, comments, and closures. */
  customer_tracker_actor?: TrackerActorConfig;
  /** Identity and helper used for git transport to the primary remote. */
  transport?: RemoteTransportConfig;
  /** Mirrors, fork bases, publishing targets. */
  secondary?: SecondaryRemote[];
}

/**
 * Resolved remote topology — every field guaranteed to be set.
 * Returned by {@link resolveRemotes}.
 */
export interface ResolvedRemotes {
  primary: string;
  issue_tracker: string;
  issue_provider?: IssueProviderConfig;
  ci: string;
  tracker_actor?: TrackerActorConfig;
  customer_issue_tracker?: string;
  customer_issue_provider?: IssueProviderConfig;
  customer_tracker_actor?: TrackerActorConfig;
  transport?: RemoteTransportConfig;
  secondary: SecondaryRemote[];
}

export type RepoMaintainerTier = 'collaborator' | 'maintainer' | 'admin';

/**
 * Role-aware repository maintenance overrides. Keys may be remote URLs,
 * owner/repo slugs, remote names, or `local`; values pin the effective tier
 * when forge permission detection is unavailable or intentionally narrowed.
 */
export interface RepoMaintainerConfig {
  tiers?: Record<string, RepoMaintainerTier>;
}

export type IssueLabelCategory =
  | 'type'
  | 'area'
  | 'priority'
  | 'lifecycle'
  | 'blocked-reason'
  | 'review-approval'
  | 'ownership'
  | 'automation-eligibility'
  | 'human-interaction';

/** A stable semantic role mapped to a tracker-native label. */
export interface IssueLabelDefinition {
  /** Default tracker-native label name. */
  name: string;
  /** Optional provider-specific names for equivalent semantics. */
  provider_names?: Partial<Record<'gitea' | 'github' | 'local', string>>;
  /** Informative grouping used by search, audit, batching, and selection. */
  category: IssueLabelCategory;
  description: string;
  requires_human: boolean;
  blocks_automation: boolean;
  /** Human-readable condition that removes or transitions this transient label. */
  resume_when?: string;
  /** Optional semantic role to apply after the resume condition is satisfied. */
  transition_to?: string;
}

export interface IssuesConfig {
  /** Label definitions keyed by stable, project-owned semantic roles. */
  labels?: Record<string, IssueLabelDefinition>;
}

/**
 * Operations that a workspace may authorize for one member repository.
 * Filesystem/tool capability never implies authorization; unlisted members
 * and actions are denied by the workspace resolver.
 *
 * @implements #1764
 */
export const WORKSPACE_REPO_ACTIONS = [
  'read',
  'write',
  'commit',
  'push',
  'issue-comment',
  'service-action',
  'destructive',
] as const;

export type WorkspaceRepoAction = typeof WORKSPACE_REPO_ACTIONS[number];

/** Root workspace metadata or an optional member-to-workspace back-reference. */
export interface WorkspaceConfig {
  /** Stable human-readable workspace name. Required on a root manifest. */
  name?: string;
  /**
   * Base directory for relative member paths. Relative values are resolved
   * from the repository containing this config; defaults to that repository.
   */
  root?: string;
  /**
   * Optional path from a member repo to its workspace root. This lets an
   * absolute/external member discover workspace authorization when invoked
   * directly. A member_of config must not also declare repos.
   */
  member_of?: string;
}

/** One member declared by a workspace root `.aiwg/aiwg.config`. */
export interface WorkspaceRepoConfig {
  name: string;
  /** Relative to workspace.root (or the workspace repo) or an absolute path. */
  path: string;
  /** Explicit workspace capabilities. Missing actions are denied. */
  allowed: WorkspaceRepoAction[];
  /**
   * Optional provider hint for self-hosted domains that cannot be identified
   * from a remote URL alone. Detectable remotes always take precedence.
   */
  provider?: 'gitea' | 'github' | 'gitlab';
  notes?: string;
}

/**
 * Project-scope data classification. Same vocabulary as the per-artifact
 * `AiwgPrivacyClassification` used by the Fortemi index export, lifted to the
 * repository so agents have a structured signal for what a repo holds — rather
 * than prose in a README and a free-text `notes` string (#2535).
 */
export type ProjectClassification = 'private' | 'sanitized' | 'public';

/** How a repository's contents may be handled. Every field defaults to permissive. */
export interface ProjectHandling {
  /** May content be quoted into decks, docs, or messages outside the repo? */
  excerptable?: boolean;
  /** May content be published, including to a public site or package? */
  publishable?: boolean;
  /** May the repo be mirrored to a secondary remote? */
  mirror?: boolean;
}

/**
 * Project metadata. Accepts a bare string (the historical shape, a name) or the
 * object form carrying classification and handling policy.
 */
export interface ProjectConfig {
  name?: string;
  description?: string;
  classification?: ProjectClassification;
  /** Whether the repo holds personally identifiable information. */
  pii?: boolean;
  handling?: ProjectHandling;
}

export const PROJECT_CLASSIFICATIONS: readonly ProjectClassification[] = ['private', 'sanitized', 'public'];

/** Normalize the string-or-object `project` field to the object form. */
/**
 * Validate the `project` block. Accepts the bare-string form unconditionally so
 * existing configs keep loading (#2535).
 */
export function validateProjectConfig(project: unknown): string[] {
  const errors: string[] = [];
  if (project === undefined || typeof project === 'string') return errors;
  if (typeof project !== 'object' || project === null || Array.isArray(project)) {
    errors.push('project: must be a string (name) or an object');
    return errors;
  }
  const value = project as Record<string, unknown>;
  if (value.classification !== undefined
    && !PROJECT_CLASSIFICATIONS.includes(value.classification as ProjectClassification)) {
    errors.push(`project.classification: must be one of ${PROJECT_CLASSIFICATIONS.join(' | ')}`);
  }
  for (const key of ['name', 'description'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      errors.push(`project.${key}: must be a string`);
    }
  }
  if (value.pii !== undefined && typeof value.pii !== 'boolean') {
    errors.push('project.pii: must be a boolean');
  }
  if (value.handling !== undefined) {
    if (typeof value.handling !== 'object' || value.handling === null || Array.isArray(value.handling)) {
      errors.push('project.handling: must be an object');
    } else {
      const handling = value.handling as Record<string, unknown>;
      for (const key of ['excerptable', 'publishable', 'mirror'] as const) {
        if (handling[key] !== undefined && typeof handling[key] !== 'boolean') {
          errors.push(`project.handling.${key}: must be a boolean`);
        }
      }
    }
  }
  return errors;
}

export function resolveProject(project: string | ProjectConfig | undefined): ProjectConfig | undefined {
  if (project === undefined) return undefined;
  if (typeof project === 'string') return { name: project };
  return project;
}

/**
 * Handling defaults derived from the classification when not stated explicitly.
 * A `private` repo is closed by default; anything else stays permissive, so
 * declaring a classification never silently tightens an existing project.
 */
export function resolveProjectHandling(project: ProjectConfig | undefined): Required<ProjectHandling> {
  const closed = project?.classification === 'private';
  return {
    excerptable: project?.handling?.excerptable ?? !closed,
    publishable: project?.handling?.publishable ?? !closed,
    mirror: project?.handling?.mirror ?? !closed,
  };
}

export interface ResolvedIssueLabel extends IssueLabelDefinition {
  role: string;
  resolved_name: string;
  provider: 'gitea' | 'github' | 'local';
}

export interface IssueLabelDiagnostic {
  severity: 'warning' | 'error';
  code: 'fallback' | 'missing' | 'duplicate' | 'conflict' | 'unavailable';
  role?: string;
  message: string;
}

/**
 * A named public resource exposed as part of project operating context.
 *
 * External links are metadata only. AIWG renders and reports them but never
 * fetches the URL or submits data to it.
 */
export interface ExternalLinkConfig {
  /** Human-readable link text. */
  label: string;
  /** Absolute public HTTP(S) URL with no embedded credentials. */
  url: string;
  /** Optional explanation of when or why to use the resource. */
  description?: string;
  /** Optional project-defined grouping such as security, status, or docs. */
  category?: string;
  /** Optional intended audience such as contributors or maintainers. */
  audience?: string;
}

/** Project-local bundle discovery configuration. */
export interface ProjectLocalConfig {
  /**
   * Additional roots to scan for project-local bundle directories.
   *
   * Each root may be absolute, project-relative, or `~/`-relative and should
   * contain any of: extensions/, addons/, frameworks/, plugins/, providers/.
   * The configured project AIWG artifact root is always scanned first.
   */
  searchPaths?: string[];
}

/**
 * Top-level shape of .aiwg/aiwg.config
 */
export interface AiwgConfig {
  /** Configurable startup lint guard; never selects or demotes rules. */
  rules?: RulesConfig;
  decision?: DecisionConfig;
  sessions?: {
    /** Explicitly authorized Codex discovery roots, relative to the workspace or absolute. */
    codex_roots?: string[];
    /** Additional authorized discovery manifests for refresh, relative to the workspace or absolute. */
    discovery_manifests?: string[];
    /** Import limits and exclusions; source cap 0 means unlimited. */
    import?: {
      max_record_bytes?: number;
      max_source_bytes?: number;
      exclude?: string[];
    };
  };
  $schema?: string;
  version: '1';

  /**
   * AI provider toolchains this project targets.
   * `aiwg use <framework>` with no --provider flag deploys to ALL of these.
   */
  providers: string[];

  /**
   * Frameworks and addons currently deployed.
   * Keyed by the name passed to `aiwg use`.
   */
  installed: Record<string, InstalledEntry>;

  /**
   * User-defined scripts, run via `aiwg run <name>`.
   * Executed with `sh -c "<command>"` (or `cmd /c` on Windows).
   */
  scripts: Record<string, string>;

  /** Provider-neutral, deny-by-default permissions, roles, and assignments. */
  authorization?: AuthorizationConfig;

  /** Deterministic, project-owned security policy including forge-content assessment. */
  security?: SecurityConfig;

  /** Canonical artifact storage and optional provider-native presentation/export policy. */
  artifact_outputs?: ArtifactOutputsConfig;

  /** Experimental remote Unified Harness Protocol client profiles. */
  uhp?: UhpConfig;

  /**
   * General multi-repository workspace metadata. Root manifests pair this
   * block with `repos`; external members may use `member_of` as a back-reference.
   * @implements #1764
   */
  workspace?: WorkspaceConfig;

  /**
   * Project identity and data classification. A bare string is the project name
   * (historical shape); the object form adds classification and handling policy.
   */
  project?: string | ProjectConfig;

  /**
   * Workspace members. Each member keeps its own `.aiwg/aiwg.config`, which is
   * authoritative for delivery, remotes, tracker actor, and signing.
   * @implements #1764
   */
  repos?: WorkspaceRepoConfig[];

  /**
   * Named public resources that travel with the project configuration.
   * Keys are stable identifiers; values are metadata only.
   * @implements #1796
   */
  externalLinks?: Record<string, ExternalLinkConfig>;

  /**
   * Project-local bundle discovery settings. Optional — when absent, AIWG only
   * scans the configured project artifact root.
   */
  projectLocal?: ProjectLocalConfig;

  /**
   * Repo origin topology. Optional — when absent, agents treat `origin` as primary.
   * @implements #994
   */
  remotes?: RemotesConfig;

  /**
   * Issue workflow semantics associated with `remotes.issue_tracker`.
   * Absent configurations retain legacy label behavior with an explicit
   * fallback diagnostic.
   * @implements #1789
   */
  issues?: IssuesConfig;

  /**
   * Role-aware repository maintenance configuration. Optional — when absent,
   * repo-maintainer probes forge permissions and falls back to collaborator.
   * @implements #1755
   */
  repo_maintainer?: RepoMaintainerConfig;

  /**
   * Repo control / delivery policy — how AIWG agents are expected to ship code.
   * Optional — when absent, agents fall back to the conservative defaults
   * applied by `resolveDelivery()`.
   * @implements #995
   */
  delivery?: DeliveryConfig;

  /**
   * Provider-scoped parallelism caps — limits how many concurrent subagents,
   * Ralph loops, and Mission Control missions agents may spawn. Composes with
   * (takes the minimum of) `context-budget` rule caps and `rlm-context-management`
   * Rule 8's 7-agent hard cap. Optional — when absent, agents fall back to
   * provider-specific defaults applied by `resolveParallelism()`.
   * @implements #1359
   */
  parallelism?: ParallelismConfig;

  /**
   * Artifact-index configuration — graph definitions consolidated here from
   * the legacy `.aiwg/config.yaml` (#1491). Optional — absent for projects
   * that don't define custom index graphs.
   * @implements #1491
   */
  index?: IndexConfig;

  /**
   * User/global index shorthand. `indices.user.roots.<name>.path` declares a
   * shared user-level graph available from any project.
   */
  indices?: UserIndicesConfig;

  /**
   * Research-complete framework settings — corpus root for the research
   * corpus (references/citations/radar/profiles under `<corpusRoot>/documentation/`).
   * @implements #1497
   */
  research?: ResearchConfig;

  /**
   * Optional local CLI command invocation log. Off by default.
   * @implements #1614
   */
  command_log?: CommandLogConfig;

  /**
   * Local-first telemetry controls. Off by default.
   * @implements #1649
   */
  telemetry?: TelemetryConfig;

  /**
   * Setup/onboarding preferences — answers to opt-in offers presented during
   * `aiwg init` / `aiwg setup project` that are not worker policy and must
   * not live in `parallelism` (a frozen contract fragment, B-OG-29).
   * @implements #3050
   */
  setup?: SetupConfig;

  /**
   * Project build policy. Large build workflows consult this before expensive
   * package installs, TypeScript compilation, or web bundle generation.
   * @implements #1692
   */
  build?: BuildConfig;

  /**
   * Project gate floors for decision studies. Lists the gate packs (or pack
   * references) every binding in the project must include and tighten, plus
   * outcome ceilings keyed by study id (`'*'` is the project-wide default).
   * Optional — when absent, the operator default integrity-ceiling floor
   * (the shipped `aiwg:decision-engine/integrity-ceiling` pack, applied at
   * expansion) still governs every evaluation. `evaluateGates` requires
   * floors explicitly; invalid sections warn at read time and fail closed in
   * gates entry points. @implements #2832
   */
  gates?: ProjectFloors;
}

/** Research-complete framework settings (#1497). */
export interface ResearchConfig {
  /** Corpus root (relative to project root or absolute). Default: project root. */
  corpusRoot?: string;
}

/** Local-first CLI command invocation logging settings (#1614). */
export interface CommandLogConfig {
  /** Enable command logging for this project. Defaults to false. */
  enabled?: boolean;
  /** Stores to write. Project store is `.aiwg/telemetry/cli-commands.jsonl`; global is XDG state. */
  scopes?: Array<'project' | 'global'>;
  /** Maximum bytes per JSONL store before rotation to `.1`. */
  max_bytes?: number;
}

/** Local-first telemetry settings (#1649). */
export interface TelemetryConfig {
  /** Skill/agent/command usage tracking. Defaults to disabled. */
  skill_usage?: SkillUsageConfig;
}

/** Skill usage telemetry settings (#1649). */
export interface SkillUsageConfig {
  /** Enable skill usage tracking for this project. Defaults to false. */
  enabled?: boolean;
  /** Stores to write. Project store is `.aiwg/telemetry/skill-usage.jsonl`; global is XDG state. */
  scopes?: Array<'project' | 'global'>;
  /** Maximum bytes per JSONL store before rotation to `.1`. */
  max_bytes?: number;
}

/**
 * Setup/onboarding preferences (#3050). String enum (not boolean) so a
 * future "snoozed" or "asked-but-no-answer" state can be added without a
 * breaking schema change.
 */
export type WorkerDispatchOfferPreference = 'declined';

/** Setup/onboarding preferences — answers to opt-in offers, not worker policy. */
export interface SetupConfig {
  /**
   * Set to `"declined"` when a person explicitly said no to the
   * `parallelism.worker_dispatch` opt-in offer presented by `aiwg init` /
   * `aiwg setup project`. Suppresses the offer and every hint surface
   * (regenerate/refresh/doctor/generated context) until cleared, so a
   * decline is never re-asked on every run. The setting itself can still be
   * turned on later with `aiwg config set --project parallelism.worker_dispatch true`.
   */
  worker_dispatch_offer?: WorkerDispatchOfferPreference;
}

/** Large-build host resource preflight mode (#1692). */
export type BuildResourcePreflightMode = 'auto_detect' | 'configured';

/** Explicit host resource thresholds for large builds (#1692). */
export interface BuildResourceRequirements {
  min_memory_gb?: number;
  min_free_disk_gb?: number;
  min_cpus?: number;
  min_swap_gb?: number;
}

/** Cheap host-resource preflight run before expensive build commands (#1692). */
export interface BuildResourcePreflightConfig {
  /** Enable preflight checks for project build scripts. Defaults to false when absent. */
  enabled?: boolean;
  /**
   * `configured` checks only explicit requirements. `auto_detect` fills omitted
   * requirements with conservative defaults before checking the host.
   */
  mode?: BuildResourcePreflightMode;
  /** Project-specific minimum host resources. */
  requirements?: BuildResourceRequirements;
  /**
   * Live dispatch thresholds (FR-OG-107, #2954). Checked by the `dispatch`
   * preflight profile before worker launches and heavy verification runs.
   * Unset fields fall back to {@link DEFAULT_DISPATCH_HOST_THRESHOLDS}.
   */
  dispatch?: DispatchHostThresholds;
}

/** Project build policy block (#1692). */
export interface BuildConfig {
  resource_preflight?: BuildResourcePreflightConfig;
}

/**
 * How agents should ship code — modes:
 *   - `direct`         : commit & push straight to default_branch
 *   - `feature-branch` : create a branch and push it, but don't open a PR
 *   - `pr-required`    : feature branch + PR via the resolved primary remote
 */
export type DeliveryMode = 'direct' | 'feature-branch' | 'pr-required';

/**
 * Merge style preference; matches the values Gitea/GitHub/GitLab APIs accept.
 */
export type MergeStyle = 'rebase-merge' | 'squash' | 'merge' | 'fast-forward-only';

/**
 * Force-push policy:
 *   - `never`           : agents may never force-push
 *   - `own-branch-only` : OK on the agent's own feature branch, never to main
 *   - `allowed`         : escape hatch for tooling that needs it
 */
export type ForcePushPolicy = 'never' | 'own-branch-only' | 'allowed';

/**
 * Pre-rename spelling of {@link ForcePushPolicy}. Accepted as a deprecated alias so
 * configs written before the rename keep validating (#2532).
 */
export type LegacyForcePushPolicy = 'main-only-blocked';

/** Deprecated spellings mapped to their current value. */
export const FORCE_PUSH_POLICY_ALIASES: Record<string, ForcePushPolicy> = {
  'main-only-blocked': 'own-branch-only',
};

/**
 * The rename also narrowed the permission: `main-only-blocked` allowed force-push on
 * *any* feature branch, `own-branch-only` restricts it to the agent's own. Callers
 * surface this rather than migrating silently, because accepting the alias quietly
 * would change what an agent is permitted to do.
 */
export const FORCE_PUSH_POLICY_ALIAS_NOTE =
  "'main-only-blocked' is a deprecated alias for 'own-branch-only'. The permission also narrowed: "
  + 'the old value allowed force-push on any feature branch, the new one only on the agent\'s own branch.';

/**
 * Normalize a force-push policy, mapping deprecated spellings forward. Returns the
 * canonical value and the alias it came from, if any.
 */
export function normalizeForcePushPolicy(
  value: ForcePushPolicy | LegacyForcePushPolicy | string | undefined,
): { policy: ForcePushPolicy | undefined; deprecatedFrom?: string } {
  if (value === undefined) return { policy: undefined };
  const alias = FORCE_PUSH_POLICY_ALIASES[value];
  if (alias) return { policy: alias, deprecatedFrom: value };
  return { policy: value as ForcePushPolicy };
}

/**
 * Branch-naming convention. `{issue}` and `{slug}` are interpolated by skills.
 */
export interface BranchNaming {
  prefix_by_type?: Partial<Record<'feat' | 'fix' | 'docs' | 'chore' | 'refactor' | 'test', string>>;
}

/** Commit author/committer identity agents should use for deliveries. */
export interface CommitterIdentity {
  name?: string;
  email?: string;
}

export type SigningFormat = 'openpgp' | 'ssh' | 'x509';
export type SigningEnforcement = 'commits' | 'tags' | 'all';

/** Signing configuration for commits and/or release tags. */
export interface SigningConfig {
  format?: SigningFormat;
  key?: string;
  key_file?: string;
  program?: string;
  enforce?: SigningEnforcement;
}

/**
 * Repo control policy — see DeliveryMode for the high-level shape. Every field
 * is optional; sensible defaults applied via {@link resolveDelivery}.
 *
 * @implements #995
 */
export interface DeliveryConfig {
  mode?: DeliveryMode;
  /** Canonical issue storage mode (for example gitea-only, github-only, or local-only). */
  issue_storage?: string;
  default_branch?: string;
  branch_naming?: BranchNaming;
  merge_style?: MergeStyle;
  delete_branch_on_merge?: boolean;
  /** When true, agents must wait for CI green before declaring done. */
  require_ci_green?: boolean;
  require_signed_commits?: boolean;
  /** Git identity to use for delivery commits. Defaults to git config when unset. */
  committer?: CommitterIdentity;
  /** Signing key/material metadata for delivery commits/tags. */
  signing?: SigningConfig;
  /** Distinct signing metadata for annotated release tags. */
  release_signing?: SigningConfig;
  force_push_policy?: ForcePushPolicy;
  /** Include "Closes #N" / "Fixes #N" in PR body when an issue is referenced. */
  auto_close_issues?: boolean;
  /** Post AL CYCLE status comments to issue threads from address-issues loops. */
  issue_comment_on_cycle?: boolean;
}

/**
 * Resolved delivery policy with all defaults applied. Returned by
 * {@link resolveDelivery}.
 */
export interface ResolvedDelivery {
  mode: DeliveryMode;
  default_branch: string;
  branch_naming: Required<BranchNaming>;
  merge_style: MergeStyle;
  delete_branch_on_merge: boolean;
  require_ci_green: boolean;
  require_signed_commits: boolean;
  committer?: CommitterIdentity;
  signing?: SigningConfig;
  release_signing?: SigningConfig;
  force_push_policy: ForcePushPolicy;
  auto_close_issues: boolean;
  issue_comment_on_cycle: boolean;
}

const DEFAULT_BRANCH_NAMING: Required<BranchNaming> = {
  prefix_by_type: {
    feat: 'feat/{issue}-{slug}',
    fix: 'fix/{issue}-{slug}',
    docs: 'docs/{slug}',
    chore: 'chore/{slug}',
    refactor: 'refactor/{slug}',
    test: 'test/{slug}',
  },
};

/**
 * Resolve the delivery policy with defaults applied.
 *
 * Defaults are intentionally conservative — they match what AIWG agents
 * naturally do today (PR-required, rebase-merge, no force pushes, post issue
 * comments) so that adding the schema doesn't shift behavior for existing
 * projects.
 */
export function resolveDelivery(delivery: DeliveryConfig | undefined): ResolvedDelivery {
  return {
    mode: delivery?.mode ?? 'pr-required',
    default_branch: delivery?.default_branch ?? 'main',
    branch_naming: {
      prefix_by_type: {
        ...DEFAULT_BRANCH_NAMING.prefix_by_type,
        ...(delivery?.branch_naming?.prefix_by_type ?? {}),
      },
    },
    merge_style: delivery?.merge_style ?? 'rebase-merge',
    delete_branch_on_merge: delivery?.delete_branch_on_merge ?? true,
    require_ci_green: delivery?.require_ci_green ?? true,
    require_signed_commits: delivery?.require_signed_commits ?? false,
    committer: delivery?.committer,
    signing: delivery?.signing,
    release_signing: delivery?.release_signing,
    force_push_policy: normalizeForcePushPolicy(delivery?.force_push_policy).policy ?? 'never',
    auto_close_issues: delivery?.auto_close_issues ?? true,
    issue_comment_on_cycle: delivery?.issue_comment_on_cycle ?? true,
  };
}

/**
 * Provider-scoped parallelism cap — limits how many concurrent subagents,
 * Ralph loops, and Mission Control missions agents may spawn. Designed to
 * keep AIWG within the rate-limit envelope of the underlying model provider
 * (Anthropic per-key TPM/RPM caps are the most-reported trigger).
 *
 * Composes with (effective limit = MIN of):
 *   - `parallelism.max_parallel_subagents` (this config)
 *   - `context-budget` rule's `AIWG_CONTEXT_WINDOW`-derived cap, if set
 *   - `rlm-context-management` Rule 8's 7-agent hard cap (RLM dispatches only)
 *   - The natural task decomposition (no point spawning 4 when only 2 subtasks exist)
 *
 * Every field is optional. Defaults applied via {@link resolveParallelism}.
 *
 * @implements #1359
 */
/** Validate current model restrictions and group references before any write.
 * Disabled/unbound projects retain their existing config-only edit behavior.
 * This is shared validation, not Tier 1 coherent activation.
 *
 * `options.aiwgHome`, when provided, is passed through to `ConfigLoader`
 * unchanged — it never reads or writes `process.env.AIWG_HOME`. Omitting it
 * keeps `ConfigLoader`'s own default precedence (`AIWG_HOME` env, else the
 * running package root).
 */
export async function validateWorkerConfigCandidate(projectDir: string, config: AiwgConfig, options?: { aiwgHome?: string }): Promise<void> {
  const errors = validateParallelismConfig(config.parallelism);
  if (errors.length) throw new Error(errors.join('; '));
  if (!config.parallelism?.worker_dispatch) return;
  const { ConfigLoader } = await import('../models/config-loader.js');
  await new ConfigLoader(projectDir, options).load(config.parallelism);
}

export function workerActivationDigests(config: AiwgConfig, projectModels?: unknown, userModels?: unknown, builtinModels?: unknown): Omit<WorkerActivation, 'revision' | 'snapshotRef' | 'previousRef'> {
  const candidate = structuredClone(config);
  if (candidate.parallelism) delete candidate.parallelism.activation;
  return { configDigest: workerConfigDigest(candidate), projectModelsDigest: workerConfigDigest(projectModels), userModelsDigest: workerConfigDigest(userModels), builtinModelsDigest: workerConfigDigest(builtinModels) };
}
/** Pure inventory only: this does not activate, lock, synchronize, or admit work. */
export function workerActivationCopyInventory(projectDir: string, compatibilityConfig: string, userModels: string, builtinModels: string): string[] {
  return [...new Set([getConfigPath(projectDir), join(projectDir, 'models.json'), compatibilityConfig, userModels, builtinModels].map(file => resolve(file)))];
}

export interface ParallelismConfig extends WorkerParallelism {
  /** Max concurrent subagents (Task dispatches, rlm-batch fan-outs). */
  max_parallel_subagents?: number;
  /** Max concurrent Ralph external loops (`aiwg agent-loop-ext`). */
  max_parallel_ralph_loops?: number;
  /** Max concurrent Mission Control missions (`aiwg mc dispatch`). */
  max_parallel_mc_missions?: number;
  /** Free-form note explaining why this cap was chosen (e.g., plan tier). */
  rationale?: string;
}

/**
 * Resolved parallelism caps with all defaults applied. Returned by
 * {@link resolveParallelism}.
 */
export interface ResolvedParallelism extends WorkerParallelism {
  groups?: Record<string, WorkerGroup & { members: WorkerMember[] }>;
  max_parallel_subagents: number;
  max_parallel_ralph_loops: number;
  max_parallel_mc_missions: number;
  rationale?: string;
}

/**
 * Per-provider parallelism defaults. Conservative numbers for Anthropic-backed
 * providers reflect Pro/Team-plan rate limits — operators on Enterprise tiers
 * should bump via `aiwg config set --project parallelism.max_parallel_subagents N`.
 *
 * Sources for the numbers:
 *   - claude / claude-code: Anthropic per-key throttling at higher concurrency
 *   - codex / copilot / etc.: OpenAI / GitHub quotas are generally per-org and
 *     less aggressive at small fan-outs (10 is a safe middle ground)
 *   - hermes: MCP sidecar; rate-limit depends on upstream provider, operator
 *     should tune. Conservative 10 default.
 *   - grokbot: desktop multi-agent; conservative 4 until native evidence.
*   - grok-build: experimental; conservative 4 until Wave 2/3 evidence.
 *   - muse: stable; conservative 4 until native concurrency evidence.
 *   - unknown: conservative 4 default.
 */
export const PROVIDER_PARALLELISM_DEFAULTS: Record<string, ResolvedParallelism> = {
  antigravity: { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  claude:   { max_parallel_subagents: 4,  max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  codex:    { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  copilot:  { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  cursor:   { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  factory:  { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  opencode: { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  warp:     { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  windsurf: { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  openclaw: { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  hermes:   { max_parallel_subagents: 10, max_parallel_ralph_loops: 3, max_parallel_mc_missions: 6 },
  // Desktop multi-agent; conservative until native concurrency evidence exists.
  grokbot:  { max_parallel_subagents: 4,  max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  'grok-build': { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  // Muse Code is stable; keep conservative defaults until native concurrency evidence (#235).
  muse:     { max_parallel_subagents: 4,  max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  // Conservative defaults for remaining stable/experimental harnesses (#249).
  openhuman: { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  omp:      { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  pi:       { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
  'deepseek-harness': { max_parallel_subagents: 4, max_parallel_ralph_loops: 2, max_parallel_mc_missions: 4 },
};

const UNKNOWN_PROVIDER_PARALLELISM: ResolvedParallelism = {
  max_parallel_subagents: 4,
  max_parallel_ralph_loops: 2,
  max_parallel_mc_missions: 4,
};

/**
 * Return the provider's parallelism defaults, or the conservative fallback
 * when the provider is unknown.
 */
export function getProviderParallelismDefaults(provider: string | undefined): ResolvedParallelism {
  if (!provider) return UNKNOWN_PROVIDER_PARALLELISM;
  return PROVIDER_PARALLELISM_DEFAULTS[provider] ?? UNKNOWN_PROVIDER_PARALLELISM;
}

/**
 * Resolve the parallelism caps with provider-aware defaults applied. The
 * primary provider drives the default — typically the first entry in the
 * project's `providers` array.
 *
 * When `parallelism` has explicit values, they override the provider default
 * field-by-field. When no provider is supplied (or it's not in the defaults
 * map), the conservative 4-subagent fallback applies.
 *
 * @implements #1359
 */
export function resolveParallelism(
  parallelism: ParallelismConfig | undefined,
  primaryProvider?: string,
): ResolvedParallelism {
  const expansion = expandWorkerGroupTemplates(parallelism);
  if (expansion.errors.length) throw new Error(expansion.errors.join('; '));
  parallelism = expansion.parallelism;
  const defaults = getProviderParallelismDefaults(primaryProvider);
  const resolved: ResolvedParallelism = {
    max_parallel_subagents: parallelism?.max_parallel_subagents ?? defaults.max_parallel_subagents,
    max_parallel_ralph_loops: parallelism?.max_parallel_ralph_loops ?? defaults.max_parallel_ralph_loops,
    max_parallel_mc_missions: parallelism?.max_parallel_mc_missions ?? defaults.max_parallel_mc_missions,
  };
  if (parallelism?.rationale !== undefined) resolved.rationale = parallelism.rationale;
  const errors = validateParallelismConfig(parallelism);
  if (errors.length) throw new Error(errors.join('; '));
  if (parallelism?.worker_dispatch) {
    Object.assign(resolved, Object.fromEntries(Object.entries(structuredClone(parallelism)).filter(([, value]) => value !== undefined)));
    resolved.worker_mode ??= 'direct';
    for (const group of Object.values(resolved.groups ?? {})) {
      group.fallback ??= [];
      group.requiredRoles ??= [];
      group.execution = { isolation: 'worktree', sandbox: 'workspace-write', approval: 'never', network: 'deny', transport: 'shell', receipts: 'optional', ...group.execution };
      for (const member of group.members) { member.enabled ??= true; member.priority ??= 50; }
    }
    for (const cli of Object.values(resolved.clis ?? {})) cli.enabled ??= true;
    if (resolved.admission) resolved.admission = { maxQueued: 128, queueTimeoutSeconds: 300, leaseSeconds: 60, starvationSeconds: 120, authorityRef: 'project', ...resolved.admission };
    if (resolved.budgets) resolved.budgets = { enforcement: 'observed', unknownCost: 'deny', ...resolved.budgets };
    if (resolved.retry) resolved.retry = { maxAttempts: 3, on: ['rate-limit', 'unavailable', 'timeout'], baseDelaySeconds: 2, maxDelaySeconds: 60, ...resolved.retry };
  }
  return resolved;
}

/**
 * Artifact-index configuration (#1491). Consolidated into `.aiwg/aiwg.config`
 * from the legacy `.aiwg/config.yaml` per ADR adr-index-config-consolidation.
 *
 * `graphs` maps a graph name to its definition. The reserved key `indices`
 * holds the markdown-view manifest consumed by the corpus-index-build skill;
 * every other key is a JSON node/edge graph def (mirrors GraphConfig in
 * src/artifacts/types.ts).
 */
export interface IndexConfig {
  /** Default graph backend. Individual graph definitions take precedence. */
  graphBackend?: 'json' | 'graphology' | 'sqlite';
  /** Per adapter name (or group), measured verification age targets. */
  freshness?: Record<string, { targetStaleAfterMs?: number; maxRetriesPerDay?: number; measureConvergence?: boolean }>;
  graphs?: Record<string, IndexGraphDef | IndexMarkdownIndices>;
  graphOverrides?: {
    project?: IndexBuiltinGraphOverride;
    codebase?: IndexBuiltinGraphOverride;
  };
  userIndices?: {
    enabled?: boolean;
  };
}

export interface UserIndicesConfig {
  user?: {
    enabled?: boolean;
    roots?: Record<string, {
      path: string;
      backend?: 'local' | 'fortemi-core';
      extensions?: string[];
    }>;
  };
}

/** A JSON node/edge index graph def. Mirrors GraphConfig (src/artifacts/types.ts). */
export interface IndexGraphDef {
  type?: string;
  scanDirs: string[];
  extensions?: string[];
  shared?: boolean;
  defaultBuild?: boolean;
  buildTier?: 'lightweight' | 'standard' | 'heavy';
  buildOrder?: number;
  nodeStrategy?: 'default' | 'filename-metadata';
  filenamePattern?: string;
  graphBackend?: 'json' | 'graphology' | 'sqlite';
  description?: string;
  edgeExtraction?: {
    parser: 'citation-sidecar';
    edges: Array<{ type: string; source: string; target: string; skipEmpty?: boolean }>;
  };
  metadataSupplements?: Array<{ scanDir: string; matchOn: string; nodeKey: string; mergeFields: string[] }>;
  embedding?: { enabled: boolean; model?: string; topK?: number; rebuildOn?: 'content-change' | 'always' | 'never' };
}

/** The reserved `indices` graph: markdown-view manifest rendered by corpus-index-build. */
export interface IndexMarkdownIndices {
  scanDirs?: string[];
  extensions?: string[];
  defaultBuild?: boolean;
  manifest: Array<{ name: string; output?: string; description?: string; source?: string }>;
}

const GRAPH_BACKENDS = ['json', 'graphology', 'sqlite'];
const NODE_STRATEGIES = ['default', 'filename-metadata'];
const BUILD_TIERS = ['lightweight', 'standard', 'heavy'];

/**
 * Validate an `index` config block, returning a list of human-readable error
 * messages (empty = valid). Hand-rolled rather than ajv because aiwg.config has
 * no runtime schema-validation pipeline and the codebase deliberately avoids
 * pulling a validator dependency for config parsing (#1491).
 *
 * Catches the failure modes #1491 calls out: unknown graph type, missing
 * scanDirs, bad regex, typo'd keys, malformed manifest. `aiwg index build` and
 * `aiwg doctor` surface these at validate time instead of at runtime.
 *
 * @param index The value of `aiwg.config.index` (untrusted shape).
 * @returns Array of error strings; empty when the block is valid or absent.
 */
export function validateIndexConfig(index: unknown): string[] {
  const errors: string[] = [];
  if (index === undefined || index === null) return errors;
  if (typeof index !== 'object' || Array.isArray(index)) {
    return ['index: must be an object'];
  }

  const indexObject = index as Record<string, unknown>;
  if (indexObject.graphBackend !== undefined && !GRAPH_BACKENDS.includes(indexObject.graphBackend as string)) {
    errors.push(`index.graphBackend: must be one of ${GRAPH_BACKENDS.join(' | ')}`);
  }
  if (indexObject.freshness !== undefined) {
    const policies = indexObject.freshness;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
      errors.push('index.freshness: must map adapter names to policies');
    } else for (const [name, policy] of Object.entries(policies)) {
      const where = `index.freshness.${name}`;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      for (const [key, value] of Object.entries(policy)) {
        if (key === 'measureConvergence') {
          if (typeof value !== 'boolean') errors.push(`${where}.${key}: must be a boolean`);
        } else if (key === 'targetStaleAfterMs' || key === 'maxRetriesPerDay') {
          if (!Number.isSafeInteger(value) || (value as number) < (key === 'targetStaleAfterMs' ? 1 : 0)) {
            errors.push(`${where}.${key}: must be a ${key === 'targetStaleAfterMs' ? 'positive' : 'non-negative'} integer`);
          }
        } else errors.push(`${where}.${key}: unknown policy key`);
      }
    }
  }
  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

  errors.push(...validateIndexGraphOverrides(indexObject.graphOverrides));

  const graphs = indexObject.graphs;
  if (graphs === undefined) return errors; // index with no graphs is permissible
  if (typeof graphs !== 'object' || graphs === null || Array.isArray(graphs)) {
    errors.push('index.graphs: must be an object mapping graph names to definitions');
    return errors;
  }

  for (const [name, rawDef] of Object.entries(graphs as Record<string, unknown>)) {
    const where = `index.graphs.${name}`;
    if (typeof rawDef !== 'object' || rawDef === null || Array.isArray(rawDef)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const def = rawDef as Record<string, unknown>;

    if (name === 'indices') {
      // Markdown-view manifest (build.py).
      const manifest = def.manifest;
      if (!Array.isArray(manifest)) {
        errors.push(`${where}.manifest: must be an array`);
        continue;
      }
      manifest.forEach((entry, i) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          errors.push(`${where}.manifest[${i}]: must be an object`);
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== 'string' || e.name.trim() === '') {
          errors.push(`${where}.manifest[${i}]: 'name' is required and must be a non-empty string (it selects the renderer)`);
        }
        if (e.output !== undefined && typeof e.output !== 'string') {
          errors.push(`${where}.manifest[${i}].output: must be a string`);
        }
      });
      continue;
    }

    // JSON node/edge graph def.
    if (!isStringArray(def.scanDirs) || (def.scanDirs as string[]).length === 0) {
      errors.push(`${where}.scanDirs: required, must be a non-empty array of strings`);
    }
    if (def.extensions !== undefined && !isStringArray(def.extensions)) {
      errors.push(`${where}.extensions: must be an array of strings`);
    }
    if (def.nodeStrategy !== undefined && !NODE_STRATEGIES.includes(def.nodeStrategy as string)) {
      errors.push(`${where}.nodeStrategy: must be one of ${NODE_STRATEGIES.join(' | ')}`);
    }
    if (def.graphBackend !== undefined && !GRAPH_BACKENDS.includes(def.graphBackend as string)) {
      errors.push(`${where}.graphBackend: must be one of ${GRAPH_BACKENDS.join(' | ')}`);
    }
    if (def.buildTier !== undefined && !BUILD_TIERS.includes(def.buildTier as string)) {
      errors.push(`${where}.buildTier: must be one of ${BUILD_TIERS.join(' | ')}`);
    }
    if (def.buildOrder !== undefined && (typeof def.buildOrder !== 'number' || !Number.isFinite(def.buildOrder))) {
      errors.push(`${where}.buildOrder: must be a finite number`);
    }
    if (def.nodeStrategy === 'filename-metadata') {
      if (typeof def.filenamePattern !== 'string' || def.filenamePattern.trim() === '') {
        errors.push(`${where}.filenamePattern: required when nodeStrategy is 'filename-metadata'`);
      }
    }
    if (def.filenamePattern !== undefined && typeof def.filenamePattern === 'string') {
      try {
        // Apply the same Python→JS named-capture normalization the builder uses
        // (index-builder.ts buildFilenameMetadataEntry) so the validator doesn't
        // reject patterns the builder would happily compile. Fixes #1514 —
        // `aiwg` workspace refresh emits Python-style `(?P<name>)` patterns
        // (port residue from the Python build.py); the builder is lenient, the
        // validator wasn't, so legit configs failed up front.
        // eslint-disable-next-line no-new
        new RegExp(normalizeNamedCaptures(def.filenamePattern));
      } catch (err) {
        errors.push(`${where}.filenamePattern: not a valid regular expression (${(err as Error).message})`);
      }
    }
    if (def.edgeExtraction !== undefined) {
      const ee = def.edgeExtraction;
      if (typeof ee !== 'object' || ee === null || Array.isArray(ee)) {
        errors.push(`${where}.edgeExtraction: must be an object`);
      } else {
        const eo = ee as Record<string, unknown>;
        if (eo.parser !== 'citation-sidecar') {
          errors.push(`${where}.edgeExtraction.parser: must be 'citation-sidecar'`);
        }
        if (!Array.isArray(eo.edges)) {
          errors.push(`${where}.edgeExtraction.edges: must be an array`);
        } else {
          eo.edges.forEach((edge, i) => {
            if (typeof edge !== 'object' || edge === null) {
              errors.push(`${where}.edgeExtraction.edges[${i}]: must be an object`);
              return;
            }
            const ed = edge as Record<string, unknown>;
            for (const k of ['type', 'source', 'target']) {
              if (typeof ed[k] !== 'string' || (ed[k] as string).trim() === '') {
                errors.push(`${where}.edgeExtraction.edges[${i}].${k}: required, must be a non-empty string`);
              }
            }
          });
        }
      }
    }
  }

  return errors;
}

const EXTERNAL_LINK_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Validate project-defined external links without performing network access.
 */
export function validateExternalLinks(externalLinks: unknown): string[] {
  if (externalLinks === undefined || externalLinks === null) return [];
  if (typeof externalLinks !== 'object' || Array.isArray(externalLinks)) {
    return ['externalLinks: must be an object mapping stable identifiers to link definitions'];
  }

  const errors: string[] = [];
  for (const [key, rawLink] of Object.entries(externalLinks as Record<string, unknown>)) {
    const where = `externalLinks.${key}`;
    if (!EXTERNAL_LINK_KEY_PATTERN.test(key)) {
      errors.push(`${where}: key must start with a lowercase letter and contain only lowercase letters, numbers, underscores, or hyphens`);
    }
    if (!rawLink || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
      errors.push(`${where}: must be an object`);
      continue;
    }

    const link = rawLink as Record<string, unknown>;
    const allowedFields = new Set(['label', 'url', 'description', 'category', 'audience']);
    for (const field of Object.keys(link)) {
      if (!allowedFields.has(field)) {
        errors.push(`${where}.${field}: unknown field`);
      }
    }

    if (typeof link.label !== 'string' || link.label.trim() === '') {
      errors.push(`${where}.label: required, must be a non-empty string`);
    } else if (link.label.length > 200) {
      errors.push(`${where}.label: must be at most 200 characters`);
    }

    if (typeof link.url !== 'string' || link.url.trim() === '') {
      errors.push(`${where}.url: required, must be an absolute HTTP(S) URL`);
    } else {
      try {
        const parsed = new URL(link.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          errors.push(`${where}.url: protocol must be http or https`);
        }
        if (parsed.username || parsed.password) {
          errors.push(`${where}.url: embedded credentials are not allowed`);
        }
      } catch {
        errors.push(`${where}.url: must be a valid absolute URL`);
      }
    }

    for (const field of ['description', 'category', 'audience'] as const) {
      const value = link[field];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        errors.push(`${where}.${field}: must be a non-empty string when provided`);
      } else if (typeof value === 'string' && value.length > 500) {
        errors.push(`${where}.${field}: must be at most 500 characters`);
      }
    }
  }

  return errors;
}

/**
 * Validate the general workspace-of-repositories blocks.
 *
 * This is intentionally runtime validation as well as schema documentation:
 * CLI callers may not have editor/schema support, and authorization data must
 * fail closed when malformed.
 *
 * @implements #1764
 */
export function validateWorkspaceConfig(
  workspace: unknown,
  repos: unknown,
): string[] {
  const errors: string[] = [];
  if (workspace === undefined && repos === undefined) return errors;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return ['workspace: must be an object when workspace or repos is configured'];
  }

  const metadata = workspace as Record<string, unknown>;
  for (const field of ['name', 'root', 'member_of'] as const) {
    if (metadata[field] !== undefined && (
      typeof metadata[field] !== 'string' || !(metadata[field] as string).trim()
    )) {
      errors.push(`workspace.${field}: must be a non-empty string`);
    }
  }

  if (metadata.member_of !== undefined && repos !== undefined) {
    errors.push('workspace.member_of: member back-references must not also declare repos');
  }
  if (repos === undefined) return errors;
  if (typeof metadata.name !== 'string' || !metadata.name.trim()) {
    errors.push('workspace.name: required when repos is configured');
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    errors.push('repos: must be a non-empty array');
    return errors;
  }

  const names = new Set<string>();
  const paths = new Set<string>();
  const allowedActions = new Set<string>(WORKSPACE_REPO_ACTIONS);
  repos.forEach((raw, index) => {
    const where = `repos[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const repo = raw as Record<string, unknown>;
    if (typeof repo.name !== 'string' || !repo.name.trim()) {
      errors.push(`${where}.name: required and must be a non-empty string`);
    } else if (names.has(repo.name.trim())) {
      errors.push(`${where}.name: duplicate member name '${repo.name.trim()}'`);
    } else {
      names.add(repo.name.trim());
    }
    if (typeof repo.path !== 'string' || !repo.path.trim()) {
      errors.push(`${where}.path: required and must be a non-empty string`);
    } else if (paths.has(repo.path.trim())) {
      errors.push(`${where}.path: duplicate member path '${repo.path.trim()}'`);
    } else {
      paths.add(repo.path.trim());
    }
    if (!Array.isArray(repo.allowed) || repo.allowed.length === 0) {
      errors.push(`${where}.allowed: must be a non-empty array`);
    } else {
      for (const action of repo.allowed) {
        if (typeof action !== 'string' || !allowedActions.has(action)) {
          errors.push(`${where}.allowed: invalid operation '${String(action)}'`);
        }
      }
    }
    if (repo.provider !== undefined && !['gitea', 'github', 'gitlab'].includes(String(repo.provider))) {
      errors.push(`${where}.provider: must be gitea, github, or gitlab`);
    }
    if (repo.notes !== undefined && typeof repo.notes !== 'string') {
      errors.push(`${where}.notes: must be a string`);
    }
  });
  return errors;
}

/**
 * Read the `index` block, preferring `.aiwg/aiwg.config` (the consolidated
 * home, #1491) and falling back to the legacy `.aiwg/config.yaml` `index:`
 * block. Returns `{ index, source }` where source is 'aiwg.config',
 * 'config.yaml' (deprecated), or 'none'.
 *
 * The fallback keeps un-migrated corpora working; callers should surface a
 * deprecation notice when `source === 'config.yaml'`.
 */
export async function readIndexConfig(
  projectDir: string,
): Promise<{ index: IndexConfig | undefined; source: 'aiwg.config' | 'config.yaml' | 'none' }> {
  const cfg = await readAiwgConfig(projectDir);
  if (cfg?.index && typeof cfg.index === 'object') {
    return { index: cfg.index, source: 'aiwg.config' };
  }
  // Fallback: legacy config.yaml in the resolved AIWG artifact directory (deprecated).
  const yamlPath = projectAiwgPath(projectDir, 'config.yaml');
  try {
    await access(yamlPath);
    const { load: loadYaml } = await import('js-yaml');
    const raw = loadYaml(await readFile(yamlPath, 'utf-8')) as Record<string, unknown> | null;
    const idx = raw?.index;
    if (idx && typeof idx === 'object') {
      return { index: idx as IndexConfig, source: 'config.yaml' };
    }
  } catch {
    /* no config.yaml or unreadable */
  }
  return { index: undefined, source: 'none' };
}

/**
 * Provider tag for a given remote URL. Used by skills (issue-create,
 * pr-review, commit-and-push) to pick the right CLI / MCP client when
 * the operator didn't pass `--provider` explicitly.
 *
 * Recognized hosts:
 *   - github.com         → 'github'
 *   - gitlab.com / gitlab.* → 'gitlab'
 *   - any host containing 'gitea' (or matching the typical Gitea path shape) → 'gitea'
 *
 * Returns 'unknown' for self-hosted instances we can't classify by host alone —
 * callers should then prompt the operator or use `remotes.issue_provider`
 * when the project has declared one.
 *
 * @implements #997
 */
export function resolveRemoteProvider(remoteUrl: string): 'github' | 'gitlab' | 'gitea' | 'unknown' {
  if (!remoteUrl) return 'unknown';
  const lower = remoteUrl.toLowerCase();

  // github.com (or git@github.com:owner/repo.git form)
  if (/(^|[/@])github\.com[:/]/.test(lower)) return 'github';

  // gitlab.com or self-hosted gitlab
  if (/(^|[/@])gitlab\./.test(lower) || lower.includes('/gitlab/')) return 'gitlab';

  // gitea — identified by hostname token. Self-hosted Gitea instances often
  // don't include 'gitea' in their hostname (e.g. corporate git servers), so
  // 'unknown' is the honest answer there — callers should consult the
  // explicit remotes.issue_provider hint rather than guess.
  if (lower.includes('gitea')) return 'gitea';

  return 'unknown';
}

/**
 * Resolve the repo remote topology with defaults applied.
 *
 * Defaults:
 *   - `primary` defaults to "origin"
 *   - `issue_tracker` defaults to `primary`
 *   - customer tracker fields remain unset unless explicitly configured
 *   - `ci` defaults to `primary`
 *   - `secondary` defaults to `[]`
 *
 * Pass an absent or partial `remotes` block — every field comes back populated.
 */
export function resolveRemotes(remotes: RemotesConfig | undefined): ResolvedRemotes {
  const primary = remotes?.primary ?? 'origin';
  return {
    primary,
    issue_tracker: remotes?.issue_tracker ?? primary,
    issue_provider: remotes?.issue_provider,
    ci: remotes?.ci ?? primary,
    tracker_actor: remotes?.tracker_actor,
    customer_issue_tracker: remotes?.customer_issue_tracker,
    customer_issue_provider: remotes?.customer_issue_provider,
    customer_tracker_actor: remotes?.customer_tracker_actor,
    transport: remotes?.transport,
    secondary: remotes?.secondary ?? [],
  };
}

/**
 * Resolve stable semantic label roles to provider-native label strings.
 * The same role therefore drives Gitea, GitHub, and local issue-store flows.
 */
export function resolveIssueLabels(
  issues: IssuesConfig | undefined,
  provider: 'gitea' | 'github' | 'local',
): { labels: Record<string, ResolvedIssueLabel>; diagnostics: IssueLabelDiagnostic[] } {
  const diagnostics = validateIssueLabels(issues, { provider });
  if (!issues?.labels) {
    return {
      labels: {},
      diagnostics: [{
        severity: 'warning',
        code: 'fallback',
        message: 'issues.labels is not configured; issue workflows retain legacy label-name behavior and must warn before guessing or provisioning labels.',
      }],
    };
  }

  const labels = Object.fromEntries(Object.entries(issues.labels).map(([role, definition]) => [
    role,
    {
      ...definition,
      role,
      provider,
      resolved_name: definition.provider_names?.[provider] ?? definition.name,
    },
  ]));
  return { labels, diagnostics };
}

/**
 * Validate taxonomy structure and, when supplied, tracker availability.
 * This function is read-only: ordinary issue processing never provisions
 * missing labels implicitly.
 */
export function validateIssueLabels(
  issues: IssuesConfig | undefined,
  options: {
    provider?: 'gitea' | 'github' | 'local';
    availableLabels?: Iterable<string>;
  } = {},
): IssueLabelDiagnostic[] {
  if (!issues?.labels) return [];
  const diagnostics: IssueLabelDiagnostic[] = [];
  const seenNames = new Map<string, string>();
  const roles = new Set(Object.keys(issues.labels));
  const available = options.availableLabels ? new Set(options.availableLabels) : undefined;
  const categories = new Set<IssueLabelCategory>([
    'type', 'area', 'priority', 'lifecycle', 'blocked-reason',
    'review-approval', 'ownership', 'automation-eligibility', 'human-interaction',
  ]);

  for (const [role, definition] of Object.entries(issues.labels)) {
    const where = `issues.labels.${role}`;
    if (!definition.name?.trim() || !definition.description?.trim() || !definition.category) {
      diagnostics.push({
        severity: 'error',
        code: 'missing',
        role,
        message: `${where} must define non-empty name, description, and category fields.`,
      });
      continue;
    }
    if (!categories.has(definition.category)) {
      diagnostics.push({
        severity: 'error',
        code: 'conflict',
        role,
        message: `${where}.category '${definition.category}' is not a supported semantic category.`,
      });
    }
    if (typeof definition.requires_human !== 'boolean' || typeof definition.blocks_automation !== 'boolean') {
      diagnostics.push({
        severity: 'error',
        code: 'missing',
        role,
        message: `${where} must explicitly define requires_human and blocks_automation booleans.`,
      });
    }
    if (definition.blocks_automation && !definition.requires_human && !definition.resume_when) {
      diagnostics.push({
        severity: 'error',
        code: 'conflict',
        role,
        message: `${where} blocks automation but declares neither human action nor a resume condition.`,
      });
    }
    if (definition.blocks_automation && !definition.resume_when?.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'missing',
        role,
        message: `${where}.resume_when is required when blocks_automation is true.`,
      });
    }
    if (definition.transition_to && !roles.has(definition.transition_to)) {
      diagnostics.push({
        severity: 'error',
        code: 'conflict',
        role,
        message: `${where}.transition_to references unknown semantic role '${definition.transition_to}'.`,
      });
    }

    const resolvedName = options.provider
      ? definition.provider_names?.[options.provider] ?? definition.name
      : definition.name;
    const normalized = resolvedName.trim().toLocaleLowerCase();
    const previousRole = seenNames.get(normalized);
    if (previousRole) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate',
        role,
        message: `${where} resolves to '${resolvedName}', already used by role '${previousRole}'.`,
      });
    } else {
      seenNames.set(normalized, role);
    }
    if (available && !available.has(resolvedName)) {
      diagnostics.push({
        severity: 'error',
        code: 'unavailable',
        role,
        message: `${where} resolves to unavailable tracker label '${resolvedName}'; provision it explicitly before issue processing.`,
      });
    }
  }
  return diagnostics;
}

export const VALID_PROVIDERS = PROVIDER_IDS.filter((provider) => provider !== 'generic');
export type Provider = Exclude<Platform, 'generic'>;

/**
 * Empty config template.
 *
 * Includes an explicit `delivery` block defaulting to `pr-required`. The
 * runtime default in {@link resolveDelivery} is the same, so this is purely
 * for visibility — new projects ship with the policy written down so users
 * can see what their agents will do, and switch via `aiwg config set` or
 * the AIWG Steward agent without first having to discover the field exists.
 */
export function emptyConfig(providers: string[] = ['claude']): AiwgConfig {
  const primaryProvider = providers[0];
  const parDefaults = getProviderParallelismDefaults(primaryProvider);
  const knownProvider = primaryProvider && primaryProvider in PROVIDER_PARALLELISM_DEFAULTS;
  return {
    $schema: 'https://aiwg.io/schemas/aiwg.config.v1.json',
    version: '1',
    providers,
    installed: {},
    scripts: {},
    security: {
      threatAssessment: defaultThreatAssessmentConfig(),
    },
    artifact_outputs: defaultArtifactOutputs(),
    rules: { inline_budget_tokens: DEFAULT_RULES_INLINE_BUDGET_TOKENS },
    delivery: {
      mode: 'pr-required',
      default_branch: 'main',
      require_ci_green: true,
      auto_close_issues: true,
      issue_comment_on_cycle: true,
      force_push_policy: 'never',
    },
    parallelism: {
      max_parallel_subagents: parDefaults.max_parallel_subagents,
      max_parallel_ralph_loops: parDefaults.max_parallel_ralph_loops,
      max_parallel_mc_missions: parDefaults.max_parallel_mc_missions,
      rationale: knownProvider
        ? `Provider default for ${primaryProvider} — adjust via 'aiwg config set --project parallelism.max_parallel_subagents N'`
        : `Conservative default (unknown provider) — adjust via 'aiwg config set --project parallelism.max_parallel_subagents N'`,
    },
  };
}

/**
 * Resolve path to the project-level AIWG config.
 *
 * The config is part of the repository-local control plane. Relocating the
 * artifact corpus does not relocate this path.
 */
export function getConfigPath(projectDir: string): string {
  return projectControlPath(projectDir, CONFIG_FILENAME);
}

/**
 * Resolve the project directory for a handler invocation.
 *
 * Precedence:
 *   1. `--target <path>` or `--prefix <path>` flag in args
 *   2. The HandlerContext `cwd`, if provided
 *   3. `process.cwd()`
 *
 * All three variants existed scattered across handlers (#919 cleanup).
 * Use this helper so we have one authoritative resolution.
 */
export function getProjectDir(
  ctx: { cwd?: string } | undefined,
  args: readonly string[] = [],
): string {
  const targetIdx = args.findIndex(a => a === '--target' || a === '--prefix');
  const targetValue = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
  return targetValue || ctx?.cwd || process.cwd();
}

/**
 * Read and independently validate .aiwg/aiwg.config EXCEPT for the
 * worker-model defaults step (`validateWorkerConfigCandidate`), which needs
 * its own `aiwgHome` resolution and can fail solely because the bundled
 * model defaults are unreachable. Callers that want to degrade gracefully
 * on that one failure mode (e.g. generated-context rendering) read the
 * candidate here, then call `validateWorkerConfigCandidate` themselves and
 * handle its failure explicitly. `readAiwgConfig` below is the composition
 * of both steps for callers that want the original all-or-nothing contract.
 * Returns null if the file does not exist.
 */
export async function readAiwgConfigCandidate(projectDir: string): Promise<AiwgConfig | null> {
  const localPath = getConfigPath(projectDir);
  const artifactPath = projectAiwgPath(projectDir, CONFIG_FILENAME);
  let filePath = localPath;
  try {
    await access(localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (artifactPath === localPath) return null;
    try {
      await access(artifactPath);
      filePath = artifactPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }

  const content = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(content) as AiwgConfig;

  // Ensure required fields exist (forward-compat)
  normalizeAiwgConfigCandidate(parsed);

  if (parsed.sessions !== undefined && (
    parsed.sessions === null || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)
    || (parsed.sessions.codex_roots !== undefined && (
      !Array.isArray(parsed.sessions.codex_roots)
      || !parsed.sessions.codex_roots.every((root) => typeof root === 'string' && root.trim().length > 0)
    ))
  )) {
    throw new Error('sessions.codex_roots must be an array of non-empty paths');
  }
  if (parsed.sessions?.discovery_manifests !== undefined && (
    !Array.isArray(parsed.sessions.discovery_manifests)
    || !parsed.sessions.discovery_manifests.every((file) => typeof file === 'string' && file.trim().length > 0)
  )) {
    throw new Error('sessions.discovery_manifests must be an array of non-empty paths');
  }

  if (parsed.sessions?.import !== undefined) {
    const limits = parsed.sessions.import;
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new Error('sessions.import must be an object');
    }
    if (limits.exclude !== undefined) validateImportExclusions(limits.exclude);
    for (const key of ['max_record_bytes', 'max_source_bytes'] as const) {
      const value = limits[key];
      const minimum = key === 'max_source_bytes' ? 0 : 1;
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)) {
        throw new Error(`sessions.import.${key} must be a ${minimum ? 'positive' : 'non-negative'} integer`);
      }
    }
  }

  const externalLinkErrors = validateExternalLinks(parsed.externalLinks);
  if (externalLinkErrors.length > 0) {
    throw new Error(`Invalid .aiwg/aiwg.config:\n${externalLinkErrors.join('\n')}`);
  }

  const workspaceErrors = validateWorkspaceConfig(parsed.workspace, parsed.repos);
  if (workspaceErrors.length > 0) {
    throw new Error(`Invalid .aiwg/aiwg.config:\n${workspaceErrors.join('\n')}`);
  }

  const hitlErrors = validateHitlPolicy(parsed.authorization?.hitl);
  if (hitlErrors.length) throw new Error(hitlErrors.join("\n"));

  const authorizationErrors = parsed.authorization
    ? validateAuthorization(parsed.authorization).filter(item => item.severity === 'error')
    : [];
  if (authorizationErrors.length > 0) {
    throw new Error(`Invalid .aiwg/aiwg.config:\n${authorizationErrors.map(item => item.message).join('\n')}`);
  }

  const threatAssessmentErrors = [
    ...validateThreatAssessmentConfig(parsed.security?.threatAssessment),
    ...validateProjectConfig(parsed.project),
    ...validateParallelismConfig(parsed.parallelism),
    ...validateDecisionConfig(parsed.decision),
    ...validateRulePinCapabilities(parsed.rules, installedRuleCapabilities(loadRulePinConfigs(projectDir, parsed)), loadRulePinConfigs(projectDir, parsed).user.rules?.pin_groups),
  ];
  if (threatAssessmentErrors.length > 0) {
    throw new Error(`Invalid .aiwg/aiwg.config:\n${threatAssessmentErrors.join('\n')}`);
  }

  const artifactOutputErrors = validateArtifactOutputs(parsed.artifact_outputs);
  if (artifactOutputErrors.length > 0) throw new Error(`Invalid .aiwg/aiwg.config:\n${artifactOutputErrors.join('\n')}`);

  const uhpErrors = validateUhpConfig(parsed.uhp);
  if (uhpErrors.length > 0) throw new Error(`Invalid .aiwg/aiwg.config:\n${uhpErrors.join('\n')}`);

  // Gates errors warn (non-fatal): an invalid `gates` section must not brick
  // every command that reads the config. Gates entry points (`aiwg gates
  // evaluate`, binding resolution with floors) re-validate strictly via
  // `validateGatesConfig` and fail closed there; `writeAiwgConfig` below
  // stays strict so bad policy is never persisted.
  const gatesErrors = validateGatesConfig(parsed.gates);
  if (gatesErrors.length > 0) {
    console.warn(`Invalid gates section in .aiwg/aiwg.config (ignored):\n${gatesErrors.join('\n')}`);
  }

  return parsed;
}

/**
 * Read .aiwg/aiwg.config, including worker-model default validation.
 * Returns null if the file does not exist.
 *
 * `aiwgHome` (optional) resolves the bundled AIWG model-defaults location
 * passed through to `validateWorkerConfigCandidate` / `ConfigLoader`,
 * without ever reading or writing `process.env.AIWG_HOME`. Omit it to keep
 * the default precedence (`AIWG_HOME` env, else the user-home install).
 */
export async function readAiwgConfig(projectDir: string, options?: { aiwgHome?: string }): Promise<AiwgConfig | null> {
  const parsed = await readAiwgConfigCandidate(projectDir);
  if (!parsed) return null;
  await validateWorkerConfigCandidate(projectDir, parsed, options);
  return parsed;
}

/**
 * Write aiwg.config to the repository-local control plane. When a reachable
 * external corpus also carries the compatibility control copy, keep it in
 * sync so split-root health remains deterministic.
 */
export async function writeAiwgConfig(projectDir: string, config: AiwgConfig): Promise<void> {
  return withWorkerWriteLock(projectDir, () => writeAiwgConfigUnlocked(projectDir, preserveInstalledSelection(projectDir, config)));
}
async function writeAiwgConfigUnlocked(projectDir: string, config: AiwgConfig): Promise<void> {
  // Uninstall is an explicit capability change. Retire project selectors for
  // removed capabilities before strict validation, and tell the operator.
  const previousFile = getConfigPath(projectDir);
  let previous: AiwgConfig | null = null;
  if (existsSync(previousFile)) {
    try { previous = JSON.parse(readFileSync(previousFile, 'utf8')) as AiwgConfig; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const hitlErrors = validateHitlPolicy(config.authorization?.hitl);
  if (hitlErrors.length) throw new Error(hitlErrors.join("\n"));
  const pinConfigs = loadRulePinConfigs(projectDir, config);
  const currentCapabilities = new Set(installedRuleCapabilities(pinConfigs));
  const removed = previous ? installedRuleCapabilities({ ...pinConfigs, project: previous }).filter(id => !currentCapabilities.has(id)) : [];
  if (removed.length && (config.rules?.always_load?.length || Object.keys(config.rules?.pin_groups ?? {}).length)) {
    const removedSet = new Set(removed);
    const rules = config.rules!;
    const userGroups = loadRulePinConfigs(projectDir, config).user.rules?.pin_groups ?? {};
    const pinGroups = Object.fromEntries(Object.entries(rules.pin_groups ?? {})
      .map(([name, ids]) => [name, ids.filter(id => !removedSet.has(id))] as const).filter(([, ids]) => ids.length));
    const selectors = (rules.always_load ?? []).flatMap(selector => {
      if (selector.group && ((!Object.hasOwn(pinGroups, selector.group) && Object.hasOwn(rules.pin_groups ?? {}, selector.group))
        || (!Object.hasOwn(pinGroups, selector.group) && userGroups[selector.group]?.some(id => removedSet.has(id))))) return [];
      if (!selector.capabilities) return [selector];
      const capabilities = selector.capabilities.filter(id => !removedSet.has(id));
      return capabilities.length ? [{ ...selector, capabilities }] : [];
    });
    config = { ...config, rules: { ...config.rules, pin_groups: pinGroups, always_load: selectors } };
    console.warn(`Uninstalled ${removed.join(', ')}: their rules leave the effective pinned set; retired project capability selectors/groups. User pins remain visible as inactive warnings.`);
  }
  const threatAssessmentErrors = [
    ...validateThreatAssessmentConfig(config.security?.threatAssessment),
    ...validateProjectConfig(config.project),
    ...validateParallelismConfig(config.parallelism),
    ...validateDecisionConfig(config.decision),
    ...validateRulePinCapabilities(config.rules, installedRuleCapabilities(loadRulePinConfigs(projectDir, config)), loadRulePinConfigs(projectDir, config).user.rules?.pin_groups),
  ];
  if (threatAssessmentErrors.length > 0) {
    throw new Error(`Invalid .aiwg/aiwg.config:\n${threatAssessmentErrors.join('\n')}`);
  }
  const artifactOutputErrors = validateArtifactOutputs(config.artifact_outputs);
  if (artifactOutputErrors.length > 0) throw new Error(`Invalid .aiwg/aiwg.config:\n${artifactOutputErrors.join('\n')}`);
  const uhpErrors = validateUhpConfig(config.uhp);
  if (uhpErrors.length > 0) throw new Error(`Invalid .aiwg/aiwg.config:\n${uhpErrors.join('\n')}`);
  const gatesErrors = validateGatesConfig(config.gates);
  if (gatesErrors.length > 0) throw new Error(`Invalid .aiwg/aiwg.config:\n${gatesErrors.join('\n')}`);
  await validateWorkerConfigCandidate(projectDir, config);
  const localPath = getConfigPath(projectDir);
  const artifactDir = resolveProjectAiwgDir(projectDir);
  const artifactPath = join(artifactDir, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + '\n';

  const writeAtomic = (file: string) => atomicConfigWrite(file, content);

  await writeAtomic(localPath);
  if (artifactPath !== localPath) {
    try {
      await access(artifactDir);
      await writeAtomic(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}


/**
 * Ensure `provider` appears in `config.providers` without wiping others (#247).
 * First entry is the primary provider for parallelism/doctor labels.
 * When `asPrimary` is true (explicit `--provider` deploy), move the provider to the front.
 */
export function ensureProviderListed(
  config: AiwgConfig,
  provider: string,
  opts: { asPrimary?: boolean } = {},
): AiwgConfig {
  const normalized = provider.trim();
  if (!normalized) return config;
  const providers = Array.isArray(config.providers) ? [...config.providers] : [];
  const idx = providers.indexOf(normalized);
  if (opts.asPrimary) {
    if (idx === 0) {
      config.providers = providers;
      return config;
    }
    if (idx > 0) providers.splice(idx, 1);
    providers.unshift(normalized);
  } else if (idx < 0) {
    providers.push(normalized);
  } else {
    return config;
  }
  config.providers = providers;
  return config;
}

/**
 * Update the `installed` record for a framework after a successful deployment.
 * Returns the updated config (does not write to disk — caller must call writeAiwgConfig).
 */
export function updateInstalled(
  config: AiwgConfig,
  name: string,
  provider: string,
  counts: DeployedArtifactCounts,
  opts: {
    version: string;
    source: string;
    manifestHash?: string;
    /** Set when source === 'project-local'. Relative to project root. */
    localPath?: string;
    /** Set when source === 'project-local'. */
    localType?: ProjectLocalType;
    /** Set when source === 'project-local'. */
    manifestVersion?: string;
    /** Optional source-artifact hash map for project-local remove revert (#1037). */
    artifactHashes?: Record<string, string>;
    /** Provider-specific hashes captured from the deployed files (#1998). */
    deployedArtifactHashes?: Record<string, string>;
    /**
     * When true (explicit `--provider` deploy), move this provider to the front
     * of `providers[]` so doctor/parallelism treat it as primary (#247).
     */
    asPrimary?: boolean;
  }
): AiwgConfig {
  // Project-local invariant: `source: 'project-local'` requires localPath + localType
  // (per ADR adr-unified-registry-shape §6 risk mitigation).
  if (opts.source === 'project-local') {
    if (!opts.localPath || !opts.localType) {
      throw new Error(
        `updateInstalled: source 'project-local' requires localPath and localType (got ${JSON.stringify({ localPath: opts.localPath, localType: opts.localType })})`
      );
    }
  }

  const existing = config.installed[name] ?? {
    version: opts.version,
    source: opts.source,
    installedAt: new Date().toISOString(),
    deployedTo: {},
    manifestHash: opts.manifestHash,
  };

  existing.version = opts.version;
  existing.source = opts.source;
  existing.installedAt = new Date().toISOString();
  existing.deployedTo[provider] = counts;
  if (opts.manifestHash) existing.manifestHash = opts.manifestHash;

  if (opts.source === 'project-local') {
    existing.localPath = opts.localPath;
    existing.localType = opts.localType;
    if (opts.manifestVersion) existing.manifestVersion = opts.manifestVersion;
    if (opts.artifactHashes) existing.artifactHashes = opts.artifactHashes;
    if (opts.deployedArtifactHashes) {
      existing.deployedArtifactHashes ??= {};
      existing.deployedArtifactHashes[provider] = opts.deployedArtifactHashes;
    }
  } else {
    // Clear stale project-local fields if a previously project-local entry is
    // being overwritten by a non-project-local source.
    delete existing.localPath;
    delete existing.localType;
    delete existing.manifestVersion;
    delete existing.artifactHashes;
    delete existing.deployedArtifactHashes;
  }

  config.installed[name] = existing;
  // Keep providers[] aligned with deployedTo so doctor/parallelism see the right primary (#247).
  ensureProviderListed(config, provider, { asPrimary: opts.asPrimary === true });
  return config;
}

/**
 * Aggregate deployment counts across all installed frameworks for a given provider.
 * Returns the totals for agents, commands, skills, and rules.
 * If no provider is specified, uses the first configured provider.
 */
export function getDeploymentSummary(
  config: AiwgConfig,
  provider?: string
): DeployedArtifactCounts {
  const targetProvider = provider ?? config.providers[0] ?? 'claude';
  const totals: DeployedArtifactCounts = { agents: 0, commands: 0, skills: 0, rules: 0 };

  for (const entry of Object.values(config.installed)) {
    const counts = entry.deployedTo[targetProvider];
    if (!counts) continue;
    totals.agents += counts.agents;
    totals.commands += counts.commands;
    totals.skills += counts.skills;
    totals.rules += counts.rules;
  }

  return totals;
}

/**
 * Compute SHA-256 hash of a manifest.json file.
 * Returns undefined if the file cannot be read.
 */
export async function hashManifest(manifestPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(manifestPath, 'utf-8');
    return 'sha256:' + createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

function getProviderDeployDirs(
  provider: string,
  projectDir: string,
): { agents: string; skills: string; kernelSkills: string; commands: string; rules: string } | null {
  const artifacts = getProviderDefinition(provider)?.paths.artifacts;
  if (!artifacts) return null;
  return {
    agents: resolveProviderPathValue(artifacts.agents, projectDir),
    skills: resolveProviderPathValue(artifacts.skills, projectDir),
    kernelSkills: resolveProviderPathValue(getProviderKernelSkillPath(provider), projectDir),
    commands: resolveProviderPathValue(artifacts.commands, projectDir),
    rules: resolveProviderPathValue(artifacts.rules, projectDir),
  };
}

/**
 * Count .md files or subdirectories in a deployment directory.
 * Returns 0 if the directory does not exist.
 */
async function countDeployedInDir(
  projectDir: string,
  relOrAbsDir: string,
  mode: 'md' | 'dirs'
): Promise<number> {
  if (!relOrAbsDir) return 0;
  const dir = isAbsolute(relOrAbsDir) ? relOrAbsDir : resolve(projectDir, relOrAbsDir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    if (mode === 'md') return entries.filter(e => e.isFile() && e.name.endsWith('.md')).length;
    return entries.filter(e => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * Scan actual deployment directories and populate `deployedTo` for any
 * `installed` entries that have an empty `deployedTo` map.
 *
 * Called by `aiwg init` when migrating a project that already has frameworks
 * deployed but whose config was created before deployment-tracking was added.
 *
 * @implements #721
 */
export async function populateDeployedTo(
  config: AiwgConfig,
  projectDir: string
): Promise<AiwgConfig> {
  const entriesNeedingPopulation = Object.entries(config.installed).filter(
    ([, entry]) => Object.keys(entry.deployedTo).length === 0
  );
  if (entriesNeedingPopulation.length === 0) return config;

  for (const provider of config.providers) {
    const dirs = getProviderDeployDirs(provider, projectDir);
    if (!dirs) continue;

    const counts: DeployedArtifactCounts = {
      agents:   await countDeployedInDir(projectDir, dirs.agents,   'md'),
      commands: await countDeployedInDir(projectDir, dirs.commands, 'md'),
      skills:
        (await countDeployedInDir(projectDir, dirs.skills, 'dirs')) +
        (dirs.kernelSkills && dirs.kernelSkills !== dirs.skills
          ? await countDeployedInDir(projectDir, dirs.kernelSkills, 'dirs')
          : 0),
      rules:    await countDeployedInDir(projectDir, dirs.rules,    'md'),
    };

    // Only populate if at least one artifact type is present
    if (counts.agents + counts.commands + counts.skills + counts.rules === 0) continue;

    for (const [name, entry] of entriesNeedingPopulation) {
      if (Object.keys(entry.deployedTo).length === 0) {
        entry.deployedTo[provider] = counts;
        config.installed[name] = entry;
      }
    }
  }

  return config;
}

/** Shape validation alone cannot infer process/HTTP metadata or model authority. */
export function validateWorkerInstallationBindings(parallelism: ParallelismConfig, adapters: Record<string, { transport: 'process' | 'http'; executable?: string }>): string[] {
  const errors: string[] = [];
  for (const [id, cli] of Object.entries(parallelism.clis ?? {})) {
    if (cli.enabled === false) continue;
    const metadata = adapters[cli.adapter];
    if (!metadata) errors.push(`OG_ADAPTER_UNQUALIFIED /parallelism/clis/${id}/adapter: Unknown trusted binding`);
    else if (metadata.transport === 'http' ? (!cli.endpoint || cli.executable !== undefined) : (cli.endpoint !== undefined || !(cli.executable ?? metadata.executable))) errors.push(`OG_CONFIG_REFERENCE /parallelism/clis/${id}: Invalid transport binding`);
  }
  return errors;
}
export function validateWorkerGroupReferences(parallelism: ParallelismConfig, selection: import('../models/types.js').WorkerSelectionPolicy, qualifiedRoles?: Record<string, string[]>): string[] {
  const errors = validateParallelismConfig(parallelism);
  if (errors.length) return errors;
  parallelism = expandWorkerGroupTemplates(parallelism).parallelism!;
  for (const [role, guidance] of Object.entries(selection.roleGuidance ?? {})) {
    for (const group of guidance.groups) if (!parallelism.groups?.[group]) errors.push(`OG_CONFIG_REFERENCE /defaults/workerSelection/roleGuidance/${role}/groups: Unknown group ${group}`);
  }
  if (qualifiedRoles) errors.push(...validateWorkerGroupQualifications(parallelism, qualifiedRoles)
    .map(diagnostic => `${diagnostic.code} ${diagnostic.pointer}: ${diagnostic.message}`));
  return errors;
}

/** Structured qualification gaps retain role scope for readiness projections. */
export function validateWorkerGroupQualifications(parallelism: ParallelismConfig,
  qualifiedRoles: Record<string, string[]>): import('../models/types.js').WorkerPolicyDiagnostic[] {
  const diagnostics: import('../models/types.js').WorkerPolicyDiagnostic[] = [];
  parallelism = expandWorkerGroupTemplates(parallelism).parallelism!;
  for (const [id, group] of Object.entries(parallelism.groups ?? {})) {
    for (const role of group.requiredRoles ?? []) {
      if (!(group.members ?? []).some(m => m.enabled !== false && parallelism.clis?.[m.cli]?.enabled !== false
        && m.roles.includes(role) && qualifiedRoles[`${id}/${m.id}`]?.includes(role))) {
        diagnostics.push({ code: 'OG_ADAPTER_UNQUALIFIED', pointer: `/parallelism/groups/${id}/requiredRoles`,
          message: `No qualified route covers ${role}`, roles: [role] });
      }
    }
  }
  return diagnostics;
}

/** A configured hard ceiling is eligible only where a qualified control enforces it. */
export function validateWorkerBudgetEnforcement(budgets: WorkerParallelism['budgets'], enforceable: Array<'tokens' | 'costUsd' | 'wallSeconds'>): string[] {
  if (budgets?.enforcement !== 'hard') return [];
  const errors: string[] = [];
  for (const scope of ['perRun', 'perTask'] as const) for (const dimension of ['tokens', 'costUsd', 'wallSeconds'] as const) {
    if (budgets[scope]?.[dimension] !== undefined && !enforceable.includes(dimension)) errors.push(`OG_BUDGET_UNMEASURABLE /parallelism/budgets/${scope}/${dimension}: No qualified enforcing control`);
  }
  return errors;
}
