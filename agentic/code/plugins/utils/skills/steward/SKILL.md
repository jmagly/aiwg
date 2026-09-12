---
namespace: aiwg
name: steward
platforms: [all]
kernel: true
description: Provide provider capability awareness and route commands by answering what the current provider supports natively vs must emulate
triggers:
  - "help me choose what to use"
  - "help me choose the right AIWG framework or skill"
  - "ask for one recommended path and one fallback"
  - "aiwg steward"
  - "steward repair AIWG setup"
  - "repair AIWG setup"
  - "AIWG setup is stale or broken"
  - "refresh provider files"
  - "clean up stale AIWG files"
  - "fix AIWG discovery"
  - "clean up AIWG issues"
---

# steward

You provide provider capability awareness and intelligent command routing. You read the canonical capability matrix to answer what the current provider supports natively, what must be emulated, and which command achieves a given goal on the active platform.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "what can this provider do" → capabilities for current provider
- "is X supported here" → feature check for current provider
- "how do I do X" (in provider context) → routing advice
- "what command handles Y" → find subcommand
- "which model should this use" → model policy route
- "model catalog or routing" → `aiwg steward models`
- "install or repair AIWG" → public provider-orchestrated setup manifest
- "AIWG setup is stale/broken" → steward repair ladder
- "refresh provider files" → status/doctor, dry-run refresh, then provider redeploy
- "clean up AIWG issues" → discover `issue-audit`, `aiwg-issue`, or `address-issues`

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Current provider capabilities | "what does my provider support" | `aiwg steward capabilities` |
| Named provider capabilities | "what does Cursor support" | `aiwg steward capabilities --provider cursor` |
| All providers | "show the full capability matrix" | `aiwg steward capabilities --all` |
| Feature check | "does my provider support agent teams" | `aiwg steward capabilities --feature agent_teams` |
| Routing lookup | "which providers support cron" | `aiwg steward find --capability cron` |
| Model routing | "which model should this use" | `aiwg steward models`; then `aiwg models audit` or `aiwg models resolve` |
| Install or repair AIWG | "get AIWG working in this project" | Follow the public `setup.aiwg.yaml`; use the self-verifying deployment result, with status and doctor only for audit or recovery |
| Stale provider files | "Codex says skills are missing" | `aiwg status --probe --json`, `aiwg doctor`, `aiwg refresh --dry-run`, then `aiwg use all --provider <provider>` or `aiwg refresh --provider <provider>` |
| Stale bootstrap/context | "doctor says the precedence is superseded", "WORKSPACE.md looks wrong", `precedence-superseded` / `precedence-missing` / `authority-missing` | `aiwg workspace-context doctor`, then `aiwg regenerate` to rewrite the managed blocks; re-run the doctor to confirm healthy |
| Rules not being honored | "the agent ignored an AIWG rule and cited harness instructions" | Check `aiwg doctor` → "Workspace context graph". A missing or superseded precedence means the bootstrap never asserted rule authority; `aiwg regenerate` restores it |
| Stale discovery | "discover cannot find a known skill" | Rebuild and sync the framework index, then re-run discovery |
| Issue cleanup | "clean up stale issues" | Discover first: `issue-audit` for backlog cleanup, `address-issues` for implementation, `aiwg-issue` for AIWG product issues |

## AIWG Installation Routing

For an interactive new, existing, stale, broken, duplicate, or development-mode
AIWG installation, follow
`https://aiwg.io/setup.aiwg.yaml` in the
current supported provider. It is a `provider-orchestrated` manifest: inspect
and explain before mutation, preserve existing work, then run one self-verifying
`aiwg use all` deployment and evaluate its `aiwg.use.result.v1` response. Do not
make index, regenerate, status, or doctor commands mandatory follow-up steps;
retain them for an explicit audit, maintenance, or recovery action. Do not send
this manifest to deterministic `aiwg setup-run`.

Route CI, cloud-init, container image, SSH-only, offline, and other
non-interactive cases to `docs/install/non-interactive.md`. Confirm ambiguous
project roots and verify each provider separately when a project uses more than
one provider.

## Setup Troubleshooting and Cleanup Routing

The steward is the primary route when an AIWG setup looks stale, broken, partly
deployed, duplicated, or confused by old provider files. Agents should not start
by grepping `.claude/`, `.codex/`, `.agents/`, `.cursor/`, `.warp/`, or other
provider directories. Start with the steward route, use CLI diagnostics, and let
AIWG decide what to prune or regenerate.

Use this recovery ladder:

1. Discover and load the route if it is not already loaded:

   ```bash
   aiwg discover "steward repair AIWG setup" --type skill
   aiwg show skill steward
   ```

