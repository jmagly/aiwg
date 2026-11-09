---
enforcement: critical
activation: bound
summary: "Require an independent named human to approve the exact artifact hash before civic publication or external action; retain the review record and blocking findings."
bound_to:
  skills:
    - civic-newsroom-plan
    - civic-publish-gate
    - editorial-correction-review
    - local-resource-index
    - public-meeting-reconcile
    - public-records-plan
    - public-technology-review
    - source-compliance-gate
  agents:
    - citation-editor
    - civic-newsroom-operator
    - correction-editor
    - news-caster
---

# Publication and external-action human review

**Enforcement: BLOCK**

A named human who did not author the generated output must approve the exact
artifact version/hash before recording, records-request transmission, appeal,
outreach, public indexing of sensitive material, publication, speaker identity,
official vote labeling, correction release, or legal/compliance assertion.

The decision records reviewer and role, artifact hash, jurisdiction profile,
questions and evidence reviewed, redactions, decision, conditions, timestamp,
and expiry. A checkbox without access to underlying sources is not approval.

Machine `block` findings remain blocking. Only a separately authorized policy
exception may waive a waivable result; covert recording, access-control bypass,
anti-targeting, threats, and impersonation are non-overridable.
