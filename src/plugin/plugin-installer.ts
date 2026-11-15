/**
 * Plugin Installation System
 *
 * Comprehensive installer supporting frameworks, add-ons, and extensions
 * with dependency resolution, registry management, and atomic installation.
 *
 * Features:
 * - Install from local path or plugin ID
 * - Dependency resolution (add-ons require parent framework)
 * - Automatic registry updates
 * - Directory structure creation
 * - Manifest validation
 * - Atomic installation (rollback on failure)
 * - Dry-run mode
 *
 * @module src/plugin/plugin-installer
 * @implements @.aiwg/requirements/use-cases/UC-010-rollback-plugin-installation.md
 * @architecture @docs/architecture/cli/index.md
 * @adr @docs/plugin-marketplace-guide.md
 * @nfr @.aiwg/requirements/nfr-modules/reliability.md - NFR-REL-002 (zero data loss)
 * @tests @test/unit/plugin/plugin-installer.test.ts
 * @depends @src/plugin/metadata-validator.ts
 * @depends @src/plugin/framework-config-loader.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Plugin types
 */
export type PluginType = 'framework' | 'add-on' | 'extension';

/**
 * Plugin manifest structure
 */
export interface PluginManifest {
  /** Plugin identifier */
  id: string;
  /** Plugin type */
  type: PluginType;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Description */
  description: string;
  /** Author */
  author?: string;
  /** License */
  license?: string;
  /** Repository URL */
  repository?: string;
  /** Required parent framework (for add-ons) */
  parentFramework?: string;
  /** Dependencies on other plugins */
  dependencies?: Record<string, string>;
  /** Entry points */
  entry?: {
    agents?: string;
    commands?: string;
    templates?: string;
  };
  /** Keywords for search */
  keywords?: string[];
}

/**
 * Installation options
 */
export interface InstallOptions {
  /** Plugin type (required if installing from local path) */
  type?: PluginType;
  /** Parent framework ID (required for add-ons) */
  parentFramework?: string;
  /** Dry-run mode (preview without executing) */
  dryRun?: boolean;
  /** Force reinstallation even if already installed */
  force?: boolean;
  /** Custom target directory */
  targetDir?: string;
  /** Skip dependency check */
  skipDependencyCheck?: boolean;
}

/**
 * Installation result
 */
export interface InstallResult {
  /** Whether installation succeeded */
  success: boolean;
  /** Plugin ID */
  pluginId: string;
  /** Plugin version */
  version: string;
  /** Installation path */
  installPath: string;
  /** Actions taken */
  actions: InstallAction[];
  /** Errors encountered */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/**
 * Single installation action
 */
export interface InstallAction {
  /** Action type */
  type: 'create-dir' | 'copy-file' | 'update-registry' | 'validate' | 'rollback';
  /** Action description */
  description: string;
  /** Path affected */
  path?: string;
  /** Whether action was executed or just planned (dry-run) */
  executed: boolean;
}

/**
 * Registry entry structure (simplified)
 */
interface RegistryEntry {
  id: string;
  type: PluginType;
  name: string;
  version: string;
  path: string;
  installedAt: string;
  parentFramework?: string;
  health?: {
    status: 'healthy' | 'warning' | 'error';
    lastCheck: string;
  };
}

/**
 * Registry structure
 */
interface Registry {
  version: string;
  lastModified: string;
  plugins: RegistryEntry[];
}

/**
 * PluginInstaller - Install and manage plugins
 *
 * @example
 * ```typescript
 * const installer = new PluginInstaller('~/.local/share/ai-writing-guide');
 *
 * // Install framework
 * const result = await installer.install('/path/to/sdlc-complete');
 *
 * // Install add-on with parent
 * const addonResult = await installer.install('/path/to/gdpr-compliance', {
 *   type: 'add-on',
 *   parentFramework: 'sdlc-complete'
 * });
 *
 * // Dry-run preview
 * const preview = await installer.install('/path/to/plugin', { dryRun: true });
 * ```
 */
export class PluginInstaller {
  private aiwgRoot: string;
  private registryPath: string;
  private rollbackActions: Array<() => Promise<void>> = [];

  constructor(aiwgRoot: string) {
    this.aiwgRoot = aiwgRoot;
    this.registryPath = path.join(aiwgRoot, 'registry.json');
  }

