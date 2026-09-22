---
namespace: aiwg
name: devkit-create-agent
platforms: [all]
description: Create a new agent with AI-guided expertise definition following the Agent Design Bible
---

# Create AIWG Agent

Create a new agent with AI assistance to define expertise, workflow, and capabilities.

**Follows**: [Agent Design Bible](~/.local/share/ai-writing-guide/docs/AGENT-DESIGN.md) - 10 Golden Rules for production-grade agents.

**Research Foundation**: REF-001 (Bandara et al.), REF-002 (Roig 2025) failure archetype prevention.

## Usage

```
/devkit-create-agent <name> --to <target> [options]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| name | Yes | Agent name (kebab-case recommended) |

## Required Options

| Option | Description |
|--------|-------------|
| --to | Target addon or framework |

## Optional Options

| Option | Description |
|--------|-------------|
| --template | Agent template: simple (default), complex, orchestrator |
| --interactive | Enable interactive mode with guided questions |

## Templates

Templates are in `~/.local/share/ai-writing-guide/templates/agent-scaffolding/`.

### simple (default)
Single-purpose, focused agent with minimal structure (Rule 1: Single Responsibility).
- Best for: Utility agents, single-task specialists
- Model: haiku (efficiency tier)
- Tools: Read, Write (Rule 2: Minimal Tools)

### complex
Full reasoning agent with all safeguards including failure archetype prevention.
- Best for: Subject matter experts, reviewers, analysts
- Model: sonnet/opus (based on complexity)
- Tools: Read, Write, Grep (Rule 2: 0-3 tools)
- Includes: Grounding, uncertainty handling, recovery protocol

### orchestrator
Multi-agent coordination with workflow patterns and agent assignment tables.
- Best for: Workflow coordinators, phase managers
- Model: opus (Rule 8: reasoning tier for coordination)
- Tools: Task only (Rule 2: single tool for delegation)

### validator
Read-only validation agent that doesn't modify state.
- Best for: Quality gates, compliance checks, code review
- Model: haiku/sonnet
- Tools: Read, Grep (read-only)

## Interactive Mode

When `--interactive` is specified, I will ask:

1. **Role**: What is this agent's primary role?
2. **Expertise**: What domains does it specialize in?
3. **Responsibilities**: What are its key responsibilities?
4. **Tools**: What tools does it need access to?
5. **Workflow**: How should it approach tasks?
6. **Output**: What format should its output take?

## Examples

```bash
# Simple agent
/devkit-create-agent code-reviewer --to aiwg-utils

# Complex domain expert
/devkit-create-agent security-auditor --to sdlc-complete --template complex

# Orchestrator agent
/devkit-create-agent deployment-coordinator --to sdlc-complete --template orchestrator --interactive
```

## Execution

1. **Validate inputs**: Check name and target
2. **Verify target exists**: Ensure addon/framework is installed
3. **Select template**: Use specified or default to simple
4. **Gather expertise**: In interactive mode, ask about domain knowledge
5. **Generate agent file**: Create with frontmatter and sections
6. **Update manifest**: Add agent to manifest.json
7. **Report success**: Show location and customization tips

## Output Location

```
<target>/agents/<name>.md
```

## Agent File Structure

```markdown
---
name: agent-name
description: Agent description
model: claude-sonnet-5
tools: Read, Write, MultiEdit, Bash, WebFetch
---

# Agent Title

[Description]

## Expertise
[Domain knowledge]

## Responsibilities
[What the agent does]

## Workflow
[How it approaches tasks]

## Output Format
[Expected output structure]
```

## CLI Equivalent

```bash
aiwg add-agent <name> --to <target> --template <type>
```

## 10 Golden Rules Validation

After creation, validate against the Agent Design Bible:

```bash
aiwg lint agents <target>/agents/<name>.md --verbose
```

| Rule | Check |
|------|-------|
| 1. Single Responsibility | One clear purpose, no "and" overload |
| 2. Minimal Tools | 0-3 tools, justified |
| 3. Explicit I/O | Inputs and outputs defined |
| 4. Grounding | Verify before acting (Archetype 1) |
| 5. Uncertainty | Escalate ambiguity (Archetype 2) |
| 6. Context Scope | Filter distractors (Archetype 3) |
| 7. Recovery | Handle errors (Archetype 4) |
| 8. Model Tier | Match task complexity |
| 9. Parallel Ready | Concurrent execution safe |
| 10. Observable | Traceable output |

## Related Commands

- `/devkit-create-command` - Create a slash command
- `/devkit-create-skill` - Create an auto-triggered skill
- `/devkit-validate` - Validate agent structure
- `aiwg lint agents` - Validate against 10 Golden Rules

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/README.md — aiwg-dev addon overview
- @$AIWG_ROOT/docs/extensions/extension-types.md — Extension types including agent type
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference including add-agent command
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/god-session.md — Single-responsibility rules for agents
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md — Agent metadata structure and multi-provider deployment
