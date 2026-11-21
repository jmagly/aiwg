/**
 * SkillSmith Type Definitions
 *
 * Types for generating skills with platform-aware deployment.
 *
 * @module smiths/skillsmith
 */

import type { Platform } from '../../agents/types.js';

/**
 * Skill generation options
 */
export interface SkillOptions {
  /** Skill name (kebab-case) */
  name: string;

  /**
   * What the skill does. REQUIRED and must be non-empty.
   * Codex rejects SKILL.md files without a description; Claude Code uses this
   * field for natural-language invocation. The generator throws if this is
   * missing or blank.
   */
  description: string;

  /** Target platform */
  platform: Platform;

  /** Where to deploy */
  projectPath: string;

  /** User guidance for generation */
  guidance?: string;

  /** Enable interactive mode */
  interactive?: boolean;

  /** Natural language triggers */
  triggerPhrases?: string[];

  /** Dry run (don't write files) */
  dryRun?: boolean;

  /** Skill version */
  version?: string;

  /** Tools this skill uses */
  tools?: string[];

  /** Provider-neutral model role; defaults to efficiency for cheap-first skills */
  modelRole?: 'reasoning' | 'coding' | 'efficiency';

  /** Provider-neutral model tier; defaults to economy for cheap-first skills */
  modelTier?: 'economy' | 'standard' | 'premium';

  /** Required rationale when callers intentionally elevate a generated skill */
  modelRationale?: string;

  /** Whether to create references directory */
  createReferences?: boolean;
}

/**
 * Generated skill artifact
 */
export interface GeneratedSkill {
  /** Skill name */
  name: string;

  /** Path where skill will be deployed */
  path: string;

  /** SKILL.md content */
  content: string;

  /** Target platform */
  platform: Platform;

  /** Supporting reference files */
  references?: SkillReference[];

  /** Skill version */
  version: string;
}

/**
 * Supporting reference file for a skill
 */
export interface SkillReference {
  /** Reference filename (within references/) */
  filename: string;

  /** Reference content */
  content: string;

  /** Reference description */
  description: string;
}

/**
 * Skill frontmatter metadata.
 *
 * `name`, `description`, and `version` are REQUIRED in every emitted SKILL.md.
 * `description` in particular must be non-empty — Codex rejects skills without
 * it. `tools` is the only optional field.
 */
export interface SkillFrontmatter {
  /** Skill name (kebab-case) — REQUIRED */
  name: string;

  /** Brief description — REQUIRED, non-empty. Codex enforces this. */
  description: string;

  /** Skill version (semver) — REQUIRED */
  version: string;

  /** Tools this skill uses (optional) */
  tools?: string;

  /** Canonical skill-to-command model policy */
  commandHint: {
    modelRole: 'reasoning' | 'coding' | 'efficiency';
    modelTier: 'economy' | 'standard' | 'premium';
    modelRationale?: string;
  };
}

/**
 * Platform-specific skill deployment configuration
 */
export interface PlatformSkillConfig {
  /** Base directory for skills */
  baseDir: string;

  /** File extension for skill files */
  extension: string;

  /** Whether this platform supports skills natively */
  supportsSkills: boolean;

  /** Alternative deployment strategy if skills not supported */
  alternativeStrategy?: 'command' | 'agent' | 'none';

  /**
   * Whether this platform supports subdirectory recursion for skill discovery.
   * When true, namespaced skills deploy under `{baseDir}/{namespace}/{slug}/`.
   * When false (e.g. Devin Desktop), skills deploy flat at `{baseDir}/{slug}/`.
   */
  supportsSubdirectory: boolean;
}

/**
 * Skill deployment result
 */
export interface SkillDeploymentResult {
  /** Skill that was deployed */
  skill: GeneratedSkill;

  /** Whether deployment succeeded */
  success: boolean;

  /** Deployment path */
  deployPath: string;

  /** Any errors encountered */
  error?: string;

  /** Files created */
  filesCreated: string[];
}

/**
 * Interactive skill design prompts
 */
export interface InteractivePrompts {
  /** Skill purpose */
  purpose: string;

  /** Trigger phrases */
  triggerPhrases: string[];

  /** Input requirements */
  inputRequirements: string[];

  /** Output format */
  outputFormat: string;

  /** Whether to create reference materials */
  needsReferences: boolean;

  /** Reference materials to create */
  referenceMaterials?: string[];
}
