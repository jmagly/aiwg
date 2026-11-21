# Agent Permission Tiers

**Version**: 1.0.0
**Status**: Active
**Platform**: Claude Code v2.1.33+

## Overview

This document defines a 3-tier permission model for AIWG agents that controls which sub-agents each agent can spawn. This leverages Claude Code's `Task(agent_type)` syntax introduced in v2.1.33 to enforce least-privilege access and prevent runaway agent spawning.

## Platform Compatibility

| Platform | Support | Notes |
|----------|---------|-------|
| Claude Code | Full | Native `Task(agent_type)` support |
| GitHub Copilot | Partial | Uses different delegation model |
| Cursor | N/A | No sub-agent spawning |
| Devin Desktop | N/A | Uses different agent model |
| Cline | N/A | Single-agent model |

This permission model is primarily for Claude Code. Other platforms handle agent restrictions through different mechanisms.

## Three-Tier Model

### Tier 1: Analyst (Read-Only)

**Permission**: `Task(Explore)` only - can spawn Explore agents for information gathering

**Philosophy**: Analysis and review agents should gather information and produce reports, not execute code or spawn implementation agents.

**Tool Access**: Read, Grep, Glob (information gathering only)

**Agents**:

| Category | Agents |
|----------|--------|
| **Requirements** | requirements-analyst, requirements-reviewer, requirements-documenter |
| **Domain Analysis** | domain-expert, business-process-analyst, system-analyst |
| **Security Review** | security-auditor, security-architect, security-gatekeeper |
| **Code Review** | code-reviewer, citation-verifier, quality-assessor |
| **Governance** | legal-liaison, privacy-officer, raci-expert, decision-matrix-expert |
| **Strategy** | metrics-analyst, product-strategist, product-designer, vision-owner |
| **Documentation** | documentation-archivist, documentation-synthesizer |
| **Writing** | technical-writer, test-documenter, architecture-documenter |

**Rationale**: These agents analyze, review, and document. They should not execute code or spawn implementation agents. Limiting to `Task(Explore)` prevents escalation from analysis to implementation.

### Tier 2: Implementation (Execute + Explore)

**Permission**: `Task(Explore)`, `Task(Bash)` - can spawn Explore and Bash agents

**Philosophy**: Implementation agents need to run tests, build code, and validate their work. They can spawn exploratory agents for investigation and Bash agents for execution.

**Tool Access**: Read, Write, Bash, Grep, Glob (full development toolset)

**Agents**:

| Category | Agents |
|----------|--------|
| **Development** | software-implementer, test-engineer, test-architect |
| **Debugging** | debugger, database-optimizer, performance-engineer |
| **DevOps** | devops-engineer, build-engineer, cloud-architect |
| **Modernization** | legacy-modernizer, incident-responder, reliability-engineer |
| **Integration** | integration-engineer, deployment-manager, environment-engineer |
| **Accessibility** | accessibility-specialist, api-designer, api-documenter |
| **Tooling** | toolsmith, mcpsmith, skillsmith, commandsmith, agentsmith |
| **Research** | technical-researcher |

**Rationale**: These agents produce working code and infrastructure. They need execution capability to test their work but should not have unrestricted agent spawning.

### Tier 3: Orchestrator (Unrestricted)

**Permission**: Full `Task` - can spawn any agent type

**Philosophy**: Orchestrators coordinate work across multiple specialists. They need unrestricted delegation to route tasks appropriately.

**Tool Access**: Read, Write, Bash, Grep, Glob (full toolset)

**Agents**:

| Category | Agents |
|----------|--------|
| **Orchestration** | executive-orchestrator, architecture-designer |
| **Intake** | intake-coordinator, project-manager |
| **Management** | configuration-manager, traceability-manager |
| **Context** | context-librarian, component-owner |

**Rationale**: These agents manage workflows and delegate to specialists. They need full Task access to route work effectively.

## Permission Enforcement

### Claude Code Frontmatter

For Claude Code agents, the `tools:` field in frontmatter should reflect tier:

**Analyst Tier**:
```yaml
---
name: Requirements Analyst
tools: Read, Grep, Glob
# No Task listed - cannot spawn sub-agents (or Task(Explore) if exploration needed)
---
```

