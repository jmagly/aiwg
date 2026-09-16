# Provider Skill Paths — Verified Reference

Ground-truth skill discovery paths for all AIWG-supported providers.
Paths are verified from platform source code where available, or from official documentation.

**Issue tracking full audit + fixes:** roctinam/aiwg#766

---

## Universal Cross-Platform Path

`.agents/skills/` is scanned by multiple platforms as a shared convention:

- Codex CLI (primary, confirmed from `codex-rs/core-skills/src/loader.rs`)
- OpenClaw (confirmed from `src/agents/skills/workspace.ts`)
- Warp Terminal (also scans alongside `.warp/skills/`)
- GitHub Copilot / VS Code (also scans alongside `.github/skills/`)

Deploying to `.agents/skills/` is the most portable option if you need a single directory that works across providers.

---

## Per-Provider Skill Paths

### Claude Code

| Scope | Path | Source |
|-------|------|--------|
| Project | `.claude/skills/` | Official docs |

- Discovery: scans `.claude/skills/` for SKILL.md files
- Plugin namespace: `plugin-name:skill-name`
- Copilot/VS Code source confirms it also scans `.claude/skills/` directly

---

### OpenAI Codex

| Scope | Path | Source | Status |
|-------|------|--------|--------|
| Project | `.agents/skills/` | `codex-rs/core-skills/src/loader.rs` | **Primary (use this)** |
| User-global | `~/.agents/skills/` | `codex-rs/core-skills/src/loader.rs` | **Primary (use this)** |
| User-global | `~/.codex/skills/` | Legacy | **Deprecated — pruned on deploy** |

- Source repo: https://github.com/openai/codex (full Rust)
- AIWG deploys project-scope kernel skills to `.agents/skills/` and user-scope
  skills to `~/.agents/skills/`. The legacy `~/.codex/skills/` home dir is no
  longer written; AIWG-managed dirs left there by pre-fix versions are pruned
  on every codex skill deploy.
- Project-local addon skills deployed via `aiwg use <addon> --provider codex`
  also land in `.agents/skills/`; `.codex/.aiwg/skills/` remains the indexed
  artifact tier, not the Codex native runtime discovery path.
- Each deployed native skill includes `agents/openai.yaml` with a display name
  and short description for Codex UI discovery. Kernel skills are copied by
  default; use `--copy-all` only when standard skills must also be native.
- `aiwg use ... --provider codex` treats `.codex/` and `.agents/` as generated
  provider trees and adds them to `.gitignore` unless already covered. Existing
  tracked files remain tracked, and `--dry-run` does not mutate the ignore file.
- **Duplicate-listing regression (fixed):** #766's first fix *added* the
  `.agents/skills/` write but never *removed* the legacy `~/.codex/skills/`
  write. codex-rs scans both, so every kernel skill appeared twice in the
  slash-command list (e.g. `/aiwg-regenerate` listed twice). `.agents/skills/`
  is now the single project-scope target.

---

### GitHub Copilot / VS Code

| Scope | Path | Source | Notes |
|-------|------|--------|-------|
| Project | `.github/skills/` | `promptFileLocations.ts` | Copilot-specific |
| Project | `.claude/skills/` | `promptFileLocations.ts` | Also scanned — already visible to Copilot when AIWG is deployed for Claude |

- Source repo: https://github.com/microsoft/vscode (full TypeScript)
- AIWG skills in `.claude/skills/` are already visible to Copilot users without extra deployment
- Deploying to `.github/skills/` is still correct for Copilot-only projects

---

### Factory AI

| Scope | Path | Source |
|-------|------|--------|
| Project | `.factory/skills/` | `docs/cli/configuration/skills.mdx` |

- Source: docs only (no public source code)
- Path not independently verified from source; treat as provisional

---

### Cursor IDE

| Scope | Path | Source |
|-------|------|--------|
| Project | `.cursor/skills/` | Official docs |

- Closed source — path from documentation only

---

### OpenCode

| Scope | Path | Source |
|-------|------|--------|
| Project | `.opencode/skill/` | `packages/opencode/src/skill/index.ts` |

