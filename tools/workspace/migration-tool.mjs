/**
 * Migration Tool for Framework-Scoped Workspace Management
 *
 * Safely migrates legacy .aiwg/ structure to framework-scoped organization.
 * Implements ADR-006 reset + redeploy pattern with comprehensive safety checks.
 *
 * @module tools/workspace/migration-tool
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { glob } from 'glob';
import { importImpl } from '../_resolve-impl.mjs';

/**
 * Migration validation error
 */
class MigrationValidationError extends Error {
  constructor(failedChecks) {
    const messages = failedChecks.map(([name, result]) =>
      `${name}: ${result.error || 'FAILED'}`
    ).join('\n  ');
    super(`Migration validation failed:\n  ${messages}`);
    this.name = 'MigrationValidationError';
    this.failedChecks = failedChecks;
  }
}

/**
 * Migration execution error
 */
class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Rollback error
 */
class RollbackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RollbackError';
  }
}

/**
 * MigrationTool - Safely migrate legacy .aiwg/ to framework-scoped structure
 *
 * Migration Mapping:
 * - .aiwg/intake/           → .aiwg/frameworks/sdlc-complete/projects/{project-id}/intake/
 * - .aiwg/requirements/     → .aiwg/frameworks/sdlc-complete/projects/{project-id}/requirements/
 * - .aiwg/architecture/     → .aiwg/frameworks/sdlc-complete/projects/{project-id}/architecture/
 * - .aiwg/planning/         → .aiwg/frameworks/sdlc-complete/projects/{project-id}/planning/
 * - .aiwg/testing/          → .aiwg/frameworks/sdlc-complete/projects/{project-id}/testing/
 * - .aiwg/security/         → .aiwg/frameworks/sdlc-complete/projects/{project-id}/security/
 * - .aiwg/deployment/       → .aiwg/frameworks/sdlc-complete/projects/{project-id}/deployment/
 * - .aiwg/risks/            → .aiwg/frameworks/sdlc-complete/projects/{project-id}/risks/
 * - .aiwg/gates/            → .aiwg/frameworks/sdlc-complete/projects/{project-id}/gates/
 * - .aiwg/reports/          → .aiwg/frameworks/sdlc-complete/projects/{project-id}/reports/
 * - .aiwg/team/             → .aiwg/frameworks/sdlc-complete/projects/{project-id}/team/
 * - .aiwg/working/          → .aiwg/frameworks/sdlc-complete/working/
 *
 * Safety Features:
 * - Pre-migration validation (disk space, permissions, conflicts)
 * - Full backup before migration
 * - Checksum validation (no data loss)
 * - Internal reference updates (paths in markdown)
 * - Rollback support (<5s target)
 * - Dry-run mode (preview changes)
 * - Incremental migration for large projects (>1GB)
 */
export class MigrationTool {
  /**
   * Create migration tool
   * @param {string} basePath - Base path for .aiwg/ directory (default: '.aiwg')
   */
  constructor(basePath = '.aiwg') {
    this.basePath = basePath;
    this.migrationLockFile = path.join(basePath, '.migration-lock');

    // Legacy directory mapping (project-level artifacts)
    this.projectDirMapping = {
      'intake': 'intake',
      'requirements': 'requirements',
      'architecture': 'architecture',
      'planning': 'planning',
      'testing': 'testing',
      'security': 'security',
      'deployment': 'deployment',
      'risks': 'risks',
      'gates': 'gates',
      'reports': 'reports',
      'team': 'team',
      'quality': 'quality',
      'handoffs': 'handoffs',
      'decisions': 'decisions'
    };

    // Working area (shared across projects)
    this.workingDir = 'working';
  }

  // ==================== PRE-MIGRATION VALIDATION ====================

  /**
   * Validate migration prerequisites
   * @returns {Promise<{passed: boolean, checks: Object}>}
   * @throws {MigrationValidationError} If validation fails
   */
  async validate() {
    const checks = {
      diskSpace: await this.checkDiskSpace(),
      permissions: await this.checkPermissions(),
      conflicts: await this.detectConflicts(),
      lock: await this.checkMigrationLock()
    };

    const failed = Object.entries(checks).filter(([, result]) => !result.passed);

    if (failed.length > 0) {
      throw new MigrationValidationError(failed);
    }

    return { passed: true, checks };
  }

