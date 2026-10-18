/**
 * Artifact Index Builder
 *
 * Scans .aiwg/ directories, extracts metadata from artifact frontmatter,
 * computes checksums, extracts @-mention and Markdown-link dependencies, and builds a
 * structured index at .aiwg/.index/.
 *
 * @implements #415
 * @source @src/artifacts/types.ts
 * @tests @test/unit/artifacts/index-builder.test.ts
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { load as loadYaml } from 'js-yaml';
import { validateDecisionDocument } from '../decision/validate.js';
import { parseDecisionJson, parseDecisionYaml } from '../decision/entry.js';
import { validateGateDocument } from '../gates/schema.js';
import type { MetadataEntry, ArtifactIndex, IndexStats, TagIndex, DependencyGraph, GraphType, TypedEdge, MetadataSupplementConfig } from './types.js';
import {
  INDEX_EXTRACTOR_VERSION,
  INDEX_VERSION,
  INDEX_DIR,
  OPERATIONAL_DISCOVERY_TYPES,
  PHASE_DIRECTORIES,
  GRAPH_CONFIGS,
  TEMPLATE_INDEX_EXTENSIONS,
  resolveGraphScanDir,
  loadUserGraphConfigs,
  loadGlobalGraphConfigs,
  resolveGraphBackendType,
} from './types.js';
import { parseCitationSidecar, citationResultToEdges, buildRefToPathMap } from './citation-parser.js';
import { writeIndexFile, resolveIndexDir, loadGraphIndexFile } from './index-reader.js';
import { loadManifest, writeManifest, statMatches, makeEntry, type ChecksumManifest, type ManifestStats } from './checksum-manifest.js';
import { normalizeOperationalState } from './operational-state.js';
import {
  DEFAULT_PROJECT_AIWG_DIR,
  resolveProjectAiwgDir,
} from '../config/project-artifacts.js';
import { normalizeStateTransferProjection } from './state-transfer.js';
import { collectGraphIndexFiles, findArtifactFiles, indexPathFor } from './index-files.js';

export interface BuildOptions {
  force?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  scope?: string;
  includeIgnored?: boolean; // Include gitignored sources; runtime directories remain excluded
  outputDir?: string; // Override index output directory (default: <cwd>/.aiwg/.index/)
  graph?: GraphType;  // Target a specific graph (default: project for backward compat)
  explicit?: boolean; // true when graph was requested via --graph flag; false for auto-selected defaultBuild graphs
}

function absoluteEntryPath(cwd: string, entryPath: string, graph?: GraphType): string {
  if ((!graph || graph === 'project') && entryPath.startsWith(`${DEFAULT_PROJECT_AIWG_DIR}/`)) {
    return path.join(resolveProjectAiwgDir(cwd), entryPath.slice(DEFAULT_PROJECT_AIWG_DIR.length + 1));
  }
  return path.isAbsolute(entryPath) ? entryPath : path.join(cwd, entryPath);
}

function loadIndexFromDir<T>(indexDir: string, filename: string): T | null {
  const filePath = path.join(indexDir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  try {
    const data = (loadYaml(match[1]) ?? {}) as Record<string, unknown>;
    return { data, body: match[2] };
  } catch {
    return { data: {}, body: content };
  }
}

/** Read the target rule schema tolerantly while older rules remain untagged. */
export function extractRuleBindings(data: Record<string, unknown>): Pick<MetadataEntry, 'activation' | 'bound_to' | 'ruleSummary'> {
  const bound_to: NonNullable<MetadataEntry['bound_to']> = {};
  const raw = data.bound_to;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['skills', 'agents', 'flows'] as const) {
      const targets = (raw as Record<string, unknown>)[key];
      if (Array.isArray(targets)) {
        const names = [...new Set(targets.filter((name): name is string => typeof name === 'string' && name.trim().length > 0))];
        if (names.length) bound_to[key] = names;
      }
    }
  }
  return {
    ...(typeof data.activation === 'string' ? { activation: data.activation } : {}),
    ...(typeof data.summary === 'string' ? { ruleSummary: data.summary } : {}),
    ...(Object.keys(bound_to).length ? { bound_to } : {}),
  };
}

/**
 * Extract @-mention references from content
 */
export function extractMentions(content: string): string[] {
  const mentions = new Set<string>();
  // Match @path/to/file.ext, @.aiwg/path, and framework references rooted at
  // @$AIWG_ROOT/. The latter must normalize to repo-relative paths so framework
  // skill references resolve to their rule files in the graph index.
  const pattern = /@(?:\$AIWG_ROOT\/)?(\.?aiwg\/[\w./-]+|[a-zA-Z][\w./-]+\.\w+)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    mentions.add(match[1]);
  }
  return Array.from(mentions);
}

/**
 * Extract relative Markdown links that may resolve to graph-local artifacts.
 *
 * External URLs, absolute paths, and anchor-only links are intentionally absent
 * from the accepted pattern. Resolution still happens later against indexed
 * nodes, so a parsed link outside the active graph cannot create an edge.
 */
export function extractMarkdownLinks(content: string): string[] {
  const links = new Set<string>();
  const pattern = /(!?)\[[^\]]+\]\((\.\/?[^)#\s]+)(?:#[^)]+)?\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1] === '!') continue;
    links.add(match[2]);
  }
  return Array.from(links);
}

