/**
 * Heuristic Project-Type Inference
 *
 * Fallback used by `project-status` (and any other `kind: status` aggregator)
 * when contributor discovery returns zero in-use contributors. Detects what
 * kind of project this is from cheap local signals — manifest files, file
 * extensions, basic git presence — so the report still says something useful
 * for projects that have not opted into AIWG contributors.
 *
 * Local-only by design: no network calls, no `npm outdated`, no GitHub API.
 * The whole inference returns in O(few hundred ms) on a typical repo because
 * it only checks a small number of well-known paths and runs a handful of
 * bounded globs.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #941
 */

import { existsSync, statSync } from 'fs';
import { glob } from 'glob';
import path from 'path';

/**
 * Discriminator for the kind of dimension a heuristic detected. Future
 * dimensions register by adding a string here without breaking consumers.
 */
export type HeuristicDimensionKind = 'code' | 'docs' | 'assets' | 'mixed' | string;

/**
 * One dimension of the inferred project type. A project may have several —
 * a code repo with a docs/ subdir surfaces both `code` and `docs`. The
 * `confidence` field is a coarse signal-strength indicator the caller can
 * surface in the report ("(high confidence)").
 */
export interface HeuristicDimension {
  kind: HeuristicDimensionKind;
  /** Coarse confidence: 'high' = strong signal, 'medium' = present but mixed, 'low' = weak */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable summary line for the dimension. */
  summary: string;
  /** Structured detail rows for verbose output / --json. */
  details: Array<{ label: string; value: string }>;
}

export interface HeuristicReport {
  /** Always 'heuristic' so callers can stamp `origin: heuristic` on the block. */
  origin: 'heuristic';
  /** Dimensions in priority order: code, docs, assets, then anything else. */
  dimensions: HeuristicDimension[];
  /** True when no signals fired and the report has nothing to show. */
  empty: boolean;
}

/**
 * Manifest files that strongly indicate a code project, mapped to a label.
 * Order matters only for the summary string when multiple match.
 */
const CODE_MANIFESTS: Array<{ file: string; label: string }> = [
  { file: 'package.json', label: 'JS/TS' },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'requirements.txt', label: 'Python (pip)' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'go.mod', label: 'Go' },
  { file: 'pom.xml', label: 'Java (Maven)' },
  { file: 'build.gradle', label: 'JVM (Gradle)' },
  { file: 'build.gradle.kts', label: 'JVM (Gradle Kotlin)' },
  { file: 'Gemfile', label: 'Ruby' },
  { file: 'composer.json', label: 'PHP' },
  { file: 'mix.exs', label: 'Elixir' },
];

/** Common test directory names — presence indicates a code project takes testing seriously. */
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec'];

/** Asset file extensions, grouped by kind. Kept tight to avoid false positives on icons in docs. */
const ASSET_EXTENSIONS = {
  audio: ['mp3', 'flac', 'opus', 'm4a', 'wav', 'aac', 'ogg'],
  video: ['mp4', 'mkv', 'webm', 'mov', 'avi'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'tiff'],
};

/** Soft thresholds to call something "asset-dominant" rather than "has a few images". */
const ASSET_DOMINANCE_MIN = 25;