  /**
   * Check disk space (need 2x current .aiwg/ size for backup)
   * @returns {Promise<{passed: boolean, available: number, required: number}>}
   */
  async checkDiskSpace() {
    try {
      const aiwgSize = await this._getDirectorySize(this.basePath);
      const requiredSpace = aiwgSize * 2; // Need 2x for backup

      // Get available disk space (platform-specific)
      const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
      let availableBytes;

      if (process.platform === 'win32') {
        // Windows: use fsutil (returns bytes free)
        const drive = path.parse(process.cwd()).root;
        const output = boundedExecFileSync('fsutil', ['volume', 'diskfree', drive], 'quick').toString();
        const match = output.match(/Total # of free bytes\s+:\s+(\d+)/);
        availableBytes = match ? parseInt(match[1], 10) : Infinity;
      } else {
        // Unix-like: use df (returns KB available)
        const output = boundedExecFileSync('df', ['-k', process.cwd()], 'quick').toString();
        const parts = output.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
        availableBytes = parseInt(parts[3], 10) * 1024; // Convert KB to bytes
      }

      return {
        passed: availableBytes >= requiredSpace,
        available: availableBytes,
        required: requiredSpace,
        error: availableBytes < requiredSpace
          ? `Insufficient disk space. Need ${this._formatBytes(requiredSpace)}, have ${this._formatBytes(availableBytes)}`
          : null
      };
    } catch (error) {
      // If we can't determine disk space, warn but don't fail
      console.warn('⚠️ Could not determine disk space:', error.message);
      return { passed: true, available: Infinity, required: 0, warning: error.message };
    }
  }

  /**
   * Check write permissions
   * @returns {Promise<{passed: boolean}>}
   */
  async checkPermissions() {
    try {
      // Test write access to .aiwg/
      const testFile = path.join(this.basePath, '.migration-test');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);

      // Test ability to create frameworks directory
      const frameworksDir = path.join(this.basePath, 'frameworks');
      await fs.mkdir(frameworksDir, { recursive: true });

      return { passed: true };
    } catch (error) {
      return {
        passed: false,
        error: `No write permission to ${this.basePath}: ${error.message}`
      };
    }
  }

  /**
   * Detect conflicts (framework structure already exists)
   * @returns {Promise<{passed: boolean, conflicts: string[]}>}
   */
  async detectConflicts() {
    const conflicts = [];
    const frameworksDir = path.join(this.basePath, 'frameworks');

    try {
      // Check if frameworks directory already has project files
      const sdlcProjectsDir = path.join(frameworksDir, 'sdlc-complete', 'projects');

      if (await this._exists(sdlcProjectsDir)) {
        const entries = await fs.readdir(sdlcProjectsDir);
        if (entries.length > 0) {
          conflicts.push(`Framework projects directory not empty: ${sdlcProjectsDir}`);
        }
      }

      return {
        passed: conflicts.length === 0,
        conflicts,
        error: conflicts.length > 0
          ? `Migration target already exists. Run with --force to overwrite.`
          : null
      };
    } catch (error) {
      // If frameworks directory doesn't exist, that's fine
      return { passed: true, conflicts: [] };
    }
  }

  /**
   * Check for migration lock (prevent concurrent migrations)
   * @returns {Promise<{passed: boolean}>}
   */
  async checkMigrationLock() {
    const lockExists = await this._exists(this.migrationLockFile);

    if (lockExists) {
      try {
        const lockContent = await fs.readFile(this.migrationLockFile, 'utf8');
        const lockData = JSON.parse(lockContent);
        return {
          passed: false,
          error: `Migration already in progress (started ${lockData.timestamp})`
        };
      } catch {
        // Corrupted lock file, can proceed
        await fs.unlink(this.migrationLockFile).catch(() => {});
        return { passed: true };
      }
    }

    return { passed: true };
  }

  // ==================== MIGRATION OPERATIONS ====================

