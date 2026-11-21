/**
 * Platform-specific skill deployment path resolution
 *
 * @module smiths/skillsmith/platform-resolver
 */

import { homedir } from 'os';
import * as path from 'path';
import type { Platform } from '../../agents/types.js';
import type { PlatformSkillConfig } from './types.js';
import { getProviderDefinition } from '../../providers/provider-definitions.js';

/**
 * Platform-specific skill configuration derived from ProviderDefinition.
 */
function getPlatformSkillConfig(platform: Platform): PlatformSkillConfig {
  const definition = getProviderDefinition(platform);
  if (!definition) throw new Error(`Unknown platform: ${platform}`);

  const namespace = definition.skillNamespace;
  const baseDir = namespace.pathType === 'home-dir'
    ? `~/${namespace.skillsBaseDir}`
    : namespace.skillsBaseDir;

  return {
    baseDir,
    extension: definition.smithPaths.fileExtension,
    supportsSkills: true,
    supportsSubdirectory: namespace.subdirLayout,
  };
}

/**
 * Resolve platform-specific skill paths
 */
export class PlatformSkillResolver {
  /**
   * Get platform configuration for skills
   */
  static getConfig(platform: Platform): PlatformSkillConfig {
    return getPlatformSkillConfig(platform);
  }

  /**
   * Get base directory for skills on a platform.
   * Supports home-dir paths (baseDir starting with `~/`) for platforms like Codex and OpenClaw.
   */
  static getBaseDir(platform: Platform, projectPath: string): string {
    const config = this.getConfig(platform);
    if (config.baseDir.startsWith('~/')) {
      return path.join(homedir(), config.baseDir.slice(2));
    }
    return path.join(projectPath, config.baseDir);
  }

  /**
   * Get path for a specific skill
   */
  static getSkillPath(
    platform: Platform,
    projectPath: string,
    skillName: string
  ): string {
    const baseDir = this.getBaseDir(platform, projectPath);
    return path.join(baseDir, skillName);
  }

  /**
   * Get path for SKILL.md file
   */
  static getSkillFilePath(
    platform: Platform,
    projectPath: string,
    skillName: string
  ): string {
    const skillPath = this.getSkillPath(platform, projectPath, skillName);
    const config = this.getConfig(platform);
    return path.join(skillPath, `SKILL${config.extension}`);
  }

  /**
   * Get path for references directory
   */
  static getReferencesPath(
    platform: Platform,
    projectPath: string,
    skillName: string
  ): string {
    const skillPath = this.getSkillPath(platform, projectPath, skillName);
    return path.join(skillPath, 'references');
  }

  /**
   * Check if platform natively supports skills
   */
  static supportsSkills(platform: Platform): boolean {
    return this.getConfig(platform).supportsSkills;
  }

  /**
   * Get alternative deployment strategy for platforms without skill support
   */
  static getAlternativeStrategy(
    platform: Platform
  ): 'command' | 'agent' | 'none' | undefined {
    return this.getConfig(platform).alternativeStrategy;
  }

  /**
   * Compute the canonical namespaced slug for a skill.
   *
   * Idempotent: if `name` already starts with `{namespace}-`, returns `name` unchanged.
   * This prevents double-prefixing existing `aiwg-*` skills (e.g. `aiwg-sync` → `aiwg-sync`,
   * not `aiwg-aiwg-sync`).
   *
   * @param name - Skill folder name (e.g. 'sync', 'aiwg-sync')
   * @param namespace - Namespace prefix (e.g. 'aiwg')
   * @returns Canonical slug (e.g. 'aiwg-sync')
   */
  static computeCanonicalSlug(name: string, namespace: string): string {
    const prefix = `${namespace}-`;
    return name.startsWith(prefix) ? name : `${prefix}${name}`;
  }

  /**
   * Get path for a namespaced skill deployment.
   *
   * Platforms with subdirectory support deploy under `{baseDir}/{namespace}/{slug}/`.
   * Devin Desktop (1-level discovery) deploys flat at `{baseDir}/{slug}/`.
   *
   * @param platform - Target platform
   * @param projectPath - Project root directory
   * @param skillName - Skill folder name (e.g. 'sync')
   * @param namespace - Namespace prefix (e.g. 'aiwg')
   * @returns Full deployment directory path
   */
  static getNamespacedSkillPath(
    platform: Platform,
    projectPath: string,
    skillName: string,
    namespace: string
  ): string {
    const config = this.getConfig(platform);
    const slug = this.computeCanonicalSlug(skillName, namespace);
    const baseDir = this.getBaseDir(platform, projectPath);

    if (config.supportsSubdirectory) {
      return path.join(baseDir, namespace, slug);
    }
    // Devin Desktop and other flat-discovery platforms: slug only, no namespace subdir
    return path.join(baseDir, slug);
  }

  /**
   * Get path for the SKILL.md file under namespaced deployment layout.
   *
   * @param platform - Target platform
   * @param projectPath - Project root directory
   * @param skillName - Skill folder name
   * @param namespace - Namespace prefix (e.g. 'aiwg')
   * @returns Full path to SKILL.md
   */
  static getNamespacedSkillFilePath(
    platform: Platform,
    projectPath: string,
    skillName: string,
    namespace: string
  ): string {
    const skillDir = this.getNamespacedSkillPath(platform, projectPath, skillName, namespace);
    const config = this.getConfig(platform);
    return path.join(skillDir, `SKILL${config.extension}`);
  }

  /**
   * Validate skill name format
   */
  static validateSkillName(name: string): { valid: boolean; error?: string } {
    // kebab-case: lowercase letters, numbers, hyphens
    const kebabRegex = /^[a-z][a-z0-9-]*[a-z0-9]$/;

    if (!name) {
      return { valid: false, error: 'Skill name cannot be empty' };
    }

    if (name.length < 2) {
      return { valid: false, error: 'Skill name must be at least 2 characters' };
    }

    if (name.startsWith('-') || name.endsWith('-')) {
      return { valid: false, error: 'Skill name cannot start or end with hyphen' };
    }

    if (!kebabRegex.test(name)) {
      return {
        valid: false,
        error: 'Skill name must be kebab-case (lowercase, alphanumeric, hyphens)',
      };
    }

    return { valid: true };
  }
}