  /**
   * Install a plugin from a source path
   *
   * @param source - Path to plugin directory or plugin ID
   * @param options - Installation options
   * @returns Installation result
   */
  async install(source: string, options: InstallOptions = {}): Promise<InstallResult> {
    const result: InstallResult = {
      success: false,
      pluginId: '',
      version: '',
      installPath: '',
      actions: [],
      errors: [],
      warnings: []
    };

    this.rollbackActions = [];

    try {
      // Step 1: Load and validate manifest
      const manifest = await this.loadManifest(source);
      result.pluginId = manifest.id;
      result.version = manifest.version;

      result.actions.push({
        type: 'validate',
        description: `Validated manifest for ${manifest.name} v${manifest.version}`,
        executed: true
      });

      // Override type if specified
      if (options.type) {
        manifest.type = options.type;
      }

      // Override parent framework if specified
      if (options.parentFramework) {
        manifest.parentFramework = options.parentFramework;
      }

      // Step 2: Check if already installed
      const isInstalled = await this.isPluginInstalled(manifest.id);
      if (isInstalled && !options.force) {
        result.errors.push(`Plugin '${manifest.id}' is already installed. Use --force to reinstall.`);
        return result;
      }

      if (isInstalled && options.force) {
        result.warnings.push(`Reinstalling existing plugin '${manifest.id}'`);
      }

      // Step 3: Validate dependencies
      if (!options.skipDependencyCheck) {
        const depErrors = await this.validateDependencies(manifest);
        if (depErrors.length > 0) {
          result.errors.push(...depErrors);
          return result;
        }
      }

      // Step 4: Calculate installation path
      const targetDir = options.targetDir || this.aiwgRoot;
      const installPath = this.getInstallPath(manifest.type, manifest.id, targetDir);
      result.installPath = installPath;

      // Step 5: Create directory structure
      if (!options.dryRun) {
        await this.createDirectoryStructure(manifest.type, manifest.id, targetDir, result);
      } else {
        result.actions.push({
          type: 'create-dir',
          description: `Would create directory structure at ${installPath}`,
          path: installPath,
          executed: false
        });
      }

      // Step 6: Copy plugin files
      if (!options.dryRun) {
        await this.copyPluginFiles(source, installPath, result);
      } else {
        result.actions.push({
          type: 'copy-file',
          description: `Would copy plugin files from ${source} to ${installPath}`,
          path: installPath,
          executed: false
        });
      }

      // Step 7: Update registry
      if (!options.dryRun) {
        await this.updateRegistry(manifest, installPath, result);
      } else {
        result.actions.push({
          type: 'update-registry',
          description: `Would update registry with ${manifest.id}`,
          path: this.registryPath,
          executed: false
        });
      }

      result.success = true;

    } catch (error) {
      result.errors.push(`Installation failed: ${(error as Error).message}`);

      // Rollback on failure
      if (!options.dryRun && this.rollbackActions.length > 0) {
        result.actions.push({
          type: 'rollback',
          description: 'Rolling back changes due to error',
          executed: true
        });

        await this.rollback();
      }
    }

    return result;
  }

