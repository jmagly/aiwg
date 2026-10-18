# Compound Memory operator guide

Compound Memory remains independently supported. Dataset Intelligence may
register source/run evidence, but does not replace promotion, review, bounded
context, or maintenance semantics. See the [dataset migration
guide](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/dataset-intelligence/docs/migration-guide.md).

## Activate

```bash
aiwg use compound-memory --provider <provider>
aiwg compound-memory status --json
```

Activation deploys line-memory and llm-wiki dependencies first. The driver is
portable (`platforms: [all]`) and its CLI registry is provider-neutral.

## Pattern mapping

| Pattern | AIWG path or command |
|---|---|
| raw | `.aiwg/wiki/raw/`; `compound-memory ingest` |
| wiki | `.aiwg/wiki/`; semantic-memory `memory-ingest` |
| bounded memory | `.aiwg/memory/line-memory.txt` plus sidecar |
| retrieve/use | `compound-memory context` |
| output | project artifact plus `.aiwg/memory/output-registration/` |
| context/identity | `.aiwg/context/compound-memory/`; `compound-memory update` |
| review | `compound-memory review` and exact-version sessions review |
| maintain | `compound-memory maintain` preview/confirm |

## Routine cycle

1. Preview and confirm intake; run the routed sessions or llm-wiki workflow.
2. Review candidates independently, then promote to wiki and/or line-memory.
3. Build a bounded context pack for the task.
4. Register outputs with that pack and its source lineage.
5. Review any extracted insight before a durable update.
6. Inspect review signals and run the deterministic maintenance preview.

## Migration

Standalone line-memory and llm-wiki paths are already canonical. Back them up,
activate the addon, then run status and a mutation-free context inspection:

```bash
cp -a .aiwg/memory/line-memory.txt .aiwg/memory/line-memory.txt.pre-compound
cp -a .aiwg/memory/line-memory.meta.json .aiwg/memory/line-memory.meta.json.pre-compound
cp -a .aiwg/wiki .aiwg/wiki.pre-compound
aiwg use compound-memory --provider <provider>
aiwg compound-memory status --json
aiwg compound-memory context "migration verification" --no-touch --json
```

No data rewrite is required. Activation adds orchestration metadata and leaves
the underlying stores independently readable.

## Rollback

Disable/remove the compound-memory deployment through the normal addon removal
workflow. Do not remove line-memory or llm-wiki. If verification found a
pre-existing store problem, restore only from the explicit backups above after
preserving the failed state for diagnosis. Output registrations, canonical
context receipts, and intake receipts are additive audit data and may remain.

## Gates

- Hard context bound: configured total, never exceeded.
- Local 1,000-file fixture: p95 below 250 ms.
- Retrieval precision and recall: at least 0.90 on the checked-in fixture.
- Every mutation: exact preview plus receipt.
- Release smoke: add-on activation, seven-command registration, TypeScript,
  schema, standalone line-memory, and llm-wiki regression tests.
