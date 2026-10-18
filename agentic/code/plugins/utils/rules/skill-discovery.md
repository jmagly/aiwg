---
enforcement: high
triggers:
  - "does AIWG have a skill for this"
  - "how do I find a capability"
  - "is there a command for this"
  - "AIWG does not seem to have"
---

# Skill Discovery Rules

**Enforcement Level**: HIGH
**Scope**: All AIWG-deployed agents on platforms with skill-listing budgets
**Addon**: aiwg-utils (core, universal)
**Issue**: #1215 (parent epic #1212)

## Overview

AIWG ships hundreds of skills/agents/commands/rules, but platforms cap how many they list. AIWG deploys two tiers: **kernel skills** (always loaded — ~10 quickrefs + core utilities) and **standard skills** (at `<provider-dir>/.aiwg/skills/`, *not* listed; reachable only through the artifact index). **Most AIWG skills are not in your context.** The discipline: **query the index before declining or improvising.**

## Mandatory Rules

### Rule 0: Recognize Directive Boundaries Before Acting

Classify every user turn before acting:
- **Continuation** — extends work in flight ("and also fix the test", "use Postgres instead"). Stay in context.
- **New directive** — a fresh task, often with its own scope ("address-issues #1230", "now do a security review"). Reset to discovery mode.

Re-classify at every turn boundary — **not just session start**: (1) the first message is always a new directive; (2) **after `/clear`**, the next message is a new directive even if it sounds like a continuation; (3) a user can pivot mid-session; (4) a fresh imperative after tool output is a new directive.

**On a new directive you MUST**: (1) name the task internally; (2) search the index via `aiwg discover` — non-optional, even if you think you know the skill, because the index is authoritative; (3) fetch with `aiwg show <type> <name>`; (4) then act. Skipping 1–3 is the failure this rule prevents. Common failure: user pastes a directive that names a skill (e.g. an `address-issues` table) and the agent reads it as commentary instead of acting.

If genuinely ambiguous (continuation vs new directive), ask one question rather than guessing. If you notice mid-session you misclassified, stop, acknowledge it, run `aiwg discover` against the actual directive, and resume from the correct skill.

### Rule 1: Query the Index Before Declining

Before saying "AIWG doesn't have a skill for that," you MUST run `aiwg discover "<the user's need, paraphrased>"`. The index covers every deployed artifact, including the 90%+ not in your context. Use the top match; if several are close, present the top-3.

**FORBIDDEN**: "AIWG doesn't seem to have a deployment skill, let me write a custom script." **REQUIRED**: run `aiwg discover "deploy production"` → use `flow-deploy-to-production`.

### Rule 1.5: Discover BEFORE Filesystem Search (discover-first protocol)

For any request mentioning **AIWG**, a framework name (sdlc, research, forensics, ops, security-engineering, knowledge-base, marketing, media-curator), or a capability keyword (skill, agent, rule, command, addon, workflow, flow, template), `aiwg discover` MUST be the first information-gathering call.

`Grep`/`Glob`/`Read` against these dirs is **FORBIDDEN** for AIWG lookups until `aiwg discover` has been consulted at least once this session: `.claude/`, `.codex/` / `~/.codex/`, `.github/{agents,skills,instructions,prompts}/`, `.cursor/`, `.warp/` / `WARP.md`, `.windsurf/` / `AGENTS.md`, `.factory/`, `.opencode/`, `.hermes.md` / `~/.hermes/skills/`, `~/.openclaw/`, and `agentic/code/` (when inside the AIWG repo). The failure this prevents: a literal-string grep hit short-circuits discovery and misses 10× the surface a ranked `aiwg discover` would return.

**When subagent delegation is available** (Claude Code Task tool, Hermes `delegate_task`, etc.), prefer dispatching the `aiwg-finder` agent over inline discover+show — it runs the query in its own context and returns the body + capability summary (~200 parent tokens vs ~3–8k inline).

You may skip the query when: the user named a specific skill/command; the need is clearly outside AIWG scope; you already queried this need this session; or the kernel quickref directly lists the skill. Otherwise, **discover first.**

