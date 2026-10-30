// Mirror provider artifacts while retaining only evidenced native ownership.
import * as path from 'node:path';
import type { ArtifactMirrorResult } from './scope-resolver.js';
const SIDECAR = '.aiwg-manifest.json';
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
function receipt(bytes: Buffer | string | undefined): Record<string, any> {
  try { return object(JSON.parse(bytes?.toString() || '{}')); } catch { return {}; }
}
export async function assertGrokUserMirrorPaths(
  projectPaths: { agents: string; skills: string; kernelSkills?: string },
  userPaths: { agents: string; skills: string },
): Promise<void> {
  const fs = await import('node:fs/promises');
  const statIfPresent = async (target: string) => {
    try { return await fs.lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const checkTarget = async (target: string): Promise<void> => {
    const stat = await statIfPresent(target);
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Refusing unsafe Grok Build user mirror target: ${target}`);
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await checkTarget(path.join(target, name));
    }
  };
  for (const [destination, sources] of [
    [userPaths.agents, [projectPaths.agents]],
    [userPaths.skills, [projectPaths.skills, projectPaths.kernelSkills ?? '']],
  ] as const) {
    if (!destination) continue;
    const rootStat = await statIfPresent(destination);
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
      throw new Error(`Refusing unsafe Grok Build user mirror root: ${destination}`);
    }
    for (const source of sources) {
      if (!source) continue;
      let names: string[];
      try { names = await fs.readdir(source); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) await checkTarget(path.join(destination, name));
    }
  }
}

/**
 * Copy every directory or file under `src` into `dst` (creating `dst` if
 * needed). Returns the count of top-level entries successfully copied and
 * the entry names themselves — the names are needed by callers that record
 * a per-framework manifest at user scope so `aiwg remove --scope user` can
 * delete only what this deploy created.
 *
 * Used by the user-scope mirror to cover both directory-style artifacts
 * (skills, agents) and file-style artifacts (commands, rules in some
 * providers). Failures on individual entries are swallowed so a single bad
 * entry doesn't fail the whole mirror.
 */
export async function mirrorArtifactDir(src: string, dst: string, ownedThisCall: ReadonlySet<string> = new Set()): Promise<ArtifactMirrorResult> {
  if (!src || !dst) return { count: 0, targetDir: dst, entries: [] };
  const fs = await import('node:fs/promises');

  let dirents;
  try {
    dirents = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return { count: 0, targetDir: dst, entries: [] };
  }

  // Some providers already deploy kernel skills to an absolute user-level
  // path. Inventory that source for registry accounting instead of trying to
  // recursively copy each entry onto itself.
  if (path.resolve(src) === path.resolve(dst)) {
    const entries: string[] = [];
    for (const entry of dirents) {
      if ((entry.isDirectory() || entry.isFile()) && await isAiwgManagedEntry(path.join(dst, entry.name), entry.isDirectory())) {
        entries.push(entry.name);
      }
    }
    return { count: entries.length, targetDir: dst, entries };
  }

  const { captureDeploymentOutputs, recordDeploymentOutputs } = await import('../providers/deployment-ownership.mjs');
  const before = captureDeploymentOutputs([dst]);
  const sourceReceipt = receipt(await fs.readFile(path.join(src, SIDECAR)).catch(() => undefined));
  const copiedRecords: Record<string, unknown> = {};
  await fs.mkdir(dst, { recursive: true });
  let count = 0;
  const entries: string[] = [];
  for (const entry of dirents) {
    if (entry.name === SIDECAR) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      // User-scope directories are shared with operator-created artifacts.
      // A same-named unmanaged entry belongs to the operator, even when a
      // project has an AIWG-managed source with that name.
      try {
        const existing = await fs.lstat(d);
        if (!ownedThisCall.has(entry.name) && !await isAiwgManagedEntry(d, existing.isDirectory())) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      if (entry.isDirectory()) {
        await fs.cp(s, d, { recursive: true, force: true });
      } else if (entry.isFile()) {
        await fs.copyFile(s, d);
        if (sourceReceipt.managed?.[entry.name]) copiedRecords[entry.name] = sourceReceipt.managed[entry.name];
      } else {
        continue;
      }
      count++;
      entries.push(entry.name);
    } catch {
      // ignore individual failures
    }
  }
  if (Object.keys(copiedRecords).length) {
    const sidecarPath = path.resolve(dst, SIDECAR);
    const prior = receipt(before.get(sidecarPath));
    const next = { ...prior, managed: { ...object(prior.managed), ...copiedRecords } };
    await fs.writeFile(sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  // Copied skill sidecars retain their directory-local shape. The same merge
  // handles flat files, and never adopts an unrecorded legacy/operator file.
  recordDeploymentOutputs(before, [dst], { onlyDeclared: true });
  return { count, targetDir: dst, entries };
}

async function isAiwgManagedEntry(target: string, directory: boolean): Promise<boolean> {
  const fs = await import('node:fs/promises');
  if (directory) {
    try {
      const marker = await fs.readFile(path.join(target, '.aiwg-managed'), 'utf8');
      if (marker.trim() === 'aiwg') return true;
    } catch { /* legacy deployed skill may use an inline marker */ }
  }
  const markerFile = directory ? path.join(target, 'SKILL.md') : target;
  try {
    const text = await fs.readFile(markerFile, 'utf8');
    return /(?:#|<!--) aiwg:managed v[^\s]+ [^\r\n]+/.test(text.slice(0, 2048));
  } catch {
    return false;
  }
}
