/**
 * Upstream Artifact Registry
 *
 * Scans the framework root for upstream artifacts (agents, skills, rules,
 * commands) under `agentic/code/{frameworks,addons}/*` and returns an
 * id-indexed registry. Each entry carries the `safety-critical` flag (parsed
 * from frontmatter for `.md` artifacts and from `manifest.json` at the bundle
 * level), the source kind ('bundled' for npm-shipped, 'cache' for git-installed),
 * and the absolute source path.
 *
 * Consumed by the shadow resolver (#1036) to detect collisions between project-
 * local bundles and upstream artifacts and apply the override / safety-critical
 * denylist policy from `docs/customization/project-local-lifecycle.md`.
 *
 * @implements #1036
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';

export type UpstreamArtifactType = 'agent' | 'skill' | 'rule' | 'command';
export type UpstreamSource = 'bundled' | 'cache';

export interface UpstreamArtifact {
  /** Artifact id (rule frontmatter id, skill dir name, or filename minus extension) */
  id: string;
  type: UpstreamArtifactType;
  /** Absolute path to the artifact file (or directory for skills) */
  sourcePath: string;
  /** Owning bundle directory name (e.g., "aiwg-utils", "sdlc-complete") */
  bundleName: string;
  /** Source kind — npm-shipped or git-installed */
  source: UpstreamSource;
  /** Whether the artifact is on the safety-critical denylist (#1041 §2) */
  safetyCritical: boolean;
}

export interface UpstreamRegistry {
  /** Lookup by `${type}:${id}` — matches the shadow detection key shape */
  byKey: Map<string, UpstreamArtifact>;
  /** Lookup by id alone, returning all artifacts (any type) with that id */
  byId: Map<string, UpstreamArtifact[]>;
}

/** Subdir name → singular type, for the four artifact kinds the resolver cares about. */
const ARTIFACT_DIRS: Record<string, UpstreamArtifactType> = {
  agents: 'agent',
  skills: 'skill',
  rules: 'rule',
  commands: 'command',
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const ID_LINE_RE = /^id\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m;
const NAME_LINE_RE = /^name\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m;
// `safety-critical: true` (also accepts safety_critical for snake_case tolerance)
const SAFETY_CRITICAL_RE = /^(?:safety-critical|safety_critical)\s*:\s*true\s*$/m;

/** Parse YAML frontmatter for the small set of fields we care about. Returns
 * `{}` if no frontmatter or no recognized field. We avoid pulling in a YAML
 * dependency for this single-purpose scan. */
function parseFrontmatterFields(raw: string): { id?: string; name?: string; safetyCritical: boolean } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { safetyCritical: false };
  const body = match[1];
  const idMatch = ID_LINE_RE.exec(body);
  const nameMatch = NAME_LINE_RE.exec(body);
  return {
    id: idMatch?.[1]?.trim(),
    name: nameMatch?.[1]?.trim(),
    safetyCritical: SAFETY_CRITICAL_RE.test(body),
  };
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Read the bundle's manifest.json (if any) and pull `safety-critical: true` —
 * a bundle-level flag opts in every artifact in the bundle, per ADR §2. */
async function readBundleSafetyCritical(bundleDir: string): Promise<boolean> {
  const raw = await readSafe(join(bundleDir, 'manifest.json'));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['safety-critical'] === true;
  } catch {
    return false;
  }
}

