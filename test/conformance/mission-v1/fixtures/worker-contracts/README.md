# Frozen worker contracts — B-OG-01 / #2876

This is the S1 **direct/shared fixture checkpoint**, based on the read-only
multi-cli-orchestration proposal dated 2026-10-07: delivery plan B-OG-01,
configuration spec §§2–5 and test strategy T-OG-01/08/14/15/17/19 (Revision 2
Tier 0 packs). The latest source includes optional Revision 3 health definitions;
historical five-feature dispatch records and six-feature records both have shape
vectors. S1 health-to-lease and Mission reconciliation mapping is frozen as
pure codec vectors by #2916 (B-OG-54); managed scheduler/MC enforcement is
not implemented here. #2925 additively amends parallelism and worker-selection fragments for groupTemplates/template, group effort/data ceilings and constrained baseRole aliases; manifest digests are refreshed and strict exact-match assertions remain unchanged. Direct/shared coverage is partial; managed protocol role vocabulary and MCP transport are unchanged.

The fragment files are verbatim JSON contracts from configuration spec §4/§5.1.
They have **no new published schema IDs**. After #2878, #2879 and #2880, the
conformance helper reads all five production owners directly. IDs, dialects,
closed objects and unrelated extensions remain preserved. `manifest.json` binds
each fragment to its source section,
existing owner, merge location and SHA-256. Tests never need the gitignored
proposal, vendor CLIs, credentials, account data, inference or managed services.

The planned command/tool descriptors are executable **input and output schema
fixtures**, not registered handlers or an advertisement that proposed flags work.
`worker-resolve` and `worker-invoke` are distinct from the unchanged, session-bound
`mission-dispatch`. Invocation accepts a typed resolved invocation and direct
brief, rejects preparatory input and top-level raw command/server/verification properties,
and returns worker claims separately from observed execution. Schema validation
cannot prove expiration, authorization, path containment, exact artifact identity,
profile qualification or cancellation; their consumer boundaries remain owned by
the drafts below. No additional operator-confirmation field is introduced.

`--json` stays the JSON-format compatibility alias. Shell rendering is POSIX
sh/bash; unsupported renderers require the diagnostic/typed descriptor specified
by B-OG-33. MCP output pins registered server/tool/arguments, input/output schema
digests, timeout and session isolation. Config paths stay under `parallelism`;
model preferences stay under `models.json.defaults.workerSelection`. No `mc groups`
namespace exists. MC dispatch queues; MC run executes.

`mission-vectors.json` preserves the test strategy's eight original scenario IDs
and adds direct/shared positives and targeted negative deltas. Direct parent may
be absent/null/conductor-session; direct brief has no lease. Direct accepted
results allow null runner and empty artifact-evidence references but require
verifier identity, exact artifact-digest shape, controlled context and findings.
Managed parent, brief lease/decision, and accepted runner/artifact evidence remain
required. Both variants share closed `workerClaims`; a worker cannot supply trusted
execution or verification. A valid digest's correspondence to the actual artifact
is a runtime check, not a shape claim.

`negotiation-vectors.json` is an executable reference oracle for revision, bundle
digest, required-feature and lossless-codec negotiation. It rejects unknown/absent
required worker support before a prospective data handoff. It does not enable
production negotiation. The canonical codec is tested for actual lossless
extension round trips; other consumers advertise no worker support in
`consumer-inventory.json` until their own conformance and boundary work passes.

## Disposition and consumer ownership

### #3656 conductor input guard amendment

The existing data-policy objects add `localOnlyPaths` (literal project-relative
files/subtrees). Worker-selection and parallelism fragments and manifest digests
are amended together; strict production-owner equality is preserved. Deployment
blocks explicit conductor references; arbitrary shell programs remain outside
this guard's containment boundary. No schema family or runtime qualification is added.

### #2925 template and constrained alias amendment

The parallelism fragment combines #2925 group templates, group effort/data
ceilings and #2926 admission `starvationSeconds`. The worker-selection fragment
adds constrained `baseRole` aliases. All fragment SHA-256 digests are recomputed;
production-owner equality and strict validation remain enforced. Reserved alias
keys and template ancestry beyond 64 levels are rejected by the shared loaders.

### #2926 diagnostic threshold amendment

The parallelism fragment and manifest digest add optional admission
`starvationSeconds` (1–86400, default 120). This configures bounded group/run
service diagnostics only; priority/FIFO/aging, budgets, deadlines and fencing
remain authoritative. The existing schema owner and strict exact-match checks
are preserved. No new schema family or live qualification is introduced.


### #2913 S1 health resolution amendment

The existing effective-health definition permits bounded optional `origins` and
`truncatedWindows`. Group resolution freezes source pointers and tied limiting
ceilings with the effective windows; short parent deadlines disclose truncated
startup/quiet/stall windows without extending the hard deadline. Historical
descriptors retain their original shape. The Mission fragment and manifest digest
are amended together, preserving strict exact-match assertions. Existing
parallelism health fields now receive cross-field and canonical-key validation;
required step caps reject observed/unavailable enforcement. Managed breaker
execution, leases and remediation remain deferred to their S2+ owners.

### #2896 S1 health qualification amendment

The existing closed invocation-profile health record now preserves explicit
coverage, qualification target, H/R/D source grades, provenance and B-OG owner.
Scoped synthetic/live evidence binds the exact profile, runtime version, account,
canonical inference model and effort through the shared qualification digest.
Unqualified records use a null qualification date and never assert accepted
model work. Authenticated live evidence requires separate live authorization;
synthetic CI fixtures cannot establish it. The worker-adapter fragment and its
manifest digest are amended together; exact equality assertions remain strict.
The three excluded hosted entries use explicit unobserved coverage on their
existing capability entries. Generic remains a nonexecutable deployment fallback
in the provider-definition owner. All 15 IN provider profiles and local HTTP
remain S1 qualification targets; unavailable controls continue to block dispatch.
Managed admission, leases and reconciliation remain with their S2+ owners.

Provider health descriptors live in the optional `workerHealthAdapter` and
`workerHealthAdapters` metadata fields. They retain the closed adapter shapes
without registering an executable module or enabling an adapter reference.
The capability-root fragment and digest include this separate metadata map;
the approved worker module set and its existing reference semantics remain
unchanged. Legacy resolved and preparatory descriptors may omit effective
health and must round-trip without synthesizing a field. Observer and resolution
owners supply the documented defaults when execution requires them.
The direct MCP invocation bridge is not part of this change; it is deferred to
#2892. The frozen `missions` toolset and mission-dispatch descriptor remain
unchanged.

