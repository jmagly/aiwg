import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { GraphType } from "./types.js";
import { GRAPH_CONFIGS, getProjectIndexRoot, loadGlobalGraphConfigs } from "./types.js";
import {
  buildAiwgFortemiIndexExport,
  type AiwgPrivacyClassification,
  type AiwgFortemiIndexExport,
} from "./browser-export.js";
import type { ArtifactIndex } from "./types.js";
import { loadGraphIndexFile, publishIndexFiles } from "./index-reader.js";
import { getFrameworkIndexBaseDir } from './framework-index-paths.js';
import { prebuiltFrameworkFreshnessReason } from './fortemi-core-prebuilt-freshness.js';

export interface FortemiCoreSyncOptions {
  graph?: GraphType;
  repo?: string;
  privacy?: AiwgPrivacyClassification;
  generatedAt?: string;
  /** Maximum serialized chunk size in UTF-16 characters (default: 64 KiB). */
  maxChunkChars?: number;
}

export interface FortemiCoreSyncManifest {
  schema_version: "aiwg.fortemi.core-sync.v1";
  backend: "fortemi-core";
  graph: string;
  generated_at: string;
  export_path: string;
  export_schema_version: "aiwg.fortemi.index.export.v2";
  export_checksum: string;
  item_count: number;
  text_quality?: {
    short_text_threshold_chars: number;
    short_text_count: number;
    filename_title_count: number;
    degenerate: boolean;
  };
  skos_coverage?: {
    records_with_concepts: number;
    total_records: number;
    ratio: number;
  };
  status: "created" | "updated" | "unchanged";
  source_index_built_at: string | null;
}

interface FortemiCorePrebuiltManifest {
  schema_version: "aiwg.fortemi.prebuilt.v1";
  backend: "fortemi-core";
  graph: string;
  generated_at: string;
  export_path: "aiwg-fortemi-index-v2.json";
  export_schema_version: "aiwg.fortemi.index.export.v2";
  export_checksum: string;
  item_count: number;
  source_index_built_at: string | null;
  package_version?: string;
  source_digest?: string;
}

export interface FortemiCoreSyncStatus {
  optedIn: boolean;
  source: "local" | "prebuilt" | "none";
  graph: string;
  location: string;
  manifestPath: string;
  exportPath: string;
  built: boolean;
  stale: boolean;
  /** A valid cache predates its source index; current metadata can be used instead. */
  sourceIndexNewer?: true;
  itemCount: number | null;
  exportChecksum: string | null;
  generatedAt: string | null;
  sourceIndexBuiltAt: string | null;
  reason: string | null;
}

export interface FortemiCoreExecutableSkillStatus {
  sourceExecutableCount: number;
  packagedExecutableCount: number;
  missing: string[];
}

export function getFortemiCoreIndexDir(cwd: string, graph: string): string {
  loadGlobalGraphConfigs();
  if (graph === 'framework') return path.join(getFrameworkIndexBaseDir(cwd), 'fortemi-core', graph);
  const config = GRAPH_CONFIGS[graph];
  if (config?.shared) {
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? cwd, ".local", "share");
    return path.join(xdgData, "aiwg", "index", "fortemi-core", graph);
  }
  return path.join(getProjectIndexRoot(cwd), "fortemi-core", graph);
}

