// Refuse dispatch when a prepared worker tree exposes declared local-only inputs.
import { stat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { collectLocalOnlyPaths } from '../../models/conductor-data-policy.mjs';

const contains = (base, file) => {
  const relative = path.relative(base, file);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function existing(file) {
  try {
    const info = await stat(file);
    return info.isFile() || info.isDirectory() ? await realpath(file) : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Enumerate aliases without traversing their targets or opening any file contents.
async function symlinkTargets(tree) {
  const targets = [], pending = [tree];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isSymbolicLink()) {
        const target = await existing(file);
        if (target) targets.push(target);
      }
    }
  }
  return targets;
}

export async function workerLocalOnlyPreflight({ root, snapshot, invocation, drivers }) {
  const paths = collectLocalOnlyPaths(snapshot.models.defaults.workerSelection, snapshot.config.parallelism);
  if (!paths.length) return null;
  const selected = invocation.selected;
  const rows = snapshot.catalog.discovery?.instances?.[selected.cli]?.models ?? [];
  const observation = rows.find(row => (row.id === selected.model || row.apiModelId === selected.model)
    && row.llmProvider === selected.inferenceProvider)?.worker;
  // Locality is an observed execution-path fact, never inferred from a CLI or class name.
  if (observation?.qualification?.status === 'qualified' && observation.dataUse?.processing === 'local') return null;
  const trees = [invocation.cwd];
  if (invocation.transport === 'mcp') {
    const server = await drivers[selected.cli]?.mcpRegistry?.get(invocation.mcp.serverRef);
    if (server?.cwd) trees.push(server.cwd);
  }
  const exposed = [], protectedTargets = new Map();
  const planned = (invocation.artifacts ?? []).filter(artifact => artifact.location === 'workspace-relative')
    .map(artifact => path.resolve(invocation.cwd, artifact.relativePath));
  for (const file of paths) {
    const projectPath = path.resolve(root, file);
    const projectTarget = await existing(projectPath);
    if (projectTarget) protectedTargets.set(file, projectTarget);
    for (const tree of new Set(trees)) {
      const canonicalTree = await realpath(tree);
      // Check project-relative copies as well as a workdir inside a protected subtree.
      if (await existing(path.resolve(tree, file))
        || planned.some(target => contains(path.resolve(tree, file), target)) || projectTarget && (
        contains(tree, projectPath) || contains(projectPath, tree)
        || contains(canonicalTree, projectTarget) || contains(projectTarget, canonicalTree))) {
        exposed.push(file);
        break;
      }
    }
  }
  if ([...protectedTargets.keys()].some(file => !exposed.includes(file))) {
    for (const tree of new Set(trees)) for (const target of await symlinkTargets(tree)) {
      for (const [file, protectedTarget] of protectedTargets) {
        if (!exposed.includes(file) && (contains(target, protectedTarget) || contains(protectedTarget, target))) exposed.push(file);
      }
    }
  }
  return exposed.length ? { code: 'LOCAL_ONLY_PATH_EXPOSED', paths: exposed.sort(),
    message: `Worker tree exposes local-only paths to a tuple without qualified local processing: ${exposed.sort().join(', ')}; remove them from the worker tree before launch, use a worker with qualified local processing, or deny the task` } : null;
}