### #2916 S1 health-to-lease mapping amendment (B-OG-54)

No fragment, manifest digest, schema ID or worker definition is changed: the
shipped `workerHealthSummary`/`workerEffectiveHealth` shapes, the five/six
required-feature shapes and the `worker-health.v1` negotiation vectors
already cover the S1 contract surface, and the exact-match test is untouched.
The Mission codec owner gains pure mapping only
(`classifyHealthTrace`, `projectHealthTrace`, `healthLifecycleDigest`,
`boundTraceText`, `healthReasonLabel`, `stopProofFromHealth`,
`decideLeaseMapping` in `src/mission-protocol/`): renewal carries no
progress field, so it cannot assert progress; stop proof is derived from
owner-observed health summaries, never asserted by the caller, so a late
final after cancel-disconnect never releases while termination is
uncertain; lease expiry or cancel-disconnect without derived confirmed stop
proof retains the uncertain reservation and releases no writer capacity; a
stale observed generation denies renew/cancel/settle/accept and stale
evidence is recorded as rejected without ever being stored. Quiet, stalled
and uncertain project distinctly; productive-work credit requires fresh
progress evidence (heartbeat replays with a frozen progress watermark earn
nothing) and no health state earns Mission/Flow completion credit.
Activity summaries are built only from enum/counter/generation fields plus
an allowlisted reason label (unlisted free text projects as
`UNCLASSIFIED#digest`, and the previous-state channel accepts only closed
observed states), bounded to 1024 UTF-8 bytes with small budgets never
overflowing; the effect ledger receives digest-only lifecycle refs. The
reason-code allowlist is pinned by parity test to the B-OG-50 observer
`reasons` set.
T-OG-24 registers the S1 vectors as partial with a mocked scheduler
boundary and no managed imports. Actual renew/fence/stop/settle/release
wiring (B-OG-12), Mission/Flow/Ralph caller-event mapping (B-OG-16) and
scheduler/MC crash/restart cases remain **deferred S2+**; the observer
reason-code allowlist moves together with the B-OG-50 observer `reasons`
set.

### #2890 S1 structured-final realization

The Mission definition fragment now encodes the normative terminal invariants:
completed execution requires confirmed termination, an end timestamp, no failure
and a zero or absent (MCP) process exit code; accepted results require completed
execution and completed claims. The fragment and manifest digest are amended
together; the exact-match test remains strict. No field or schema ID is added.
The existing adapter parser validates bounded UTF-8 claims for shell and MCP;
the Mission codec producer map and immutable snapshots own trusted assembly.
Observed identity and exact artifact bytes are checked at acceptance, while
unknown usage remains null. Managed scheduling, leases and verifier-runner
qualification remain with their S2+ owners; synthetic finals do not qualify a CLI.

#### #2890 fix pass: unknown usage must carry null counts

The initial amendment above stated that "unknown usage remains null" but the
shipped `workerUsage` definition never enforced it: a `quality: "unknown"`
usage object with all-zero (or otherwise non-null) token/cost counts still
validated. The fragment and the production schema now carry an additive
`allOf`/`if`/`then` on `workerUsage` (the same terminal-style conditional
already used on `workerExecution`): when `quality` is `"unknown"`,
`inputTokens`, `outputTokens`, `cacheTokens`, `reasoningTokens` and `costUsd`
are each required to be `null`. `reservedTokens`/`reservedUsd` are untouched —
reservations are adapter/pool bookkeeping, not a worker-reported count, so an
`unknown`-quality worker can still carry a known reservation. The manifest
digest for `mission-definitions.patch.json` is updated to match; the
exact-match test (`worker-contracts.test.ts`) continues to compare the frozen
fragment and the production schema field-for-field with no relaxation.

The strict jsonl `{"type":"terminal","status":"completed"}` line stays
optional: 03 §11.4 requires a "qualified successful terminal
event/exit", i.e. either is acceptable evidence, not both. The authoritative
truncation backstop is the adapter-owned process/transport observation
(`options.observation`), enforced unconditionally by `assertWorkerTerminal()`
in `parseWorkerOutput()` whether or not the terminal line is present; a stream
cut right after the `result` line still fails there if the process did not
also report a confirmed, clean exit. This is now documented at the parser
call site, not only here.

#### #2891 fix pass: `min_free_disk_gb` admission floor

