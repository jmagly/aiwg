/**
 * Project-Local Bundle Discovery
 *
 * Scans `.aiwg/{extensions,addons,frameworks,plugins,providers}/<name>/manifest.json`
 * and validates each manifest against the unified schema. Read-only — no
 * deployment side effects.
 *
 * @implements #1034
 * @architecture .aiwg/architecture/adr-aiwg-directory-layout.md (#1039)
 * @architecture .aiwg/architecture/design-manifest-schema.md (#1044)
 */

import { readFile, readdir, lstat, stat, access, realpath } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import {
  BundleManifestSchema,
  type BundleManifest,
  type ProjectLocalType,
  type ManifestValidationError,
  zodErrorToValidationErrors,
  MANIFEST_MAX_BYTES,
  MAX_BUNDLES_PER_PROJECT,
} from './manifest.js';
import {
  ensureTrailingSlash,
  projectLocalDisplayPath,
  PROJECT_LOCAL_DIR_TO_TYPE,
  PROJECT_LOCAL_SCAN_DIRS,
  resolveProjectLocalSearchRoots,
  type ProjectLocalSearchRoot,
} from './project-local-paths.js';

export interface ProjectLocalBundle {
  /** Bundle id from manifest */
  id: string;
  /** Bundle type from manifest */
  type: ProjectLocalType;
  /** Validated manifest */
  manifest: BundleManifest;
  /** Absolute path to the bundle directory */
  bundlePath: string;
  /**
   * Absolute artifact source consumed by deployment, hashing, shadow checks,
   * and removal metadata. This equals bundlePath except for plugin wrappers,
   * where it is the validated pluginConfig.payloadPath.
   */
  artifactPath: string;
  /** Stable display path for the bundle directory (e.g., ".aiwg/extensions/foo/"). */
  localPath: string;
  /** Stable display path for manifest.json. */
  manifestPath: string;
}

export interface ProjectLocalDiscoveryResult {
  bundles: ProjectLocalBundle[];
  errors: ManifestValidationError[];
  /** True if no `.aiwg/<type>/` dirs exist or none contain bundles. */
  isEmpty: boolean;
  /** Counts per type (only populated when bundles found) */
  counts: Record<ProjectLocalType, number>;
}

export interface DiscoveryOptions {
  /** Allow symlinked bundle directories (default false per #1042 T3) */
  allowSymlinks?: boolean;
}

/** Format rejected target diagnostics using the same roots as discovery. */
export function formatProjectLocalTargetErrors(
  projectDir: string,
  target: string,
  discovery: ProjectLocalDiscoveryResult,
): string | undefined {
  const candidates = resolveProjectLocalSearchRoots(projectDir).flatMap(root =>
    PROJECT_LOCAL_SCAN_DIRS.flatMap(dir => {
      const bundlePath = join(root.rootPath, dir, target);
      return [bundlePath, projectLocalDisplayPath(projectDir, bundlePath, root)];
    }),
  );
  const errors = discovery.errors.filter(error => error.severity === 'error'
    && (error.bundleId === target || candidates.some(candidate => {
      const errorPath = error.path.split(sep).join('/');
      const candidatePath = candidate.split(sep).join('/');
      return errorPath === candidatePath || errorPath.startsWith(`${candidatePath}/`);
    })));
  if (errors.length === 0) return undefined;
  return `Error: Project-local bundle '${target}' failed manifest validation:\n`
    + errors.map(error => `  ${error.path}\n    ${error.field}: expected ${error.expected}, got ${error.actual}`
      + (error.hint ? `\n    hint: ${error.hint}` : '')).join('\n');
}

/**
 * Scan all project-local `.aiwg/<type>/` directories for bundles. Returns
 * a structured result with bundles, errors, and counts. Missing directories
 * are silently skipped (per #1039 §3 / UC-PL-6).
 */
