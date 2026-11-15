/**
 * Filesystem Storage Adapter
 *
 * The default backend. Wraps `fs.promises` and honors per-subsystem root
 * overrides from `storage.config`. Output is byte-identical to the
 * pre-abstraction direct-fs calls so consumer migrations stay safe.
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #956
 */

import { resolve, sep } from 'path';
import { pinContainedRoot, readContainedFile, writeContainedFile, appendContainedFile, deleteContainedFile, listContainedFiles, type ContainedRoot } from '../../utils/contained-filesystem.mjs';
import type { StorageAdapter, StorageEntry, WriteMeta } from '../types.js';

export class FilesystemAdapter implements StorageAdapter {
  /** Absolute path where this subsystem's content lives. */
  private readonly root: string;
  private readonly store: Promise<ContainedRoot>;

  constructor(root: string) {
    this.root = resolve(root);
    this.store = pinContainedRoot(this.root, undefined, {
      createMissing: true, protectLocationPointer: false, rejectLinkedWrites: true,
    });
  }

  /**
   * Path traversal guard. Rejects `..`, leading `/`, leading `~`, and
   * backslashes (which on POSIX would be treated as filename chars but
   * are almost always a Windows-vs-POSIX bug). Also rejects empty paths.
   */
  private resolveSafe(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('storage(fs): path must be a non-empty string');
    }
    if (relPath.includes('\\')) {
      throw new Error(`storage(fs): backslash not allowed in path "${relPath}"`);
    }
    if (relPath.startsWith('/') || relPath.startsWith('~')) {
      throw new Error(`storage(fs): absolute paths not allowed: "${relPath}"`);
    }
    const segments = relPath.split('/');
    if (segments.some((s) => s === '..')) {
      throw new Error(`storage(fs): ".." traversal not allowed in "${relPath}"`);
    }
    const abs = resolve(this.root, relPath);
    // Final guard: ensure the resolved path is still under root, even if
    // the segment check missed something unusual (e.g. empty segments).
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`storage(fs): resolved path escapes subsystem root: "${relPath}"`);
    }
    return abs;
  }

  async read(path: string): Promise<string | null> {
    this.resolveSafe(path);
    return readContainedFile(await this.store, path);
  }

  async write(path: string, content: string, _meta?: WriteMeta): Promise<void> {
    this.resolveSafe(path);
    await writeContainedFile(await this.store, path, content);
  }

  /** Append through a verified O_APPEND handle, without read/replace races. */
  async append(path: string, content: string): Promise<void> {
    this.resolveSafe(path);
    await appendContainedFile(await this.store, path, content);
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    if (typeof prefix !== 'string') throw new Error('storage(fs): list prefix must be a string');
    if (prefix) this.resolveSafe(prefix);
    return listContainedFiles(await this.store, prefix);
  }

  async delete(path: string): Promise<void> {
    this.resolveSafe(path);
    await deleteContainedFile(await this.store, path);
  }
}