The frozen `parallelism.fragment.json` `admission.hostResources` object is
amended additively with `min_free_disk_gb` (`type: number, minimum: 0,
default: 2`), the same shape as the existing numeric `hostResources` fields
it sits alongside (`min_avail_mem_gb`, `max_load_ratio`, `max_mem_psi_avg10`,
`max_mem_psi_avg60`, `max_workers`). No existing defaults or required lists change. The fragment and manifest SHA-256 are amended together; the
exact-match test (`worker-contracts.test.ts`) continues to compare the frozen
fragment and the production schema field-for-field with no relaxation. The
production schema (`vscode-extension/schemas/aiwg.config.v1.json`
`parallelism.admission.hostResources`) and the `DispatchHostThresholds`
TypeScript interface (re-exported from `src/config/aiwg-config.ts`) agree.
#3301 adds positive `max_snapshot_age_seconds` (default 300, MIN across layers),
amending fragment/digest together with exact equality intact. The free-disk floor validates through the shipped JSON
schema and `resolveDispatchHostThresholds`/`resolveDispatchThresholds`
(`tools/scripts/resource-preflight.mjs`), which share one conservative
default set (`DEFAULT_DISPATCH_HOST_THRESHOLDS` /
`DEFAULT_DISPATCH_THRESHOLDS`, `min_free_disk_gb: 2`). The #2954 dispatch
admission gate (`checkWorkerDispatch`, threaded through
`checkDispatchAdmission` in `tools/ralph-external/lib/dispatch-evidence.mjs`
for #2891) samples the actual attempt-root and worktree filesystems — never
the conductor's process `cwd` — and fails closed on non-finite, negative or
undetectable free disk; it never silently passes an unprovable sample.
Shared enforced admission remains **deferred S2+**, unchanged by this
amendment.

Every disposition below names an owning draft and consuming source owner.
The machine-readable consumer inventory extends the existing Mission matrix
without altering its established consumer IDs. Downstream issues should extend
this corpus and apply its vectors to their production validators/boundaries,
retaining scenario IDs and documenting any reviewed contract revision.

| Disposition | Owning draft / issue | Consumer | This checkpoint / next checkpoint |
|---|---|---|---|
| Public vocabulary and compatibility corpus | B-OG-01 / #2876 | CLI handlers, MCP orchestration, Mission schema tests | S1 fixture gate delivered here |
| Additive optional observation fields (`evidenceDigest`, `conflicts`) | B-OG-03 / #2882 | `schemas/models/model-catalog.v1.schema.json`, `src/models/model-discovery.ts`, `src/models/provider-policy.ts` | Amend the frozen observation fragment with per-value conflict evidence (value, source, pointer, digest, observedAt); #2882 acceptance criteria require explicit conflicts. Existing required fields and strict exact-match assertions remain unchanged |
| Group/CLI/model field shapes, merge restrictions, model observations | B-OG-29 / #2878; B-OG-02/04 | `src/config/aiwg-config.ts`, `src/config/cli.ts`, `src/models/config-loader.ts`, `src/models/provider-policy.ts` and existing config/model schemas | Frozen field fragments and initial shape vectors; downstream adds semantic vectors and production validation |
| Managed coherent activation and copy inventory | B-OG-29; B-OG-02/04 | Existing config/model writers and MC preflight | Marker shape frozen; managed writer/lock/admission assertions **deferred S2+** |
| Shared and managed Mission definitions, producer separation, required-feature negotiation | B-OG-30 / #2879 | `schemas/mission-v1.schema.json`, `src/mission-protocol/types.ts`, `src/mission-protocol/codecs.ts`, executor consumers | Reviewable version-1 definitions and compatibility/negotiation vectors; downstream ships definitions and fail-closed consumer guards |
| Closed capability root and trusted installed module loader | B-OG-31 / #2880; B-OG-06 | `schemas/models/provider-model-capabilities.v1.schema.json`, `src/models/provider-policy.ts`, Ralph `registerProvider` factory | Frozen root patch and adapter/profile fragments; downstream implements trusted loader/digest/version/export checks |
| Exact command rendering, unsupported syntax, stale/denied exclusions, Muse consumer mismatch | B-OG-33; B-OG-04 | `src/cli/handlers/models.ts`, `src/models/resolver.ts` | Flag/alias/transport fixtures and actual fake POSIX command capture; runtime renderer/resolver remains S1 downstream work |
| Read-only worker resolution and bounded authorized invocation | B-OG-35 | `src/mcp/tools/orchestration.mjs`, `src/mcp/server.mjs`, `src/mcp/registry.ts`, `src/mcp/profiles.ts` | Frozen descriptors and negative inputs; runtime bridge/native transport, concurrency/disconnect/late-call assertions belong to B-OG-35 |
| Doctor group readiness and steward model guidance | B-OG-18 | `tools/cli/doctor.mjs`, `src/cli/handlers/steward.ts` | Existing namespace flag fixtures; runtime direct readiness/diagnostics remain S1 downstream work |
| Provider and alias completeness, actual transport qualification | B-OG-27/47; B-OG-07/08/09/28/36–45/48 | Capability matrix, provider definitions, model policy, qualified invocation profiles | Every current provider plus local text has row, owner and consumer; all fixture rows explicitly unqualified; enabled live qualification remains S1 downstream work |
| Direct lifecycle, protected verification, optional receipts | B-OG-13/14/15/34 | Conductor, existing launcher/result/evidence owners | Direct schema independence and synthetic shell mechanics delivered; end-to-end lifecycle/verification remains S1 downstream work |
| MC brief/group/decision and Mission/Flow/Ralph bindings | B-OG-16/23; B-OG-30 | `src/cli/handlers/mc.ts`, Mission conductors, composition-engine validator/runtime, Ralph | Vocabulary, offline Flow value-schema mappings and consumer inventory delivered; Mission/MC lifecycle, completion and accounting **deferred S2+** |
| Leases, admission, fencing, cancel/reconcile | B-OG-10/12/16 | `src/serve/shared-host-scheduler.ts`, existing admission store, MC/Mission owners | Required managed data shape retained; managed runtime assertions **deferred S2+** |
| S1 health-to-lease/trace mapping vectors | B-OG-54 / #2916 | `src/mission-protocol/types.ts`, `src/mission-protocol/codecs.ts`, T-OG-24 packs | Pure `classifyHealthTrace`/`projectHealthTrace`/`decideLeaseMapping` with mocked scheduler boundary; B-OG-12/16 run the same vectors as mandatory S2 runtime gates |
| Live host-resource admission thresholds (`admission.hostResources`) | FR-OG-107 / #2954 | `vscode-extension/schemas/aiwg.config.v1.json`, `src/config/aiwg-config.ts`, dispatch preflight | `parallelism.fragment.json` amended additively with optional `hostResources` (conservative defaults live in `resolveDispatchHostThresholds`); strict exact-match assertions unchanged; shared enforced admission remains **deferred S2+** |
| Optional health definitions and required-feature compatibility | B-OG-49/50/54/55; B-OG-12/16 for enforcement | Existing launcher/adapters, Mission codecs, scheduler | Five/six-feature shape compatibility only; health-to-lease mappings owned by B-OG-54 and managed enforcement **deferred S2+** |
| Catalog editor annotation discrepancy | B-OG-29 / #2878 | `schemas/models/model-catalog.v1.schema.json`, catalog loader | Resolved in #2878: the closed owner accepts the exact checked-in annotation; the complete annotated catalog validates through the production loader |

## Test lane and evidence limits

- `test/conformance/mission-v1/worker-contracts.test.ts`: T-OG-01/08/14 shared
  shapes, legacy schemas, managed-required negatives, actual canonical codec
  round trips, offline cross-dialect Flow bindings and negotiation reference oracle.
- `test/unit/cli/handlers/models-worker-contracts.test.ts`: T-OG-15 flag/alias
  catalog, actual legacy handler compatibility, a zero-managed-state direct schema
  pair, fake POSIX argv/cwd/stdin/environment-name/output capture, cleanup, and
  T-OG-19 inventory/alias reconciliation. The injection-shaped prompt is literal
  data; malformed group/transport/format syntax is rejected by descriptor vectors.
- `test/unit/mcp/worker-contracts.test.ts`: T-OG-17 frozen input/output descriptors,
  schema pin/isolation requirements and unchanged actual Mission tool descriptor.

Run all three with `npx vitest run --config config/vitest.config.js <files>` and
`npm run typecheck`. These run in existing default Vitest lanes. Temporary roots
are owned by the tests and removed; the fake child has a finite deadline, closed
stdin after the synthetic brief and bounded output. No paid/live qualification or
full provider drivers, packaged adapter loading, MCP transport chaos, managed
Mission runtime, leases or admission is claimed by these passing fixture packs.

## Validation evidence (2026-10-07)

`npm run typecheck`: passed (exit 0).

Final Vitest invocation:

```sh
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/conformance/mission-v1/mission-protocol.test.ts \
  test/unit/mission-protocol/inventory.test.ts \
  test/unit/mission-protocol/migration.test.ts \
  test/unit/cli/handlers/models.test.ts \
  test/unit/mcp/orchestration.test.ts \
  test/unit/mcp/orchestration-flows.test.ts \
  test/unit/models/provider-policy.test.ts \
  test/unit/config/aiwg-config.test.ts
```

New suites: **105 passed, 0 failed** (81 Mission/schema, 18 MCP, 6 CLI/inventory).
Related existing suites: **241 passed, 5 environmental failures**; combined:
**346 passed, 5 failed**, nine passing files and two failing files.

Four failures are in the existing Mission inventory suite: its synchronous Node
subprocesses are denied with `EPERM`; the final assertion sees empty subprocess
stderr instead of its expected outside-workspace diagnostic. One existing models
handler test fails with `EROFS` attempting to write the home model-catalog cache.
Neither sandbox restriction was bypassed or changed. These failures are not passes.

Sanitized fixture evidence: the real fake shell child produced exactly the frozen
argv (including quotes, spaces, Unicode, newline, leading-dash text and literal
command-substitution text), assigned cwd, synthetic brief stdin, separate output
paths and environment names `OLDPWD`, `PATH`, `PWD`. The apparent injection did
not create its target file; final claims validated independently. No environment
values are exported. All newly created temporary roots were removed by teardown;
removal was checked by `ENOENT`. Direct schema validation left only the input
`models.json` and `.aiwg/aiwg.config`, with their bytes unchanged.

Acceptance at this fixture checkpoint: disposition ownership, legacy compatibility,
unsupported-required-metadata rejection vectors, and reviewable versioned Mission
definitions/consumer inventory are met. Production negotiation remains #2879's
consumer-boundary work; managed runtime/leases/admission are deferred to S2+.

## #2879 production boundary refinement

The frozen #2876 fragments and vectors remain intact. Production validation now
uses the bundled Mission owner. `encodeMission` and `decodeMission` negotiate and
validate worker extensions before cloning; unqualified native projections and
runtime handoffs reject them with `OG_CONTRACT_UNSUPPORTED`. Only canonical-codec
advertises support after its production boundary tests pass. Consumer rows that
name schemas or types do not introduce an executor handshake. Model selectors,
profile registries and provider-name factories have no worker payload input;
their future worker support remains false.

`test/unit/mission-protocol/worker-boundaries.test.ts` adds aggregate UTF-8 byte
limit/limit+1 and nesting depth 16/17/32 cases without changing the frozen shape
vectors. Individual fields remain schema-valid in these aggregate negatives.
The same test creates immutable pending and accepted result snapshots through
the existing codec owner, checks unchanged prior bytes/digest, and round-trips
linked `workerDispatch.previousRecord` updates through canonical Mission owners.
Snapshot records are local codec return values, not new persisted schema owners.

Persisted managed snapshots and completion integration remain **deferred S2+**:
configuration spec 05 §5.1 assigns digest-addressed versions to existing
Mission/Flow/Ralph artifacts; rules spec 06 §7 explicitly assigns immutable
pending/accepted artifact versions to Tier 1 and permits Tier 0 verification in
context or an optional receipt; delivery plan 11 S2–S3 schedules managed evidence
and Flow bindings. The S1 codec preserves bytes and successor links in memory
without requiring a database, receipt or Mission runtime.

`installed-layout.test.ts` probes compiled codec modules and local validator
dependencies under temporary installed paths for both `aiwg` and `@aiwg/cli`.
`test/integration/mission-contract-packaging.test.ts` additionally packs/unpacks
both publication targets offline in the existing serial packaging lane.

### Fix-pass validation (2026-10-07)

- `npm run typecheck`: pass.
- `npm run lint:mission-contract`: pass, compatible, no breaking changes.
- `npx vitest run --config config/vitest.config.js test/conformance/mission-v1/ test/unit/mission-protocol/`:
  **243 passed / 4 failed**. Existing inventory tests fail on sandbox-denied Node
  subprocesses (`EPERM`), including the assertion that receives empty stderr.
- `node tools/mission-protocol/inventory.mjs` and the same command with `--write`:
  both blocked by `spawnSync rg EPERM`. Newly added files still need inventory
  generation/classification in an environment permitting these subprocesses.
- `npx vitest run --config config/vitest.packaging.config.js test/integration/`:
  **0 collected**, existing global setup fails on `prepack`'s `tsx` IPC
  `listen EPERM`. The installed-layout checks passed separately (2/2); actual
  tarball execution remains environmentally unverified.

Related owner suites before the final UHP transmission additions: **510 passed,
0 failed** (22 files):

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts test/unit/a2a/ \
  test/unit/serve/mission-conductor.test.ts \
  test/unit/serve/fleet-mission-conductor.test.ts \
  test/unit/serve/shared-host-scheduler.test.ts test/unit/uhp/sse-mission.test.ts \
  test/unit/addons/composition-runtime.test.ts test/unit/mcp/agentic-sandbox.test.ts \
  test/unit/mcp/orchestration.test.ts test/unit/cli/handlers/mc.test.ts
```

Final UHP transmission regression: **76 passed, 0 failed** (6 files):

```sh
npx vitest run --config config/vitest.config.js test/unit/uhp/ \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts
```

The related-owner command above with `test/unit/cockpit/` added (before the three
SDK stripping tests) produced **524 passed / 13 failed**. All failures were the
existing bridge smoke isolation suite's sandbox-denied Node permission probes
(`spawnSync EPERM`). Broader related coverage produced **1450 passed / 32 failed**:

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts \
  test/unit/serve/mission-conductor.test.ts \
  test/unit/serve/fleet-mission-conductor.test.ts \
  test/unit/serve/shared-host-scheduler.test.ts test/unit/uhp/ \
  test/unit/addons/ test/unit/mcp/ test/unit/cli/handlers/mc.test.ts
```

Those broader failures are in existing subprocess-evidence tests (30), a
compound-memory context-pack schema expectation (1), and a real MCP child-pipe
timeout (1). The subprocess tests received empty child output despite exit zero;
this is not labeled a proven `EPERM` failure. No changed boundary test failed.
Related package metadata/workflow checks also passed (6/6):

```sh
npx vitest run --config config/vitest.config.js \
  test/smoke/cli-package-publish-workflow.test.ts test/unit/package-metadata.test.ts
```
## #2880 S0 / S1 capability and installed-loader checkpoint (2026-10-07)

The capability owner now contains the frozen root patch, workerAdapter and its
profile/helper definitions verbatim. `contractSchemas()` reads this production
owner directly; it no longer patches capability fixtures over missing production
fields. Existing adapter vectors also exercise the production Zod loader. No
frozen fragment, manifest digest, or existing vector was changed.

New vectors in this same fixture home:

- `adapter-vectors.json`: T-OG-03/17 HTTP and MCP positives, schema pins,
  isolation, missing controls, closed profile fields, unsupported revision and
  qualification evidence negatives. Deltas retain positive sibling values.
- `adapter-loading-vectors.json`: T-OG-10/14 traversal, symlink, digest,
  package/adapter/interface versions, wrong/reassigned exports, URL/unknown
  modules, worker/group/world writable paths, duplicate IDs/references, builtin
  collision, unsupported platforms and catalog-module tampering. Every negative
  checks absence of the import side-effect marker.
- `third-worker-adapter.mjs`: synthetic interface-v1 installed adapter/catalog.
  No bootstrap switch, resolver or workflow knows its ID. Concurrent loads use
  `ensureProvidersRegistered(trustedBindings)` and the existing string factory;
  import and registration occur once. Cached calls recheck installed bytes.

The host registration API takes the existing registry and an in-memory trusted
installed-module allowlist: reference, canonical package root, relative module
path, package name/version, interface version, SHA-256, adapter IDs and qualified
platforms, plus worker-writable roots. Project configuration cannot supply this
allowlist through any CLI/config loader. All selected runtime/catalog modules
pass validation before any selected module import. Exports must be statically
bound (`interfaceVersion=1`, callable `register(factory)`); reexports, computed
interface values and visible binding writes are rejected. The syntax scan also
rejects direct `eval(...)` calls; it does not detect indirect eval, `Function()`
or computed dynamic imports. Trust rests on the approved digest and installation
authority, since importing executes the entire module body.

Threat note (08 Revision 2, TB5/TM-OG-07/17; 05 §4.3a): the host must keep
installation roots, their path bindings and dependency closure read-only during
loading and execution, including against concurrent installers and worker writes
through aliases. Schedule installation updates outside that interval. Symlinked
package roots resolve to a canonical identity before containment, package and
digest checks; module/package.json symlinks inside that root remain rejected.
Hardlinked module/package.json files are accepted only with no write permission
bits for anyone (`mode & 0222 === 0`); writable hardlinks fail before import.
This permits read-only content-addressed stores. Permission bits do not prevent
an owner from changing modes or establish ACL/mount isolation: the host must
enforce the read-only requirement, including shared inodes and symlink ancestors.

The loader bounds module and package.json reads to 5 MiB (the catalog `maxBytes`
default), then rechecks canonical identity, permissions and digest immediately
before import. A residual check-to-import TOCTOU race remains: ESM reopens the
path after validation, so the recheck narrows but does not close that window.
These checks are defense in depth, not filesystem isolation or a race-free load.

Direct/shared results: closed annotation enum and lossless metadata preservation,
exact reference namespaces, process-default/HTTP binding semantics, versioned
shell/MCP control guards, installed factory loading and pre-import negatives are
implemented. Pure resolution needs no Mission, MC, admission, activation or
executor service. All deployment providers pass the models consumer guard and
bundled policy compiler, including Muse; Codex/Muse native resolve is exercised
without managed state. Deployment support is not live worker qualification.
T-OG-03 here covers metadata/required-control boundaries; provider terminal,
cancellation and full invocation qualification remain their existing S1 owners.
T-OG-17 here covers profile/schema pins; transport chaos belongs to B-OG-35.
Managed admission, leases, activation, Mission/Flow/Ralph runtime and health
settlement are **deferred to S2+**; no managed readiness is advertised.

Minimal shared edits: `src/models/provider-policy.ts` adds capability fields and
helpers only, leaving the config/catalog areas owned by #2878 unchanged;
`src/cli/handlers/models.ts` derives its provider guard from the registry;
`worker-contract-fixtures.ts` and `worker-contracts.test.ts` switch capability
checks to production. Package manifests/lock promote already-locked Acorn to a
runtime dependency for pre-import syntax checks. Both package manifests include
models schemas, the CLI builder/manifest include Ralph adapters, and
`config/test-lanes.mjs` registers the test in the existing packaging lane.

Validation commands and results:

```sh
npm run typecheck
npx tsc && npm run build:copy-mjs
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/models/worker-capabilities.test.ts \
  test/unit/ralph-external/installed-worker-adapter.test.ts \
  test/unit/ralph-external/provider-adapter.test.ts \
  test/unit/models/provider-policy.test.ts \
  test/unit/models/provider-conformance.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/cli/handlers/models.test.ts \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/ralph-external/session-launcher.test.ts \
  test/unit/providers/capability-preflight.test.ts
npx vitest run --config config/vitest.packaging.config.js \
  test/integration/worker-adapter-package.test.ts
```

Typecheck and compilation/resource copy passed. Combined default suites:
**318 passed, 1 environmental failure**, ten passing files and one failing file.
The existing Grok discovery test in `models.test.ts` fails with `EROFS` writing
`~/.cache/aiwg/model-catalog.v1.json`; no production workaround was added.
The packaging lane fails in its existing global prepack setup with `EPERM`
creating the tsx IPC socket, before either package test runs: **0 executed,
2 blocked**. T-OG-14 package-path verification is therefore **partial**, not a
passing packaged-runtime claim. The tests pack/extract both published targets
outside the checkout, use compiled production code and preinstalled dependencies,
and exercise the same trusted factory. The conductor must rerun this lane where
its existing prepack setup is permitted.

All owned test temporary roots were removed and ENOENT checked. New tests use
synthetic modules/catalogs and no credentials or paid calls. Open conductor item:
rerun the two package cases in a permitted environment before claiming T-OG-14
complete; no contract redesign or frozen-vector correction is requested.

### #2880 security fix pass (2026-10-07)

The installed-loader unit suite adds writable hardlink negatives for both module
and package.json, read-only store positives, symlinked package/ancestor positives
with canonical-cache identity, worker-writable root and escaping symlink
negatives, and 5 MiB read-limit boundaries. All frozen vectors are preserved.

```sh
npm run typecheck
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/models/worker-capabilities.test.ts \
  test/unit/ralph-external/installed-worker-adapter.test.ts \
  test/unit/ralph-external/ test/unit/models/
npx vitest run --config config/vitest.packaging.config.js \
  test/integration/worker-adapter-package.test.ts
```

Typecheck passed. The requested four files passed **164/164** tests. The full
default invocation produced **1029 passed, 9 failed**, 36 passing files and two
failing files. One existing `models/live-smoke.test.ts` check fails with subprocess
`EPERM`. Eight existing `ralph-external/snapshot-manager.test.ts` cases fail in
temporary-repository `git commit` setup; stderr is suppressed by those tests, so
their precise cause is unconfirmed (this environment enables GPG commit signing).
No test or signing configuration was changed to bypass these failures.

The packaging lane remains **0 executed, 2 blocked**: its global prepack setup
fails with `EPERM` creating the tsx IPC socket. The focused loader suite passes
**32/32**. All four requested security corrections are implemented; full green
regression/packaging evidence remains partial until the conductor can rerun the
blocked/failing existing lanes in a permitted test environment.
## #2878 S0 contracts / S1 direct and shared implementation

The three frozen field fragments now ship in their existing production owners:
editor `parallelism`, models `defaults.workerSelection` and catalog
`$defs.workerObservation`. No frozen JSON fragment/vector was changed, no new
schema family was added, and native cap resolution retains its original result
when worker dispatch is disabled. The merged worktree also retains #2880
capability-root/driver loading and #2879 Mission definitions/codecs/negotiation,
with their checkpoint evidence recorded above.

`policy-semantic-vectors.json` adds field/origin algebra, booleans, empty sets,
canonical identity, null/none effort, role/reference/installation declarations
and hard-budget control checks. `policy-route-vectors.json` adds qualified
model-effort and identity-evidence order, pin/alias protection, denied ultra and
self-delegation aliases, no-control/mixed groups, contributor/unknown-data,
required role and stale-evidence exclusions. `activation-contract-vectors.json`
freezes canonical digests, absent-model null hashing and distinct/coincident
config copy inventories. These are synthetic facts, not live qualification.

Production config readers/writers now reject malformed parallelism before
persistence. Resolution preserves legacy provider caps and applies direct/group
member/execution defaults without managed state. The existing nested config
set/reset operations accept the new JSON values and validate the entire
candidate; unsafe prototype paths are rejected before mutation.

The models loader retains leaf source pointers, canonical layer digests,
authority classes and original contributions before merging. First explicit
values replace shipped defaults; subsequent restrictions use union,
intersection, OR/AND, numeric minima and ordered identity evidence. Attempted
relaxations fail with both origins. Changed builtin/user/project contents and
removed user inputs invalidate cached results. Effective freshness is validated
after inheritance. Data classes narrow their base policy.

Catalog enrichment remains in the existing discovery owner, including separate
installation/account rows. Runtime validation checks the production schema,
calendar dates/URIs and consistent existing visibility/effort evidence. Cached,
static and remote input cannot silently acquire malformed worker evidence;
legacy rows remain usable without worker qualification. The pure route,
reference, installation-binding and budget guards are available to downstream
B-OG-02/04/06 consumers; this checkpoint does not add an executable resolver,
command renderer, trusted import authority or launcher.

Shared edits are scoped: `src/models/provider-policy.ts` changes only config,
worker policy and catalog validation (capability loading is untouched);
`worker-contract-fixtures.ts` removes only #2878's test-only schema patches.
`tools/release/build-cli-package.mjs` adds three schema-copy lines;
`package.json` and `packages/cli/package.json` add only corresponding published
asset paths. The compiled CLI package loads these production assets successfully.

### Acceptance and tier disposition

| Criterion / pack | Status and evidence |
|---|---|
| AC1 shape/semantic coverage and disabled legacy behavior | **met (S0/S1 shared):** frozen shape vectors exercise production owners; added semantic vectors exercise production validators, loaders and guards; legacy suites pass |
| AC2 distinct direct/shared and managed checkpoints | **met:** direct config/model loading creates no MC, admission, activation marker or receipt state; managed-only checks are explicitly deferred below |
| T-OG-01 | **met for #2878's owners:** defaults/origins/restrictions, canonical identities, pins, qualified efforts, references/roles and catalog guards; executable candidate selection/ordering remains B-OG-04 |
| T-OG-05 | **met for S0 contracts:** capacity-key shapes, hard-ceiling control rejection, digest/copy inventory; atomic reservations and runtime accounting deferred S2+ |
| T-OG-15/17/19 | **met for scoped fixtures:** actual fake shell mechanics, typed shell/MCP contracts and provider/alias inventory still pass; runtime renderer, MCP transport chaos, doctor and live qualification remain their S1 owning drafts |
| Coherent managed activation | **deferred-to-S2+:** writer locks, immutable paired snapshots, synchronized copies/markers, stale-digest admission checks and fault rollback belong to B-OG-02/04 after the S1 gate |
| Leases / required evidence / managed runtime integration | **deferred-to-S2+:** unchanged owners B-OG-10/12/16; no cross-process reservation, fencing, health-to-lease enforcement or recovery claim |

### Final validation evidence

`npm run typecheck`: **passed**, exit 0 (1 command passed, 0 failed).

Final Vitest command:

```sh
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-policy.test.ts \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/models/provider-policy.test.ts \
  test/unit/models/model-discovery.test.ts \
  test/unit/models/resolver.test.ts \
  test/unit/models/provider-conformance.test.ts \
  test/unit/models/corpus-policy.test.ts \
  test/unit/models/select-role-models.test.ts \
  test/unit/config/aiwg-config.test.ts \
  test/unit/config/get-set-project.test.ts \
  test/unit/cli/config-loader.test.ts \
  test/unit/cli/handlers/models.test.ts \
  test/conformance/mission-v1/mission-protocol.test.ts \
  test/unit/mcp/orchestration.test.ts \
  test/unit/mcp/orchestration-flows.test.ts
```

**536 passed, 1 failed** across 17 files (16 passed, 1 failed). The four direct/shared
contract lanes passed **203/203** (98 policy, 81 shared/Mission, 6 CLI, 18 MCP).
The single failure is environmental: the existing Grok Build models CLI test
attempts to write `/home/roctinam/.cache/aiwg/model-catalog.v1.json` and receives
`EROFS`. Its cache environment and production behavior were left unchanged.
No sandbox restriction was bypassed; this failure is not reported as a pass.

Additional package validation: `npx tsc`,
`node tools/scripts/copy-build-resources.mjs` and
`node tools/release/build-cli-package.mjs --output /tmp/aiwg-2878-cli-smoke`
passed. A Node ESM smoke invocation against the compiled staged CLI checked the
frozen config/model/observation vectors, direct default and both package asset
manifests: **13 assertions passed, 0 failed**. The staged package was removed.

Sanitized evidence: all identities, account bindings, endpoint paths and model
names in added vectors are synthetic. Existing fake-shell tests retain exact
argv/cwd/stdin/output and environment-name checks, with no paid calls or real
credentials. Policy tests reject invalid writes without changing file bytes;
all temporary project roots are removed and absence is asserted. No tracker,
branch, commit or push operation was performed.

Conductor questions: none for the frozen contracts. Downstream direct resolvers
must call the shared route/reference/control guards before task transmission;
managed activation and runtime claims must await their S2+ owners.

## #2885 S1 installation qualification contract amendment

The frozen `worker-adapter.fragment.json` adds optional
`invocationProfile.installationQualification` in the existing capability owner.
The closed record binds the installation/profile scope digest, negative-fixture
digest, verification timestamp and evidence reference. Its manifest digest is
updated; exact-match assertions remain unchanged. Existing profiles stay valid,
but this optional metadata alone does not enable an installation: the adapter
qualification owner must verify the current scoped installation and controls.
Required children/fallback controls also require the corresponding adapter
capability, preventing a profile mapping from claiming uncontrolled behavior.

This is the S1 direct/shared contract checkpoint. Managed executor admission,
leases and verification settlement remain deferred to S2+.

## #2890 S1 final validation (2026-10-08)

New production paths are the existing adapter's `parseWorkerOutput` reached through
the async `parseWorkerFinal()` entry point (`parseOutput` keeps its synchronous
legacy contract with no group mode), and the existing Mission codec's
`assembleWorkerResult`. JSON/JSONL/MCP framing is selected explicitly by the
qualified caller; provider-specific native event normalization and live profile
qualification remain with their adapter owners. The parser returns only claims.
The separately supplied observation must confirm successful transport completion;
acceptance additionally checks qualified observed identity, verifier evidence and
actual artifact bytes. Calling code owns process observation, protected checks,
and the artifact/tree-manifest read. No worker-selected command is executed.

Required checks:

- `npm run typecheck`: passed, exit 0.
- `npm run lint:schemas`: passed, 236 registered schemas, 0 errors, 2 existing fixture warnings.
- `npm run lint:orchestration-packs`: passed, 18 packs; new tests registered as partial.
- `node tools/mission-protocol/inventory.mjs --write`: blocked with `spawnSync rg EPERM`; no generated inventory was hand-edited or subprocess restriction bypassed.
- `git diff --check`: passed.

Final focused source and installed-layout validation: **115 passed, 0 failed**:

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/ralph-external/worker-finals.test.ts \
  test/unit/mission-protocol/worker-results.test.ts \
  test/unit/mission-protocol/worker-boundaries.test.ts \
  test/unit/mission-protocol/installed-layout.test.ts
```

Broader unit/neighbour run: **613 passed, 19 failed** (before three final added
negative cases). Four inventory tests fail on synchronous subprocess EPERM;
remaining failures concern empty subprocess version/protocol output and MCP
connections closing before protocol output. These are validation limitations,
not passing qualification. No assertions or environment restrictions were relaxed.

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/ralph-external/worker-finals.test.ts \
  test/unit/ralph-external/provider-adapter.test.ts \
  test/unit/ralph-external/worker-invocation.test.ts \
  test/unit/ralph-external/installed-worker-adapter.test.ts \
  test/unit/ralph-external/worker-installation.test.ts \
  test/unit/mission-protocol \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/mcp/worker-qualification.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/cli/handlers/models-direct-invocation.test.ts \
  test/unit/cli/handlers/models-production-invocation.test.ts
```

Conformance: **197 passed, 18 failed**. Three pack-registry subprocess cases fail
with EPERM, thirteen CLI/MCP fixture cases lose stdio/disconnect, and two trusted
verifier cases lose stdout/stderr. The final direct-lifecycle rerun retains
**15 passed, 2 failed**, with the same missing verifier output. Source loading for
the verifier uses `node --import tsx` and an explicit source selection so clean
checkouts need no stale/prebuilt dist. Both positive/negative verifier exit codes
are observed, but missing diagnostics keep these cases failed.

```sh
npx vitest run --config config/vitest.conformance.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/conformance/orchestration-v1/worker-fixtures.test.ts \
  test/conformance/orchestration-v1/direct-lifecycle.test.ts \
  test/conformance/orchestration-v1/direct-security.test.ts \
  test/conformance/orchestration-v1/worker-resolution.test.ts \
  test/conformance/orchestration-v1/pack-registry.test.ts
```

Additional default-lane Mission/policy checks passed **240/240**:

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/ralph-external/worker-finals.test.ts \
  test/unit/mission-protocol/worker-results.test.ts \
  test/conformance/mission-v1/worker-policy.test.ts \
  test/conformance/mission-v1/mission-protocol.test.ts \
  test/unit/models/provider-policy.test.ts
```

Legacy adapter Node lane:
`node --test test/unit/ralph/deepseek-harness-adapter.test.mjs test/unit/ralph/muse-adapter.test.mjs test/unit/ralph/pi-adapter.test.mjs`
reported 1 passing file and 2 failing files. Direct diagnostic runs of the latter
files reported Muse **8 passed/4 failed**, Pi **7 passed/7 failed**; failures concern
empty subprocess output, missing parsed session results and abort/input behavior.
These are retained as environmental/subprocess limitations, not silently skipped.

Acceptance: claims-only, forged-field rejection, bounded/consistent finals,
producer separation, inert instruction text, unknown usage and original 09
round-trip vectors are met at the S1 shared contract boundary. Exact digest
acceptance/tamper checks pass in the codec; subprocess verifier evidence remains
partial under the above environment. Managed admission/lifecycle integration and
qualified verifier runners remain S2+ owners. No live CLI is newly qualified.
Temporary test workspaces are removed by existing teardown; no credentials or
paid calls were used. Open action: rerun inventory and failed subprocess lanes
in a permitted environment before asserting complete validation.

Final frozen-contract rerun:
`npx vitest run --config config/vitest.conformance.config.js test/conformance/mission-v1/worker-contracts.test.ts`
passed **142/142**, including strict fragment/manifest equality and original
unresolved-intent, admitted-brief and assembled-evidence round trips.

## #2991 / #3002 / #2998 coordinated contract amendment (2026-10-11)

The adapter fragment adds optional bounded `versionPattern` and the
`adapter-frame` stdin kind. The Mission definition fragment adds the same
stdin kind and optional generated `artifacts` declarations (name, content,
optional `location: run-directory`). Manifest SHA-256 bindings are amended;
exact equality and strict compilation checks remain intact. These are
intentional shared-contract extensions; no schema ID or subsystem is added.
Cursor decimal date cores normalize 2026.10.01-e373342 to
2026.10.1-e373342 once in the version probe; suffixes remain unchanged.
Subsequent installation qualification also compares the captured raw version
text with the recorded banner: added leading zeros cannot reuse a normalized
version pin, including `2026.010.1` versus `2026.10.1`.
Artifacts are bounded private launcher files with argv placeholders, never
preview writes. #2905 now permits one workspace-relative artifact under an installed adapter's
fixed prefix, with an optional resolved invocation ID and required workspace
prefix/path fields. The frozen invocation fragment and its manifest digest are
amended together with the Mission compatibility baseline; exact equality and
strict compilation remain required. Runtime checks
bind the path to that ID, bound UTF-8 bytes, reject symlink components, create
exclusively, preserve collisions and clean up on failure, completion or stop.
Warp delivery is wired, while authenticated envelope capture and smoke remain
deferred and the profile remains unqualified.
Antigravity frames are computed by the installed driver and delivered only
on stdin, must be nonempty, and shell framing binds the trusted host store bytes
and conductor policy explicitly under `env -i`, without cwd config resolution.
Launcher records bind substituted argv and artifact names, byte lengths and
content digests without exposing contents; the placeholder argv digest is retained.
Output paths cannot collide with reserved `artifact-` paths.
Provider controls remain unqualified until authenticated smoke
runs; synthetic fixtures do not grant live authority.

Version patterns are anchored whole-banner expressions with exactly one
capture, at most 256 characters and two bounded atom repetitions (each at
most 128). Branching, assertions, backreferences, wildcard/unbounded
repetition and repeated groups are rejected by the registry loader. Probes
retain at most 4096 bytes of raw UTF-8 banner evidence. The artifact limits
are 16 names, 1 MiB per artifact and 4 MiB total UTF-8 bytes (the existing
invocation-file ceiling can be stricter); names use alphanumerics, underscore
and hyphen, with an alphanumeric first character.

Review-required fixes validation (2026-10-11): all 12 added regression cases
fail against the pre-fix uncommitted source and pass with the fixes. The full
touched unit files report 341 passed, 20 failed and 1 skipped; the touched
Antigravity/DeepSeek conformance files report 29 passed and 11 failed. All
31 remaining failure names also reproduce against the pre-fix source (empty
subprocess stdio/version evidence and MCP fixture disconnects); no new failures
were introduced. Frozen worker-contract conformance passes 142/142, and every
fragment's SHA-256 matches the manifest. These fixes change no frozen schema
fragment, so their existing amended digests remain valid.

`npm run -s typecheck`, `npm run -s lint:schemas` (236 schemas, 0 errors,
2 existing warnings), `npm run -s lint:orchestration-packs` (21 packs) and
`git diff --check` pass. Vitest's default config bundling hits EROFS;
`--configLoader runner --no-cache` starts successfully and produces the results
above. `node tools/mission-protocol/inventory.mjs --write` remains blocked by
`spawnSync rg EPERM`; no generated inventory was hand-edited. No vendor/model
calls or commits were made. Runtime qualification remains deferred.

#2643 disposition: the existing worker-selection tier enum accepts canonical `flagship`
and compatibility alias `max-quality`; neither grants user election. Fragment and
manifest digest amended together; default worker bindings remain unchanged.

## #3167 delegation and acceptance amendment

The existing Mission definitions gain optional brief uncertainty, regression,
oracle and design-review fields, and verifier-owned findings/review rounds.
New shared components nest inside existing brief/verification definitions,
preserving schema ownership at Flow/MCP handoffs. The compatibility baseline
is amended under the existing mission-v1 schema identity.
The frozen fragment and its manifest digest are amended together; exact-match
checks remain required. Array types in accepted verification branches are now
explicit so every worker definition compiles with strict types and keywords.
`delegation-vectors.json` adds synthetic positive/negative contract cases;
legacy vectors remain unchanged. Result assembly uses the existing required
review policy and shared observed-lineage diagnostics, binds final review to
the conductor's current head, and derives rounds-to-clean. These fixtures do
not qualify live providers or introduce a managed evidence framework.

#3121 adds Flue to provider-coverage.json as an OUT app target only, with no
worker adapter or invocation profile (#3120 D6). Existing frozen schema
fragments and their manifest digests are unchanged.
