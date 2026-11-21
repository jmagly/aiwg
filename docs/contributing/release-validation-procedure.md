# Release Validation Procedure (Per Provider)

**Audience**: Maintainer driving release-readiness validation across all supported agentic stacks. Run this once per provider when validating a stable release (e.g. v2026.5.13).

**Assumption**: You hold a lowest-tier paid account on each provider. The in-session agent is expected to **report** outcomes accurately but is **not** expected to self-correct or debug. Your job is to capture verbatim what the session does, not to coach it into passing.

**Scope per session**: ~30 minutes. Each step has a Pass/Fail/Unsure verdict and an evidence slot. If a step Fails or is Unsure, **note it and continue** — don't block the rest of the run on one regression.

**Where to record**: The provider-specific child issue under the validation epic (e.g. `provider-validation(<name>): v2026.5.13 release validation`). Paste transcript excerpts directly in issue comments.

---

## RC response regression gate

After the RC build (#3201), check the [release comparison gate](release-comparison.md). Quarterly full validation runs the complete comparison against the last published package on Claude, Codex, and Hermes: the complete base/Wave 5 probe corpus plus the workflow scenarios, n=5 per side, identical subject model/settings, and a distinct blind judge model. Routine releases require current-quarter evidence whose tested commit is the candidate or an authenticated ancestor, plus candidate-specific approval recording any reuse. Resolve or explicitly accept each regression with a recorded reason linked to its evidence before shipping. Invalid or incomplete runs hold the gate. Higher-consequence model spot checks supplement the complete corpus. Do not count offline stub tests or a selected smoke set as the release comparison.

RC build → required tests → quarterly comparison or verified current-quarter reuse → fix or record acceptance for each regression → ship.

Review the recorded decision thresholds and per-scenario A/B/tie tallies before
dispositioning regressions. Assertion pass-rate drops and A-passed/B-failed pairs
always regress. Judge-only regressions require a one-sided exact sign-test
`p < 0.05` by default (ties excluded; at n=5 only 5/0 A wins qualify), or a
dimension mean drop greater than 1.0 on the integer 0–4 scale. Improvement uses
the mirrored tests; conflicting signals favor regression. Thresholds are
configurable with `--judge-alpha` / `judgeAlpha` and `--judge-score-margin` /
`judgeScoreMargin`; freeze them in the plan before running. The quarterly
producer uses defaults, and retained reports must match the trusted plan.
Check each report's p-values, B-minus-A dimension deltas, maximum absolute delta,
and fired rule alongside the per-pair evidence. See the
[decision rule](../../tools/rules/README.md) for bounds and details.

## 0. Pre-flight (Do once, on the host machine)

Run these checks **before** opening any provider session. They verify your local install is healthy and the version under test is what you expect.

```bash
# 0.1 — Confirm install is current
aiwg version
# Expected: 2026.5.13 (or whichever stable you're validating)

# 0.2 — Confirm install health
aiwg doctor
# Expected: all checks green; if any red, fix or note the failure before continuing.

# 0.3 — Pick a clean target project (fresh dir or empty repo)
mkdir -p /tmp/aiwg-rv-<provider-slug> && cd /tmp/aiwg-rv-<provider-slug>
# (Substitute <provider-slug>: claude, codex, copilot, etc.)
```

Record outcomes in the issue under **§ 0 Pre-flight**.

---

## 1. Deploy AIWG to the provider (Regression check #1)

```bash
# 1.1 — Deploy a small framework. Use sdlc-complete unless the provider's quickref calls for something else.
aiwg use sdlc --provider <provider-slug>
# OpenClaw is user-scope-only — it deploys to ~/.openclaw/ regardless of cwd;
# omit --scope (it now defaults to user) or pass --scope user.

# 1.2 — Probe the workspace state.
# Note: migration lives at .workspace.migration and the scoped flag at .workspace.workspace.isFrameworkScoped
# (top-level .migration is null — see #1523/#1524 validation).
aiwg status --probe --json | jq '{migration: .workspace.migration, isFrameworkScoped: .workspace.workspace.isFrameworkScoped}'
```

**Pass criteria — provider-dependent.** The migration/scoped probe is a *project-local* signal; it does not apply uniformly across providers.

*Project-local providers* (claude-code, codex, copilot, cursor, factory,
opencode, omp, pi, warp, devin) deploy into the project and migrate a
framework-scoped `.aiwg/` workspace:
- `aiwg use` exits 0.
- `migration.status` is `"completed"` (not `"partial"`) on a fresh workspace (regression check for #1516).
- `isFrameworkScoped` is `true`.

*Home-dir / user-scope providers* (**openclaw**, **openhuman**) deploy to the home dir and **do not create a project-local framework-scoped workspace** — so `migration.status` is `"none"` and `isFrameworkScoped` is `false` **by design. That is a PASS, not a #1516 regression.** The probe above is N/A for these providers; verify the home-dir deploy instead:

```bash
# OpenClaw — deploys to ~/.openclaw/ (home-dir, user-scope)
aiwg use sdlc --provider openclaw                              # exit 0
ls ~/.openclaw/agents ~/.openclaw/rules ~/.openclaw/behaviors  # populated
grep -c "AIWG SDLC Framework" ~/.openclaw/workspace/AGENTS.md  # >= 1 — Discover-First bridge (#1562)

# OpenHuman — deploys to .agents/ + .openhuman/ + AGENTS.md bridge
ls .agents/agents .openhuman/skills                            # populated
grep -c "AIWG SDLC Framework" AGENTS.md                        # >= 1
```
- `aiwg use` exits 0.
- The provider's deploy directories are populated.
- The context bridge is present (workspace `AGENTS.md` for openclaw; project `AGENTS.md` for openhuman).

**Evidence to paste**: the step 1.2 output, plus — for home-dir providers — the deploy-directory listing and bridge grep.

---

## 2. Deploy AIWG hooks (Regression check #2 — Claude Code only)

This step only applies if the provider is Claude Code. Skip for all other providers.

If you're on a workstation that **had AIWG installed before May 10, 2026** (pre-`be3ee551`):

```bash
# 2.1 — Show the current SessionStart hook reference in settings.json
jq '.hooks.SessionStart' .claude/settings.json
# Expected: command ends in "aiwg-session.cjs". If it ends in ".js", the v2026.5.13 hook fix has not yet
# been applied to this settings.json.

# 2.2 — If you saw ".js" above, refresh to trigger the heal
aiwg refresh
# Re-run 2.1 — command should now end in ".cjs".
```

**Pass criteria**: `.cjs` path in the hook command after refresh. If the path was already `.cjs` (new install), step 2.2 was unnecessary — record that as Pass.

---

## 3. Open a fresh provider session

Open the provider's UI / CLI / IDE — whatever is the canonical entry point for that provider — in the project directory from step 0.3. Make sure the deployed AIWG files are visible to the agent (no startup error referring to a missing file).

**Pass criteria**: Session opens. Agent acknowledges. No error banners about missing skills, missing config, missing hooks, or `MODULE_NOT_FOUND`.

**Evidence**: Copy any startup banner or error verbatim.

If the session fails to open or shows hook errors: STOP this provider's pass and report the error in the issue. Don't attempt to fix.

---

## 4. Discovery hookup — does the agent know how to find AIWG things?

Type **exactly this** into the session, verbatim:

> Find an AIWG skill that handles intake forms.

Watch what the agent does. Record which of the following it uses (one or more):

| Hook | Looks like |
|---|---|
| **rule** | Mentions the discover-first rule, or runs `aiwg discover` directly. |
| **config / context file** | Cites `AGENTS.md`, `AIWG.md`, `WARP.md`, `.github/copilot-instructions.md`, or the provider's equivalent context file. |
| **quickref** | Uses a loaded AIWG quickref skill (mentions `sdlc-quickref`, `aiwg-utils-quickref`, etc.). |
| **discovery-agent** | Delegates to `aiwg-finder` or the provider's curator / subagent equivalent. |
| **none** | Improvises from training data; never cites AIWG-specific surface. |

**Pass**: at least one hook fires AND the agent surfaces a real intake-related skill (`intake-wizard`, `intake-start`, or `intake-from-codebase`).

**Fail**: agent declines, claims AIWG has no such skill, or invents a skill name not in the index.

**Evidence**: paste the agent's reply verbatim (truncate to ~20 lines if very long).

---

## 5. Skill body fetch — can the agent read a deployed skill?

Type **exactly this** into the session:

> Read the AIWG quickref for AIWG utility discovery and summarize the fallback when a skill is not loaded.

Record the read-access behavior:

| Path | Looks like |
|---|---|
| **`aiwg show`** | Agent runs `aiwg show skill aiwg-utils-quickref --body` (or equivalent) and quotes the content. |
| **Direct file read** | Agent reads a `.md` file via its native Read tool. Acceptable for providers where `aiwg show` isn't reachable. |
| **MCP `rule-show` / `skill-show`** | Hermes only — agent uses MCP tool. |
| **Failure** | Agent guesses, declines, or references a non-existent path. |

**Pass criteria**: any of the first three (real content surfaces). **Fail**: guesswork or refusal.

**Evidence**: paste the agent's summary verbatim, especially the fallback description.

---

## 6. Skill invocation — does a representative skill actually run?

Type **exactly this**:

> Run aiwg discover for "deploy production" and tell me the top three results.

**Pass criteria**: agent either runs the `aiwg discover` command (CLI dispatch) or reports the top results via the index. The expected #1 result is `flow-deploy-to-production` (score ~0.51).

**Fail**: agent invents results, declines without trying, or surfaces names not in the deployed corpus.

**Evidence**: paste the discover output verbatim.

---

## 7. Provider-specific normalization verification

Each provider has gaps in what it natively offers; AIWG fills those gaps so behavior across the 11 stacks is comparable. Step 7 verifies that AIWG's normalization is actually doing its job for the provider under test. Skip the rows tagged `n/a` for providers you're not validating.

Each row has a **gap** (what the vendor doesn't do natively), an **AIWG normalization** (what AIWG ships to cover it), and a **verification** (what you check to prove the normalization landed). Pass = all rows green. Fail any row → record + continue.

### Universal pre-check (all providers)

Before opening the per-provider matrix, confirm the universal artifact-presence baseline:

```bash
# Verify AIWG knows where it deployed and what
aiwg list                                              # framework presence
aiwg discover "intake wizard" --limit 3 --json         # discovery surface live
aiwg show skill aiwg-utils-quickref --body | head -10         # quickref reachable
```

---

### 7-A. Claude Code

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| No declarative agent definitions — they live in markdown files only | Ships `.claude/agents/*.md` with frontmatter Claude Code parses | `ls .claude/agents/ \| wc -l` ≥ 1; open one in the IDE, confirm it shows in the agent picker |
| No project-level rule auto-load contract — only system prompt | Ships `.claude/rules/*.md` discovered by Claude Code's rules-directory loader; `CLAUDE.md` references AIWG context via `@AIWG.md` which transitively pulls the rules in | `ls .claude/rules/ \| wc -l` ≥ 50 (real deployed corpus); `grep -E "^@AIWG\.md" CLAUDE.md` returns 1; rules load on session start (verify by asking the agent which rules it's following). Note: `.claude/rules/` is the load path, not `@`-mentions in CLAUDE.md directly — that was the original verification's mistake. |
| Hook scripts must be `.cjs` because `"type": "module"` makes `.js` load as ESM and `require()` fails | Hooks installer (#1308) deploys `aiwg-{session,permissions,trace}.cjs` and re-writes stale `.js` paths in `settings.json` (v2026.5.13 fix) | `jq '.hooks.SessionStart' .claude/settings.json` shows a command ending in `.cjs`. Open a session — no `SessionStart:startup hook error` / `cjs/loader:1459` banner. |
| ~455 of ~480 skills exceed the listed-skills budget (25% of context window) | Kernel skill set (~20) is always-loaded; remainder reached via `aiwg discover` / `aiwg show` per the `skill-discovery` rule | Ask the session "How many AIWG skills are available?" — agent should answer "~480 reachable via aiwg discover, ~20 in the kernel set" or invoke discover instead of enumerating |
| No marketplace plugin install workflow without a marketplace.json | Ships `.claude-plugin/marketplace.json` with 13 plugins published | `/plugin marketplace list` in Claude Code shows AIWG; `/plugin install sdlc@aiwg` succeeds |

### 7-B. OpenAI Codex

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Commands are a static built-in enum in `codex-rs` — file-based commands are NOT scanned by the loader | `.codex/commands/` is deployed for operator visibility but the discovery bridge is `AGENTS.md` (linked aggressively per the 32KB cap) | Open `AGENTS.md` at repo root — it links to `.aiwg/AIWG.md`, frameworks, and rules. Size is well under 32KB (`wc -c AGENTS.md`). Inside session: agent uses AGENTS.md context, not the `.codex/commands/` files |
| `~/.codex/` is home-scope (cross-project) while repository skills need a project discovery path | Deploys prompts to `~/.codex/prompts/`, skills to `.agents/skills/`, and agents/rules to `.codex/`; AGENTS.md is the project-scope bridge | `ls .agents/skills/ \| wc -l` = canonical kernel count by default; `ls ~/.codex/prompts/ \| wc -l` ≥ 1; no AIWG-managed entries remain in legacy `~/.codex/skills/` |
| No native Skill tool dispatch — agent has no way to invoke a skill body | Agents must use `aiwg show skill <name> --body` via shell tool — discovery returns paths the agent fetches via Bash | Step 5 already proves this; in this session verify the agent uses `aiwg show` (not a direct path read) and the CLI returns content |
| OIDC trusted publishing not native to Codex workflow tooling | Documented in `docs/contributing/versioning.md`, automated via GitHub Actions OIDC step in `.github/workflows/npm-publish.yml` | N/A for in-session validation — release-pipeline concern |
| 32KB AGENTS.md cap (per Codex doc) means inlining everything overflows | `aiwg use` and `aiwg regenerate` emit a link-heavy AGENTS.md, not a content dump | `wc -c AGENTS.md` < 32000 |

### 7-C. GitHub Copilot

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Agents must use Copilot's `.agent.md` format (markdown + YAML frontmatter) with specific keys | Agents installer writes `.github/agents/*.agent.md` with correct frontmatter | `head -10 .github/agents/$(ls .github/agents/ \| head -1)` shows `---` frontmatter with `name`, `description`, `tools` |
| Rules are not free-form — they deploy as path-scoped `.github/instructions/*.md` with `applyTo:` frontmatter glob | Rules installer rewrites AIWG rules into instruction files with the right `applyTo` matchers | `head -10 .github/instructions/$(ls .github/instructions/ \| head -1)` shows `applyTo: "**/*.md"` or similar; activating on a matching file fires the rule |
| Commands deploy as `.github/prompts/*.prompt.md`, not loose markdown | Prompt files generated with `.prompt.md` extension | `ls .github/prompts/*.prompt.md \| wc -l` ≥ 1; invokable in Copilot UI |
| No discrete skills concept — only prompt files | Skills deploy to `.github/skills/` AND `.agents/skills/` (cross-agent mirror) | Both directories populated; agent in session reaches them via either path |

### 7-D. Cursor

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Rules auto-activate via glob frontmatter in `.cursor/rules/*.mdc` — not free-form `.md` | Rules installer generates `.mdc` files with correct `globs:` frontmatter | `head -8 .cursor/rules/$(ls .cursor/rules/*.mdc \| head -1)` shows `globs:` field; rule fires when matching file is open |
| Agents directory naming differs from Claude Code (`.cursor/agents/` vs `.claude/agents/`) | Provider adapter deploys to `.cursor/agents/` | `ls .cursor/agents/ \| wc -l` ≥ 1 |
| No Skill tool — skills are just files | `aiwg show` is the dispatch path; `.cursor/skills/` deployed for visibility | Step 5 already proves the agent uses `aiwg show` |
| Cursor context window varies by tier; agent should defer-to-discover, not eagerly load | Discovery-first rule deployed; quickref kernel set kept small | Ask session "list all AIWG skills" — agent should run discover, not attempt to load all |

### 7-E. Warp Terminal

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Warp reads single-file `WARP.md` natively (no rules-directory contract) | `aiwg use --provider warp` emits a **lean managed `WARP.md` bridge** — Discover-First Protocol + Context Finalization + Parallelism Cap near the top — not a full rules aggregate; discrete rules/commands/behaviors deploy under `.warp/` | `grep -c 'aiwg-managed' WARP.md` == 1 (lean managed bridge present) and `WARP.md` leads with the Discover-First Protocol. Do NOT expect a large `^### `-rule aggregate — that's the obsolete shape (`grep -c "^### " WARP.md` ≥ 10 no longer applies) |
| Warp has no native agents picker/directory contract for AIWG agents | Agents reachable via `aiwg discover` / `aiwg show`; the lean `WARP.md` bridge points at discovery rather than inlining an agent index (any `.warp/agents/` is operator-browsing only, not required) | Agent in session reaches AIWG agents via `aiwg discover` / `aiwg show` (not an inlined WARP.md agent dump) |
| Commands deploy to `.warp/commands/` (discrete) AND aggregated section in WARP.md | Both surfaces populated | `ls .warp/commands/ \| wc -l` ≥ 1; WARP.md has a "Commands" section |
| Behaviors not natively supported — aggregated into rules | `.warp/rules/behaviors/` directory contains behavior rules | `ls .warp/rules/behaviors/ \| wc -l` ≥ 1 |

### 7-F. Factory AI

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Agents live in `.factory/droids/` — different naming convention (droid, not agent) | Provider adapter renames on deploy and applies Factory's droid frontmatter | `ls .factory/droids/ \| wc -l` ≥ 1; droid frontmatter present |
| Commands and skills use `.factory/{commands,skills}/` | Standard deployment | Both populated |
| MCP-via-Factory binding is provider-specific | Configured via `.factory/` MCP config when relevant | If MCP servers configured: `aiwg mcp list` shows Factory-bound entries |

### 7-G. OpenCode

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Directory names are **singular** (`agent/`, `command/`, `skill/`, `rule/`) — not plural | Provider adapter writes to the singular path names | `ls .opencode/agent/ .opencode/command/ .opencode/skill/ .opencode/rule/` all exist and populated |
| Skills also need a cross-agent mirror at `.agents/skills/` | Both locations populated by deploy | `ls .agents/skills/ \| wc -l` ≥ 1 |
| OpenCode does not enforce frontmatter strictly; AIWG ships it anyway for portability | Files retain frontmatter even when not required | `head -5 .opencode/agent/$(ls .opencode/agent/ \| head -1)` shows `---` frontmatter |

### 7-H. Devin Desktop

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Devin Desktop reads `AGENTS.md` + `.windsurf/rules/` natively; there's no native agents picker, so agent reachability must be normalized | `aiwg use --provider devin` deploys agents to `.windsurf/agents/*.soul.md` (+ `.aiwg-manifest.json`) and emits a **lean discover-first `AGENTS.md` bridge** (not an inlined agent dump) | `ls .windsurf/agents/*.soul.md \| wc -l` ≥ 1 **AND** `grep -c 'aiwg-managed' AGENTS.md` == 1 (regenerated lean bridge present). Agents are reachable via `.windsurf/agents/` + the `.agents/skills/` mirror + `aiwg discover`/`aiwg show` — NOT via an obsolete inlined `^## Agent: ` block |
| Commands deploy to `.windsurf/workflows/` (not `commands/`) | Provider adapter uses correct path name | `ls .windsurf/workflows/ \| wc -l` ≥ 1 |
| Rules use `.windsurf/rules/*.md` with Devin Desktop-specific frontmatter | Generated with correct frontmatter | `head -8 .windsurf/rules/$(ls .windsurf/rules/ \| head -1)` shows expected frontmatter |
| Skills get `.windsurf/skills/` AND `.agents/skills/` mirror | Both populated | Both directories present |

### 7-I. OpenClaw

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| All artifacts deploy to `~/.openclaw/` (home-scope) — not the project | Provider adapter writes to home; `aiwg use sdlc --provider openclaw` populates home | `ls ~/.openclaw/{agents,commands,skills,rules}/ \| wc -l` ≥ 4 |
| First provider with **native behavior** support — all other providers receive generated behavior rules | Behaviors deploy natively to `~/.openclaw/behaviors/`; rules-derived behaviors deploy elsewhere | `ls ~/.openclaw/behaviors/ \| wc -l` ≥ 1; the files are real behavior bundles, not rule-generated stubs |
| OpenClaw's skill-listing budget is hard cap 150 | Same kernel-skill strategy as Claude Code | Inside session, "list all skills" — agent uses discover, not enumeration |
| Cross-project context lives in home; project-scope context loaded on session-start | Documented in OpenClaw deploy notes | Open OpenClaw on a fresh project — AIWG content from `~/.openclaw/` is reachable without re-deploying per-project |

### 7-J. Hermes

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Hermes baseline is file deploy + CLI discovery; MCP is optional sidecar enrichment | AGENTS.md/.hermes.md generated, skills deployed under `~/.hermes/skills/`, optional commands reach AIWG via `mcp_aiwg_command_run` | `AGENTS.md` names `aiwg discover`; optional MCP session lists `mcp_aiwg_command_run` |
| 16 core MCP tools by default; 45 more via `AIWG_MCP_TOOLSETS=<csv>` | Default tools available; opt-in extras via env var | Inside session, list MCP tools — count is 16 (or 61 if `AIWG_MCP_TOOLSETS=all`, including deprecated compatibility tools) |
| Standard skills (~460) recursively discovered under `~/.hermes/skills/.aiwg/`; kernel (~20) at top level | Curator (v0.12.0+) protects kernel via `.bundled_manifest` | `ls ~/.hermes/skills/ \| grep -v "^\.aiwg$" \| wc -l` ≥ 20 (kernel); `find ~/.hermes/skills/.aiwg/ -name SKILL.md \| wc -l` ≥ 300 (standard) |
| `AGENTS.md` + `.hermes.md` are the discovery bridges (no provider-native context file) | Both files generated by `aiwg use --provider hermes` | Both files present at project root |
| Rules inlined in AGENTS.md + reachable via CLI `aiwg show rule`; MCP `rule-list`/`rule-show` optional | Non-MCP and MCP surfaces populated | `grep -c "^### Rule:" AGENTS.md` ≥ 7; `AGENTS.md` contains `aiwg show rule <name> --body`; optional MCP `rule-list` returns rule names |

### 7-K. Omnius

| Gap (vendor side) | AIWG normalization | Verification |
|---|---|---|
| Omnius is a **first-party AIWG integrator** — no separate `aiwg use` step; AIWG ships embedded in the Omnius runtime | `npm i -g omnius` installs both; `aiwg discover` reachable inside Omnius sessions without project setup | Inside Omnius session: `aiwg discover "intake wizard"` returns ranked results without prior `aiwg use` |
| Omnius exposes AIWG via REST (`/v1/aiwg/*`) and MCP bridges | Bridges live in Omnius runtime, not in this repo | Inside session, agent can fetch a skill body via REST or MCP — paste agent's invocation verbatim |
| All AIWG-aware rules apply (`skill-discovery`, `delivery-policy`, `human-authorization`, `anti-laziness`) even though no provider-specific deploy ran | Embedded distribution carries the rules | Ask session "Which AIWG rules are active?" — agent should name at minimum the four above |
| Bundled runtime versioning may lag — Omnius releases on its own cadence | AIWG release ↔ Omnius bundled version is tracked separately | Check the Omnius release notes for the AIWG version it ships (compare to current `aiwg version` host install) |

---

Run the verification column commands. Paste any unexpected output. **Pass**: all rows green for the provider under test. **Fail**: at least one row shows the normalization didn't land — record which one in the issue.

---

## 8. Final verdict per provider

In the issue, at the top of your last comment, state one of:

```
VERDICT: PASS — all 7 checks green.
VERDICT: PASS WITH NOTES — N failures captured below, none release-blocking.
VERDICT: FAIL — release-blocking issue; details below.
```

Then list each step's outcome:

```
0. Pre-flight: PASS / FAIL / UNSURE
1. Deploy: PASS / FAIL / UNSURE
2. Hook heal (Claude Code only): PASS / FAIL / UNSURE / N/A
3. Session opens: PASS / FAIL / UNSURE
4. Discovery hookup: PASS / FAIL / UNSURE
5. Skill body fetch: PASS / FAIL / UNSURE
6. Skill invocation: PASS / FAIL / UNSURE
7. Provider regression spot check: PASS / FAIL / UNSURE
```

For every Fail or Unsure: a one-line note in the comment, AND a follow-up issue with the provider name in the title (so the matrix epic links to it).

---

## What a release-blocking failure looks like

These warrant immediate operator notice; everything else is captured as a known issue and rolled forward:

- `aiwg use` exits non-zero on a clean target.
- `aiwg status --probe` reports `migration: partial` on a fresh deploy (regression of #1516).
- Claude Code session shows `SessionStart:startup hook error → MODULE_NOT_FOUND` (regression of v2026.5.13 hook fix).
- Provider session refuses to open citing a missing AIWG file.
- Discovery hookup returns invented (hallucinated) skill names instead of real ones.

Other failures (one provider's discover doesn't fire, one provider's `aiwg show` isn't reachable, etc.) are captured as the per-provider follow-ups they always have been.

---

## When all child issues have a verdict

Close the epic with a summary comment of the form:

```
| Provider | Verdict | Notes |
|---|---|---|
| Claude Code | PASS | — |
| Codex | PASS WITH NOTES | discovery uses prompt-file path, not aiwg show |
…
```

This is the artifact future releases will reference when deciding "did we ship a regression on provider X."
