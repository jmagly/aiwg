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
import { CITATION_HEADER_ALIASES, CITATION_TABLE_FORMS } from './citation-table-schema.js';

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
  return /\b(?:topical|thematic|conditional|non[- ]citations?|methodological cousin|related|unverified)\b/.test(text)
    || /\bnot (?:(?:a|an) )?(?:(?:verified|formal) )?(?:citations?|cites|cited|verified)\b/.test(text)
    || /\bno (?:formal |verified )?citations?\b/.test(text)
    || /\b(?:if|unless|provided that|assuming)\b/.test(text);
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
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
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
    if (isNonCitation(context.join('\n')) || table.length < 3) continue;

    const headers = parseRow(table[0]).map(normalizeCell);
    if (headers.some(isNonCitation)) continue;
    const separator = parseRow(table[1]);
    if (separator.length !== headers.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const roles = headers.map(header => HEADER_ROLES.get(header));
    if (bibliographicOnly && !CITATION_TABLE_FORMS.some(form =>
      form.length === roles.length && form.every((role, index) => role === roles[index]),
    )) continue;

    // For graph extraction the matched form registers exactly one resolution
    // column. The generic column helper still honors its explicit alias order.
    const colIndex = bibliographicOnly
      ? roles.indexOf('ref')
      : aliases.map(alias => headers.indexOf(alias)).find(index => index !== -1) ?? -1;
    if (colIndex === -1) continue;

    for (const line of table.slice(2)) {
      const cells = parseRow(line);
      // Extra/missing cells have no unambiguous column semantics. Never guess.
      if (cells.length !== headers.length) continue;
      const qualifiers = cells.filter((_, index) => index === colIndex
        || ['notes', 'evidence', 'context', 'kind'].includes(roles[index] ?? '')
        || (!bibliographicOnly && !['#', 'title', 'work', 'authors', 'year', 'doi/url', 'doi', 'url'].includes(headers[index])));
      if (qualifiers.some(isNonCitation)) continue;
      const matches = cells[colIndex].match(NODE_ID_PATTERN);
      if (matches) refs.push(...matches);
    }
  }
  return [...new Set(refs)];
}

/**
 * Parse a citation sidecar markdown file into structured edges.
 *
 * Only registered bibliographic header forms declare citations, through their
 * resolution column alone.
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
  if (isNonCitation(preamble.replace(/^#+ .*$/gm, ''))) return { ref, cites: [], citedBy: [] };

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
