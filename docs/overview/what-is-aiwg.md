# What Is AIWG?

AIWG gives your AI assistant reusable project context and specialist workflows, so you can carry decisions forward and
review complex work in the tools you already use.

It is useful for work that spans several tasks or sessions: planning a software change, preparing a campaign,
investigating a problem, or organizing research. You describe the outcome in your AI tool. AIWG supplies instructions
and workflows that help the agent produce reviewable work and save context for the next task.

## Three examples

| Situation | What you ask for | What you keep |
|---|---|---|
| You inherited a codebase | Identify the main components and the most important missing tests | A report with source references and prioritized test recommendations |
| You are preparing a launch | Review the README for unclear positioning and missing onboarding steps | A messaging review with specific fixes |
| You are investigating a technical question | Compare the available sources and distinguish findings from uncertainty | Source notes and a synthesis with traceable citations |

Each output can become input to later work. For example, the next session can read a README review and revise the
first section. You can inspect the saved report instead of relying on the previous conversation being available.

Try the [first-result walkthrough](../getting-started/just-try-it.md), or use the [capability guide](capabilities.md)
to choose a different task.

## What you install

AIWG places agents, skills, commands, and rules in locations your AI tool can read. Those files describe roles, tasks,
and constraints. A framework groups them around a domain, such as software development or marketing. Templates give
the resulting documents a consistent structure.

The deployment layer is a CLI tool. Optional utilities support artifact search, workflow orchestration, recovery, and
other tasks. Some require additional services or provider capabilities. The [architecture
overview](../architecture-overview.md) separates deployment from optional runtime components.

You continue working in your existing assistant. AIWG supplies context and procedures; the provider supplies the model
and its available tools. Native agent execution, discovery, permissions, and reload behavior vary by provider.

## How work carries forward

Project outputs live in the `.aiwg/` artifact area. A software workflow might save requirements, a design decision,
and a test plan. A marketing workflow might save a campaign brief and a messaging review. Links between those
documents help later tasks find their supporting context.

A typical review proceeds through a draft, specialist feedback, and a combined result. The agent may use parallel
reviewers when supported, or work through the roles sequentially. The workflow defines what to check and what to save;
your project policy controls required approvals.

Saved context still needs maintenance. Outdated decisions should be revised, conflicting findings resolved, and
important claims checked against their sources. An artifact being present does not prove that the assistant consulted
it or interpreted it correctly.

## When it fits

AIWG is a useful fit when you want to:

- keep project decisions available across sessions;
- give a team reusable instructions across supported AI tools;
- structure reviews around different areas of expertise;
- connect plans, implementation work, and verification;
- build project-specific workflows you can inspect and version.

A single short question may not benefit from this structure. Start with one task before committing to a larger
process. You can use a focused workflow without adopting every phase of a framework.

## Provider support

AIWG has **18 named provider integrations**: Google Antigravity CLI, Claude Code, OpenAI Codex, GitHub Copilot,
Cursor, DeepSeek Harness, Factory AI, Grok Bot, Grok Build, Muse Code, Hermes, OpenCode, OpenClaw, OpenHuman, Oh My Pi, Pi Coding Agent, Warp Terminal,
and Devin Desktop. The separate `generic` adapter provides portable files for custom harnesses.

The [provider inventory](../providers/provider-inventory.md) tracks integration status and deployment scope. The
[comparison and setup guides](../integrations/cross-platform-overview.md) explain the supported surfaces and
provider-specific handoff. Integration does not imply identical capabilities on every tool.

## Costs and limitations

Specialist reviews, context retrieval, and recovery attempts can add model calls and review effort. Their value
depends on the task, model, tools, and quality criteria. Set a bounded first task and examine the result before
increasing autonomy.

AIWG's templates and checks support review and traceability; they do not guarantee correct output, perfect citations,
regulatory compliance, or deterministic reproduction. A prompt-based rule is an instruction to the agent, and
technical enforcement depends on the configured tools and checks.

Research on structured artifacts, multi-agent work, and recovery informs the design. Results measured for those
research systems are not AIWG benchmarks. See the [reading list](reading-list.md) for sources, and the [executive
brief](executive-brief.md) for a pilot that measures usefulness in your own work.

## Start with a saved review

Follow [Install, Connect, and Verify](../getting-started/install-connect-verify.md), then ask:

```text
Use AIWG to review this project's README for unclear positioning and missing
onboarding steps. Save a report at
.aiwg/marketing/brand/audit/readme-review.md with file references and the
three highest-priority fixes. Leave the README unchanged.
```

Check that each recommendation identifies a real passage, explains the reader's problem, and proposes a concrete fix.
In the next session, ask the agent to read the report and implement the first agreed change.

For a wider project, continue with [software development](../quickstart-sdlc.md), [marketing](../quickstart-mmk.md),
or [another workflow](capabilities.md).
