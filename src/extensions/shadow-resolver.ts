/**
 * Shadow Resolver
 *
 * Implements the override / shadow-resolution policy from
 * `docs/customization/project-local-lifecycle.md` (#1041) for project-local
 * artifact bundles deployed via `aiwg use` / `aiwg refresh`.
 *
 * Resolves the seven cases from ADR §4:
 *
 *   1. No collision — deploy normally
 *   2. Non-safety-critical shadow — deploy + warn
 *   3. Safety-critical shadow with `overrides:` declaration — deploy + prominent warn
 *   4. Safety-critical shadow without `overrides:` — REFUSE
 *   5. Phantom override (declared override has no upstream match) — REFUSE
 *   6. Two project-local bundles export the same id — REFUSE both
 *   7. git-installed source collides with project-local — same as 2/3/4 against cache
 *
 * Inputs: the project-local bundles (from `discoverProjectLocalBundles`) and
 * an upstream registry (from `buildUpstreamRegistry`). Outputs a per-artifact
 * verdict that the deployment pipeline consumes to decide what to write to
 * provider paths.
 *
 * @implements #1036
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import type { ProjectLocalBundle } from './project-local-discovery.js';
import type {
  UpstreamArtifact,
  UpstreamArtifactType,
  UpstreamRegistry,
} from './upstream-registry.js';

export type ShadowVerdict =
  | 'deploy'              // Case 1 — no collision; deploy unchanged
  | 'deploy-with-warning' // Case 2 — non-safety shadow; deploy + warn
  | 'deploy-acknowledged' // Case 3 — safety-critical shadow + overrides; deploy + prominent warn
  | 'refuse-unsafe'       // Case 4 — safety-critical shadow, no overrides
  | 'refuse-phantom'      // Case 5 — overrides declares non-existent upstream id
  | 'refuse-duplicate';   // Case 6 — two project-local bundles export same id

export interface ShadowResolution {
  /** Project-local bundle the artifact belongs to. */
  bundleId: string;
  bundleLocalPath: string;
  /** Artifact within the bundle. */
  artifactId: string;
  artifactType: UpstreamArtifactType;
  artifactSourcePath: string;
  /** Upstream artifact being shadowed (when applicable). */
  upstream?: UpstreamArtifact;
  verdict: ShadowVerdict;
  /** Operator-visible message for warning / error output. */
  message: string;
  /** True for verdicts that block deployment of this artifact. */
  blocking: boolean;
  /** True for the prominent (multi-line, color-in-TTY) safety-critical warning. */
  prominent: boolean;
}

export interface ResolveOptions {
  /** Strict mode: phantom overrides also block bundle deployment.
   * Defaults to true (matches ADR §4 case 5). */
  strictPhantomOverrides?: boolean;
}

export interface ResolveResult {
  resolutions: ShadowResolution[];
  /** Bundle ids that have at least one blocking resolution and should be
   * skipped wholesale (case 6 — duplicate id refuses both). */
  blockedBundleIds: Set<string>;
  /** Convenience filters. */
  shadows: ShadowResolution[]; // anything where upstream !== undefined
}

