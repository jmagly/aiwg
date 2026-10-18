/**
 * Citation Sidecar Parser Tests
 *
 * @source @src/artifacts/citation-parser.ts
 * @implements #722
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractRefsFromTable,
  parseCitationSidecar,
  citationResultToEdges,
  buildRefToPathMap,
  isNodeId,
} from '../../../src/artifacts/citation-parser.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import type { DependencyGraph } from '../../../src/artifacts/types.js';
import { GRAPH_CONFIGS, INDEX_DIR } from '../../../src/artifacts/types.js';

describe('Citation Sidecar Parser', () => {
  describe('extractRefsFromTable', () => {
    it('should extract REF-XXX from a markdown table column', () => {
      const table = `
| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 7 | Dense passage retrieval | Karpukhin et al. | 2020 | arXiv:2004.04906 | REF-029 |
| 26 | Neural Turing machines | Graves et al. | 2014 | arXiv:1410.5401 | REF-009 |
| 31 | Some other paper | Smith | 2021 | doi:10.1234 | — |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual(['REF-029', 'REF-009']);
    });

    it('preserves interior empty cells when locating the target column (#1939)', () => {
      const table = `
| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|---|---|---|---|---|
| 1 | Example |  |  |  | REF-002 |
`;
      expect(extractRefsFromTable(table, 'Inducted REF')).toEqual(['REF-002']);
    });

    it('supports aliases and independently parses variant tables (#1939)', () => {
      const tables = `
| Title | Placeholder |
|---|---|
| Ignored | — |

| # | Title | Extra | REF |
|---|---|---|---|
| 1 | Decorated |  | [\`REF-004\`](../REF-004.md) |
`;
      expect(extractRefsFromTable(tables, ['Inducted REF', 'REF'])).toEqual(['REF-004']);
    });

    it('skips malformed rows whose resolution column is ambiguous (#3186)', () => {
      const table = `
| # | Title | Authors | Year | Inducted REF |
|---|---|---|---|---|
| 1 | Shifted | — | — | — | — | REF-006 |
`;
      expect(extractRefsFromTable(table, ['Inducted REF', 'REF'])).toEqual([]);
    });

    it('skips shifted cells and headerless continuation rows (#3186)', () => {
      const tables = `
| Work | In-corpus REF / issue | Status |
|---|---|---|
| Candidate | #249 | REF-007 | exact |

| — | Continued work | REF-008 |
`;
      expect(extractRefsFromTable(tables, ['In-corpus REF', 'REF'])).toEqual([]);
    });

    it('should handle case-insensitive column matching', () => {
      const table = `
| REF | Title | Relationship |
|-----|-------|-------------|
| REF-015 | Self-Refine | Cites RAG baseline |
| REF-042 | Another paper | Some relationship |
`;
      const refs = extractRefsFromTable(table, 'ref');
      expect(refs).toEqual(['REF-015', 'REF-042']);
    });

    it('should skip dash and em-dash values', () => {
      const table = `
| # | Title | Inducted REF |
|---|-------|--------------|
| 1 | Paper A | REF-001 |
| 2 | Paper B | — |
| 3 | Paper C | - |
| 4 | Paper D | – |
| 5 | Paper E | REF-005 |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual(['REF-001', 'REF-005']);
    });

    it('should return empty array for table without the target column', () => {
      const table = `
| # | Title | Authors |
|---|-------|---------|
| 1 | Paper A | Smith |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual([]);
    });

    it('should return empty array for insufficient table rows', () => {
      const table = `
| # | Title | Inducted REF |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual([]);
    });

    it('should handle multiple REF values in a single cell', () => {
      const table = `
| # | Title | Inducted REF |
|---|-------|--------------|
| 1 | Paper | REF-001, REF-002 |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual(['REF-001', 'REF-002']);
    });

    it('should extract PROF-* identifiers alongside REF-* (#105)', () => {
      const table = `
| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 1 | Auditing Hidden Goals | Marks et al. | 2025 | — | REF-803 |
| 2 | Anthropic NLAs | Marks et al. | 2026 | — | REF-779 |
| 3 | Profile cross-link | — | — | — | PROF-O-anthropic |
`;
      const refs = extractRefsFromTable(table, 'Inducted REF');
      expect(refs).toEqual(['REF-803', 'REF-779', 'PROF-O-anthropic']);
    });

    it('should extract all four PROF-* type codes (P/O/F/G)', () => {
      const table = `
| # | Linked Entity |
|---|---------------|
| 1 | PROF-P-marks-samuel |
| 2 | PROF-O-anthropic |
| 3 | PROF-F-open-philanthropy |
| 4 | PROF-G-mech-interp-team |
`;
      const refs = extractRefsFromTable(table, 'Linked Entity');
      expect(refs).toEqual([
        'PROF-P-marks-samuel',
        'PROF-O-anthropic',
        'PROF-F-open-philanthropy',
        'PROF-G-mech-interp-team',
      ]);
    });

    it('should not match malformed PROF-* (wrong type code, no slug)', () => {
      const table = `
| # | Linked Entity |
|---|---------------|
| 1 | PROF-X-bogus |
| 2 | PROF-P- |
| 3 | PROF-INVALID |
| 4 | REF-001 |
`;
      const refs = extractRefsFromTable(table, 'Linked Entity');
      // Only REF-001 is a valid match.
      expect(refs).toEqual(['REF-001']);
    });
  });

  describe('parseCitationSidecar', () => {
    it('should parse a complete citation sidecar file', () => {
      const content = `---
ref: REF-008
title: "Retrieval-Augmented Generation"
type: citations
---

## Outgoing: Papers This Work Cites

| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 7 | Dense passage retrieval | Karpukhin et al. | 2020 | arXiv:2004.04906 | REF-029 |
| 26 | Neural Turing machines | Graves et al. | 2014 | arXiv:1410.5401 | REF-009 |
| 31 | Attention is all you need | Vaswani et al. | 2017 | arXiv:1706.03762 | — |

## Incoming: Papers That Cite This Work

### Corpus Cross-References (Internal)

| # | Title | REF | Notes |
|---|---|---|---|
| 1 | Self-Refine | REF-015 | Cites RAG as retrieval augmentation baseline |
| 2 | Chain of Thought | REF-042 | References retrieval augmentation |
`;

      const result = parseCitationSidecar(content);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe('REF-008');
      expect(result!.cites).toEqual(['REF-029', 'REF-009']);
      expect(result!.citedBy).toEqual(['REF-015', 'REF-042']);
    });

    it('should return null for content without ref frontmatter', () => {
      const content = `---
title: Not a sidecar
---

# Regular document
`;
      expect(parseCitationSidecar(content)).toBeNull();
    });

    it('should return null for invalid ref format', () => {
      const content = `---
ref: INVALID-FORMAT
---

## Outgoing: Papers This Work Cites
`;
      expect(parseCitationSidecar(content)).toBeNull();
    });

    it('should handle sidecar with only outgoing section', () => {
      const content = `---
ref: REF-050
title: "New Paper"
---

## Outgoing: Papers This Work Cites

| # | Title | Inducted REF |
|---|-------|--------------|
| 1 | Paper A | REF-001 |
`;
      const result = parseCitationSidecar(content);
      expect(result).not.toBeNull();
      expect(result!.cites).toEqual(['REF-001']);
      expect(result!.citedBy).toEqual([]);
    });

    it('should handle sidecar with only incoming section', () => {
      const content = `---
ref: REF-001
title: "Foundational Paper"
---

## Incoming: Papers That Cite This Work

| Title | REF |
|---|---|
| Follow-up | REF-010 |
`;
      const result = parseCitationSidecar(content);
      expect(result).not.toBeNull();
      expect(result!.cites).toEqual([]);
      expect(result!.citedBy).toEqual(['REF-010']);
    });

    it('accepts both supported header aliases in outgoing and incoming sections (#1939)', () => {
      const content = `---
ref: REF-001
---

## Outgoing: Papers This Work Cites

| Title | REF |
|---|---|
| Outgoing alias | REF-002 |

## Incoming: Papers That Cite This Work

| Title | Inducted REF |
|---|---|
| Incoming alias | REF-003 |
`;
      expect(parseCitationSidecar(content)).toEqual({
        ref: 'REF-001',
        cites: ['REF-002'],
        citedBy: ['REF-003'],
      });
    });

    it('accepts historical corpus REF aliases (#1939)', () => {
      const content = `---
ref: REF-001
---

## Outgoing References

| Title | Corpus REF |
|---|---|
| Corpus alias | REF-002 |

## Incoming Connections

| Title | In-corpus REF |
|---|---|
| In-corpus alias | REF-003 |
`;
      expect(parseCitationSidecar(content)).toEqual({
        ref: 'REF-001',
        cites: ['REF-002'],
        citedBy: ['REF-003'],
      });
    });

    it('extracts only the named resolution cell, excluding title IDs (#3186)', () => {
      const content = `---
ref: REF-001
---

## Outgoing References

| # | Title | Inducted REF |
|---|---|---|
| 1 | REDIRECT → REF-002 | REF-003 |
`;
      expect(parseCitationSidecar(content)?.cites).toEqual(['REF-003']);
    });

    it('should parse a profile-edges sidecar with PROF-* source (#105)', () => {
      const content = `---
ref: PROF-P-marks-samuel
title: "Samuel Marks"
type: profile-edges
profile-path: profiles/people/PROF-P-marks-samuel.md
---

## Outgoing: Papers this entity authored / is affiliated with

| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 1 | Auditing Hidden Goals via Reasoning Traces | Marks, S. et al. | 2025 | — | REF-803 |
| 2 | Anthropic NLAs | Marks, S. et al. | 2026 | — | REF-779 |
`;
      const result = parseCitationSidecar(content);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe('PROF-P-marks-samuel');
      expect(result!.cites).toEqual(['REF-803', 'REF-779']);
      expect(result!.citedBy).toEqual([]);
    });

    it('should accept all four PROF-* type codes in frontmatter ref', () => {
      for (const id of [
        'PROF-P-marks-samuel',
        'PROF-O-anthropic',
        'PROF-F-open-philanthropy',
        'PROF-G-mech-interp-team',
      ]) {
        const content = `---
ref: ${id}
title: "Entity"
type: profile-edges
---

## Outgoing: Papers this entity authored / is affiliated with
`;
        const result = parseCitationSidecar(content);
        expect(result, `expected ${id} to parse`).not.toBeNull();
        expect(result!.ref).toBe(id);
      }
    });

    it('should reject malformed PROF-* in frontmatter ref', () => {
      const content = `---
ref: PROF-X-bogus
---

## Outgoing: Papers This Work Cites
`;
      expect(parseCitationSidecar(content)).toBeNull();
    });

    it('should handle sidecar with empty tables', () => {
      const content = `---
ref: REF-099
title: "Isolated Paper"
---

## Outgoing: Papers This Work Cites

No inducted references yet.

## Incoming: Papers That Cite This Work

No citations found.
`;
      const result = parseCitationSidecar(content);
      expect(result).not.toBeNull();
      expect(result!.cites).toEqual([]);
      expect(result!.citedBy).toEqual([]);
    });
  });

  describe('semantic citation filtering (#3186)', () => {
    const fixture = (name: string) => fs.readFileSync(
      path.join(import.meta.dirname, '../../fixtures/citation-sidecar-edges', `${name}.md`), 'utf-8',
    );

    const schema = JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, '../../fixtures/citation-sidecar-edges/citation-sidecar.schema.json'), 'utf-8',
    )) as {
      headerAliases: Record<string, string[]>;
      variants: { id: string; kind: string; roles: string[] }[];
    };

    function schemaTable(roles: string[], headers = roles.map(role => schema.headerAliases[role][0])): string {
      const cells = roles.map(role => role === 'ref' ? 'REF-002' : 'Metadata mentioning REF-900');
      return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        `| ${cells.join(' | ')} |`,
      ].join('\n');
    }

    it.each(schema.variants)('resolves the named REF column of $id ($kind)', variant => {
      const table = schemaTable(variant.roles);
      const result = parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${table}\n\n## Incoming\n${table}`);
      const expected = variant.roles.includes('ref') ? ['REF-002'] : [];
      expect(result).toEqual({ ref: 'REF-001', cites: expected, citedBy: expected });
    });

    const bibliographicForms = schema.variants.filter(variant => ['citation', 'compact', 'relation'].includes(variant.kind));
    const aliases = Object.entries(schema.headerAliases).flatMap(([role, names]) => {
      const form = bibliographicForms.find(variant => variant.roles.includes(role));
      return form ? names.filter(alias => !alias.includes('not citation-grounded'))
        .map(alias => ({ role, alias, roles: form.roles })) : [];
    });
    it.each(aliases)('accepts the exact registered $role alias "$alias"', ({ role, alias, roles }) => {
      const headers = roles.map(value => value === role ? `**${alias.toUpperCase()}**` : schema.headerAliases[value][0]);
      expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${schemaTable(roles, headers)}`)?.cites)
        .toEqual(['REF-002']);
    });

    it.each(['Title | REF | REF', 'Title | REF | Corpus REF'])(
      'rejects ambiguous resolution headers: %s', header => {
        const headers = header.split(' | ');
        const table = `| ${header} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map(() => 'REF-002').join(' | ')} |`;
        expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${table}`)?.cites).toEqual([]);
      },
    );

    it.each(['REF | Title', 'Title | REF | Extra', 'REF | Marker | Verbatim prose snippet'])(
      'resolves the named column regardless of other column roles: %s', header => {
        const headers = header.split(' | ');
        const table = `| ${header} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map(h => h === 'REF' ? 'REF-002' : 'REF-900').join(' | ')} |`;
        expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${table}`)?.cites).toEqual(['REF-002']);
      },
    );

    it('keeps the REF-016 incoming and REF-1024 outgoing declarations in their stated directions', () => {
      const cot = parseCitationSidecar(fixture('ref-016'))!;
      const gpt = parseCitationSidecar(fixture('ref-1024'))!;
      expect(cot).toEqual({ ref: 'REF-016', cites: [], citedBy: ['REF-1024', 'REF-1148'] });
      expect(gpt).toEqual({ ref: 'REF-1024', cites: ['REF-016'], citedBy: ['REF-1013'] });
      const paths = new Map(['REF-016', 'REF-1024', 'REF-1148', 'REF-1013'].map(ref => [ref, `${ref}.md`]));
      expect(citationResultToEdges(cot, paths).downstream)
        .toContainEqual({ path: 'REF-1024.md', type: 'cited-by' });
      expect(citationResultToEdges(gpt, paths).upstream)
        .toContainEqual({ path: 'REF-016.md', type: 'cites' });
    });

    it('accepts corpus header variants with additional metadata in either direction', () => {
      const content = fixture('header-variants');
      const expected = Array.from({ length: 14 }, (_, index) => `REF-${index + 2}`);
      expect(parseCitationSidecar(content)?.cites).toEqual(expected);
      expect(parseCitationSidecar(content.replace('## Outgoing', '## Incoming'))?.citedBy).toEqual(expected);
    });

    it('still filters explicit mapping qualifiers in tables with extra columns', () => {
      const table = `
| # | Cited work | Autellix ref | In-corpus REF | Mapping | Evidence |
|---|---|---|---|---|---|
| 1 | Verified work | [36] | REF-002 | exact | Ref list [36] |
| 2 | Another work | [78] | REF-003 | related | Ref list [78] |
`;
      expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${table}`)?.cites).toEqual(['REF-002']);
    });

    it('keeps two-column citation descriptions in both directions and skips qualified rows', () => {
      expect(parseCitationSidecar(fixture('two-column-relationship')))
        .toEqual({ ref: 'REF-001', cites: ['REF-002'], citedBy: ['REF-004'] });
    });

    it('preserves the verified I-JEPA incoming relationship declaration', () => {
      expect(parseCitationSidecar(fixture('verified-relationship'))).toEqual({
        ref: 'REF-1151', cites: ['REF-2883'], citedBy: ['REF-2840', 'REF-2817'],
      });
    });

    it('keeps citation descriptions mentioning related work and paper titles', () => {
      const content = `---
ref: REF-001
---
## Incoming

| REF | Relationship |
|---|---|
| REF-002 | DeLM cites LongMem in Related Work. |
| REF-003 | Agent-evaluation paper that cites this as a related benchmark. |
| REF-004 | Parent source that cites Conditional Memory as an architecture dependency. |
| REF-005 | What If? cites this work in printed reference 3. |
| REF-006 | Topical only; a previous record says cites this work. |
| REF-007 | Not a citation, even though the old row said cites this work. |
| REF-008 | Conditional: if REF-001 is in the benchmark suite. |
| REF-009 | Extracted Conditional Memory citation, printed reference 3. |
`;
      expect(parseCitationSidecar(content)?.citedBy).toEqual(['REF-002', 'REF-003', 'REF-004', 'REF-005', 'REF-009']);
    });

    it('scopes candidate-specific audit notes without disavowing verified tables', () => {
      const content = `---
ref: REF-001
---
# Citation Network

REF-900 is a different paper, topical only.

## Outgoing

Historical records retain topical labels, not verified printed citations.
- REF-901 — thematic connection, not a citation. Original row: \`| REF-901 | related |\`.

| REF | Relationship |
|---|---|
| REF-002 | Cites this work |

## Incoming

Only verified in-corpus citers appear below.
External search results are discovery candidates, not verified citation edges.
<!-- The table below repairs a row formerly filed under relationship notes,
not verified citation rows. -->

| Title | REF |
|---|---|
| Verified bibliography entry | REF-003 |
`;
      expect(parseCitationSidecar(content)).toEqual({ ref: 'REF-001', cites: ['REF-002'], citedBy: ['REF-003'] });
    });

    it('honors whole-table qualifiers even when they name a REF', () => {
      const content = `---
ref: REF-001
---
## Incoming

The connections below are topical within the REF-001 cluster, not citation edges.

| REF | Relationship |
|---|---|
| REF-002 | Similar architecture |
`;
      expect(parseCitationSidecar(content)?.citedBy).toEqual([]);
    });

    it('keeps six-column citations and excludes IDs in titles and locators', () => {
      expect(parseCitationSidecar(fixture('six-column'))).toEqual({
        ref: 'REF-001', cites: ['REF-002', 'REF-003', 'REF-004'], citedBy: ['REF-005'],
      });
    });

    it('recognizes a condition on a REF in the title without rejecting thematic paper titles', () => {
      const table = `
| # | Title | REF |
|---|---|---|
| 1 | Conklin Learning is Forgetting (if REF-828 in 6-benchmark suite) | REF-839 |
| 2 | Thematic Modeling | REF-002 |
| 3 | Conditional Computation | REF-003 |
`;
      expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${table}`)?.cites)
        .toEqual(['REF-002', 'REF-003']);
    });

    it('keeps a verified bibliography when audit prose explains why other candidates were rejected', () => {
      // Minimal REF-2572 shape: its audit note says a .bib-only entry is not a
      // citation. That statement does not disavow the verified table below it.
      const content = `---
ref: REF-2572
---
## Outgoing: Sources This Work Cites

The compiled bibliography contains 512 entries. A .bib-only entry is not a citation;
those candidates are excluded. These are works this paper does not cite.
Other related work was checked if needed.
The compiled keys agree: no entry is uncited and no citation is dangling.

Two candidate matches were rejected: REF-891 and REF-1665 are different papers.

| # | Title | Authors | Year | Venue / DOI / URL | Inducted REF |
|---|---|---|---|---|---|
| 7 | Self-rag | Asai et al. | 2024 | ICLR | REF-1543 |
`;
      expect(parseCitationSidecar(content)?.cites).toEqual(['REF-1543']);
    });

    it.each([['topical', 'REF-1771'], ['relationship-notes', 'REF-834'], ['conditional', 'REF-828']])(
      'does not assert citation edges for the %s fixture', (name, ref) => {
        expect(parseCitationSidecar(fixture(name))).toEqual({ ref, cites: [], citedBy: [] });
      },
    );

    it('preserves real citations beside non-citation rows and tables', () => {
      expect(parseCitationSidecar(fixture('mixed'))).toEqual({
        ref: 'REF-001', cites: ['REF-002', 'REF-003', 'REF-004'], citedBy: ['REF-005', 'REF-1727'],
      });
    });

    it.each(['Outgoing', 'Incoming'])('excludes embedded IDs and invalid rows in %s tables', direction => {
      const content = `---
ref: REF-001
---
## ${direction}

| Topic | Target |
|---|---|
| Notes | See REF-900 |

| Title | Notes |
|---|---|
| Discussion | REF-901 pending |

| Title | Inducted REF (topical) |
|---|---|
| Discussion | REF-902 |

| Title | Inducted REF |
| bogus | separator |
| Discussion | REF-903 |

| # | Title | Inducted REF | Notes |
|---|---|---|---|
| 1 | Actual citation | REF-002 | See REF-904 |
`;
      const result = parseCitationSidecar(content)!;
      expect(direction === 'Outgoing' ? result.cites : result.citedBy).toEqual(['REF-002']);
    });

    it('resolves whole-cell Status IDs without a named resolution column', () => {
      expect(parseCitationSidecar(fixture('status-resolution'))).toEqual({
        ref: 'REF-1540', cites: ['REF-1542', 'REF-1607', 'REF-1608'], citedBy: ['REF-2840'],
      });
    });

    it.each(['topical', 'thematic', 'related', 'conditional', 'non-citation', 'if REF-828 in suite'])(
      'honors %s qualifiers in unnamed resolution tables', qualifier => {
        const table = `| Cited Work | Status | Extra |\n|---|---|---|\n| Work | REF-002 | ${qualifier} |`;
        for (const direction of ['Outgoing', 'Incoming']) {
          expect(parseCitationSidecar(`---\nref: REF-001\n---\n## ${direction}\n${table}`))
            .toEqual({ ref: 'REF-001', cites: [], citedBy: [] });
        }
        if (qualifier.startsWith('if ')) return;
        for (const context of [`### ${qualifier}\n`, '', `Note: ${qualifier} relationships only.`]) {
          const header = context ? 'Extra' : qualifier;
          const qualified = table.replace('Extra', header).replace(qualifier + ' |', 'printed entry |');
          const body = context.startsWith('Note:') ? `${qualified}\n\n${context}` : `${context}\n${qualified}`;
          expect(parseCitationSidecar(`---\nref: REF-001\n---\n## Outgoing\n${body}`)?.cites).toEqual([]);
        }
      },
    );

    it('keeps well-formed decorated historical aliases', () => {
      const content = `---
ref: REF-001
---
## Outgoing

| Title / source | **In-corpus REF / issue** |
|---|---|
| Candidate | [\`REF-007\`](../REF-007.md) / #249 |
`;
      expect(parseCitationSidecar(content)?.cites).toEqual(['REF-007']);
    });

    it('honors a non-citation qualifier declared in the table header', () => {
      const content = `---
ref: REF-001
---
## Incoming

| Title | REF | Relationship notes, not verified citation rows |
|---|---|---|
| Candidate | REF-828 | Similar method |
`;
      expect(parseCitationSidecar(content)?.citedBy).toEqual([]);
    });

    it('inherits section declarations through nested headings and resets sibling scopes', () => {
      const content = `---
ref: REF-001
---
## Outgoing

### Non-bibliographic connections

Topical relationships only.

#### Candidates

| Title | Inducted REF |
|---|---|
| Candidate | REF-828 |

### Verified bibliography

| Title | Inducted REF |
|---|---|
| Citation | REF-002 |
`;
      expect(parseCitationSidecar(content)?.cites).toEqual(['REF-002']);
    });

    it('does not promote trailing-column REFs or override the registered resolution column', () => {
      const table = `
| Title | Inducted REF | REF | Notes |
|---|---|---|---|
| Verified | REF-002 | REF-900 | REF-901 |
| Unresolved | — | REF-902 | REF-903 |
`;
      expect(extractRefsFromTable(table, ['Inducted REF', 'REF'])).toEqual(['REF-002']);
    });

    it.each(['topical', 'thematic', 'related', 'conditional', 'non-citation', 'not a citation', 'not a verified citation', 'unverified', 'if REF-828 in suite'])(
      'skips an explicit %s row qualifier without dropping adjacent citations', qualifier => {
        const content = `---
ref: REF-001
---
## Outgoing

| # | Title | Inducted REF | Notes |
|---|---|---|---|
| 1 | Candidate | REF-828 | ${qualifier} |
| 2 | Verified | REF-002 | printed-entry |
`;
        expect(parseCitationSidecar(content)?.cites).toEqual(['REF-002']);
      },
    );

    it('honors a trailing note disavowing a table', () => {
      const content = `---
ref: REF-001
---
## Incoming

| Title | REF |
|---|---|
| Candidate | REF-828 |

Note: these are not citation edges.
`;
      expect(parseCitationSidecar(content)?.citedBy).toEqual([]);
    });
  });

  describe('rejected-candidate section is not an edge source (#2525)', () => {
    // The citation-sidecar template gained a `## Rejected Candidates` section so a
    // candidate dropped after investigation is recorded rather than silently
    // reintroduced by a later extraction pass. Those rows name REF ids by design —
    // they must never reach the graph, or the record of a rejection would itself
    // fabricate the edge it exists to prevent.
    const sidecar = [
      '---',
      'ref: REF-2539',
      'title: "Probe"',
      'type: citations',
      '---',
      '',
      '## Outgoing: Papers This Work Cites',
      '',
      '| # | Title | Authors | Year | DOI/URL | Inducted REF | Confirmed by |',
      '|---|-------|---------|------|---------|--------------|--------------|',
      '| 1 | GCG | Zou et al. | 2023 | arXiv:2307.15043 | REF-1018 | printed-entry |',
      '',
      '## Rejected Candidates',
      '',
      '| # | Title | Authors | Year | Why rejected |',
      '|---|-------|---------|------|--------------|',
      '| 1 | Representation Engineering | Zou et al. | 2023 | wrong node after author-year disambiguation (REF-233) |',
      '| 2 | Do Anything Now | Shen et al. | 2023 | `.bib`-only, absent from compiled `.bbl` (REF-543) |',
      '',
      '## Incoming: Papers That Cite This Work',
      '',
      '| # | Title | Authors | Year | DOI/URL | Inducted REF |',
      '|---|-------|---------|------|---------|--------------|',
      '| 1 | Later work | Someone | 2025 | arXiv:2501.00001 | REF-9001 |',
      '',
    ].join('\n');

    it('keeps rejected REF ids out of both edge directions', () => {
      const result = parseCitationSidecar(sidecar);
      expect(result).not.toBeNull();
      expect(result!.cites).toEqual(['REF-1018']);
      expect(result!.citedBy).toEqual(['REF-9001']);
      for (const rejected of ['REF-233', 'REF-543']) {
        expect(result!.cites, rejected).not.toContain(rejected);
        expect(result!.citedBy, rejected).not.toContain(rejected);
      }
    });

    it('still reads the Inducted REF column when a Confirmed by column follows it', () => {
      // The template's Outgoing table is 7 columns now. Column lookup is by name,
      // so a trailing column must not shift what gets read.
      const result = parseCitationSidecar(sidecar);
      expect(result!.cites).toContain('REF-1018');
    });
  });

  describe('citationResultToEdges', () => {
    it('should convert cites to upstream edges and citedBy to downstream edges', () => {
      const refToPath = new Map([
        ['REF-029', 'citations/REF-029-citations.md'],
        ['REF-009', 'citations/REF-009-citations.md'],
        ['REF-015', 'citations/REF-015-citations.md'],
      ]);

      const result = {
        ref: 'REF-008',
        cites: ['REF-029', 'REF-009'],
        citedBy: ['REF-015'],
      };

      const edges = citationResultToEdges(result, refToPath);

      expect(edges.upstream).toEqual([
        { path: 'citations/REF-029-citations.md', type: 'cites' },
        { path: 'citations/REF-009-citations.md', type: 'cites' },
      ]);
      expect(edges.downstream).toEqual([
        { path: 'citations/REF-015-citations.md', type: 'cited-by' },
      ]);
    });

    it('should skip refs not in the path map', () => {
      const refToPath = new Map([
        ['REF-001', 'citations/REF-001-citations.md'],
      ]);

      const result = {
        ref: 'REF-008',
        cites: ['REF-001', 'REF-999'], // REF-999 not in index
        citedBy: ['REF-888'],           // REF-888 not in index
      };

      const edges = citationResultToEdges(result, refToPath);
      expect(edges.upstream).toHaveLength(1);
      expect(edges.downstream).toHaveLength(0);
    });
  });

  describe('buildRefToPathMap', () => {
    it('should build map from entries with ref frontmatter', () => {
      const entries = new Map<string, Record<string, unknown>>([
        ['citations/REF-008-citations.md', { ref: 'REF-008', title: 'Paper A' }],
        ['citations/REF-029-citations.md', { ref: 'REF-029', title: 'Paper B' }],
        ['other/document.md', { title: 'No ref' }],
      ]);

      const map = buildRefToPathMap(entries);
      expect(map.size).toBe(2);
      expect(map.get('REF-008')).toBe('citations/REF-008-citations.md');
      expect(map.get('REF-029')).toBe('citations/REF-029-citations.md');
    });

    it('should skip entries with invalid ref format', () => {
      const entries = new Map<string, Record<string, unknown>>([
        ['a.md', { ref: 'INVALID' }],
        ['b.md', { ref: 123 }],
        ['c.md', { ref: 'REF-001' }],
      ]);

      const map = buildRefToPathMap(entries);
      expect(map.size).toBe(1);
    });

    it('should include PROF-* entries (#105)', () => {
      const entries = new Map<string, Record<string, unknown>>([
        ['c/REF-001-citations.md', { ref: 'REF-001' }],
        ['p/PROF-P-marks-samuel-edges.md', { ref: 'PROF-P-marks-samuel' }],
        ['p/PROF-O-anthropic-edges.md', { ref: 'PROF-O-anthropic' }],
        ['p/PROF-X-bogus-edges.md', { ref: 'PROF-X-bogus' }], // rejected
      ]);
      const map = buildRefToPathMap(entries);
      expect(map.size).toBe(3);
      expect(map.get('PROF-P-marks-samuel')).toBe('p/PROF-P-marks-samuel-edges.md');
      expect(map.get('PROF-O-anthropic')).toBe('p/PROF-O-anthropic-edges.md');
      expect(map.has('PROF-X-bogus')).toBe(false);
    });
  });

  describe('isNodeId', () => {
    it('accepts REF-* and all four PROF-* type codes', () => {
      expect(isNodeId('REF-001')).toBe(true);
      expect(isNodeId('REF-1234')).toBe(true);
      expect(isNodeId('REF-434a')).toBe(true);
      expect(isNodeId('PROF-P-marks-samuel')).toBe(true);
      expect(isNodeId('PROF-O-anthropic')).toBe(true);
      expect(isNodeId('PROF-F-open-philanthropy')).toBe(true);
      expect(isNodeId('PROF-G-mech-interp-team')).toBe(true);
    });

    it('rejects malformed and unrelated values', () => {
      expect(isNodeId('PROF-X-bogus')).toBe(false);
      expect(isNodeId('PROF-P-')).toBe(false);
      expect(isNodeId('PROF-PERSON-marks')).toBe(false); // type code must be 1 char
      expect(isNodeId('REF-')).toBe(false);
      expect(isNodeId('REF-abc')).toBe(false);
      expect(isNodeId('INVALID')).toBe(false);
      expect(isNodeId('')).toBe(false);
      expect(isNodeId(null)).toBe(false);
      expect(isNodeId(123)).toBe(false);
    });
  });

  describe('buildIndex integration with citation-sidecar parser', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-citation-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // Clean up any user-defined graphs
      for (const key of Object.keys(GRAPH_CONFIGS)) {
        if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
          delete GRAPH_CONFIGS[key];
        }
      }
    });

    it('should extract citation edges when edgeExtraction is configured', async () => {
      // Setup: .aiwg/config.yaml with citation-network graph
      const aiwgDir = path.join(tmpDir, '.aiwg');
      const citationsDir = path.join(tmpDir, 'documentation', 'citations');
      fs.mkdirSync(aiwgDir, { recursive: true });
      fs.mkdirSync(citationsDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    citation-network:
      scanDirs:
        - documentation/citations
      extensions:
        - .md
      defaultBuild: false
      edgeExtraction:
        parser: citation-sidecar
        edges:
          - type: cites
            source: frontmatter.ref
            target: outgoing-table.inducted-ref
            skipEmpty: true
          - type: cited-by
            source: frontmatter.ref
            target: incoming-table.inducted-ref
            skipEmpty: true
`);

      // Create citation sidecar files
      fs.writeFileSync(path.join(citationsDir, 'REF-008-citations.md'), `---
ref: REF-008
title: "Retrieval-Augmented Generation"
type: citations
---

## Outgoing: Papers This Work Cites

| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 7 | Dense passage retrieval | Karpukhin et al. | 2020 | arXiv:2004.04906 | REF-029 |
| 26 | Neural Turing machines | Graves et al. | 2014 | arXiv:1410.5401 | REF-009 |
| 27 | Topical neighbor | Someone | 2025 | — | — (topical → REF-015) |
| 28 | Conditional neighbor | Someone | 2025 | — | if REF-015 in suite |

| Topic | Notes |
|---|---|
| Similar work | Related REF-015 |

## Incoming: Papers That Cite This Work

### Corpus Cross-References (Internal)

| # | Title | REF | Notes |
|---|---|---|---|
| 1 | Self-Refine | REF-015 | Printed reference |
| 2 | DPR | REF-029 | methodological cousin |

| REF | Relationship |
|---|---|
| REF-009 | related work |
`);

      fs.writeFileSync(path.join(citationsDir, 'REF-029-citations.md'), `---
ref: REF-029
title: "Dense Passage Retrieval"
type: citations
---

## Outgoing: Papers This Work Cites

No inducted references.

## Incoming: Papers That Cite This Work

### Corpus Cross-References (Internal)

| # | Title | REF | Notes |
|---|---|---|---|
| 1 | RAG | REF-008 | Uses DPR for retrieval |
`);

      fs.writeFileSync(path.join(citationsDir, 'REF-009-citations.md'), `---
ref: REF-009
title: "Neural Turing Machines"
type: citations
---

## Outgoing: Papers This Work Cites

No inducted references.

## Incoming: Papers That Cite This Work

### Corpus Cross-References (Internal)

| # | Title | REF | Notes |
|---|---|---|---|
| 1 | RAG | REF-008 | References memory mechanisms |
| 2 | DPR | REF-029 | Printed reference |
`);

      fs.writeFileSync(path.join(citationsDir, 'REF-015-citations.md'), `---
ref: REF-015
title: "Self-Refine"
type: citations
---

## Outgoing: Papers This Work Cites

| # | Title | Inducted REF |
|---|-------|--------------|
| 1 | RAG | REF-008 |
| 2 | DPR | REF-029 |
| 3 | Duplicate DPR | REF-029 |

## Incoming: Papers That Cite This Work

No corpus citations.
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'citation-network', explicit: true });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      // Read the dependency graph
      const indexDir = path.join(tmpDir, '.aiwg', '.index', 'citation-network');
      const deps: DependencyGraph = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8')
      );

      // REF-008 should have cites edges to REF-029 and REF-009
      const ref008 = deps['documentation/citations/REF-008-citations.md'];
      expect(ref008).toBeDefined();
      const citesEdges = ref008.upstream.filter(e => e.type === 'cites');
      expect(citesEdges).toHaveLength(2);
      const citesPaths = citesEdges.map(e => e.path).sort();
      expect(citesPaths).toEqual([
        'documentation/citations/REF-009-citations.md',
        'documentation/citations/REF-029-citations.md',
      ]);

      // REF-008 should have cited-by edge from REF-015
      const citedByEdges = ref008.downstream.filter(e => e.type === 'cited-by');
      expect(citedByEdges).toHaveLength(1);
      expect(citedByEdges[0].path).toBe('documentation/citations/REF-015-citations.md');

      // REF-015 should have a cites edge to REF-008
      const ref015 = deps['documentation/citations/REF-015-citations.md'];
      expect(ref015).toBeDefined();
      const ref015Cites = ref015.upstream.filter(e => e.type === 'cites');
      expect(ref015Cites).toHaveLength(2);
      expect(ref015Cites[0].path).toBe('documentation/citations/REF-008-citations.md');

      const stats = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'stats.json'), 'utf-8'),
      );
      expect(stats.graphMetrics).toMatchObject({
        totalEdges: 4,
        canonicalEdges: 4,
        outgoingDeclarations: 4,
        incomingDeclarations: 4,
        adjacencyEntries: 16,
        unmirroredOutgoing: 1,
        unmirroredIncoming: 1,
      });

      // An incremental rebuild must also discard cached edges from the old
      // permissive extractor even though none of the source files changed.
      ref008.upstream.push({ path: 'documentation/citations/REF-015-citations.md', type: 'cites' });
      fs.writeFileSync(path.join(indexDir, 'dependencies.json'), JSON.stringify(deps));
      await buildIndex(tmpDir, { graph: 'citation-network', explicit: true });
      const rebuilt: DependencyGraph = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8'),
      );
      expect(rebuilt['documentation/citations/REF-008-citations.md'].upstream.filter(edge => edge.type === 'cites'))
        .toEqual(citesEdges);
    });

    it('should extract PROF-* → REF-* edges in citation-network graph (#105)', async () => {
      const aiwgDir = path.join(tmpDir, '.aiwg');
      const citationsDir = path.join(tmpDir, 'documentation', 'citations');
      const profilesEdgesDir = path.join(tmpDir, 'documentation', 'profiles', 'edges');
      fs.mkdirSync(aiwgDir, { recursive: true });
      fs.mkdirSync(citationsDir, { recursive: true });
      fs.mkdirSync(profilesEdgesDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    citation-network:
      scanDirs:
        - documentation/citations
        - documentation/profiles/edges
      extensions:
        - .md
      defaultBuild: false
      edgeExtraction:
        parser: citation-sidecar
        edges:
          - type: cites
            source: frontmatter.ref
            target: outgoing-table.inducted-ref
            skipEmpty: true
          - type: cited-by
            source: frontmatter.ref
            target: incoming-table.inducted-ref
            skipEmpty: true
`);

      // Two REF-* targets
      fs.writeFileSync(path.join(citationsDir, 'REF-803-citations.md'), `---
ref: REF-803
title: "Auditing Hidden Goals"
type: citations
---

## Outgoing: Papers This Work Cites

No inducted references.
`);
      fs.writeFileSync(path.join(citationsDir, 'REF-779-citations.md'), `---
ref: REF-779
title: "Anthropic NLAs"
type: citations
---

## Outgoing: Papers This Work Cites

No inducted references.
`);

      // Profile-edges sidecar with PROF-* source pointing at the two REFs
      fs.writeFileSync(
        path.join(profilesEdgesDir, 'PROF-P-marks-samuel-edges.md'),
        `---
ref: PROF-P-marks-samuel
title: "Samuel Marks"
type: profile-edges
profile-path: profiles/people/PROF-P-marks-samuel.md
---

## Outgoing: Papers this entity authored / is affiliated with

| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 1 | Auditing Hidden Goals via Reasoning Traces | Marks, S. et al. | 2025 | — | REF-803 |
| 2 | Anthropic NLAs | Marks, S. et al. | 2026 | — | REF-779 |
`,
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'citation-network', explicit: true });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      const indexDir = path.join(tmpDir, '.aiwg', '.index', 'citation-network');
      const deps: DependencyGraph = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8'),
      );

      // PROF-P-marks-samuel-edges.md should have cites edges to REF-803 and REF-779
      const profEdges =
        deps['documentation/profiles/edges/PROF-P-marks-samuel-edges.md'];
      expect(profEdges, 'PROF-P-marks-samuel sidecar must be indexed').toBeDefined();
      const cites = profEdges.upstream.filter((e) => e.type === 'cites');
      const citePaths = cites.map((e) => e.path).sort();
      expect(citePaths).toEqual([
        'documentation/citations/REF-779-citations.md',
        'documentation/citations/REF-803-citations.md',
      ]);

      // The two REF targets are also indexed as nodes (no extra assertions
      // about inverse edges — those would require the REF sidecars to list
      // the PROF source in their incoming tables, which is orthogonal to
      // the parser-extension this issue addresses).
      expect(deps['documentation/citations/REF-803-citations.md']).toBeDefined();
      expect(deps['documentation/citations/REF-779-citations.md']).toBeDefined();
    });
  });
});
