# Evidence-gated memory and prompt updates (#3318)

Status: research design and proposed experiment; no product behavior changes or
measured AIWG improvement. This note supplies the research-phase acceptance for
#3318 and preserves the #3282–#3285 ownership split. It does not authorize an
autonomous updater, a model run, corpus writes, or changes to provider behavior.

## Evidence boundary

The research findings below are supplied by issue #3318, citing the
research-papers corpus at `144e35c2d6fa94171eed60dc4ba5b9d59398771d`.
Those corpus analyses and primary papers were not independently verified in
this offline worktree task. Numerical results in the issue are literature
reports, not AIWG measurements; this note does not repeat them as validated
results. The issue's AIWG runtime pin `5e8746878` is historical, not evidence
that those capabilities exist on this checkout.

| Issue-supplied source | Design implication to test | Primary-source locator |
|---|---|---|
| REF-1545, ACE | Delta edits may preserve accumulated specifics better than whole-prompt rewrites; forbid rewrites in the proposed update policy. | [ACE](https://doi.org/10.48550/arXiv.2510.04618) |
| REF-2588, PANDO | Evaluate demotion and retirement, including blocked rediscovery, alongside addition. | [PANDO](https://doi.org/10.48550/arXiv.2605.24785) |
| REF-2633, ExpeL | Relevant memory needs shuffled-memory and no-memory controls; retrieval can harm outcomes. | [ExpeL](https://doi.org/10.1609/aaai.v38i17.29936) |
| REF-1658; REF-1656 | Self-correction and self-refinement are not sufficient proof of correctness. Freeze the evaluator and require external checks. | [Self-correction](https://arxiv.org/abs/2310.01798), [reward hacking](https://doi.org/10.48550/arXiv.2407.04549) |
| REF-2922 | Cross-vendor agreement is not independent ground truth. Record disagreements and use an oracle or accountable human acceptance. | [Correlated errors](https://doi.org/10.48550/arXiv.2506.07962) |
| REF-2528 | Persistent context changes alone are not learning; later-task improvement is required. Treat L1–L2 placement as conceptual, not qualification. | [Recursive self-improvement](https://doi.org/10.48550/arXiv.2609.11873) |
| REF-2933; REF-785 | General rules plus activation-loaded specifics are an analogy and hypothesis, not evidence that layered prompts improve AIWG. | [Matryoshka](https://doi.org/10.48550/arXiv.2503.17547), [absorption](https://arxiv.org/abs/2409.14507) |

The corpus audit's retention/meta-recursion gap is also issue-supplied and
unverified here. SkillOps is described as not yet inducted; it is not an
accepted dependency. MemGPT, Generative Agents, A-MEM, GEPA and Dynamic
Cheatsheet remain further-reading leads, not evidence reviewed in this task.
Before empirical conclusions, re-open the pinned
[cross-analysis](https://git.integrolabs.net/section9/research-papers/src/commit/144e35c2d6fa94171eed60dc4ba5b9d59398771d/documentation/analysis/aiwg-capability-blending-cross-analysis-2026-10-19.md),
[memory-loop recommendations](https://git.integrolabs.net/section9/research-papers/src/commit/144e35c2d6fa94171eed60dc4ba5b9d59398771d/documentation/analysis/aiwg-post-training-and-memory-loop-recommendations-2026-10-19.md)
and [collation report](https://git.integrolabs.net/section9/research-papers/src/commit/144e35c2d6fa94171eed60dc4ba5b9d59398771d/documentation/analysis/node-collation-cross-reference-2026-10-19.md),
then verify each relevant primary-source passage and its applicability.

The 2026-11-16 comment on #3318 adds REF-3177 (MutMem) and REF-3181 (PSN) and
points at corpus commit `7f92a62b99d62d14b9c3a4fe499087d654cf6234`. This
offline task did not re-open those analyses, their protocols or the primary
sources. Counts, attack rates and cost ratios in that comment are literature
reports. They are limits on what this design may copy, and they are not
deployment defaults. The comment reports that REF-3177's cited source
repositories and pinned commits returned 404, and that its poisoning
calibration reused the same 100 locked targets, so a low attack rate on that
set does not estimate unseen attacks. It reports that REF-3181 admitted 96 of
139 refactor proposals, replayed only three recent affected tasks, and rolled
back after a greater-than-20% success drop, with embodied cost about 3.5× a
comparator in a separate cohort. That drop, that replay width and that cost
ratio do not transfer to coding tasks. Closed #4205 is not reopened here.

## Verified checkout owners

These are source owners found by reading code, not inferred tracker status:

- [Maintenance contract](../../src/memory/maintenance-contract.ts) already defines
  `aiwg.maintenance-plan.v1`, typed operations, target/precondition
  id/digest/version, separate placement/lifecycle axes and protected retirement.
- [Maintenance coordinator](../../src/memory/maintenance.ts) validates exact
  owner snapshots and reviewer bindings, verifies retrieval before resident
  removal, and journals owner receipts with partial/resume handling.
  [Semantic-memory owner](../../src/artifacts/memory-maintenance.ts) retains
  source records/history and rebuilds the existing artifact index.
- [Recommendations](../../src/memory/recommend.ts) are advisory only, carrying
  evidence, uncertainty, protection exceptions, savings and retrieval impact.
- [Maintenance CLI](../../src/memory/maintenance-cli.ts) owns `memory plan`,
  `apply`, `verify`, `restore`, exact-plan confirmation and next-session effects.
  [Recommendation CLI](../../src/memory/recommend-cli.ts) owns candidate reports.
- [Offline qualification](../../test/conformance/memory-maintenance/qualification.test.ts)
  already exercises registry-derived providers and unchanged/no-memory/indexed/
  selected-context/resident baselines. These deterministic fixtures are not
  model-task evidence for the proposed H5 hypothesis.
- [Evaluation runner](../../tools/eval/src/runner.ts) supplies injectable
  `GenerationModel`, YAML cases, paired-baseline metadata and protected-artifact
  checks through [integrity utilities](../../tools/eval/src/integrity.ts).
  It does not implement a memory-update experiment or retention comparison.
  No H5-specific #3315 study was found here; integration with that issue is
  a dependency to reconcile, not a delivered runner claimed by this note.

The [memory architecture contract](../architecture/harness-memory-maintenance.md)
remains authoritative for taxonomy and provider limitations. The
[evaluator-calibration guide](evaluator-calibration.md) provides reviewer and
ground-truth discipline. No new store, schema, configuration key, CLI flag or
command is proposed here; experimental records below are reporting requirements,
not additions to existing strict v1 JSON contracts.

## Constraint-to-owner map

| ID | Constraint | Owning issue(s) and existing extension point | Required evidence / remaining boundary |
|---|---|---|---|
| C1 | Structured delta edits: add, demote, merge, retire; never whole-prompt rewrites. | #3282 lifecycle contracts/coordinator and canonical owners; #3283 selects advisory candidates; #3284 exposes owner previews. | Existing maintenance operations cover demote/merge/retire. Addition uses reviewed owner-native ingest/upsert, not a fabricated `add` maintenance operation. Keep stable identities, lineage and tombstones; preserve unrelated entries. |
| C2 | Every edit is a claim gated by an executable check, ground-truth comparison or human acceptance, versioned with rollback. | #3282 exact-version plans/receipts/history; #3284 review and confirmation; #3283 evidence/uncertainty. | Bind the chosen check or human acceptance to the exact candidate bytes and preconditions; a rationale, reviewer name or `--yes` alone does not prove semantic correctness. Existing review/confirmation machinery is not an automatic correctness evaluator. |
| C3 | Frozen vs updating vs shuffled-memory held-out experiment; measure earlier-task retention. | #3285 qualification fixtures, extending tools/eval patterns when the experiment is implemented; #3283 candidate evidence. | Add the H5 controls below to a future study, including no-memory. Existing placement baselines do not measure longitudinal learning, shuffled retrieval or retention. |
| C4 | Always-loaded general rules with activation-loaded specifics. | #3282 placement/retrieval checks; #3283 bounded-pack recommendation; #3284 activation/discovery controls. | Reuse context packs and existing rule-binding/provider owners. Moving files is not demotion if startup imports still load them. Verify activation, rare obligations and next-session projection; layering benefit remains a hypothesis. |
| C5 | Per-version prompt/memory size, contradictions and drift. | #3283 audit/cost and evidence reports; #3282 revision/receipt lineage; #3284 verify/report controls; #3285 comparative outcomes. | Record before/after bytes and estimated/measured tokens with estimator, contradiction cases and drift against the frozen version. Unknown live loading or semantic drift stays unknown, never zero. A smaller file alone cannot pass. |

### Follow-up constraints from the 2026-11-16 comment

These rows extend the same owner map. They do not add a command, schema,
config key or signature field. Authorization, continuity, freshness and
usefulness stay separate questions.

| ID | Constraint | Owning issue(s) and existing extension point | Required evidence / remaining boundary |
|---|---|---|---|
| C6 | Separate authorized mutation, chain continuity and freshness from truth or usefulness. An authentic history can still hold an incorrect belief. | #3284 reviewer plus exact plan-digest confirmation authorizes the mutation. #3282 precondition digest/version and the maintenance receipt record continuity. Freshness is the owner snapshot compared with current records at preview. #3283 evidence and #3285 scores speak only to usefulness. | A matching receipt or reviewer name does not make the belief true or useful. Do not collapse authorization, continuity, freshness and usefulness into one pass. |
| C7 | An external trusted head defines freshness. A self-contained chain does not make a replayed or forked branch current. | #3282 reads owner records and the snapshot digest under the maintenance directory lock before pending work is applied. #3284 `providerCopies.status` reports projection freshness (`current`, `stale`, `not-applicable`) and does not regenerate. | Idempotent resume of a finished plan digest returns that receipt and does not move the head. A new plan whose predecessor is older than the live records fails as stale. A valid receipt on a fork is not currency. No attestation service is added. |
| C8 | Each add, demote, merge and retire reproduces against one fixed predecessor and independently checked evidence. Keep negative evidence. | #3282 requires target and precondition to name the same revision and checks that revision against current records. #3284 binds the external check to the candidate digest (C2). Tombstones keep id, predecessor digest, disposition, reason and reviewer. #3283 can mark a candidate `conflict` or `rejected` without writing the store. | Maintenance cannot purge. A later winning revision does not delete the tombstone, retained history or rejected candidate. Tombstones are reviewer-bound records, not a new signature scheme. |
| C9 | Compare unconditional acceptance with maturity-aware gating. Localize faults in composed skills, and validate rollback on coding fixtures. Do not transfer embodied-environment results. | #3285 extends the H5 updating policy below. #3282 already distinguishes `retirementBasis` `age` and `review`, and already has a reviewed restore plan. Synthetic tool-selection fixtures stay local. | Maturity is a second predeclared gate on top of C2. REF-3181's greater-than-20% drop, three-task replay and embodied cost ratio are not deployment defaults. |
| C10 | Future evaluation includes a stale predecessor, a replayed predecessor, concurrent conflicting updates, rejected evidence, incomplete writes and rollback recovery. | #3282 already rejects a stale precondition, refuses a second plan while the directory lock is held, journals a `partial` receipt with `resumedFrom`, and verifies restore. #3283 retains the rejected candidate. #3285 runs the vectors below as offline fixtures. | These cases score integrity only. They reuse existing errors and receipts. |
| C11 | Report integrity conformance separately from downstream utility, retention, maintenance cost and negative transfer. | #3285 reporting, next to the H5 measures in this note. #3283 cost and evidence stay in the cost block. | The five blocks are not summed. An integrity pass is not a utility gain. A utility gain with a failed integrity vector is a failed run. |

## Delta review, versioning and rollback

1. Identify the owner, scope, source digest/version and exact proposed delta.
   Restrict updates to authorized memory or canonical instruction entries;
   hidden provider system prompts and running sessions are outside this contract.
   Keep general safety/authority rules fixed. Preserve unaffected entries, source
   links and trust; promotion never grants higher instruction authority.
2. Treat the proposal as a falsifiable claim: specify expected later behavior,
   impacted obligations and a check that can reject it. Bind command/result and
   test/fixture digests, ground-truth version or explicit human acceptance to the
   reviewed candidate digest. Model self-approval and reviewer agreement alone
   are insufficient. Store references with existing review evidence; do not add
   unsupported fields to the v1 plan. Missing proof leaves the proposal pending.
3. Use existing owner-native preview/confirmation for add; use maintenance
   `plan` for demote/merge/retire. Bind target/precondition digest/version and
   owner snapshot. Apply only the accepted version, then verify receipt and
   source/index disposition. Reject stale inputs; review a fresh preview instead
   of silently reusing old acceptance. One operation per owner snapshot means
   multiple revisions need sequential plans, not a monolithic rewrite.
4. Demotion requires successful indexed retrieval before resident removal.
   Retirement retains source, tombstone, reason and reviewer while ordinary
   retrieval and regenerated projections exclude it. Block rediscovery from
   reactivating the same disposed identity without explicit reviewed restore.
   Do not purge or silently prune pinned/rare obligations. Default line-memory
   and compound-memory resident removal is currently refused because their
   owner-native indexed proof is unavailable; do not bypass that limitation.
5. Keep plan/receipt references and retained versions for rollback. For retire,
   create a fresh `restore` plan against the current revision, review/confirm,
   restore, then verify. For demote, use a reviewed inverse placement plan only
   where the owner supports it. Merge/add reversal is owner-specific: use
   retained originals and lineage to preview compensating deltas; if safe
   inversion is unsupported, stop for owner disposition. There is no universal
   automatic whole-store rollback. Do not replace the store with an old snapshot
   over intervening work. Owner history may be bounded; verify recoverability
   before acceptance rather than treating a digest as retained content.
6. Report partial receipts as partial, recover the exact pending transaction
   through the existing coordinator and verify the resulting state. Canonical
   provider projection changes require the existing regeneration owner and
   a new session; a successful source write is not live-load proof.

For each accepted version, retain an experiment/report row referencing the
owner's record version, source and plan/receipt digests, predecessor, delta and
gate evidence. Record prompt and memory UTF-8 bytes separately, token counts
with estimator/version/confidence, active/indexed/retired counts, activation
paths, contradiction findings and unresolved count, changed protected rules,
source-to-projection drift, and held-out/retention changes. Keep bodies out of
summary logs. Contradiction checks combine executable incompatible-fact fixtures
with human review for unstructured claims; they cannot certify all semantics.
Unavailable observations and unmeasured semantic drift must be explicit.

## H5 experiment plan (proposed)

**H5 hypothesis:** evidence-gated, persistent delta updates improve later
held-out task completion over a frozen structured store without losing earlier
task performance. Relevant updates should outperform shuffled-memory and
no-memory controls. Persistence without later improvement is not learning.
The plan below is a research proposal, not a benchmark result or run approval.

**Freeze before collection.** Pin the initial store/general prompt, updater
policy, source/fixture/scorer digests, model/version, generation parameters,
retriever/pack builder, context budget, maximum accepted deltas and random seeds.
Use three synthetic task families: code repair with executable tests,
instruction/rare-obligation adherence, and tool selection using fake local tools.
Start with 60 tasks per family: 20 adaptation, 20 later held-out and 20 earlier
tasks for retention. Earlier tasks have a baseline pre-test but neither their
labels nor their evaluation feedback can enter adaptation. Split by source
template/topic as well as task ID; reject semantic near-duplicates across
splits. Gold answers, hidden tests and evaluators are outside updater access.
Choose five fixed seeds and paired task ordering for all arms. This is a pilot
size, not a power claim; set any larger sample before opening held-out outcomes.

| Arm | Memory/update treatment |
|---|---|
| frozen | Initial structured store with relevant retrieval; no accepted deltas. |
| updating | Same initial store; evidence-gated add/demote/merge/retire during adaptation only. Freeze each checkpoint before evaluating it. |
| shuffled-memory | At each checkpoint use updating's same eligible specific-memory pool, but assign packets to unrelated tasks using a seeded derangement within task-family/token-length strata. Keep fixed general rules identical. |
| no-memory | Same general rules and task input, with specific-memory retrieval disabled. |

Shuffling is content reassignment, not merely reordering the relevant packet.
Match specific-memory item count, token budget, format and invocation timing to
updating. Predefine neutral padding for small length differences; never truncate
protected rules to match lengths. Reject a shuffle with topical overlap, a
self-assigned packet or an unmatched stratum and report it as invalid, not as a
zero score. Log seed, permutation and packet digests. The shuffled arm receives
the paired checkpoint pool without gold/task labels and cannot write updates;
this isolates relevance rather than testing a different updater policy.

**Gating contrast.** The primary `updating` arm is maturity-aware: a delta is
eligible only after the C2 check and a second predeclared condition, such as
`retirementBasis: review` or a second independent fixture check on the same
candidate bytes. A paired unconditional treatment accepts every C2-passing
delta during adaptation, with the same seeds, item counts and ceilings.
Report unconditional minus maturity-aware on held-out completion and on
retention. Neither treatment may use a greater-than-20% success drop or a
three-recent-task replay as its gate. In the synthetic tool-selection family,
at least one composed-skill case has a single wrong component, and the report
names that component. Rollback uses the existing restore-and-verify path on
these coding fixtures. Embodied-environment results are not treated as
evidence for that path.

**Integrity vectors.** Run these with deterministic local fixtures before any
model arm. A rejecting vector leaves the prior revision in place.

| Vector | Expected existing behavior | Integrity result |
|---|---|---|
| stale predecessor | Precondition digest or version differs from current records (`Stale memory digest or version precondition`, or a stale owner snapshot). | Reject. No apply. |
| replayed predecessor | A new plan names an older revision after a newer commit, or a fork presents an old receipt as the current head. | Reject as stale. The receipt does not establish currency. Idempotent resume of the same finished plan digest returns that receipt and does not apply again. |
| concurrent conflicting updates | Another plan targets the same owner snapshot while the directory lock is held, or it is reviewed after the winner commits. | Lock refusal (`Concurrent maintenance plan owns the workspace lock`), or a stale snapshot on the loser. One operation per owner snapshot. |
| rejected evidence | The independent check fails, or the recommendation status is `rejected`. | Store unchanged. Keep the rejected candidate and its evidence. |
| incomplete write | Apply stops after a committed owner mutation. | `partial` receipt, pending keys explicit, resume from the same plan digest, then verify. |
| rollback recovery | Reviewed `restore` against the current revision, then verify. | Source, tombstone and projection match the restored plan. A missing exact version stops the run. |

**Separate reports.** Publish five blocks that cannot be added together:
integrity conformance (pass or fail per vector above); downstream utility
(the held-out completion contrasts); retention (`retention_delta_pp` and
paired regressions); maintenance cost (tokens, latency, accepted and rejected
deltas); negative transfer (updating minus shuffled-memory, and any earlier
task that passed before adaptation and fails after). Negative transfer can
occur while held-out utility rises. Integrity does not imply utility.

**Sequence and isolation.** Run each arm/seed from a fresh temporary HOME and
project (os.tmpdir + mkdtemp), fake local CLI/MCP/HTTP fixtures and reset caches.
Pre-test earlier tasks at version zero, adapt on the adaptation split only,
then checkpoint after each accepted delta (maximum 10 per seed in this pilot).
Evaluate both held-out and earlier tasks at each checkpoint with no updates
during evaluation. Keep results hidden from the updater; no selecting a best
checkpoint from test scores. The final adaptation checkpoint is the primary
endpoint; intermediate checkpoints diagnose forgetting. Freeze comparators
throughout and predefine equivalent token/call/time ceilings. No paid or live
calls belong in the offline pilot.

**Measures and decision rule.** Use executable ground-truth task completion,
not self-reported quality or file-size reduction, as the primary binary outcome.
Record per-task scores, errors/timeouts (failures, not dropped rows), relevant
retrieval recall, stale/retired hits, activation, protected-rule adherence,
source survival, total prompt/memory tokens, latency and accepted/rejected deltas.

- Later-task effect: mean paired completion difference, updating minus frozen;
  also report updating minus shuffled-memory and updating minus no-memory.
- Retention: `R_before` and `R_after` are completion rates on the identical
  earlier tasks before adaptation and at a checkpoint. Report
  `retention_delta_pp = 100 * (R_after - R_before)` in percentage points, per family and
  aggregate, plus paired regressions (previous pass becoming fail). Example:
  18/20 to 17/20 is -5 percentage points; source survival alone is not retention.
- Drift/contradictions: compare every checkpoint with version zero and its
  predecessor using the per-version observations above; record unresolved cases.
  Test retire/restore and attempted rediscovery explicitly.
- Compute 95% confidence intervals from 10,000 paired bootstrap resamples of
  task-template clusters, preserving arms and seed repeats within each cluster.
  Repeated seeds are not independent new tasks. Report family-level results;
  no cherry-picking a favorable family or checkpoint.

Proposed pilot criteria, to preregister before collection: the lower confidence
interval bound for each of the three final held-out contrasts is greater than
zero; retention's lower bound is at least -5 percentage points per family;
protected-obligation adherence and source survival are 100%; retired ordinary
retrieval hits and unresolved critical contradictions are zero; declared cost
and context ceilings hold. These are design choices, not literature-established
thresholds. All must pass to justify a larger study. Wide intervals, missing
evidence or invalid controls mean inconclusive/HOLD, not improvement.

**Evaluator and stop policy.** Freeze a trusted external scorer and hidden
gold/tests; hash them before/after, using the existing tools/eval integrity
pattern. The updater cannot edit tests, scorer, gold, logs or evaluation policy.
For outcomes without executable ground truth, require blinded human scoring
against a frozen rubric with disagreements adjudicated and retained. Record
evaluator/model/vendor/family if a model advises reviewers; shared errors remain
possible across vendors. Any evaluator edit, leakage, authority change, lost
protected obligation, unsafe rollback or unavailable exact-version proof stops
the affected run, preserves evidence and holds the update. Report failed and
stopped runs as well as successful ones.

**Implementation handoff.** Reuse tools/eval's injectable model/case/scoring
pattern and integrity metadata, with deterministic synthetic responses for the
offline dry run; the current runner has no four-arm longitudinal scheduling or
paired retention report. Extend existing owners/test lanes under #3285 and
reconcile #3315 before implementing that scheduling. The current runner's
aggregate release-gate score is not this H5 acceptance decision. Do not add a
new benchmark service, live-qualification framework or store. A later model
study needs separately authorized collection and verified source passages.

## Acceptance and remaining questions

- Design mapping: C1–C5 assign the original issue constraints, and C6–C11
  assign the 2026-11-16 authenticity, freshness, negative-evidence, gating,
  fault-vector and separate-reporting constraints, to #3282–#3285. Current
  mechanisms stay separate from proposed semantic and evaluation gates.
  No new command, schema, config key or signature field is added.
- Experiment plan: H5 keeps frozen, updating, shuffled-memory and no-memory
  arms, held-out isolation, the longitudinal retention metric and falsifiable
  criteria. It also compares unconditional and maturity-aware gating, lists
  six offline integrity vectors, and splits integrity conformance from
  utility, retention, maintenance cost and negative transfer.
- Remaining empirical questions: does layering help after counting startup
  imports; what contradiction checks generalize beyond fixtures; what sample
  size supports the chosen retention margin; and how will #3315 expose the
  required paired records? None is claimed resolved by this design note.
  Cryptographic signatures on negative evidence are not proposed; whether a
  later issue needs them is open.
- Primary-source re-verification and experiment execution remain pending,
  including REF-3177 and REF-3181. This deliverable creates neither a runtime
  updater nor measured evidence.
