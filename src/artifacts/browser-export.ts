import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { load as loadYaml } from "js-yaml";
import type {
  ArtifactIndex,
  DependencyGraph,
  GraphType,
  MetadataEntry,
  TypedEdge,
} from "./types.js";
import { loadGraphIndexFile } from "./index-reader.js";
import type { OperationalStateProvenance } from "./operational-state.js";

export type AiwgFortemiRecordType =
  | "crm.contact"
  | "crm.organization"
  | "crm.event"
  | "crm.interaction"
  | "aiwg.artifact"
  | "aiwg.skill"
  | "aiwg.agent"
  | "aiwg.command"
  | "aiwg.rule"
  | "aiwg.schema"
  | "aiwg.behavior"
  | "aiwg.flow"
  | "aiwg.provider"
  | "aiwg.bundle"
  | "aiwg.research.ref"
  | "aiwg.research.profile"
  | "aiwg.research.view"
  | "aiwg.research.synthesis"
  | "aiwg.kb.page"
  | "aiwg.memory.entry"
  | "aiwg.issue"
  | `aiwg.source.${string}`
  | `aiwg.project.${string}`;

export type AiwgFortemiExportSchemaVersion = "v1" | "v2";
export type AiwgFortemiRecordSchemaVersion =
  | "aiwg.fortemi.index.record.v1"
  | "aiwg.fortemi.index.record.v2";

export type AiwgPrivacyClassification = "private" | "sanitized" | "public";
export type AiwgProvenanceConfidence =
  | "source"
  | "candidate"
  | "reviewed"
  | "rejected";

export interface AiwgFortemiRecordSource {
  path: string;
  repo_relative_path: string;
  locator: string;
  origin?: string;
  generated?: boolean;
  checksum?: string;
  updated_at?: string;
}

export interface AiwgFortemiRelationship {
  type: string;
  target_id: string;
  source_path?: string;
  target_path?: string;
  direction?: "upstream" | "downstream" | "related";
  label?: string;
  confidence?: number;
  privacy?: AiwgPrivacyClassification;
  metadata?: Record<string, unknown>;
}

export interface AiwgFortemiProvenance {
  field: string;
  source: string;
  path: string;
  confidence: AiwgProvenanceConfidence;
  privacy: AiwgPrivacyClassification;
}

export interface AiwgFortemiSkosConcept {
  id: string;
  prefLabel: string;
  definition?: string;
  scheme?: string;
  notation?: string;
  uri?: string;
  altLabels?: string[];
  metadata?: Record<string, unknown>;
}

export interface AiwgFortemiSkosRelation {
  type: string;
  source_id: string;
  target_id: string;
  source_path?: string;
  metadata?: Record<string, unknown>;
}

export interface AiwgFortemiProvenanceEvent {
  id?: string;
  activity: string;
  agent?: string;
  started_at?: string;
  ended_at?: string;
  source?: string;
  path?: string;
  confidence?: AiwgProvenanceConfidence;
  privacy?: AiwgPrivacyClassification;
  attributes?: Record<string, unknown>;
}

export interface AiwgFortemiRecord {
  schema_version: AiwgFortemiRecordSchemaVersion;
  id: string;
  type: AiwgFortemiRecordType;
  source: AiwgFortemiRecordSource;
  title: string;
  name?: string;
  summary?: string;
  text: string;
  search?: {
    title: string;
    name?: string;
    summary?: string;
    body: string;
    triggers: string[];
    aliases: string[];
    capability?: string;
    tags: string[];
    phase?: string;
    type?: string;
    frontmatter: Record<string, unknown>;
  };
  facets: Record<string, string[]>;
  tags: string[];
  concepts: string[];
  relationships: AiwgFortemiRelationship[];
  provenance: AiwgFortemiProvenance[];
  privacy: {
    classification: AiwgPrivacyClassification;
    pii: boolean;
    locality?: "project" | "framework" | "external";
  };
  chunks?: Array<{
    id: string;
    text: string;
    body?: string;
    summary?: string;
    source_path?: string;
    metadata?: Record<string, unknown>;
    checksum: string;
  }>;
  embeddings?: Array<{
    id?: string;
    model: string;
    embedding?: number[];
    vector?: number[];
    granularity?: string;
    source_path?: string;
    metadata?: Record<string, unknown>;
    chunk_id?: string;
    vector_ref?: string;
    input_hash: string;
  }>;
  skos_concepts?: AiwgFortemiSkosConcept[];
  skos_relations?: AiwgFortemiSkosRelation[];
  provenance_events?: AiwgFortemiProvenanceEvent[];
  compatibility?: Record<string, unknown>;
  operational_state?: OperationalStateProvenance;
  state_transfer?: {
    deleted_at: string | null;
  };
  updated_at: string;
}