2. Establish the actual workspace state:

   ```bash
   aiwg installation show --json
   aiwg status --probe --json
   aiwg doctor
   aiwg runtime-info
   ```

   Treat `installation.json` in the resolved global user-config directory as
   the provider-neutral source of truth for installation method, root, update
   executable, run mode, and channel. Never infer a replacement from the first
   `npm` or `aiwg` on `PATH`. If the report shows drift, stop ordinary refresh
   work and ask the operator to choose `aiwg installation adopt` or the
   explicit `aiwg installation switch --root ... --method ...` recovery path.

3. Preview cleanup before changing files:

   ```bash
   aiwg refresh --dry-run
   ```

4. Apply the smallest repair that matches the diagnosis:

   ```bash
   # Re-deploy and prune stale files for the active provider set.
   aiwg refresh

   # Re-deploy the complete default surface for one provider.
   aiwg use all --provider <provider>

   # Rebuild generated bootstrap/context files when AGENTS.md, AIWG.md,
   # CLAUDE.md, WARP.md, or other provider bridges are stale.
   aiwg regenerate
   ```

5. If discovery itself is stale after source edits or a failed deploy, rebuild
   the index and verify the route:

   ```bash
   aiwg index build --graph framework --force
   aiwg index sync --backend fortemi-core --graph framework
   aiwg discover "<original user need>"
   ```

6. Reload the provider session when `aiwg use`, `aiwg refresh`, or
   `aiwg regenerate` changes provider-facing files.

For issue cleanup, route through discovery instead of assuming a command:

- AIWG product bug or feature request: `aiwg discover "file an AIWG issue"` →
  `aiwg-issue`
- Backlog hygiene, stale issues, duplicates, or close/update recommendations:
  `aiwg discover "audit open issues"` → `issue-audit`
- Implement or process issue work: `aiwg discover "address issues"` →
  `address-issues`

When a broken or stale route is confirmed, file an AIWG correction issue with
the requested route, observed route, command output, AIWG version, provider, and
reproduction command. Use `aiwg-issue` for the product issue and include any
`status --probe` / `doctor` excerpts needed to reproduce the setup failure.

## Behavior

When triggered:

1. **Identify the subcommand**:
   - `capabilities` — show what a provider supports, optionally filtered by feature
   - `find` — show which providers support a capability and how to invoke it

2. **Detect provider context** (for `capabilities` without `--provider`):
   - Check `CLAUDE_CODE_VERSION` env → `claude-code`
   - Check `CODEX_API_KEY` env → `codex`
   - Check `.cursor/` project directory → `cursor`
   - Fall back to `aiwg runtime-info` for authoritative detection

3. **Run the appropriate command**:

   ```bash
   # Current provider capabilities (auto-detected)
   aiwg steward capabilities

   # Named provider
   aiwg steward capabilities --provider copilot

   # Check specific feature on current provider
   aiwg steward capabilities --feature agent_teams

   # Full matrix — all providers, all features
   aiwg steward capabilities --all

   # Find providers that support a capability
   aiwg steward find --capability cron

   # Model policy and dynamic catalog routing
   aiwg steward models
   aiwg models sources --json
   aiwg models audit --provider codex
   ```

4. **Interpret and surface routing advice**:
   - Native support: report the native tool or mechanism
   - Emulated support: show the `aiwg` command that emulates the feature
   - No support: report clearly and suggest the nearest alternative

## Project-Local Authoring Routing

Steward capability routing is intentionally broader than the provider matrix when the user asks how to create AIWG artifacts for their own project. For project-local authoring intents, do not answer only with `aiwg steward capabilities`.

Route these intents directly:

| User intent | Primary route | Notes |
|---|---|---|
| Create a repo/project-level skill | `aiwg new-bundle <name> --starter skill` or `aiwg new-extension <name> --starter skill` | Creates content source under `.aiwg/{extensions,addons,frameworks}/<name>/`; deploy with `aiwg use <name>`. |
| Create a project-level agent | `aiwg new-bundle <name> --starter agent` or SkillSmith/AgentSmith when generating from a prompt | Use project-local bundle layout so the artifact is versioned with the repo. |
| Create a custom provider selector | `aiwg new-provider <name>` or `aiwg new-bundle <name> --type provider` | Creates `.aiwg/providers/<name>/` with `providerConfig.extends`; select it with `aiwg use <framework> --provider <name>`. |
| Choose extension/addon/framework/plugin/provider shape | `aiwg discover "project-local customization"` and docs/customization quickstart | Extensions are the usual smallest local customization; addons/frameworks are heavier. Plugins are marketplace delivery wrappers. Providers are metadata selectors. |
| Make an agent invoke a custom skill | Create the skill in a project-local bundle, run `aiwg use <name>`, then reload the provider session | Session reload rules still apply. |

