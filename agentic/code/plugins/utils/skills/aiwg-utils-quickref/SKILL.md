---
name: aiwg-utils-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: AUTO-INVOKE for ANY AIWG capability question, framework/addon/extension query, steward routing, MCP profile, or when unsure where to start. ALWAYS consult before filesystem search on .claude/.factory/.codex/.warp/etc. AIWG core utilities quick reference — always-on framing, steward, index, meta operations.
triggers:
  - "i do not know what AIWG has"
  - "translate my goal into AIWG search terms"
  - "run two or three aiwg discover searches"
  - "capability discovery"
---

# AIWG Core Utilities — Quick Reference

This is your always-loaded core directory for AIWG. It does **not** list every utility skill. Instead, it teaches the cross-cutting domains and gives you **curated search phrases** that map to `aiwg discover` lookups, plus a list of which framework-specific quickrefs are loaded.

## How to use this quickref

Walk the action hierarchy in order. The agent always prefers a **skill** over a raw CLI invocation:

1. **Priority 1 — Local skill or agent**: check if a skill already in your context handles the need (kernel skills listed below, framework quickrefs, deployed agents like `aiwg-steward` / `aiwg-finder`). These cost nothing to invoke.
2. **Priority 2 — Discovered skill**: if no local match, pick a **curated phrase** from a capability domain (or paraphrase the user's words), run `aiwg discover "<phrase>"`, surface the top match, and fetch its body with `aiwg show <type> <name>` — never `find` / `ls` / `Read`.
3. **Priority 3 — Raw CLI**: only when no skill exists at priorities 1 or 2, OR the command is on the discovery surface (`aiwg discover`, `aiwg show`, `aiwg list`, `aiwg version`, `aiwg runtime-info`), OR you are inside a skill that's calling the CLI as its step.

**Do not enumerate skills from memory.** AIWG ships hundreds of skills; you only see the kernel set in your context. See the [`cli-secondary` rule](../../rules/cli-secondary.md) for the full hierarchy and per-command pairings.

## The canonical pipeline: `discover → show`

Most AIWG skills (~460 of 480) are **not in your context** and are not in `<provider>/skills/` either — they stay at `$AIWG_ROOT` (no per-project copy by default, #1217). Two commands close the loop:

```bash
# 1. Find — returns ranked candidates with absolute paths
aiwg discover "<the user's need, paraphrased>"

# 2. Fetch — streams the SKILL.md body for the chosen candidate
aiwg show skill <name>          # or: agent | command | rule
```

`discover` and `show` are designed to compose. **You should never need to navigate the filesystem to read AIWG content.** That's the whole point of the CLI.

### When the platform Skill tool errors

Most AIWG skills aren't kernel-listed, so the platform's Skill tool will reject them. This is expected behavior, not a bug. The fallback hierarchy:

1. **`aiwg show <type> <name>`** — primary fetch. Always works regardless of kernel status.
2. **`aiwg show <type> <name> --json`** — same fetch with `{ path, content }` envelope, useful for forwarding to a sub-agent.
3. **Read directly from `$AIWG_ROOT/agentic/code/`** — last-resort fallback. Only if the `aiwg` CLI itself is broken. The corpus at `$AIWG_ROOT/agentic/code/frameworks/<name>/skills/<skill>/SKILL.md` and `$AIWG_ROOT/agentic/code/addons/<name>/skills/<skill>/SKILL.md` is the canonical source — it is always present at the install root and survives any deploy-state corruption.

**Forbidden after `discover` returns a path**: running `find`, `ls`, `Glob`, or `Read` on a `<provider>/skills/` directory. Those reflect the kernel-pivot deploy state, not the full surface. Use `aiwg show`.

This is mandated by the `skill-discovery` HIGH rule. Surface the top match (or top-3) to the user — the search is auditable.

## Framework quickrefs (loaded if framework is installed)

If a user asks about a specific framework's surface, the corresponding quickref is your first stop. These are kernel-resident, so they're already in your context:

- `sdlc-quickref` — software-development-lifecycle workflows
- `forensics-quickref` — incident response and digital forensics
- `research-quickref` — research corpus and citation workflows
- `media-curator-quickref` — media archive management
- `marketing-quickref` — marketing operations and campaigns
- `ops-quickref` — operational infrastructure and runbooks
- `security-engineering-quickref` — applied security and crypto decisions
- `knowledge-base-quickref` — wiki and documentation workflows

If a quickref isn't loaded, the framework isn't installed in this project. Use `aiwg list` to confirm.

## Addons & extensions (separate kernel quickref)

For everything **outside the framework set** — the ~214 skills across 29 addons (loops, voice, memory, color, testing, NLP, etc.) and 7 ops extensions (sys/net/sec/dev/it/stream/api-adapter) — load `aiwg-language-map`. It's also kernel-resident and acts as the orientation layer for the addon/extension surface, with curated discover phrases per capability domain.

```
aiwg-language-map  → addon capability domains + extension domains + cheat sheet
```

## Self-maintenance kernel (always loaded)

These ops **skills** are kernel-resident — already in your context regardless of `aiwg discover`. They are your primary surface for self-maintenance. Each skill carries the priming the bare CLI cannot — pre-flight checks, dry-run preview, preservation logic, recovery patterns.

> **Skills first, CLI second.** Each row below shows what the skill is for and the CLI command it calls under the hood. Invoke the skill — let it call the CLI. Direct CLI invocation skips the priming and is acceptable only on the discovery surface (Rule 2 of `cli-secondary`). See [`cli-secondary` rule](../../rules/cli-secondary.md) for the full policy.

| Skill (preferred) | Purpose | CLI it wraps |
|---|---|---|
| `steward` | Provider capability awareness + command routing | (no single CLI — orchestrates several) |
| `aiwg-doctor` | Installation health check + remediation | `aiwg doctor` |
| `aiwg-refresh` | Update CLI + redeploy frameworks with dry-run preview | `aiwg refresh` (alias: `aiwg sync`) |
| `aiwg-regenerate` | Regenerate AIWG.md + AGENTS.md preserving team directives | `aiwg regenerate` |
| `aiwg-status` | Workspace status dashboard | `aiwg status` |
| `aiwg-help` | List CLI commands, args, examples | `aiwg help` |
| `aiwg-issue` | Filing AIWG project issues (template, env, duplicate detection) | (no single CLI) |
| `aiwg-pr` / `aiwg-delivery-pr` | AIWG-specific delivery PRs only (delivery-policy, no-attribution, CI gate); not generic repository PR work | (no single CLI) |
| `use` | Deploy a framework or addon with validation gates | `aiwg use <name>` |

Pair with the `aiwg-steward` agent (always-deployed) for orchestrated repair: health check → refresh → re-doctor.

**Discovery commands stay direct** — `aiwg discover`, `aiwg show`, `aiwg list`, `aiwg version`, `aiwg runtime-info`, status/info subcommands. They have no paired "priming skill" because they ARE the priming entry points.

### Status intent disambiguation

Route these phrases carefully:

| User intent | Use |
|---|---|
| Workspace inventory, installed frameworks, deployed provider files | `aiwg-status` / `aiwg status` |
| Cross-framework project progress, "project-status", "where are we?", "what is next?" | `aiwg discover "project status"` → `aiwg show skill project-status --first` |
| SDLC-specific project health or lifecycle gate status | `aiwg discover "SDLC project health check"` and prefer `project-health-check` or `orchestrate-project` when those rank above generic workspace inventory |

Do not answer `project-status` by running only `aiwg status`; that command reports workspace install/deployment inventory, not project progress.

When a user wants to **file an AIWG product issue or open an AIWG delivery PR**, route them through `aiwg-issue` / `aiwg-pr` (or the explicit alias `aiwg-delivery-pr`) first. These are AIWG-specific kernel skills and reference `steward-prep-delivery` where applicable.

For generic repository PR work, use ordinary repository PR tooling and templates. Examples: "open a PR for this repo" → normal git/Gitea/GitHub PR flow; "open an AIWG delivery PR for this change" → `aiwg-pr`.

`aiwg-*` skills are AIWG-specific product/workspace capabilities. Do not route general tracker processing through `aiwg-issue`: use `issue-audit` / `audit-issues` for backlog audits and `address-issues` for implementation loops.

When a user wants to **start using issues for their own project**, especially local file-system backed issues, route them to the `issue-workflow-guide` agent or discover/show it if it is not already loaded. The guide helps choose local vs external tracker backends, suggests a project-specific issue key prefix, and explains how local issues feed `issue-audit` and `address-issues`. Keep the distinction sharp: `aiwg-issue` files issues against the AIWG product; `issue-workflow-guide` helps users operate project issues.

## Capability domains

| Domain | Covers |
|---|---|
| **Workspace status & health** | Workspace inventory, project status, doctor, version, runtime info |
| **Lookup & query** | Capability discovery, KB query, artifact lookup, AIWG help |
| **Maintenance** | Refresh, deploy, hooks, regenerate context files |
| **Mentions & traceability** | @-mention validation, lint, wiring across files |
| **Activity & provenance** | Activity log, provenance records |
| **Steward & policy** | Provider capability awareness, delivery policy |

## Curated discovery phrases

### Workspace status & health

```bash
aiwg discover "aiwg status"                    # → aiwg-status
aiwg discover "aiwg doctor"                    # → aiwg-doctor
aiwg discover "version"                        # → version
aiwg discover "runtime info"                   # → runtime-info
aiwg discover "project status"                 # → project-status (cross-framework project progress; then `aiwg show skill project-status --first`)
aiwg discover "SDLC project health check"       # → project-health-check / orchestrate-project
aiwg discover "workspace health"               # → workspace-health
```

### Lookup & query

```bash
aiwg discover "<capability phrase>"            # itself — discovery is the entry surface
aiwg discover "aiwg help"                      # → aiwg-help
aiwg discover "search aiwg knowledge base"     # → aiwg-kb
aiwg discover "artifact lookup"                # → artifact-lookup
aiwg discover "intake wizard"                  # → intake-wizard
```

### Maintenance

```bash
aiwg discover "aiwg refresh"                   # → update / refresh
aiwg discover "deploy framework"               # → use
aiwg discover "regenerate claude.md"           # → aiwg-regenerate-claude
aiwg discover "regenerate AGENTS.md"           # → aiwg-regenerate-agents
aiwg discover "hook enable"                    # → hook-enable
aiwg discover "hook disable"                   # → hook-disable
aiwg discover "hook status"                    # → hook-status
```

### Mentions & traceability

```bash
aiwg discover "mention validate"               # → mention-validate
aiwg discover "mention lint"                   # → mention-lint
aiwg discover "mention wire traceability"      # → mention-wire
aiwg discover "mention conventions"            # → mention-conventions
aiwg discover "mention report"                 # → mention-report
```

### Activity & provenance

```bash
aiwg discover "activity log"                   # → activity-log
aiwg discover "create provenance record"       # → provenance-create
aiwg discover "auto provenance"                # → auto-provenance
aiwg discover "record an effect"               # → effect-ledger (aiwg effect record)
aiwg discover "sign an effect"                 # → effect-ledger (signed intent + completed)
aiwg discover "reconcile effect"               # → effect-ledger (aiwg effect reconcile)
aiwg discover "did this PR merge"              # → effect-ledger (reconcile tracker.pr.merged)
```

### Steward & policy

```bash
aiwg discover "aiwg steward"                   # → steward (agent + policy router)
aiwg discover "delivery policy"                # → delivery-policy rule (and related skills)
aiwg discover "start using local issues"       # → issue-workflow-guide
aiwg discover "choose issue tracking backend"  # → issue-workflow-guide
aiwg discover "project-local customization"     # → project-local quickstart / customization docs
```

### Feature domains the steward owns (expansion / persona / project)

Three cross-cutting domains that no framework quickref owns — consult the `steward-quickref` kernel skill, or discover directly:

```bash
aiwg discover "author an expansion"            # → scaffold-extension / -addon / -framework
aiwg discover "create a persona"               # → soul-create (author a SOUL identity)
aiwg discover "select a persona"               # → persona agents (agentic/code/agents/personas/*)
aiwg discover "scaffold a project"             # → new-project (+ new-bundle for project-local)
```

### Project-local bundles (pilot → promote)

AIWG supports authoring rules/skills/agents per-project under `.aiwg/{extensions,addons,frameworks}/<name>/`, marketplace wrappers under `.aiwg/plugins/<name>/`, and custom provider selectors under `.aiwg/providers/<name>/`. Pilot here, promote upstream when mature.

```bash
aiwg new-bundle <name>                         # scaffold; auto-builds project graph
aiwg new-extension <name> --starter rule       # extension with a starter rule
aiwg new-provider <name>                       # provider selector using providerConfig.extends
aiwg new-bundle <name> --dry-run               # preview without writing
aiwg list --project-local                      # inventory + validation
aiwg doctor --project-local                    # health check (counts, drift, shadows)
aiwg use <name>                                # deploy a single project-local bundle
aiwg use sdlc --provider <name>                # select a project-local provider bundle
aiwg promote <name>                            # graduate to upstream (hash-verified copy)
aiwg promote <name> --dry-run                  # preview promotion
```

After scaffolding, the new bundle is immediately discoverable via `aiwg discover "<name>"`. The framework graph and the project graph search by default; no `--graph` flag needed.

## On-disk layout

```
agentic/code/        ← framework + addon source (NOT deployed; read-only reference)
.aiwg/               ← project artifacts (use cases, ADRs, test plans, etc.)
.claude/skills/      ← always-loaded "kernel" skills (this skill is here)
.claude/.aiwg/skills/ ← bulk AIWG skills (index-discoverable, not flat-listed)
.claude/agents/      ← AIWG agents (platform-native)
.claude/commands/    ← Generated command stubs for tab completion
.claude/rules/       ← AIWG rules
```

Same shape on every supported provider — see `docs/discovery-and-kernel-skills.md` for the full per-provider table.

## When to query the index versus answer from kernel

| Situation | Action |
|---|---|
| User asks "what can AIWG do?" generically | Skim the framework quickrefs above; offer the top 3 most-relevant. |
| User asks "find me a skill that does X" | `aiwg discover "X"` — return ranked candidates. |
| User asks "is there a skill for Y?" and it's not in any quickref | `aiwg discover "Y"` — don't say "no" without checking. |
| User asks about a specific framework's catalog | Direct them to that framework's quickref + invite a discover query. |
| User asks for AIWG version / config / status | `aiwg version`, `aiwg-status`, `aiwg doctor`. |

## When the curated phrases don't fit

```bash
aiwg discover "<your need, paraphrased>" --limit 5
```

If the top-3 results all score below ~0.20, the framework genuinely may not have a curated skill. Then improvise — but always check first.

## Anti-patterns

- **Do not enumerate skills from memory.** Query the index.
- **Do not deploy or modify framework source.** Files under `agentic/code/` are read-only references; project work happens in `.aiwg/` and any `src/` directories the project owns.
- **Do not bypass the steward for cross-provider questions.** If the user asks "does this work on Codex?" or "deploy to Cursor", invoke the AIWG Steward — it has the provider-capability matrix you don't.
- **Do not fabricate skill names.** If `aiwg discover` doesn't return a match, the skill genuinely may not exist — say so.

## When you don't know what to do

```bash
aiwg help                          # full CLI surface
aiwg discover "<your need>"        # find the right skill
aiwg-kb "<question>"               # conceptual help
```

If still stuck, ask the user — but ask narrowly, with options drawn from the index, not blank.