const ARTIFACT_DIRS: Record<string, UpstreamArtifactType> = {
  agents: 'agent',
  skills: 'skill',
  rules: 'rule',
  commands: 'command',
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const ID_LINE_RE = /^id\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m;
const NAME_LINE_RE = /^name\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m;

function parseId(raw: string): { id?: string; name?: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return {};
  return {
    id: ID_LINE_RE.exec(m[1])?.[1]?.trim(),
    name: NAME_LINE_RE.exec(m[1])?.[1]?.trim(),
  };
}

export interface BundleArtifact {
  id: string;
  type: UpstreamArtifactType;
  sourcePath: string;
}

/** Enumerate the artifacts a project-local bundle would deploy by walking its
 * source `agents/`, `skills/`, `rules/`, `commands/` subdirs — same pattern as
 * `deployOneProjectLocalBundle` and `countBundleSourceArtifacts` in use.ts. */
export async function enumerateBundleArtifacts(bundlePath: string): Promise<BundleArtifact[]> {
  const out: BundleArtifact[] = [];
  for (const [dirName, type] of Object.entries(ARTIFACT_DIRS)) {
    const artifactDir = join(bundlePath, dirName);
    let entries: string[];
    try {
      entries = await readdir(artifactDir);
    } catch {
      continue;
    }
    if (type === 'skill') {
      for (const entry of entries) {
        const skillDir = join(artifactDir, entry);
        try {
          const st = await stat(skillDir);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }
        let id = entry;
        try {
          const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
          const fm = parseId(skillMd);
          id = fm.name ?? fm.id ?? entry;
        } catch {
          // No SKILL.md — fall back to dir name
        }
        out.push({ id, type, sourcePath: skillDir });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      if (entry === 'README.md' || entry === 'RULES-INDEX.md' || entry === 'INDEX.md') continue;
      const filePath = join(artifactDir, entry);
      let id = basename(entry, '.md');
      try {
        const raw = await readFile(filePath, 'utf-8');
        const fm = parseId(raw);
        id = fm.id ?? fm.name ?? id;
      } catch {
        // Read failure — fall back to filename
      }
      out.push({ id, type, sourcePath: filePath });
    }
  }
  return out;
}

/** Resolve overrides + shadows for a set of project-local bundles against an
 * upstream registry. Pure function — no filesystem side effects beyond reading
 * the bundle artifact files for id extraction. */
export async function resolveShadows(
  bundles: ProjectLocalBundle[],
  upstream: UpstreamRegistry,
  options: ResolveOptions = {}
): Promise<ResolveResult> {
  const strictPhantomOverrides = options.strictPhantomOverrides ?? true;
  const resolutions: ShadowResolution[] = [];
  const blockedBundleIds = new Set<string>();

  // Pre-pass: case 6 — duplicate project-local bundle ids (cross-bundle, by
  // artifact id+type). Discovery already rejects same-type duplicate bundle
  // ids (#1041 §4 case 6 at the bundle level); here we additionally guard
  // against two distinct bundles exporting an artifact with the same id+type.
  const projectLocalArtifacts = new Map<string, { bundle: ProjectLocalBundle; art: BundleArtifact }[]>();

  // Enumerate every artifact in every bundle once.
  const enumerated: { bundle: ProjectLocalBundle; arts: BundleArtifact[] }[] = [];
  for (const bundle of bundles) {
    // Preserve compatibility for programmatic callers that constructed the
    // pre-#1868 ProjectLocalBundle shape; discovery always supplies artifactPath.
    const arts = await enumerateBundleArtifacts(bundle.artifactPath ?? bundle.bundlePath);
    enumerated.push({ bundle, arts });
    for (const art of arts) {
      const key = `${art.type}:${art.id}`;
      const list = projectLocalArtifacts.get(key) ?? [];
      list.push({ bundle, art });
      projectLocalArtifacts.set(key, list);
    }
  }

  for (const { bundle, arts } of enumerated) {
    const declaredOverrides = new Set(bundle.manifest.overrides ?? []);

    // Case 5 pre-pass: validate every declared override resolves to *some*
    // upstream artifact (any type). Phantom overrides refuse the bundle.
    for (const overrideId of declaredOverrides) {
      if (!upstream.byId.has(overrideId)) {
        resolutions.push({
          bundleId: bundle.id,
          bundleLocalPath: bundle.localPath,
          artifactId: overrideId,
          artifactType: 'rule', // unknown — picked nominal type for surface
          artifactSourcePath: bundle.manifestPath,
          verdict: 'refuse-phantom',
          message: `Phantom override: '${overrideId}' declared in ${bundle.manifestPath} but no upstream artifact has that id.`,
          blocking: strictPhantomOverrides,
          prominent: false,
        });
        if (strictPhantomOverrides) blockedBundleIds.add(bundle.id);
      }
    }

    for (const art of arts) {
      const key = `${art.type}:${art.id}`;

      // Case 6 — duplicate project-local artifact id+type across bundles
      const projectLocalGroup = projectLocalArtifacts.get(key) ?? [];
      if (projectLocalGroup.length > 1) {
        const others = projectLocalGroup
          .filter((p) => p.bundle.id !== bundle.id)
          .map((p) => p.bundle.localPath);
        resolutions.push({
          bundleId: bundle.id,
          bundleLocalPath: bundle.localPath,
          artifactId: art.id,
          artifactType: art.type,
          artifactSourcePath: art.sourcePath,
          verdict: 'refuse-duplicate',
          message: `Duplicate project-local ${art.type} '${art.id}' also exported by: ${others.join(', ')}`,
          blocking: true,
          prominent: false,
        });
        blockedBundleIds.add(bundle.id);
        continue;
      }

      const upstreamMatch = upstream.byKey.get(key);

      // Case 1 — no collision
      if (!upstreamMatch) {
        resolutions.push({
          bundleId: bundle.id,
          bundleLocalPath: bundle.localPath,
          artifactId: art.id,
          artifactType: art.type,
          artifactSourcePath: art.sourcePath,
          verdict: 'deploy',
          message: '',
          blocking: false,
          prominent: false,
        });
        continue;
      }

      const acknowledged = declaredOverrides.has(art.id);

      if (upstreamMatch.safetyCritical) {
        if (acknowledged) {
          // Case 3 — safety-critical with explicit override
          resolutions.push({
            bundleId: bundle.id,
            bundleLocalPath: bundle.localPath,
            artifactId: art.id,
            artifactType: art.type,
            artifactSourcePath: art.sourcePath,
            upstream: upstreamMatch,
            verdict: 'deploy-acknowledged',
            message:
              `SAFETY-CRITICAL SHADOW: ${art.type} '${art.id}' overridden by ${art.sourcePath}.\n` +
              `  Acknowledge: this disables upstream safeguard at ${upstreamMatch.sourcePath}.\n` +
              `  Use 'aiwg doctor' to review all active shadows.`,
            blocking: false,
            prominent: true,
          });
        } else {
          // Case 4 — refuse
          resolutions.push({
            bundleId: bundle.id,
            bundleLocalPath: bundle.localPath,
            artifactId: art.id,
            artifactType: art.type,
            artifactSourcePath: art.sourcePath,
            upstream: upstreamMatch,
            verdict: 'refuse-unsafe',
            message:
              `Refused to shadow safety-critical upstream ${art.type} '${art.id}'. ` +
              `Add 'overrides: ["${art.id}"]' to ${bundle.manifestPath} to authorize the override.`,
            blocking: true,
            prominent: true,
          });
          blockedBundleIds.add(bundle.id);
        }
        continue;
      }

      // Case 2 — non-safety shadow
      const sourceLabel = upstreamMatch.source === 'cache' ? 'git-installed' : 'bundled';
      resolutions.push({
        bundleId: bundle.id,
        bundleLocalPath: bundle.localPath,
        artifactId: art.id,
        artifactType: art.type,
        artifactSourcePath: art.sourcePath,
        upstream: upstreamMatch,
        verdict: 'deploy-with-warning',
        message:
          `Shadow: ${art.type} '${art.id}' — project-local at ${art.sourcePath} ` +
          `overrides ${sourceLabel} at ${upstreamMatch.sourcePath}`,
        blocking: false,
        prominent: false,
      });
    }
  }

  const shadows = resolutions.filter((r) => r.upstream !== undefined);
  return { resolutions, blockedBundleIds, shadows };
}

/** Format a multi-resolution summary suitable for stderr or doctor output. */
export function formatShadowReport(result: ResolveResult): string {
  if (result.resolutions.length === 0) return '';
  const lines: string[] = [];
  const blockers = result.resolutions.filter((r) => r.blocking);
  const warnings = result.resolutions.filter(
    (r) => !r.blocking && (r.verdict === 'deploy-with-warning' || r.verdict === 'deploy-acknowledged')
  );

  if (blockers.length > 0) {
    lines.push('── Project-local shadow resolution: blocked artifacts ──');
    for (const r of blockers) {
      lines.push(`  ✗ [${r.verdict}] ${r.bundleId} :: ${r.artifactType}/${r.artifactId}`);
      for (const ml of r.message.split('\n')) lines.push(`    ${ml}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('── Project-local shadows ──');
    for (const r of warnings) {
      const marker = r.prominent ? '!!' : '⚠';
      lines.push(`  ${marker} [${r.verdict}] ${r.bundleId} :: ${r.artifactType}/${r.artifactId}`);
      for (const ml of r.message.split('\n')) lines.push(`    ${ml}`);
    }
  }

  return lines.join('\n');
}
