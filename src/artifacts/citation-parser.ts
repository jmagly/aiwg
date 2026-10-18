/**
 * Citation Sidecar Edge Extraction
 *
 * Parses markdown citation sidecar files into typed graph edges.
 * Each sidecar has YAML frontmatter with `ref: <id>` and two markdown tables:
 *
 * - **Outgoing**: papers this work cites (column: "Inducted REF") → `cites` edges
 * - **Incoming**: corpus papers that cite this work (column: "REF") → `cited-by` edges
 *
 * Supported node-id forms (#105):
 * - `REF-\d+[a-z]?`                research-paper IDs (REF-001, REF-434a, ...)
 * - `PROF-[POFG]-[a-z0-9-]+`       entity-profile IDs:
 *     - `PROF-P-*` people, `PROF-O-*` orgs, `PROF-F-*` funders, `PROF-G-*` groups
 *
 * Both forms can appear as the sidecar's source (`frontmatter.ref`) and as
 * targets in the outgoing/incoming tables. The two ID spaces are
 * unambiguous (always prefixed) and orthogonal.
 *
 * @implements #722
 * @implements #105
 * @source @src/artifacts/types.ts
 * @tests @test/unit/artifacts/citation-parser.test.ts
 */

import type { TypedEdge } from './types.js';
import { parseFrontmatter } from './index-builder.js';
import { CITATION_HEADER_ALIASES } from './citation-table-schema.js';

/**
 * Match a single node identifier (REF-* or PROF-*) anywhere in a string.
 * Used by `extractRefsFromTable` to pull every ID out of a table cell.
 */
const NODE_ID_PATTERN = /(?:REF-\d+[a-z]?|PROF-[POFG]-[a-z0-9-]+)/g;

/**
 * Validate that a string is a complete node identifier.
 * Used by `parseCitationSidecar` and `buildRefToPathMap` to gate
 * frontmatter `ref` values.
 */
const NODE_ID_FULL = /^(?:REF-\d+[a-z]?|PROF-[POFG]-[a-z0-9-]+)$/;

/** An unnamed resolution cell must contain only one REF, optionally decorated. */
function standaloneRef(value: string): string | null {
  let text = value.trim();
  const link = text.match(/^\[([^\]]+)\]\([^\s]+(?:\s+"[^"\n]*")?\)$/);
  if (link) text = link[1].trim();
  const code = text.match(/^`([^`]+)`$/);
  if (code) text = code[1].trim();
  return /^REF-\d+[a-z]?$/.test(text) ? text : null;
}

/** Resolution aliases are shared by every registered bibliographic form. */
const CITATION_REF_COLUMNS = CITATION_HEADER_ALIASES.ref;

const HEADER_ROLES = new Map(
  Object.entries(CITATION_HEADER_ALIASES).flatMap(([role, aliases]) =>
    aliases.map(alias => [alias, role] as const),
  ),
);

function normalizeCell(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

/** Explicitly non-bibliographic or uncertain declarations must not assert citations. */
function isNonCitation(value: string): boolean {
  const text = normalizeCell(value);
  // An explicit disavowal wins even when the description also says "cites".
  if (/\b(?:topical|thematic|non[- ]citations?|methodological cousin|unverified)\b/.test(text)
    || /\bnot (?:(?:a|an) )?(?:(?:verified|formal|directly) )?(?:citations?|cites?|cited|verified)\b/.test(text)
    || /\bno (?:formal |verified )?citations?\b/.test(text)
    || /\b(?:if|unless|provided that|assuming)\s+(?:ref-\d+|prof-[pofg]-|present\b)/.test(text)
    || /\bconditional (?:on|upon)\b/.test(text)
    || /^(?:conditional|related)(?:\s+only)?\s*(?:[(:;—-]|$)/.test(text)) return true;
  // "Cites X in Related Work", "cites-related-version", and citations to a
  // paper named "Conditional Memory" describe real citations, not qualifiers.
  if (/\b(?:cites?|cited|citing)\b/.test(text)) return false;
  return /\brelated\b/.test(text);
}

/** Table/section declarations, rather than incidental mentions in audit prose. */
function isNonCitationContext(value: string): boolean {
  // Candidate-specific audit prose does not disavow the surrounding tables.
  // Keep whole-table declarations separate from notes about particular REFs.
  const text = value.replace(/<!--[\s\S]*?-->/g, '').toLowerCase().replace(/[`*_]/g, '').split('\n')
    .filter(line => !/\b(?:search results|external .*?candidates?|historical records)\b/.test(line))
    .filter(line => !/(?:ref-\d+|prof-[pofg]-)/.test(line)
      || /\b(?:rows|tables?|relationships?|connections?) (?:below|are|only)\b/.test(line))
    .join('\n');
  return /(?:^|\n)\s*(?:related|topical|thematic) works[^\n]*\b(?:do|does) not (?:directly )?cite\b/.test(text)
    || /\b(?:no (?:formal|verified) citations?|not (?:(?:asserted|verified) )?citation (?:edges?|rows?)|relationship notes|related corpus nodes)\b/.test(text)
    || /\bno citations\s*(?:[.!;]|$)/.test(text)
    || /\b(?:topical|thematic|related|conditional|non-citation) (?:relationships?|connections?|only)\b/.test(text)
    || /(?:^|\n)\s*(?:topical|thematic|related|conditional|non-citation)(?:\s+(?:relationships?|connections?|notes|rows|only))?\s*(?:$|\n)/.test(text);
}