function findPackageRoot(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function prebuiltDir(graph: string): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findPackageRoot(moduleDir);
  if (!packageRoot) return null;
  return path.join(packageRoot, "prebuilt", "fortemi-core", graph);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface ExportSnapshot {
  signature: string;
  checksum: string;
  exported: AiwgFortemiIndexExport;
}
// Status checks and the query reader often inspect the same large export.
// Keep at most two private snapshots, and never retain an object exposed to a
// caller: query results have always been fresh, mutable objects.
const exportSnapshots = new Map<string, ExportSnapshot>();

function exportSignature(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function readExportSnapshot(
  file: string,
  expectedChecksum: string | null,
): ExportSnapshot {
  const signature = exportSignature(file);
  const cached = exportSnapshots.get(file);
  // The manifest checksum is part of the snapshot identity. Filesystems may
  // preserve every stat field across a same-size rewrite within one timestamp
  // tick, while the manifest already names the replacement's checksum.
  if (
    cached?.signature === signature &&
    cached.checksum === expectedChecksum
  ) return cached;
  exportSnapshots.delete(file);
  const text = fs.readFileSync(file, "utf-8");
  const exported = JSON.parse(text) as AiwgFortemiIndexExport;
  const snapshot = { signature, exported, checksum: sha256(text) };
  // A concurrent replacement cannot publish a snapshot under the wrong stamp.
  if (exportSignature(file) === signature) {
    exportSnapshots.set(file, snapshot);
    while (exportSnapshots.size > 2) exportSnapshots.delete(exportSnapshots.keys().next().value!);
  }
  return snapshot;
}

/** Transfer a checked snapshot to the query reader without sharing mutable results. */
export function consumeFortemiCoreExport(file: string, expectedChecksum: string | null): AiwgFortemiIndexExport {
  try {
    const snapshot = readExportSnapshot(file, expectedChecksum);
    if (snapshot.checksum !== expectedChecksum) throw new Error("export checksum does not match manifest");
    return snapshot.exported;
  } finally {
    exportSnapshots.delete(file);
  }
}

function readManifest(manifestPath: string): FortemiCoreSyncManifest | null {
  return readManifestResult(manifestPath).manifest;
}

function readManifestResult(manifestPath: string): {
  manifest: FortemiCoreSyncManifest | null;
  reason: string | null;
} {
  if (!fs.existsSync(manifestPath)) return { manifest: null, reason: null };
  try {
    return {
      manifest: JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as FortemiCoreSyncManifest,
      reason: null,
    };
  } catch (err) {
    return {
      manifest: null,
      reason: `manifest file is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function sourceIndexBuiltAt(cwd: string, graph: GraphType): string | null {
  const index = loadGraphIndexFile<ArtifactIndex>(cwd, "metadata.json", graph);
  return typeof index?.builtAt === "string" ? index.builtAt : null;
}

/**
 * Emit the v2 JSON document without stringifying a collection or a whole record.
 * Strings are escaped in bounded slices too: a single large text field must not
 * reintroduce V8's string limit. Preserve pretty-print bytes for stable checksums.
 */
function* jsonTokens(value: unknown, maxChars: number, depth = 0, ancestors = new Set<object>()): Generator<string> {
  if (value && typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    value = value.toJSON();
  }
  if (typeof value === "string") {
    yield '"';
    const sliceChars = Math.floor(maxChars / 6); // A control character can expand to \uXXXX.
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + sliceChars, value.length);
      // Keep surrogate pairs together, including when UTF-8 encoding each write.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (value && typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    ancestors.add(value);
    const array = Array.isArray(value);
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
    yield array ? "[" : "{";
    for (let i = 0; i < entries.length; i++) {
      yield (i === 0 ? "\n" : ",\n") + "  ".repeat(depth + 1);
      const [key, item] = entries[i];
      if (!array) {
        yield* jsonTokens(key, maxChars, depth + 1, ancestors);
        yield ": ";
      }
      yield* jsonTokens(item, maxChars, depth + 1, ancestors);
    }
    if (entries.length) yield "\n" + "  ".repeat(depth);
    yield array ? "]" : "}";
    ancestors.delete(value);
  } else {
    yield JSON.stringify(value) ?? "null";
  }
}

/** Write and hash the same bounded chunks; publish only complete exports. */
function writeExport(file: string, exported: AiwgFortemiIndexExport, maxChars: number): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "w");
  try {
    const flush = (chunk: string): void => {
      const bytes = Buffer.from(chunk, "utf-8");
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    };
    let pending = "";
    for (const token of jsonTokens(exported, maxChars)) {
      if (pending.length + token.length > maxChars) {
        flush(pending);
        pending = "";
      }
      pending += token;
    }
    flush(pending);
    flush("\n");
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function syncFortemiCoreIndex(
  cwd: string,
  options: FortemiCoreSyncOptions = {},
): FortemiCoreSyncManifest {
  const graph = options.graph ?? "project";
  const dir = getFortemiCoreIndexDir(cwd, graph);
  const exportPath = path.join(dir, "aiwg-fortemi-index-v2.json");
  const manifestPath = path.join(dir, "manifest.json");
  const maxChars = options.maxChunkChars ?? 64 * 1024;
  if (!Number.isSafeInteger(maxChars) || maxChars < 64) throw new Error("maxChunkChars must be an integer of at least 64");
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, ".sync-"));
  const temporaryPath = path.join(staging, `.export-${randomUUID()}.tmp`);
  const previous = readManifest(manifestPath);
  const sourceBuiltAt = sourceIndexBuiltAt(cwd, graph);

  const buildExport = (generatedAt: string): {
    generatedAt: string;
    checksum: string;
    itemCount: number;
    textQuality: FortemiCoreSyncManifest["text_quality"];
    skosCoverage: FortemiCoreSyncManifest["skos_coverage"];
  } => {
    const exported = buildAiwgFortemiIndexExport(cwd, {
      graph,
      repo: options.repo,
      privacy: options.privacy,
      generatedAt,
      schemaVersion: "v2",
    });
    const checksum = writeExport(temporaryPath, exported, maxChars);
    const recordsWithConcepts = exported.items.filter(
      (item) => (item.skos_concepts?.length ?? 0) > 0,
    ).length;
    const shortTextThreshold = 200;
    let shortTextCount = 0;
    let filenameTitleCount = 0;
    for (const item of exported.items) {
      if (item.text.trim().length < shortTextThreshold) shortTextCount++;
      if (item.title.trim() === path.posix.basename(item.source.path)) filenameTitleCount++;
    }
    return {
      generatedAt,
      checksum,
      itemCount: exported.items.length,
      textQuality: {
        short_text_threshold_chars: shortTextThreshold,
        short_text_count: shortTextCount,
        filename_title_count: filenameTitleCount,
        degenerate: exported.items.length === 0 || shortTextCount / exported.items.length >= 0.8,
      },
      skosCoverage: {
        records_with_concepts: recordsWithConcepts,
        total_records: exported.items.length,
        ratio:
          exported.items.length === 0
            ? 1
            : Math.round((recordsWithConcepts / exported.items.length) * 10000) /
              10000,
      },
    };
  };

  try {
    let built = buildExport(
      options.generatedAt ?? previous?.generated_at ?? new Date().toISOString(),
    );
    let status: FortemiCoreSyncManifest["status"] = "created";
    if (previous) {
      if (previous.export_checksum === built.checksum) {
        status = "unchanged";
      } else {
        status = "updated";
        if (options.generatedAt === undefined) {
          built = buildExport(new Date().toISOString());
        }
      }
    }

    fs.renameSync(temporaryPath, path.join(staging, path.basename(exportPath)));
    const manifest: FortemiCoreSyncManifest = {
      schema_version: "aiwg.fortemi.core-sync.v1",
      backend: "fortemi-core",
      graph,
      generated_at: built.generatedAt,
      export_path: path.relative(cwd, exportPath),
      export_schema_version: "aiwg.fortemi.index.export.v2",
      export_checksum: built.checksum,
      item_count: built.itemCount,
      text_quality: built.textQuality,
      skos_coverage: built.skosCoverage,
      status,
      source_index_built_at: sourceBuiltAt,
    };
    fs.writeFileSync(
      path.join(staging, path.basename(manifestPath)),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8",
    );
    publishIndexFiles(staging, dir);
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function getFortemiCoreSyncStatus(
  cwd: string,
  graph: string = "project",
): FortemiCoreSyncStatus {
  const dir = getFortemiCoreIndexDir(cwd, graph);
  const manifestPath = path.join(dir, "manifest.json");
  const exportPath = path.join(dir, "aiwg-fortemi-index-v2.json");
  const { manifest, reason: manifestReadReason } = readManifestResult(manifestPath);
  if (!manifest) {
    return {
      optedIn: manifestReadReason !== null,
      source: "none",
      graph,
      location: dir,
      manifestPath,
      exportPath,
      built: false,
      stale: manifestReadReason !== null,
      itemCount: null,
      exportChecksum: null,
      generatedAt: null,
      sourceIndexBuiltAt: null,
      reason: manifestReadReason,
    };
  }

  const exportExists = fs.existsSync(exportPath);
  let exportReadReason: string | null = null;
  let exportChecksumMatches = false;
  if (exportExists) {
    try {
      const { exported, checksum } = readExportSnapshot(
        exportPath,
        manifest.export_checksum,
      );
      exportChecksumMatches = checksum === manifest.export_checksum;
      if (exportChecksumMatches) {
        if (exported.schema_version !== manifest.export_schema_version) {
          exportReadReason = `export schema '${exported.schema_version}' does not match manifest '${manifest.export_schema_version}'`;
        }
      } else {
        exportReadReason = "export checksum does not match manifest";
      }
    } catch (err) {
      exportReadReason = `export file is unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const currentSourceBuiltAt = sourceIndexBuiltAt(cwd, graph as GraphType);
  const sourceIsNewer =
    exportExists &&
    exportReadReason === null &&
    manifest.source_index_built_at !== null &&
    currentSourceBuiltAt !== null &&
    Date.parse(currentSourceBuiltAt) >
      Date.parse(manifest.source_index_built_at);
  const stale = !exportExists || exportReadReason !== null || sourceIsNewer;
  return {
    optedIn: true,
    source: "local",
    graph,
    location: dir,
    manifestPath,
    exportPath,
    built: exportExists,
    stale,
    ...(sourceIsNewer ? { sourceIndexNewer: true as const } : {}),
    itemCount: manifest.item_count,
    exportChecksum: manifest.export_checksum,
    generatedAt: manifest.generated_at,
    sourceIndexBuiltAt: manifest.source_index_built_at,
    reason: !exportExists
      ? "manifest exists but export file is missing"
      : exportReadReason
        ? exportReadReason
      : sourceIsNewer
        ? "source index is newer than the Fortemi Core static cache"
      : null,
  };
}

export function getFortemiCorePrebuiltStatus(
  graph: string = "framework",
  packageRoot?: string,
): FortemiCoreSyncStatus {
  const dir = (packageRoot ? path.join(packageRoot, "prebuilt", "fortemi-core", graph) : prebuiltDir(graph)) ?? path.join(process.cwd(), "prebuilt", "fortemi-core", graph);
  const manifestPath = path.join(dir, "manifest.json");
  const exportPath = path.join(dir, "aiwg-fortemi-index-v2.json");
  const { manifest, reason: manifestReadReason } = readManifestResult(manifestPath);
  if (!manifest) {
    return {
      optedIn: false,
      source: "none",
      graph,
      location: dir,
      manifestPath,
      exportPath,
      built: false,
      stale: false,
      itemCount: null,
      exportChecksum: null,
      generatedAt: null,
      sourceIndexBuiltAt: null,
      reason: manifestReadReason,
    };
  }
  const prebuiltManifest = manifest as unknown as FortemiCorePrebuiltManifest;

  const exportExists = fs.existsSync(exportPath);
  let reason: string | null = null;
  if (exportExists) {
    try {
      const { exported, checksum } = readExportSnapshot(
        exportPath,
        prebuiltManifest.export_checksum,
      );
      if (
        prebuiltManifest.schema_version !== "aiwg.fortemi.prebuilt.v1" ||
        prebuiltManifest.backend !== "fortemi-core" ||
        prebuiltManifest.graph !== graph ||
        prebuiltManifest.export_path !== "aiwg-fortemi-index-v2.json" ||
        prebuiltManifest.export_schema_version !== "aiwg.fortemi.index.export.v2"
      ) {
        reason = "prebuilt manifest is incompatible with the requested graph";
      } else if (checksum !== prebuiltManifest.export_checksum) {
        reason = "prebuilt export checksum does not match manifest";
      } else if (exported.schema_version !== prebuiltManifest.export_schema_version) {
        reason = `prebuilt export schema '${exported.schema_version}' does not match manifest '${prebuiltManifest.export_schema_version}'`;
      } else if (exported.source?.graph !== graph) {
        reason = `prebuilt export graph '${exported.source?.graph ?? "unknown"}' does not match requested graph '${graph}'`;
      } else if (!Array.isArray(exported.items) || exported.items.length !== prebuiltManifest.item_count) {
        reason = "prebuilt export item count does not match manifest";
      }
      if (!reason && graph === 'framework') reason = prebuiltFrameworkFreshnessReason(path.resolve(dir, '../../..'), prebuiltManifest);
    } catch (err) {
      reason = `prebuilt export file is unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    optedIn: true,
    source: "prebuilt",
    graph,
    location: dir,
    manifestPath,
    exportPath,
    built: exportExists,
    stale: !exportExists || reason !== null,
    itemCount: prebuiltManifest.item_count,
    exportChecksum: prebuiltManifest.export_checksum,
    generatedAt: prebuiltManifest.generated_at,
    sourceIndexBuiltAt: prebuiltManifest.source_index_built_at,
    reason: !exportExists ? "prebuilt manifest exists but export file is missing" : reason,
  };
}

/**
 * Compare source script declarations with their compact prebuilt records.
 * This is deliberately independent of cache freshness: a checksum-valid index
 * can still be operationally broken when compaction drops runtime metadata.
 */
export function getFortemiCoreExecutableSkillStatus(
  graph: string = "framework",
  packageRoot?: string,
): FortemiCoreExecutableSkillStatus {
  const root = packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!root) return { sourceExecutableCount: 0, packagedExecutableCount: 0, missing: [] };
  const exportPath = path.join(root, "prebuilt", "fortemi-core", graph, "aiwg-fortemi-index-v2.json");
  if (!fs.existsSync(exportPath)) return { sourceExecutableCount: 0, packagedExecutableCount: 0, missing: [] };

  const exported = JSON.parse(fs.readFileSync(exportPath, "utf-8")) as AiwgFortemiIndexExport;
  let sourceExecutableCount = 0;
  let packagedExecutableCount = 0;
  const missing: string[] = [];
  for (const item of exported.items ?? []) {
    if (item.type !== "aiwg.skill" || typeof item.source?.path !== "string") continue;
    const sourcePath = path.join(root, item.source.path);
    if (!fs.existsSync(sourcePath)) continue;
    const match = fs.readFileSync(sourcePath, "utf-8").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const script = (parseYaml(match[1]) as { script?: unknown } | null)?.script;
    if (!script) continue;
    sourceExecutableCount += 1;
    if (item.search?.frontmatter?.aiwg_script) packagedExecutableCount += 1;
    else missing.push(item.name ?? item.id);
  }
  return { sourceExecutableCount, packagedExecutableCount, missing };
}
