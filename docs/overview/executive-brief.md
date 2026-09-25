# AIWG Executive Brief

AIWG gives your AI assistant reusable project context and specialist workflows, so you can carry decisions forward and
review complex work in the tools you already use.

For teams, the practical opportunity is to keep decisions, review criteria, and findings available as work moves
between people, tasks, and AI sessions. AIWG provides inspectable instructions and saved artifacts that support that
continuity.

## The problem it addresses

An AI-assisted project can accumulate useful decisions in conversations that are difficult to reuse. Review practices
can vary between team members, and later work may miss the reasons behind an earlier change.

AIWG helps a team record those decisions, apply specialist review procedures, and connect outputs to their supporting
context. A developer can carry a design decision into implementation; a marketing team can carry an agreed message
into a campaign draft; a researcher can carry source notes into a synthesis.

## What adoption involves

AIWG places workflow instructions in locations the team's AI tools can read. Project artifacts are saved under
`.aiwg/`. Optional utilities add lookup, orchestration, and recovery capabilities.

Adoption requires an existing AI tool, a configured project, and someone responsible for reviewing the resulting work.
Teams should agree on which artifacts to keep, who maintains them, and which changes require approval. Workflows
involving external systems also need the corresponding integrations and access.

Start with the [canonical installation guide](../getting-started/install-connect-verify.md). A focused first task can
use the complete supported setup without requiring the team to adopt every available workflow.

## Expected benefits and limits

| Capability | What to look for in a pilot | Limit to keep in view |
|---|---|---|
| Saved project context | Later tasks can locate and use earlier decisions | Artifacts can become stale or be misread |
| Specialist review | Findings address distinct risks and cite concrete sources | Multiple reviewers can still share errors |
| Structured workflows | Outputs have clear scope and verification criteria | More process can add overhead to small tasks |
| Recovery procedures | Failed attempts produce useful diagnosis and a bounded retry | Recovery is not guaranteed |
| Shared instructions | Team members can reuse reviewed workflow source | Provider capabilities and deployment scope differ |

AIWG does not promise a fixed saving in cost or time, error-free citations, or a compliance certification. Model calls
and human review may increase for complex workflows. Research cited in the [reading list](reading-list.md) informs the
approach; results from other systems are not AIWG performance measurements.

## A practical pilot

1. Choose a bounded task with known context, such as reviewing a README or a planned software change.
2. Define the expected deliverable and who will assess it before starting.
3. Connect AIWG and run the task. Save the review with source references and prioritized recommendations.
4. In a later session, use the saved review to make one agreed change.
5. Compare the work with the team's usual process and decide what to retain.

Record task completion, correctness of findings, missed issues, reviewer effort, total elapsed time, and model cost
where available. Use comparable tasks and report limitations. The decision is whether the workflow helps this team
enough to justify its setup and review effort.

The [first-result walkthrough](../getting-started/just-try-it.md) provides a concrete prompt and an illustrative output.

## Compatibility and next steps

AIWG tracks **18 named provider integrations**, including Google Antigravity CLI, Claude Code, OpenAI Codex, GitHub
Copilot, Cursor, DeepSeek Harness, Factory AI, Grok Bot, Grok Build, Muse Code, Hermes, OpenCode, OpenClaw, OpenHuman, Oh My Pi, Pi Coding Agent, Warp
Terminal, and Devin Desktop. See the [provider inventory](../providers/provider-inventory.md) for status and scope,
including experimental integrations and the separate generic fallback.

Read [What Is AIWG?](what-is-aiwg.md) for the working model, [choose a workflow](capabilities.md), or begin with
[Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Portable skills use the `.agents/skills/` surface on compatible providers; deployment adapts to each host.
