// Create private in-project run parents without following symlinked components.
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { withWorkerPath } from './worker-inputs.mjs';

export async function createAttemptRunDirectory(runDir, projectRoot = process.cwd()) {
  if (!isAbsolute(runDir) || runDir.includes('\0') || runDir.split('/').includes('..')) {
    throw new Error('Invalid worker run directory path');
  }
  const parent = dirname(runDir);
  const root = resolve(projectRoot);
  const rel = relative(root, parent);
  const inProject = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  if (inProject) {
    await withWorkerPath(root, async target => {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid conductor project root');
    });
  }
  let current = parse(parent).root;
  for (const segment of parent.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Worker run directory parent must be a directory without symlinks: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!inProject) {
        throw new Error(`Worker run directory parent does not exist: ${parent}; create it (mode 0700) before launch`);
      }
      await withWorkerPath(current, async target => {
        try { await mkdir(target, { mode: 0o700 }); } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Worker run directory parent must be a directory without symlinks: ${current}`);
        }
      });
    }
  }
  await withWorkerPath(runDir, target => mkdir(target, { mode: 0o700 }));
}
