/**
 * Obsidian Storage Adapter
 *
 * Writes and reads markdown files in an Obsidian vault on disk. The
 * adapter is filesystem-shaped — Obsidian vaults are directories of
 * `.md` files plus a hidden `.obsidian/` config dir we never touch.
 *
 * About the official Obsidian CLI: as of Feb 2026 Obsidian ships an
 * official CLI for vault interactions. Its primary surface is opening
 * notes / running commands against a *running* Obsidian instance, not
 * arbitrary external file writes. Obsidian's own file watcher handles
 * picking up external markdown changes within a few seconds, so direct
 * fs writes work cleanly when Obsidian is closed and converge quickly
 * when it's open.
 *
 * What this adapter does:
 *   - Reads / writes / lists / deletes markdown files via fs
 *   - Optional CLI reachability probe (when `useCli: true`) — emits a
 *     one-time warning if the user opted into CLI mode but the
 *     `obsidian` binary is missing
 *   - Refuses paths that resolve into the vault's `.obsidian/` config
 *   - Forwards `WriteMeta.frontmatter` into the markdown's YAML
 *     frontmatter when provided
 *   - Does NOT implement `query()` — Obsidian's search is not exposed
 *     via the CLI as of research date
 *
 * @design @.aiwg/architecture/storage-design.md (§5.2)
 * @issue #934
 * @issue #957
 */

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { execSync } from 'child_process';
import type { ObsidianBackendConfig, StorageAdapter, StorageEntry, WriteMeta } from '../types.js';

const OBSIDIAN_CONFIG_DIR = '.obsidian';

export class ObsidianAdapter implements StorageAdapter {
  /** Absolute path to the root the adapter writes into (vault[/folder]). */
  private readonly root: string;
  /** Absolute path to the vault — used to enforce the .obsidian/ guard. */
  private readonly vault: string;
  private readonly useCli: boolean;
  /** Cached result of the CLI reachability probe so we only warn once. */
  private cliWarned = false;

  constructor(config: ObsidianBackendConfig) {
    this.vault = resolve(expandHome(config.vault));
    this.root = config.folder ? join(this.vault, config.folder) : this.vault;
    this.useCli = config.useCli ?? true;
  }

  /**
   * Validate a subsystem-relative path. Rejects traversal, absolute
   * paths, backslashes, and any path that resolves into the vault's
   * `.obsidian/` config directory.
   */
  private resolveSafe(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('storage(obsidian): path must be a non-empty string');
    }
    if (relPath.includes('\\')) {
      throw new Error(`storage(obsidian): backslash not allowed in path "${relPath}"`);
    }
    if (relPath.startsWith('/') || relPath.startsWith('~')) {
      throw new Error(`storage(obsidian): absolute paths not allowed: "${relPath}"`);
    }
    const segments = relPath.split('/');
    if (segments.some((s) => s === '..')) {
      throw new Error(`storage(obsidian): ".." traversal not allowed in "${relPath}"`);
    }

    const abs = resolve(this.root, relPath);

