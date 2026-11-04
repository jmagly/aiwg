# Beginner Language Map

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Use this guide when you know what you want in plain language but do not know the AIWG term for it.

You stay in the conversation with your AI tool. The agent translates your goal into AIWG-native concepts and runs the lookups for you. You do not need to memorize AIWG terminology, command names, or skill identifiers — they are the agent's job.

## How AIWG Is Meant To Be Used

The everyday AIWG user surface is the agent conversation. The CLI exists mostly so agents can call it; only a small set of commands (`aiwg use`, `aiwg wizard`, `aiwg doctor`, `aiwg status`, `aiwg refresh`) is meant for users to type directly. Discovery, lookup, indexing, loops, and orchestration are agent operations triggered by what you say in the chat.

## Automatic discovery on a new prompt

> Review the authentication code for security issues.

With Claude Code or Muse hooks installed, AIWG gives the assistant up to three
matching capabilities and the next steps: inspect the candidate, read its required
rules, then apply it. You keep talking normally. Short acknowledgements and slash
commands skip the lookup; errors and timeouts leave the conversation running.
See [prompt-time hooks](../hook-patterns.md#prompt-time-discovery-3858) for the
context example, opt-out, timeout setting, and explicit Codex/Hermes bridge gaps.

## The Pattern

1. Describe your situation in ordinary words.
2. Ask the agent how AIWG can help.
3. The agent translates your words into AIWG capability searches and runs them.
4. The agent recommends one path.
5. Stay with that path until you understand what it does and get one useful result.

Good starter prompts:

```text
How best can we use AIWG for our situation?
I do not know what AIWG has. Help me find the right thing.
What should we focus on first?
Create a workflow from AIWG capabilities that fits this project.
```

The agent should answer with a short recommendation, not a catalog.

## Intent Map

This table tells you *what to say*. The right-hand columns are AIWG-internal — they describe what the agent will do on your behalf when you say the thing in the left column.

| If you say... | What you'd like AIWG to help with | What the agent looks up |
|---|---|---|
| "Help me start a project." | SDLC intake and requirements | Intake wizards and requirements skills |
| "Help me choose what to use." | Routing across the AIWG catalog | The steward agent and framework quickrefs |
| "I do not know what AIWG has." | Capability discovery for your goal | The capability index across all installed frameworks |
| "Help my AI remember what we decided." | Memory, knowledge base, project artifacts | Memory ingest, KB profiles, project artifact workflows |
| "Help me know what is next." | Project status and orchestration | Status reports and orchestration flows |
| "Help the AI not quit early." | Iterative loops with completion checks | Agent-loop tooling and completion criteria |
| "Help check quality." | Tests, review, gates, validation | Test coverage and quality gate skills |
| "Help with research papers." | Research framework, citation, GRADE | Research workflows and citation tools |
| "Help with infra or servers." | Ops framework and extensions | Runbook, inventory, and audit workflows |
| "Help with security." | Security engineering and reviews | Security assessment and security-engineering flows |
| "Help write better content." | Voice, writing quality, marketing | Voice profiles, writing validation, marketing flows |
| "Help make this less chaotic." | Planning, orchestration, gates | Orchestration and planning workflows |
| "Help me build a custom workflow." | Project-local extension or skill authoring | Skill-architect and extension-authoring paths |
| "Help with CI, builds, or deployment." | Dev-ops and release gates | Pipeline safety and release-readiness skills |

You only need the left column. The agent handles the rest.

## Keep The Choice Small

For a beginner, a good AIWG response from the agent has this shape:

```text
Your goal sounds like: <plain-language restatement>

I would start with: <one path>
Why: <one short reason>

Fallback if that does not fit: <one alternative>

Next action: <one specific step>
```

If the agent gives you more than that — every framework, addon, skill, and agent — interrupt and ask for one recommendation.

## Examples

### "How best can we use AIWG globally?"

Say that. The agent will look up the steward and the workspace-health surfaces, compare them against your situation, and recommend the steward as the entry point for a routing conversation. You stay in the chat.

### "Create new workflows that fit our situation."

Say that. The agent will look up the skill-architect path and the project-local extension path, decide which one matches the work you described, and walk you through it. If your situation is a one-time project flow rather than a reusable skill, the agent will steer toward orchestration instead.

### "What should we focus on first?"

Say that. The agent will look up project status, risk cycle, and SDLC health-check workflows, then pick the one that best matches the project's current state. You do not have to know which of those exists.

## Related Guides

- [Getting Started](README.md)
- [Quick Start](../quickstart.md)
- [Key Addons](key-addons.md)
- [Simple Language Translations](../simple-language-translations.md)
