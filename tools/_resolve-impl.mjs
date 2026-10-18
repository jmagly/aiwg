import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findPackageRoot(callerUrl) {
  let dir = dirname(fileURLToPath(callerUrl));
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'aiwg' || pkg.name === '@aiwg/cli') return dir;
      } catch {
        // Keep walking.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw Object.assign(new Error(`Could not locate AIWG package root from ${callerUrl}`), { code: 'AIWG_PACKAGE_ROOT_MISSING' });
}

function candidatesFor(root, relativeFromSrc, base) {
  const primary = resolve(root, base, relativeFromSrc);
  const candidates = [primary];

  if (base === 'src' && extname(primary) === '.js') {
    candidates.push(primary.slice(0, -3) + '.ts');
  }

  return candidates;
}

function resolveCandidate(root, relativeFromSrc, base) {
  for (const candidate of candidatesFor(root, relativeFromSrc, base)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a module that may live under compiled dist/src/ or source src/.
 *
 * Prefers dist/src/ when present. Set AIWG_RESOLVE_IMPL_FROM=dist or src to
 * force a side during CI/package-layout checks.
 *
 * ## Why a tools/ script that imports src/ needs this (#3062)
 *
 * The npm package ships the `tools/` tree (with maintainer-only exceptions
 * below) and `dist/src/`; it does not ship `src/` itself (see `files` in
 * package.json). A script under `tools/` that imports `../../src/<module>`
 * directly by relative path works from a git checkout (`src/` exists
 * there) but throws `ERR_MODULE_NOT_FOUND` once installed from npm, where
 * only `dist/src/<module>` exists. Any shipped `.mjs` file under `tools/`
 * or `bin/` that needs something under `src/` must resolve it through
 * `importImpl(import.meta.url, '<module-path-relative-to-src>')` instead of
 * a literal relative import, so it finds `dist/src/` when installed and
 * `src/` in a checkout. `test/integration/tools-packed-relative-imports.test.ts`
 * guards this for every shipped relative import without exceptions.
 *
 * Directories `package.json`'s `files` excludes from the npm package
 * (`tools/benchmarks/`, `tools/ci/`, `tools/contrib/`,
 * `tools/eval/`, `tools/lint/` other than its listed exceptions,
 * `tools/manifest/` other than its listed exception, `tools/qualification/`,
 * and `tools/release/`) are maintainer/CI-only: they never run from an
 * installed package, so a literal `../../src/<module>` import there is
 * fine and does not need `importImpl`. Keep that distinction explicit at
 * each such import site rather than silently mixing styles within one
 * shipped-vs-not-shipped directory. `tools/benchmarks/` and
 * `tools/qualification/` were excluded specifically because nothing
 * shipped ever referenced them (#3062 B/C finding 2) — removing them
 * also trims install size (#3075).
 *
 * Decision study/replay scripts, experiments, OMP conformance probes, the
 * desktop issuer qualification, and repository testing scripts are also
 * excluded: they require checkout fixtures, development dependencies, or
 * unshipped application code and have no installed CLI callers. Keep those
 * scripts in the repository rather than adapting them for installation.
 *
 * `tools/docker/container-manager.mjs` and `Dockerfile.daemon` are shipped
 * exceptions to the Docker directory exclusion: `aiwg daemon start --docker`
 * needs both. The manager uses this resolver for its implementation import.
 */
export function resolveImpl(callerUrl, relativeFromSrc) {
  const root = findPackageRoot(callerUrl);
  const forced = process.env.AIWG_RESOLVE_IMPL_FROM;

  const order = forced === 'src'
    ? ['src']
    : forced === 'dist'
      ? ['dist/src']
      : ['dist/src', 'src'];

  for (const base of order) {
    const candidate = resolveCandidate(root, relativeFromSrc, base);
    if (candidate) return candidate;
  }

  const attempted = order
    .flatMap((base) => candidatesFor(root, relativeFromSrc, base))
    .join(', ');
  throw Object.assign(new Error(`Could not resolve ${relativeFromSrc}; attempted: ${attempted}`), { code: 'AIWG_IMPLEMENTATION_MISSING' });
}

export async function importImpl(callerUrl, relativeFromSrc) {
  const modulePath = resolveImpl(callerUrl, relativeFromSrc);
  return import(pathToFileURL(modulePath).href);
}
