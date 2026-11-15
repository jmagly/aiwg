/**
 * Contributor Discovery
 *
 * Walks the installed framework registry and project-local override directory
 * to find `<framework>/<kind>/contributor.md` files. Parses, validates, and
 * runs detection on each candidate. Returns kept records and skipped entries
 * with reasons. Failures of one contributor never abort discovery.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #938
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { glob } from 'glob';
import path from 'path';
import { parseFrontmatter } from '../artifacts/index-builder.js';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { isInUse } from './detect.js';
import { validateContributor } from './validation.js';
import type {
  ContributorBase,
  ContributorKind,
  ContributorOrigin,
  ContributorRecord,
  DiscoveryResult,
  SkippedContributor,
} from './types.js';

/**
 * Subdirectories under a framework root that may host installable units.
 * The discovery loop checks each in order so a single id can resolve to
 * the right source path regardless of whether it's a framework, addon, or
 * extension. First match wins.
 */
const FRAMEWORK_SUBDIRS = ['frameworks', 'addons', 'extensions'] as const;

interface DiscoverOptions {
  /**
   * Root of the AIWG installation (where `agentic/code/` lives). Required —
   * callers pass the result of `getFrameworkRoot()`. Tests can pass a fixture
   * path.
   */
  frameworkRoot: string;
  /** Project root — where `.aiwg/` lives and where detection globs run. */
  projectRoot: string;
  /**
   * Override the registry path. Defaults to
   * `<projectRoot>/.aiwg/frameworks/registry.json`. Tests can pass a fixture.
   */
  registryPath?: string;
}

/**
 * Minimal shape of `.aiwg/frameworks/registry.json`. We only consume `id`s.
 */
interface FrameworkRegistry {
  frameworks: Array<{ id: string }>;
}

/**
 * Read the registry. Returns empty list if missing or unparseable — discovery
 * is non-fatal and project-local contributors can still be found.
 */
async function readRegistry(registryPath: string): Promise<FrameworkRegistry> {
  if (!existsSync(registryPath)) return { frameworks: [] };
  try {
    const raw = await readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as FrameworkRegistry;
    return parsed && Array.isArray(parsed.frameworks) ? parsed : { frameworks: [] };
  } catch {
    return { frameworks: [] };
  }
}

/**
 * Resolve a framework id to its source path under the AIWG installation.
 * Tries `frameworks/`, `addons/`, `extensions/` in order. Returns null if
 * none exist on disk — the id is registered but its source is missing.
 */
function resolveFrameworkSourcePath(frameworkRoot: string, id: string): string | null {
  for (const sub of FRAMEWORK_SUBDIRS) {
    const candidate = path.join(frameworkRoot, 'agentic', 'code', sub, id);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Process one contributor source: parse, validate, run detection.
 * Returns either a record (in-use) or a skip entry. Never throws.
 */
async function processContributor(
  src: ContributorOrigin,
  projectRoot: string
): Promise<{ kind: 'record'; record: ContributorRecord } | { kind: 'skip'; entry: SkippedContributor }> {
  let raw: string;
  try {
    raw = await readFile(src.path, 'utf-8');
  } catch (err) {
    return {
      kind: 'skip',
      entry: { ...src, reason: 'parse-error', message: `cannot read file: ${(err as Error).message}` },
    };
  }

  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(raw);
    data = parsed.data;
    body = parsed.body;
  } catch (err) {
    return {
      kind: 'skip',
      entry: { ...src, reason: 'parse-error', message: `cannot parse frontmatter: ${(err as Error).message}` },
    };
  }

  const validation = validateContributor(data);
  if (!validation.ok) {
    return {
      kind: 'skip',
      entry: { ...src, reason: 'schema-violation', message: validation.errors.join('; ') },
    };
  }

  const validData = validation.data as ContributorBase;

  let inUse: boolean;
  try {
    inUse = await isInUse(validData.detect, projectRoot);
  } catch (err) {
    return {
      kind: 'skip',
      entry: { ...src, reason: 'detection-error', message: `detection threw: ${(err as Error).message}` },
    };
  }

  if (!inUse) {
    return {
      kind: 'skip',
      entry: { ...src, reason: 'detection-no-match', message: 'declared globs matched fewer files than minCount' },
    };
  }

  return {
    kind: 'record',
    record: { ...src, data: validData, body },
  };
}

/**
 * Discover all in-use contributors of a given kind for a project.
 *
 * Walks two source classes:
 *
 *   1. Framework-shipped contributors — for each framework id in the project's
 *      `.aiwg/frameworks/registry.json`, look up its source path under the
 *      AIWG installation and check for `<kind>/contributor.md`.
 *
 *   2. Project-local contributors — every `.aiwg/contributors/<kind>/*.md`
 *      file in the project root. Lets users add custom contributors without
 *      forking a framework.
 *
 * Order is preserved: framework contributors appear in registry order, then
 * project-local contributors in glob order. Each kept record carries its
 * `origin` (framework id or `'project-local'`) and absolute `path`.
 *
 * Failures (parse, validation, detection-throw, detection-no-match) are
 * captured as `SkippedContributor` entries — discovery never aborts on a
 * single bad contributor.
 */
export async function discoverContributors(
  kind: ContributorKind,
  options: DiscoverOptions
): Promise<DiscoveryResult> {
  const { frameworkRoot, projectRoot } = options;
  const registryPath =
    options.registryPath ?? projectAiwgPath(projectRoot, 'frameworks', 'registry.json');

  const sources: ContributorOrigin[] = [];

  // 1. Framework-shipped contributors via registry.
  const registry = await readRegistry(registryPath);
  for (const entry of registry.frameworks) {
    const sourcePath = resolveFrameworkSourcePath(frameworkRoot, entry.id);
    if (!sourcePath) continue;
    const candidate = path.join(sourcePath, kind, 'contributor.md');
    if (existsSync(candidate)) {
      sources.push({ origin: entry.id, path: candidate });
    }
  }

  // 2. Project-local contributors.
  const localDir = projectAiwgPath(projectRoot, 'contributors', kind);
  if (existsSync(localDir)) {
    const localFiles = await glob('*.md', { cwd: localDir, absolute: true, nodir: true });
    localFiles.sort(); // deterministic ordering
    for (const file of localFiles) {
      sources.push({ origin: 'project-local', path: file });
    }
  }

  // Process each source. Failures become skip entries; the rest become records.
  const records: ContributorRecord[] = [];
  const skipped: SkippedContributor[] = [];
  for (const src of sources) {
    const result = await processContributor(src, projectRoot);
    if (result.kind === 'record') {
      records.push(result.record);
    } else {
      skipped.push(result.entry);
    }
  }

  return { kind, records, skipped };
}
