# Install, Connect, and Verify AIWG

AIWG gives your AI assistant reusable project context and specialist workflows.
This is the canonical first-time setup path. Connect the intended project,
verify readiness, then complete a small task with a saved result.

Your **project root** is the main folder for the project—the folder that usually
contains files such as `README.md`, `package.json`, or `.git`. Your **provider**
is the AI tool you are using, such as Claude Code, Codex, Copilot, or Cursor.

## One prompt for installation or repair

Open the intended project in your provider and paste:

```text
Install or repair AIWG for this project by following
https://aiwg.io/setup.aiwg.yaml

First identify the project root and provider. Inspect the current installation
without changing it, explain the plan and files that may change, preserve my
existing work, and ask me only for choices you cannot safely determine. Use the
complete supported AIWG setup unless this project already declares a narrower
policy. When finished, verify the engagement state and report the evidence in
plain language.
```

The linked installer is designed for agent use. It recognizes healthy,
outdated, incomplete, duplicate, and source-checkout installations. A healthy
installation should not be replaced merely because the agent was asked to
check it.

## What the agent should do

The agent should:

1. confirm the project root and provider;
2. inspect the installed AIWG version and ownership;
3. preview installation, deployment, and context changes;
4. request approval where project policy requires it or a choice needs your input;
5. connect the complete supported AIWG surface to the selected provider;
6. preserve project-authored instructions and unrelated work; and
7. run the engagement check and explain the result.

If the agent cannot determine the project folder, tell it which folder contains
your project and ask it to reopen or continue from there. Do not approve a path
that points at your home directory or an unrelated repository.

## Provider handoff

Tell the agent which tool you are using:

| AI tool | What to say |
|---|---|
| Claude Code | “Connect AIWG to this Claude Code project.” |
| OpenAI Codex | “Connect AIWG to this Codex workspace.” |
| GitHub Copilot | “Connect AIWG to this Copilot workspace.” |
| Cursor | “Connect AIWG to this Cursor project.” |
| Factory | “Connect AIWG to this Factory project.” |
| OpenCode | “Connect AIWG to this OpenCode project.” |
| Warp | “Connect AIWG to this Warp project.” |
| Devin Desktop | “Connect AIWG to this Devin Desktop project.” |
| OpenClaw | “Connect AIWG to this OpenClaw workspace.” |
| Hermes | “Connect AIWG to this Hermes workspace.” |
| Grok Bot | “Connect AIWG to this Grok Bot workspace.” |
| Muse Code | “Connect AIWG to this Muse Code workspace.” |
| OpenHuman | “Connect AIWG to this OpenHuman workspace.” |
| Oh My Pi | “Connect AIWG to this Oh My Pi project.” |
| Pi Coding Agent (pi.dev) | “Connect AIWG to this Pi Coding Agent project.” |

Some providers can use refreshed context immediately; others need a single
restart or workspace reload. The agent should report that need rather than
asking you to restart by default.

## Verify the result

Paste this after setup:

```text
Is AIWG active in this project? Read the canonical engagement evidence and
report the engaged state, project root, provider files, installed frameworks
and addons, and exactly one next action. Do not make me interpret raw command
output. If anything is partial or degraded, explain the safest recovery path
before changing files.
```

Success means:

- the reported project folder is the one you intended;
- the provider matches the AI tool you opened;
- AIWG reports an engaged, ready state;
- the provider context is connected to `WORKSPACE.md` and `AIWG.md`; and
- the agent gives one sensible next action with verification evidence.

## Get your first useful result

Once the connection is ready, [review your README](just-try-it.md). The task
saves a report with source references and three prioritized fixes. Check the
findings, then use the report in a later session to implement an agreed change.
Readiness confirms the connection; this task lets you assess the workflow.

## Recovery prompts

Wrong project:

```text
Stop. Re-check the project root from repository evidence, tell me which folder
you are using, and propose how to reopen AIWG in the intended project without
changing either folder.
```

Missing or stale provider context:

```text
Diagnose the AIWG provider connection for this project. Explain what is missing
or stale, preview the smallest safe repair, preserve project-authored files,
and verify the connection after I approve it.
```

Conflicting instructions:

```text
Show me the conflicting AIWG-managed and project-authored instructions. Explain
which source owns each section and propose a preservation-safe resolution. Do
not overwrite project-authored content without my approval.
```

## Manual installation alternative

If you prefer a terminal or cannot run an agent, use the
[manual installation reference](../cli/install-and-repair.md). The complete
[CLI reference](../cli/reference.md) covers deployment and recovery syntax.
Return to the verification check and first task above after manual setup.

For secure long-running agents, an operator can instead use the
[AIWG Cockpit + Agentic Sandbox installer](https://aiwg.io/agentic-sandbox/setup.aiwg.yaml),
which audits the host and verifies the control and audit path.
