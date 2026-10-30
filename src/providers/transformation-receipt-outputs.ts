// Discover provider outputs from existing ownership evidence, including nested sidecars.
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const MANAGED_SIDECAR = '.aiwg-manifest.json';
const MANAGED_DIRECTORY_MARKER = '.aiwg-managed';
const MANAGED_FILE_MARKER = /^(?:<!-- aiwg:managed |# aiwg:managed )/m;
function safeChild(root: string, name: string): boolean {
  const relative = path.relative(root, path.resolve(root, name));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

async function addEntry(files: Set<string>, candidate: string): Promise<void> {
  try {
    const metadata = await lstat(candidate);
    if (metadata.isFile()) files.add(candidate);
    else if (metadata.isDirectory()) {
      for (const file of await regularFiles(candidate)) files.add(file);
    }
  } catch {
    // A registry or sidecar entry can describe a stale partial deployment.
    // Receipt finalization binds only successful on-disk outputs; an existing
    // receipt remains responsible for diagnosing later deletion.
  }
}

export async function collectOwnedDirectory(
  directory: string,
  exactEntries: string[],
  files: Set<string>,
  projectRoot?: string,
): Promise<void> {
  for (const entry of exactEntries) await addEntry(files, path.join(directory, entry));

  const sidecarPath = path.join(directory, MANAGED_SIDECAR);
  try {
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as { managed?: Record<string, unknown>; scope?: string };
    const managed = sidecar.managed && typeof sidecar.managed === 'object'
      ? Object.keys(sidecar.managed)
      : [];
    if (managed.length > 0) files.add(sidecarPath);
    const base = projectRoot && directory === path.join(projectRoot, '.aiwg') && sidecar.scope === 'project' ? projectRoot : directory;
    for (const name of managed) {
      if (name !== MANAGED_SIDECAR && safeChild(base, name)) {
        await addEntry(files, path.join(base, name));
      }
    }
  } catch {
    // Missing or invalid sidecars are not ownership evidence.
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      try {
        const marker = await lstat(path.join(candidate, MANAGED_DIRECTORY_MARKER));
        if (!marker.isFile()) continue;
        await addEntry(files, candidate);
      } catch {
        // Unmarked directories remain operator-owned.
      }
      continue;
    }
    if (!entry.isFile() || entry.name === MANAGED_SIDECAR) continue;
    try {
      const content = await readFile(candidate, 'utf8');
      if (MANAGED_FILE_MARKER.test(content)) files.add(candidate);
    } catch {
      // Unreadable files cannot establish an ownership signal.
    }
  }
}
