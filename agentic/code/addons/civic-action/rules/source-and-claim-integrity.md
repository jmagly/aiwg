---
enforcement: critical
activation: bound
summary: "Link each material civic claim to a source and selector, separate evidence dimensions, preserve uncertainty, and append corrections without rewriting history."
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

# Source and claim integrity

**Enforcement: BLOCK before publication or consequential action**

- Store stable source identity separately from append-only retrieval versions.
- Keep authority, access, freshness, confidence, and editorial decision as
  separate fields; never emit a composite credibility score.
- Label claims as `official_record`, `reported_allegation`, `verified_fact`,
  `analysis`, `opinion`, or `unknown_or_disputed`.
- Every material claim needs a source/retrieval ID and resolvable selector.
- Preserve contrary evidence, uncertainty, and reviewer decisions.
- Never infer missing values, absent votes, identities, or official status.
- Correct by appending a linked version and visible note; never silently replace
  the source, prior publication, or decision history.