export async function discoverProjectLocalBundles(
  projectDir: string,
  options: DiscoveryOptions = {}
): Promise<ProjectLocalDiscoveryResult> {
  const bundles: ProjectLocalBundle[] = [];
  const errors: ManifestValidationError[] = [];
  const counts: Record<ProjectLocalType, number> = {
    extension: 0,
    addon: 0,
    framework: 0,
    plugin: 0,
    provider: 0,
  };

  let totalScanned = 0;

  const searchRoots = resolveProjectLocalSearchRoots(projectDir);

  for (const searchRoot of searchRoots) {
    for (const dirName of PROJECT_LOCAL_SCAN_DIRS) {
      const type = PROJECT_LOCAL_DIR_TO_TYPE[dirName];
      const dirPath = join(searchRoot.rootPath, dirName);

      let bundleNames: string[];
      try {
        bundleNames = await readdir(dirPath);
      } catch {
        // Directory absent — silently skip (no-op when absent per UC-PL-6)
        continue;
      }

      for (const bundleName of bundleNames) {
        const bundlePath = join(dirPath, bundleName);

        // Skip non-directory entries (e.g., the legacy registry.json file)
        let isDir: boolean;
        try {
          const st = await lstat(bundlePath);
          if (st.isSymbolicLink()) {
            if (!options.allowSymlinks) {
              errors.push({
                path: bundlePath,
                field: '(bundle directory)',
                expected: 'regular directory',
                actual: 'symlink',
                hint: 'Pass --allow-symlinks to opt in (per #1042 threat model T3)',
                severity: 'error',
              });
              continue;
            }
            // Resolve the symlink and check the target is a directory
            const target = await stat(bundlePath);
            isDir = target.isDirectory();
          } else {
            isDir = st.isDirectory();
          }
        } catch {
          continue;
        }
        if (!isDir) continue;

        const manifestPath = join(bundlePath, 'manifest.json');

        // Silently skip directories without manifest.json — these are not
        // project-local bundles. Most commonly, .aiwg/frameworks/<id>/ holds
        // workspace state from initializeFrameworkWorkspace() (archive/,
        // projects/, repo/, working/), not a bundle. Issue #1058.
        try {
          await access(manifestPath);
        } catch {
          continue;
        }

        totalScanned++;

        // Enforce per-project bundle count cap (#1042 D2 / NFR-PL-12)
        if (totalScanned > MAX_BUNDLES_PER_PROJECT) {
          errors.push({
            path: dirPath,
            field: '(bundle count)',
            expected: `<= ${MAX_BUNDLES_PER_PROJECT} bundles per project`,
            actual: `>${MAX_BUNDLES_PER_PROJECT}`,
            hint: 'Refusing to scan further bundles. Reduce project-local artifact count.',
            severity: 'error',
          });
          const isEmpty = bundles.length === 0;
          return { bundles, errors, isEmpty, counts };
        }

        const result = await loadAndValidateManifest(manifestPath, type, projectDir, searchRoot);
        if (result.bundle) {
          bundles.push(result.bundle);
          counts[result.bundle.type]++;
        }
        errors.push(...result.errors);
      }
    }
  }

  // Cross-bundle: check for case-insensitive id collisions within a single type
  // (NFR-PL-6) and duplicate ids (per #1041 §4 case 6)
  for (const type of ['extension', 'addon', 'framework', 'plugin', 'provider'] as ProjectLocalType[]) {
    const bundlesOfType = bundles.filter((b) => b.type === type);
    const idsLower = new Map<string, ProjectLocalBundle[]>();
    for (const b of bundlesOfType) {
      const key = b.id.toLowerCase();
      const existing = idsLower.get(key) ?? [];
      existing.push(b);
      idsLower.set(key, existing);
    }
    for (const [, group] of idsLower) {
      if (group.length > 1) {
        for (const b of group) {
          errors.push({
            path: b.manifestPath,
            field: 'id',
            expected: 'unique id (case-insensitive) within type',
            actual: `${b.id} (collides with ${group.filter((g) => g !== b).map((g) => g.id).join(', ')})`,
            hint: 'Two bundles within the same type may not share an id, even differing only in case',
            severity: 'error',
          });
        }
        // Drop colliding bundles from the result so they don't get treated as
        // valid downstream
        for (const b of group) {
          const idx = bundles.indexOf(b);
          if (idx >= 0) {
            bundles.splice(idx, 1);
            counts[b.type]--;
          }
        }
      }
    }
  }

  const isEmpty = bundles.length === 0 && errors.length === 0;
  return { bundles, errors, isEmpty, counts };
}

/**
 * Read a single manifest.json, validate it, and return either a bundle or
 * structured errors. Used by the scanner; exported for tests.
 */
