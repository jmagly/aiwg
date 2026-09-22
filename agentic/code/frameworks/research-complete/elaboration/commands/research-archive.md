---
description: Package, version, and backup research artifacts following OAIS standards
category: research-management
argument-hint: [--version <tag>] [--format <type>] [--destination <path>]
allowed-tools: Bash, Read, Write, Glob
model: claude-sonnet-5
---

# Research Archive Command

## Task

Package research artifacts into versioned archives for long-term preservation. Follows OAIS (Open Archival Information System) standards for digital preservation.

When invoked with `/research-archive [options]`:

1. **Collect** all research artifacts
2. **Package** into versioned archive
3. **Generate** preservation metadata
4. **Backup** to configured destinations

## Parameters

- **`--version <tag>`** (optional): Version tag (default: timestamp)
- **`--format <type>`** (optional): Archive format (`tar.gz`, `zip`, `oais-sip`)
- **`--destination <path>`** (optional): Backup destination (local path or S3 URI)

## Outputs

- **Archive package**: `.aiwg/research/archives/research-{version}.tar.gz`
- **PREMIS metadata**: `.aiwg/research/archives/premis-{version}.xml`
- **Backup log**: `.aiwg/research/logs/archive-{timestamp}.log`

## Related Agents

- **Archival Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/archival-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Archive the research"
- "Create research backup"
- "Package artifacts for preservation"
- "Version the research collection"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-007-archive-research-artifacts.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-007
