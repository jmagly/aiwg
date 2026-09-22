# Claude-Specific Optimization Guide

Practical techniques for getting the most out of Claude models in AIWG deployments. This guide covers prompt formatting, context management, model selection, and how AIWG's agent tier system maps to Claude's capabilities.

---

## When to Use This Guide

Use this guide if you are:

- Running AIWG on Claude Code, Factory AI, or Windsurf (all use Claude under the hood)
- Tuning agent prompts in `agentic/code/frameworks/sdlc-complete/agents/`
- Troubleshooting quality issues with specific SDLC agents
- Selecting models for custom agent definitions

---

## Quick Start

```bash
# Deploy AIWG with Claude defaults (Claude Code provider)
aiwg use sdlc

# Deploy with explicit model overrides
aiwg use sdlc --reasoning-model claude-opus-5 \
              --coding-model claude-sonnet-5 \
              --efficiency-model claude-haiku-4-5

# Check what models are deployed
aiwg use sdlc --dry-run
```

---

## Model Selection Reference

AIWG maps three tiers to Claude models. The canonical defaults come from `agentic/code/frameworks/sdlc-complete/config/models.json`.

| AIWG Tier | Claude Model | Use For | Context Window |
|-----------|--------------|---------|----------------|
| `opus` (reasoning) | claude-opus-5 | Architecture, security review, complex analysis | 200K tokens |
| `sonnet` (coding) | claude-sonnet-5 | Code generation, debugging, implementation | 200K tokens |
| `haiku` (efficiency) | claude-haiku-4-5 | File ops, summaries, simple edits | 200K tokens |

### Decision Tree: Which Model Tier to Assign an Agent

```
Is this agent making architectural or security decisions?
  Yes → opus (reasoning)

Is this agent writing or reviewing code?
  Yes → sonnet (coding)

Is this agent performing repetitive or mechanical tasks?
  Yes → haiku (efficiency)

Is latency more important than depth for this agent?
  Yes → haiku or sonnet depending on output complexity
```

### Agents and Their Default Tiers

| Agent | Tier | Rationale |
|-------|------|-----------|
| architecture-designer | opus | Strategic decisions, cross-cutting trade-offs |
| requirements-analyst | opus | Complex problem decomposition |
| security-architect | opus | Critical correctness requirements |
| software-implementer | sonnet | Sustained code generation |
| code-reviewer | sonnet | Code comprehension and critique |
| test-engineer | sonnet | Test logic complexity |
| documentation-synthesizer | haiku | Structured formatting, low reasoning load |
| configuration-manager | haiku | Pattern matching and file operations |

---

## XML Tag Formatting

Claude responds well to structured XML tags in both system and user prompts. This is especially useful for AIWG agent definitions.

### Wrapping Instructions

Use named tags to separate concerns clearly:

```xml
<instructions>
  You are an AIWG Test Engineer. Your role is to generate test plans
  based on the requirements provided.
</instructions>

<constraints>
  - Focus on behavior, not implementation details
  - Cover happy path, edge cases, and error conditions
  - Produce executable test cases in the format specified
</constraints>

<output_format>
  Return a YAML test plan following the structure at @.aiwg/testing/
</output_format>
```

### Separating Context from Task

When passing large context blocks, use tags to keep them distinct from the instruction:

```xml
<context>
  {{artifact_content}}
</context>

<task>
  Review the above for security vulnerabilities. Focus on authentication
  flows and input validation. Output findings as a prioritized list.
</task>
```

### Custom Tags in AIWG Agent Definitions

Agent YAML frontmatter supports a `system` field. Wrap sections with descriptive tags:

```yaml
---
name: security-auditor
model: opus
---

<role>Security Auditor</role>

<responsibilities>
Review code and architecture for security issues including:
- Authentication and authorization flaws
- Injection vulnerabilities
- Secrets exposure
- Dependency risks
</responsibilities>

<output>
Return findings in this format:
CRITICAL | HIGH | MEDIUM | LOW — [component] — [description] — [remediation]
</output>
```

---