export interface AiwgFortemiIndexExport {
  schema_version:
    | "aiwg.fortemi.index.export.v1"
    | "aiwg.fortemi.index.export.v2";
  generated_at: string;
  source: {
    repo: string;
    privacy: AiwgPrivacyClassification;
    graph?: string;
  };
  compatibility?: {
    previous_schema_version: "aiwg.fortemi.index.export.v1";
    strategy: "supported";
  };
  items: AiwgFortemiRecord[];
}

export interface BrowserIndexExportOptions {
  graph?: GraphType;
  repo?: string;
  privacy?: AiwgPrivacyClassification;
  generatedAt?: string;
  schemaVersion?: AiwgFortemiExportSchemaVersion;
  includeSourceBody?: boolean;
  maxSourceBodyBytes?: number;
}

export const DEFAULT_MAX_SOURCE_BODY_BYTES = 256 * 1024;

const BINARY_SOURCE_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dll",
  ".doc",
  ".docx",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".odt",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".so",
  ".tar",
  ".tgz",
  ".war",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

function stableArtifactId(artifactPath: string): string {
  return (
    "aiwg:artifact:" +
    createHash("sha256").update(artifactPath).digest("hex").slice(0, 16)
  );
}

export function stableRecordId(
  recordType: AiwgFortemiRecordType,
  artifactPath: string,
): string {
  if (recordType === "aiwg.artifact") return stableArtifactId(artifactPath);
  return (
    recordType.replaceAll(".", ":") +
    ":" +
    createHash("sha256").update(artifactPath).digest("hex").slice(0, 16)
  );
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function textForEntry(entry: MetadataEntry): string {
  return uniqueSorted([
    entry.title,
    entry.summary,
    entry.capability,
    entry.name,
    entry.kind,
    entry.sourceType,
    entry.path,
    ...entry.tags,
    ...(entry.triggers ?? []),
    ...(entry.searchTerms ?? []),
  ]).join("\n");
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf-8");
  if (sample.length === 0) return false;
  const replacementCount = (sample.match(/\uFFFD/g) ?? []).length;
  return replacementCount / sample.length > 0.01;
}

function sourceBodyForEntry(
  cwd: string,
  entry: MetadataEntry,
  maxBytes: number,
): string {
  const sourcePath = path.isAbsolute(entry.path)
    ? entry.path
    : path.join(cwd, entry.path);
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    if (BINARY_SOURCE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()))
      return "";
    const buffer = fs.readFileSync(sourcePath);
    if (looksBinary(buffer)) return "";
    return stripFrontmatter(buffer.toString("utf-8")).trim();
  } catch {
    return "";
  }
}

