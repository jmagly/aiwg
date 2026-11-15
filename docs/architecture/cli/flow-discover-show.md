# Flow: `aiwg discover` → `aiwg show`

[Architecture](index.md) · [Discovery internals](discovery.md)

Discovery ranks candidates; showing one fetches its metadata card and optional
instruction body. These are separate CLI invocations. Use stable IDs from results
when names are ambiguous.

```mermaid
sequenceDiagram
  actor A as Operator or harness
  box Local CLI boundary
    participant R as Router and discovery handlers
    participant Q as Artifact CLI and query engine
    participant S as Scoring and facet fusion
    participant B as Rule relationships
    participant V as Show card renderer
  end
  box Resource storage boundary
    participant I as Framework and project graphs
    participant F as Artifact source or verified web bytes
  end
  A->>R: discover phrase
  R->>R: initRouter(discoveryOnly=true)
  R->>Q: discoverHandler.execute → main(discover, args)
  Q->>I: discoverCapability; select sources, refresh eligible graphs
  I-->>Q: metadata, provenance and relations
  Q->>S: scoreEntryDetailed; facet fusion, sort and deduplicate
  S-->>Q: top candidates
  Q->>B: governing rule descriptors and statistics for results
  B-->>Q: rule obligations and ordering
  Q-->>A: emitDiscoverResults with stable IDs and drill-in hints
  A->>R: show skill name or stable ID
  R->>Q: showHandler.execute → main(show, args)
  Q->>I: showArtifact → loadShowEntries; findShowMatches
  I-->>Q: matches and relation reader
  alt Multiple matches without --first
    Q-->>A: ambiguity list, exit 2
  else One selected artifact
    Q->>F: resolveMetadataPath and read body
    F-->>Q: content bytes
    Q->>B: showBindings; resolve required rules
    B-->>Q: bindings and optional rule bodies
    Q->>V: emitShowCard(content, params, bindings)
    V-->>A: metadata by default; section/body on request
  end
```

Drawn from:

- [`src/cli/router.ts`](../../../src/cli/router.ts): `initRouter`, `run`.
- [`src/cli/handlers/subcommands-discovery.ts`](../../../src/cli/handlers/subcommands-discovery.ts): `discoverHandler.execute`, `showHandler.execute`.
- [`src/artifacts/cli.ts`](../../../src/artifacts/cli.ts): `main`.
- [`src/artifacts/query-engine-discover.ts`](../../../src/artifacts/query-engine-discover.ts): `discoverCapability`.
- [`src/artifacts/query-engine-discover-output.ts`](../../../src/artifacts/query-engine-discover-output.ts): `emitDiscoverResults`.
- [`src/artifacts/query-engine-scoring.ts`](../../../src/artifacts/query-engine-scoring.ts): `scoreEntryDetailed`.
- [`src/artifacts/discover-facets.ts`](../../../src/artifacts/discover-facets.ts): `applyFacetFusion`.
- [`src/artifacts/query-engine-show.ts`](../../../src/artifacts/query-engine-show.ts): `showArtifact`.
- [`src/artifacts/query-engine-show-load.ts`](../../../src/artifacts/query-engine-show-load.ts): `loadShowEntries`, `resolveMetadataPath`.
- [`src/artifacts/query-engine-matching.ts`](../../../src/artifacts/query-engine-matching.ts): `findShowMatches`.
- [`src/artifacts/query-engine-rules.ts`](../../../src/artifacts/query-engine-rules.ts): `compoundGoverningRules`, `showBindings`.
- [`src/artifacts/query-engine-show-card.ts`](../../../src/artifacts/query-engine-show-card.ts): `emitShowCard`.

Default capability search covers framework and project graphs; explicit graph
selection and legacy fallbacks change the source set. `show` can fall back to the
local corpus for missing indexed content. Web bodies use verified release resources
rather than treating an index path as an arbitrary URL.

Fetch governing rules with `aiwg show skill <name> --rules --with-rule-bodies`,
then retrieve `--body` or a specific `--section`. The ranking summary is not the
full rule or skill instruction. The prompt-time variant is [bounded and read-only](flow-prompt-discovery.md).
