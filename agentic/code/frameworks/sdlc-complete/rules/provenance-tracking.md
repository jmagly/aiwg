---
enforcement: high
---

# Provenance Tracking Rules

**Enforcement Level**: HIGH
**Scope**: All artifact generation (documents, code, agents, commands, skills)
**Version**: 1.0.0

## Overview

W3C PROV-compliant provenance tracking for all AIWG artifacts — an auditable derivation chain for reproducibility, attribution, and quality verification — via the PROV-DM **Entity** (artifact) / **Activity** (operation) / **Agent** (who/what performed it) model.

## Mandatory Rules

### Rule 1: Record Provenance for All Generated Artifacts
Every generated artifact MUST have a provenance record in `.aiwg/research/provenance/records/` capturing `entity`, `activity`, `agent`, and `relationships.wasGeneratedBy`. Never create/commit an artifact with no record.

### Rule 2: Use @-Mentions to Record wasDerivedFrom
Every artifact MUST include a References section listing its sources as `@`-mentions (e.g. `@.aiwg/requirements/use-cases/UC-104.md - Source requirement`). These @-mentions MUST match the `wasDerivedFrom` entries in the provenance record. **FORBIDDEN**: content with no source references.

### Rule 3: Bidirectional Provenance Chains
When creating a derived artifact, record BOTH directions. The derived artifact references its sources (`@implements`, `@schema`, `@tests` in headers), AND the source artifact is updated to reference the new artifact (e.g. an Implementation section linking the new code/tests). **FORBIDDEN**: forward-only links.

### Rule 4: Record Agent Attribution
Every generated artifact MUST record which agent created it via `agent` (id + type + version, optionally `tool`) and `relationships.wasAssociatedWith` (linking activity → agent).

### Rule 5: Timestamp All Activities
Every `activity` MUST record `started_at` and `ended_at` (ISO-8601); `duration_seconds` recommended.

### Rule 6: Use URN Schema for IDs
All provenance IDs MUST use the consistent URN format below. **FORBIDDEN**: ambiguous, machine-specific, or opaque IDs (`some-file.md`, `/abs/path`, `123abc`).

| Element | Format |
|---------|--------|
| entity | `urn:aiwg:artifact:<project-relative-path>` |
| activity | `urn:aiwg:activity:<type>:<artifact-name>:<sequence>` |
| agent | `urn:aiwg:agent:<agent-name>` |

### Rule 7: Document Derivation Chains
When an artifact derives from multiple sources, record ALL of them under `relationships.wasDerivedFrom`, each entry carrying `source` (a URN) and `derivation_type`. **FORBIDDEN**: recording only one source when several apply.

## Artifact Type Requirements

All types require a provenance record in `.aiwg/research/provenance/records/` named `<artifact-name>.prov.yaml`, plus type-specific in-content links:

- **Documents (.md/.yaml/.json)**: References section with @-mentions; frontmatter `created`/`created_by`/`derived_from` where applicable.
- **Code (.ts/.js/.py)**: file header with `@implements`/`@schema`/`@tests`/`@created`/`@agent`.
- **Tests**: header with `@source` (implementation under test), `@requirement`, `@created`, `@agent`.
- **Agent definitions**: Metadata section (Created, Agent Type, Version) + References section.

## Validation Checklist

- [ ] Provenance record created in `.aiwg/research/provenance/records/`
- [ ] Entity ID uses correct URN format
- [ ] Activity timestamps recorded (started_at, ended_at)
- [ ] Agent attribution included
- [ ] wasDerivedFrom documents all sources with derivation types
- [ ] @-mentions in content match the record
- [ ] Bidirectional links established (forward and backward)

## Derivation Type Vocabulary

| Type | Meaning |
|------|---------|
| `implements` | Code implements requirement |
| `conforms_to` | Artifact follows schema |
| `follows_pattern` | Artifact uses a template |
| `extends` | Artifact extends a base |
| `tests` | Test verifies code |
| `documents` | Documentation describes code |
| `refines` | Refines an earlier version |
| `derives_from` | General derivation (type unclear) |

## Activity Type Vocabulary

| Type | Description | Example |
|------|-------------|---------|
| `generation` | New artifact created | First creation of document |
| `modification` | Existing artifact updated | Editing existing file |
| `refactoring` | Code restructured | Rename, reorganize |
| `testing` | Tests written/executed | Creating test file |
| `review` | Artifact reviewed | Code review, quality check |
| `merge` | Artifacts combined | Merging branches |
| `derivation` | Derived from sources | Creating from template |
| `validation` | Artifact validated | Schema validation |

## Agent Type Vocabulary

| Type | Description | Example |
|------|-------------|---------|
| `ai_assistant` | Base LLM (Claude, GPT) | `claude-sonnet-5` |
| `aiwg_agent` | AIWG specialized agent | `software-implementer` |
| `human` | Human developer | `developer@example.com` |
| `automated_tool` | Script or CLI tool | `eslint`, `prettier` |
| `ci_system` | CI/CD pipeline | `github-actions` |

## Enforcement & Exceptions

Enforced at artifact-creation, code-review, audit, and release time. Exceptions (document in `.aiwg/research/provenance/docs/exceptions.md`): temp files (`.aiwg/working/`, `/tmp`), auto-generated outputs from tracked sources, external code (track at integration point). When in doubt, record MORE.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/provenance/prov-record.yaml - PROV record schema
- @.aiwg/research/provenance/docs/provenance-guide.md - Detailed guidance
- @.aiwg/research/provenance/examples/artifact-creation.yaml - Example record
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/mention-wiring.md - @-mention wiring
- @https://www.w3.org/TR/prov-dm/ - W3C PROV-DM spec

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-01-25
**Issue**: #104
