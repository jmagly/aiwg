# Skill Listing Budget — User Troubleshooting Guide

**For users seeing**: `Skill listing will be truncated`, `N descriptions dropped`, or skills that exist on disk but don't appear when you ask for them.

AIWG ships ~480 skills across the SDLC, forensics, research, marketing, and ops frameworks. When you install several frameworks together, the host platform (Claude Code, Codex, etc.) may run past its skill listing budget and silently drop the lowest-priority descriptions. This guide explains what's happening and how to fix it for your platform.

For runtime costs after a Claude Code skill or subagent is invoked, see
[`docs/providers/claude-context-budget.md`](providers/claude-context-budget.md).

## The three budgets (do not conflate them)

1. **Startup skill listing** — skill `name` + `description` entries inlined
   every session. Claude Code: `skillListingBudgetFraction` of the context
   window (AIWG default assumption `0.01 × 200,000`; `aiwg doctor` compares
   `ceil(chars / 4)` listing tokens against
   `floor(fraction × window / 4)` — see `tools/cli/doctor.mjs`
   `resolveClaudeListingBudget`). Codex: upstream 2% skills-metadata ceiling
   (source: `docs/agents/providers/codex.md`, citing
   `codex-rs/core-skills/src/render.rs:18`), plus AIWG's enforced
   deployer-side cap of 8,000 startup-listing chars
   (`tools/skills/deploy-skills-codex.mjs` `CODEX_LISTING_CHAR_CAP`).
2. **Bridge bytes** — generated always-loaded context files, measured
   **per file** by `tools/lint/context-size-guard.mjs`
   (`DEFAULT_BRIDGE_CEILING_BYTES = 8 KiB`; default files `AGENTS.md`,
   `WARP.md`, `.hermes.md`, `.github/copilot-instructions.md`; check with
   `npm run lint:context-sizes`). This guard does not scan `CLAUDE.md`;
   the memory-plus-rules aggregate (including `CLAUDE.md`) is measured by
   the startup-context scan in `tools/lint/claude-context-inventory.mjs`
   against a 200,000-token standard baseline. Codex's separate per-file
   ingestion cap `project_doc_max_bytes` (default 32 KiB) is upstream, not
   the guard.
3. **Runtime reattachment** — full `SKILL.md` bodies and subagent definitions
   loaded on demand after invocation. Inventoried (not always loaded) by
   `tools/lint/claude-context-inventory.mjs`: skill bodies flagged above
   24 KiB (`DEFAULT_SKILL_CEILING_BYTES`), agent definitions above 16 KiB
   (`DEFAULT_AGENT_CEILING_BYTES`); `--strict` also fails when aggregate
   startup context is over budget.

---

## Quick fix by platform

| Platform | Setting | Default | If you see truncation, try |
|----------|---------|---------|----------------------------|
| Claude Code | `skillListingBudgetFraction` in `~/.claude/settings.json` | `0.01` (1% of context) | Raise to `0.05` (5%) |
| Claude Code | `skillListingMaxDescChars` | `1536` | Lower to `1024` to keep more skills full-length |
| Codex (OpenAI) | `project_doc_max_bytes` for AGENTS.md (bridge bytes, per-file upstream ingestion cap) | 32 KiB | Nest AGENTS.md per-subdir; do not raise blindly |
| Codex | Skill listing ceiling (upstream) | 2% of model context (source: `docs/agents/providers/codex.md`, `codex-rs/core-skills/src/render.rs:18`) | Fixed by Codex; reduce skill count or split workspaces |
| Codex | AIWG startup-listing cap (deployer-enforced) | 8,000 chars | `--listing-cap <chars>` or `AIWG_CODEX_LISTING_CAP` (`0` disables) |
| Cursor / Warp / Devin Desktop | Startup hook (AGENTS.md or WARP.md) | 8 KiB AIWG bridge ceiling | Kernel and indexes live in harness rules files |

---

## Claude Code 2.1.129+

Claude Code added two skill-listing settings starting in **2.1.129**. Both live in `settings.json` (precedence: user `~/.claude/settings.json` overrides project `.claude/settings.json`).

### `skillListingBudgetFraction`