## Extended Thinking / Chain-of-Thought

Claude produces higher-quality outputs on complex tasks when given explicit space to reason before answering.

### Triggering Extended Reasoning

Add a reasoning section before the response in your prompt:

```
Before answering, think through the architectural trade-offs step by step
inside <thinking> tags. Then provide your recommendation.
```

Claude will use `<thinking>` for internal reasoning that does not appear in the final response when the API's extended thinking feature is active. In prompt engineering (without the API parameter), the tag creates a visible reasoning section.

### When to Use Chain-of-Thought Prompting

Use explicit reasoning steps for:

- Architecture decisions with multiple valid approaches
- Security reviews where completeness matters
- Debugging tasks where root cause is non-obvious
- Requirements analysis with ambiguous inputs

Do not add reasoning scaffolding to:

- Haiku-tier efficiency agents (latency cost not worth it)
- Tasks with clear, deterministic outputs (format conversions, summaries)
- Batch operations where per-item reasoning is redundant

### AIWG Template Pattern

AIWG's `reasoning-sections` rule (see `RULES-INDEX.md`) formalizes this. Use numbered reasoning steps in templates:

```markdown
## Reasoning

1. Identify the core problem and constraints
2. List candidate approaches with trade-offs
3. Evaluate against non-functional requirements
4. Select and justify the recommended approach

## Recommendation

[Answer goes here after reasoning is complete]
```

---

## Tool Use Patterns

Claude's tool use (function calling) follows a structured pattern. AIWG agents that use Claude Code's built-in tools should be designed with this in mind.

### Available Tools in Claude Code

| Tool | When to Call | Notes |
|------|-------------|-------|
| Read | File content needed | Prefer explicit paths from context |
| Write | Creating new files | Read first if file may exist |
| Edit | Modifying existing files | Always Read first |
| Bash | Command execution | Describe what the command does |
| Glob | File discovery | Use before Read when path is uncertain |
| Grep | Content search | Faster than Read for targeted lookup |

### Prompt Design for Tool-Heavy Agents

Give agents explicit permission to use tools and guidance on sequencing:

```
You have access to file system tools. Before writing any code:
1. Read the relevant source files to understand existing patterns
2. Search for related implementations with Grep
3. Then generate code consistent with what you found

Never write code based on assumptions about file contents.
```

### Avoiding Tool Call Loops

Agents can get stuck in repeated tool calls if the stopping condition is unclear. Make it explicit:

```
After reading the three files listed below, you have enough context.
Do not read additional files unless I request it.
```

---

## System Prompt vs. User Prompt Placement

Claude treats system prompts and user prompts differently. In AIWG agent definitions, the agent's `---` frontmatter body becomes the system prompt.

### What Goes in the System Prompt

- Role definition and persona
- Constraints and ground rules
- Output format requirements
- Persistent behavioral instructions

```yaml
---
name: code-reviewer
model: sonnet
---

You are an AIWG Code Reviewer. You review pull request diffs for:
- Logic errors and edge case gaps
- Security anti-patterns
- Violations of the project's coding conventions

Always respond with a structured review following the AIWG review template.
Never approve code with CRITICAL findings unresolved.
```

### What Goes in the User Prompt (Command/Skill)

- Specific task content
- Variable inputs (file paths, artifact references)
- One-time context

```markdown
Review this diff for the authentication module:

{{diff_content}}

Focus especially on token validation and session management.
```

### Why This Separation Matters

System prompt instructions are more persistent across a conversation. Instructions in user turns can be overridden or forgotten in long sessions. Put behavioral constraints in the system prompt, not the user turn.

---

## Context Management (200K Token Window)

All Claude models support 200K token context windows. Managing what goes into that window determines quality and cost.

### Context Budgeting

A rough budget for typical AIWG SDLC sessions:

| Allocation | Tokens | Content |
|-----------|--------|---------|
| Agent system prompt | ~2,000 | Role, constraints, format |
| Rules index | ~4,000 | RULES-INDEX.md |
| Artifact under review | ~10,000–50,000 | Code, docs, requirements |
| Conversation history | ~5,000–20,000 | Prior turns |
| Output buffer | ~4,000 | Response space |

