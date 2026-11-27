---
id: FT-payments-v2
kind: release
value_type: boolean
dynamism: per-request
lifetime: temporary
owner: Payments team
service: payments
live: true
default_value: false
default_rationale: Retain the current payment path on evaluation failure
requirements:
  - REQ-PAY-12
  - US-PAY-9
removal_criteria: All cohorts migrated and payment error rate under agreed threshold
removal_criteria_met: true
removal_task: TASK-PAY-19
review_by: '2026-11-20'
code_removed: false
---

# Feature Toggle Card

## Targeting and rollout

Internal cohort, then 5%, 25%, 100%; expand on healthy payment metrics.

## Metrics and rollback

Revert to false if error rate exceeds 1%; Payments on-call verifies current path.

## Test plan

TC-PAY-1 current production false; TC-PAY-2 upcoming true; TC-PAY-3 evaluation error returns false; evaluation context customer cohort.
