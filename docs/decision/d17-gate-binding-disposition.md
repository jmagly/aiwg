# D17 gate binding parity (#2835)

The D17 adapter evaluates the historical descriptive measurements with the
shipped `evaluateGates` implementation. `gate-policy.ts` owns the parameter
values; `protocol.ts` projects those values into the unchanged frozen v1
protocol. Native deltas retain their original units and floating-point values.
Rounded interval bounds retain their historical rounding; the gate adapter
does not recalculate intervals, fit calibration or assert new observations.

The protocol schema governs shape, methods and closed fields. Numeric policy
values no longer appear as duplicated schema constants. `validateD17Analysis`
still requires exact canonical equality with a private frozen protocol snapshot,
including when an analysis/v2 artifact embeds it or native templates reference
its paired thresholds. Mutating the exported projection cannot redefine that
snapshot. A changed binding is an
explicit diagnostic experiment, not acceptance of a changed frozen protocol.

The legacy binding uses an explicit project-floor opt-out so ambient project
configuration cannot change replay. Its synthetic replay timestamp and sealed
binding digest are adapter inputs, not a new operator approval or evidence of
historical first access. Existing scoring checks continue to verify corpus,
gold, preregistration, source pins, execution receipts and calibrated contexts.

Both v1 and staged v2 study scoring apply `d17StudyDecision` after evaluation.
Its independent HOLD ceiling applies even when every gate passes and the
binding permits PROMOTE. Integrity ROLLBACK and compromise remain effective.
The study retains its original release-gate/compromise-label integrity policy;
it does not silently adopt additional allowlist/state rules from raw gate reports.
The separately anchored D09/native promotion route remains separate; it never
changes the diagnostic study verdict. Existing report/v2 compatibility fields
(`gates.source`, `gateBinding: null`) retain their historical representation.
The evaluated binding/report are available through the adapter API.

## Retained artifact disposition

No pre-existing frozen artifact or study golden bytes were rewritten. No frozen
#2876 fragment covers `D17StudyProtocol`; no fragment/manifest digest changed.
`test/fixtures/decision/ensemble/d17-gate-parity.v1.json` is new evidence captured
from the pre-migration implementation at
`d88d04e401f658c10e0845b88610aafb100d2c73`. It records the exact protocol and
20 historical synthetic statistics scenarios individually: unchanged,
additional cost, non-inferiority, benefit, native quality, slice support/harm,
accepted risk, coverage, abstention, Brier bootstrap, latency p95, inclusive
caps, native cost/tokens/latency/calibration, unknown tokens, missing and empty
pairs. Each case pins findings, statistical verdict, benefit, study verdict,
canonical statistics digest and ordinary JSON serialization digest.
The existing qualification fixture manifest registers this new file and its
raw byte digest. Its prior records and digests are unchanged; formatting is
compacted to one record per line to keep that existing owner below 500 lines.
The exact fixture inventory and provenance assertions are unchanged.

The existing corpus, split and gold pins stay unchanged. As already documented
in `ensemble-heldout-study.md`, source-derived analysis, preregistration and
unapproved template pins change when runtime/schema bytes change. Reproduce
old approvals at their original source revision; a current source-derived
template requires its own preregistration and approval. No approval, frozen
bundle, calibration artifact or collected result was regenerated here.

The dedicated binding mutation test must fail when statistics ignore the
supplied binding. The independent ceiling test must fail when its HOLD ceiling
is removed. Both safeguards are restored before the complete verification run.
The existing D17 staged slow suite separately verifies that native D09
promotion can succeed while its supporting study report remains HOLD.
