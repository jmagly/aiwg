---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.grokbot
---

# Grok Bot Operational Reference

> **AIWG provider status:** Stable (`grokbot`). Promoted under [#210](https://github.com/jmagly/aiwg/issues/210) with Linux PUW, path security review, migration docs, and **maintainer guidance (2026-09-16) that Linux verification is sufficient** — macOS/Windows PUW is not required for release. Optional natives remain [#209](https://github.com/jmagly/aiwg/issues/209) and do not block stable.

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed.

Deploy AIWG into **Grok Bot** (multi-agent desktop assistant). This provider is
**not** Cursor IDE and **not** xAI Grok Build / API. Decision record:
[`docs/architecture/adr-grokbot-provider-target.md`](../../architecture/adr-grokbot-provider-target.md).

## Architecture

| Artifact | Where it lands | Notes |
|----------|----------------|-------|
| Context bridge | `<project>/AGENTS.md` + `WORKSPACE.md` + `.aiwg/AIWG.md` | Discover-first; explicit-read guidance |
| Agents / commands / rules | AIWG index | `aiwg discover` / `aiwg show` — no native CreateAgent claim |
| Skills (kernel) | `$AIWG_GROKBOT_SKILLS_DIR/` on `--scope user` / `--global` deploys | Project-scope deploys never write it; fail-closed without the env override |
| Skills (standard) | Index/discovery; optional `$AIWG_GROKBOT_SKILLS_DIR/.aiwg/skills` with `--copy-all` at user scope | Preserves operator-owned skills |
| Routines / connectors / teammates / memory / local machine | Grok-owned | Optional AIWG adapters evidence-gated ([#209](https://github.com/jmagly/aiwg/issues/209); [catalog](../../integrations/grokbot-native-surfaces-evidence.md)) |

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

## Migration from Cursor workaround

Grok Bot fleets that used `--provider cursor` should move to `--provider grokbot`.
Cursor IDE fleets stay on `cursor`. See
[`docs/migration/grokbot-from-cursor-workaround.md`](../../migration/grokbot-from-cursor-workaround.md).

## Deferred / evidence-gated natives (#209)

Optional adapters (routines, CreateAgent/teammates, connectors/MCP, registered-machine
probe, memory reference helper) remain **blocked** for AIWG writers: product docs
document UX (2026-09) but not an import/API/reload contract. Catalog:
[`docs/integrations/grokbot-native-surfaces-evidence.md`](../../integrations/grokbot-native-surfaces-evidence.md).
Does **not** block stable promotion.

Fail-closed scaffolding (typed contracts + default-OFF kill-switches; no writers):
[`src/providers/grokbot-natives/`](../../../src/providers/grokbot-natives/) —
operator notes in
[`docs/integrations/grokbot-native-adapters-scaffolding.md`](../../integrations/grokbot-native-adapters-scaffolding.md).
Baseline `aiwg use --provider grokbot` does not enable these surfaces.

- macOS / Windows PUW: **waived** by maintainer for #210 (Linux-only validation sufficient)

## Cloud session global install

On the Grok Bot shared computer, install AIWG globally like other harnesses:

1. Set absolute `AIWG_GROKBOT_SKILLS_DIR` (required for user-scope skill deploy).
2. `aiwg use all --provider grokbot --scope user`
3. In each repo/policy workspace: `aiwg use all --provider grokbot`
4. Start a new agent chat (or re-read skills) — AIWG does not claim live refresh.

Operator runbook: [grokbot-cloud-session-global-install.md](../../integrations/grokbot-cloud-session-global-install.md).

Optional natives (routines / CreateAgent / connectors) remain [#209](https://github.com/jmagly/aiwg/issues/209) and are **not** required for loading.
