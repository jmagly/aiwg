# Citation-sidecar edge fixtures

Minimal downstream table shapes for issue #3186:

- `topical.md`: REF-1771's six-column topical resolutions.
- `relationship-notes.md`: the REF-834 relationship-notes form with the reported
  DeepSeekMath methodological-cousin row.
- `conditional.md`: REF-828's conditional REF-839 relationship.
- `mixed.md`: verified citations beside topical, thematic, conditional and related
  rows, relationship tables, and scoped non-citation headings.
- `two-column-relationship.md`: relationship headers in both directions, including
  citation descriptions and an explicitly topical row.
- `verified-relationship.md`: I-JEPA's verified incoming REF-2840 declaration and
  outgoing relationship descriptions, alongside qualified rows and scoped tables.
- `six-column.md`: positive bibliography forms, decorated IDs, multiple IDs in the
  resolution cell, and unrelated IDs in other columns.
- `ref-016.md` and `ref-1024.md`: incoming/outgoing direction, empty metadata,
  repeated ordinals and tables, and an unresolved title mentioning a REF.
- `status-resolution.md`: whole-cell REF resolution in Status columns, plain,
  linked and backtick-wrapped IDs, embedded mentions and qualified exclusions.
- `header-variants.md`: corpus header aliases and extra metadata columns before
  and after the resolution column.
- `section-headings.md`: Incoming/Outgoing slash and em-dash headings, Cited-by,
  Papers That Cite This Work, References, formal-reference headings, citation
  statements (including `— cites this work`), self-edges, and provenance IDs
  outside the resolution cell.
- `citation-sidecar-contract.json` (research-papers' `citation-sidecar.schema.json`): schema version 1 from research-papers, retained
  as an independent inventory of corpus forms and aliases. Graph extraction uses
  a unique resolution header in Incoming/Outgoing, or whole-cell REF IDs when
  no resolution header exists;
  extra columns and their order do not decide citation semantics.

These fixtures contain synthetic metadata and minimal transcriptions; tests do
not access the downstream checkout.

Supported section headings (case-insensitive, with optional Markdown emphasis,
closing hashes, indentation and tabs):

- `Incoming` / `Outgoing`, with word-bounded descriptions. Corpus variants
  include `Incoming / Corpus Connections`, `Incoming / Corpus Links`,
  `Incoming: Papers That Cite This Work`, `Incoming (selected — corpus REFs that
  cite this paper)`, `Incoming references in this corpus`, `Incoming Citation
  Backlinks Added`, `Incoming Citations`, `Outgoing References`, `Outgoing
  Citations`, `Outgoing Citation Map`, `Outgoing source references`, and
  `Outgoing (selected)`. Their `/`, `—`, `:`, and `(` suffixes retain direction.
- Whole headings or first segments before those delimiters: `Cited-by`,
  `Cited by`, `Papers That Cite This Work`, `Sources That Cite This Work`,
  `Works That Cite This Work` (incoming); `Cites`, `References`,
  `Papers This Work Cites`, `Sources This Work Cites`, `Works This Work Cites`
  (outgoing).
- Exact corpus bibliography headings: `Formal / High-Value References
  Extracted`, `Formal / High-Value References and Benchmarks Extracted`,
  `Formal References Extracted From the Card`, `Formal References Extracted
  From the Addendum / Parent Card`, `High-Value References and Benchmarks`,
  `Foundational External Citations` (outgoing).

`Related work`, `Topical connections`, general corpus connections, audit notes,
and rejected-candidate headings do not declare citations. Explicit qualifiers
still apply inside recognized sections; a resolution labelled `context`,
`family context`, or `adjacent` does not identify a cited artifact.
