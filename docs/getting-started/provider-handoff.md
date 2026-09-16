# Provider Handoff

Use this page after choosing the AI tool that should use AIWG. Local files can
be correctly deployed while an already-open provider session still needs a
restart, reload, or fresh workspace conversation.

## One handoff prompt

Open the intended project in your provider and paste:

```text
Connect this provider session to the AIWG deployment for the current project.
Identify the provider and project root from evidence, inspect the expected
provider files, preserve project-authored instructions, and tell me whether a
restart or reload is actually required. Then verify engagement and recommend
one useful next action.
```

If more than one provider is present, add the tool name to the first sentence.

## Pick your AI tool

| Tool | Open the session from | Main deployed path | First verification ask |
|---|---|---|---|
| Claude Code | Project root | `.claude/` | “Is AIWG active, and what evidence proves it?” |
| OpenAI Codex | Project root | `.codex/`, `.agents/`, and `AGENTS.md` | “Check the Codex handoff and report engagement.” |
| GitHub Copilot | VS Code workspace root | `.github/` | “Find one AIWG capability for this workspace.” |
| Cursor | Project root in Cursor | `.cursor/` | “Check the Cursor handoff, then recommend one path.” |
| Factory | Project root | `.factory/` and shared context | “Verify Factory can read the AIWG context.” |
| OpenCode | Project root | `.opencode/` and `AGENTS.md` | “Verify the OpenCode handoff and choose one route.” |
| Warp | Warp session in the project root | `WARP.md` and `.warp/` | “Verify the Warp handoff from this project.” |
| Devin Desktop | Project root | Provider compatibility paths | “Verify the deployed project context.” |
| Hermes | Workspace attached to the project | Hermes context and `AGENTS.md` | “Verify project state and recommend one next action.” |
| Grok Bot | Workspace attached to the project | Grok Bot context and `AGENTS.md` | “Verify project state and recommend one next action.” |
| OpenClaw | Project root or OpenClaw workspace | OpenClaw skill and rule paths | “Verify the deployed project and find one capability.” |
| OpenHuman | Workspace attached to the project | OpenHuman user and project context | “Verify the AIWG context available here.” |
| Oh My Pi | OMP session in the project root | `.omp/`, `.agents/skills/`, and `.omp/AGENTS.md` | “Verify native OMP agents, context, and one AIWG capability.” |
| Pi Coding Agent (pi.dev) | Pi session in the project root | `AGENTS.md`, `.agents/skills/`, and `.pi/prompts/` | “Invoke an AIWG prompt and verify the Pi handoff.” |

## Honest validation

The agent should distinguish two kinds of proof:

- **deployment proof:** the expected files and context exist for the provider;
- **session proof:** the current provider session actually read that context.

Some providers load refreshed instructions immediately. Others need one
restart or workspace reload. Until the current session demonstrates that it
can use AIWG, describe the handoff as deployment-verified rather than fully
active.

Named integrations have provider definitions and capability-matrix records.
That structural coverage is distinct from field validation in a live provider
session.

## If verification is unclear

```text
Do not infer success from file presence alone. Check both deployment evidence
and this session’s ability to use an AIWG capability. If they disagree, explain
the smallest safe restart, reload, or repair and wait for my approval before
changing files.
```

Exact provider flags and non-interactive automation contracts are confined to
the [CLI reference](../cli/reference.md).

## Related

- [Start Here](start-here.md)
- [Install, Connect, and Verify](install-connect-verify.md)
- [Verify AIWG Is Working](verify-aiwg-is-working.md)
- [Scope and Recovery](scope-and-recovery.md)