Canonical docs: `docs/customization/project-local-quickstart.md`, `docs/customization/project-local-lifecycle.md`, and `docs/customization/extensions-vs-addons-vs-frameworks-vs-plugins.md`. Mention that project-local artifacts and provider definitions are trusted repo code and should be reviewed before deploy.

Model-policy caveat: generated skills and commands must carry
`commandHint.modelRole` and `commandHint.modelTier`; generated agents must carry
`model-role` and `model-tier`. Do not suggest exact model IDs or legacy
`haiku|sonnet|opus` choices for new provider-neutral source artifacts.

Externalizing the artifact corpus does not externalize the project control
plane. Diagnose split-root state with `aiwg status --probe --json` or `aiwg
doctor`; preview recovery with `aiwg artifacts repair --dry-run`; use `--apply`
only after review. Never overwrite divergent control files or delete divergent
local corpus content.

## Feature-Domain Routing (proactive)

Three cross-cutting feature domains fall outside the framework quickrefs and were historically undiscoverable (#1623). The steward owns routing for them via the `steward-quickref` kernel skill. Be **proactive** — these are easy to miss:

| Domain | Canonical discover phrase | Owning capability |
|---|---|---|
| **Expansion authoring** (extension/addon/framework) | `aiwg discover "author an expansion"` | `scaffold-extension` / `-addon` / `-framework` |
| **Persona / SOUL** (author **and** select) | `aiwg discover "create a persona"` · `aiwg discover "select a persona"` | `soul-create`, persona agents under `agentic/code/agents/personas/` |
| **Project creation** | `aiwg discover "scaffold a project"` | `new-project`, `new-bundle` |

Routing protocol:

1. **Volunteer the affordance** (Norman signifier). When a user is near one of these domains but hasn't found the entry point, surface it unprompted: "you can also author expansions, create or select a persona, or scaffold a project — want me to discover one?"
2. **Discover, don't dead-end.** Run the domain's `aiwg discover` phrase; the four discover facets fuse the result so the owning capability ranks top-3.
3. **Re-query on low confidence.** If the first pass is weak, broaden the phrase or try an adjacent domain before concluding "not found" — the `skill-discovery` rule forbids decline-without-search.
4. **Show the selection.** `aiwg show <type> <name>` for the chosen capability.

See `steward-quickref` for the full anchor tables.


## Capability Matrix Source

The authoritative source is `agentic/code/providers/capability-matrix.yaml`. Key features tracked:

| Feature | Description |
|---------|-------------|
| `cron` | Scheduled/recurring task execution |
| `agent_teams` | Native multi-agent team orchestration |
| `tasks` | Background task dispatch |
| `mcp` | Model Context Protocol server support |
| `behaviors` | Hook-based behavior scripts |
| `mission_control` | Multi-session orchestration (`aiwg mc`) |

## Examples

### Example 1: Check current provider

**User**: "What does my provider support?"

**Extraction**: Capabilities request, no provider specified — auto-detect

**Action**:
```bash
aiwg steward capabilities
```

**Response**: "You are on **claude-code**. Native support: agent_teams, tasks, mcp, cron. Emulated via aiwg: behaviors (via hooks), mission_control (via `aiwg mc`)."

### Example 2: Feature-specific check

**User**: "Does my provider support agent teams natively?"

**Extraction**: Feature check — `agent_teams` on current provider

**Action**:
```bash
aiwg steward capabilities --feature agent_teams
```

**Response**: "agent_teams on **claude-code**: Native (uses Claude Code's built-in Task tool). No emulation needed."

### Example 3: Cross-provider lookup

**User**: "Which providers support cron natively?"

**Extraction**: `find` subcommand for `cron` capability

**Action**:
```bash
aiwg steward find --capability cron
```

**Response**:
```
cron support across providers:
  claude-code:  native
  codex:        external trigger (system cron/systemd/CI)
  copilot:      unsupported
  cursor:       unsupported
  factory:      unsupported
  opencode:     unsupported
  warp:         unsupported
  windsurf:     unsupported
  openclaw:     unsupported
```

External means the host scheduler owns time and launches a reviewed provider
command. It is not AIWG emulation; no `aiwg schedule` or `aiwg daemon` command
exists in the production CLI.

### Example 4: Full matrix

**User**: "Show me the capability matrix for all providers"

**Extraction**: `capabilities --all`

**Action**:
```bash
aiwg steward capabilities --all
```

**Response**: Formatted table of all named providers and requested features, with native/emulated/unsupported indicators from the authoritative capability matrix.

## Clarification Prompts

If the user's intent is ambiguous:

- "Are you asking about the provider you're currently using, or a specific provider?"
- "Should I check all features or a specific one?"

## References

- @$AIWG_ROOT/src/cli/handlers/steward.ts — Steward command handler
- @$AIWG_ROOT/agentic/code/providers/capability-matrix.yaml — Authoritative capability matrix
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
