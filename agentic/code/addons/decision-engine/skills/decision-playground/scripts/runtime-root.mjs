// Locate the compiled decision runtime for a dispatcher script.
//
// `aiwg use decision-engine` copies this skill into a provider directory such as
// `.claude/.aiwg/skills/decision-evaluate/`, far from the installed package, so
// a fixed path relative to the script only works in the package itself.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DECISION_RUNTIME = 'dist/src/decision/index.js';

function isAiwgRoot(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'aiwg'
      && existsSync(path.join(root, DECISION_RUNTIME));
  } catch {
    return false;
  }
}

function* ancestors(start) {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    yield directory;
    if (path.dirname(directory) === directory) return;
  }
}

function* pathInstalls(searchPath) {
  for (const directory of (searchPath ?? '').split(path.delimiter).filter(Boolean)) {
    const bin = path.join(directory, 'aiwg');
    // POSIX global installs link <prefix>/bin/aiwg to <package>/bin/aiwg.mjs.
    try { yield path.dirname(path.dirname(realpathSync(bin))); } catch { /* not on this entry */ }
    yield path.join(directory, '..', 'lib', 'node_modules', 'aiwg');
    yield path.join(directory, 'node_modules', 'aiwg');
  }
}

/**
 * Resolution order: `AIWG_ROOT` when it names a built package; the package
 * containing the script, or an `aiwg` installed in a `node_modules` above it;
 * the same search from the working directory; then the `aiwg` executable on
 * `PATH`.
 */
export function resolveDecisionRuntime(scriptUrl, { env = process.env, cwd = process.cwd() } = {}) {
  // AIWG_ROOT often names an unbuilt source checkout, so it wins only when built.
  if (env.AIWG_ROOT && isAiwgRoot(path.resolve(env.AIWG_ROOT))) {
    return path.join(path.resolve(env.AIWG_ROOT), DECISION_RUNTIME);
  }
  for (const start of [path.dirname(fileURLToPath(scriptUrl)), cwd]) {
    for (const directory of ancestors(start)) {
      for (const root of [directory, path.join(directory, 'node_modules', 'aiwg')]) {
        if (isAiwgRoot(root)) return path.join(root, DECISION_RUNTIME);
      }
    }
  }
  for (const root of pathInstalls(env.PATH)) {
    if (isAiwgRoot(root)) return path.join(path.resolve(root), DECISION_RUNTIME);
  }
  throw new Error('Cannot locate the aiwg decision runtime. Install aiwg in this project or globally, '
    + 'or set AIWG_ROOT to the installed aiwg package directory.');
}