/**
 * Test whether a string is a valid sidecar node identifier.
 *
 * Accepts `REF-\d+[a-z]?` and `PROF-[POFG]-[a-z0-9-]+`. Returns false for any
 * other input (including unrelated `PROF-` prefixed strings that don't
 * match the four-letter type code form).
 */
export function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID_FULL.test(value);
}

/**
 * Result of parsing a single citation sidecar file
 */
export interface CitationParseResult {
  /** Source node identifier (e.g., "REF-008" or "PROF-P-marks-samuel") */
  ref: string;

  /** Outgoing "cites" edges — node IDs this paper references */
  cites: string[];

  /** Incoming "cited-by" edges — node IDs of papers that cite this one */
  citedBy: string[];
}

/**
 * Extract node identifiers from a markdown table column.
 *
 * Scans table rows for a column matching `columnName` (case-insensitive)
 * and extracts node IDs (REF-* or PROF-*) only from that cell. Malformed
 * tables/rows and explicit non-citation qualifiers are skipped.
 *
 * @param tableText - Markdown table text (header + separator + rows)
 * @param columnName - Column header to extract from (e.g., "Inducted REF")
 * @returns Array of node identifiers found
 */
export function extractRefsFromTable(
  tableText: string,
  columnName: string | readonly string[],
): string[] {
  return extractTableRefs(tableText, columnName, false);
}

