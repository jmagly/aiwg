# AIWG Steward — Worked Examples

Externalized from the agent definition per the few-shot-examples rule (#1587).
These are the worked transcripts, sample report scaffolds, badge helper details, and
capability-walkthrough demonstrations that used to live inline. The steward definition
keeps only Tier-1 routing logic and pointers; this file carries detail that is useful on
demand but too bulky for default subagent dispatch.

## Output Format — Report Templates

The steward always reports results in a structured format. Use these scaffolds.

Standard maintenance report:

```markdown
## Steward Report

**Operation**: [what was requested]
**Provider**: [detected provider]
**Duration**: [time taken]

### Pre-Check
- Version: [current] → [latest available]
- Health: [doctor result before]
- Frameworks: [list of installed]

### Actions Taken
1. [action + result]
2. [action + result]

### Post-Check
- Health: [doctor result after]
- Changes: [summary of what changed]

### Recommendations
- [any follow-up suggestions]
```

Capability routing response:

```markdown
## Routing Advice: [feature] on [provider]

**Status**: ✓ Native / ~ Emulated / ✗ Not supported
**Tool/Command**: [native tool or AIWG command]

[Routing explanation from capability matrix]

[Note if applicable]
```

Cross-provider capability gap report (from the capability matrix):

```markdown
## Capability Gap Report: cursor vs. claude-code

| Feature | claude-code | cursor | Gap |
|---------|-------------|--------|-----|
| scheduler | ✓ CronCreate | ~ aiwg schedule | Use `aiwg schedule` |
| agent-teams | ✓ Agent tool | ✓ Background Agents | Native (different model) |
| mission-control | ✓ Task tool | ~ aiwg mc | Use `aiwg mc` |
| behaviors | ~ aiwg emulation | ~ aiwg emulation | No gap — both emulated |
| mcp | ✓ native | ✓ native | No gap |
```

## Worked Transcripts

### Example 1: Simple Refresh

**User**: "Make sure AIWG is current"

**Steward**:
```
Running pre-flight diagnostics...

$ aiwg runtime-info
Provider: claude-code

$ aiwg version
Current: 2026.3.12
Latest:  2026.3.15

$ aiwg refresh
Updating aiwg... 2026.3.12 → 2026.3.15
Re-deploying sdlc-complete to claude-code... done

$ aiwg doctor
All checks passed.

## Steward Report

**Operation**: Full refresh
**Provider**: claude-code

### Actions Taken
1. Updated AIWG 2026.3.12 → 2026.3.15
2. Re-deployed sdlc-complete (38 rules, 94 agents, 47 commands)

### Post-Check
- Health: All checks passed
- Changes: Version bump + 1 framework re-deployed
```

### Example 2: Cross-Provider Deploy

**User**: "Deploy SDLC to GitHub Copilot"

**Steward**:
```
$ aiwg runtime-info
Primary provider: claude-code

$ aiwg use sdlc --provider copilot
Deploying sdlc-complete to .github/agents/... done
Deploying rules to .github/copilot-instructions.md... done

$ aiwg doctor
All checks passed.

## Steward Report

**Operation**: Deploy SDLC to Copilot
**Provider**: copilot (secondary)

### Actions Taken
1. Deployed sdlc-complete agents to .github/agents/
2. Injected rules into .github/copilot-instructions.md

### Post-Check
- Health: All checks passed
```

### Example 3: Capability Routing Question

**User**: "I want to schedule a recurring task. What command should I use?"

**Steward**:
```
$ aiwg runtime-info
Provider: cursor

Reading capability matrix for cursor × scheduler...

## Routing Advice: scheduler on cursor

**Status**: ~ Emulated
**Command**: aiwg schedule

Cursor has no native AI-aware cron capability. Use `aiwg schedule` for all recurring agent
task scheduling. This uses the AIWG daemon to persist scheduled invocations.

Note: For non-AI recurring shell tasks, standard system cron (crontab) is available
independently of AIWG.

To create a schedule:
  aiwg schedule create --cron "0 9 * * 1-5" --task "run daily standup summary"
```

### Example 4: Destructive Operation (with confirmation)

**User**: "Remove the marketing framework"

**Steward**:
```
Before removing media-marketing-kit, I'd like to confirm:

This will remove:
- 12 agents from .claude/agents/
- 8 commands from .claude/commands/
- 3 skills from .claude/skills/
- Marketing-related rules from .claude/rules/

The framework source in agentic/code/frameworks/ is NOT affected.

Proceed with removal? [Awaiting confirmation]
```

### Example 5: Provider Comparison

**User**: "How does Cursor compare to Claude Code for the scheduler feature?"

**Steward**:
```
Reading capability matrix...

## Capability Comparison: scheduler

| Provider | Support | Tool / Command |
|----------|---------|----------------|
| claude-code | ✓ Native | CronCreate / CronList / CronDelete |
| cursor | ~ Emulated | aiwg schedule |

**claude-code**: Inside an agent context, use CronCreate for persistent native scheduling.
From the CLI, use `aiwg schedule`.

**cursor**: No native cron. Use `aiwg schedule` for all recurring task scheduling.

Gap: cursor lacks native CronCreate — `aiwg schedule` provides equivalent functionality
via the AIWG daemon.
```

## Kernel-Pivot Deploy Model — Version Provenance & Edge Cases

The steward definition keeps the kernel/standard/index tier table and the per-provider
deploy-paths table inline (those are capability data). The version-specific changelog
detail and edge cases were externalized here.

- **Self-maintenance ops promotion**: the first 6 ops (steward, aiwg-doctor, aiwg-refresh,
  aiwg-status, aiwg-help, use) were promoted to kernel in rc.17 so the agent retains repair
  surfaces even when discovery itself is broken; `aiwg-regenerate` joined in rc.37 (#1245) —
  regenerating platform context files is a core operational task that benefits from
  natural-language invocation without an `aiwg discover` round-trip.
- **Stale-skill cleanup (rc.21+)**: every `aiwg use` writes a `.aiwg-managed` marker file
  alongside SKILL.md. Post-deploy holistic cleanup uses the marker +
  `computeAllKernelNames(srcRoot)` to prune skills whose source name no longer exists
  (renamed/removed sources). Walks the AIWG root regardless of which framework is being
  deployed, so `aiwg use sdlc` doesn't accidentally delete media-curator's kernel skills.
  Codex pre-marker orphans (e.g., `doctor` from before `aiwg-doctor`) detected via
  `namespace: aiwg` frontmatter fallback.
- **No-copy opt-in**: pass `--copy-all` to `aiwg use` (alias `--copy-standard-skills`) to
  force the legacy per-project mirror behavior — writes all skills to
  `<provider>/.aiwg/skills/`. For sandboxed runtimes where `$AIWG_ROOT` isn't readable.
- **Discover defaults (rc.23)**: `aiwg discover --limit` defaults to 5 (was 10) per
  peer-reviewed K=3 hit-rate findings.
- **Show single-name fallback (rc.23)**: `aiwg show <name>` works when the name is
  unambiguous across artifact types. `aiwg show <type> <name> --body` still works and is preferred
  when the type is known. Multi-type matches still error with the disambiguation list.

## Post-Deploy Session Reload (#1240)

**Every `aiwg use` completes with new files on disk that the running AI session cannot see until it reloads.** Most agentic platforms read their `<provider>/agents/` directory at session start and cache the registry for the lifetime of the session. A deploy that just landed `software-implementer.md` (or any other agent) is invisible to the Agent/Task tool until the operator reloads — the tool will fail with `Agent type '<name>' not found. Available agents: <built-ins only>` and (with a fallback in place) silently downgrade to `general-purpose`.

When the user reports "Agent type not found" for an agent that clearly exists on disk, the cause is almost always a stale session, not a deploy bug.

**Reload requirement by platform:**

| Provider | What to do | Why |
|---|---|---|
| **Claude Code** | Close and reopen the session | `.claude/agents/` is scanned at session start |
| **Codex** | Restart the Codex session | `.agents/skills/` and `.codex/agents/` are scanned on startup |
| **Copilot (VS Code)** | `Developer: Reload Window` | VS Code caches workspace agent definitions |
| **Cursor** | Close and reopen the project | `.cursor/agents/` and `.cursor/rules/` load on workspace open |
| **Warp** | Open a fresh Warp tab | WARP.md is re-read on tab start |
| **Windsurf** | Reload the workspace | AGENTS.md is parsed once per workspace session |
| **Factory** | Restart the droid runtime | Factory caches the droid manifest at runtime start |
| **OpenCode** | Restart the OpenCode session | `.opencode/agent/` loads on session start (no hot-reload) |
| **Hermes** | `/reload-skills` and `/reload-mcp` (slash commands; restart chat as fallback) | Skill and MCP config are loaded at session start; Hermes provides in-session re-scan commands |
| **OpenClaw** | Restart OpenClaw | `~/.openclaw/agents/` and `~/.openclaw/skills/` load once per process |

`aiwg use` prints this notice in its post-deploy "Session reload required" section. If a user pastes "Agent type not found" output, your first move is to check whether their session was running before the most recent `aiwg use` — and if so, instruct them to reload per the table above before any further diagnosis.

## Hermes Composition Reference (#1244)

Hermes Agent ships a 65-command slash surface beyond the AIWG MCP seam. When users ask about composing AIWG with Hermes-side features, here's the authoritative routing:

| Hermes feature | What it is | AIWG composition |
|---|---|---|
| `/kanban` (15 verbs) | In-session multi-profile task board with todo→ready→running→blocked→done lifecycle (`hermes_cli/kanban.py`) | Kanban for in-session task flow; AIWG for persistent SDLC artifacts. Compose: a kanban task can call `aiwg-orchestrate` to produce the artifact, then mark itself complete with the artifact path |
| `/handoff <platform>` | Transfer active session to Telegram/Discord/Signal/Slack/Mattermost/Matrix/DingTalk/SMS (`gateway/run.py:_process_handoff`) | AIWG state survives the handoff (the MCP connection stays attached). Operators can start a workflow in terminal and finish from mobile |
| `/agents` (alias `/tasks`) | Inspect running tasks spawned via `delegate_task` | Use to monitor `aiwg-orchestrate` child agents during long workflows |
| `/goal "<text>"` | Standing goal across turns until achieved/paused/cleared | Pair with AIWG: `/goal "Complete SDLC inception"` triggers iterative `aiwg-orchestrate` calls toward the goal |
| `/cron` | Scheduled tasks (Hermes-side) | Boundary: `/cron` for recurring conversational tasks (digests, polls); `aiwg schedule` for recurring AIWG workflows that produce SDLC artifacts |
| `/snapshot` and `/rollback` | Hermes-state filesystem checkpoints | Different scope from `.aiwg/working/` — they don't overlap; no operator coordination required |
| `/background` (alias `/bg`, `/btw`) | Fire-and-forget prompts | Pairs with `aiwg-orchestrate` for non-blocking workflows |
| ACP adapter (`acp_adapter/server.py`) | Exposes Hermes as an Agent Communication Protocol server (Zed integration) | Three-hop chain works: `Zed → ACP → Hermes → MCP → AIWG`. No AIWG-side config required |
| Plugin system (`plugins/`) | Hermes-native plugins (kanban, memory, observability, disk-cleanup, google_meet, image_gen, …) | AIWG ships as MCP server, not a plugin — same AIWG code works against any MCP host. Don't redirect users to write a `plugins/aiwg/` |

When a user asks how to compose AIWG with Hermes-side features (`/kanban` for tasks, `/cron` for scheduling, etc.), use this table to give the boundary recommendation rather than guessing. Hermes file:line citations let you defend the answer if the user pushes back.

## Common Deploy Errata (per platform)

When users report deploy issues, run through this triage list:

### Universal

| Symptom | Likely cause | Fix |
|---|---|---|
| `aiwg discover` returns no results | Framework index not built or stale | `aiwg index build --graph framework --force` (or `aiwg use <framework>`, which rebuilds post-deploy) |
| Discover paths can't be `Read` by the agent | `$AIWG_ROOT` not readable from agent's cwd | Set `AIWG_ROOT` env var; verify install location with `aiwg version`; on system installs, may need to copy AIWG to a user-readable location |
| Skill budget alarm in `aiwg doctor` | Legacy skills still present in kernel dir | `aiwg refresh` — the new deployer prunes them on next pass |
| Version mismatch (`aiwg version` shows old) | Channel pinned to stable but pre-release was installed | `aiwg refresh --channel next` (RCs) or `aiwg refresh --channel latest` (stable) |

### Claude Code

| Symptom | Likely cause | Fix |
|---|---|---|
| Slash commands like `/sdlc-accelerate` don't appear in Claude session | rc.13+: standard skills no longer deploy as slash commands | Use natural language ("accelerated SDLC") — agent queries the index. Or run `aiwg sdlc-accelerate "..."` from CLI directly |
| `/doctor` says `"hooks" must be an object` | Pre-rc.11 hooks shape (array form) | `aiwg refresh` — rc.11+ writes object-keyed `hooks` and migrates legacy arrays |
| Kernel skills exceed budget | More than ~30 kernel skills on a tightly-budgeted context window | Reduce installed frameworks; or raise `skillListingBudgetFraction` in `~/.claude/settings.json` |

### Codex

| Symptom | Likely cause | Fix |
|---|---|---|
| Standard skills not found | Codex's home-dir script-deploy is on a different code path than the unified pipeline | Open issue #766 — kernel routing for the codex script path is deferred. Use the conventional `.codex/.aiwg/skills/` mirror as fallback |

### OpenClaw

| Symptom | Likely cause | Fix |
|---|---|---|
| Hits `DEFAULT_MAX_SKILLS_IN_PROMPT = 150` | More than 150 kernel skills installed | OpenClaw is the binding constraint. Kernel set should stay ≤30. If user added many `kernel: true` skills, they need to remove some |
| Skills not discovered by OpenClaw runtime | OpenClaw scans `~/.openclaw/skills/aiwg/` (2-level namespacing, PUW-025) | Verify deploy landed at `~/.openclaw/skills/aiwg/<name>/`. The 2-level layout is intentional |

### Hermes

| Symptom | Likely cause | Fix |
|---|---|---|
| Discover returns paths Hermes can't read | Hermes runs on host but `$AIWG_ROOT` may be in a path the runtime can't access | Verify with `ls -la $(aiwg version --json | jq -r '.installPath')`. May need to use legacy `.aiwg/skills/` per-project copy fallback |

### Cursor / Factory / Copilot / Warp / Windsurf / OpenCode

These platforms work cleanly with the no-copy model. If user reports issues, focus on the universal triage table above.

## Note: aiwg-steward dual source

The `aiwg-steward` agent has two source copies that must keep the same Tier-1 routing
contract:

| Copy | Path | Deployed to |
|---|---|---|
| **Canonical** | `agentic/code/addons/aiwg-utils/agents/aiwg-steward.md` | All standard providers via the manifest-driven deployer (`.claude/agents/`, `.factory/droids/`, etc.) |
| **Persona** | `agentic/code/agents/personas/aiwg-steward.md` | OpenHuman/persona selection surface |

The persona copy carries persona-specific frontmatter/triggers, so it is not
byte-identical to the addon agent. Keep role, guardrails, discover/show routes, and
Tier-3 pointers behaviorally aligned. Both copies use the same
`addons/aiwg-utils/...` pointer to this catalog, which resolves regardless of which copy
is loaded.

## References

- `few-shot-examples` rule — the inline ≤1 + catalog requirement and size ceiling
- #1587 — debloat oversized agent definitions
- #1600 — aiwg-steward reconcile + debloat
- #1661 — steward Tier-1/2/3 split for sub-12 KB dispatch

---

## Badge Helper — full reference

_Externalized from the agent def per #1600. The steward def keeps the badge capability + a pointer; the full verb→file table, snippets, and README-placement guidance live here._


When a user asks to add an AIWG ecosystem badge ("add a Built With AIWG badge", "give me a Powered By AIWG badge", "mark this repo as built with AIWG"), help them — tastefully, per the `aiwg-branding-restraint` discipline: one badge, not a wall.

**1. Verb → file.** Badges are hosted at `https://aiwg.io/assets/badges/` (immutable, CORS-open). Scheme: `<verb>-aiwg-<mode>.png`.

| Verb phrase | File stem |
|---|---|
| "built with" (default) | `built-with-aiwg` |
| "powered by" | `powered-by-aiwg` |
| "built on" | `built-on-aiwg` |
| "runs on" | `runs-on-aiwg` |
| "made with" | `made-with-aiwg` |
| "AIWG inside" | `aiwg-inside` |
| "AIWG wordmark" | `aiwg-wordmark` |

Also: `aiwg-icon-<mode>.png`, `sticker-*.png`, `aiwg-hero-<mode>.png` (+ `-1200x630`). Modes: `dark` (default — self-contained plate, reads on light or dark pages) and `light`. Default to `built-with` + `dark`; ask light vs dark only when the page background is ambiguous.

**2. Emit the snippet**, pointing at the hosted URL and linking to `https://aiwg.io`:

```md
[![Built With AIWG](https://aiwg.io/assets/badges/built-with-aiwg-dark.png)](https://aiwg.io)
```

HTML on request:

```html
<a href="https://aiwg.io"><img src="https://aiwg.io/assets/badges/built-with-aiwg-dark.png" alt="Built With AIWG"></a>
```

**3. Offer README placement (don't force).** If a README exists, offer to insert it after an existing shields/badge strip if present, otherwise right under the H1. Honor the `delivery-policy` rule before any commit/push — never auto-push without authorization.

**4. Point to the full set:** `https://aiwg.io/badges` (every variant + copy-paste Markdown/HTML, palette, downloads).

Example — user: *"add a powered-by AIWG badge to my README"*:
> Here's the Powered By AIWG badge (dark — reads on any background):
> `[![Powered By AIWG](https://aiwg.io/assets/badges/powered-by-aiwg-dark.png)](https://aiwg.io)`
> Want me to insert it under your README's H1? I'll follow your delivery policy — no push without your OK. Full set + light variants: https://aiwg.io/badges
