# Eval contract extension and offline H1/H2 pilot (#3315)

Schema brief (2026-11-24). Owner: roctinam / eval maintainers. This change
formalizes and extends the existing `TestCase`, `EvalResult`, and `EvalReport`
contracts in `tools/eval/src/models/types.ts`; it introduces no new schema family.
The one canonical authority is `tools/eval/datasets/contracts.v1.schema.json`,
catalog identity `eval.contracts`, owned by `eval-maintainers` in the `eval`
catalog domain. This domain follows the `tools/eval` source owner and its runner
and validator consumers. The testing-quality domain owns the separate addon's
13 foundational contracts; eval does not consume that addon's contract loader.
The catalog domain adds no schema family or configuration root. Its local
definitions also govern the frozen dataset envelope and the pilot projection
of an eval report.

Consumers: the existing eval runner, its YAML loader, fixture pilot, JSON and
Markdown reporters, and the existing `aiwg-eval` entry point. No top-level CLI
command or configuration root is introduced. The fixture backend takes no model
client, performs no HTTP requests, spawns no model process, and uses no judges.

Compatibility disposition: backward compatible. All current YAML datasets must
validate as TestCase without pilot metadata. Existing EvalResult fields remain
required and unchanged; pilot evidence is optional. Existing report rendering and
standard model evaluation remain available. The existing missing
`@matric/eval-client` typecheck failure is outside this change.

Valid fixtures: all `tools/eval/datasets/*/*.yaml`, the frozen pilot dataset, and
`test/fixtures/eval-pilot/contracts/*.valid.json`. Invalid fixtures:
`test/fixtures/eval-pilot/contracts/*.invalid.json`. Tests compile the canonical
schema in strict Ajv mode and validate both fixtures and runtime projections.
Projection verification checks the emitted result, adjudication, and summary
against their canonical definitions. No schema mirrors are created, and no
#2876 frozen Mission fragment is changed.

The dataset freezes 16 corpus verification, 16 coding repair, and 16 mixed
security/testing tasks, stratified as four development and twelve held-out tasks
per family. A SHA-256 commitment covers tasks, split membership, checks, arms,
environment, budgets and pairing seed. Every referenced fixture/check/graph is
content-pinned. Changes require a new reviewed commitment, not an automatic
refresh. Development and held-out summaries are separate; inference uses only
held-out task pairs. All failed, missing, erroneous and partial observations stay
in the denominator. Fixture resources are labelled as fixture observations.

H1 compares no skills, all relevant bundles, discover-selected, and expert-selected
using frozen offline response tapes and the actual selected context byte counts.
These tapes exercise instrumentation; they do not simulate measured model gains.
H2 runs the existing composition FlowGraph runtime with a fake local adapter for
plain DAG, single verifier loop, constrained graph, and a weakened guard. The
weakened guard uses the same check instrument and must be rejected. Conditional
routes and joins are exercised; this is not live qualification.

Hidden check vectors are passed only to the trusted checker, never in worker
input. They are public synthetic fixtures in this repository: hidden means an
execution boundary, not secrecy from a developer who can read this repository.
Checks are selected from fixed executable implementations, never arbitrary shell
commands from dataset text. Coding checks execute fixture programs in a bounded
VM with hidden inputs. Corpus checks verify source/claim consistency; security
checks verify permission, idempotency, transition and functional invariants.

Adjudication uses opaque case and candidate identities and keeps arm decoding in
the raw run evidence. Executable outcomes, disagreements with fixture self-checks,
and reasons are retained. Human labels remain `NOT RUN`. A paired, seeded
percentile bootstrap resamples whole task pairs; reports include 95% intervals
for success, tokens, latency, regressions, permission violations, transition and
duplicate-effect differences, plus successes per total tokens (including failures).
Intervals describe this fixed fixture set only. The empirical claim gate stays
`BLOCKED` regardless of fixture scores, confidence intervals or labels. H3-H6,
real model execution and blinded expert evaluation are deferred.
