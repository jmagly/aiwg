import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
import { loadGraphIndexFile } from "./index-reader.js";

export interface FortemiCoreSyncOptions {
  graph?: GraphType;
  repo?: string;
  privacy?: AiwgPrivacyClassification;
  generatedAt?: string;
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

function syncDir(cwd: string, graph: string): string {
  loadGlobalGraphConfigs();
  const config = GRAPH_CONFIGS[graph];
  if (graph === "framework" || config?.shared) {
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

export function syncFortemiCoreIndex(
  cwd: string,
  options: FortemiCoreSyncOptions = {},
): FortemiCoreSyncManifest {
  const graph = options.graph ?? "project";
  const dir = syncDir(cwd, graph);
  const exportPath = path.join(dir, "aiwg-fortemi-index-v2.json");
  const manifestPath = path.join(dir, "manifest.json");
  const previous = readManifest(manifestPath);
  const sourceBuiltAt = sourceIndexBuiltAt(cwd, graph);

  const buildExport = (generatedAt: string): {
    generatedAt: string;
    json: string;
    checksum: string;
    itemCount: number;
    skosCoverage: FortemiCoreSyncManifest["skos_coverage"];
  } => {
    const exported = buildAiwgFortemiIndexExport(cwd, {
      graph,
      repo: options.repo,
      privacy: options.privacy,
      generatedAt,
      schemaVersion: "v2",
    });
    const json = JSON.stringify(exported, null, 2) + "\n";
    const recordsWithConcepts = exported.items.filter(
      (item) => (item.skos_concepts?.length ?? 0) > 0,
    ).length;
    return {
      generatedAt,
      json,
      checksum: sha256(json),
      itemCount: exported.items.length,
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

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(exportPath, built.json, "utf-8");
  const manifest: FortemiCoreSyncManifest = {
    schema_version: "aiwg.fortemi.core-sync.v1",
    backend: "fortemi-core",
    graph,
    generated_at: built.generatedAt,
    export_path: path.relative(cwd, exportPath),
    export_schema_version: "aiwg.fortemi.index.export.v2",
    export_checksum: built.checksum,
    item_count: built.itemCount,
    skos_coverage: built.skosCoverage,
    status,
    source_index_built_at: sourceBuiltAt,
  };
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  return manifest;
}

export function getFortemiCoreSyncStatus(
  cwd: string,
  graph: string = "project",
): FortemiCoreSyncStatus {
  const dir = syncDir(cwd, graph);
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
      const exportText = fs.readFileSync(exportPath, "utf-8");
      const exported = JSON.parse(exportText) as AiwgFortemiIndexExport;
      exportChecksumMatches = sha256(exportText) === manifest.export_checksum;
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
): FortemiCoreSyncStatus {
  const dir = prebuiltDir(graph) ?? path.join(process.cwd(), "prebuilt", "fortemi-core", graph);
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
      const exportText = fs.readFileSync(exportPath, "utf-8");
      const exported = JSON.parse(exportText) as AiwgFortemiIndexExport;
      if (
        prebuiltManifest.schema_version !== "aiwg.fortemi.prebuilt.v1" ||
        prebuiltManifest.backend !== "fortemi-core" ||
        prebuiltManifest.graph !== graph ||
        prebuiltManifest.export_path !== "aiwg-fortemi-index-v2.json" ||
        prebuiltManifest.export_schema_version !== "aiwg.fortemi.index.export.v2"
      ) {
        reason = "prebuilt manifest is incompatible with the requested graph";
      } else if (sha256(exportText) !== prebuiltManifest.export_checksum) {
        reason = "prebuilt export checksum does not match manifest";
      } else if (exported.schema_version !== prebuiltManifest.export_schema_version) {
        reason = `prebuilt export schema '${exported.schema_version}' does not match manifest '${prebuiltManifest.export_schema_version}'`;
      } else if (exported.source?.graph !== graph) {
        reason = `prebuilt export graph '${exported.source?.graph ?? "unknown"}' does not match requested graph '${graph}'`;
      } else if (!Array.isArray(exported.items) || exported.items.length !== prebuiltManifest.item_count) {
        reason = "prebuilt export item count does not match manifest";
      }
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