  /**
   * Execute full migration
   * @param {Object} options - Migration options
   * @param {string} options.projectId - Target project ID (default: derived from package.json or 'default-project')
   * @param {string} options.frameworkId - Target framework (default: 'sdlc-complete')
   * @param {boolean} options.dryRun - Preview only, don't execute (default: false)
   * @param {boolean} options.force - Overwrite existing framework structure (default: false)
   * @param {boolean} options.skipBackup - Skip backup creation (NOT RECOMMENDED, default: false)
   * @returns {Promise<{success: boolean, backupPath?: string, migratedFiles: number}>}
   */
  async migrate(options = {}) {
    const {
      projectId = await this._deriveProjectId(),
      frameworkId = 'sdlc-complete',
      dryRun = false,
      force = false,
      skipBackup = false
    } = options;

    // Dry-run mode
    if (dryRun) {
      return await this.dryRun(projectId, frameworkId);
    }

    // Create migration lock
    await this._createLock();

    try {
      // Pre-migration validation
      if (!force) {
        await this.validate();
      }

      // Analyze existing structure
      const analysis = await this.analyzeExistingStructure();

      // Check if incremental migration needed (>1GB)
      const useIncremental = analysis.totalSize > 1024 * 1024 * 1024;

      // Create backup
      let backupPath = null;
      if (!skipBackup) {
        console.log('Creating backup...');
        backupPath = await this.createBackup();
        console.log(`✓ Backup created: ${backupPath}`);
      }

      // Execute migration
      let migratedFiles;
      if (useIncremental) {
        console.log('⚠️ Large project detected. Using incremental migration...');
        migratedFiles = await this._migrateIncrementally(projectId, frameworkId, analysis);
      } else {
        migratedFiles = await this._executeMigration(projectId, frameworkId, analysis);
      }

      // Update internal references
      console.log('Updating internal references...');
      await this.updateInternalReferences(projectId, frameworkId);

      // Validate migration
      console.log('Validating migration...');
      const validation = await this.verifyMigration(backupPath, projectId, frameworkId);

      if (!validation.passed) {
        throw new MigrationError('Migration validation failed. Rolling back...');
      }

      // Remove migration lock
      await this._removeLock();

      console.log(`✓ Migration complete: ${migratedFiles} files migrated`);

      return {
        success: true,
        backupPath,
        migratedFiles,
        projectId,
        frameworkId
      };
    } catch (error) {
      console.error('✗ Migration failed:', error.message);

      // Automatic rollback on failure
      if (!skipBackup) {
        console.log('Attempting automatic rollback...');
        try {
          await this.rollback();
          console.log('✓ Rollback successful');
        } catch (rollbackError) {
          console.error('✗ Rollback failed:', rollbackError.message);
          console.error('⚠️ System may be in inconsistent state. Manual recovery required.');
        }
      }

      // Remove lock
      await this._removeLock();

      throw error;
    }
  }

  /**
   * Preview migration without executing
   * @param {string} projectId - Target project ID
   * @param {string} frameworkId - Target framework ID
   * @returns {Promise<{dryRun: true, actions: Array, totalFiles: number, estimatedTime: string}>}
   */
  async dryRun(projectId, frameworkId) {
    const analysis = await this.analyzeExistingStructure();
    const actions = [];

    // Detect legacy directories
    for (const [legacyDir, targetSubdir] of Object.entries(this.projectDirMapping)) {
      const source = path.join(this.basePath, legacyDir);

      if (await this._exists(source)) {
        const target = path.join(
          this.basePath,
          'frameworks',
          frameworkId,
          'projects',
          projectId,
          targetSubdir
        );

        const fileCount = await this._countFiles(source);
        const size = await this._getDirectorySize(source);

        actions.push({
          action: 'move',
          source,
          target,
          fileCount,
          size: this._formatBytes(size)
        });
      }
    }

    // Working directory
    const workingSource = path.join(this.basePath, this.workingDir);
    if (await this._exists(workingSource)) {
      const workingTarget = path.join(
        this.basePath,
        'frameworks',
        frameworkId,
        'working'
      );

      const fileCount = await this._countFiles(workingSource);
      const size = await this._getDirectorySize(workingSource);

      actions.push({
        action: 'move',
        source: workingSource,
        target: workingTarget,
        fileCount,
        size: this._formatBytes(size)
      });
    }

    // Estimate reference updates
    const mdFiles = await glob(`${this.basePath}/**/*.md`);
    actions.push({
      action: 'update-references',
      fileCount: mdFiles.length,
      estimatedReferences: mdFiles.length * 3 // Rough estimate
    });

    const totalFiles = actions.reduce((sum, a) => sum + (a.fileCount || 0), 0);
    const estimatedTime = totalFiles > 100 ? '10-15 seconds' : '5-10 seconds';

    return {
      dryRun: true,
      actions,
      totalFiles,
      estimatedTime,
      projectId,
      frameworkId
    };
  }

