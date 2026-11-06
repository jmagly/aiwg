# CLI checkpoint record schema brief

`aiwg checkpoint` persists a resume position as either
`checkpoints/<id>.json` or `checkpoints/<id>/checkpoint.json` beneath the
configured artifact root. This is distinct from the agent-loop workflow
checkpoint (`aiwg:schema:e3cc285a7e0b8827`) and effect ledger checkpoints.

The canonical authority is
`schemas/artifacts/checkpoint-record.v1.schema.json`, with catalog identity
`https://aiwg.io/schemas/artifacts/checkpoint-record.v1.schema.json`, logical
name `schemas.artifacts.checkpoint.record.v1`, version `1.0.0`, and owner
`schema-artifacts`. It is registered in the existing `control-plane` domain manifest, listed by
`schemas/catalog/catalog.json`, keeping ownership and fixture metadata out of
the generated catch-all domain.

Consumers are `checkpoint-handler` (create/list/recover) and
`checkpoint-handoff` (handoff document and record persistence). Both validate
through the shared catalog-backed `SchemaValidator` before writing; loading
validates before any saved field is used. No remote resolution is needed.

Compatibility is additive and backward compatible with records written by
2026.11.1: no version discriminator or handoff fields become required.
The original required fields remain `id`, `createdAt`, `cwd`, and `artifacts`.
Optional handoff document paths must be nonblank and supplied together.
The schema declares every writer field and rejects undeclared properties.

Valid and invalid fixtures are registered in the domain manifest. Handler
tests validate each fixture through the runtime projection, load the 2026.11.1
fixture alongside a handoff, and check both write boundaries. The handwritten
`Checkpoint` interface is a type projection in `checkpoint-record.ts`; it is
shared by both writers. Runtime validation of their serialized output and all
fixtures verifies that projection. There are no schema mirrors or generated
copies. Run `npm run lint:schemas` for strict compilation and the checkpoint
handler tests for fixture and persistence checks.