function resolveMarkdownLinkDependency(
  cwd: string,
  sourcePath: string,
  rawLink: string,
  entries: Record<string, MetadataEntry>,
  graph?: GraphType,
): string | null {
  const target = rawLink.split('#')[0]?.trim();
  if (!target) return null;
  const sourceFullPath = absoluteEntryPath(cwd, sourcePath, graph);
  const targetFullPath = path.resolve(path.dirname(sourceFullPath), target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetFullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const indexedPath = indexPathFor(cwd, targetFullPath, graph);
  return entries[indexedPath] ? indexedPath : null;
}

function addDependencyEdge(
  depGraph: DependencyGraph,
  entries: Record<string, MetadataEntry>,
  sourcePath: string,
  targetPath: string,
  type: TypedEdge['type'],
): boolean {
  if (sourcePath === targetPath) return false;
  if (!depGraph[sourcePath]) depGraph[sourcePath] = { upstream: [], downstream: [] };
  if (!depGraph[targetPath]) depGraph[targetPath] = { upstream: [], downstream: [] };
  if (depGraph[sourcePath].upstream.some(edge => edge.path === targetPath)) return false;

  depGraph[sourcePath].upstream.push({ path: targetPath, type });
  depGraph[targetPath].downstream.push({ path: sourcePath, type });
  if (entries[targetPath]) entries[targetPath].dependents.push(sourcePath);
  return true;
}

/**
 * Extract title from content (first # heading or frontmatter title)
 */
function extractTitle(data: Record<string, unknown>, body: string): string {
  if (typeof data.title === 'string') return data.title;
  const headingMatch = body.match(/^#\s+(.+)$/m);
  return headingMatch ? headingMatch[1].trim() : 'Untitled';
}

/**
 * Extract canonical short name (#1233) used for exact-name search match.
 *
 * Priority:
 *   1. frontmatter `name:` field if present
 *   2. parent directory basename for skills/agents/commands/rules layouts
 *      (skills conventionally live in `<...>/skills/<name>/SKILL.md`)
 *   3. filename without extension as final fallback
 *
 * The result is the literal slug a user would type to find the artifact —
 * `aiwg-doctor`, `intake-wizard`, `flow-deploy-to-production` — preserving
 * hyphens so the scorer can match queries that contain them.
 */
function extractCanonicalName(data: Record<string, unknown>, relativePath: string): string {
  if (typeof data.name === 'string' && data.name.trim().length > 0) {
    return data.name.trim();
  }
  const filename = path.basename(relativePath);
  // For slug layouts: <type>s/<name>/<TYPE>.md
  const isCanonicalLayout = /^(SKILL|AGENT|COMMAND|RULE|BEHAVIOR)\.md$/i.test(filename);
  if (isCanonicalLayout) {
    return path.basename(path.dirname(relativePath));
  }
  return path.basename(filename, path.extname(filename));
}

/**
 * Extract summary from content (first 500 chars of description or body)
 */
function extractSummary(data: Record<string, unknown>, body: string): string {
  if (typeof data.description === 'string') return data.description.slice(0, 500);
  // Skip headings, get first paragraph
  const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  return lines.slice(0, 5).join(' ').slice(0, 500).trim();
}

interface SchemaDocMetadata {
  title?: string;
  name?: string;
  capability?: string;
  searchTerms: string[];
}

interface DecisionDocMetadata {
  type: 'decision-definition' | 'decision-ruleset' | 'decision-binding';
  kind: 'DecisionDefinition' | 'DecisionRuleset' | 'DecisionBinding';
  name: string;
  description: string;
  capability: string;
  tags: string[];
  searchTerms: string[];
}

interface GatePackDocMetadata {
  type: 'gate-pack';
  kind: 'GatePack';
  name: string;
  description: string;
  capability: string;
  tags: string[];
  searchTerms: string[];
}

/** Classify and schema-check authored decision-system documents. */
export function parseDecisionDoc(content: string, relativePath: string): DecisionDocMetadata | null {
  if (!/\.(json|ya?ml)$/i.test(relativePath)) return null;
  if (Buffer.byteLength(content, 'utf8') > 262_144) return null;
  let document: unknown;
  try {
    document = /\.json$/i.test(relativePath) ? parseDecisionJson(content) : parseDecisionYaml(content);
    validateDecisionDocument(document);
  } catch {
    return null;
  }
  const value = document as {
    kind: DecisionDocMetadata['kind'];
    metadata: { id: string; version: string; description: string };
    spec: Record<string, unknown>;
  };
  if (!['DecisionDefinition', 'DecisionRuleset', 'DecisionBinding'].includes(value.kind)) return null;
  const type = ({
    DecisionDefinition: 'decision-definition',
    DecisionRuleset: 'decision-ruleset',
    DecisionBinding: 'decision-binding',
  } as const)[value.kind];
  const purpose = typeof value.spec.purpose === 'string' ? value.spec.purpose : value.metadata.description;
  const terms = new Set<string>([
    value.kind, value.metadata.id, value.metadata.version, purpose,
    ...Object.keys(value.spec),
  ]);
  return {
    type, kind: value.kind, name: value.metadata.id, description: value.metadata.description,
    capability: purpose.slice(0, 240), tags: ['decision-system', value.kind], searchTerms: [...terms],
  };
}

/**
 * Classify and schema-check authored gate-pack documents (#2830).
 *
 * Packs live in `<bundle>/gate-packs/*.gatepack.yaml|json` (never `gates/`,
 * which agent-persistence HITL uses). The `.gatepack.` extension is the
 * boundary: HITL `gates/*.yaml` files must never classify as `gate-pack`.
 * Invalid packs return null so they are never discoverable; the bundle
 * loader rejects them at load with a diagnostic.
 */
export function parseGatePackDoc(content: string, relativePath: string): GatePackDocMetadata | null {
  if (!/\.gatepack\.(json|ya?ml)$/i.test(relativePath)) return null;
  if (Buffer.byteLength(content, 'utf8') > 262_144) return null;
  let document: unknown;
  try {
    document = /\.json$/i.test(relativePath) ? parseDecisionJson(content) : parseDecisionYaml(content);
    validateGateDocument(document);
  } catch {
    return null;
  }
  const value = document as {
    kind: string;
    metadata: { id: string; version: string; description: string };
    spec: { gates?: Array<{ id?: string }>; metrics?: Record<string, unknown> };
  };
  if (value.kind !== 'GatePack') return null;
  const description = value.metadata.description;
  const terms = new Set<string>([
    value.kind, value.metadata.id, value.metadata.version, description,
    ...(value.spec.gates ?? []).map(gate => String(gate.id ?? '')).filter(Boolean),
    ...Object.keys(value.spec.metrics ?? {}),
  ]);
  return {
    type: 'gate-pack', kind: 'GatePack', name: value.metadata.id, description,
    capability: description.slice(0, 240), tags: ['gates', value.kind], searchTerms: [...terms],
  };
}

function parseSchemaDoc(content: string, relativePath: string): SchemaDocMetadata | null {
  if (!/\.(json|ya?ml)$/i.test(relativePath)) return null;
  let parsed: unknown;
  try {
    parsed = /\.json$/i.test(relativePath) ? JSON.parse(content) : loadYaml(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const schema = parsed as Record<string, unknown>;
  const title = typeof schema.title === 'string' && schema.title.trim()
    ? schema.title.trim()
    : undefined;
  const id = typeof schema.$id === 'string' && schema.$id.trim()
    ? schema.$id.trim()
    : undefined;
  const description = typeof schema.description === 'string' && schema.description.trim()
    ? schema.description.trim().slice(0, 240)
    : undefined;
  const filename = path.basename(relativePath, path.extname(relativePath)).replace(/\.schema$/i, '');
  return {
    title: title ?? filename,
    name: filename,
    capability: description ?? (id ? `Schema definition for ${title ?? filename}` : undefined),
    searchTerms: [id, title, filename, 'schema'].filter((term): term is string => Boolean(term)),
  };
}

/**
 * Determine SDLC phase from file path
 */
function inferPhase(filePath: string): string {
  for (const [phase, dir] of Object.entries(PHASE_DIRECTORIES)) {
    if (filePath.startsWith(dir)) return phase;
  }
  return 'other';
}

/**
 * Determine artifact type from frontmatter or filename.
 *
 * Path-based detection for AIWG artifact kinds (#1214) takes precedence
 * over the legacy basename heuristics so `agentic/code/.../skills/foo/SKILL.md`
 * always lands as `type: 'skill'` regardless of frontmatter.
 */
function inferType(data: Record<string, unknown>, filePath: string): string {
  // Normalize separators so matchers are cross-platform.
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(filePath, path.extname(filePath)).toLowerCase();

  // Nearest-type-dir-ancestor classification (#1221 audit).
  //
  // The AIWG corpus uses many different nesting depths for artifacts:
  //   frameworks/<f>/skills/<slug>/SKILL.md
  //   frameworks/<f>/extensions/<sub>/skills/<slug>/SKILL.md
  //   frameworks/<f>/templates/hermes/skills/<slug>/SKILL.md
  //   frameworks/<f>/elaboration/agents/<n>.md          (research-complete)
  //   addons/<a>/agents/<n>.md
  //   addons/<a>/prompts/agents/<n>.md                  (aiwg-utils)
  //   addons/<a>/skills/skills/SKILL.md                 (aiwg-utils self-skill)
  //   addons/<a>/templates/<n>.md
  //   addons/<a>/behaviors/<n>.md
  //   addons/<a>/hooks/<n>.md
  //   extensions/<e>/skills/<n>.md                      (flat — no slug dir)
  //   extensions/<e>/rules/<n>.md
  //   agentic/code/behaviors/<sub>/...                  (top-level behaviors)
  //
  // Walk the path segments from the file upward; the first segment matching
  // a known artifact-type directory determines the kind. This handles every
  // nested layout uniformly.
  const segments = normalized.split('/');
  const skipBasenames = new Set(['readme', 'rules-index', 'index']);
  const isMarkdown = /\.md$/i.test(filePath);
  const isTemplateAsset = TEMPLATE_INDEX_EXTENSIONS.some(ext => normalized.endsWith(ext));
  const isSchemaAsset = /\.(json|ya?ml|md)$/i.test(filePath);
  if (!skipBasenames.has(basename) && (isMarkdown || isTemplateAsset || isSchemaAsset)) {
    // Look at directory segments only (exclude the file itself).
    for (let i = segments.length - 2; i >= 0; i--) {
      const seg = segments[i];
      switch (seg) {
        case 'skills': {
          // Skills come in two layouts:
          //   slug-style: skills/<slug>/SKILL.md  → file is SKILL.md
          //   flat-style: skills/<name>.md        → file is directly under skills/
          //
          // Do not classify nested reference/support markdown under
          // skills/<slug>/... as standalone skills; those files should remain
          // ordinary artifacts so discovery does not advertise them as
          // invokable capabilities.
          const afterSkills = segments.length - i - 1;
          const isSlugSkill = basename === 'skill' && afterSkills === 2;
          const isFlatSkill = afterSkills === 1;
          if (isSlugSkill || isFlatSkill) return 'skill';
          break;
        }
        case 'agents':
          if (isMarkdown) return 'agent';
          break;
        case 'commands':
          if (isMarkdown) return 'command';
          break;
        case 'rules':
          // Rules/RULES-INDEX.md is a curated index file, not a rule.
          if (basename === 'rules-index' || basename === 'index') break;
          if (isMarkdown) return 'rule';
          break;
        case 'schemas':
          if (isSchemaAsset) return 'schema';
          break;
        case 'templates':
          return 'template';
        case 'behaviors':
          if (isMarkdown) return 'behavior';
          break;
        case 'hooks':
          if (isMarkdown) return 'hook';
          break;
      }
    }
  }

  if (typeof data.type === 'string') return data.type;

  // Legacy SDLC artifact heuristics (existing behavior preserved).
  if (basename.startsWith('uc-') || basename.includes('use-case')) return 'use-case';
  if (basename.startsWith('adr-') || basename.includes('adr')) return 'adr';
  if (basename.startsWith('tp-') || basename.includes('test-plan')) return 'test-plan';
  if (basename.startsWith('tc-') || basename.includes('test-case')) return 'test-case';
  if (basename.startsWith('tm-') || basename.includes('threat')) return 'threat-model';
  if (basename.startsWith('nfr-') || basename.includes('nfr')) return 'nfr';
  if (basename.includes('sad') || basename.includes('architecture')) return 'architecture';
  if (basename.includes('risk')) return 'risk';
  if (basename.includes('deploy')) return 'deployment';
  return 'document';
}

interface RunbookDocMetadata {
  kind: 'Runbook';
  capability?: string;
  searchTerms: string[];
}

interface MarkdownSection {
  heading: string;
  body: string;
}

const RUNBOOK_ACTION_HEADING = /\b(procedure|steps?|recovery steps?|installation|setup|start|stop|containment|remediation|response actions?|execution)\b/i;
const RUNBOOK_CONTROL_HEADING = /\b(prerequisites?|verification|validation|rollback|health check|troubleshooting|monitoring|escalation|post-recovery|evidence|postmortem|diagnosis)\b/i;

function markdownSections(body: string): MarkdownSection[] {
  const matches = [...body.matchAll(/^#{2,4}\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    heading: match[1].replace(/\s+#+\s*$/, '').trim(),
    body: body.slice(
      (match.index ?? 0) + match[0].length,
      matches[index + 1]?.index ?? body.length,
    ).trim(),
  }));
}

function compactSectionText(text: string, maxLength = 240): string | undefined {
  const blocks = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n\s*\n/)
    .map(block => block
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
  const first = blocks.find(block => !block.startsWith('#'));
  return first ? first.slice(0, maxLength) : undefined;
}

/**
 * Detect procedural Markdown runbooks without promoting every runbook-shaped
 * template. Explicit `type: runbook` is authoritative; otherwise a runbook
 * marker must be accompanied by both an action section and a control/validation
 * section. The extracted terms favor the operational sections people search
 * for (procedure, verification, rollback, diagnosis, remediation, and so on).
 */
export function parseRunbookDoc(
  data: Record<string, unknown>,
  body: string,
  filePath: string,
): RunbookDocMetadata | null {
  if (!/\.md$/i.test(filePath)) return null;
  const title = extractTitle(data, body);
  const explicit = typeof data.type === 'string' && data.type.toLowerCase() === 'runbook';
  const hasMarker = /\brun[- ]?book\b/i.test(`${filePath} ${title}`);
  const sections = markdownSections(body);
  const headings = sections.map(section => section.heading);
  const hasAction = headings.some(heading => RUNBOOK_ACTION_HEADING.test(heading));
  const hasControl = headings.some(heading => RUNBOOK_CONTROL_HEADING.test(heading));
  if (!explicit && !(hasMarker && hasAction && hasControl)) return null;

  const preferredCapability = sections.find(section =>
    /\b(purpose|overview|objective|intent|scope)\b/i.test(section.heading),
  );
  const lifecycleHeadings = sections
    .map(section => section.heading)
    .filter(heading => RUNBOOK_ACTION_HEADING.test(heading) || RUNBOOK_CONTROL_HEADING.test(heading));
  const lifecycleCapability = lifecycleHeadings.length > 0
    ? `${title}: ${lifecycleHeadings.slice(0, 8).join('; ')}`.slice(0, 240)
    : undefined;
  const capability =
    (typeof data.description === 'string' ? data.description.trim().slice(0, 240) : undefined)
    ?? (preferredCapability ? compactSectionText(preferredCapability.body) : undefined)
    ?? lifecycleCapability
    ?? extractCapability(data, body);

  const terms = new Set<string>(['runbook']);
  const relevantHeading = new RegExp(
    `${RUNBOOK_ACTION_HEADING.source}|${RUNBOOK_CONTROL_HEADING.source}|\\b(purpose|overview|objective|intent|scope|incident classification|communication|monitoring|symptoms?)\\b`,
    'i',
  );
  for (const section of sections) {
    if (!relevantHeading.test(section.heading)) continue;
    terms.add(section.heading);
    const compact = compactSectionText(section.body, 320);
    if (compact) terms.add(compact);
    if (terms.size >= 40) break;
  }

  return {
    kind: 'Runbook',
    capability,
    searchTerms: [...terms],
  };
}

/**
 * Extract trigger phrases from a SKILL.md / agent body.
 *
 * Skills declare alternate activation phrases in `triggers`, `aliases`,
 * `deprecated_names`, or under a `## Triggers` heading. This function pulls
 * those names plus each bullet's leading phrase (the part before any `→`
 * arrow or em-dash explanation), lowercased and trimmed.
 *
 * Returns an empty array when no `## Triggers` section is found —
 * non-skill artifacts get `triggers: undefined` after this is wired.
 *
 * @implements #1214
 */
export function extractTriggers(body: string, frontmatter?: Record<string, unknown>): string[] {
  const phrases: string[] = [];

  for (const field of ['triggers', 'aliases', 'deprecated_names']) {
    const declaredValues = Array.isArray(frontmatter?.[field])
      ? frontmatter[field]
      : [];
    for (const value of declaredValues) {
      if (typeof value !== 'string') continue;
      const phrase = value.trim().toLowerCase();
      if (phrase.length === 0) continue;
      if (phrase.length > 200) continue;
      phrases.push(phrase);
    }
  }

  // Find a triggers heading (case-insensitive). Accepted variants:
  //   ## Triggers
  //   ## Natural Language Triggers   (used by orchestration skills)
  //   ## Activation Phrases          (alternate vocabulary)
  //   ## When to invoke              (intent-style)
  // Capture the section content until the next `## ` heading or EOF.
  // Note: avoid the multi-line `m` flag with `$` — `$` would match
  // every line terminator and stop capture at the first blank line.
  const sectionMatch = body.match(
    /(?:^|\n)##\s+(?:(?:Natural\s+Language\s+)?Triggers|Activation\s+Phrases|When\s+to\s+invoke)\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  if (!sectionMatch) return [...new Set(phrases)];

  const section = sectionMatch[1];

  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('+')) continue;
    // Strip the bullet marker, optional surrounding quotes, and split on
    // common explanation separators ("→", " — ", " - " when followed by
    // explanatory text).
    let phrase = line.replace(/^[-*+]\s+/, '').trim();
    // Drop any leading quote characters
    phrase = phrase.replace(/^["“”'`]+/, '').trim();
    // Cut at the first explanation separator
    const sepMatch = phrase.match(/^(.*?)\s*(?:→|—|--|\s-\s)/);
    if (sepMatch) phrase = sepMatch[1];
    // Strip trailing quotes / colons
    phrase = phrase.replace(/["“”'`:.]+\s*$/, '').trim();
    if (phrase.length === 0) continue;
    if (phrase.length > 200) continue; // Reject pathological lines
    phrases.push(phrase.toLowerCase());
  }

  return [...new Set(phrases)];
}

/**
 * Extract a capability summary for a skill/agent/command/rule.
 *
 * Prefers the frontmatter `description` field (used uniformly across
 * AIWG SKILL.md / agent files). Falls back to the first non-heading
 * paragraph of the body. Capped at 240 chars so the index stays
 * token-tight when surfaced via `aiwg index discover`.
 *
 * @implements #1214
 */
export function extractCapability(data: Record<string, unknown>, body: string): string | undefined {
  if (typeof data.description === 'string' && data.description.trim().length > 0) {
    return data.description.trim().slice(0, 240);
  }
  // Fallback: first non-empty paragraph that isn't a heading.
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const block of stripped.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed.replace(/\s+/g, ' ').slice(0, 240);
  }
  return undefined;
}

/**
 * Extract a SkillScriptSpec from skill frontmatter (#1227).
 *
 * The `script:` block is optional — only skills with a backing executable
 * declare it. Schema:
 *
 *   script:
 *     entrypoint: scripts/voice_loader.py   # required, relative to skill dir
 *     runtime: python3                       # required (node|python3|bash|...)
 *     cwd: project-root                      # optional, default project-root
 *     argsHint: "--voice <name> --input <path>"  # optional UX hint
 *
 * Returns undefined when the block is absent or malformed. Malformed
 * blocks are silently dropped — index builder logs a warning so authors
 * see it, but the artifact still indexes as a non-executable skill.
 */
export function extractSkillScript(
  data: Record<string, unknown>,
): import('./types.js').SkillScriptSpec | undefined {
  const raw = data.script;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const block = raw as Record<string, unknown>;
  const entrypoint = typeof block.entrypoint === 'string' ? block.entrypoint.trim() : '';
  const runtime = typeof block.runtime === 'string' ? block.runtime.trim() : '';
  if (!entrypoint || !runtime) return undefined;
  const cwdRaw = typeof block.cwd === 'string' ? block.cwd.trim() : 'project-root';
  const cwd: 'project-root' | 'skill-dir' | 'aiwg-root' =
    cwdRaw === 'skill-dir' || cwdRaw === 'aiwg-root' ? cwdRaw : 'project-root';
  const argsHint = typeof block.argsHint === 'string' ? block.argsHint.trim() : undefined;
  return {
    entrypoint,
    runtime,
    cwd,
    ...(argsHint ? { argsHint } : {}),
  };
}

/**
 * Compute truncated SHA-256 checksum (16 hex chars)
 */
function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Convert Python-style named capture groups (?P<name>...) to JS-style (?<name>...)
 */
export function normalizeNamedCaptures(pattern: string): string {
  return pattern.replace(/\(\?P</g, '(?<');
}

/**
 * Build a MetadataEntry from filename regex captures instead of file content.
 * Used when graphConfig.nodeStrategy === 'filename-metadata'.
 *
 * @implements #723
 */
export function buildFilenameMetadataEntry(
  relativePath: string,
  fullPath: string,
  filenamePattern: string | undefined,
): MetadataEntry {
  const basename = path.basename(fullPath);
  let captures: Record<string, string> = {};

  if (filenamePattern) {
    const normalizedPattern = normalizeNamedCaptures(filenamePattern);
    const regex = new RegExp(normalizedPattern);
    const match = basename.match(regex);
    if (match?.groups) {
      captures = match.groups;
    }
  }

  const ref = captures.ref ? `REF-${captures.ref}` : '';
  const titleParts = [ref, captures.author, captures.year, captures.slug].filter(Boolean);
  const title = titleParts.length > 0 ? titleParts.join(' — ') : basename;

  // Use file stat for timestamps; checksum is based on filename (content not read)
  const stat = fs.statSync(fullPath);
  const checksum = createHash('sha256').update(basename).digest('hex').slice(0, 16);

  return {
    path: relativePath,
    type: captures.ref ? 'paper' : 'document',
    phase: 'other',
    title,
    tags: [],
    created: stat.birthtime.toISOString(),
    updated: stat.mtime.toISOString(),
    checksum,
    summary: '',
    dependencies: [],
    dependents: [],
    // Store captures as a non-standard field for downstream consumers
    ...(Object.keys(captures).length > 0 ? { captures } : {}),
  } as MetadataEntry;
}

/**
 * Apply metadata supplements — merge frontmatter fields from sidecar files.
 *
 * @implements #723
 */
function applyMetadataSupplements(
  entries: Record<string, MetadataEntry>,
  supplements: MetadataSupplementConfig[],
  cwd: string,
): void {
  for (const supplement of supplements) {
    const sidecarDir = path.join(cwd, supplement.scanDir);
    if (!fs.existsSync(sidecarDir)) continue;

    if (!supplement.matchOn || !supplement.nodeKey) continue;

    // Parse matchOn: "frontmatter.ref" -> field "ref"
    const matchField = supplement.matchOn.replace(/^frontmatter\./, '');

    // Build a map of sidecar files: matchField value -> frontmatter data
    const sidecarFiles = findArtifactFiles(sidecarDir, ['.md', '.yaml', '.json']);
    const sidecarMap = new Map<string, Record<string, unknown>>();

    for (const sidecarPath of sidecarFiles) {
      const content = fs.readFileSync(sidecarPath, 'utf-8');
      const { data } = parseFrontmatter(content);
      const matchValue = data[matchField];
      if (typeof matchValue === 'string') {
        sidecarMap.set(matchValue, data);
      }
    }

    // Match entries to sidecars and merge fields
    for (const entry of Object.values(entries)) {
      const entryCaptures = (entry as MetadataEntry & { captures?: Record<string, string> }).captures;
      if (!entryCaptures) continue;

      const nodeValue = entryCaptures[supplement.nodeKey];
      if (!nodeValue) continue;

      // Build the full ref ID for matching (e.g., captures.ref="008" -> "REF-008")
      const matchValue = supplement.nodeKey === 'ref' ? `REF-${nodeValue}` : nodeValue;
      const sidecarData = sidecarMap.get(matchValue);
      if (!sidecarData) continue;

      for (const field of supplement.mergeFields) {
        const value = sidecarData[field];
        if (value === undefined) continue;

        if (field === 'title' && typeof value === 'string') {
          entry.title = value;
        } else if (field === 'tags' && Array.isArray(value)) {
          entry.tags = [...new Set([...entry.tags, ...value.map(String)])];
        } else if (field === 'authors' && typeof value === 'string') {
          entry.summary = value;
        }
        // Other fields stored via captures — downstream consumers can access them
      }
    }
  }
}

/**
 * Build the artifact index
 */
/**
 * Detect an AIWG workflow "Flow" document — the declarative YAML metalanguage
 * (`apiVersion: workflow.aiwg.io/v1`, the legacy `ops.aiwg.io/v1` alias, and
 * domain-extension namespaces like `<domain>.workflow.aiwg.io/v1`). Pure-YAML
 * Flow docs carry no markdown frontmatter, so the standard frontmatter path
 * leaves them unclassified and invisible to discovery. This surfaces them as
 * `type: 'flow'` with discovery metadata drawn from `metadata.name`,
 * `spec.description`, and `metadata.labels` (#1540). Returns null for any file
 * that isn't a recognizable Flow document.
 */
export function parseFlowDoc(
  content: string,
  filePath: string
): {
  type: 'flow' | 'runbook';
  kind: string;
  name?: string;
  description?: string;
  capability?: string;
  tags: string[];
  searchTerms: string[];
} | null {
  if (!/\.ya?ml$/i.test(filePath)) return null;
  let doc: unknown;
  try {
    doc = loadYaml(content);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const api = typeof d.apiVersion === 'string' ? d.apiVersion : '';
  // core (workflow.aiwg.io/v1), the forward Flows alias (flow.aiwg.io/v1,
  // #1536), the legacy alias (ops.aiwg.io/v1), and any domain-extension
  // namespace ending in one of those.
  const isFlow = /(^|\.)(workflow|flow|ops)\.aiwg\.io\/v1$/.test(api);
  if (!isFlow) return null;
  const kind = typeof d.kind === 'string' ? d.kind.trim() : '';
  // The namespace alone is insufficient: other domain schemas may end in an
  // `ops.aiwg.io` suffix. Accept only the workflow metalanguage resource
  // families and their Workflow/Flow/Ops aliases.
  const isFlowKind = /^(?:(?:Workflow|Flow|Ops)?(?:Capability|Playbook|Inventory|Target|Gate|Role|Extension|Runbook))$/.test(kind);
  if (!isFlowKind) return null;
  const meta = (d.metadata && typeof d.metadata === 'object' ? d.metadata : {}) as Record<string, unknown>;
  const spec = (d.spec && typeof d.spec === 'object' ? d.spec : {}) as Record<string, unknown>;
  const labelMap = meta.labels && typeof meta.labels === 'object'
    ? meta.labels as Record<string, unknown>
    : {};
  const labels = Object.values(labelMap).map(String);
  const name = typeof meta.name === 'string' ? meta.name : undefined;
  const description = typeof spec.description === 'string' ? spec.description : undefined;
  const searchTerms = new Set<string>([kind, ...Object.keys(labelMap), ...labels]);
  const excludedKeys = new Set(['body', 'content', 'script', 'source', 'template']);
  const collectTerms = (value: unknown, key = '', depth = 0): void => {
    if (depth > 7 || searchTerms.size >= 80) return;
    if (typeof value === 'string') {
      const compact = value.replace(/\s+/g, ' ').trim();
      if (compact && compact.length <= 320) searchTerms.add(compact);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectTerms(item, key, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (excludedKeys.has(childKey.toLowerCase())) continue;
      if (/^(id|name|kind|agent|capability|command|action|expect|description|role|inventory|target|group|schema|rollback[_-]?capability)$/i.test(childKey)) {
        searchTerms.add(childKey.replace(/[_-]+/g, ' '));
      }
      collectTerms(childValue, childKey, depth + 1);
    }
  };
  collectTerms(spec);
  const fallbackTerms = [...searchTerms]
    .filter(term => term !== kind && term !== name)
    .slice(0, 4);
  const capability = description
    ?? `${kind.replace(/([a-z])([A-Z])/g, '$1 $2')} ${name ?? ''}${fallbackTerms.length > 0 ? `: ${fallbackTerms.join('; ')}` : ''}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  return {
    type: /Runbook$/.test(kind) ? 'runbook' : 'flow',
    kind,
    name,
    description,
    capability,
    tags: labels,
    searchTerms: [...searchTerms],
  };
}

/**
 * Best-effort absolute path to the AIWG install root, for error text that must
 * name where the framework graph can actually be built (#2530).
 */
function resolveInstallRootHint(): string {
  try {
    // The running module lives under the install root; walk up to the package.
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i += 1) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const content = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string };
          if (content.name === 'aiwg' || content.name === '@aiwg/cli') return dir;
        } catch { /* keep walking */ }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return '<aiwg install root>';
}

export async function buildIndex(
  cwd: string,
  options: BuildOptions = {}
): Promise<void> {
  const { force = false, verbose = false, scope, includeIgnored = false, outputDir, graph, explicit = true } = options;
  const startTime = Date.now();
  const log = options.quiet ? (..._args: unknown[]) => {} : console.log;

  // Ensure user-defined graphs are loaded
  loadUserGraphConfigs(cwd);
  loadGlobalGraphConfigs();

  // Determine scan directories based on graph type
  const graphConfig = graph ? GRAPH_CONFIGS[graph] : undefined;
  let scanDirs: string[];

  if (scope) {
    // Explicit scope overrides graph config
    scanDirs = [path.join(cwd, scope)];
  } else if (graphConfig) {
    scanDirs = graphConfig.scanDirs.map(d => resolveGraphScanDir(cwd, d));
  } else {
    // Default: scan .aiwg/ (backward compatible)
    scanDirs = [resolveProjectAiwgDir(cwd)];
  }

  // Verify at least one scan directory exists
  const existingDirs = scanDirs.filter(d => fs.existsSync(d));
  if (existingDirs.length === 0) {
    // If this graph was auto-selected rather than explicitly requested via --graph,
    // skip gracefully — docs/corpus repos should not be forced to have every
    // built-in or user-defined graph root when `--all` asks for the available set.
    if (!explicit) {
      const relDirs = scanDirs.map(d => path.relative(cwd, d)).join(', ');
      console.warn(`Warning: ${graph} graph: scan directories not found (${relDirs}), skipping`);
      return;
    }
    console.error(`Error: No scan directories found: ${scanDirs.join(', ')}`);
    // The framework graph scans the AIWG corpus, which only exists at the install
    // root — never in a consumer project. Saying "run from a project with the
    // required directories" sends the operator looking in the wrong place (#2530).
    if (graph === 'framework') {
      const installRoot = resolveInstallRootHint();
      log('The framework graph indexes the AIWG corpus and can only be built at the');
      log('install root, not in a consumer project. Build it there, then sync here:');
      log('');
      log(`  cd ${installRoot} && aiwg index build --graph framework --force`);
      log(`  cd ${cwd} && aiwg index sync --backend fortemi-core --graph framework`);
      log('');
      log("As an immediate workaround, discovery also works with '--backend local'.");
    } else {
      log('Run this command from a project with the required directories.');
    }
    process.exit(1);
  }

  // Determine output index directory
  let indexOutputDir: string;
  if (outputDir) {
    // Test/custom override — write to outputDir/.aiwg/.index/ (or graph subdir)
    indexOutputDir = graph
      ? path.join(outputDir, '.aiwg', '.index', graph)
      : path.join(outputDir, INDEX_DIR);
  } else if (graph) {
    indexOutputDir = resolveIndexDir(cwd, graph);
  } else {
    indexOutputDir = resolveIndexDir(cwd);
  }
  fs.mkdirSync(indexOutputDir, { recursive: true });
  // effectiveOutputCwd is used for backward-compat loadMetadataIndex calls
  const effectiveOutputCwd = outputDir ?? cwd;

  if (graph === 'source') {
    const { buildSourceGraphIndex } = await import('./source-graph.js');
    await buildSourceGraphIndex({
      cwd,
      outputDir: indexOutputDir,
      effectiveOutputCwd,
      verbose,
    });
    const buildTimeMs = Date.now() - startTime;
    log(`Source graph built in ${buildTimeMs}ms`);
    log(`  Output: ${INDEX_DIR}/source/`);
    return;
  }

  // Load existing index for incremental updates
  const backendType = resolveGraphBackendType(graph);
  const buildConfigHash = createHash('sha256')
    .update(JSON.stringify({ graphConfig, backendType }))
    .digest('hex');
  const existingIndex = force
    ? null
    : outputDir
      ? loadIndexFromDir<ArtifactIndex>(indexOutputDir, 'metadata.json')
      : loadGraphIndexFile<ArtifactIndex>(effectiveOutputCwd, 'metadata.json', graph);
  const canReuseExisting = existingIndex?.version === INDEX_VERSION
    && existingIndex.extractorVersion === INDEX_EXTRACTOR_VERSION
    && existingIndex.buildConfigHash === buildConfigHash;
  const existingEntries = canReuseExisting ? existingIndex.entries : {};

  // Load checksum manifest for fast stat-based change detection (#794).
  // When --force is set we skip the manifest entirely and rebuild everything.
  const manifest: ChecksumManifest = force || !canReuseExisting
    ? { version: 1, generated: '', entries: {} }
    : loadManifest(indexOutputDir);
  const nextManifestEntries: Record<string, import('./checksum-manifest.js').ManifestEntry> = {};
  const manifestStats: ManifestStats = {
    checked: 0,
    statSkipped: 0,
    checksumSkipped: 0,
    reindexed: 0,
    pruned: 0,
  };

  // Collect files from all scan directories
  const files = await collectGraphIndexFiles(cwd, graph, { scope, includeIgnored });
  const entries: Record<string, MetadataEntry> = {};
  const tagIndex: TagIndex = {};
  const depGraph: DependencyGraph = {};

  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  const useFilenameMetadata = graphConfig?.nodeStrategy === 'filename-metadata';

  const reportBuild = (buildTimeMs: number, total: number): void => {
    log(`Artifact index built in ${buildTimeMs}ms`);
    log(`  Indexed ${newCount} new, updated ${updatedCount}, unchanged ${unchangedCount}`);
    log(`  Total: ${total} artifacts`);
    if (!force && manifestStats.checked > 0) {
      const fastPath = manifestStats.statSkipped;
      const slowPath = manifestStats.checked - manifestStats.statSkipped;
      log(`  Change detection: ${manifestStats.checked} checked, ${fastPath} skipped via stat, ${slowPath} content-read, ${manifestStats.reindexed} re-indexed`);
      if (manifestStats.pruned > 0) {
        log(`  Pruned ${manifestStats.pruned} stale manifest entries (files no longer on disk)`);
      }
    }
    const displayDir = graph ? indexOutputDir : `${INDEX_DIR}/`;
    log(`  Output: ${displayDir}`);
  };

  for (const fullPath of files) {
    const relativePath = indexPathFor(cwd, fullPath, graph);

    let entry: MetadataEntry;

    if (useFilenameMetadata) {
      // Filename-metadata strategy: derive metadata from filename, skip content read.
      // The checksum manifest doesn't help here (no content read to skip) but we still
      // preserve any existing manifest entry so cross-graph builds don't drop it.
      const checksum = createHash('sha256').update(path.basename(fullPath)).digest('hex').slice(0, 16);
      const existingManifestEntry = manifest.entries[relativePath];
      if (existingManifestEntry) {
        nextManifestEntries[relativePath] = existingManifestEntry;
      }

      // Skip unchanged files in incremental mode
      if (!force && existingEntries[relativePath]?.checksum === checksum) {
        entries[relativePath] = existingEntries[relativePath];
        unchangedCount++;
        if (verbose) log(`  unchanged: ${relativePath}`);
        continue;
      }

      entry = buildFilenameMetadataEntry(relativePath, fullPath, graphConfig?.filenamePattern);
    } else {
      // Default strategy: read content, parse frontmatter
      manifestStats.checked++;

      // Phase 1: stat-based quick filter — skip content read if mtime+size match manifest.
      // This is the fast path: unchanged files don't touch the filesystem beyond fs.statSync.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          manifestStats.pruned++;
          if (verbose) log(`  skipped missing: ${relativePath}`);
          continue;
        }
        throw err;
      }
      const manifestEntry = manifest.entries[relativePath];

      if (!force && statMatches(stat, manifestEntry) && existingEntries[relativePath]?.checksum === manifestEntry?.checksum) {
        // Stat matches manifest AND the stored index entry references the same checksum.
        // Safe to reuse both without reading the file.
        entries[relativePath] = existingEntries[relativePath];
        nextManifestEntries[relativePath] = manifestEntry!;
        unchangedCount++;
        manifestStats.statSkipped++;
        if (verbose) log(`  unchanged (stat): ${relativePath}`);
        continue;
      }

      // Phase 2: content read + checksum verification for files that looked changed.
      const content = fs.readFileSync(fullPath, 'utf-8');
      const checksum = computeChecksum(content);

      // Skip unchanged files in incremental mode (checksum matched despite stat drift)
      if (!force && existingEntries[relativePath]?.checksum === checksum) {
        entries[relativePath] = existingEntries[relativePath];
        // Update manifest with current stat so Phase 1 succeeds next time.
        nextManifestEntries[relativePath] = makeEntry(checksum, stat);
        unchangedCount++;
        manifestStats.checksumSkipped++;
        if (verbose) log(`  unchanged (checksum): ${relativePath}`);
        continue;
      }

      manifestStats.reindexed++;
      nextManifestEntries[relativePath] = makeEntry(checksum, stat);
      const { data, body } = parseFrontmatter(content);
      // YAML Flow documents (workflow.aiwg.io/v1) are pure YAML, not
      // markdown+frontmatter — detect them up front so they classify and
      // become discoverable (#1540).
      const flow = parseFlowDoc(content, relativePath);
      const decision = flow ? null : parseDecisionDoc(content, relativePath);
      const gatePack = flow || decision ? null : parseGatePackDoc(content, relativePath);
      const inferredType = inferType(data, relativePath);
      const physicalType = inferType({ ...data, type: undefined }, relativePath);
      const runbook = flow || decision || gatePack ? null : parseRunbookDoc(data, body, relativePath);
      const schemaDoc = inferredType === 'schema' ? parseSchemaDoc(content, relativePath) : null;
      const title = flow?.name ?? decision?.name ?? gatePack?.name ?? schemaDoc?.title ?? extractTitle(data, body);
      const phase = typeof data.phase === 'string' ? data.phase : inferPhase(relativePath);
      const type = flow?.type ?? decision?.type ?? gatePack?.type ?? (runbook ? 'runbook' : inferredType);
      const tags = flow?.tags ?? decision?.tags ?? gatePack?.tags ?? (Array.isArray(data.tags) ? data.tags.map(String) : []);
      const summary = flow?.description ?? decision?.description ?? gatePack?.description ?? schemaDoc?.capability ?? runbook?.capability ?? extractSummary(data, body);
      const dependencies = extractMentions(content);
      const markdownLinks = extractMarkdownLinks(content);

      // Discovery metadata (#1214, #1540, #1792) — meaningful for operational
      // AIWG artifact kinds. Kept undefined on document types so the index file
      // stays small for the common case.
      const isDiscoverable = OPERATIONAL_DISCOVERY_TYPES.includes(
        type as typeof OPERATIONAL_DISCOVERY_TYPES[number],
      );
      // Declarative processes have no trigger phrases — they rely on their
      // capability and structure-aware search terms.
      const triggers = isDiscoverable && !flow ? extractTriggers(body, data) : undefined;
      const capability = flow?.capability ?? decision?.capability ?? gatePack?.capability ?? schemaDoc?.capability ?? runbook?.capability ?? (isDiscoverable ? extractCapability(data, body) : undefined);
      const kind = flow?.kind ?? decision?.kind ?? gatePack?.kind ?? runbook?.kind;
      const sourceType = runbook && physicalType !== 'runbook' ? physicalType : undefined;
      const searchTerms = flow?.searchTerms ?? decision?.searchTerms ?? gatePack?.searchTerms ?? schemaDoc?.searchTerms ?? runbook?.searchTerms;
      const kernel =
        data.kernel === true || data.kernel === 'true' ? true : undefined;
      // Script entrypoint metadata is meaningful for skills only (#1227).
      const script = type === 'skill' ? extractSkillScript(data) : undefined;
      const operationalState = normalizeOperationalState(data.operational_state);
      const stateTransfer = normalizeStateTransferProjection(data.state_transfer);
      // Canonical short name (#1233) — used by the scorer to floor exact-name
      // queries to 1.0 so hyphenated kernel-skill names like `aiwg-doctor`
      // remain searchable even when the rendered title strips the hyphen.
      const name = flow?.name ?? decision?.name ?? gatePack?.name ?? schemaDoc?.name ?? (isDiscoverable ? extractCanonicalName(data, relativePath) : undefined);

      entry = {
        path: relativePath,
        type,
        ...(kind ? { kind } : {}),
        ...(sourceType ? { sourceType } : {}),
        phase,
        title,
        tags,
        created: typeof data.created === 'string' ? data.created : stat.birthtime.toISOString(),
        updated: stat.mtime.toISOString(),
        checksum,
        summary,
        dependencies,
        ...(markdownLinks.length > 0 ? { markdownLinks } : {}),
        dependents: [], // Computed after all entries are processed
        ...(name ? { name } : {}),
        ...(triggers && triggers.length > 0 ? { triggers } : {}),
        ...(capability ? { capability } : {}),
        ...(searchTerms && searchTerms.length > 0 ? { searchTerms } : {}),
        ...(kernel ? { kernel } : {}),
        ...(script ? { script } : {}),
        ...(type === 'rule' || type === 'behavior' ? extractRuleBindings(data) : {}),
        ...(operationalState ? { operationalState } : {}),
        ...(stateTransfer ? { stateTransfer } : {}),
      };
    }

    entries[relativePath] = entry;

    if (existingEntries[relativePath]) {
      updatedCount++;
      if (verbose) log(`  updated: ${relativePath}`);
    } else {
      newCount++;
      if (verbose) log(`  new: ${relativePath}`);
    }
  }

  // Reuse derived indexes only when their complete input set is unchanged.
  // Supplements can live outside the scanned files, so they must still be read.
  // Configured edge extractors must run to discard stale cached edges even
  // when source checksums match.
  const total = Object.keys(entries).length;
  if (canReuseExisting && !useFilenameMetadata && !graphConfig?.metadataSupplements?.length
    && !graphConfig?.edgeExtraction
    && newCount === 0 && updatedCount === 0
    && total === Object.keys(existingEntries).length
    && manifest.generated && total === Object.keys(manifest.entries).length
    && manifestStats.pruned === 0) {
    const stats = loadIndexFromDir<IndexStats>(indexOutputDir, 'stats.json');
    const requiredFiles = ['tags.json', 'dependencies.json'];
    if (backendType === 'sqlite') requiredFiles.push('graph.db');
    if (stats?.version === INDEX_VERSION && stats.extractorVersion === INDEX_EXTRACTOR_VERSION
      && stats.totalArtifacts === total
      && requiredFiles.every(filename => fs.existsSync(path.join(indexOutputDir, filename)))) {
      // A timestamp-only source change needs a manifest refresh, but does not
      // invalidate metadata, tags, dependencies, or the persistent backend.
      if (manifestStats.checksumSkipped > 0) {
        writeManifest(indexOutputDir, {
          version: 1,
          generated: new Date().toISOString(),
          entries: nextManifestEntries,
        });
      }
      const buildTimeMs = Date.now() - startTime;
      writeIndexFile(effectiveOutputCwd, 'stats.json', {
        ...stats,
        builtAt: new Date().toISOString(),
        buildTimeMs,
      }, indexOutputDir);
      reportBuild(buildTimeMs, total);
      return;
    }
  }

  // Apply metadata supplements if configured (enriches filename-metadata nodes from sidecars)
  if (graphConfig?.metadataSupplements?.length) {
    applyMetadataSupplements(entries, graphConfig.metadataSupplements, cwd);
  }

  // Build tag reverse index
  for (const entry of Object.values(entries)) {
    for (const tag of entry.tags) {
      if (!tagIndex[tag]) tagIndex[tag] = [];
      tagIndex[tag].push(entry.path);
    }
  }

  // Build dependency graph and compute dependents
  let markdownLinkEdgeCount = 0;
  for (const entry of Object.values(entries)) {
    if (!depGraph[entry.path]) {
      depGraph[entry.path] = { upstream: [], downstream: [] };
    }

    for (const dep of entry.dependencies) {
      // Normalize: check if referenced path exists in the index
      const normalizedDep = Object.keys(entries).find(
        p => p === dep || p.endsWith(dep)
      );
      if (normalizedDep && normalizedDep !== entry.path) {
        addDependencyEdge(depGraph, entries, entry.path, normalizedDep, 'depends-on');
      }
    }

    for (const link of entry.markdownLinks ?? []) {
      const normalizedDep = resolveMarkdownLinkDependency(cwd, entry.path, link, entries, graph);
      if (normalizedDep && addDependencyEdge(depGraph, entries, entry.path, normalizedDep, 'markdown-link')) {
        markdownLinkEdgeCount++;
      }
    }
  }

  // Run citation sidecar edge extraction if configured
  let citationMetrics: {
    canonicalEdges: number;
    outgoingDeclarations: number;
    incomingDeclarations: number;
    unmirroredOutgoing: number;
    unmirroredIncoming: number;
  } | null = null;
  if (graphConfig?.edgeExtraction?.parser === 'citation-sidecar') {
    // Build REF-XXX → path map from all entries with ref frontmatter
    const entryFrontmatter = new Map<string, Record<string, unknown>>();
    for (const entryPath of Object.keys(entries)) {
      const fullPath = absoluteEntryPath(cwd, entryPath, graph);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const { data } = parseFrontmatter(content);
        entryFrontmatter.set(entryPath, data);
      }
    }
    const refToPath = buildRefToPathMap(entryFrontmatter);

    // Parse each entry as a citation sidecar and extract edges
    let citationEdgeCount = 0;
    let outgoingDeclarations = 0;
    let incomingDeclarations = 0;
    const canonicalOutgoing = new Set<string>();
    const declaredIncoming = new Set<string>();
    for (const entryPath of Object.keys(entries)) {
      const fullPath = absoluteEntryPath(cwd, entryPath, graph);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const result = parseCitationSidecar(content);
      if (!result) continue;

      outgoingDeclarations += result.cites.length;
      incomingDeclarations += result.citedBy.length;
      for (const targetRef of result.cites) {
        canonicalOutgoing.add(`${result.ref}\0${targetRef}`);
      }
      for (const sourceRef of result.citedBy) {
        declaredIncoming.add(`${sourceRef}\0${result.ref}`);
      }

      const edges = citationResultToEdges(result, refToPath);

      if (!depGraph[entryPath]) {
        depGraph[entryPath] = { upstream: [], downstream: [] };
      }

      // Add upstream "cites" edges
      for (const edge of edges.upstream) {
        depGraph[entryPath].upstream.push(edge);
        // Add reciprocal downstream edge on the target
        if (!depGraph[edge.path]) {
          depGraph[edge.path] = { upstream: [], downstream: [] };
        }
        depGraph[edge.path].downstream.push({ path: entryPath, type: 'cites' });
        citationEdgeCount++;
      }

      // Add downstream "cited-by" edges
      for (const edge of edges.downstream) {
        depGraph[entryPath].downstream.push(edge);
        // Add reciprocal upstream edge on the source
        if (!depGraph[edge.path]) {
          depGraph[edge.path] = { upstream: [], downstream: [] };
        }
        depGraph[edge.path].upstream.push({ path: entryPath, type: 'cited-by' });
        citationEdgeCount++;
      }
    }

    citationMetrics = {
      canonicalEdges: canonicalOutgoing.size,
      outgoingDeclarations,
      incomingDeclarations,
      unmirroredOutgoing: [...canonicalOutgoing]
        .filter(edge => !declaredIncoming.has(edge)).length,
      unmirroredIncoming: [...declaredIncoming]
        .filter(edge => !canonicalOutgoing.has(edge)).length,
    };

    if (verbose && citationEdgeCount > 0) {
      log(`  citation edges: ${citationEdgeCount}`);
    }
  }

  // Deduplicate dependents
  for (const entry of Object.values(entries)) {
    entry.dependents = [...new Set(entry.dependents)];
  }

  const buildTimeMs = Date.now() - startTime;

  // Write index files
  const index: ArtifactIndex = {
    version: INDEX_VERSION,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    buildConfigHash,
    builtAt: new Date().toISOString(),
    buildTimeMs,
    entries,
  };

  writeIndexFile(effectiveOutputCwd, 'metadata.json', index, indexOutputDir);
  writeIndexFile(effectiveOutputCwd, 'tags.json', tagIndex, indexOutputDir);
  writeIndexFile(effectiveOutputCwd, 'dependencies.json', depGraph, indexOutputDir);

  // Materialize the configured backend and always retain dependencies.json as
  // the stable compatibility/export contract.
  const { createGraphBackend } = await import('./graph-backend.js');
  const persistentPath = backendType === 'sqlite' ? path.join(indexOutputDir, 'graph.db') : undefined;
  let selectedBackend;
  try {
    selectedBackend = await createGraphBackend(backendType, persistentPath);
    selectedBackend.deserialize(depGraph);
  } finally {
    await selectedBackend?.close?.();
  }

  // Update and persist the checksum manifest for faster future builds (#794).
  // The next manifest contains entries for every file we processed this build.
  // Files that disappeared from disk are pruned; the resulting manifest is
  // written atomically.
  const nextManifest: ChecksumManifest = {
    version: 1,
    generated: new Date().toISOString(),
    entries: nextManifestEntries,
  };
  manifestStats.pruned = Object.keys(manifest.entries).length - Object.keys(nextManifestEntries).length;
  if (manifestStats.pruned < 0) manifestStats.pruned = 0;
  writeManifest(indexOutputDir, nextManifest);

  // Write stats
  const downstreamEdges = Object.values(depGraph).reduce(
    (sum, node) => sum + node.downstream.length, 0
  );
  const adjacencyEntries = Object.values(depGraph).reduce(
    (sum, node) => sum + node.upstream.length + node.downstream.length, 0
  );
  const totalEdges = citationMetrics?.canonicalEdges ?? downstreamEdges;
  const orphaned = Object.entries(depGraph).filter(
    ([, node]) => node.upstream.length === 0 && node.downstream.length === 0
  ).length;
  const mostReferenced = Object.entries(depGraph)
    .map(([p, node]) => ({ path: p, count: node.downstream.length }))
    .sort((a, b) => b.count - a.count)[0] ?? null;

  const byPhase: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const tagDist: Record<string, number> = {};

  for (const entry of Object.values(entries)) {
    byPhase[entry.phase] = (byPhase[entry.phase] || 0) + 1;
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    for (const tag of entry.tags) {
      tagDist[tag] = (tagDist[tag] || 0) + 1;
    }
  }

  writeIndexFile(effectiveOutputCwd, 'stats.json', {
    version: INDEX_VERSION,
    extractorVersion: INDEX_EXTRACTOR_VERSION,
    builtAt: new Date().toISOString(),
    buildTimeMs,
    totalArtifacts: Object.keys(entries).length,
    byPhase,
    byType,
    tagDistribution: tagDist,
    graphMetrics: {
      backend: backendType,
      totalEdges,
      markdownLinkEdges: markdownLinkEdgeCount,
      ...(citationMetrics ? {
        canonicalEdges: citationMetrics.canonicalEdges,
        outgoingDeclarations: citationMetrics.outgoingDeclarations,
        incomingDeclarations: citationMetrics.incomingDeclarations,
        adjacencyEntries,
        unmirroredOutgoing: citationMetrics.unmirroredOutgoing,
        unmirroredIncoming: citationMetrics.unmirroredIncoming,
      } : {}),
      orphanedArtifacts: orphaned,
      mostReferenced,
    },
  }, indexOutputDir);

  // Report
  reportBuild(buildTimeMs, total);
}
