# AIWG Steward — Routing Reference Lookups

Externalized from the agent definition per the few-shot-examples rule (#1587, #1600).

These are **Tier-3 reference-grade lookup tables** — large, mostly-static data the
steward consults on demand when answering a specific question. They are not the
steward's Tier-1 decision loop. The steward definition keeps role, guardrails, context
discipline, and exact next-hop routes inline; detailed routing tables live here or in
Tier-2 quickrefs such as `steward-quickref` and `aiwg-utils-quickref`.

The steward keeps the *ability* to route — it knows what each table covers and where the
live source of truth is (`aiwg steward capabilities`, `aiwg --help`, the agent-loop
Step 0 table, `steward-quickref`, `aiwg-utils-quickref`,
`agentic/code/providers/capability-matrix.yaml`). It reads this file when it needs the
full enumerated lookup.

Reach this file with:

```bash
aiwg discover "aiwg-steward routing reference"
# or read docs/agent-examples/aiwg-steward-routing-reference.md directly
```

---

## Tier-2 / Tier-3 Loading Protocol

The steward default dispatch is Tier 1. Follow this path for detail:

1. Start from the inline Tier-2 Routing Map in `aiwg-steward.md`.
2. For quick anchors, load `steward-quickref` or `aiwg-utils-quickref` with
   `aiwg show skill <name> --body`.
3. For enumerated tables, load this reference with
   `aiwg discover "aiwg-steward routing reference"` and then `aiwg show`.
4. If a route is ambiguous, ask one clarifying question.
5. If a route is broken or stale, file an AIWG correction issue through
   `aiwg-issue` / `steward-prep-delivery` with the broken target, expected target,
   observed command output, and reproduction command.

---

## Setup Repair and Cleanup Routing

The steward is the primary route when AIWG setup, deployment, provider bridges,
or discovery look stale or broken. Do not start with manual cleanup in provider
directories; first ask AIWG to diagnose and preview the repair.

| User intent | Route | Notes |
| --- | --- | --- |
| Get AIWG working in a project | Public `setup.aiwg.yaml` via the active provider | Provider-orchestrated, inspect-first, self-verifying install path. |
| Check whether AIWG is engaged | `aiwg status --probe --json` | Report engaged state, root, provider files, frameworks/addons, and next action. |
| Diagnose broken/stale setup | `aiwg doctor` | Use with `status --probe`; include output in any correction issue. |
| Preview stale provider cleanup | `aiwg refresh --dry-run` | Shows provider-file cleanup and redeploy changes before mutation. |
| Apply general repair | `aiwg refresh` | Preferred maintenance path when the project is already configured. |
| Re-deploy one provider | `aiwg use all --provider <provider>` or `aiwg refresh --provider <provider>` | Use when one provider bridge is stale or has missing kernel files. |
| Regenerate bootstrap/context files | `aiwg regenerate` | Use when `AGENTS.md`, `AIWG.md`, `CLAUDE.md`, `WARP.md`, or provider bridges are stale. |
| Repair stale discover results | `aiwg index build --graph framework --force` then `aiwg index sync --backend fortemi-core --graph framework` | Verify with the original `aiwg discover "<need>"` phrase after sync. |
| Clean up stale project issues | `aiwg discover "audit open issues"` → `issue-audit` | Use for stale, duplicate, malformed, or close/update recommendations. |
| Process issue work | `aiwg discover "address issues"` → `address-issues` | Use for implementation or issue-processing workflows. |
| File an AIWG product issue | `aiwg discover "file an AIWG issue"` → `aiwg-issue` | Use for AIWG setup bugs, broken routes, missing IDs, docs gaps, or product changes. |

Provider-facing repair commands usually require a provider reload before the
agent can see new kernel skills, commands, or bridge text. Tell the user when a
reload is required.

If the same route stays broken after refresh/regenerate/index rebuild, file an
AIWG correction issue with:

- AIWG version and install path
- provider and project root
- requested route and expected target
- observed route or error
- reproduction command
- relevant `status --probe --json`, `doctor`, and discover output

---

## Issue Workflow Routing

When a user asks to start using issues themselves, set up a project issue workflow, use
local issues, audit a backlog, or work through issues, do not route them to the AIWG
product issue filing skill by default.

| User intent | Route |
| --- | --- |
| File a bug or feature request against AIWG itself | `aiwg-issue` |
| Start tracking project work locally | `aiwg discover "start using local issues"` -> `issue-workflow-guide` |
| Choose between local, Gitea, GitHub, Jira, or Linear issue tracking | `aiwg discover "choose issue tracking backend"` -> `issue-workflow-guide` |
| Audit existing issues | `aiwg discover "audit open issues"` -> `issue-audit` / `audit-issues` |
| Implement or process issues | `aiwg discover "address issues"` -> `address-issues` |
| Sync local issues to an external tracker | local issue sync/import-export workflow |

For local issue tracking, explain the model as project-configured prefixes, markdown
issue bodies, metadata/state JSONL events, rebuildable indexes, and bounded issue slices
for agent workflows. If the installed version lacks local provider commands, say so and
recommend Gitea/GitHub or markdown notes as the temporary fallback.

---

## Project-Local Authoring Routing

Steward capability routing is broader than the provider matrix when the user asks how to
create AIWG artifacts for their own project. For project-local authoring intents, do not
answer only with `aiwg steward capabilities`.

| User intent | Primary route | Notes |
|---|---|---|
| Create a repo/project-level skill | `aiwg new-bundle <name> --starter skill` or `aiwg new-extension <name> --starter skill` | Creates content source under `.aiwg/{extensions,addons,frameworks}/<name>/`; deploy with `aiwg use <name>`. |
| Create a project-level agent | `aiwg new-bundle <name> --starter agent` or SkillSmith/AgentSmith when generating from a prompt | Use project-local bundle layout so the artifact is versioned with the repo. |
| Create a custom provider selector | `aiwg new-provider <name>` or `aiwg new-bundle <name> --type provider` | Creates `.aiwg/providers/<name>/` with `providerConfig.extends`; select it with `aiwg use <framework> --provider <name>`. |
| Choose extension/addon/framework/plugin/provider shape | `aiwg discover "project-local customization"` and docs/customization quickstart | Extensions are the usual smallest local customization; addons/frameworks are heavier. Plugins are marketplace delivery wrappers. Providers are metadata selectors. |
| Make an agent invoke a custom skill | Create the skill in a project-local bundle, run `aiwg use <name>`, then reload the provider session | Session reload rules still apply. |

Canonical docs: `docs/customization/project-local-quickstart.md`,
`docs/customization/project-local-lifecycle.md`, and
`docs/customization/extensions-vs-addons-vs-frameworks-vs-plugins.md`. Mention that
project-local artifacts and provider definitions are trusted repo code and should be
reviewed before deploy.

---

## Model Policy Routing

Route model questions through the effective model catalog and provider compiler. Do not
answer from stale exact model examples.

| User intent | Route |
|---|---|
| Explain cheap-first routing or escalation | `aiwg steward models` |
| Inspect catalog source/provenance | `aiwg models sources --json` |
| Refresh dynamic provider/account catalog | `aiwg models refresh --json` |
| Audit generated/source artifacts for a provider | `aiwg models audit --provider <provider>` |
| Resolve exact provider model selection | `aiwg models resolve --provider <provider>` |

Authoring contract: generated agents carry `model-role` and `model-tier`; generated
skills and commands carry `commandHint.modelRole` and `commandHint.modelTier`. Exact
provider IDs are deployment/compiler output, not the default source contract.

---

## Kernel-Pivot Deploy Model (#1212 / #1217)

Starting in 2026.5.0, AIWG splits skills into two tiers and uses a **no-copy** model for
the bulk of the surface:

| Tier | Where it lives | Per-project copy? | Discovered how |
|---|---|---|---|
| **Kernel** (15 skills today) | `<provider>/skills/` (e.g., `.claude/skills/`) | Yes | Platform-native flat scan, always-loaded |
| **Standard** (~385) | `$AIWG_ROOT/agentic/code/.../skills/<name>/` | **No** — read directly from source | `aiwg discover "<phrase>"` returns absolute paths anchored to `$AIWG_ROOT` |
| **Index** | `~/.local/share/aiwg/index/framework/` (XDG) | No, user-global | Built post-deploy by `aiwg use`, queried by `aiwg discover` |

**Kernel set = 9 framework quickrefs + 7 self-maintenance ops** (steward, aiwg-doctor,
aiwg-refresh, aiwg-status, aiwg-help, use, aiwg-regenerate). Behavior summary:
stale-skill cleanup prunes skills whose source no longer exists via the `.aiwg-managed`
marker; `--copy-all` opts into the legacy per-project mirror for sandboxed runtimes where
`$AIWG_ROOT` isn't readable; `aiwg discover --limit` defaults to 5; `aiwg show <name>`
resolves an unambiguous single name (use `aiwg show <type> <name> --body` when the type is
known). Version-specific provenance and edge cases (rc.17/rc.21/rc.23 changelog detail)
live in the worked-examples catalog.

**Deploy paths to know per provider** (kernel target only — standard tier no longer
copied by default):

| Provider | Kernel skills target |
|---|---|
| claude-code | `.claude/skills/` |
| cursor | `.cursor/skills/` |
| factory | `.factory/skills/` |
| copilot | `.github/skills/` |
| opencode | `.opencode/skill/` |
| warp | `.warp/skills/` |
| windsurf | `.windsurf/skills/` |
| openclaw | `~/.openclaw/skills/aiwg/` |
| hermes | `~/.hermes/skills/` |
| codex | `.agents/skills/` |

**Legacy `.aiwg/` mirrors**: in rc.10 → rc.13 the deployer copied standard skills to
`<provider>/.aiwg/skills/`. Starting in rc.14 those copies are skipped and any existing
legacy mirrors are pruned automatically on next `aiwg use`. If a user reports skills
"missing" from `.claude/.aiwg/skills/`, that's expected — point them at `aiwg discover`
and the absolute path it returns.

---

## Diagnostic — Is `$AIWG_ROOT` readable?

Before declaring a discover-path issue, verify the agent's environment can read AIWG_ROOT:

```bash
# From any project directory
aiwg version                                          # confirms install path
ls -la "$(aiwg version --json | jq -r '.installPath')/agentic/code/frameworks" | head -3
```

If `ls` fails or returns permission denied, the discover paths can't be `Read` by the
agent. Workarounds:
1. Set `AIWG_ROOT` to a user-readable copy of the install
2. Reinstall AIWG to a user-owned location: `npm install -g aiwg --prefix ~/.local`
3. Fall back to per-project copy mode (see "Force per-project copy" below)

## Force per-project copy (fallback)

When `$AIWG_ROOT` isn't accessible from the agent's runtime, fall back to the legacy copy
model:

```bash
aiwg refresh --provider <p> --copy-all
```

(Note: this flag is environment-driven, not declarative; document it in the user's project
README so other team members know.)

---

## CLI Toolset

Use these CLI commands for all operations. Never write files directly when a CLI command
exists.

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `aiwg version` | Check installed version | Start of any maintenance cycle |
| `aiwg update` | Pull latest from npm | When version is behind latest |
| `aiwg doctor` | Health check + diagnostics | Before and after every maintenance cycle |
| `aiwg refresh` | Update + re-deploy all frameworks | Most common maintenance operation |
| `aiwg refresh --dry-run` | Preview changes without applying | When user wants to check first |
| `aiwg refresh --provider <p>` | Refresh to a specific provider | Cross-provider deployment |
| `aiwg sync` | Deprecated alias for `aiwg refresh` | Still works, emits warning; do not use in new playbooks |
| `aiwg use <framework>` | Deploy/re-deploy a framework | Targeted deployment |
| `aiwg use <fw> --provider <p>` | Deploy to specific provider | Cross-provider targeted |
| `aiwg list` | Show installed frameworks | Inventory check |
| `aiwg remove <framework>` | Remove a framework | Only with user confirmation |
| `aiwg status` | Workspace health | Workspace-level check |
| `aiwg runtime-info` | Detect active provider | Provider identification |
| `aiwg validate-metadata` | Validate extension definitions | After modifications |
| `aiwg discover "<phrase>"` | Capability search across all installed skills/agents/commands/rules | When user asks "is there a skill for X?" or describes a capability without naming a skill |
| `aiwg discover "<phrase>" --type skill --json` | Same, programmatic output | When chaining into another agent or script |
| `aiwg index build --graph framework --force` | Rebuild the user-global capability index | When discover seems stale, or after manual edits to `agentic/code/` source |
| `aiwg catalog list` | Browse available frameworks | Discovery |
| `aiwg catalog search <q>` | Search available extensions | Discovery |
| `aiwg steward capabilities --provider <p>` | Show native vs emulated features for a provider | Capability questions |
| `aiwg steward capabilities --feature <f>` | Show provider support for a feature | Cross-provider questions |
| `aiwg steward capabilities --all` | Full capability matrix | Comprehensive audit |
| `aiwg steward find --capability <f>` | Routing advice for current provider | "What command should I use?" |
| `aiwg add-agent <name>` | Add individual agent | Targeted extension add |
| `aiwg add-command <name>` | Add individual command | Targeted extension add |
| `aiwg add-skill <name>` | Add individual skill | Targeted extension add |

---

## Command Routing Intelligence — Routing Examples

When a user asks "what command should I use for X?", the protocol (kept inline in the
definition) is: identify feature → detect provider → read capability matrix → recommend
native / emulated / closest-alternative. These rows are worked lookups for that protocol.
The live data is `agentic/code/providers/capability-matrix.yaml` and
`aiwg steward capabilities`.

| User Request | Provider | Correct Answer |
|-------------|----------|----------------|
| "I want to schedule a recurring task" | claude-code | Use `CronCreate` inside agent context; `aiwg schedule` from CLI |
| "I want to schedule a recurring task" | cursor | Use `aiwg schedule` — no native cron in Cursor |
| "I want to run agents in parallel" | claude-code | Use the `Agent` (Task) tool directly for short-lived subagents; `aiwg mc dispatch` for persistent missions |
| "I want to run agents in parallel" | factory | Use Factory Droids natively; `aiwg mc dispatch` for AIWG state tracking |
| "I want to use behaviors" | openclaw | Native — deploy to `~/.openclaw/behaviors/` via `aiwg add-behavior --provider openclaw` |
| "I want to use behaviors" | claude-code | AIWG emulation — `aiwg add-behavior` + daemon; Claude Code has hooks but not full behaviors |
| "Does Cursor support MCP?" | cursor | Yes — native MCP support. Configure with `aiwg mcp install cursor` |

---

## Catalog Search by Capability

When users ask "what can AIWG do for X?" without knowing the command name:

```bash
aiwg catalog search scheduling        # Find scheduling-related extensions
aiwg catalog search agent-teams       # Find team/parallel agent extensions
aiwg steward find --capability mcp    # Routing advice for MCP on current provider
```

---

## Orchestration & Loop Routing

For "iterate until done" / multi-agent orchestration / Mission requests, the canonical
routing surface is the **agent-loop Step 0 table**
(`agentic/code/addons/agent-loop/skills/agent-loop/SKILL.md`), backed by
`.aiwg/architecture/adr-workflow-routing.md`.

| User Request | Provider | Correct Answer |
|-------------|----------|----------------|
| "iterate on this until tests pass" (in-session) | claude-code / codex | Native `/goal "<task>; completion: <criterion>"` (#1451/#1469) — in-session loop |
| "fan out multiple agents in-session" | claude-code | MAY delegate the mechanism to the native Workflow tool; AIWG retains audit/gates/best-output/durability |
| "fan out multiple agents in-session" | codex | No core `/workflow` (it's plugin-provided, #1535); use the AIWG-owned `/aiwg-mission` or `aiwg mc dispatch` |
| "launch a Mission" / dynamic orchestration | any | `/aiwg-mission` (Codex) or `aiwg mc dispatch`; AIWG-owned durable conductor |
| "run detached/background/crash-resilient" | any | AIWG-native external route (`agent-loop-ext` / `ralph-external`) — native primitives are session-scoped |
| "coordinate Codex AND Claude agents" (cross-stack) | any | Cross-stack Mission (#1546) — one AIWG conductor dispatches workers to executors advertising the target `runtime:<name>` (for example `runtime:codex`) via the `serve` registry (`routeMission`) |

Invariant: whatever drives the worker mechanism, AIWG owns activity-log, gates,
best-output selection, checkpoint/resume durability, reproducibility, and cost. Native
primitives are in-stack workers; a Mission is the cross-stack conductor.

---

## Invocation Patterns

Worked "user says → steward action" lookups. The decision logic for these lives inline in
the definition; this is the enumerated quick-reference.

| User Says | Your Action |
|-----------|-------------|
| "make sure AIWG is up to date" | Full refresh: version check + update + re-deploy + verify |
| "deploy SDLC to Copilot" | `aiwg use sdlc --provider copilot` + verify |
| "health check" | `aiwg doctor` + structured report |
| "remove the media framework" | Confirm with user, then `aiwg remove media-curator` + verify |
| "what frameworks do I have?" | `aiwg list` + formatted summary |
| "deploy everything to cursor" | `aiwg refresh --provider cursor` |
| "repair the installation" | Full diagnostic: doctor → identify issues → refresh → verify |
| "what version am I running?" | `aiwg version` + compare to latest |
| "switch to the next channel" | `aiwg refresh --channel next` |
| "what's available?" | `aiwg catalog list` |
| "does my provider support scheduling natively?" | Detect provider → read matrix → report native vs emulated |
| "what command should I use to schedule a task?" | `aiwg steward find --capability scheduler` + explain result |
| "how does cursor compare to claude code?" | Cross-provider gap report from capability matrix |
| "what features are native on openclaw?" | `aiwg steward capabilities --provider openclaw` |

---

## References

- `few-shot-examples` rule — the inline ≤1 + catalog requirement and size ceiling
- #1587 — debloat oversized agent definitions
- #1600 — aiwg-steward reconcile + debloat (dual-source byte-identity)
- #1661 — steward Tier-1/2/3 split for sub-12 KB dispatch
- `agentic/code/providers/capability-matrix.yaml` — canonical live capability data
- `agentic/code/addons/agent-loop/skills/agent-loop/SKILL.md` — canonical agent-loop Step 0 routing table
- `docs/agent-examples/aiwg-steward-examples.md` — worked transcripts and report scaffolds
