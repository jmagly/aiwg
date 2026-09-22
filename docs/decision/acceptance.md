# Primitive-aware acceptance

Primitive acceptance keeps provider values, distributions, native confidence,
derived statistics, and calibrated risk separate. Policies use exact
basis-point comparisons and explicit routes; an acceptance result is evidence,
not action authorization. Quantized probabilities and ties therefore require
declared review behavior, and confidence must not be described as correctness.

## Governed rollout evidence

`replayAcceptancePolicyShadow()` compares incumbent and candidate immutable
policies against stored observations only. Its record is use-case scoped,
retains each observation digest and both dispositions, and is explicitly marked
`actionAuthorization: not-authorized`. `createAcceptancePromotionRecord()`
requires that exact shadow record, an approval reference, a digest-pinned D11
qualification manifest, and the incumbent policy as the rollback pin.

The checked-in D08 release manifest under
`test/fixtures/decision/acceptance/release/` retains C08–C10 and
TV-03/04/05/11 evidence beyond a temporary qualification run.
