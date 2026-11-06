# Data Contract

## Metadata

- ID: DES-DATA-`id`
- Owner: API Designer (docs/agents/sdlc/api-designer.md)
- Contributors: System Analyst (docs/agents/system-analyst.md), Implementer (docs/agents/software-implementer.md)
- Reviewers: Architecture Designer (docs/agents/architecture-designer.md)
- Team: `team`
- Stakeholders: `list`
- Status: `draft/in-progress/blocked/approved/done`
- Dates: created `YYYY-MM-DD` / updated `YYYY-MM-DD` / due `YYYY-MM-DD`
- Related: UC-`id`, REQ-`id`, DES-`id`, TEST-`id`
- Links: `paths/urls`

## Related templates

- agentic/code/frameworks/sdlc-complete/templates/analysis-design/interface-contract-card.md
- agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-acceptance-template.md

## Endpoint / Interface

- Name/Path: `GET /api/v1/...`
- Version: v`major.minor`

## Schema Authority

- Logical name:
- Stable schema ID:
- Version and lifecycle:
- Canonical authority path:
- Owner:
- Producers and consumers:
- Compatibility mode and baseline:
- Fixture paths (valid/invalid):
- Projections:
- Catalog/domain manifest:

If this data is persistent, exchanged, configured, queued, evented,
imported/exported, or structured user input, these fields are required. A prose
shape or example is not the contract. An opt-out requires an ephemeral internal
boundary, owner, rationale, and review date.

## Request Example (validated by the canonical schema)

```json
{
  "field": "type",
  "required": true
}
```

## Response Example (validated by the canonical schema)

```json
{
  "data": {},
  "meta": {}
}
```

## Constraints

- Validation rules
- AuthZ/AuthN
- Rate limits
