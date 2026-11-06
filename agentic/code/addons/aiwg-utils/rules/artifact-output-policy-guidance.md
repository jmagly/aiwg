---
name: artifact-output-policy-guidance
description: Supporting rationale and examples for artifact-output-policy
enforcement: low
activation: on-demand
---

# artifact-output-policy — guidance

Authority: `aiwg show rule artifact-output-policy --body` (kernel). This companion supplies supporting explanation; the complete imperative core is self-contained in that rule.

## Destination example

A review can remain canonical in the AIWG artifact store while an explicitly selected presentation is exported to Claude Design. The export provenance links back to the review; an unavailable destination yields a diagnostic.

## Template examples

For a bug report, read the issue skill's "Output template" section and load
`templates/issues/bug-report.md` from aiwg-utils. Preserve "Steps to reproduce"
and "Acceptance criteria" and fill them with observed facts. For an unrelated
section, retain its heading and write "Not applicable: <reason>".

For a PR, load `templates/pull-requests/description.md` from aiwg-utils and record
the exact verification commands and observed pass/fail counts. Issue comments
use the relevant SDLC `templates/issue-comments/` template.

If discovery finds no template for a report, state "No template exists for this
output; using free-form" before writing it. Compose/delivery warnings list missing
required headings without blocking headless workflows; optional headings may be
omitted. These checks detect structure, not whether the content is factual.

## Policy rationale

Provider presentation defaults can change independently of project storage. Keeping the canonical artifact and derived presentation separate preserves durable review history.
