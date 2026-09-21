# Claude Desktop as a first-class AIWG provider — assessment and issue plan

- Status: Filed — roctinam/aiwg#2623–#2634 (label `claude-desktop`), 2026-09-21
- Date: 2026-09-21
- Author: drafted from a live Claude Desktop Code-tab session on `grissom`
- Tracker: `git.integrolabs.net/roctinam/aiwg`
- Related: [ADR: Canonical and provider-native artifact destinations](../../architecture/adr-artifact-output-destinations.md),
  [Provider inventory](../../providers/provider-inventory.md),
  [Session intelligence plan](../session-intelligence/traceability-and-issue-plan.md)

## 1. Headline recommendation

**Do not add `claude-desktop` to `PROVIDER_IDS`.** Model it as a *deployable surface* of the
existing `claude` provider, and model the Claude Desktop **chat/Cowork** app as a separate,
non-filesystem companion surface.

Rationale, from evidence gathered in §2:

- The Desktop **Code tab is Claude Code**. This session runs
  `~/.config/Claude/claude-code/2.1.275/claude` with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.
  It reads and writes exactly the surfaces `claude` already owns: `.claude/agents`,
  `.claude/commands`, `.claude/skills`, `.claude/rules`, `.claude/hooks`, `.claude/settings.json`,
  `CLAUDE.md`, `.mcp.json`. Upstream states Desktop and CLI share CLAUDE.md, MCP servers, hooks,
  skills and settings ([desktop docs](https://code.claude.com/docs/en/desktop)).
- A second provider id would double-write the same directories, split
  `installed.<bundle>.deployedTo` records in `.aiwg/aiwg.config`, and break the idempotency and
  drift-receipt guarantees in `src/cli/services/deployment-verification.ts`.
- The registry already has the right primitive: `ProviderSurface.related[]` with
  `relationship: 'same-provider' | 'shared-adapter' | 'future-provider' | 'companion-standard'`
  (`src/providers/provider-definitions.ts:20-36`), used today for Devin Desktop / Devin CLI /
  Devin Product Skills under the `windsurf` provider (`src/providers/provider-definitions.ts:1238-1300`).

What genuinely differs and therefore needs new modelling:

| Axis | Claude Code CLI | Claude Desktop Code tab | Claude Desktop chat / Cowork |
|---|---|---|---|
| Deploy surfaces | `.claude/**`, `CLAUDE.md` | identical, **plus** `.claude/launch.json`, `.claude/worktrees/`, `.worktreeinclude`, `~/.claude/scheduled-tasks/**` | none on disk |
| MCP config | `~/.claude.json`, `.mcp.json` | same **plus** `claude_desktop_config.json`, which wins on name collision | `claude_desktop_config.json`, connectors, `.mcpb` extensions |
| Skills | user + project + enterprise + synced | same | account-enabled skills only; `!` shell execution disabled by policy |
| Scheduling | `/loop` (session-scoped) | local scheduled tasks (1-min min) + cloud routines (1-hr min) | routines |
| Environments | local | local, cloud, SSH, WSL | cloud |
| Output | files | files **plus** published Artifacts, docs connector, widgets | Artifacts, docs |

## 2. Evidence base

### 2.1 This session (empirical, `grissom`, 2026-09-21)

Environment markers present in a Desktop Code-tab session:

```
CLAUDE_CODE_ENTRYPOINT=claude-desktop
CLAUDE_CODE_DESKTOP_APP_VERSION=2.2553.1
CLAUDE_CODE_EXECPATH=/home/roctinam/.config/Claude/claude-code/2.1.275/claude
CLAUDE_CODE_HOST_SESSION_ID=local_419c20f4-…
CLAUDE_CODE_SESSION_ID=5c347e39-…
CLAUDE_CODE_MESSAGING_SOCKET=/run/user/1000/cc-socks/2672210.sock
CLAUDE_AGENT_SDK_VERSION=0.3.275
CLAUDECODE=1
AI_AGENT=claude-code_2-1-275_agent
```

**Neither `CLAUDE_CODE_VERSION` nor `ANTHROPIC_API_KEY` is set** — Desktop authenticates with
subscription OAuth (`CLAUDE_CODE_OAUTH_SCOPES` is present instead). Both are the env markers AIWG
keys its `claude` detection on.

On-disk layout observed:

```
~/.config/Claude/claude_desktop_config.json      # preferences + coworkUserFilesPath; no mcpServers on this build
~/.config/Claude/claude-code/<cc-version>/claude # the bundled Claude Code binary
~/.config/Claude/claude-code-sessions/<account>/<device>/local_<host-session>.json
~/.config/Claude/local-agent-mode-sessions/{<account>,skills-plugin}/…
~/.config/Claude/scratch-workspaces/<account>/<device>/scratch-<date>-<hash>/
~/.config/Claude/git-worktrees.json
~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl   # same tree the CLI uses
~/.claude/projects/<mangled-cwd>/memory/                # per-session agent memory
<repo>/.claude/worktrees/                               # present in this repo today
```

Tool surface available to a Desktop session that a CLI session does not have: `Artifact` /
`ArtifactComments` / `ArtifactData`, `Workflow`, `SendUserFile`, `PushNotification`,
`RemoteTrigger`, `Monitor`, `EnterWorktree`/`ExitWorktree`, `CronCreate`/`CronList`/`CronDelete`,
and MCP servers `ccd_session`, `ccd_session_mgmt`, `ccd_view`, `ccd_pr`, `ccd_window`,
`ccd_sidebar`, `ccd_settings`, `ccd_directory`, `ccd_connectors`, `Claude_Browser`,
`claude-in-chrome`, `terminal`, `visualize`, `scheduled-tasks`, `mcp-registry`, plus a
first-party docs connector.

### 2.2 Upstream documentation (fetched 2026-09-21)

- [Desktop app](https://code.claude.com/docs/en/desktop) — environments (local/cloud/SSH/WSL),
  permission modes incl. `auto`, worktrees in `<project-root>/.claude/worktrees/`,
  `.worktreeinclude`, preview servers in `.claude/launch.json`, browser pane, terminal pane,
  cross-session messaging with `crossSessionInbound`, PR/CI monitoring, computer use, and the
  managed-settings keys `managedMcpServers`, `sshConfigs`, `sshHostAllowlist`,
  `disableDesktopLocalSessions`, `browserExternalPageTools`, `disableBrowserExternalNavigation`,
  `disableAutoMode`, `disableMobileSimulatorTools`. **MCP precedence:** desktop-chat servers are
  loaded into local Code-tab sessions and win over `.mcp.json` on a name collision.
- [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) — local tasks
  stored as `~/.claude/scheduled-tasks/<task-name>/SKILL.md` (YAML `name` + `description`, prompt
  as body); schedule, folder, model and enabled state live outside the file. 1-minute minimum
  interval; cloud routines are 1 hour. Missed-run catch-up is one run per task.
- [Skills](https://code.claude.com/docs/en/skills) — current frontmatter includes
  `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `context: fork`,
  `agent`, `background`, `model`, `effort`, `paths`, `shell`, `argument-hint`, `arguments`,
  `metadata`. `~/.claude/skills/` is **not** loaded in Cowork or cloud sessions; those load skills
  enabled on the claude.ai account. Synced skills land in `~/.claude/skills/synced/`. In Cowork on
  desktop, `!` shell interpolation is replaced with a policy notice.
- [MCPB desktop extensions](https://claude.com/docs/connectors/building/mcpb) — `.mcpb` zip with
  `manifest.json` for one-click install into Claude Desktop.

### 2.3 AIWG today

- `claude` provider definition: `src/providers/provider-definitions.ts:508-551`. `related: []`.
  Detection env: `['CLAUDE_CODE_VERSION', 'ANTHROPIC_API_KEY']`.
- Capability matrix row `claude-code`: `agentic/code/providers/capability-matrix.yaml:16-74`.
  Seven feature keys only (`cron`, `agent_teams`, `tasks`, `mcp`, `behaviors`, `mission_control`,
  `daemon`); `daemon_tier: unsupported`.
- Session adapter: `src/sessions/adapters/claude.ts` (transcript JSONL + hook evidence + web export).
  Workspace→transcript mapping: `src/sessions/workspace-discovery.ts:105-108`.
- Agent Skills baseline: `src/skills/agent-skills.ts:20-27` and `src/skills/deployer.ts:50-57`
  recognize only `name, description, license, compatibility, metadata, allowed-tools`; the `strict`
  and `compatible` profiles treat any other field as an **error**
  (`src/skills/agent-skills.ts:46-67`).
- MCP install: `src/mcp/cli.mjs:98-115` and the docs at `docs/mcp/README.md:19-20,76-81`.
- Artifact destinations: only `claude-code.design` is referenced, at
  `src/smiths/context-pipeline/claude-hook.ts:44`.
- Provider onboarding precedent: the `grok-build` series (`fd7033ef8` → `10b5f9eca`) is the
  canonical worked example of the file set a provider change touches.

## 3. Verified defects — filed as roctinam/aiwg#2623–#2627

| # | Title | Evidence | Fix sketch |
|---|---|---|---|
| D1 [#2623](https://git.integrolabs.net/roctinam/aiwg/issues/2623) | `runtime-info` misreports scheduler backend in Claude Desktop | `src/cli/handlers/runtime-info.ts:331-339` gates native-cron on `CLAUDE_CODE_VERSION`/`ANTHROPIC_API_KEY`; both absent under Desktop OAuth. Observed: `aiwg runtime-info` printed *"external trigger required"* while `aiwg steward capabilities` printed *"cron — ✓ native"* in the same session. | Reuse `resolveActiveProvider()` instead of the ad-hoc env check; add the Desktop markers. |
| D2 [#2624](https://git.integrolabs.net/roctinam/aiwg/issues/2624) | `aiwg mcp install claude` does not target Claude Desktop | `docs/mcp/README.md:19-20,76-81` promises `~/.config/Claude/claude_desktop_config.json`; `src/mcp/cli.mjs:102-115` writes `.claude/settings.local.json`. | Split targets: `claude-code` → `.mcp.json` / `~/.claude.json`; `claude-desktop` → platform `claude_desktop_config.json`. Fix the doc either way. |
| D3 [#2625](https://git.integrolabs.net/roctinam/aiwg/issues/2625) | `mcpServers` in `.claude/settings.local.json` is not a documented MCP config location | Same code path as D2. Upstream lists `~/.claude.json` (user) and `.mcp.json` (project). | Verify against a live Claude Code session; if unsupported, emit `.mcp.json` and migrate existing writes. |
| D4 [#2626](https://git.integrolabs.net/roctinam/aiwg/issues/2626) | `clean:providers` destroys Desktop-owned state | `package.json` → `"clean:providers": "rm -rf … .claude …"`. This repo currently has `.claude/worktrees/` and Desktop stores `.claude/launch.json` there. | Prune only AIWG-managed subpaths, or explicitly preserve `worktrees/`, `launch.json`, `settings.local.json`. |
| D5 [#2627](https://git.integrolabs.net/roctinam/aiwg/issues/2627) | `claude` detection env markers are stale | `src/providers/provider-definitions.ts:513-518`. Neither marker is set in Desktop; detection currently only succeeds via the process-ancestry fallback in `src/cli/provider-resolution.ts`. | Add `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_DESKTOP_APP_VERSION`. |

## 4. Epics — filed as roctinam/aiwg#2628–#2634

Each epic lists the deliverable, the files it touches (modelled on the `grok-build` precedent), and
acceptance criteria. Suggested labels: `type:feature`/`type:bug`, `area:providers`, and
`area:sessions` / `area:skills` / `area:mcp` as applicable.

---

### EPIC A [#2628](https://git.integrolabs.net/roctinam/aiwg/issues/2628) — Provider identity: Claude Desktop as a declared surface of `claude`

**Deliverable.** `claude` gains `surfaces.related[]` entries and the resolver learns to report
*which* surface it is on.

Child issues:

- **A1 — Register the surfaces.** Add to `src/providers/provider-definitions.ts`:
  `claude-code-cli` (`same-provider`, deployable), `claude-desktop` (`same-provider`, deployable,
  aliases `desktop`, `cc-desktop`), `claude-desktop-chat` (`companion-standard`, **not** deployable,
  MCP/MCPB-only), `claude-code-web` (`future-provider`, not deployable). Paths per §1 table.
- **A2 — Surface-aware runtime resolution.** Extend `ProviderResolution` in
  `src/cli/provider-resolution.ts` with `surface: 'cli' | 'desktop' | 'web' | 'ssh' | 'wsl' | 'cloud' | null`
  derived from `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_DESKTOP_APP_VERSION` / `CLAUDE_CODE_HOST_SESSION_ID`.
  Fold D5 in here. Thread the surface through `aiwg runtime-info`, `aiwg steward capabilities`,
  `src/cli/command-log.ts:80` and `src/cli/skill-usage.ts:146` (both already read
  `CLAUDE_CODE_ENTRYPOINT` raw — normalize instead).
- **A3 — ADR.** `docs/architecture/adr-claude-desktop-surface.md`: why Desktop is a surface, not a
  provider id; the double-write and `deployedTo` hazards; what would change that decision.
- **A4 — Docs + inventory.** `docs/providers/claude-desktop.md`; update
  `docs/providers/provider-inventory.md` (surface note, not a new counted integration) and
  `docs/integrations/cross-platform-overview.md`. Keep
  `test/unit/providers/provider-doc-inventory.test.ts` green.

**Acceptance.** `aiwg steward capabilities` in a Desktop session reports provider `claude`,
surface `desktop`. `aiwg use <bundle> --provider claude` writes exactly the same bytes from CLI and
Desktop. Provider count in the inventory doc is unchanged (17).

---

### EPIC B [#2629](https://git.integrolabs.net/roctinam/aiwg/issues/2629) — Capability matrix: a Desktop capability profile and new feature vocabulary

**Deliverable.** The matrix can express per-surface capability, and gains keys for what Desktop
actually adds.

Child issues:

- **B1 — Per-surface overlay.** Add `surfaces:` to a provider row in
  `agentic/code/providers/capability-matrix.yaml` with a `claude-code` base and a `claude-desktop`
  overlay; teach `src/providers/capability-matrix.ts` to resolve base+overlay and
  `formatCapabilityTable()` to render it. Fix D1 as part of the consumer sweep.
- **B2 — Scheduling accuracy.** Model three distinct scheduling backends rather than one boolean:
  `loop` (session-scoped), `desktop-scheduled-task` (local, 1-min minimum, requires app open and
  machine awake, deterministic stagger, one catch-up run), `cloud-routine` (1-hr minimum, machine
  off OK, API/GitHub triggers). Today `cron: true` collapses all three.
- **B3 — New feature keys.** AIWG has no vocabulary for: `artifacts` (publish/read/update, shared
  DB, comments), `browser_preview` (browser pane + `.claude/launch.json` auto-verify),
  `computer_use`, `cross_session_messaging` (incl. the `crossSessionInbound` setting),
  `worktree_isolation`, `pr_ci_monitor`, `remote_execution` (cloud/SSH/WSL). Add them to
  `FeatureKey` in `src/providers/capability-matrix.ts:24` plus the `features:` block at
  `capability-matrix.yaml:725+`, defaulting every existing provider to unsupported.
- **B4 — Re-assess `daemon_tier`.** `claude-code` is `unsupported` today. Desktop scheduled tasks
  plus cloud routines are a genuine background-execution tier; decide whether that is
  `daemon_tier: native` for the Desktop surface or a new tier name, and reconcile with
  `docs/daemon-guide.md`.
- **B5 — Interaction block.** Record `ReportFindings`, `AskUserQuestion`, and the widget/artifact
  elicitation paths for the Desktop surface (`capability-matrix.yaml:50-53`).

**Acceptance.** `aiwg runtime-info --capabilities` shows a Claude Desktop row distinct from Claude
Code, and the matrix conformance tests cover base+overlay resolution.

---

### EPIC C [#2630](https://git.integrolabs.net/roctinam/aiwg/issues/2630) — Deploy and govern the Desktop-only on-disk surfaces

**Deliverable.** AIWG writes and protects the three artifact classes Desktop owns that AIWG
currently ignores.

Child issues:

- **C1 — `.claude/launch.json` generator.** AIWG already knows how to run projects
  (`apps/cockpit/scripts/cockpit-up.sh`, `aiwg run`, framework templates). Emit a managed
  `configurations[]` entry with an AIWG marker, merge-preserving operator entries the same way
  `.claude/settings.json` hooks are merged with `_aiwg_managed` / `_aiwg_id`. Include the
  `autoVerify` decision in the generated-output policy.
- **C2 — `~/.claude/scheduled-tasks/<name>/SKILL.md` writer.** Deploy recurring AIWG workflows
  (`issue-audit`, `best-practices-audit`, `cost-report`, `lint:*` gates) as Desktop scheduled
  tasks. This is a **partial** deploy by construction — schedule, folder, model and enabled state
  are not in the file — so it must report `support: 'degraded'` with an explicit operator step,
  consistent with the existing degraded-context contract. Guard against clobbering
  user-authored tasks; honour `CLAUDE_CONFIG_DIR`.
- **C3 — Worktree-safe cleanup and ignore policy.** Fix D4. Then make
  `tools/lint/tracked-generated-artifacts.mjs` and the `.gitignore` templates aware of
  `.claude/worktrees/` and `.worktreeinclude`, and decide whether AIWG should emit a
  `.worktreeinclude` so `.aiwg/` local state follows a session into its worktree.
- **C4 — Managed-settings awareness.** Read-only: when
  `disableDesktopLocalSessions`, `browserExternalPageTools`, `disableBrowserExternalNavigation` or
  `managedMcpServers` are in force, `aiwg doctor` should say so rather than proposing steps the
  operator cannot take.

**Acceptance.** `aiwg use … --provider claude` on a Desktop host produces a valid
`.claude/launch.json` and at least one scheduled task; `npm run clean:providers` leaves
Desktop-owned state intact; a deployment-verification run reports the scheduled-task surface as
`degraded` with the correct manual step.

---

### EPIC D [#2631](https://git.integrolabs.net/roctinam/aiwg/issues/2631) — Close the Agent Skills baseline drift

**Deliverable.** AIWG can validate, deploy and round-trip the skill frontmatter Claude Code and
Desktop actually document, without losing portability guarantees.

Child issues:

- **D1 — Extend the recognized field set.** Add the documented Claude fields as a *provider-scoped
  extension* layer alongside `STANDARD_SKILL_FIELDS` (`src/skills/agent-skills.ts:20-27`,
  `src/skills/deployer.ts:50-57`): `disable-model-invocation`, `user-invocable`, `disallowed-tools`,
  `context`, `agent`, `background`, `model`, `effort`, `paths`, `shell`, `argument-hint`,
  `arguments`. Today a legitimate Claude skill using `context: fork` fails the `strict` and
  `compatible` profiles outright.
- **D2 — Projection matrix per surface.** A skill using `!` shell interpolation is `native` in CLI
  and Desktop Code, `degraded` in Cowork (shell execution disabled by policy), and `unsupported`
  where `~/.claude/skills/` is not read at all (Cowork, cloud). Extend
  `AgentSkillProjectionStatus` consumers to reason per surface, and surface the result in
  `aiwg skill-lint`.
- **D3 — `synced` collision origin.** `AgentSkillCollisionOrigin` is
  `project | user | imported | aiwg-managed` (`src/skills/agent-skills.ts:40-45`). Account-synced
  skills land in `~/.claude/skills/synced/` on a ~10-minute refresh and can shadow AIWG-managed
  names. Add the origin and a deterministic precedence rule.
- **D4 — Budget reconciliation.** Upstream documents a 5,000-token per-skill / 25,000-token
  combined re-attachment budget. Reconcile with `docs/skills-budget-guide.md` and
  `tools/lint/context-size-guard.mjs`.

**Acceptance.** A Claude-native skill using `context: fork` + `allowed-tools` validates under
`compatible`, deploys unchanged to `.claude/skills/`, and projects to a documented degraded form
for providers that lack the field.

---

### EPIC E [#2632](https://git.integrolabs.net/roctinam/aiwg/issues/2632) — MCP and extension delivery to Claude Desktop

**Deliverable.** AIWG installs cleanly into both Desktop MCP surfaces, and ships as a one-click
extension.

Child issues:

- **E1 — Split the install targets.** Fix D2/D3. `aiwg mcp install claude-code` → `.mcp.json`
  (project) or `~/.claude.json` (user); `aiwg mcp install claude-desktop` → platform
  `claude_desktop_config.json` (`~/Library/Application Support/Claude/`, `%APPDATA%\Claude\`,
  `~/.config/Claude/`). Keep `claude` as a deprecated alias that warns and picks by detected surface.
- **E2 — Collision reporting.** Desktop-chat servers load into local Code-tab sessions and win on
  name collision. `src/mcp/registry.ts` must detect an `aiwg` entry in `claude_desktop_config.json`
  when injecting `.mcp.json` and report the shadowing rather than writing a silently-dead config.
- **E3 — `.mcpb` bundle.** Build an AIWG desktop extension (`manifest.json` + server) in
  `tools/release/`, with user config for `AIWG_ROOT`, published alongside the npm tarball. Add it
  to `docs/mcp/README.md` and the release discovery gates.
- **E4 — `managedMcpServers` recipe.** Document the enterprise push config, including `toolPolicy`
  restriction of the AIWG tool surface, in `docs/mcp/README.md`.

**Acceptance.** On Linux/macOS/Windows, `aiwg mcp install claude-desktop` produces a config Claude
Desktop loads after restart; `aiwg mcp install claude-code` produces one a Code-tab session loads
without restart; both are covered by contract tests.

---

### EPIC F [#2633](https://git.integrolabs.net/roctinam/aiwg/issues/2633) — Session intelligence for Desktop sessions

**Deliverable.** The session catalog understands Desktop session identity, scratch workspaces, and
non-local environments. Follows the `docs/planning/session-intelligence/` pattern.

Child issues:

- **F1 — Host-session linkage.** Desktop keeps a sidecar at
  `~/.config/Claude/claude-code-sessions/<account>/<device>/local_<host-session-id>.json` keyed by
  `CLAUDE_CODE_HOST_SESSION_ID`, distinct from the `CLAUDE_CODE_SESSION_ID` that names the
  transcript in `~/.claude/projects/`. Capture the pairing as session metadata so a catalog entry
  can be traced back to the sidebar session that produced it.
- **F2 — Scratch-workspace classification.** `src/sessions/workspace-discovery.ts:105-108` maps a
  workspace to `~/.claude/projects/<mangled-cwd>`. Desktop "No folder" sessions mangle to a path
  under `~/.config/Claude/scratch-workspaces/…` that corresponds to no project and is deleted with
  the session. Classify these as ephemeral, keep them out of project catalogs, and warn on import.
- **F3 — Non-local environments.** Cloud, SSH and WSL sessions have no local transcript, and SSH
  reads `~/.claude/skills/` from the *remote* host. Declare these `unsupported` or `degraded`
  explicitly in the adapter rather than returning an empty discovery.
- **F4 — Per-session memory directory.** `~/.claude/projects/<key>/memory/` is a new artifact class.
  Decide whether `tools/security/context-memory-firewall.mjs` should cover it, and whether AIWG
  should read it at all (it is agent-authored, so it is data, not instruction).
- **F5 — Conformance rows.** Add Desktop rows to
  `docs/planning/session-intelligence/provider-capability-matrix.md` and
  `provider-conformance-matrix.json`, with fixtures under `test/fixtures/sessions/`.

**Acceptance.** `aiwg sessions discover` run from a Desktop session on a real project finds the
transcript and labels it `surface: desktop`; run from a scratch workspace it reports an ephemeral
source and imports nothing by default.

---

### EPIC G [#2634](https://git.integrolabs.net/roctinam/aiwg/issues/2634) — `claude-desktop.artifact` as a governed output destination

**Deliverable.** Published Artifacts become a first-class, policy-gated presentation destination
under the existing ADR, not an ad-hoc side effect.

Child issues:

- **G1 — Register the destination.** Add `claude-desktop.artifact` (and, if kept distinct,
  `claude-desktop.doc` for the docs connector) alongside `claude-code.design`. Wire it into
  `src/smiths/context-pipeline/claude-hook.ts:44`, which currently recognizes only one destination
  id, and into the `provenance/artifact-outputs.jsonl` record.
- **G2 — Canonical-first conformance test.** Prove the ADR's ordering: canonical AIWG artifact
  written first, the Artifact recorded as a derived export with a link back. The CLAUDE.md
  bootstrap block already asserts this policy; it currently has no destination id to bind to.
- **G3 — Cockpit parity decision.** `apps/cockpit` is AIWG's own Tauri desktop surface. Decide
  whether Artifacts are an export target from Cockpit, a competing surface, or out of scope, and
  write it down before either grows a dependency on the other.

**Acceptance.** With `provider_native: explicit-only`, an explicit request to publish an Artifact
writes the canonical artifact first and appends a provenance row naming `claude-desktop.artifact`;
with `provider_native: disabled`, the request is refused with a diagnostic.

---

## 5. Suggested sequencing

1. **Defects D1–D5** — independent, small, each one removes a wrong statement about Claude from the
   product.
2. **EPIC A** then **EPIC B** — identity before capability; B1 depends on A2's surface concept.
3. **EPIC E** — highest user-visible value, and D2/D3 already open the file.
4. **EPIC D** — unblocks shipping AIWG skills that use current Claude frontmatter.
5. **EPIC C** and **EPIC F** in parallel.
6. **EPIC G** last; it depends on nothing above but is the least urgent.

## 6. Open questions for the maintainer

- Should `claude-desktop-chat` (Cowork) ever be a deployable target, or permanently MCP/MCPB-only?
  That decision sets the scope of EPIC E3.
- Does the 17-provider count in `docs/providers/provider-inventory.md` stay fixed if Desktop is a
  surface? (This plan assumes yes, consistent with `devin` being an alias rather than an entry.)
- Is `daemon_tier` the right home for Desktop scheduled tasks, or should scheduling stay entirely
  inside the `cron` feature with the three backends of B2?
- Are Desktop Artifacts in scope for AIWG governance at all, given the ADR's stated degraded-mode
  limitation that AIWG cannot suppress provider behaviour above its own surfaces?