- Source repo: https://github.com/sst/opencode (full TypeScript)
- Note: agents (`.opencode/agent/`) and commands (`.opencode/command/`) are config-only via `opencode.jsonc` — file-based discovery only works for skills
- Skills-only file-based discovery confirmed from source

---

### Warp Terminal

| Scope | Path | Source | Notes |
|-------|------|--------|-------|
| Project | `.warp/skills/` | Official docs | Warp-specific |
| Project | `.agents/skills/` | warpdotdev/oz-skills examples | Also scanned |

- Closed source — paths from official docs and example repos
- `.agents/skills/` cross-platform path likely scanned; needs verification

---

### Windsurf

| Scope | Path | Source |
|-------|------|--------|
| Project | `.windsurf/skills/` | Official docs |

- Codeium — closed source; path from documentation only
- Status: experimental
- Devin Desktop is modeled as the renamed/evolved Windsurf local IDE surface.
  AIWG keeps `windsurf` as the deployable compatibility id, and
  `devin-desktop`, `devin-local`, and `cascade` resolve to the same writer
  adapter. Use `aiwg use sdlc --provider windsurf` or
  `aiwg use sdlc --provider devin-desktop`.
- AIWG does not currently emit `.devin/` provider output. `.devin/` remains
  ignored local provider state; committed source should use `.windsurf/` output
  plus `AGENTS.md` until a dedicated Devin CLI provider writer exists.
- Bare `--provider devin` and `--provider devin-cli` are intentionally rejected
  with guidance, because Devin CLI has distinct rules/skills surfaces.

---

### OpenClaw

| Scope | Path | Source |
|-------|------|--------|
| User-global | `~/.openclaw/skills/` | `src/agents/skills/workspace.ts`, `local-loader.ts` |

- Source repo: https://github.com/openclaw/openclaw (full TypeScript)
- All artifacts deploy to home directory — no project-local skill paths
- Inherits Claude Code SKILL.md behavior including deep subdirectory recursion

---

### Hermes Agent

| Scope | Path | Source |
|-------|------|--------|
| User-global | `$HERMES_HOME/skills/` (default `~/.hermes/skills/`) | `hermes_constants.py`, `agent/skill_utils.py`, `tools/skills_tool.py` |

- Source repo: https://github.com/NousResearch/hermes-agent (full Python)
- Discovery: recursive `SKILL.md` scan under the active profile's skills directory
- NOT MCP-only for skills; file-based discovery is the primary mechanism
- Managed Agent Skills imports deployed with `aiwg skills deploy <name>
  --target hermes` land at `$HERMES_HOME/skills/<name>` as strict Agent Skills
  bundles with AIWG ownership sidecars. This is separate from `aiwg use
  --provider hermes`, which deploys framework/kernel skills and provider bridge
  files.

---


### Grok Bot

| Scope | Path | Notes |
|-------|------|-------|
| User (when configured) | `$AIWG_GROKBOT_SKILLS_DIR/` | Absolute override required; AIWG does **not** invent `~/.grokbot` |
| User standard (optional) | `$AIWG_GROKBOT_SKILLS_DIR/.aiwg/skills/` | Only with `--copy-all` |
| Project | Indexed via `aiwg discover` / `aiwg show` | Discover-first bridge in `AGENTS.md` |

Fail-closed until `AIWG_GROKBOT_SKILLS_DIR` is set. Never deploys to `.cursor/`.
See `docs/architecture/adr-grokbot-provider-target.md`.


## Distribution Mechanism by Provider

Not all providers have a native plugin marketplace. The table below distinguishes providers with marketplace-based distribution from those that use `aiwg use --provider <name>` as the file-deploy adapter.