function extractTableRefs(
  tableText: string,
  columnName: string | readonly string[],
  bibliographicOnly: boolean,
): string[] {
  const aliases = (typeof columnName === 'string' ? [columnName] : columnName)
    .map(normalizeCell);
  const parseRow = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
      .map(cell => cell.replace(/\\\|/g, '|').trim());
  const lines = tableText.split('\n');
  const headings: { level: number; text: string }[] = [];
  let preamble: string[] = [];
  const refs: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      // A parent section's declaration also governs its nested tables.
      const parent = headings[headings.length - 1];
      if (parent && parent.level < heading[1].length) parent.text += `\n${preamble.join('\n')}`;
      while (headings.length && headings[headings.length - 1].level >= heading[1].length) headings.pop();
      headings.push({ level: heading[1].length, text: heading[2] });
      preamble = [];
      continue;
    }
    if (!lines[i].trim().startsWith('|')) {
      preamble.push(lines[i]);
      continue;
    }

    const table: string[] = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) table.push(lines[i++]);
    i--;
    const context = [...headings.map(h => h.text), ...preamble];
    preamble = [];
    // A trailing note can explicitly disavow the preceding table's citations.
    const following: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*[#|]/.test(lines[j]); j++) following.push(lines[j]);
    if (/^\s*note\b/im.test(following.join('\n'))) context.push(...following);
    if (isNonCitationContext(context.join('\n')) || table.length < 3) continue;

    const headers = parseRow(table[0]).map(normalizeCell);
    if (headers.some(isNonCitation)) continue;
    const separator = parseRow(table[1]);
    if (separator.length !== headers.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const roles = headers.map(header => HEADER_ROLES.get(header));
    // Incoming/Outgoing declares the direction; the named resolution header
    // identifies the target when present. Otherwise whole-cell REF IDs
    // resolve rows. Additional metadata and column order do not change
    // those semantics. Multiple resolution columns are ambiguous.
    if (bibliographicOnly && roles.filter(role => role === 'ref').length > 1) continue;

    // For graph extraction the headers register exactly one resolution
    // column when present. The generic column helper still honors its explicit alias order.
    const colIndex = bibliographicOnly
      ? roles.indexOf('ref')
      : aliases.map(alias => headers.indexOf(alias)).find(index => index !== -1) ?? -1;
    if (colIndex === -1 && !bibliographicOnly) continue;

    for (const line of table.slice(2)) {
      const cells = parseRow(line);
      // Extra/missing cells have no unambiguous column semantics. Never guess.
      if (cells.length !== headers.length) continue;
      // A condition can also qualify the printed title, as in the downstream
      // "Learning is Forgetting (if REF-828 in 6-benchmark suite)" row.
      if (cells.some(cell => /\b(?:if|unless|provided that|assuming)\s+[`*_[\s]*(?:REF-\d+|PROF-[POFG]-)/i.test(cell))) continue;
      const qualifiers = cells.filter((_, index) => (bibliographicOnly && colIndex === -1) || index === colIndex
        || ['notes', 'evidence', 'context', 'kind', 'relationship', 'status'].includes(roles[index] ?? '')
        || (!bibliographicOnly && !['#', 'title', 'work', 'authors', 'year', 'doi/url', 'doi', 'url'].includes(headers[index])));
      if (qualifiers.some(isNonCitation)) continue;
      // Without a named resolution column, only whole-cell REF IDs resolve.
      // Named columns always take precedence over incidental IDs elsewhere.
      const matches = colIndex === -1
        ? cells.map(standaloneRef).filter((ref): ref is string => ref !== null)
        : cells[colIndex].match(NODE_ID_PATTERN);
      if (matches) refs.push(...matches);
    }
  }
  return [...new Set(refs)];
}

/**
 * Parse a citation sidecar markdown file into structured edges.
 *
 * Tables in Incoming/Outgoing sections declare citations through a unique
 * registered resolution column, or whole-cell REF IDs when no such column
 * exists, independent of other metadata columns.
 * Topical, related, conditional and explicitly non-citation declarations are
 * skipped; they do not produce citation edges or new relationship types.
 *
 * @param content - Full markdown content of the sidecar file
 * @returns Parse result with ref ID and edge arrays, or null if not a valid sidecar
 */
export function parseCitationSidecar(content: string): CitationParseResult | null {
  const { data, body } = parseFrontmatter(content);

  // Must have a node identifier in frontmatter (REF-* or PROF-*)
  const ref = typeof data.ref === 'string' ? data.ref : null;
  if (!ref || !NODE_ID_FULL.test(ref)) return null;

  // Split body into sections by ## headings
  const sections = body.split(/(?=^## )/m).filter(Boolean);
  const preamble = sections[0]?.startsWith('## ') ? '' : sections[0] ?? '';
  if (isNonCitationContext(preamble.replace(/^#+ .*$/gm, ''))) return { ref, cites: [], citedBy: [] };

  let cites: string[] = [];
  let citedBy: string[] = [];

  for (const section of sections) {
    const sectionLower = section.toLowerCase().replace(/^## /, '');

    if (sectionLower.startsWith('outgoing')) {
      cites.push(...extractTableRefs(section, CITATION_REF_COLUMNS, true));
    } else if (sectionLower.startsWith('incoming')) {
      citedBy.push(...extractTableRefs(section, CITATION_REF_COLUMNS, true));
    }
  }

  return { ref, cites: [...new Set(cites)], citedBy: [...new Set(citedBy)] };
}

/**
 * Convert a CitationParseResult into TypedEdge arrays for the dependency graph.
 *
 * @param result - Parsed citation sidecar
 * @param refToPath - Map from REF-XXX to file path in the index
 * @returns Object with upstream (cites) and downstream (cited-by) typed edges
 */
export function citationResultToEdges(
  result: CitationParseResult,
  refToPath: Map<string, string>
): { upstream: TypedEdge[]; downstream: TypedEdge[] } {
  const upstream: TypedEdge[] = [];
  const downstream: TypedEdge[] = [];

  // Outgoing citations → upstream "cites" edges
  for (const citedRef of result.cites) {
    const targetPath = refToPath.get(citedRef);
    if (targetPath) {
      upstream.push({ path: targetPath, type: 'cites' });
    }
  }

  // Incoming citations → downstream "cited-by" edges
  for (const citingRef of result.citedBy) {
    const sourcePath = refToPath.get(citingRef);
    if (sourcePath) {
      downstream.push({ path: sourcePath, type: 'cited-by' });
    }
  }

  return { upstream, downstream };
}

/**
 * Build a node-id → file path mapping from indexed entries.
 *
 * Scans entry frontmatter for `ref` fields matching the node-id pattern
 * (REF-* or PROF-*).
 *
 * @param entries - Map of path → parsed frontmatter data
 * @returns Map from node identifier to file path
 */
export function buildRefToPathMap(
  entries: Map<string, Record<string, unknown>>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [filePath, data] of entries) {
    const ref = typeof data.ref === 'string' ? data.ref : null;
    if (ref && NODE_ID_FULL.test(ref)) {
      map.set(ref, filePath);
    }
  }
  return map;
}