### Rule 2: Query the Index Before Improvising

Even when you *can* build from scratch, check first for a curated skill — it encodes templates, gate criteria, multi-agent patterns, and framework conventions an ad-hoc version misses. (e.g. "generate a SAD" → `aiwg discover "create SAD"` → artifact-orchestration + the architecture-evolution flow, not freehand.)

### Rule 3: Quickrefs Are a Filter, Not a Limit

Kernel quickrefs are orientation, not an exhaustive list. When a need isn't verbatim in a quickref, query the index — don't assume the framework lacks the skill. Don't enumerate from memory.

### Rule 4: When to Skip the Query

Skip only when: the user named a specific skill/command; the need is outside AIWG scope (weather, translation, unrelated general programming); you queried the same need this session; or the quickref directly lists it.

### Rule 5: Discover → Show Is the Canonical Access Pattern

When `aiwg discover` returns a path, fetch the body with `aiwg show <type> <name>` — **never** `find`/`ls`/`Glob`/`Grep`/`Read` on the discovered path. `discover` is the lookup; `show` is the fetch; they compose. You should never navigate AIWG's storage layout.

```bash
aiwg discover "deploy to production"        # ranked candidates with paths
aiwg show skill flow-deploy-to-production   # streams the SKILL.md body
```

### Rule 6: When Skill Invocation Errors, Don't Fall Back to the Filesystem

If the platform's native Skill tool rejects a name (most AIWG skills aren't kernel-listed — expected), the fallback hierarchy is: (1) **primary** `aiwg show <type> <name>` (fetches via the index regardless of disk location); (2) `aiwg show skill <name> --json` (path + content envelope, for forwarding to a sub-agent); (3) **last resort, only if the `aiwg` CLI is broken** read the canonical corpus at `$AIWG_ROOT/agentic/code/frameworks/<framework>/skills/<name>/SKILL.md` or `$AIWG_ROOT/agentic/code/addons/<addon>/skills/<name>/SKILL.md`. **`find`/`ls`/`Glob` against `<provider>/skills/` are never correct** — they reflect only the kernel deploy mirror, not the full surface.

### Rule 7: Surface the Top Match, Don't Hide the Search

When you query, tell the user and name the candidate(s) with a one-line capability summary, so your reasoning is auditable and they can redirect.

## Query Patterns

```bash
aiwg discover "audit the supply chain"        # by capability
aiwg discover "validate" --type skill         # by type filter
aiwg discover "..." --json --limit 3          # token-tight; stable schema for sub-agents
```

## Recovery

- **Never queried**: STOP → `aiwg discover "<need>"` → read capabilities → `aiwg show` → apply.
- **Queried then went to the filesystem**: stop, fetch via `aiwg show` (the path is `$AIWG_ROOT`-anchored; no need to `find` it).
- **Skill tool errored on a non-kernel skill**: take the name+type from discover, `aiwg show <type> <name>`, apply its instructions yourself.
- **`aiwg` CLI broken**: read the corpus directly, then repair via `aiwg-doctor` → `aiwg-refresh` (the always-loaded self-maintenance kernel skills exist for exactly this).

Better to query late than not at all.

## Interaction with Other Rules

- **research-before-decision** — for AIWG-internal content, "research" means `aiwg discover` + `aiwg show`, NOT filesystem `Read`/`Glob`/`Grep`.
- **instruction-comprehension** — pass the *parsed* intent to discover, not ambiguous verbatim words.
- **human-authorization** — never invoke a destructive skill without authorization, even on a discover match.
- **god-session** — discover is one focused step; decompose complex multi-skill flows rather than absorbing them.

Universal across all AIWG providers — the `discover` subcommand works against the artifact index regardless of which provider deployed the skills.

## Checklist

Before declining: did I `aiwg discover "<need>"` with the right `--type`, read the top result's capability (not just its name), report close matches, and confirm the need is genuinely out of scope? After a discover match: did I use `aiwg show` (not the filesystem) to fetch the body, including as the fallback when the Skill tool errors?

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md
- Issue #1215 (this rule), parent epic #1212

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-09