    // Must stay under root
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`storage(obsidian): resolved path escapes folder root: "${relPath}"`);
    }
    // Must never enter .obsidian/
    const relFromVault = relative(this.vault, abs);
    if (
      relFromVault === OBSIDIAN_CONFIG_DIR ||
      relFromVault.startsWith(OBSIDIAN_CONFIG_DIR + sep)
    ) {
      throw new Error(
        `storage(obsidian): refusing to operate on .obsidian/ vault config (${relPath})`
      );
    }
    return abs;
  }

  async init(): Promise<void> {
    if (!existsSync(this.vault)) {
      throw new Error(`storage(obsidian): vault does not exist: ${this.vault}`);
    }
    if (this.useCli) this.probeCli();
  }

  /**
   * One-shot best-effort `obsidian --version` probe. We only warn
   * (never fail) — direct fs writes still work without the CLI.
   */
  private probeCli(): void {
    if (this.cliWarned) return;
    try {
      execSync('obsidian --version', {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000,
        killSignal: 'SIGKILL',
      });
    } catch {
      this.cliWarned = true;
      process.stderr.write(
        `storage(obsidian): CLI requested (useCli: true) but the \`obsidian\` binary was not found.\n` +
          `  AIWG will continue with direct file writes against the vault.\n` +
          `  Set "useCli": false in storage.config to suppress this warning.\n`
      );
    }
  }

  async read(path: string): Promise<string | null> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) return null;
    return readFile(abs, 'utf-8');
  }

  async write(path: string, content: string, meta?: WriteMeta): Promise<void> {
    const abs = this.resolveSafe(path);
    await mkdir(dirname(abs), { recursive: true });

    // Merge supplied frontmatter into the markdown payload (only when
    // there isn't already YAML frontmatter at the top — we don't want
    // to overwrite user-written frontmatter inadvertently).
    let body = content;
    if (meta?.frontmatter && Object.keys(meta.frontmatter).length > 0 && !startsWithFrontmatter(content)) {
      body = renderFrontmatter(meta.frontmatter) + content;
    }

    await writeFile(abs, body, 'utf-8');
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    if (typeof prefix !== 'string') {
      throw new Error('storage(obsidian): list prefix must be a string');
    }
    if (prefix.length > 0) this.resolveSafe(prefix);
    if (!existsSync(this.root)) return [];

    const out: StorageEntry[] = [];
    await walkInto(this.root, this.root, this.vault, prefix, out);
    return out;
  }

  async delete(path: string): Promise<void> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) return;
    await rm(abs, { force: true });
  }
}

async function walkInto(
  root: string,
  dir: string,
  vault: string,
  prefix: string,
  out: StorageEntry[]
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    // Skip the vault config directory anywhere under the walk
    if (e.name === OBSIDIAN_CONFIG_DIR) {
      const fullForCheck = join(dir, e.name);
      // Only skip when this is *the* vault's .obsidian/ — a user-created
      // folder named ".obsidian" inside content would still be skipped
      // out of paranoia, which matches the safety stance.
      if (relative(vault, fullForCheck) === OBSIDIAN_CONFIG_DIR) continue;
      continue; // be conservative: skip any .obsidian directory
    }

    const full = join(dir, e.name);
    const rel = relative(root, full).split(sep).join('/');

    if (e.isDirectory()) {
      if (prefix === '' || rel.startsWith(prefix) || prefix.startsWith(rel + '/')) {
        await walkInto(root, full, vault, prefix, out);
      }
      continue;
    }
    if (!e.isFile()) continue;
    if (prefix !== '' && !rel.startsWith(prefix)) continue;

    let size: number | undefined;
    let modifiedAt: Date | undefined;
    try {
      const s = await stat(full);
      size = s.size;
      modifiedAt = s.mtime;
    } catch {
      // ignore
    }
    const entry: StorageEntry = { path: rel };
    if (size !== undefined) entry.size = size;
    if (modifiedAt !== undefined) entry.modifiedAt = modifiedAt;
    out.push(entry);
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const { homedir } = require('os') as typeof import('os');
    return join(homedir(), p.slice(2));
  }
  if (p === '~') {
    const { homedir } = require('os') as typeof import('os');
    return homedir();
  }
  return p;
}

function startsWithFrontmatter(content: string): boolean {
  // Obsidian frontmatter convention: starts with `---` on a line by itself
  return /^---\s*\r?\n/.test(content);
}

function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${formatYamlScalar(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function formatYamlScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => formatYamlScalar(x)).join(', ') + ']';
  if (typeof v === 'string') {
    // Quote strings containing YAML special characters
    if (/[:\#\n\r\t&*?{}\[\]|>'"%@`!,]/.test(v) || /^\s|\s$/.test(v) || v.length === 0) {
      return JSON.stringify(v);
    }
    return v;
  }
  return JSON.stringify(v);
}
