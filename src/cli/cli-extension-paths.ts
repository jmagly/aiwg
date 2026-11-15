// Resolve portable CLI namespace sources and diagnose stale registrations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Relative sources are project-root-relative; external sources remain absolute. */
export async function resolveCliExtensionSource(cwd: string, source: string): Promise<string> {
  if (typeof source !== 'string' || !source.trim() || source.split(/[\\/]+/).includes('..')) {
    throw new Error('Unsafe CLI extension source: empty path or parent traversal.');
  }
  const resolved = path.resolve(cwd, source);
  if (path.isAbsolute(source)) return resolved;
  if (!inside(path.resolve(cwd), resolved)) throw new Error('CLI extension source escapes project root.');
  // Inspect real paths so an in-project symlink cannot grant an external source.
  try {
    const [rootReal, sourceReal] = await Promise.all([fs.realpath(cwd), fs.realpath(resolved)]);
    if (!inside(rootReal, sourceReal)) throw new Error('CLI extension source escapes project root via symlink.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Missing directories are reported at execution and by doctor.
  }
  return resolved;
}

export async function portableCliExtensionSource(cwd: string, source: string): Promise<string> {
  const resolved = await resolveCliExtensionSource(cwd, source);
  if (!inside(path.resolve(cwd), resolved)) return resolved;
  const relative = path.relative(path.resolve(cwd), resolved) || '.';
  await resolveCliExtensionSource(cwd, relative);
  return relative.split(path.sep).join('/');
}

/** Diagnose every registry, including committed registries in a fresh clone. */
export async function cliExtensionSourceWarnings(cwd: string): Promise<string[]> {
  const file = projectAiwgPath(cwd, 'cli-extensions.json');
  let registry: Record<string, { source: string }>;
  try {
    registry = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('expected namespace object');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [`CLI extensions: invalid ${file}: ${(error as Error).message}`];
  }
  const warnings: string[] = [];
  for (const [namespace, entry] of Object.entries(registry)) {
    try {
      const source = await resolveCliExtensionSource(cwd, entry?.source);
      if (!(await fs.stat(source)).isDirectory()) throw new Error('source is not a directory');
    } catch (error) {
      warnings.push(`CLI extension '${namespace}' source '${entry?.source}': ${(error as Error).message}. Run aiwg use <bundle> to register its current source.`);
    }
  }
  return warnings;
}
