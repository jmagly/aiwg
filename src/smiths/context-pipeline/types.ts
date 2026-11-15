/**
 * Type definitions for the context-pipeline module.
 *
 * The context-pipeline emits a canonical graph and provider adapters at the end of `aiwg use`:
 *
 * - WORKSPACE.md — provider-neutral project/operator context
 * - AIWG.md      — generated framework context
 * - provider startup files — minimal adapters that load WORKSPACE.md, then AIWG.md
 *
 * Per ADR-1 (docs/configuration/workspace-context.md). NOT part of agentsmith;
 * agentsmith creates subagent personas, this module assembles cross-platform context.
 */

import type { Platform } from '../../agents/types.js';

/**
 * Artifact types that can appear as link-index sections in AGENTS.md.
 *
 * Order in this list is the order sections appear in AGENTS.md.
 */
export type IndexedArtifactType = 'agents' | 'rules' | 'skills' | 'behaviors';

/**
 * One entry in an AGENTS.md link-index section.
 *
 * Path field MUST originate from the AIWG-owned ProviderDefinition registry
 * plus the canonical `~/.agents/skills/` cross-provider user-scope target.
 * The allowlist in `allowlist.ts` enforces this.
 */
export interface IndexEntry {
  /** Artifact id (kebab-case, matches the deployed file's basename) */
  id: string;

  /** One-line description, ≤120 chars after sanitization */
  description: string;

  /** Path relative to the repo root (e.g. `.codex/agents/api-designer.md`) */
  path: string;

  /** Optional tags (sanitized; comma-joined in emission) */
  tags?: string[];

  /** True if this artifact carries `safety-critical: true` per the override-shadow-policy ADR */
  safetyCritical?: boolean;

  /** Non-empty if this artifact has been legitimately shadowed via an `overrides:` declaration */
  shadowedBy?: string;
}

/**
 * One link-index section of AGENTS.md.
 */
export interface AgentsMdSection {
  type: IndexedArtifactType;
  entries: IndexEntry[];
}

/**
 * Options for context-pipeline generation.
 */
export interface ContextPipelineOptions {
  /** Provider this AGENTS.md targets. Determines variant (file name, twin-file emission) */
  provider: Platform;

  /** Repo root path */
  projectPath: string;

  /** Pre-aggregated link-index sections; the caller is responsible for collecting deployed artifacts */
  sections: AgentsMdSection[];

  /** Project-context prose (≤1000 chars). Empty string omits the section. */
  projectContext?: string;

  /** Where to source AIWG.md content from. If omitted, derives from `${projectPath}/CLAUDE.md` template */
  aiwgMdSource?: string;

  /** If true, refuse to overwrite existing AGENTS.md / AIWG.md without --force */
  detectExistingFiles?: boolean;

  /** Force overwrite (with backup-before-overwrite per ADR-1 R1 mitigation) */
  force?: boolean;

  /** Skip individual graph nodes (all are skipped by --no-context-files). */
  skip?: { workspaceMd?: boolean; aiwgMd?: boolean; agentsMd?: boolean };

  // NOTE: OpenHuman trust-marker option removed (#1553 follow-up). Kernel skills
  // now deploy to user scope (~/.openhuman/skills/), which is ungated — the
  // trust marker only ever governed project-scope (<ws>/.openhuman/skills/).

  /**
   * Operator-declared overflow priority map per ADR-1 §6 / PUW-029.
   *
   * Keyed by artifact id. Special key `*` is the wildcard default. Values
   * 1 (pinned to AGENTS.md), 2 (medium; default), 3 (low; first to overflow).
   *
   * When omitted, all entries default to priority 2 except safety-critical
   * artifacts which are pinned to priority 1 unconditionally.
   */
  overflowPriorityMap?: Record<string, 1 | 2 | 3>;

}

/**
 * Result of a context-pipeline emission.
 */
export interface ContextPipelineResult {
  /** Path of WORKSPACE.md emission (empty if skipped or operator-owned) */
  workspaceMdPath: string;

  /** Whether WORKSPACE.md was created, refreshed, preserved, or skipped */
  workspaceMdAction?: 'created' | 'updated' | 'unchanged' | 'preserved';

  /** Path of AIWG.md emission (empty if skipped) */
  aiwgMdPath: string;

  /** Deprecated compatibility alias for root aiwgMdPath */
  normalizedAiwgMdPath: string;

  /** Path of AGENTS.md emission (empty if skipped) */
  agentsMdPath: string;

  /** Twin-file emissions (.hermes.md, WARP.md) when applicable */
  twinPaths: string[];

  /** Provider configuration files updated to register graph nodes */
  contextRegistrationPaths: string[];

  /** Backup paths created when --force overwrote existing operator content */
  backupPaths: string[];

  /** Total bytes written (used by PUW-029 32KB validator) */
  agentsMdBytes: number;

  /** Warnings emitted during generation (non-fatal) */
  warnings: string[];

  /** CLAUDE.md hook file path when provider is claude (empty otherwise; #1437) */
  claudeMdHookPath?: string;

  /** What happened to CLAUDE.md when provider is claude (#1437) */
  claudeMdHookAction?: 'created' | 'inserted' | 'updated' | 'unchanged' | 'skipped';
}

/**
 * AIWG-wide brand defaults for the Codex `agents/openai.yaml` sidecar (PUW-028).
 *
 * Per ADR-1 signoff (2026-05-05): single brand identity for all skills.
 * Per-category mapping is a follow-up if demand surfaces.
 */
export const AIWG_BRAND_DEFAULTS = {
  icon: 'aiwg',
  brandColor: '#0B5FFF',
} as const;