A decimal fraction (not percentage) of the **active model's context window** that may be spent on skill name+description listings. Range: `(0, 1]`. Default: `0.01` (1%).

When the total listing exceeds this fraction, lower-priority skills lose their description first (kept as name-only), then drop entirely if still over budget.

### `skillListingMaxDescChars`

Maximum per-description character count. Default `1536`, raise to `2048` for less aggressive trimming, lower to `1024` to keep more skills under the budget. Each description longer than this gets shortened first; only then does the total-budget check run.

### What you'll see

```
Skill listing will be truncated
  425 descriptions dropped (full descriptions kept for most-used skills) (6.9%/1% of context)
  container-forensics, prose-detect, induct-research, +422 more
  run /skills to disable some, or raise skillListingBudgetFraction (currently 1%) in settings.json
  Opting in would cost ~14k tokens for skills every session and uses rate limits faster
```

The percentage notation is `<actual>/<budget> of context`. Above, 6.9% of the window is needed but only 1% is allowed.

### How to raise the budget

Edit `~/.claude/settings.json`:

```json
{
  "skillListingBudgetFraction": 0.05,
  "skillListingMaxDescChars": 1536
}
```

Restart Claude Code (or open a new conversation) for the change to apply. Cost trade-off: 5% of a 200k window ≈ 10k tokens spent every session.

### Disabling specific skills

Run `/skills` inside Claude Code to interactively disable skills you don't need. The selection persists for that workspace.

### Related GitHub issues