**Implementation Tier**:
```yaml
---
name: Software Implementer
tools: Bash, Read, Write, Grep, Glob
# Can spawn Explore and Bash agents
---
```

**Orchestrator Tier**:
```yaml
---
name: Executive Orchestrator
tools: Bash, Read, Write, Grep, Glob
# Can spawn any agent (unrestricted Task)
---
```

### Runtime Enforcement

Claude Code enforces `Task(agent_type)` restrictions at runtime. Attempting to spawn an unauthorized agent type results in:

```
Error: Agent 'requirements-analyst' cannot spawn agent type 'Bash'.
Permitted types: Explore
```

## Escalation Paths

When an agent needs capabilities beyond its tier:

### Analyst → Implementation

**Scenario**: Security Auditor finds vulnerability requiring code fix

**Solution**: Generate finding report, escalate to orchestrator to delegate to Software Implementer

**Pattern**:
```markdown
# Security Finding: SQL Injection in login.ts

**Severity**: Critical
**Location**: src/auth/login.ts:42
**Recommendation**: Parameterize query

**Escalation**: Requires code change beyond auditor scope.
Request delegation to Software Implementer.
```

### Implementation → Orchestrator

**Scenario**: Software Implementer encounters architectural decision

**Solution**: Document decision point, escalate to Architecture Designer

**Pattern**:
```markdown
# Implementation Blocker: Database Schema Decision

**Context**: Implementing user preferences storage
**Options**: JSON column vs normalized tables
**Impact**: Performance, maintainability, query complexity

**Escalation**: Requires architectural decision.
Request Architecture Designer evaluation.
```

## Security Implications

### Least Privilege

Restricting agent spawning follows the principle of least privilege:

- Analyst agents cannot accidentally introduce code changes
- Implementation agents cannot spawn unrestricted orchestrators
- Only designated orchestrators have full delegation authority

### Attack Surface Reduction

By limiting Task access:

- Reduces risk of runaway agent spawning
- Prevents privilege escalation through agent chaining
- Creates clear audit trail of delegation decisions

### Monitoring

Track agent spawning patterns:

| Metric | Alert Threshold |
|--------|----------------|
| Analyst spawns Bash | Any occurrence (should be impossible) |
| Implementation spawns Orchestrator | Any occurrence (escalation required) |
| Orchestrator spawn depth | >3 levels (potential runaway) |

## Migration Notes

### Existing Agents

Most existing agent definitions don't explicitly list `Task` in tools. This is correct - Task is a runtime capability, not a frontmatter declaration.

### Documentation Update

This document serves as the canonical reference for permission tiers. Agent definitions should reference this document:

```markdown
## Permission Tier

Tier: Analyst
Permitted Task types: Explore
See @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/agent-permission-tiers.md
```

### Cross-Platform

For platforms without `Task(agent_type)` support, this tier model serves as design guidance. Implement equivalent restrictions through platform-specific mechanisms.

## Examples

### Analyst Tier: Requirements Analyst

**What they CAN do**:
- Spawn `Task(Explore)` to research existing requirements
- Read source code and documentation
- Generate requirement specifications

**What they CANNOT do**:
- Spawn `Task(Bash)` to run tests
- Spawn `Task(software-implementer)` to implement code
- Execute arbitrary commands

### Implementation Tier: Software Implementer

**What they CAN do**:
- Spawn `Task(Explore)` to investigate code patterns
- Spawn `Task(Bash)` to run tests
- Read, write, and edit source files

**What they CANNOT do**:
- Spawn `Task(executive-orchestrator)` for workflow decisions
- Spawn `Task(architecture-designer)` for design decisions
- Delegate to agents outside Explore/Bash

### Orchestrator Tier: Executive Orchestrator

**What they CAN do**:
- Spawn any agent type via unrestricted `Task`
- Coordinate multi-agent workflows
- Make routing decisions

**What they SHOULD avoid**:
- Directly implementing code (delegate to Software Implementer)
- Deep agent nesting (>3 levels)
- Spawning agents without clear task definition

## References

- Claude Code v2.1.33 Release Notes - Task(agent_type) introduction
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/agent-fallback.md - Agent fallback patterns
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/agent-template.md - Agent definition template
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/agent-capability-matrix.yaml - Capability matching

---

**Maintained by**: Configuration Manager
**Last Updated**: 2026-02-06
**Review Cycle**: Quarterly
