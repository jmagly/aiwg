/**
 * Plugin Registry Validator
 *
 * Validates registry consistency with filesystem, detects orphaned/missing plugins,
 * and validates cross-framework references.
 *
 * @module src/plugin/registry-validator
 * @implements @.aiwg/requirements/use-cases/UC-011-validate-plugin-security.md
 * @architecture @docs/architecture/cli/index.md
 * @adr @docs/plugin-marketplace-guide.md
 * @tests @test/unit/plugin/registry-validator.test.ts
 * @depends @src/plugin/metadata-validator.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Registry entry structure
 */
export interface RegistryEntry {
  id: string;
  type: 'framework' | 'add-on' | 'extension';
  name: string;
  version: string;
  path: string;
  installedAt: string;
  parentFramework?: string;
  projects?: string[];
  health?: {
    status: 'healthy' | 'warning' | 'error';
    lastCheck: string;
    issues?: string[];
  };
}

/**
 * Registry structure
 */
export interface Registry {
  version: string;
  lastModified: string;
  plugins: RegistryEntry[];
}

/**
 * Validation issue
 */
export interface ValidationIssue {
  type: 'error' | 'warning';
  category: 'orphaned' | 'missing' | 'mismatch' | 'invalid-ref' | 'stale-health';
  pluginId?: string;
  path?: string;
  message: string;
  suggestion?: string;
}

/**
 * Validation result
 */
export interface RegistryValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  stats: {
    totalPlugins: number;
    healthyPlugins: number;
    orphanedPlugins: number;
    missingPlugins: number;
    invalidRefs: number;
  };
}

/**
 * Validation options
 */
export interface RegistryValidationOptions {
  /** Check that filesystem directories match registry entries */
  checkFilesystem?: boolean;
  /** Check parent framework references are valid */
  checkFrameworkRefs?: boolean;
  /** Check health status is not stale (older than threshold) */
  checkHealthStaleness?: boolean;
  /** Health staleness threshold in hours (default: 24) */
  healthStaleThresholdHours?: number;
  /** Auto-fix issues where possible */
  autoFix?: boolean;
}

/**
 * RegistryValidator validates plugin registry consistency
 */
export class RegistryValidator {
  private registryPath: string;
  private aiwgRoot: string;
  private options: RegistryValidationOptions;

  constructor(aiwgRoot: string, options: RegistryValidationOptions = {}) {
    this.aiwgRoot = aiwgRoot;
    this.registryPath = path.join(aiwgRoot, 'registry.json');
    this.options = {
      checkFilesystem: true,
      checkFrameworkRefs: true,
      checkHealthStaleness: true,
      healthStaleThresholdHours: 24,
      autoFix: false,
      ...options
    };
  }

  /**
   * Validate the entire registry
   *
   * @returns Validation result with issues and stats
   */
  async validate(): Promise<RegistryValidationResult> {
    const result: RegistryValidationResult = {
      valid: true,
      issues: [],
      stats: {
        totalPlugins: 0,
        healthyPlugins: 0,
        orphanedPlugins: 0,
        missingPlugins: 0,
        invalidRefs: 0
      }
    };

    // Load registry
    let registry: Registry;
    try {
      registry = await this.loadRegistry();
    } catch (error: any) {
      result.valid = false;
      result.issues.push({
        type: 'error',
        category: 'missing',
        path: this.registryPath,
        message: `Failed to load registry: ${error.message}`,
        suggestion: 'Run "aiwg -init-registry" to create a new registry'
      });
      return result;
    }

    result.stats.totalPlugins = registry.plugins.length;

    // Validate each plugin entry
    for (const plugin of registry.plugins) {
      const pluginIssues = await this.validatePlugin(plugin);
      result.issues.push(...pluginIssues);

      // Track stats
      if (plugin.health?.status === 'healthy') {
        result.stats.healthyPlugins++;
      }
    }

    // Check for orphaned directories (in filesystem but not in registry)
    if (this.options.checkFilesystem) {
      const orphaned = await this.findOrphanedDirectories(registry);
      result.stats.orphanedPlugins = orphaned.length;
      result.issues.push(...orphaned);
    }

    // Check framework references
    if (this.options.checkFrameworkRefs) {
      const invalidRefs = this.validateFrameworkReferences(registry);
      result.stats.invalidRefs = invalidRefs.length;
      result.issues.push(...invalidRefs);
    }

    // Determine overall validity
    result.valid = result.issues.filter(i => i.type === 'error').length === 0;

    return result;
  }

