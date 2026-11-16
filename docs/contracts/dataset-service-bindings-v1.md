# Qualified dataset service bindings v1

`aiwg dataset <action> ... --binding <selection.json>` explicitly selects a
qualified `DatasetSourceAdapter` / `DatasetExecutionBackend` composition for the
existing orchestration service. Omitting the option preserves the built-in
adapters and local backend. No production preservation connector or native graph
projector ships with this contract.

The contract is `aiwg.dataset.service-binding/v1`. Its canonical authority is
[`service-binding.v1.schema.json`](../../schemas/dataset/service-binding.v1.schema.json),
catalog identity `dataset.service-binding@1.0.0`, owned by `aiwg-maintainers`.
The CLI constructor consumes selections; the registry consumes descriptors.
This additive contract leaves existing dataset contracts and fixtures unchanged.
Future incompatible changes require a new contract major; selection and component
versions are exact, with no automatic upgrade. Component and capability versions
use the same numeric `major.minor.patch` pattern; aliases and ranges are rejected.

## Trusted registration and explicit selection

A trusted installed entrypoint statically imports its implementation and calls
`datasetBindingRegistry.register(descriptor, adapter, backend, backendIdentity)` before invoking
`datasetHandler.execute(context)` or `executeDatasetCommand(context)`. Embedders
can instead supply an isolated `DatasetBindingRegistry` to
`createDatasetCliService(context, registry)`. These APIs are exported from
`src/dataset/index.ts` and `src/cli/handlers/dataset.ts`, respectively.

Registration returns the selection JSON to give the operator:

```json
{
  "contractVersion": "aiwg.dataset.service-binding/v1",
  "kind": "DatasetBindingSelection",
  "id": "example.preservation-native",
  "version": "1.0.0",
  "descriptorDigest": { "algorithm": "sha256", "value": "<64 lowercase hex characters>" }
}
```

The shipped registry starts empty. An installed integration must register its
pair in each process; a JSON file alone cannot install or qualify code. The
selection file is data, and admits only the fields above. There is no module
path, executable, environment lookup, config root, implicit discovery directory,
or dataset-supplied import. Evidence references are descriptive and never loaded.

The trusted entrypoint supplies `backendIdentity: DatasetBindingComponent`
(`id`, `version`, `packageDigest`) from its installed implementation metadata,
independently of the descriptor, and runs qualification on that exact pair.
The registry copies this identity and rejects a descriptor/backend ID, version or
package digest mismatch with typed `DATASET_BINDING_INCOMPATIBLE` errors.
`DatasetExecutionBackend` has no package introspection method; the supplied
identity remains a trusted installation assertion, not computed proof of a
binary. The registry also checks the adapter manifest, package digest, trust,
maturity and supported dataset range, and exact backend capability offers.
A Fortemi bridge must finish `negotiate()` before registration. This
composition API uses the existing service backend boundary; the consolidated
Fortemi MCP execution client has a separate wire contract.

## Descriptor and qualification

A `DatasetServiceBinding` descriptor pins the composition ID/version, dataset
and adapter contract versions, adapter ID/version/package digest and manifest
digest, backend ID/version/package digest, exact capability names/versions,
record/byte/time ceilings, and qualification fixture revision and cells. See the
schema and [descriptor fixture](../../test/fixtures/dataset/bindings/descriptor.valid.json)
for its complete shape. The descriptor digest uses `datasetDigest` canonical
JSON; fixture placeholder digests are schema examples, not usable registrations.

All five distinct qualification cells must pass with evidence references:
admission, capability/version mismatch, cancellation/resume, replay, and receipt
mismatch. Adapter maturity must be qualified or stable and trust must be builtin
or verified. Duplicate registrations, failed or missing cells, incompatible
versions, changed manifests, capability offers and selection digests fail closed.
Qualification assertions come from trusted bootstrap code, never dataset input.

The bounded synthetic fixture exercises package preservation followed by native
graph and membership projection. It requires `package-preservation`,
`native-graph`, and `native-membership`, each at exactly `1.0.0`, as required
capabilities with degradation action `fail`. Those are fixture capabilities,
not claims about a deployed Fortemi server. Local record materialization and
note upsert cannot satisfy them. Capability negotiation occurs in the shared
service at planning and again before ingestion; registration is rechecked at
each selected adapter operation and before backend execution. Resource limits
bound selected reads and cooperative execution signals.
Adapters and backends must honor cancellation/deadlines; synchronous or malicious
implementation code cannot be preempted by this in-process API.

## Plan, checkpoint, and receipt preservation

The service stores the selected composition as the existing execution backend
identity `dataset-binding:<id>@<version>:sha256:<descriptor digest>`. That identity
binds component packages, qualification and bounds into the immutable plan digest.
Plan source revision, adapter/config digest, schemas, capabilities, effect steps,
artifact classes, estimates and approval references retain their existing roles.
The backend wrapper preserves the service's local label for a backend named `local`.
Use the same selection for subsequent operations. A different or absent binding
cannot execute that plan, and an unknown backend never falls through to local.

Cancellation leaves the source's last committed checkpoint untouched. Resume an
atomic cancelled attempt by ingesting the same reviewed plan with a fresh
idempotency key and its required approvals. Exact replay returns the recorded
attempt. The Fortemi bridge forwards the prior checkpoint and checks the returned
receipt's digest, plan ID/digest, outcome and counts against the execution result.
Only a committed result can supply the run's new checkpoint. Checkpoint adapter,
source identity and schema must match. Existing receipt `checkpointBeforeId` and
`checkpointAfterId` fields contain `checkpoint:sha256:<checkpoint digest>` for
selected bindings. Verification re-derives the before-checkpoint ID from the
source snapshot bound by the stored plan's source ID, revision and identity;
that snapshot must remain available and unchanged for verification. A changed
source snapshot fails verification. It compares the before-checkpoint exactly,
including its required presence when the source has a checkpoint. A committed
run checkpoint requires an exactly matching after-checkpoint ID. Rewritten or
stripped IDs fail even when the receipt digest has been recomputed. The shared
receipt remains digest-bound to the plan, and lineage retains source revision
and checkpoint references.

## Schema and verification brief

This schema governs exchanged selection data and trusted registration descriptors.
Its runtime/type projections live in `service-binding-contract.ts`. Valid and
invalid fixtures are registered in the dataset schema catalog; unit tests check
strict schema validation, runtime projection parity and catalog resolution. The
binding tests exercise real CLI construction, file persistence, exact capability
failure, bounded cancellation/resume, replay, resource excess and independently
checksummed receipt mismatches. Existing dataset unit and conformance lanes remain
the regression oracle.

Fixture success is not deployment acceptance. Production source preservation,
native graph semantics, durability, installed package identity, authorization and
server guarantees require acceptance in the target deployment. This feature
neither extends server capability offers nor promotes fixture evidence to a
deployment or maturity claim.