| Provider | Distribution Mechanism | Install Command / Marketplace |
|----------|----------------------|-------------------------------|
| **Claude Code** | File-deploy adapter | `aiwg use sdlc` |
| **OpenAI Codex** | File-deploy adapter | `aiwg use sdlc --provider codex` |
| **GitHub Copilot** | VS Code Marketplace for extensions; file-deploy adapter for agents/skills/rules | `aiwg use sdlc --provider copilot` |
| **Factory AI** | File-deploy adapter | `aiwg use sdlc --provider factory` |
| **Cursor** | File-deploy adapter | `aiwg use sdlc --provider cursor` |
| **OpenCode** | File-deploy adapter | `aiwg use sdlc --provider opencode` |
| **Warp Terminal** | File-deploy adapter | `aiwg use sdlc --provider warp` |
| **Windsurf** | File-deploy adapter | `aiwg use sdlc --provider windsurf` |
| **OpenClaw** | File-deploy adapter | `aiwg use sdlc --provider openclaw` |
| **Hermes** | File-deploy adapter; managed Agent Skills target | `aiwg use sdlc --provider hermes`; `aiwg skills deploy <name> --target hermes` |
| **Grok Bot** | File-deploy adapter; fail-closed user skill root | `aiwg use sdlc --provider grokbot`; set `AIWG_GROKBOT_SKILLS_DIR` for user-scope |

**Marketplace vs. file-deploy distinction:**

- **VS Code Marketplace** (GitHub Copilot): Distributes Copilot *extensions* — GitHub App-based integrations built with the Extensions API. It does not distribute project-local agent/skill/rule file bundles. AIWG uses `aiwg use --provider copilot` for those.
- **File-deploy adapter** (all other providers): No native plugin marketplace exists for distributing AI framework packages. `aiwg use --provider <name>` writes framework artifacts to the platform's native discovery paths. This provides equivalent capability to a marketplace install and is by design, not a missing feature.

---

## Capability-Matrix.yaml vs. Ground Truth

| Provider | Matrix `skills:` | Ground-truth primary | Correct? |
|----------|-----------------|----------------------|----------|
| claude-code | `.claude/skills/` | `.claude/skills/` | Yes |
| codex | `.agents/skills/` | `.agents/skills/` | Yes (#766; legacy `~/.codex/skills/` pruned) |
| copilot | `.github/skills/` | `.github/skills/` (also `.claude/skills/`) | Partial |
| factory | `.factory/skills/` | `.factory/skills/` | Unverified |
| cursor | `.cursor/skills/` | `.cursor/skills/` | Unverified |
| opencode | `.opencode/skill/` | `.opencode/skill/` | Yes |
| warp | `.warp/skills/` | `.warp/skills/` (also `.agents/skills/`) | Partial |
| windsurf | `.windsurf/skills/` | `.windsurf/skills/` | Unverified |
| openclaw | `~/.openclaw/skills/` | `~/.openclaw/skills/` | Yes |

---

## Source Repositories

| Platform | Repo | Open Source | Key skill loader |
|----------|------|-------------|-----------------|
| Claude Code | https://github.com/anthropics/claude-code | Partial (no loader) | Docs: code.claude.com/docs/en/skills |
| Codex CLI | https://github.com/openai/codex | Full Rust | `codex-rs/core-skills/src/loader.rs` |
| GitHub Copilot / VS Code | https://github.com/microsoft/vscode | Full TypeScript | `promptFileLocations.ts` |
| Factory AI | — (docs only) | No | `docs/cli/configuration/skills.mdx` |
| Cursor | — (closed) | No | Docs only |
| OpenCode | https://github.com/sst/opencode | Full TypeScript | `packages/opencode/src/skill/index.ts` |
| Warp | — (closed) | No (examples: warpdotdev/oz-skills) | Docs only |
| Windsurf | — (closed) | No | Docs only |
| OpenClaw | https://github.com/openclaw/openclaw | Full TypeScript | `src/agents/skills/workspace.ts`, `local-loader.ts` |
| Hermes Agent | https://github.com/NousResearch/hermes-agent | Full Python | `agent/skill_commands.py` |
| agentskills spec | https://github.com/agentskills/agentskills | Full | Specification + reference library |

---

*Last verified: 2026-07-28. Re-verify before implementing path changes — source repos move fast.*
