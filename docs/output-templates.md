---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.output-templates
---

# Default output templates

Use `aiwg discover "<phrase>" --type template` to select the default, then
`aiwg show template <id> --body` to read it. Fill every required section with
observed facts; explain non-applicable sections and identify unrun checks.

A template declares one `outputKind` string in YAML frontmatter. Short aliases
belong in the existing `aliases` or `triggers` lists; the index merges them into
triggers. An exact query for the declared kind (dots, hyphens, underscores and
spaces are interchangeable) or a declared phrase ranks that template above
ordinary exact names and lexical matches. Other queries keep ordinary discovery
ranking. Scope breaks equal-score ties, so project defaults can override packaged
defaults. Declare only one default per kind within a scope. This priority applies
when `--type` includes `template`; unfiltered discovery preserves exact-name
priority. A trailing `template` or `templates` token is ignored when matching a kind.

Generic tracker, message, handoff and report formats belong to `aiwg-utils`.
Testing and evaluation records belong to `testing-quality`. Existing SDLC and
operations templates retain their owners and bodies. `status update` selects an
issue progress comment; `status report` selects the stakeholder report. An audit
report uses the gate audit record; domain audits can use their specialized forms.
Checkpoint handoffs keep their own template for the CLI's fixed sections.

| Output kind | Default template | Canonical query / short aliases |
|---|---|---|
| `issue.bug` | [bug-report](../agentic/code/addons/aiwg-utils/templates/issues/bug-report.md) | `bug report issue`; `bug report`; `bug issue` |
| `issue.feature` | [feature-request](../agentic/code/addons/aiwg-utils/templates/issues/feature-request.md) | `feature request issue`; `feature request` |
| `issue.imported` | [imported-report](../agentic/code/addons/aiwg-utils/templates/issues/imported-report.md) | `imported issue`; `imported report` |
| `issue.comment.progress` | [progress-update](../agentic/code/frameworks/sdlc-complete/templates/issue-comments/progress-update.md) | `issue progress update comment`; `status update`; `progress update`; `issue comment progress` |
| `issue.comment.blocker` | [blocker-found](../agentic/code/frameworks/sdlc-complete/templates/issue-comments/blocker-found.md) | `blocker comment`; `blocker found`; `issue comment blocker` |
| `issue.comment.completed` | [task-completed](../agentic/code/frameworks/sdlc-complete/templates/issue-comments/task-completed.md) | `issue completion comment`; `task completed`; `issue comment completed` |
| `pull-request` | [description](../agentic/code/addons/aiwg-utils/templates/pull-requests/description.md) | `pull request description`; `pull request`; `PR` |
| `commit-message` | [commit-message](../agentic/code/addons/aiwg-utils/templates/commit-message.md) | `commit message`; `commit` |
| `worker-brief` | [subagent-brief](../agentic/code/addons/aiwg-utils/templates/subagent-brief.md) | `subagent worker delegation brief`; `worker brief`; `delegation brief` |
| `report.ci-failure` | [ci-failure-report](../agentic/code/addons/testing-quality/templates/ci-failure-report.md) | `flaky test or CI failure report`; `CI failure report`; `flaky test report` |
| `experiment.amendment` | [experiment-amendment](../agentic/code/addons/testing-quality/templates/experiment-amendment.md) | `experiment protocol amendment`; `experiment amendment`; `protocol amendment` |
| `report.audit` | [gate-audit-record](../agentic/code/addons/testing-quality/templates/gate-audit-record.md) | `evaluation gate audit record`; `gate audit record`; `audit report`; `audit record` |
| `handoff` | [agent-handoff](../agentic/code/addons/aiwg-utils/templates/agent-handoff.md) | `agent handoff note`; `agent handoff`; `handoff` |
| `report.status` | [stakeholder-status-report](../agentic/code/addons/aiwg-utils/templates/stakeholder-status-report.md) | `status report for stakeholders`; `status report`; `stakeholder status report` |
| `report.review` | [code-review-findings](../agentic/code/addons/aiwg-utils/templates/code-review-findings.md) | `code review findings report`; `code review findings`; `review report` |
| `report.security` | [security-finding](../agentic/code/addons/aiwg-utils/templates/security-finding.md) | `security finding report`; `security finding`; `security report` |
| `report.incident` | [incident](../agentic/code/frameworks/ops-complete/templates/incident.md) | `incident postmortem`; `incident report`; `incident` |
| `decision-record` | [adr-template](../agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md) | `architecture decision record`; `decision record`; `ADR` |
| `change-request` | [change-request-card](../agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md) | `infrastructure or host change request`; `change request`; `host change request` |
| `release-notes` | [release-notes-template](../agentic/code/frameworks/sdlc-complete/templates/deployment/release-notes-template.md) | `release notes` |
| `handoff.checkpoint` | [checkpoint-handoff](../agentic/code/addons/aiwg-utils/templates/checkpoint-handoff.md) | `checkpoint handoff`; `session handoff` |


`test/fixtures/artifacts/template-output-kinds.json` fixes the probe phrases.
`test/unit/artifacts/template-output-kinds.test.ts` checks first place and the
output-kind score floor against a fresh corpus build and the shipped prebuilt
index. It also checks the producing skills' template references.

After changing source templates, run `npm run package-plugins`, then rebuild the
packaged index with `npm run release:fortemi-index`. The existing metadata export
retains `outputKind` and merged triggers; no separate template registry or
frontmatter schema is required.
