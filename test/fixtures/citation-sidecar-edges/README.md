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
- `citation-sidecar.schema.json`: schema version 1 from research-papers, retained
  as an independent inventory of corpus forms and aliases. Graph extraction uses
  a unique resolution header in Incoming/Outgoing, or whole-cell REF IDs when
  no resolution header exists;
  extra columns and their order do not decide citation semantics.

These fixtures contain synthetic metadata and minimal transcriptions; tests do
not access the downstream checkout.