function sourceFrontmatterForEntry(
  cwd: string,
  entry: MetadataEntry,
  maxBytes: number,
): Record<string, unknown> {
  const sourcePath = path.isAbsolute(entry.path)
    ? entry.path
    : path.join(cwd, entry.path);
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > maxBytes) return {};
    if (BINARY_SOURCE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()))
      return {};
    const buffer = fs.readFileSync(sourcePath);
    if (looksBinary(buffer)) return {};
    const text = buffer.toString("utf-8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) return {};
    const parsed = loadYaml(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function skosConceptFromValue(
  value: unknown,
  fallbackScheme: string,
): AiwgFortemiSkosConcept | null {
  if (typeof value === "string") {
    const label = value.trim();
    if (!label) return null;
    return {
      id: `${fallbackScheme}:${slug(label)}`,
      prefLabel: label,
      scheme: fallbackScheme,
    };
  }
  const obj = asObject(value);
  const prefLabel =
    typeof obj.prefLabel === "string"
      ? obj.prefLabel.trim()
      : typeof obj.label === "string"
        ? obj.label.trim()
        : typeof obj.name === "string"
          ? obj.name.trim()
          : "";
  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim()
      : prefLabel
        ? `${fallbackScheme}:${slug(prefLabel)}`
        : "";
  if (!id || !prefLabel) return null;
  const concept: AiwgFortemiSkosConcept = {
    id,
    prefLabel,
    ...(typeof obj.definition === "string" ? { definition: obj.definition } : {}),
    ...(typeof obj.scheme === "string" ? { scheme: obj.scheme } : { scheme: fallbackScheme }),
    ...(typeof obj.notation === "string" ? { notation: obj.notation } : {}),
    ...(typeof obj.uri === "string" ? { uri: obj.uri } : {}),
    ...(Array.isArray(obj.altLabels) ? { altLabels: stringArray(obj.altLabels) } : {}),
  };
  const metadata = asObject(obj.metadata);
  if (Object.keys(metadata).length > 0) concept.metadata = metadata;
  return concept;
}

function skosRelationFromValue(
  value: unknown,
  sourcePath: string,
): AiwgFortemiSkosRelation | null {
  const obj = asObject(value);
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  const sourceId =
    typeof obj.source_id === "string"
      ? obj.source_id.trim()
      : typeof obj.source === "string"
        ? obj.source.trim()
        : "";
  const targetId =
    typeof obj.target_id === "string"
      ? obj.target_id.trim()
      : typeof obj.target === "string"
        ? obj.target.trim()
        : "";
  if (!type || !sourceId || !targetId) return null;
  const relation: AiwgFortemiSkosRelation = {
    type,
    source_id: sourceId,
    target_id: targetId,
    source_path: sourcePath,
  };
  const metadata = asObject(obj.metadata);
  if (Object.keys(metadata).length > 0) relation.metadata = metadata;
  return relation;
}

function skosForEntry(
  cwd: string,
  entry: MetadataEntry,
  maxBytes: number,
): {
  concepts: AiwgFortemiSkosConcept[];
  relations: AiwgFortemiSkosRelation[];
} {
  const frontmatter = sourceFrontmatterForEntry(cwd, entry, maxBytes);
  const skos = asObject(frontmatter.skos);
  const explicitConceptValues = [
    ...asArray(frontmatter.skos_concepts),
    ...asArray(skos.concepts),
  ];
  const explicitRelationValues = [
    ...asArray(frontmatter.skos_relations),
    ...asArray(skos.relations),
  ];
  const derivedConcepts: AiwgFortemiSkosConcept[] = [
    { value: entry.type, scheme: "aiwg-types", source: "aiwg-index-type" },
    { value: entry.phase, scheme: "aiwg-phases", source: "aiwg-index-phase" },
    ...(entry.kind
      ? [{ value: entry.kind, scheme: "aiwg-kinds", source: "aiwg-index-kind" }]
      : []),
    ...(entry.sourceType
      ? [{ value: entry.sourceType, scheme: "aiwg-source-types", source: "aiwg-index-source-type" }]
      : []),
    ...(entry.name
      ? [{ value: entry.name, scheme: "aiwg-names", source: "aiwg-index-name" }]
      : []),
    ...entry.tags.map((tag) => ({
      value: tag,
      scheme: "aiwg-tags",
      source: "aiwg-index-tags",
    })),
  ]
    .filter((item) => item.value.length > 0)
    .map((item) => ({
      id: `${item.scheme}:${slug(item.value)}`,
      prefLabel: item.value,
      scheme: item.scheme,
      metadata: {
        source: item.source,
        path: entry.path,
      },
    }));
  const conceptsById = new Map<string, AiwgFortemiSkosConcept>();
  for (const concept of [
    ...explicitConceptValues
      .map((value) => skosConceptFromValue(value, "aiwg-skos"))
      .filter((value): value is AiwgFortemiSkosConcept => value !== null),
    ...derivedConcepts,
  ]) {
    conceptsById.set(concept.id, concept);
  }
  const relations = explicitRelationValues
    .map((value) => skosRelationFromValue(value, entry.path))
    .filter((value): value is AiwgFortemiSkosRelation => value !== null)
    .sort((left, right) =>
      `${left.type}:${left.source_id}:${left.target_id}`.localeCompare(
        `${right.type}:${right.source_id}:${right.target_id}`,
      ),
    );
  return {
    concepts: [...conceptsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    relations,
  };
}

function textForRecord(
  entry: MetadataEntry,
  schemaVersion: AiwgFortemiExportSchemaVersion,
  sourceBody: string,
): string {
  const metadataText = textForEntry(entry);
  if (schemaVersion !== "v2" || !sourceBody) return metadataText;
  return [metadataText, sourceBody].join("\n\n");
}

function relationshipsForEntry(
  entry: MetadataEntry,
  graph: DependencyGraph | null,
  recordTypesByPath: Map<string, AiwgFortemiRecordType>,
  schemaVersion: AiwgFortemiExportSchemaVersion,
): AiwgFortemiRelationship[] {
  const edges = graph?.[entry.path];
  if (!edges) return [];

  const relationships: AiwgFortemiRelationship[] = [];
  const append = (prefix: "upstream" | "downstream", edge: TypedEdge) => {
    if (schemaVersion === "v1" && prefix === "downstream") return;

    const targetRecordType =
      recordTypesByPath.get(edge.path) ?? "aiwg.artifact";
    const relationship: AiwgFortemiRelationship = {
      type: edge.type,
      target_id: stableRecordId(targetRecordType, edge.path),
      source_path: edge.path,
    };
    if (schemaVersion === "v2") {
      relationship.target_path = edge.path;
      relationship.direction = prefix;
      relationship.metadata = Object.fromEntries(
        Object.entries(edge).filter(([key]) => key !== "path" && key !== "type"),
      );
    }
    relationships.push(relationship);
  };

  for (const edge of edges.upstream) append("upstream", edge);
  for (const edge of edges.downstream) append("downstream", edge);
  return relationships.sort((left, right) => {
    const typeCmp = left.type.localeCompare(right.type);
    if (typeCmp !== 0) return typeCmp;
    return left.target_id.localeCompare(right.target_id);
  });
}

export function recordTypeForEntry(
  entry: MetadataEntry,
  schemaVersion: AiwgFortemiExportSchemaVersion,
): AiwgFortemiRecordType {
  if (schemaVersion === "v1") return "aiwg.artifact";

  const normalized = entry.type.toLowerCase().replace(/_/g, "-");
  const pathText = entry.path.toLowerCase();
  switch (normalized) {
    case "skill":
      return "aiwg.skill";
    case "agent":
      return "aiwg.agent";
    case "command":
      return "aiwg.command";
    case "rule":
      return "aiwg.rule";
    case "schema":
      return "aiwg.schema";
    case "behavior":
      return "aiwg.behavior";
    case "flow":
    case "workflow":
      return "aiwg.flow";
    case "provider":
      return "aiwg.provider";
    case "bundle":
    case "extension":
    case "addon":
    case "framework":
    case "plugin":
      return "aiwg.bundle";
    case "research-ref":
    case "ref":
      return "aiwg.research.ref";
    case "research-profile":
    case "profile":
      return "aiwg.research.profile";
    case "research-view":
    case "corpus-view":
      return "aiwg.research.view";
    case "research-synthesis":
    case "synthesis":
      return "aiwg.research.synthesis";
    case "kb-page":
    case "kb":
      return "aiwg.kb.page";
    case "memory-entry":
    case "memory":
      return "aiwg.memory.entry";
    case "issue":
      return "aiwg.issue";
    case "source.file":
      return "aiwg.source.file";
    case "source.module":
      return "aiwg.source.module";
    case "source.package":
      return "aiwg.source.package";
    case "source.builtin":
      return "aiwg.source.builtin";
    case "source.asset":
      return "aiwg.source.asset";
    case "source.unresolved":
      return "aiwg.source.unresolved";
    case "source.entrypoint":
      return "aiwg.source.entrypoint";
    default:
      if (
        pathText.includes("/research/references/") ||
        /^ref[-_]/i.test(entry.name ?? entry.title)
      )
        return "aiwg.research.ref";
      if (
        pathText.includes("/research/profiles/") ||
        /^prof[-_]/i.test(entry.name ?? entry.title)
      )
        return "aiwg.research.profile";
      if (pathText.includes("/research/synthesis/"))
        return "aiwg.research.synthesis";
      if (pathText.includes("/kb/")) return "aiwg.kb.page";
      if (pathText.includes("/memory/")) return "aiwg.memory.entry";
      if (pathText.includes("/issues/")) return "aiwg.issue";
      return "aiwg.artifact";
  }
}

function generatedForPath(artifactPath: string): boolean {
  return (
    artifactPath.includes("/generated/") ||
    artifactPath.includes("/views/") ||
    artifactPath.endsWith(".generated.md")
  );
}

function localityForPath(
  artifactPath: string,
): "project" | "framework" | "external" {
  if (artifactPath.startsWith("/")) return "external";
  if (
    artifactPath.startsWith("agentic/") ||
    artifactPath.includes("/.agents/") ||
    artifactPath.includes("/.opencode/")
  )
    return "framework";
  return "project";
}

function recordForEntry(
  cwd: string,
  entry: MetadataEntry,
  graphName: string,
  dependencyGraph: DependencyGraph | null,
  privacy: AiwgPrivacyClassification,
  schemaVersion: AiwgFortemiExportSchemaVersion,
  recordTypesByPath: Map<string, AiwgFortemiRecordType>,
  sourceBody: string,
  maxSourceBodyBytes: number,
): AiwgFortemiRecord {
  const recordType = recordTypeForEntry(entry, schemaVersion);
  const text = textForRecord(entry, schemaVersion, sourceBody);
  const skos = schemaVersion === "v2" ? skosForEntry(cwd, entry, maxSourceBodyBytes) : null;
  const recordSchemaVersion: AiwgFortemiRecordSchemaVersion =
    schemaVersion === "v2"
      ? "aiwg.fortemi.index.record.v2"
      : "aiwg.fortemi.index.record.v1";
  return {
    schema_version: recordSchemaVersion,
    id: stableRecordId(recordType, entry.path),
    type: recordType,
    source: {
      path: entry.path,
      repo_relative_path: entry.path,
      locator: entry.name ?? entry.title ?? entry.path,
      ...(schemaVersion === "v2"
        ? {
            origin: graphName,
            generated: generatedForPath(entry.path),
            checksum: entry.checksum,
            updated_at: entry.updated,
          }
        : {}),
    },
    title: entry.title || entry.path,
    ...(schemaVersion === "v2"
      ? {
          name: entry.name,
          summary: entry.summary,
          search: {
            title: entry.title || entry.path,
            name: entry.name,
            summary: entry.summary,
            body: text,
            triggers: uniqueSorted(entry.triggers ?? []),
            aliases: uniqueSorted([entry.name, entry.title]),
            capability: entry.capability,
            tags: uniqueSorted(entry.tags),
            phase: entry.phase,
            type: entry.type,
            frontmatter: {
              ...(entry.kernel === undefined ? {} : { kernel: entry.kernel }),
              ...(entry.kind ? { aiwg_kind: entry.kind } : {}),
              ...(entry.sourceType ? { aiwg_source_type: entry.sourceType } : {}),
              ...(entry.searchTerms?.length
                ? { aiwg_search_terms: uniqueSorted(entry.searchTerms) }
                : {}),
              ...(entry.script ? { aiwg_script: entry.script } : {}),
              ...(entry.activation ? { activation: entry.activation } : {}),
              ...(entry.bound_to ? { bound_to: entry.bound_to } : {}),
              ...(entry.ruleSummary !== undefined ? { summary: entry.ruleSummary } : {}),
            },
          },
        }
      : {}),
    text,
    facets: {
      artifact_type: uniqueSorted([entry.type]),
      record_type: uniqueSorted([recordType]),
      phase: uniqueSorted([entry.phase]),
      graph: uniqueSorted([graphName]),
      privacy: uniqueSorted([privacy]),
      ...(entry.kind ? { process_kind: uniqueSorted([entry.kind]) } : {}),
      ...(entry.sourceType ? { source_type: uniqueSorted([entry.sourceType]) } : {}),
    },
    tags: uniqueSorted(entry.tags),
    concepts: uniqueSorted([
      entry.type,
      entry.phase,
      entry.name,
      entry.kind,
      entry.sourceType,
      ...(entry.triggers ?? []),
      ...(skos?.concepts.map((concept) => concept.id) ?? []),
    ]),
    relationships: relationshipsForEntry(
      entry,
      dependencyGraph,
      recordTypesByPath,
      schemaVersion,
    ),
    provenance: [
      {
        field: "record",
        source: "aiwg-index",
        path: entry.path,
        confidence: "source",
        privacy,
      },
    ],
    privacy: {
      classification: privacy,
      pii: privacy === "private",
      ...(schemaVersion === "v2"
        ? { locality: localityForPath(entry.path) }
        : {}),
    },
    ...(schemaVersion === "v2"
      ? {
          chunks: [
            {
              id: stableRecordId(recordType, entry.path) + ":chunk:body",
              text,
              checksum: createHash("sha256").update(text).digest("hex"),
            },
          ],
          embeddings: [] as Array<{
            model: string;
            chunk_id?: string;
            vector_ref?: string;
            input_hash: string;
          }>,
          skos_concepts: skos?.concepts ?? [],
          skos_relations: skos?.relations ?? [],
          ...(entry.operationalState
            ? { operational_state: entry.operationalState }
            : {}),
          ...(entry.stateTransfer
            ? {
                state_transfer: {
                  deleted_at: entry.stateTransfer.deletedAt,
                },
              }
            : {}),
        }
      : {}),
    updated_at: entry.updated,
  };
}

export function buildAiwgFortemiIndexExport(
  cwd: string,
  options: BrowserIndexExportOptions = {},
): AiwgFortemiIndexExport {
  const graphName = options.graph ?? "project";
  const schemaVersion = options.schemaVersion ?? "v1";
  const index = loadGraphIndexFile<ArtifactIndex>(
    cwd,
    "metadata.json",
    options.graph,
  );
  if (!index) {
    const graphFlag = options.graph ? " --graph " + options.graph : "";
    throw new Error(
      "No metadata index found for graph '" +
        graphName +
        "'. Run 'aiwg index build" +
        graphFlag +
        "' first.",
    );
  }

  const dependencyGraph = loadGraphIndexFile<DependencyGraph>(
    cwd,
    "dependencies.json",
    options.graph,
  );
  const privacy = options.privacy ?? "private";
  const repo = options.repo ?? path.basename(cwd);
  const maxSourceBodyBytes =
    options.maxSourceBodyBytes ?? DEFAULT_MAX_SOURCE_BODY_BYTES;
  const entries = Object.values(index.entries);
  const recordTypesByPath = new Map(
    entries.map((entry) => [
      entry.path,
      recordTypeForEntry(entry, schemaVersion),
    ]),
  );
  const items = entries
    .map((entry) =>
      recordForEntry(
        cwd,
        entry,
        graphName,
        dependencyGraph,
        privacy,
        schemaVersion,
        recordTypesByPath,
        options.includeSourceBody === false
          ? ""
          : sourceBodyForEntry(cwd, entry, maxSourceBodyBytes),
        maxSourceBodyBytes,
      ),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schema_version:
      schemaVersion === "v2"
        ? "aiwg.fortemi.index.export.v2"
        : "aiwg.fortemi.index.export.v1",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source:
      schemaVersion === "v2"
        ? { repo, privacy, graph: graphName }
        : { repo, privacy },
    ...(schemaVersion === "v2"
      ? {
          compatibility: {
            previous_schema_version: "aiwg.fortemi.index.export.v1",
            strategy: "supported",
          } as const,
        }
      : {}),
    items,
  };
}

function v1CompatibleText(record: AiwgFortemiRecord): string {
  return record.search?.body ?? record.text;
}

function v1CompatibleRelationships(
  record: AiwgFortemiRecord,
): AiwgFortemiRelationship[] {
  return record.relationships
    .filter((relationship) => relationship.direction !== "downstream")
    .map((relationship) => ({
      type: relationship.type,
      target_id: relationship.target_id,
      source_path: relationship.target_path ?? relationship.source_path,
    }))
    .sort((left, right) => {
      const typeCmp = left.type.localeCompare(right.type);
      if (typeCmp !== 0) return typeCmp;
      return left.target_id.localeCompare(right.target_id);
    });
}

export function buildAiwgFortemiV1CompatibilityExport(
  exportData: AiwgFortemiIndexExport,
): AiwgFortemiIndexExport {
  return {
    schema_version: "aiwg.fortemi.index.export.v1",
    generated_at: exportData.generated_at,
    source: {
      repo: exportData.source.repo,
      privacy: exportData.source.privacy,
    },
    items: exportData.items
      .map((record) => ({
        schema_version: "aiwg.fortemi.index.record.v1" as const,
        id: record.id,
        type: record.type,
        source: {
          path: record.source.path,
          repo_relative_path: record.source.repo_relative_path,
          locator: record.source.locator,
        },
        title: record.title,
        text: v1CompatibleText(record),
        facets: record.facets,
        tags: record.tags,
        concepts: record.concepts,
        relationships: v1CompatibleRelationships(record),
        provenance: record.provenance,
        privacy: {
          classification: record.privacy.classification,
          pii: record.privacy.pii,
        },
        updated_at: record.updated_at,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function writeAiwgFortemiIndexExport(
  exportData: AiwgFortemiIndexExport,
  outPath?: string,
): void {
  const json = JSON.stringify(exportData, null, 2) + "\n";
  if (!outPath || outPath === "-") {
    process.stdout.write(json);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, json, "utf-8");
}