Total active session: typically 25,000–80,000 tokens, well within the 200K limit.

### When Context Size Becomes a Problem

Signs you are hitting context management issues:

- Agent ignores instructions given early in the conversation
- Outputs start contradicting prior turns
- Code generated does not match patterns from files read earlier

Solutions:

1. **Use the RLM addon** for large codebases — spawn focused sub-agents instead of loading everything at once
2. **Reference artifacts with @-mentions** rather than pasting content inline
3. **Compact conversation history** at phase transitions using AIWG's checkpoint system
4. **Use haiku** for initial passes to extract relevant sections before sending to opus or sonnet

### Practical Token Estimation

```bash
# Rough estimate: 1 token ≈ 4 characters
# A 1,000-line Python file ≈ 30,000–40,000 tokens
# A complete SDLC artifact set ≈ 50,000–100,000 tokens

# Check before sending large files
wc -c myfile.py
# Divide by 4 for approximate token count
```

---

## Prompt Optimization Examples

### Before: Vague Instruction

```
Review this code for issues.
```

### After: Structured Claude Prompt

```xml
<task>Review the authentication module for security issues.</task>

<scope>
Focus on these areas only:
- Token generation and validation
- Session management
- Input sanitization on login endpoints
</scope>

<output>
Return findings as:
SEVERITY: [CRITICAL/HIGH/MEDIUM/LOW]
LOCATION: [file:line]
FINDING: [description]
REMEDIATION: [specific fix]

List findings in descending severity order.
</output>

<context>
{{auth_module_content}}
</context>
```

### Before: Ambiguous Role

```
You help with coding tasks.
```

### After: Precise AIWG Agent Definition

```yaml
---
name: software-implementer
model: sonnet
description: Implements features from specifications with production-ready code
---

You are an AIWG Software Implementer. You translate requirements and
architecture decisions into working code.

Your outputs must:
- Follow the project's established patterns (read existing code before writing)
- Include error handling for all external calls
- Pass the project's existing test suite
- Match the style of surrounding code

You do not make architectural decisions. If a specification is ambiguous
or requires a design choice, stop and ask for clarification.
```

---

## AIWG Model Configuration

Override Claude model assignments in `models.json`:

```json
{
  "claude": {
    "reasoning": {
      "model": "claude-opus-5",
      "description": "Complex reasoning and architecture"
    },
    "coding": {
      "model": "claude-sonnet-5",
      "description": "Code generation and review"
    },
    "efficiency": {
      "model": "claude-haiku-4-5",
      "description": "Quick tasks and file operations"
    }
  },
  "shorthand": {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5"
  }
}
```

Place this file at:
- `./models.json` — project-level override (checked into version control)
- `~/.config/aiwg/models.json` — user-level preference

### Assigning Models in Agent Frontmatter

```yaml
---
name: my-agent
model: opus    # resolves to claude-opus-5
---
```

```yaml
---
name: my-agent
model: sonnet  # resolves to claude-sonnet-5
---
```

```yaml
---
name: my-agent
model: haiku   # resolves to claude-haiku-4-5
---
```

---

## Common Mistakes and Fixes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Using opus for all agents | High cost, slow iteration | Assign haiku to mechanical tasks |
| No output format specified | Inconsistent response structure | Add explicit format in system prompt |
| Pasting entire codebase inline | Context overflow, degraded quality | Use RLM addon or targeted file reads |
| Instructions only in user turn | Drift in long sessions | Move behavioral rules to system prompt |
| Vague task description | Generic, low-value output | Use XML tags to separate task, context, and format |

---

## See Also

- `docs/configuration/model-configuration.md` — Full model configuration reference
- `docs/models/hybrid-architectures.md` — Cost-optimized multi-model routing
- `agentic/code/frameworks/sdlc-complete/rules/RULES-INDEX.md` — Enforcement rules
- `agentic/code/addons/rlm/README.md` — Large context handling with RLM
