---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.grokbot
---

# Grok Bot Operational Reference

> **AIWG provider status:** Experimental (`grokbot`). Stable promotion is tracked in [#210](https://github.com/jmagly/aiwg/issues/210).

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed.

Deploy AIWG into **Grok Bot** (multi-agent desktop assistant). This provider is
**not** Cursor IDE and **not** xAI Grok Build / API. Decision record:
[`docs/architecture/adr-grokbot-provider-target.md`](../../architecture/adr-grokbot-provider-target.md).

## Architecture

| Artifact | Where it lands | Notes |
|----------|----------------|-------|
| Context bridge | `<project>/AGENTS.md` + `WORKSPACE.md` + `.aiwg/AIWG.md` | Discover-first; explicit-read guidance |
| Agents / commands / rules | AIWG index | `aiwg discover` / `aiwg show` — no native CreateAgent claim |
| Skills (kernel) | `$AIWG_GROKBOT_SKILLS_DIR/` when configured | Fail-closed without the env override |
| Skills (standard) | Index/discovery; optional `$AIWG_GROKBOT_SKILLS_DIR/.aiwg/skills` with `--copy-all` | Preserves operator-owned skills |
| Routines / connectors / teammates | Grok-owned | Optional AIWG adapters deferred ([#209](https://github.com/jmagly/aiwg/issues/209)) |

AIWG never writes `.cursor/**` for this provider and never invents `~/.grokbot`.

## Quick start (project)

```bash
aiwg use all --provider grokbot --dry-run
aiwg use all --provider grokbot
aiwg regenerate --provider grokbot
```

After deploy, **start a new Grok Bot agent chat** (or re-read skills). AIWG does
not claim live refresh until product behavior is verified.

## User-scope / global skills

Set an absolute skills root first:

```bash
export AIWG_GROKBOT_SKILLS_DIR=/absolute/path/to/grokbot/skills
aiwg use all --provider grokbot --scope user
# or
aiwg use all --provider grokbot --global
```

Without `AIWG_GROKBOT_SKILLS_DIR`, user-scope and `--global` skill deploys are
**blocked** with remediation. Relative paths and bare `~` are rejected.

`--global` is the no-project-deploy bootstrap (stage → user deploy → lightweight
project context). It is **not** identical to `--scope user` (additive mirror).

## Verify

```bash
aiwg status --probe --json   # Grok Bot restart copy — never Cursor wording
aiwg doctor --provider grokbot
```

## Deferred

- Optional native adapters (routines, CreateAgent, connectors): [#209](https://github.com/jmagly/aiwg/issues/209)
- Experimental → stable promotion: [#210](https://github.com/jmagly/aiwg/issues/210)