- [anthropics/claude-code#56448](https://github.com/anthropics/claude-code/issues/56448) — `2.1.129` started reporting "47 skill descriptions dropped" on configurations that loaded clean on `2.1.128`.
- [anthropics/claude-code#31505](https://github.com/anthropics/claude-code/issues/31505) — Skills silently dropped past ~28 limit (older bug, addressed by the new budget mechanism).

---

## OpenAI Codex

Codex uses **progressive disclosure**: only skill `name`, `description`, and file path enter the initial context. The full `SKILL.md` body loads only when Codex decides to use that skill.

### Caps you should know

| Limit | Value | Setting |
|-------|-------|---------|
| Startup skill listing in initial context (Codex's own ceiling) | 2% of model context (source: `docs/agents/providers/codex.md`, `codex-rs/core-skills/src/render.rs:18`) | Fixed by Codex; not user-configurable |
| AIWG's enforced startup-listing cap (deployer-side) | 8,000 chars (`tools/skills/deploy-skills-codex.mjs` `CODEX_LISTING_CHAR_CAP`) | `--listing-cap <chars>`, or `AIWG_CODEX_LISTING_CAP` (`0` disables) |
| Bridge bytes per generated file (AIWG guard) | 8 KiB per file (`tools/lint/context-size-guard.mjs` `DEFAULT_BRIDGE_CEILING_BYTES`; `npm run lint:context-sizes`) | Reduce generated bridge content; move detail to Tier 3 |
| Per-AGENTS.md ingestion size (upstream) | 32 KiB | `project_doc_max_bytes` (advanced config) |

Codex's ceiling is not adjustable. AIWG's cap — the budget the deployer enforces
so it never writes past that ceiling — is.

When the AGENTS.md size limit is hit, **Codex stops adding files silently** ([openai/codex#7138](https://github.com/openai/codex/issues/7138), [#13386](https://github.com/openai/codex/issues/13386)). Instructions near the end of an oversized file are ignored without warning.

AIWG's managed AGENTS.md block contains the WORKSPACE.md → AIWG.md bootstrap,
precedence, compact core rules and one hook per deployed harness. Codex's hook
requires reading `.codex/rules/RULES-INDEX.md` and every listed kernel file before
every task and subagent task. Kernel bodies and summary/path indexes stay in
rule files; this is prose-directed loading, not an automatic Codex rule loader.

### How to fix in Codex

1. **Nest AGENTS.md per subdirectory** rather than one giant root file. Codex respects nearest-ancestor first.
2. **Don't blindly raise `project_doc_max_bytes`** — it lifts the cap but doesn't help if descriptions are bloated.
3. **Reduce framework count** if you see truncation (see below).
4. **Let the deployer place overflow on the standard tier.** `aiwg use` keeps the
   startup listing (`.agents/skills/`) under the 8,000-char cap by default: when a
   bundle's skills would push it over, the largest non-kernel entries are written
   to `.codex/.aiwg/skills/` instead and named in the deploy output. They stay
   reachable through `aiwg discover` / `aiwg show`. Re-running
   `aiwg use <bundle> --provider codex` (no `--force`) re-places an existing
   over-cap deployment the same way; `--force` only overwrites unmanaged files and
   is never the budget fix.

   Controls:

   | Control | Effect |
   |---------|--------|
   | `AIWG_CODEX_LISTING_CAP=<chars>` | Set the cap (default `8000`); `0` disables budgeting |
   | `--listing-cap <chars>` (deploy script) | Same, per invocation; passing it also activates the budget |
   | `--listing-budget` (deploy script) | Honor the cap even when `--copy-all` is in effect |

   Activation rule: `aiwg use` passes `--listing-budget` only on the
   project-local path, where the deployer forces `--copy-all` itself so bundle
   skills are reachable at all. An operator's own `--copy-all` means "everything
   in the listing" and is not budgeted unless `--listing-cap` is given
   explicitly.

---

## Reduce AIWG skill footprint

Independent of platform settings, you can reduce how many skills AIWG deploys.

### Workspace-aware deployment

Preview the workspace-aware plan without writing files:

```bash
aiwg use --workspace-signals
```

AIWG inspects the current project and deploys only matching bundles. It always
keeps core lifecycle support (`sdlc`) and AIWG utility skills (`aiwg-utils`).

To deploy a workspace-aware subset, choose a profile explicitly:

```bash
aiwg use --profile forensics
aiwg use --profile research
aiwg use --profile marketing
```

To install everything:

```bash
aiwg use all
```

To skip utility addons during a full install:

```bash
aiwg use all --no-utils
```

Current signals:

AIWG currently uses these signals:

| Signal | Included bundle |
| --- | --- |
| `.aiwg/forensics/` | `forensics` |
| `.aiwg/research/` | `research` |
| `.aiwg/marketing/` | `marketing` |
| `.aiwg/media-curator/` | `media-curator` |
| `.aiwg/ops/` | `ops` |
| `.aiwg/knowledge-base/` | `knowledge-base` |
| `.aiwg/security-engineering/` | `security-engineering` plus `sdlc` |
| `package.json` plus `src/` | `sdlc` |
| `Dockerfile` or Compose file | `forensics` |
| `.aiwg/intake/solution-profile.md` text hints | matching profile |

Optional config hints may be placed in `.aiwg/aiwg.config`:

```json
{
  "skillLoading": {
    "profile": "research",
    "include": ["ops"]
  }
}
```

After a workspace-aware deployment, inspect what was included and filtered out:

```bash
aiwg list --deployed
```

The report is recorded at `.aiwg/workspace-skill-plan.json` so the decision is
reviewable after deployment.

### List installed frameworks

```bash
aiwg list
```

### Remove a framework you don't need

```bash
aiwg remove media-marketing       # if you're not running marketing workflows
aiwg remove forensics-complete    # if you're not doing IR
aiwg remove research-complete     # if you're not running a research corpus
```

Per-framework approximate skill counts:

| Framework | Skills | When you need it |
|-----------|--------|------------------|
| `sdlc-complete` | ~116 | Most projects (requirements → deployment) |
| `aiwg-utils` | ~111 | Always on (deploys with everything) |
| `media-marketing` | ~33 | Marketing campaigns, content ops |
| `research-complete` | ~39 | Research corpora, citation graphs |
| `forensics-complete` | ~20 | Incident response, forensic investigation |
| `media-curator` | ~20 | Personal media archive |
| `security-engineering` | ~27 | Security/cryptography reviews |

The big cost is when you stack everything: full install ≈ 480+ skills. A focused install (sdlc + utils) is ~228 skills and fits comfortably in default Claude Code budgets.

### Workspace-per-purpose pattern

If you regularly switch between very different domains (forensics, marketing, dev), run separate workspaces with separate framework installs rather than one mega-workspace with everything deployed.

---

## Doctor diagnostics

```bash
aiwg doctor
```

`aiwg doctor` runs a per-provider **Skill Budget** check (#1150) for each startup skills directory it finds. The check sums each `SKILL.md`'s `name + description` from frontmatter, converts via the standard ~4 chars/token heuristic, and compares against the platform's default budget.

Doctor's **Deployed Skill Count** check measures startup-visible skills for Claude Code and Codex (`kernelSkillsPath`). Hidden standard-tier skills remain available through `aiwg discover` and `aiwg show` and do not count against these listing budgets. A default kernel-only install can therefore retain its full hidden inventory without a warning. If the visible listing exceeds the budget, inspect it with `aiwg list --deployed` and reduce the startup-visible set before raising a platform budget.

| Platform | Budget |
|----------|--------|
| Claude Code | Startup skill listing: `floor(skillListingBudgetFraction × context_window / 4)` listing tokens by doctor's ~4 chars/token heuristic (defaults `0.01 × 200,000 / 4 = 500` tokens; see `tools/cli/doctor.mjs` `resolveClaudeListingBudget`) |
| Codex | Startup skill listing: AIWG deployer-enforced 8,000-char cap (`tools/skills/deploy-skills-codex.mjs` `CODEX_LISTING_CHAR_CAP`; `aiwg doctor` compares startup-visible kernel-dir chars against it), under Codex's upstream 2% ceiling |
| Other | Info-only line — no documented budget |

Bridge bytes are not part of this check: `npm run lint:context-sizes`
enforces the 8 KiB per-file bridge-bytes ceiling
(`tools/lint/context-size-guard.mjs`), and on-demand skill bodies are
inventoried by `npm run lint:claude-context` (skill bodies above 24 KiB,
agent definitions above 16 KiB).

The check honors:
- Your existing `~/.claude/settings.json` override (or `~/.config/claude/settings.json` fallback). When the user is already at e.g. `0.05`, the verdict reads **EXCEEDS OVERRIDE** rather than the misleading "EXCEEDS DEFAULT".
- The `<!-- AIWG_CONTEXT_WINDOW: N -->` directive in `CLAUDE.md` / `AGENTS.md` / `AIWG.md` — overrides the assumed 200,000-token context.

Sample output on a sysops + sdlc + marketing + ops + forensics workspace:

```
⚠ Claude Code Skill Budget: EXCEEDS OVERRIDE (9.50×) — 393 skills (avg 101 chars desc),
  est. 11,870 tokens vs 1,250 tokens budget — 5.00% × 100,000 ctx (override in ~/.claude/settings.json)
  | raise skillListingBudgetFraction to 0.1 (~10%) in ~/.claude/settings.json
  | or remove unused frameworks (e.g. aiwg remove media-marketing)
  | see docs/skills-budget-guide.md for full options
○ Factory Skill Budget: 294 skills, ~8,807 tokens — no documented budget for factory, skipping verdict
○ Copilot Skill Budget: 296 skills, ~8,846 tokens — no documented budget for copilot, skipping verdict
```

To suppress in CI runs that don't care about pre-flight surface analysis:

```bash
aiwg doctor --no-budget-check
```

---

## When to file an AIWG issue vs a platform issue

| Symptom | File where |
|---------|-----------|
| Specific AIWG skill description is too long | AIWG (`/issues`) |
| Truncation message references AIWG skills | AIWG `#1147` (frame budget) — link your repro |
| `skillListingBudgetFraction` doesn't take effect after edit | Claude Code (anthropics/claude-code) |
| AGENTS.md content past 32 KiB ignored without warning | Codex (openai/codex) |
| Truncation appears regardless of which framework is installed | Platform issue, not AIWG |

---

## References

- Claude Code skill loading: <https://code.claude.com/docs/en/skills>
- Claude Code runtime context-budget rules for AIWG: [`docs/providers/claude-context-budget.md`](providers/claude-context-budget.md)
- Claude Code skill budget mechanics: <https://claudefa.st/blog/guide/mechanics/skill-listing-budget>
- Claude Code settings reference: <https://claudefa.st/blog/guide/settings-reference>
- Codex skills: <https://developers.openai.com/codex/skills>
- Codex AGENTS.md guide: <https://developers.openai.com/codex/guides/agents-md>
- AIWG issue #1147 — Skill listing exceeds default budget
- AIWG issue #1148 — Description audit and rewrite