  // ==================== BACKUP/RESTORE ====================

  /**
   * Create full backup of .aiwg/
   * @returns {Promise<string>} Backup directory path
   */
  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.basePath}.backup.${timestamp}`;

    // Copy entire .aiwg/ to backup
    await this._copyDirectory(this.basePath, backupPath);

    // Create manifest
    const manifest = {
      timestamp,
      sourcePath: this.basePath,
      backupPath,
      checksum: await this.computeChecksum(this.basePath),
      fileCount: await this._countFiles(this.basePath),
      totalSize: await this._getDirectorySize(this.basePath)
    };

    await fs.writeFile(
      path.join(backupPath, 'migration-manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return backupPath;
  }

  /**
   * Rollback to most recent backup
   * @returns {Promise<{restoredFrom: string, checksum: string, timestamp: string}>}
   * @throws {RollbackError} If rollback fails
   */
  async rollback(backupPath = null) {
    const backups = await this.listBackups();

    if (!backupPath && backups.length === 0) {
      throw new RollbackError('No backups found. Cannot rollback.');
    }

    let latestBackup = backupPath || backups[0];
    const relativeToWorkspace = path.relative(this.basePath, latestBackup);
    if (relativeToWorkspace && !relativeToWorkspace.startsWith('..') && !path.isAbsolute(relativeToWorkspace)) {
      const preservedBackup = `${this.basePath}.backup.${path.basename(latestBackup)}`;
      await fs.rm(preservedBackup, { recursive: true, force: true });
      await this._copyDirectory(latestBackup, preservedBackup);
      latestBackup = preservedBackup;
    }

    // Verify backup integrity when a manifest is available. Legacy internal
    // WorkspaceMigrator backups predate manifests but remain recoverable.
    const manifestPath = path.join(latestBackup, 'migration-manifest.json');
    let manifest = null;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      manifest = null;
    }

    const currentChecksum = await this.computeChecksum(latestBackup);
    if (manifest?.checksum && currentChecksum !== manifest.checksum) {
      throw new RollbackError('Backup corrupted. Checksum mismatch.');
    }

    // Remove current .aiwg/
    await fs.rm(this.basePath, { recursive: true, force: true });

    // Restore from backup
    await this._copyDirectory(latestBackup, this.basePath);
    await fs.unlink(path.join(this.basePath, 'migration-manifest.json')).catch(() => {});

    console.log(`✓ Restored from ${latestBackup}`);

    return {
      restoredFrom: latestBackup,
      checksum: currentChecksum,
      timestamp: manifest?.timestamp || new Date().toISOString()
    };
  }

  /**
   * List available backups (sorted newest first)
   * @returns {Promise<string[]>} Array of backup directory paths
   */
  async listBackups() {
    const parentDir = path.dirname(this.basePath);
    const baseName = path.basename(this.basePath);

    try {
      const entries = await fs.readdir(parentDir);
      const externalBackups = entries
        .filter(name => name.startsWith(`${baseName}.backup.`))
        .map(name => path.join(parentDir, name));
      const internalBackupsDir = path.join(this.basePath, 'backups');
      let internalBackups = [];
      try {
        internalBackups = (await fs.readdir(internalBackupsDir))
          .filter(name => name.startsWith('migration-'))
          .map(name => path.join(internalBackupsDir, name));
      } catch {
        // Legacy internal backup directory does not exist.
      }
      const backups = [...externalBackups, ...internalBackups];
      const withMtime = await Promise.all(backups.map(async backup => ({
        backup,
        mtimeMs: (await fs.stat(backup)).mtimeMs
      })));

      return withMtime
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(entry => entry.backup);
    } catch {
      return [];
    }
  }

  /**
   * Clean old backups
   * @param {number} olderThanDays - Delete backups older than N days
   * @returns {Promise<number>} Number of backups deleted
   */
  async cleanBackups(olderThanDays) {
    const backups = await this.listBackups();
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    let deleted = 0;

    for (const backupPath of backups) {
      try {
        const manifestPath = path.join(backupPath, 'migration-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const backupDate = new Date(manifest.timestamp);

        if (backupDate < cutoffDate) {
          await fs.rm(backupPath, { recursive: true, force: true });
          deleted++;
          console.log(`Deleted old backup: ${backupPath}`);
        }
      } catch {
        // Skip if can't read manifest
        continue;
      }
    }

    return deleted;
  }

  // ==================== REFERENCE UPDATES ====================

  /**
   * Update internal references in markdown files
   * @param {string} projectId - Project ID for path replacement
   * @param {string} frameworkId - Framework ID for path replacement
   * @returns {Promise<number>} Number of files updated
   */
  async updateInternalReferences(projectId, frameworkId) {
    const mdFiles = await glob(`${this.basePath}/**/*.md`);

    const mapping = this._buildPathMapping(projectId, frameworkId);
    let updatedCount = 0;

    for (const file of mdFiles) {
      const content = await fs.readFile(file, 'utf8');
      const updated = this.replaceReferences(content, mapping);

      if (updated !== content) {
        await fs.writeFile(file, updated, 'utf8');
        updatedCount++;
      }
    }

    return updatedCount;
  }

  /**
   * Find .aiwg/ path references in content
   * @param {string} content - File content
   * @returns {string[]} Array of found references
   */
  findReferences(content) {
    const regex = /\.aiwg\/(intake|requirements|architecture|planning|testing|security|deployment|risks|gates|reports|team|working|quality|handoffs|decisions)\//g;
    const matches = [...content.matchAll(regex)];
    return [...new Set(matches.map(m => m[0]))]; // Unique references
  }

  /**
   * Replace references with new paths
   * @param {string} content - File content
   * @param {Object} mapping - Old path → new path mapping
   * @returns {string} Updated content
   */
  replaceReferences(content, mapping) {
    let updated = content;

    for (const [oldPath, newPath] of Object.entries(mapping)) {
      // Escape special regex characters in path
      const escapedOldPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedOldPath, 'g');
      updated = updated.replace(regex, newPath);
    }

    return updated;
  }

  // ==================== VALIDATION ====================

  /**
   * Verify migration integrity
   * @param {string} backupPath - Backup directory path
   * @param {string} projectId - Project ID
   * @param {string} frameworkId - Framework ID
   * @returns {Promise<{passed: boolean, checks: Object}>}
   */
  async verifyMigration(backupPath, projectId, frameworkId) {
    const checks = {};

    // Check all project directories migrated
    for (const [legacyDir, targetSubdir] of Object.entries(this.projectDirMapping)) {
      const legacyPath = path.join(this.basePath, legacyDir);
      const newPath = path.join(
        this.basePath,
        'frameworks',
        frameworkId,
        'projects',
        projectId,
        targetSubdir
      );

      const legacyExists = await this._exists(legacyPath);
      const newExists = await this._exists(newPath);

      checks[legacyDir] = {
        legacyRemoved: !legacyExists,
        newCreated: newExists,
        passed: !legacyExists && newExists
      };
    }

    // Check working directory migrated
    const workingLegacy = path.join(this.basePath, this.workingDir);
    const workingNew = path.join(this.basePath, 'frameworks', frameworkId, 'working');

    checks.working = {
      legacyRemoved: !(await this._exists(workingLegacy)),
      newCreated: await this._exists(workingNew),
      passed: !(await this._exists(workingLegacy)) && (await this._exists(workingNew))
    };

    // Overall pass/fail
    const allPassed = Object.values(checks).every(check => check.passed);

    return {
      passed: allPassed,
      checks
    };
  }

  /**
   * Compute SHA256 checksum of directory
   * @param {string} directory - Directory path
   * @returns {Promise<string>} Hex checksum
   */
  async computeChecksum(directory) {
    const files = (await glob(`${directory}/**/*`, { nodir: true }))
      .filter(file => path.basename(file) !== 'migration-manifest.json');
    const hash = crypto.createHash('sha256');

    // Sort files for consistent checksum
    files.sort();

    for (const file of files) {
      const content = await fs.readFile(file);
      hash.update(content);
    }

    return hash.digest('hex');
  }

  /**
   * Compare directory structures
   * @param {string} source - Source directory
   * @param {string} target - Target directory
   * @returns {Promise<{fileCountMatch: boolean, sizeMatch: boolean}>}
   */
  async compareDirStructures(source, target) {
    const sourceCount = await this._countFiles(source);
    const targetCount = await this._countFiles(target);

    const sourceSize = await this._getDirectorySize(source);
    const targetSize = await this._getDirectorySize(target);

    return {
      fileCountMatch: sourceCount === targetCount,
      sizeMatch: Math.abs(sourceSize - targetSize) < 1024, // Allow 1KB tolerance
      sourceCount,
      targetCount,
      sourceSize,
      targetSize
    };
  }

  // ==================== STATUS/REPORTING ====================

  /**
   * Get migration status
   * @returns {Promise<string>} Status: 'pending' | 'in-progress' | 'completed' | 'failed'
   */
  async getMigrationStatus() {
    // Check if migration lock exists
    if (await this._exists(this.migrationLockFile)) {
      return 'in-progress';
    }

    // Check if framework structure exists
    const frameworksDir = path.join(this.basePath, 'frameworks');
    if (await this._exists(frameworksDir)) {
      const entries = await fs.readdir(frameworksDir).catch(() => []);
      if (entries.length > 0) {
        return 'completed';
      }
    }

    // Check if legacy structure exists
    const legacyDirs = Object.keys(this.projectDirMapping);
    const legacyExists = await Promise.all(
      legacyDirs.map(dir => this._exists(path.join(this.basePath, dir)))
    );

    if (legacyExists.some(exists => exists)) {
      return 'pending';
    }

    return 'unknown';
  }

  /**
   * Get detailed migration report
   * @returns {Promise<Object>} Migration statistics
   */
  async getMigrationReport() {
    const status = await this.getMigrationStatus();
    const analysis = await this.analyzeExistingStructure();
    const backups = await this.listBackups();

    return {
      status,
      legacyStructure: analysis,
      backupsAvailable: backups.length,
      latestBackup: backups[0] || null,
      frameworksInstalled: await this._listFrameworks()
    };
  }

  /**
   * Analyze existing structure
   * @returns {Promise<Object>} Structure analysis
   */
  async analyzeExistingStructure() {
    const analysis = {
      directories: {},
      totalFiles: 0,
      totalSize: 0
    };

    for (const dir of Object.keys(this.projectDirMapping)) {
      const dirPath = path.join(this.basePath, dir);

      if (await this._exists(dirPath)) {
        const fileCount = await this._countFiles(dirPath);
        const size = await this._getDirectorySize(dirPath);

        analysis.directories[dir] = {
          fileCount,
          size,
          sizeFormatted: this._formatBytes(size)
        };

        analysis.totalFiles += fileCount;
        analysis.totalSize += size;
      }
    }

    // Check working directory
    const workingPath = path.join(this.basePath, this.workingDir);
    if (await this._exists(workingPath)) {
      const fileCount = await this._countFiles(workingPath);
      const size = await this._getDirectorySize(workingPath);

      analysis.directories[this.workingDir] = {
        fileCount,
        size,
        sizeFormatted: this._formatBytes(size)
      };

      analysis.totalFiles += fileCount;
      analysis.totalSize += size;
    }

    analysis.totalSizeFormatted = this._formatBytes(analysis.totalSize);

    return analysis;
  }

  // ==================== INTERNAL HELPERS ====================

  /**
   * Execute migration (non-incremental)
   * @private
   */
  async _executeMigration(projectId, frameworkId, analysis) {
    let migratedFiles = 0;

    // Create framework structure
    const frameworkBase = path.join(this.basePath, 'frameworks', frameworkId);
    const projectBase = path.join(frameworkBase, 'projects', projectId);

    await fs.mkdir(projectBase, { recursive: true });

    // Migrate project directories
    for (const [legacyDir, targetSubdir] of Object.entries(this.projectDirMapping)) {
      const source = path.join(this.basePath, legacyDir);

      if (await this._exists(source)) {
        const target = path.join(projectBase, targetSubdir);

        console.log(`  Migrating ${legacyDir}/ → ${targetSubdir}/...`);
        await this._moveDirectory(source, target);

        migratedFiles += analysis.directories[legacyDir]?.fileCount || 0;
      }
    }

    // Migrate working directory
    const workingSource = path.join(this.basePath, this.workingDir);
    if (await this._exists(workingSource)) {
      const workingTarget = path.join(frameworkBase, 'working');

      console.log(`  Migrating ${this.workingDir}/ → frameworks/${frameworkId}/working/...`);
      await this._moveDirectory(workingSource, workingTarget);

      migratedFiles += analysis.directories[this.workingDir]?.fileCount || 0;
    }

    return migratedFiles;
  }

  /**
   * Execute incremental migration (for large projects >1GB)
   * @private
   */
  async _migrateIncrementally(projectId, frameworkId, analysis, batchSize = 50) {
    let migratedFiles = 0;

    // Group directories into batches
    const allDirs = Object.keys(this.projectDirMapping);
    const batches = [];

    for (let i = 0; i < allDirs.length; i += batchSize) {
      batches.push(allDirs.slice(i, i + batchSize));
    }

    // Migrate in batches
    for (let i = 0; i < batches.length; i++) {
      console.log(`  Batch ${i + 1}/${batches.length}...`);

      const batchAnalysis = {
        directories: {}
      };

      for (const dir of batches[i]) {
        if (analysis.directories[dir]) {
          batchAnalysis.directories[dir] = analysis.directories[dir];
        }
      }

      const batchFiles = await this._executeMigration(projectId, frameworkId, batchAnalysis);
      migratedFiles += batchFiles;
    }

    return migratedFiles;
  }

  /**
   * Build path mapping for reference updates
   * @private
   */
  _buildPathMapping(projectId, frameworkId) {
    const mapping = {};

    for (const [legacyDir, targetSubdir] of Object.entries(this.projectDirMapping)) {
      const oldPath = `.aiwg/${legacyDir}/`;
      const newPath = `.aiwg/frameworks/${frameworkId}/projects/${projectId}/${targetSubdir}/`;
      mapping[oldPath] = newPath;
    }

    // Working directory
    mapping[`.aiwg/${this.workingDir}/`] = `.aiwg/frameworks/${frameworkId}/working/`;

    return mapping;
  }

  /**
   * Derive project ID from package.json or use default
   * @private
   */
  async _deriveProjectId() {
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      return packageJson.name || 'default-project';
    } catch {
      return 'default-project';
    }
  }

  /**
   * Create migration lock
   * @private
   */
  async _createLock() {
    const lockData = {
      timestamp: new Date().toISOString(),
      pid: process.pid
    };

    await fs.mkdir(path.dirname(this.migrationLockFile), { recursive: true });
    await fs.writeFile(this.migrationLockFile, JSON.stringify(lockData, null, 2));
  }

  /**
   * Remove migration lock
   * @private
   */
  async _removeLock() {
    await fs.unlink(this.migrationLockFile).catch(() => {});
  }

  /**
   * List installed frameworks
   * @private
   */
  async _listFrameworks() {
    const frameworksDir = path.join(this.basePath, 'frameworks');

    if (!(await this._exists(frameworksDir))) {
      return [];
    }

    const entries = await fs.readdir(frameworksDir);
    return entries.filter(async name => {
      const stat = await fs.stat(path.join(frameworksDir, name));
      return stat.isDirectory();
    });
  }

  /**
   * Copy directory recursively
   * @private
   */
  async _copyDirectory(source, target) {
    await fs.mkdir(target, { recursive: true });

    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await this._copyDirectory(sourcePath, targetPath);
      } else {
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }

  /**
   * Move directory (atomic rename where possible)
   * @private
   */
  async _moveDirectory(source, target) {
    await fs.mkdir(path.dirname(target), { recursive: true });

    try {
      // Try atomic rename first (fast)
      await fs.rename(source, target);
    } catch {
      // Fallback: copy then delete (slower but works across filesystems)
      await this._copyDirectory(source, target);
      await fs.rm(source, { recursive: true, force: true });
    }
  }

  /**
   * Check if path exists
   * @private
   */
  async _exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Count files in directory
   * @private
   */
  async _countFiles(directory) {
    if (!(await this._exists(directory))) {
      return 0;
    }

    const files = await glob(`${directory}/**/*`, { nodir: true });
    return files.length;
  }

  /**
   * Get directory size in bytes
   * @private
   */
  async _getDirectorySize(directory) {
    if (!(await this._exists(directory))) {
      return 0;
    }

    const files = await glob(`${directory}/**/*`, { nodir: true });
    let totalSize = 0;

    for (const file of files) {
      const stat = await fs.stat(file);
      totalSize += stat.size;
    }

    return totalSize;
  }

  /**
   * Format bytes to human-readable string
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Export error classes
export { MigrationValidationError, MigrationError, RollbackError };
