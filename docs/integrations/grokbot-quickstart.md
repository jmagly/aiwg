# Connect AIWG to Grok Bot

> **Status:** Experimental.

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Grok Bot is the **provider** in this guide (provider id `grokbot` — there is no bare `grok` alias). Complete the
[safe Node.js setup](../getting-started/install-node.md) first if `node` or `npm` is unavailable.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

```bash
npm install -g aiwg
aiwg use all --provider grokbot
```

Project-scope deploy writes a discover-first `AGENTS.md` bridge and shared AIWG context. It does **not** write
`.cursor/` paths and does **not** invent `~/.grokbot`.

## User-scope / global skills (fail-closed)

Grok Bot user-scope skill writes require an absolute skill root:

```bash
export AIWG_GROKBOT_SKILLS_DIR=/absolute/path/to/grok-bot/skills-or-workflows
aiwg use all --provider grokbot --scope user
```

Without `AIWG_GROKBOT_SKILLS_DIR`, user-scope and Agent Skills `--target grokbot` deploys exit non-zero and create
no `~/grokbot-skills`, `~/.grokbot`, or `.cursor/` directories. Relative paths and bare `~` are rejected.

## Verify

```bash
aiwg doctor --provider grokbot
aiwg status --probe
```

Start a **new agent chat** (or re-read skills) after deploy — AIWG does not claim live-refresh or Cursor reload
wording for Grok Bot. Ask Grok Bot to verify AIWG by reporting the project root, provider files it can read,
installed frameworks, and one useful next action. Use `aiwg discover` / `aiwg show` for indexed agents and
commands.

Try one small task immediately after verification:

```text
Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged.
```

Success means Grok Bot names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or
the `AGENTS.md` bridge, and produces a concrete review you can inspect. For advanced flags, compatibility notes,
and recovery details, see the [Grok Bot operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/grokbot.md).

## Optional live smoke

Default CI skips live smoke. When you have an absolute skill root and want an opt-in check:

```bash
export AIWG_GROKBOT_LIVE_SMOKE=1
export AIWG_GROKBOT_SKILLS_DIR=/absolute/path/to/skills
npm run smoke:grokbot:live
```

Without those env vars the script prints a skip/contract report and exits 0. It never invents Cursor paths.
