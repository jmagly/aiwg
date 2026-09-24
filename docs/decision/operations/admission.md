# Admission storm and load-shedding runbook

`RUN-JEV-ADMISSION-v1` covers a provider or client storm that the D05 admission
controller is shedding, and any change to a scheduler profile made in response.
It extends `RUN-JEV-OUTAGE-v1`: use that runbook to disable a live binding, and
this one to change or restore admission limits. Both preserve receipts,
attempt admission evidence, and breaker history.

## Trigger and ownership

- Triggers: a rising `decision.throttles` count by `aiwg.admission.reason`
  (`queue-full`, `queue-timeout`, `requests-per-minute`, `tokens-per-second`,
  `circuit-open`), `decision.breaker_transitions` to `open`, sustained
  `aiwg.retry.pressure`, or queue delay near the profile's `maxQueueWaitMs`.
- Owner: decision-platform on-call leads the response.
- Approver: any profile change needs approval from a second decision-platform
  owner who is not the responder. Record the approver and change ticket in the
  host audit log next to the profile-change record.

## What the controller already sheds

Admission rejects or defers before any adapter call, so shed work is recorded
as not sent, with a typed reason and admission evidence on the attempt.
`queue-full` rejections are retryable, and their bounded `retryAfterMs` hint is
jittered. Queue expiry, deadlines, and invalid or oversized estimates are
permanent. Per-principal share caps (`maxPrincipalShare`) keep one noisy
principal from filling a shared queue, and `reservedConcurrency` keeps quiet
principals' capacity available. An open breaker defers work on that provider
lane only. Do not raise limits during a storm to make shedding stop.

## Containment

1. Confirm the storm from metrics and `decision.admit` spans. Identify the
   affected provider lane and reason. Metrics carry no principal or workspace
   identity; use the host's own audit records if a scope must be identified.
2. Prepare a tightened profile under a **new** `profileVersion`, for example
   with lower `concurrency`, `requestsPerMinute`, `maxQueueLength`, or
   `maxPrincipalShare`. Reusing an existing revision with different limits
   fails closed and is not a way to change limits.
3. Obtain approval, then publish the new revision. The registry emits a
   `decision-admission-profile-change/v1` record of kind `change`, holding the
   previous and new revision and a content digest. Store it with the approval.
4. Queued work is revalidated against the new profile before dispatch.
   In-flight calls finish under their existing leases.
5. If the provider itself is failing, follow `RUN-JEV-OUTAGE-v1` to disable
   the live binding or set `enabled: false` at a run boundary.
6. Preserve evidence. Keep durable receipts, attempt `admission` evidence
   (including `breakerTransitions`), the controller's breaker history, and the
   profile-change records. Never delete them to reset counters.

## Recovery and rollback

1. Wait until the breaker has closed through a successful half-open probe and
   the throttle rate is below the alert threshold.
2. Roll back at a run boundary by registering the previous `profileVersion`
   again. The registry emits a record of kind `rollback` whose digest equals the
   digest recorded when that revision was first used. A digest mismatch means
   the restored limits are not the approved ones; stop and investigate.
3. Record the rollback approval with the rollback record.

## Exit verification

- `decision.throttles` and `queue-timeout` rates are back below alert
  thresholds, and the breaker is `closed`.
- The profile history shows `initial`, `change`, and `rollback` in order, and
  the rollback digest matches the approved revision.
- A bounded canary admits at the restored capacity.
- Receipts and breaker history from the storm are still present.

## Tabletop drill

`DRILL-ADMISSION-STORM-v1` runs offline in
`test/unit/decision/scheduler-admission-drill.test.ts` against a real
admission registry and controller with an injected clock. It checks each step
above in order:

| Step | Expected result |
|---|---|
| provider-failures | the breaker opens at its failure threshold and records `closed` to `open` |
| load-shed | excess work is rejected as `queue-full` with a bounded, jittered retry hint |
| approved-profile-change | a new revision produces a `change` record; the tightened ceiling holds |
| evidence-retained | breaker history survives the profile change |
| previous-profile-restored | re-registering the prior revision produces a `rollback` record with the original digest |
| capacity-restored | the restored ceiling admits a canary at full capacity |

The drill report contains logical identifiers, reasons, and digests only.