/** Scan a single artifact-type directory inside a bundle and emit artifacts. */
async function scanArtifactDir(
  artifactDir: string,
  type: UpstreamArtifactType,
  bundleName: string,
  source: UpstreamSource,
  bundleSafetyCritical: boolean
): Promise<UpstreamArtifact[]> {
  const out: UpstreamArtifact[] = [];
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch {
    return out;
  }

  if (type === 'skill') {
    // Skills are subdirectories — id = directory name; safety-critical from
    // SKILL.md frontmatter or bundle-level flag.
    for (const entry of entries) {
      const skillDir = join(artifactDir, entry);
      if (!(await isDir(skillDir))) continue;
      const skillMd = await readSafe(join(skillDir, 'SKILL.md'));
      const fm = skillMd ? parseFrontmatterFields(skillMd) : { safetyCritical: false };
      out.push({
        id: fm.name ?? fm.id ?? entry,
        type,
        sourcePath: skillDir,
        bundleName,
        source,
        safetyCritical: bundleSafetyCritical || fm.safetyCritical,
      });
    }
    return out;
  }

  // agents / rules / commands — flat .md files.
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'README.md' || entry === 'RULES-INDEX.md' || entry === 'INDEX.md') continue;
    const filePath = join(artifactDir, entry);
    const raw = await readSafe(filePath);
    const fm = raw ? parseFrontmatterFields(raw) : { safetyCritical: false };
    const fallbackId = basename(entry, '.md');
    out.push({
      id: fm.id ?? fm.name ?? fallbackId,
      type,
      sourcePath: filePath,
      bundleName,
      source,
      safetyCritical: bundleSafetyCritical || fm.safetyCritical,
    });
  }
  return out;
}

/** Scan one bundle directory across all four artifact types. */
async function scanBundle(
  bundleDir: string,
  source: UpstreamSource
): Promise<UpstreamArtifact[]> {
  const bundleName = basename(bundleDir);
  const bundleSafetyCritical = await readBundleSafetyCritical(bundleDir);
  const out: UpstreamArtifact[] = [];
  for (const [dirName, type] of Object.entries(ARTIFACT_DIRS)) {
    const artifactDir = join(bundleDir, dirName);
    if (!(await isDir(artifactDir))) continue;
    const found = await scanArtifactDir(artifactDir, type, bundleName, source, bundleSafetyCritical);
    out.push(...found);
  }
  return out;
}

/** Scan all `agentic/code/{frameworks,addons}/*` bundles under the framework
 * root (npm-bundled artifacts) plus an optional cache directory for git-
 * installed artifacts. */
export async function buildUpstreamRegistry(opts: {
  frameworkRoot: string;
  /** Optional directory of git-installed packages (e.g., ~/.cache/aiwg/packages). */
  cacheRoot?: string;
}): Promise<UpstreamRegistry> {
  const { frameworkRoot, cacheRoot } = opts;
  const all: UpstreamArtifact[] = [];

  for (const containerDir of ['agentic/code/frameworks', 'agentic/code/addons']) {
    const root = join(frameworkRoot, containerDir);
    let bundleNames: string[];
    try {
      bundleNames = await readdir(root);
    } catch {
      continue;
    }
    for (const bundleName of bundleNames) {
      const bundleDir = join(root, bundleName);
      if (!(await isDir(bundleDir))) continue;
      all.push(...(await scanBundle(bundleDir, 'bundled')));
    }
  }

  if (cacheRoot) {
    try {
      const entries = await readdir(cacheRoot);
      for (const entry of entries) {
        const bundleDir = join(cacheRoot, entry);
        if (!(await isDir(bundleDir))) continue;
        all.push(...(await scanBundle(bundleDir, 'cache')));
      }
    } catch {
      // Cache root absent — fine.
    }
  }

  const byKey = new Map<string, UpstreamArtifact>();
  const byId = new Map<string, UpstreamArtifact[]>();

  for (const art of all) {
    const key = `${art.type}:${art.id}`;
    // Precedence within upstream: cache > bundled (git-installed wins over npm
    // bundle, per ADR §1). First write wins after we sort cache-first.
    const existing = byKey.get(key);
    if (!existing || (art.source === 'cache' && existing.source === 'bundled')) {
      byKey.set(key, art);
    }
    const list = byId.get(art.id) ?? [];
    list.push(art);
    byId.set(art.id, list);
  }

  return { byKey, byId };
}