function existsCheap(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Format a Unix-epoch ms as a relative-age string. Cheap, no extra deps.
 */
function relativeAge(mtimeMs: number): string {
  const ageMs = Date.now() - mtimeMs;
  const day = 86_400_000;
  if (ageMs < day) return 'today';
  const days = Math.floor(ageMs / day);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

async function detectCodeDimension(projectRoot: string): Promise<HeuristicDimension | null> {
  const matchedManifests = CODE_MANIFESTS.filter(m => existsCheap(path.join(projectRoot, m.file)));
  if (matchedManifests.length === 0) return null;

  const details: Array<{ label: string; value: string }> = [
    { label: 'Manifests', value: matchedManifests.map(m => `${m.file} (${m.label})`).join(', ') },
  ];

  const testDirs = TEST_DIRS.filter(d => existsCheap(path.join(projectRoot, d)));
  details.push({
    label: 'Test directories',
    value: testDirs.length > 0 ? testDirs.join(', ') : 'none',
  });

  const readmePath = path.join(projectRoot, 'README.md');
  if (existsCheap(readmePath)) {
    try {
      const stat = statSync(readmePath);
      details.push({ label: 'README', value: `last edited ${relativeAge(stat.mtimeMs)}` });
    } catch {
      details.push({ label: 'README', value: 'present (mtime unavailable)' });
    }
  } else {
    details.push({ label: 'README', value: 'missing' });
  }

  const gitDir = path.join(projectRoot, '.git');
  details.push({ label: 'Git', value: existsCheap(gitDir) ? 'tracked' : 'not a git repo' });

  // Confidence is high when manifest + test dir + git all agree.
  const signals = (matchedManifests.length > 0 ? 1 : 0) + (testDirs.length > 0 ? 1 : 0) + (existsCheap(gitDir) ? 1 : 0);
  const confidence: HeuristicDimension['confidence'] = signals >= 3 ? 'high' : signals === 2 ? 'medium' : 'low';

  const summary =
    matchedManifests.length === 1
      ? `${matchedManifests[0].label} code project`
      : `code project (${matchedManifests.map(m => m.label).join(' + ')})`;

  return { kind: 'code', confidence, summary, details };
}

async function detectDocsDimension(projectRoot: string): Promise<HeuristicDimension | null> {
  // Cap the scan so this stays cheap on huge repos. We only need the order
  // of magnitude.
  const mdFiles = await glob('**/*.md', {
    cwd: projectRoot,
    nodir: true,
    ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'target/**'],
  });
  if (mdFiles.length < 5) return null;

  const hasCodeManifest = CODE_MANIFESTS.some(m => existsCheap(path.join(projectRoot, m.file)));
  // Docs project = lots of markdown AND no source manifests. With a manifest
  // it's just a code project that has docs — surface both, but mark this
  // dimension's confidence as low so the summary doesn't lie.
  const confidence: HeuristicDimension['confidence'] = hasCodeManifest ? 'low' : mdFiles.length > 50 ? 'high' : 'medium';

  const details: Array<{ label: string; value: string }> = [
    { label: 'Markdown files', value: String(mdFiles.length) },
  ];

  // Top-level docs dirs hint at organization.
  const docsDirs = ['docs', 'doc', 'documentation', 'wiki'].filter(d =>
    existsCheap(path.join(projectRoot, d))
  );
  details.push({
    label: 'Docs directories',
    value: docsDirs.length > 0 ? docsDirs.join(', ') : 'none at root',
  });

  return {
    kind: 'docs',
    confidence,
    summary: hasCodeManifest
      ? `${mdFiles.length} markdown files (code project with docs)`
      : `${mdFiles.length} markdown files (docs / knowledge project)`,
    details,
  };
}

async function detectAssetsDimension(projectRoot: string): Promise<HeuristicDimension | null> {
  const counts: Record<string, number> = {};
  let total = 0;

  for (const [kind, exts] of Object.entries(ASSET_EXTENSIONS)) {
    const pattern = `**/*.{${exts.join(',')}}`;
    const matches = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
    });
    counts[kind] = matches.length;
    total += matches.length;
  }

  if (total < ASSET_DOMINANCE_MIN) return null;

  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  return {
    kind: 'assets',
    confidence: total > 200 ? 'high' : total > 50 ? 'medium' : 'low',
    summary: `${total} media file${total === 1 ? '' : 's'} (${dominant[0]} dominant)`,
    details: [
      { label: 'Audio', value: String(counts.audio) },
      { label: 'Video', value: String(counts.video) },
      { label: 'Image', value: String(counts.image) },
    ],
  };
}

/**
 * Run all heuristic detectors and return a unified report. The caller
 * decides whether to surface this to the user — typically only when
 * `discoverContributors()` returns zero in-use contributors.
 */
export async function inferProjectType(projectRoot: string): Promise<HeuristicReport> {
  const [code, docs, assets] = await Promise.all([
    detectCodeDimension(projectRoot),
    detectDocsDimension(projectRoot),
    detectAssetsDimension(projectRoot),
  ]);

  const dimensions = [code, docs, assets].filter((d): d is HeuristicDimension => d !== null);

  return {
    origin: 'heuristic',
    dimensions,
    empty: dimensions.length === 0,
  };
}
