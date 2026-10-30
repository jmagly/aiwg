# Gates capability phase 1 core

Experimental, default-off reusable evaluation gates (epic #2824, issues #2826,
#2827, #2828). The gates *evaluator* is default-off: no decision-runtime path
evaluates gate packs, so existing behavior is unchanged. The decision runtime
does reuse the moved statistics and digest helpers under `src/gates/stats/`
(`quality.ts`, `release.ts` and `gate-evidence.ts` import them); those helpers
are numerically identical to the pre-move implementations.

## What exists

- `schemas/gates/GatePack.v1alpha1.schema.json`,
  `GateBinding.v1alpha1.schema.json`, `GateReport.v1alpha1.schema.json`
  (closed, draft 2020-12, cataloged in the decision domain). Conformance
  fixtures live in `test/conformance/gates-v1/fixtures/`, including invalid
  binding/report fixtures for fail-closed conformance vectors.
- `src/gates/`: Ajv schema validation (`schema.ts`), namespace registry with
  `extends` monotone-tightening proofs and binding resolution (`registry.ts`),
  a pure deterministic evaluator (`evaluate.ts`), digest-bound report
  validation (`report.ts`) and five core metric providers (`providers/`),
  including `decision.screening/v1` (SDLC evidence-screening proportions with
  the staged-calibration attestation) behind the shipped
  `aiwg:decision-engine/absolute-screening` pack.
- D29 is the first migrated study (#2833): preregistered absolute bindings
  (`d29-synthetic-v6/v7-absolute-gates`, HOLD ceiling) evaluated through
  `evaluateGates` with project floors, a holdout seal and sealed upstream
  integrity. See [the D29 study](d29-heldout-study.md).
- D17 thresholds now use bindings (#2835), preserving each historical diagnostic
  case and an independent never-PROMOTE ceiling. See the
  [D17 parity and artifact disposition](d17-gate-binding-disposition.md).
- `src/gates/providers/loader.ts` (#2831 rework, experimental default-off):
  addon/extension bundle providers declared in the bundle manifest
  (`gateProviders`, Zod in `src/extensions/manifest.ts`) run ONLY in a
  permission-restricted child process over a pinned snapshot of the whole
  provider directory (static relative `.mjs` only; bare/external imports
  forbidden in phase 1), authorized by the project-config `gates.providers`
  allowlist — in-bundle reviews are informational only — with an explicit
  `allowBundleProviders` opt-in and no environment activation. Bindings pin
  the input-records digest per provider section; evaluation re-runs the
  pinned provider over the pinned records and uses the re-run output
  (caller-asserted provider metrics are never accepted). See
  [bundle providers](gate-providers.md). The fixture extension
  `test/fixtures/gates-example-extension/` ships one reviewed example.
- `src/gates/stats/`: the statistics moved out of
  `src/decision/qualification/quality.ts` (Wilson, Newcombe-10/Tango, seeded
  percentile bootstrap, non-inferiority, frozen-split helpers) plus the new
  exact Clopper-Pearson interval. `quality.ts` re-exports every moved symbol,
  so existing consumers are untouched.

## Gate kinds (closed set, v1alpha1)

`interval-bound` (wilson, clopper-pearson), `paired-difference`
(non-inferiority, superiority via newcombe or tango), `bootstrap-bound`
(seeded), `count-max`, `count-min`, `value-threshold`, `minimum-n`,
`evidence`, `predicate` (three-valued `DecisionPredicate`; `unknown` is
insufficient), `upstream-ceiling` (eval-integrity allowlist).

Per-gate outcomes come from the gate's own `onFail` (HOLD or ROLLBACK,
never PROMOTE) and `onInsufficient`, which is always HOLD (insufficient
evidence holds; only an observed blocking failure rolls back) and
combine on PROMOTE < HOLD < ROLLBACK with the upstream ceiling and the
binding ceiling; the maximum never upgrades any component. `upstream-ceiling`
gates mirror the trusted upstream verdict exactly (compromise rolls back,
allowlist problems hold, clean promotes) and never escalate it.
References (`always-review`, `always-predict`,
`pinned-baseline`) are reported, never gating, unless a `paired-difference`
gate names one in `vs` (the contrast is still evaluated from the paired
observation; the name documents which arm it was paired against).

Interval levels are two-sided confidence levels applied to one-sided bounds:
the reported bound is the one-sided edge of a two-sided interval, which is
conservative (wider) relative to a one-sided interval at the same level.

## Registry rules

Namespaces `aiwg:`, `framework:`, `addon:`, `extension:`, `project:`. An
`aiwg:` rest-path can never coexist with the same rest-path from any other
namespace, whichever registers first. A rest-path shared by two non-`aiwg:`
namespaces is `ambiguous` and resolves only by full id; bindings always pin
full ids, so they never hit ambiguity. `extends` is a full pin
`{id, version, digest}` over the parent's authored bytes, and every binding
and report additionally pins the digest of the composed (extends-resolved)
pack, so a loosened parent always moves the child's composed digest and
breaks old pins. A child may only tighten: thresholds move in their declared
direction (a literal threshold may never be rewritten as a bindable
parameter, and parameters may never be renamed), `minimumN` and `levelBps`
only rise (both accept a literal or a `{param}` reference to a `count` /
`level` parameter; a literal may never be rewritten as a reference, references
may never be renamed, and an unresolvable reference holds as
`parameter-missing`), `onFail` only HOLD-to-ROLLBACK while `onInsufficient` is always
HOLD (a ROLLBACK there is a load error), scope changes only when monotone
per kind (`listed` may only widen, `pooled` sets are fixed, `listed -> each`
widens to the inventory minus exceptions that must exclude none of the
parent's listed slices, `all -> each` only for `count-min`/`minimum-n` with
no exceptions; every other cross-mode change is rejected), `floor: true`
gates cannot be removed or un-floored. Removing a non-floor gate is allowed.
Unknown kinds, metrics,
providers, parameters, slices and reason codes fail at load; missing values
are `insufficient`, never PROMOTE. `except` is honoured only by `each` and
is a load error with any other mode.

## Evaluation contract

`evaluateGates({ binding, registry, trustedBindingDigest, holdout, metrics,
upstream, now, floors, attestation })` is deterministic with an injected
clock; for core-only bindings it performs no I/O. `floors` is required: pass
`resolveProjectFloors(config)` or `'none-explicit-opt-out'` (tests/legacy
only, with a documented reason); an `undefined` floors input refuses
evaluation. The report records the applied floors digest, or the explicit
opt-out marker, and report validation re-derives the distinction. Bindings
with bundle-provider pins additionally trigger one synchronous isolated
re-run per provider (`providerRuntime` input, records digesting to the pin;
the re-run output replaces caller-asserted sections, absent coverage
refuses). When the resolved binding observes any `upstream-ceiling` gate
(including the default floor's), a null `upstream` refuses evaluation
instead of downgrading to HOLD. `attestation: 'offline-cli'` labels
CLI-produced reports; library reports omit it and stay byte-identical.
`registry` must be a `GateRegistry` (duck-typed `{resolveBinding}` objects
are rejected). The binding is resolved internally through the pure
`resolveGateBinding` over a standalone snapshot of the registry's authored
packs — `composeGatePack`/`applyGateExtends` carry the `extends`
tightening semantics, and no overridable `GateRegistry` instance method is
called for anything security-relevant, so a subclass that overrides
`resolveBinding` cannot empty gates, loosen parameters or forge digests.
Pack pins (authored and composed digests are both re-derived by the
evaluator itself from authored packs plus the `extends` chain), provider pins
and `<packId>.<param>` namespaced parameters are re-derived inside the
evaluator — never trusted from registry-provided `resolved`/`parameters` —
and no caller-supplied resolution object is accepted. Binding, provider and
upstream pins are reserved and fully validated before any gate observes any
metric. Parameter values are preregistered in the binding itself: a looser
value is a new binding with a new digest (and, after holdout access, a new
study version), never a silent bypass (P7 binding freedom). A child that
drops a parent parameter default, making the parameter required, is
equivalent to this freedom: the binding must then supply the value, and any
value within the parameter's type range verifies. Project floors
(`aiwg.config` `gates`, #2832) are the check for binding-level minima: a
binding parameter value that loosens a floor minimum is refused at
resolution. Every provider used by
any gate metric must be pinned, and every metric section consumed must be
pinned; unpinned sections are refused. `holdout` is a sealed
`sealGateHoldout({ frozenDigest, firstAccessedAt })` record from the
HeldoutFrozen / first-access record, never a binding field (the binding's
`holdoutAccessedAt`, where present, is ignored): the seal (`digest` over
`{frozenDigest, firstAccessedAt}`) is re-derived on every use, following
`readHeldoutFrozen`, so a spread-copied or edited record is refused. The
seal is an unkeyed integrity digest, not an authenticity proof: any caller
can compute one, so `holdout` is a trusted caller input in the same trust
class as `trustedBindingDigest`. Callers must build it from the held-out
collector's verified HeldoutFrozen and access records. The shipped
`evaluateGatesFromHeldoutFrozen` / `sealGateHoldoutFromFrozen` entry points
in `src/gates/heldout.ts` verify the frozen bundle, pinned analysis and signed
first-access record before deriving those inputs; see
[the HeldoutFrozen boundary](heldout-gate-boundary.md). A
missing or unsealed record, a seal mismatch, a frozen-record digest mismatch,
or a freeze at or after first access refuses evaluation. `firstAccessedAt`
may be null only when the binding declares no held-out split (no
`splitDigest`/`corpusDigest`/`goldDigest`); a null record on a split binding
refuses. The report records the sealed holdout (`digest`, `frozenDigest`,
`firstAccessedAt`), and `validateGateReport` checks it plus a byte-identical
re-derivation. `sealUpstream` binds an integrity report by digest; the digest
is re-derived on every use. `validateGateReport` re-runs the evaluator from
the same trusted inputs and requires a byte-identical report.

Paired observations whose counted support disagrees with their cell sums, and
proportion observations with events above `n`, are `insufficient`, never
trusted. An `each` gate whose exclusions cover the whole inventory is a load
error when statically determinable and `insufficient` otherwise, so no gate
ever PROMOTEs vacuously. `sliceGroups` on a binding is validated against the
slice inventory but never gates (pooled-of group references are deferred).

## Project floors (`aiwg.config` `gates`, #2832)

Experimental, default-off project policy over the core above. The `gates`
section of `.aiwg/aiwg.config` holds `floors` (inline `project:` GatePacks
and/or pins over registered packs whose composed gates all become floors)
and `ceilings`: exact binding `metadata.id` keys plus `'*'` as the
project-wide default applied to every binding (a per-study key may only
tighten the `'*'` default; renames never inherit). Any per-study key
requires the `'*'` default: without it a renamed study would silently
escape every ceiling, so config validation flags it (R1), and
`resolveProjectFloors` and binding resolution refuse it too, so floors
handed in without validation cannot carry a starless or loosening
per-study ceiling. The section may
also hold `providers`, the bundle-provider allowlist (P3 trust root; see
[bundle providers](gate-providers.md)). Inline floor packs
validate against the closed GatePack schema at config load; pack-reference
versions and authored digests are verified at resolution and composed
through the pure `extends` chain, so a loosened parent moves the composed
digest and breaks the pin. Every floor gate that binds a threshold,
`minimumN` or `levelBps` parameter must declare a default for it: the default
is the enforced minimum. An inline floor gate with id `integrity-ceiling` must be an
all-scoped `upstream-ceiling` gate, or config validation flags it.

Resolution refuses a binding that omits a floor gate or loosens any floor
gate's threshold, parameter value, scope or outcome, reusing the per-kind
`assertGateTightens` validator and the scope-superset rule. Binding threshold,
`minimumN` and `levelBps` parameters are resolved to their preregistered
values before comparison, so the check is value-against-minimum in the gate's
declared direction. A
binding whose ceiling sits below its configured ceiling (per-study key, else
the `'*'` default) is refused; tighter ceilings resolve.
`resolveGateBinding` and `GateRegistry.resolveBinding` take floors as a
trusted input loaded from `aiwg.config` by the caller
(`resolveProjectFloors`), in the same trust class as
`trustedBindingDigest` and the sealed holdout record: pins and composition
are re-derived, never trusted. `evaluateGates` requires it (see above).

The operator default floor is the shipped
`aiwg:decision-engine/integrity-ceiling` pack itself — the single source of
truth — applied at expansion time (`expandFloorPacks`), never an inline
copy. It is suppressed only by a configured floor gate with id
`integrity-ceiling` that is an all-scoped `upstream-ceiling` gate tightening
the shipped gate (floor flag included, proven by `assertGateTightens`). A
same-id gate of any other kind or scope never suppresses the default; the
binding must then satisfy both, which fails closed with a diagnostic. There
is no silent opt-out: a project that configures floors without governing the
ceiling keeps the default ceiling. Invalid `gates` sections warn (non-fatal)
at `readAiwgConfig` time so unrelated commands keep working, and fail closed
in gates entry points (`aiwg gates evaluate`, binding resolution with
floors); `writeAiwgConfig` stays strict so bad policy is never persisted.

Example (every decision study observes the integrity ceiling and caps the
false-ready rate; study `d29-synthetic-v8` can never promote):

```json
{
  "gates": {
    "floors": [
      { "packRef": { "id": "aiwg:decision-engine/integrity-ceiling", "version": "1.0.0", "digest": "sha256:<pack-digest>" } },
      { "pack": {
        "apiVersion": "gates.aiwg.io/v1alpha1", "kind": "GatePack",
        "metadata": { "id": "project:study-floors", "version": "1.0.0", "description": "Project false-ready floor." },
        "spec": {
          "metrics": { "false-ready": { "provider": "decision.screening/v1", "kind": "proportion" } },
          "gates": [
            { "id": "false-ready-upper", "kind": "interval-bound",
              "metric": { "provider": "decision.screening/v1", "name": "false-ready" },
              "statistic": { "kind": "interval-bound", "method": "wilson", "bound": "upper", "levelBps": 9500 },
              "threshold": { "op": "lte", "value": 100 },
              "scope": { "mode": "all" }, "direction": "lower-is-stricter", "onFail": "HOLD" }
          ]
        }
      } }
    ],
    "ceilings": { "d29-synthetic-v8": "HOLD" }
  }
}
```

## Digest migration (#2828)

`FrozenBinaryBenchmarkPlan` and qualification release builders now emit
`/v2` records with canonical-JSON digests. Verification is canonical-only by
default: a legacy (`JSON.stringify`) digest on a freshly built v2 record
never verifies, even under an explicit allowlist. The `/v1` schema lineage
is the pre-migration lineage, so `quality.ts`, `release.ts`,
`gate-evidence.ts` split plans and feature-export release records keep an
explicit version-gated legacy allowlist: `v1` verifies legacy only when the
caller passes `{ digestModes: ['canonical', 'legacy'] }`, and `v2` intersects
any caller allowlist with canonical-only. Existing v1 evidence still verifies
under the allowlist; every other verifier defaults to canonical-only.

## Discovery, manifest and CLI (#2830)

Experimental, default-off and offline-only. `gate-pack` is on the
`aiwg discover`/`aiwg show` operational surface (`src/artifacts/types.ts`,
`parseGatePackDoc` in `src/artifacts/index-builder.ts`, corpus fallback in
`src/artifacts/query-engine.ts`). Only `*.gatepack.yaml|yml|json` files
classify: HITL `gates/*.yaml` (agent-persistence) never becomes a
`gate-pack`, and schema-invalid packs are undiscoverable. `aiwg show
gate-pack <id>` accepts the full id, the rest-path or the short pack name.

Bundles declare packs with the `gatePacks`/`entry.gatePacks` manifest fields
(`src/extensions/manifest.ts`: addon/extension lists plus framework support)
and ship them as `<bundle>/gate-packs/*.gatepack.yaml|json` (never `gates/`).
`src/gates/discovery.ts` loads and registers them: shipped packs as
`aiwg:<bundle>/<name>`, project-local bundles under their own
`framework:`/`addon:`/`extension:` namespace. The manifest's
`entry.gatePacks` dir is validated as a safe relative path and contained by
realpath (traversal and symlink escapes are load errors); listed files are
lstat-checked (symlinks rejected, regular files only, 256 KiB cap enforced
before reading). Invalid packs are rejected at load with a file-pathed
diagnostic and never enter the `GateRegistry`.

`aiwg gates` (`src/cli/handlers/gates.ts`, `src/gates/driver.ts`) is pure
and offline, with explicit trust boundaries:

- Single files and bundle directories passed via `--pack-dir` are always
  `project:` packs: an `aiwg:` (or `addon:`/`framework:`/`extension:`) id
  claimed through an unverified path is rejected, and a `--pack-dir`
  manifest claiming a shipped (`<aiwgRoot>/agentic/code/…`) or installed
  project (`.aiwg/…`) bundle id that is not its own directory refuses
  (impersonation). Symlinked `--pack-dir` bundle directories refuse.
  Those namespaces load only from the installed tree (`aiwg:`, resolved
  from the package location, never the cwd). Path substrings are never
  consulted.
- An explicit `--aiwg-root` override is untrusted: `list`/`show`/`validate`
  still inspect it, but `evaluate` refuses it.
- `validate <pack|binding|report> <path>` schema-checks plus pack semantics
  (`validateResolvedPack`) and binding resolution; invalid files report
  `valid: false` (exit 2) instead of throwing. Binding validation resolves
  with the config floors from the cwd, exactly like evaluation: a binding
  that loosens project policy is invalid.
- `evaluate --binding <file> --metrics <file> --holdout <file>
  [--upstream <file>] --now <iso> --trusted-binding-digest <sha256>`
  re-derives pack, provider, binding and seal digests inside the evaluator
  and prints the `GateReport` JSON. The binding digest is caller-asserted
  (never self-derived); holdout and upstream files must already carry their
  sealed digests (auto-sealing refused); `--upstream` is required whenever
  the binding observes an `upstream-ceiling` gate. A breached threshold
  never promotes; upstream `HOLD`/`ROLLBACK` is never upgraded; forged
  holdout/upstream seals are refused. Project floors load from
  `.aiwg/aiwg.config` in the cwd (unreadable or invalid config refuses
  evaluation). Printed reports carry `attestation: 'offline-cli'`.
- `show <id>` prints the resolved pack with authored and composed digests.
- `list [--namespace <ns>] [--rule [<rule-id>]]` lists registered packs.
  `--rule` adds rule coverage rows; a rule id filters both rows and referenced
  packs. Use the exact filename slug or source-relative path to select a rule.
- `coverage [--rule <rule-id>] [--json]` lists each rule with its enforcing
  gate references, or `guidance-only` when none are declared. Text is the
  default; `--json` returns the same rows as structured data. It scans shipped
  bundle rules, project `rules/` and `.aiwg/rules/`, project bundle rules, and
  rules beside explicitly supplied `--pack-dir` bundles. Documentation indexes
  and compact `.core.md` bodies are excluded. Invalid declarations fail.

Rules may declare an optional list of full gate references:

```yaml
enforcedBy:
  - aiwg:decision-engine/absolute-screening#false-support-upper
```

The existing rule activation schema validates the list shape; rule lint resolves
each full pack id and gate id through the composed gate registry. Unknown packs
or gates fail lint. Omitted or empty lists mean guidance-only. A declaration
does not execute gates, enable a binding, or change activation delivery.
Coverage describes the named check's scope, not proof that the entire rule is
mechanically enforced everywhere. For example, the citation-policy and
executable-feedback mappings cover D29 held-out screening only.

The decision-engine addon ships
`agentic/code/addons/decision-engine/gate-packs/integrity-ceiling.gatepack.yaml`
(`aiwg:decision-engine/integrity-ceiling`, one `upstream-ceiling` floor gate)
so discovery has a real entry; it validates and registers.

## Human checkpoints and GatePack

HITL, WorkflowGate and OpsGate remain separate contracts from GatePack (#2841).
They describe human checkpoints and workflow coordination; GatePack evaluates
evidence and emits advisory outcomes. A flow may pair a human checkpoint with
a GateBinding, but a GateReport does not grant human approval or authorize an action.

The HITL authority is
`agentic/code/frameworks/sdlc-complete/schemas/flows/hitl-gate.yaml` (JSON Schema
draft 2020-12 serialized as YAML). Reference templates, SDLC gate instances and
cost-model notes live beside it in `hitl-gate-examples.yaml`. IDs accept uppercase
hyphen-separated segments, preserving both `GATE-C2I` and the existing
`GATE-AP-RECOVERY`, `GATE-AP-FALSE-POSITIVE` and `GATE-AP-DESTRUCTIVE` identities.
`npm run lint:schemas` strictly compiles the authority and validates the shipped
instances and partial templates; the persistence regression suite also checks
runtime IDs and packaged copies. These checks validate configuration, not runtime
approval enforcement.

## Authoring gate packs

To write a pack, link rules with `enforcedBy`, or run `aiwg gates coverage`,
see [the gate-pack authoring guide](gate-pack-authoring.md). A minimal valid
example is `test/fixtures/gates/example-extension-pack/example-counter.gatepack.yaml`.

## Pending (not in this phase)

Live Jev calls, real held-out data, human reviewers and production rollout:
addon/extension provider loading exists only as the experimental,
default-off isolated runner with config-allowlist trust and records
reproduction (#2831 rework; CLI re-runs from a records file are still
pending) — D29, D23 and D17 use bindings (#2833/#2834/#2835, offline
only). The discovery relevance fixture covers the
shipped integrity-ceiling pack plus the `coverage-floor` conformance fixture
pack (`test/conformance/gates-v1/fixtures/`); live discovery ranking against
a full index is not asserted. No live criterion is met; the harness above is
what those phases build on.