export async function loadAndValidateManifest(
  manifestPath: string,
  expectedType: ProjectLocalType,
  projectDir: string,
  searchRoot?: ProjectLocalSearchRoot,
): Promise<{ bundle?: ProjectLocalBundle; errors: ManifestValidationError[] }> {
  // Size cap (#1042 D1 / NFR-PL-11): refuse before parse
  let st;
  try {
    st = await stat(manifestPath);
  } catch {
    return {
      errors: [{
        path: manifestPath,
        field: '(file)',
        expected: 'manifest.json present',
        actual: 'absent',
        hint: 'Project-local bundle directory missing manifest.json',
        severity: 'error',
      }],
    };
  }
  if (st.size > MANIFEST_MAX_BYTES) {
    return {
      errors: [{
        path: manifestPath,
        field: '(file size)',
        expected: `<= ${MANIFEST_MAX_BYTES} bytes`,
        actual: `${st.size} bytes`,
        hint: 'Manifest exceeds size limit; refusing to parse',
        severity: 'error',
      }],
    };
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    return {
      errors: [{
        path: manifestPath,
        field: '(read)',
        expected: 'readable manifest.json',
        actual: (err as Error).message,
        severity: 'error',
      }],
    };
  }

  // Encoding check (NFR-PL-5): UTF-8 BOM is allowed; we'll normalize. Other
  // BOMs (UTF-16 LE/BE, Latin-1) are rejected.
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  } else if (raw.charCodeAt(0) === 0xFFFE || raw.charCodeAt(0) === 0xFEFF) {
    return {
      errors: [{
        path: manifestPath,
        field: '(encoding)',
        expected: 'UTF-8',
        actual: 'non-UTF-8 BOM detected',
        hint: 'Manifest must be UTF-8 encoded',
        severity: 'error',
      }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      errors: [{
        path: manifestPath,
        field: '(JSON parse)',
        expected: 'valid JSON',
        actual: (err as Error).message,
        severity: 'error',
      }],
    };
  }

  const result = BundleManifestSchema.safeParse(parsed);
  if (!result.success) {
    const id = BundleManifestSchema.shape.id.safeParse(
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).id : undefined,
    );
    return { errors: zodErrorToValidationErrors(result.error, manifestPath, parsed)
      .map(error => id.success ? { ...error, bundleId: id.data } : error) };
  }

  const manifest = result.data;

  // Cross-check: manifest declared type must match the directory it lives in.
  if (manifest.type !== expectedType) {
    return {
      errors: [{
        path: manifestPath,
        field: 'type',
        expected: `"${expectedType}" (matching directory .aiwg/${expectedType}s/)`,
        actual: `"${manifest.type}"`,
        hint: `Bundle in .aiwg/${expectedType}s/ must declare type: "${expectedType}"`,
        severity: 'error',
      }],
    };
  }

  const bundlePath = manifestPath.slice(0, -'/manifest.json'.length);
  const localPath = ensureTrailingSlash(projectLocalDisplayPath(projectDir, bundlePath, searchRoot));
  let artifactPath = bundlePath;

  if (manifest.type === 'plugin') {
    // BundleManifestSchema's discriminator refinement guarantees this for a
    // plugin, but Zod refinements do not narrow the inferred TypeScript type.
    const pluginConfig = manifest.pluginConfig!;
    const configuredPayload = resolve(bundlePath, pluginConfig.payloadPath);
    const lexicalRelative = relative(bundlePath, configuredPayload);
    if (
      lexicalRelative === ''
      || lexicalRelative === '..'
      || lexicalRelative.startsWith(`..${sep}`)
    ) {
      return {
        errors: [{
          path: manifestPath,
          field: 'pluginConfig.payloadPath',
          expected: 'a child directory inside the plugin wrapper',
          actual: pluginConfig.payloadPath,
          hint: 'Plugin payloads must not resolve to the wrapper root or escape it',
          severity: 'error',
        }],
      };
    }

    let wrapperReal: string;
    let payloadReal: string;
    try {
      const payloadStat = await lstat(configuredPayload);
      if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
        return {
          errors: [{
            path: configuredPayload,
            field: 'pluginConfig.payloadPath',
            expected: 'a regular payload directory',
            actual: payloadStat.isSymbolicLink() ? 'symlink' : 'non-directory',
            hint: 'Use a real directory below the plugin wrapper',
            severity: 'error',
          }],
        };
      }
      [wrapperReal, payloadReal] = await Promise.all([
        realpath(bundlePath),
        realpath(configuredPayload),
      ]);
    } catch (err) {
      return {
        errors: [{
          path: configuredPayload,
          field: 'pluginConfig.payloadPath',
          expected: 'an existing readable payload directory',
          actual: (err as Error).message,
          hint: 'Create the configured payload directory and its manifest.json',
          severity: 'error',
        }],
      };
    }

    const realRelative = relative(wrapperReal, payloadReal);
    if (
      realRelative === ''
      || realRelative === '..'
      || realRelative.startsWith(`..${sep}`)
    ) {
      return {
        errors: [{
          path: configuredPayload,
          field: 'pluginConfig.payloadPath',
          expected: 'a non-symlinked child directory inside the plugin wrapper',
          actual: payloadReal,
          hint: 'Move the payload below the wrapper and remove symlink indirection',
          severity: 'error',
        }],
      };
    }

    const payloadManifestPath = join(configuredPayload, 'manifest.json');
    const payloadResult = await loadAndValidateManifest(
      payloadManifestPath,
      pluginConfig.payloadType,
      projectDir,
      searchRoot,
    );
    if (!payloadResult.bundle) {
      return {
        errors: payloadResult.errors.map(error => ({
          ...error,
          hint: error.field === 'type'
            ? `Payload manifest type must match pluginConfig.payloadType: "${pluginConfig.payloadType}"`
            : error.hint,
        })),
      };
    }
    artifactPath = payloadResult.bundle.bundlePath;
  }

  return {
    bundle: {
      id: manifest.id,
      type: manifest.type,
      manifest,
      bundlePath,
      artifactPath,
      localPath,
      manifestPath: projectLocalDisplayPath(projectDir, manifestPath, searchRoot),
    },
    errors: [],
  };
}