  /**
   * Validate a single plugin entry
   *
   * @param plugin - Plugin registry entry
   * @returns Array of validation issues
   */
  private async validatePlugin(plugin: RegistryEntry): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Check plugin directory exists
    if (this.options.checkFilesystem) {
      const pluginPath = path.join(this.aiwgRoot, plugin.path);
      try {
        const stats = await fs.stat(pluginPath);
        if (!stats.isDirectory()) {
          issues.push({
            type: 'error',
            category: 'mismatch',
            pluginId: plugin.id,
            path: pluginPath,
            message: `Plugin path exists but is not a directory: ${plugin.path}`,
            suggestion: 'Remove the file and reinstall the plugin'
          });
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          issues.push({
            type: 'error',
            category: 'missing',
            pluginId: plugin.id,
            path: pluginPath,
            message: `Plugin directory not found: ${plugin.path}`,
            suggestion: `Run "aiwg -uninstall ${plugin.id}" to remove from registry, or reinstall the plugin`
          });
        }
      }

      // Check manifest exists
      const manifestPath = path.join(pluginPath, 'manifest.json');
      try {
        await fs.stat(manifestPath);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          issues.push({
            type: 'warning',
            category: 'missing',
            pluginId: plugin.id,
            path: manifestPath,
            message: `Plugin manifest not found: ${path.join(plugin.path, 'manifest.json')}`,
            suggestion: 'Plugin may be incomplete or corrupted'
          });
        }
      }
    }

    // Check health staleness
    if (this.options.checkHealthStaleness && plugin.health?.lastCheck) {
      const lastCheck = new Date(plugin.health.lastCheck);
      const now = new Date();
      const hoursSinceCheck = (now.getTime() - lastCheck.getTime()) / (1000 * 60 * 60);

      if (hoursSinceCheck > (this.options.healthStaleThresholdHours || 24)) {
        issues.push({
          type: 'warning',
          category: 'stale-health',
          pluginId: plugin.id,
          message: `Plugin health check is stale (${Math.floor(hoursSinceCheck)} hours old)`,
          suggestion: `Run "aiwg -health-check ${plugin.id}" to update health status`
        });
      }
    }

    return issues;
  }

  /**
   * Find directories in the plugins folder that aren't in the registry
   *
   * @param registry - Current registry
   * @returns Array of validation issues for orphaned directories
   */
  private async findOrphanedDirectories(registry: Registry): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Get registered paths
    const registeredPaths = new Set(registry.plugins.map(p => p.path));

    // Check each plugin type directory
    const pluginDirs = ['frameworks', 'add-ons', 'extensions'];

    for (const dir of pluginDirs) {
      const dirPath = path.join(this.aiwgRoot, dir);

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const relativePath = path.join(dir, entry.name);

            if (!registeredPaths.has(relativePath)) {
              issues.push({
                type: 'warning',
                category: 'orphaned',
                path: path.join(dirPath, entry.name),
                message: `Directory exists but not in registry: ${relativePath}`,
                suggestion: `Run "aiwg -sync-registry" to add missing entries, or delete the directory`
              });
            }
          }
        }
      } catch (error: any) {
        // Directory may not exist, which is fine
        if (error.code !== 'ENOENT') {
          issues.push({
            type: 'warning',
            category: 'mismatch',
            path: dirPath,
            message: `Failed to scan directory: ${error.message}`
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate parent framework references
   *
   * @param registry - Current registry
   * @returns Array of validation issues for invalid references
   */
  private validateFrameworkReferences(registry: Registry): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Get all framework IDs
    const frameworkIds = new Set(
      registry.plugins
        .filter(p => p.type === 'framework')
        .map(p => p.id)
    );

    // Check add-ons and extensions reference valid frameworks
    for (const plugin of registry.plugins) {
      if (plugin.parentFramework && !frameworkIds.has(plugin.parentFramework)) {
        issues.push({
          type: 'error',
          category: 'invalid-ref',
          pluginId: plugin.id,
          message: `Plugin "${plugin.id}" references non-existent framework: ${plugin.parentFramework}`,
          suggestion: `Install the parent framework or update the plugin's parentFramework field`
        });
      }
    }

    return issues;
  }

  /**
   * Validate registry against filesystem and return consistency status
   *
   * @returns True if registry and filesystem are consistent
   */
  async isConsistent(): Promise<boolean> {
    const result = await this.validate();
    return result.valid;
  }

  /**
   * Get orphaned plugins (in registry but not filesystem)
   *
   * @returns Array of orphaned plugin IDs
   */
  async getOrphanedPlugins(): Promise<string[]> {
    const result = await this.validate();
    return result.issues
      .filter(i => i.category === 'missing' && i.pluginId)
      .map(i => i.pluginId!);
  }

  /**
   * Get missing plugins (in filesystem but not registry)
   *
   * @returns Array of directory paths not in registry
   */
  async getMissingPlugins(): Promise<string[]> {
    const result = await this.validate();
    return result.issues
      .filter(i => i.category === 'orphaned' && i.path)
      .map(i => i.path!);
  }

  /**
   * Generate a validation report
   *
   * @param format - Report format (text or json)
   * @returns Formatted report string
   */
  async generateReport(format: 'text' | 'json' = 'text'): Promise<string> {
    const result = await this.validate();

    if (format === 'json') {
      return JSON.stringify(result, null, 2);
    }

    return this.generateTextReport(result);
  }

  /**
   * Load and parse registry file
   */
  private async loadRegistry(): Promise<Registry> {
    const content = await fs.readFile(this.registryPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Generate text format report
   */
  private generateTextReport(result: RegistryValidationResult): string {
    const lines: string[] = [];

    // Header
    lines.push('Registry Validation Report');
    lines.push('='.repeat(50));
    lines.push('');

    // Summary
    const statusIcon = result.valid ? '✓' : '✗';
    const statusText = result.valid ? 'VALID' : 'INVALID';
    lines.push(`Status: ${statusIcon} ${statusText}`);
    lines.push('');

    // Stats
    lines.push('Statistics:');
    lines.push(`  Total Plugins:    ${result.stats.totalPlugins}`);
    lines.push(`  Healthy:          ${result.stats.healthyPlugins}`);
    lines.push(`  Orphaned:         ${result.stats.orphanedPlugins}`);
    lines.push(`  Missing:          ${result.stats.missingPlugins}`);
    lines.push(`  Invalid Refs:     ${result.stats.invalidRefs}`);
    lines.push('');

    // Issues
    if (result.issues.length > 0) {
      lines.push('Issues:');
      lines.push('-'.repeat(50));

      const errors = result.issues.filter(i => i.type === 'error');
      const warnings = result.issues.filter(i => i.type === 'warning');

      if (errors.length > 0) {
        lines.push('\nErrors:');
        for (const issue of errors) {
          const plugin = issue.pluginId ? `[${issue.pluginId}] ` : '';
          lines.push(`  ✗ ${plugin}${issue.message}`);
          if (issue.suggestion) {
            lines.push(`    → ${issue.suggestion}`);
          }
        }
      }

      if (warnings.length > 0) {
        lines.push('\nWarnings:');
        for (const issue of warnings) {
          const plugin = issue.pluginId ? `[${issue.pluginId}] ` : '';
          lines.push(`  ⚠ ${plugin}${issue.message}`);
          if (issue.suggestion) {
            lines.push(`    → ${issue.suggestion}`);
          }
        }
      }
    } else {
      lines.push('No issues found.');
    }

    lines.push('');
    lines.push('='.repeat(50));

    return lines.join('\n');
  }
}