  /**
   * Load and validate plugin manifest
   */
  private async loadManifest(source: string): Promise<PluginManifest> {
    const manifestPath = path.join(source, 'manifest.json');

    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as PluginManifest;

      // Validate required fields
      this.validateManifest(manifest);

      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Manifest not found at ${manifestPath}. Ensure the plugin has a valid manifest.json`);
      }
      throw error;
    }
  }

  /**
   * Validate manifest has required fields
   */
  private validateManifest(manifest: PluginManifest): void {
    const required = ['id', 'type', 'name', 'version'];
    const missing = required.filter(field => !(field in manifest));

    if (missing.length > 0) {
      throw new Error(`Manifest missing required fields: ${missing.join(', ')}`);
    }

    // Validate plugin ID format
    if (!/^[a-z0-9-]+$/.test(manifest.id)) {
      throw new Error(`Invalid plugin ID '${manifest.id}'. Use lowercase letters, numbers, and hyphens only.`);
    }

    // Validate version format (semver-like)
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      throw new Error(`Invalid version '${manifest.version}'. Use semver format (e.g., 1.0.0).`);
    }

    // Validate type
    const validTypes: PluginType[] = ['framework', 'add-on', 'extension'];
    if (!validTypes.includes(manifest.type)) {
      throw new Error(`Invalid plugin type '${manifest.type}'. Must be one of: ${validTypes.join(', ')}`);
    }

    // Add-ons require parentFramework
    if (manifest.type === 'add-on' && !manifest.parentFramework) {
      throw new Error(`Add-on plugins require a 'parentFramework' field in manifest.json`);
    }
  }

  /**
   * Check if plugin is already installed
   */
  private async isPluginInstalled(pluginId: string): Promise<boolean> {
    try {
      const registry = await this.loadRegistry();
      return registry.plugins.some(p => p.id === pluginId);
    } catch {
      return false;
    }
  }

  /**
   * Validate plugin dependencies
   */
  private async validateDependencies(manifest: PluginManifest): Promise<string[]> {
    const errors: string[] = [];

    // Check parent framework for add-ons
    if (manifest.type === 'add-on' && manifest.parentFramework) {
      const parentInstalled = await this.isPluginInstalled(manifest.parentFramework);
      if (!parentInstalled) {
        errors.push(
          `Parent framework '${manifest.parentFramework}' is not installed. ` +
          `Install it first: aiwg -install-plugin ${manifest.parentFramework}`
        );
      }
    }

    // Check other dependencies
    if (manifest.dependencies) {
      for (const [depId, depVersion] of Object.entries(manifest.dependencies)) {
        const depInstalled = await this.isPluginInstalled(depId);
        if (!depInstalled) {
          errors.push(
            `Required dependency '${depId}' (${depVersion}) is not installed. ` +
            `Install it first: aiwg -install-plugin ${depId}`
          );
        }
      }
    }

    return errors;
  }

  /**
   * Get installation path for plugin type
   */
  private getInstallPath(type: PluginType, pluginId: string, targetDir: string): string {
    const typeDir = type === 'add-on' ? 'add-ons' : `${type}s`;
    return path.join(targetDir, typeDir, pluginId);
  }

  /**
   * Create directory structure for plugin
   */
  private async createDirectoryStructure(
    type: PluginType,
    pluginId: string,
    targetDir: string,
    result: InstallResult
  ): Promise<void> {
    const basePath = this.getInstallPath(type, pluginId, targetDir);

    // Define directory structure based on type
    const dirs: string[] = [basePath];

    if (type === 'framework') {
      dirs.push(
        path.join(basePath, 'repo'),
        path.join(basePath, 'projects'),
        path.join(basePath, 'working'),
        path.join(basePath, 'archive')
      );
    }

    // Create directories
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      result.actions.push({
        type: 'create-dir',
        description: `Created directory: ${path.relative(this.aiwgRoot, dir)}`,
        path: dir,
        executed: true
      });

      // Add rollback action
      this.rollbackActions.push(async () => {
        await fs.rm(dir, { recursive: true, force: true });
      });
    }
  }

  /**
   * Copy plugin files to installation directory
   */
  private async copyPluginFiles(source: string, dest: string, result: InstallResult): Promise<void> {
    // For frameworks, copy to repo subdirectory
    const targetPath = dest.includes('/frameworks/') ? path.join(dest, 'repo') : dest;

    await this.copyDirectory(source, targetPath);

    result.actions.push({
      type: 'copy-file',
      description: `Copied plugin files to ${path.relative(this.aiwgRoot, targetPath)}`,
      path: targetPath,
      executed: true
    });

    // Add rollback action
    this.rollbackActions.push(async () => {
      await fs.rm(targetPath, { recursive: true, force: true });
    });
  }

  /**
   * Recursively copy directory
   */
  private async copyDirectory(source: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Update registry with new plugin
   */
  private async updateRegistry(
    manifest: PluginManifest,
    installPath: string,
    result: InstallResult
  ): Promise<void> {
    let registry: Registry;

    try {
      registry = await this.loadRegistry();
    } catch {
      // Create new registry if it doesn't exist
      registry = {
        version: '1.0.0',
        lastModified: new Date().toISOString(),
        plugins: []
      };
    }

    // Save old state for rollback
    const oldContent = JSON.stringify(registry, null, 2);
    this.rollbackActions.push(async () => {
      await fs.writeFile(this.registryPath, oldContent, 'utf-8');
    });

    // Remove existing entry if force reinstall
    registry.plugins = registry.plugins.filter(p => p.id !== manifest.id);

    // Add new entry
    const relativePath = path.relative(this.aiwgRoot, installPath);
    const entry: RegistryEntry = {
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      path: relativePath,
      installedAt: new Date().toISOString(),
      health: {
        status: 'healthy',
        lastCheck: new Date().toISOString()
      }
    };

    if (manifest.parentFramework) {
      entry.parentFramework = manifest.parentFramework;
    }

    registry.plugins.push(entry);
    registry.lastModified = new Date().toISOString();

    // Ensure registry directory exists
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });

    // Write registry
    await fs.writeFile(this.registryPath, JSON.stringify(registry, null, 2), 'utf-8');

    result.actions.push({
      type: 'update-registry',
      description: `Updated registry: added ${manifest.id} v${manifest.version}`,
      path: this.registryPath,
      executed: true
    });
  }

  /**
   * Load registry file
   */
  private async loadRegistry(): Promise<Registry> {
    const content = await fs.readFile(this.registryPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Rollback changes on failure
   */
  private async rollback(): Promise<void> {
    // Execute rollback actions in reverse order
    for (let i = this.rollbackActions.length - 1; i >= 0; i--) {
      try {
        await this.rollbackActions[i]();
      } catch {
        // Ignore rollback errors
      }
    }
    this.rollbackActions = [];
  }

  /**
   * List installed plugins
   */
  async listInstalled(): Promise<RegistryEntry[]> {
    try {
      const registry = await this.loadRegistry();
      return registry.plugins;
    } catch {
      return [];
    }
  }

  /**
   * Get plugin info by ID
   */
  async getPluginInfo(pluginId: string): Promise<RegistryEntry | null> {
    try {
      const registry = await this.loadRegistry();
      return registry.plugins.find(p => p.id === pluginId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Validate manifest without installing
   */
  async validatePlugin(source: string): Promise<{
    valid: boolean;
    manifest?: PluginManifest;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      const manifest = await this.loadManifest(source);
      return { valid: true, manifest, errors };
    } catch (error) {
      errors.push((error as Error).message);
      return { valid: false, errors };
    }
  }
}

/**
 * Create a PluginInstaller with default AIWG root
 */
export function createInstaller(): PluginInstaller {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const aiwgRoot = path.join(homeDir, '.local', 'share', 'ai-writing-guide');
  return new PluginInstaller(aiwgRoot);
}
