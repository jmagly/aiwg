---
enforcement: high
---

# Use Local or Discovered Skill Over Raw CLI

**Enforcement Level**: HIGH
**Scope**: All agents on AIWG-managed projects
**Addon**: aiwg-utils (core, universal)
**Issue**: #1272; #1480

## Overview

AIWG is **agentic-first**. Skills/agents carry the priming (rules, gates, preservation logic, recovery); the CLI sits *underneath* as the imperative tool the skill calls. Raw CLI commands augment skill workflows; they do not replace skills. The skill is the driver and owns orchestration, formatting, synthesis, gates, and recovery.

## The Hierarchy

Preferred path for any action, strict priority order (P1→P4):

| Priority | Surface | When |
|---|---|---|
| **1. Local skill/agent** | Already in context (kernel skills, framework quickrefs, deployed agents) | Always check first — free to invoke |
| **2. Discovered skill/agent** | `aiwg discover "<need>"` + `aiwg show <type> <name>` | No local match; query index before improvising or falling to CLI |
| **3. Raw CLI** | `aiwg <command>` | Only when no skill exists, OR on the discovery surface, OR inside a skill calling CLI as its step |
| **4. Manual file ops** | Direct edits bypassing skill/CLI | Last resort — bypasses priming AND registry update logic |

Reaching for raw CLI for an *action* (mutation, deploy, scaffold, regenerate)? First ask "is there a skill — locally or via `aiwg discover`?" If yes, route through it. **Sole exception**: discovery/finder commands (Rule 2) are the priming entry points — primary and direct-callable; they bridge P2 to P1.

## Mandatory Rules

### Rule 1: Local Skill First, Then Discovered Skill, Then CLI

Walk **local skill → discovered skill → raw CLI** in order; never jump to CLI. (1) Check context — kernel skills (`use`, `aiwg-doctor`, `aiwg-refresh`, `aiwg-regenerate`, `aiwg-status`, `steward`), framework quickrefs, deployed agents (`aiwg-steward`, `aiwg-finder`). (2) No local match → `aiwg discover "<need>"` (~385 of 400 skills are out of context but one query away). (3) Fall to raw CLI only per Rule 7. The skill carries the priming; the CLI alone does not.

**Example** — "refresh AIWG": **FORBIDDEN** = run `aiwg refresh` directly (skips preservation logic, doctor pre-check, provider verification). **REQUIRED** = invoke the `aiwg-refresh` skill, which loads that priming then calls `aiwg refresh` with the right flags.

### Rule 2: Discovery Commands Stay Primary

These are the priming entry points and MUST remain direct-callable (read-only / list-only). They have NO paired skill — they ARE the priming:

| Command | Purpose |
|---|---|
| `aiwg discover` | Capability search across skills, agents, commands, rules |
| `aiwg show` | Fetch the body of a discovered artifact |
| `aiwg list` | List installed frameworks and addons |
| `aiwg catalog` | Search/list marketplace packages |
| `aiwg features` | List capability features |
| `aiwg help` | CLI command reference |
| `aiwg status` | Workspace health snapshot |
| `aiwg version` | Version + channel info |
| `aiwg runtime-info` | Provider + environment detection |
| `aiwg agentcard` | List installed agent capability cards |
| `aiwg-doctor` (read-only) | Health check without repair |
| `aiwg ralph-status`, `mc status`, `cost-report`, `metrics-tokens` | Read-only status |
| `aiwg index query/deps/stats`, `packages list/info`, `storage show/list-backends` | Discovery within a multi-subcommand surface |

### Rule 3: Mixed Subcommands — Classify Per Subcommand

Commands carrying both discovery and action subcommands — classify per subcommand:

| Command | Discovery subcommands | Action subcommands (skill-first) |
|---|---|---|
| `aiwg index` | `query`, `deps`, `stats` | `build` |
| `aiwg packages` | `list`, `info` | `remove`, `install` |
| `aiwg ops` | `status`, `list` | `init`, `adopt`, `discover --register`, `push` |
| `aiwg storage` | `show`, `list-backends`, `test` | `migrate` |
| `aiwg activity-log` | `show`, `stats` | `append`, `rotate` |
| `aiwg memory`/`reflections`/`kb`/`provenance`/`research-store` | `path`, `list`, `get` | `put`, `delete`, `append-log` |

### Rule 4: Action Commands — Always Prefer Skill

These CLI commands have paired skills/agents. When user intent maps to one, invoke the skill — not the raw CLI:

| CLI command | Paired skill/agent | Why the skill matters |
|---|---|---|
| `aiwg use <framework>` | `use` | Deploy validation, conflict resolution, registry gates |
| `aiwg refresh` | `aiwg-refresh` | Doctor pre-check, dry-run, provider verification |
| `aiwg regenerate` | `aiwg-regenerate` | Preserves team directives, AGENTS.md/AIWG.md integrity |
| `aiwg doctor` (repair) | `aiwg-doctor` | Diagnoses + invokes correct remediation |
| `aiwg init` | `intake-start` / project-init | Solution profile validation, intake gate |
| `aiwg new my-project` | `new-project` / intake-wizard | Scaffold + intake guidance |
| `aiwg promote` | promote | Hash verification, source preservation |
| `aiwg remove` | use/remove | Reverts cleanly, no orphaning |
| `add-agent`/`add-command`/`add-skill`/`add-behavior`/`add-template` | AgentSmith / CommandSmith / SkillSmith / template-engine | Scaffold validation, metadata, wiring |
| `aiwg scaffold-{addon,extension,framework}` | scaffold skills | Manifest validation, naming, deploy path |
| `aiwg ralph` | `ralph` | Completion-criteria, recovery, anti-laziness gates |
| `aiwg mc start/dispatch` | `mission-control` | Concurrency budget, supervisor wiring |
| `aiwg doc-sync` | `doc-sync` | Drift assessment, reconciliation |
| `aiwg lint`/`cleanup-audit`/`best-practices-audit` | lint / audit skills | Threshold config, false-positive handling |
| `aiwg sdlc-accelerate` | `sdlc-accelerate` | Phase-gate orchestration, multi-agent dispatch |
| `execution-mode`/`snapshot`/`checkpoint`/`reproducibility-validate` | reproducibility skills | Mode-appropriate priming |
| `aiwg steward` | `steward` agent | Provider-aware routing, fallback |
| `aiwg index build` | `post-commit-index-refresh` patterns | Targeted-graph rebuild, incremental |
| `aiwg ops <action>` (init, adopt, push) | ops framework skills | Workspace context, multi-repo discipline |
| `aiwg storage migrate` | storage skills | Per-subsystem migration, backend validation |

### Rule 5: CLI Augments; Skill Drives

For paired action surfaces, raw CLI examples are implementation affordances only (what the skill calls, or what a human operator types) — never documented as replacing the skill. The skill interprets intent, runs pre-flight/dry-run/preservation/authorization gates, calls CLI as bounded steps, synthesizes, owns formatting, and records state/recovery; the CLI does narrow imperative execution, not presentation. Docs MAY keep CLI examples, but paired-action examples must be framed as (1) a step the skill calls, (2) an explicit operator command, or (3) a discovery-surface diagnostic. Docs implying `aiwg <action>` is the agent's preferred path while a paired skill exists → file/fix drift under #1480.

### Rule 6: Skill Documentation Must Say So

Every skill with a paired CLI command MUST carry a one-line note: *"Prefer invoking this skill over running `aiwg <command>` directly. The skill carries the priming this CLI command needs."* Every CLI reference doc (e.g. `docs/cli-reference.md`) MUST, for paired commands, link the skill: *"Agents: invoke via the `[skill-name]` skill rather than calling this CLI directly. See `aiwg show skill <name>`."*

### Rule 7: When Raw CLI Is Acceptable

Invoke the CLI directly without a paired skill ONLY when: (1) the user explicitly typed the raw command (`"run aiwg refresh"`, not `"refresh AIWG"`); (2) no paired skill exists for the command; (3) the command is on the discovery surface (Rule 2); (4) you are inside a paired skill calling the CLI as its imperative step; (5) the CLI is used in a documented diagnostic-only mode (e.g. `aiwg doctor` read-only, no repair).

## Recovery

About to invoke a paired CLI command directly? STOP → `aiwg discover "<purpose>"` → `aiwg show skill <name>` → invoke the skill. If the paired skill genuinely doesn't exist (rare), file an issue to add the pairing.

## Interaction with Other Rules

Layers with `skill-discovery` (discovery is the encoded exception), `self-maintenance` (skills-first routing), `research-before-decision` (the skill IS the priming research), and `human-authorization` (gates live in the skill — bypassing it bypasses the gate). Universal across all AIWG providers.

## Checklist

- [ ] P1: Local skill in context? Invoke it.
- [ ] P2: Else `aiwg discover "<need>"`; returned a paired skill? `aiwg show` + invoke.
- [ ] P3: Only after P1/P2 exhausted, run CLI directly per Rule 7. If P1/P2 matched and you're still reaching for the CLI, stop and route through the skill.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/skill-discovery.md — Discovery-first protocol
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md — Self-maintenance routing (skill-first)
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md — Kernel quickref
- Issue #1272 — Origin of this rule

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-25
