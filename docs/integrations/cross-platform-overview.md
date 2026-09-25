# Cross-Platform Overview

AIWG gives your AI assistant reusable project context and specialist workflows
inside the AI tools you already use. The provider integration decides where
that context, skills, commands, rules, and agents are written so the selected
tool can read them. AIWG has 18 named provider integrations plus a separate
provider-neutral `generic` fallback adapter.

---

## Quick Comparison

The technical registry currently covers **18 named provider integrations**,
including Google Antigravity CLI, Grok Bot, Grok Build, Muse Code, Oh My Pi, and Pi Coding Agent, plus a
provider-neutral `generic` fallback adapter. Start with [Install, Connect, and
Verify](../getting-started/install-connect-verify.md), then use the row below
for provider-specific deployment details. The commands in this table are
focused SDLC examples for manual use; the canonical installation path uses the
complete supported setup unless project policy selects a narrower scope.

| Platform | Deploy Command | Context File |
|----------|----------------|--------------|
| Google Antigravity CLI | `aiwg use sdlc --provider antigravity` (alias `agy`) | AGENTS.md |
| Claude Code | `aiwg use sdlc` | CLAUDE.md |
| OpenAI/Codex | `aiwg use sdlc --provider codex` | AGENTS.md |
| GitHub Copilot | `aiwg use sdlc --provider copilot` | copilot-instructions.md |
| Cursor | `aiwg use sdlc --provider cursor` | .cursor/rules/ (MDC) |
| DeepSeek Harness | `aiwg use sdlc --provider dsh` | AGENTS.md |
| Factory AI | `aiwg use sdlc --provider factory` | AGENTS.md |
| Grok Bot | `aiwg use sdlc --provider grokbot` | AGENTS.md |
| [Grok Build](grok-build-ci.md) | `aiwg use sdlc --provider grok-build` | AGENTS.md |
| [Muse Code](muse-quickstart.md) | `aiwg use sdlc --provider muse` | AGENTS.md |
| Hermes | `aiwg use sdlc --provider hermes` | AGENTS.md |
| OpenCode | `aiwg use sdlc --provider opencode` | AGENTS.md |
| OpenClaw | `aiwg use sdlc --provider openclaw` | AGENTS.md |
| OpenHuman | `aiwg use sdlc --provider openhuman` | Provider-managed |
| Oh My Pi | `aiwg use sdlc --provider omp` | .omp/AGENTS.md |
| Pi Coding Agent ([pi.dev](https://pi.dev/)) | `aiwg use sdlc --provider pi` | AGENTS.md |
| Warp Terminal | `aiwg use sdlc --provider warp` | WARP.md |
| Devin Desktop | `aiwg use sdlc --provider devin` | AGENTS.md |
| Custom or unsupported harness | `aiwg use sdlc --provider generic` | AGENTS.md |

---

## What Gets Deployed

Artifacts deploy in each provider's native or compatibility format when that
provider exposes the corresponding surface:

- **Agents** - Specialized AI personas (Architecture Designer, Test Engineer, Security Auditor, etc.)
- **Commands** - Slash commands and CLI commands (`/mention-wire`, `transition`, `where-are-we`)
- **Skills** - Natural language workflows (project awareness, handoffs, quality gates)
- **Rules** - Context rules and coding standards (citation policy, token security, versioning)
- **Behaviors** - Platform behavior definitions (OpenClaw only)

---

## Provider Capability Matrix

| Provider | Agents | Commands | Skills | Rules | Behaviors |
|----------|--------|----------|--------|-------|-----------|
| Google Antigravity CLI | degraded | indexed | native | AGENTS.md | unsupported |
| Claude Code | native | native | native | native | - |
| OpenAI/Codex | native | native | native | conventional | - |
| GitHub Copilot | native | native | conventional | native | - |
| Cursor | conventional | conventional | native | native | - |
| Factory AI | native | native | native | conventional | - |
| Hermes | aggregated | indexed | native | AGENTS.md + CLI | indexed |
| OpenCode | native | native | conventional | conventional | - |
| OpenClaw | native | native | native | native | native |
| OpenHuman | indexed | indexed | native | indexed | indexed |
| Oh My Pi | native | native prompts | native | native | extension bridge |
| Pi Coding Agent | skills-as-agents | native prompts | native | AGENTS.md | extension bridge |
| Warp Terminal | aggregated | conventional | native | aggregated | - |
| Devin Desktop | aggregated | native | native | native | - |

**Legend**:
- **native** - Platform auto-discovers artifacts in standard directories
- **conventional** - AIWG directory convention (platform reads on request)
- **aggregated** - Single-file compilation + discrete files for compatibility
- **indexed** - Full artifact bodies load through `aiwg discover` and `aiwg show`, even without a native file loader.
  Reading a behavior contract does not supply native hooks or execution support.

---

The [indexed access audit](../providers/indexed-access-audit.md) records regression checks and remaining access restrictions.

## Directory Conventions

### Standard Pattern

Most providers follow `.<provider>/<type>/`:

```
.claude/
├── agents/          # Agent definitions
├── commands/        # Slash commands
├── skills/          # Natural language workflows
└── rules/           # Context rules

.github/
├── agents/          # Agent definitions (.agent.md format)
├── prompts/         # Slash commands (.prompt.md format)
├── instructions/    # Path-scoped rules (.instructions.md format)
└── copilot-instructions.md  # Repository-wide instructions
```

### Special Cases

| Provider | Special Convention |
|----------|--------------------|
| **Google Antigravity CLI** | Experimental, pinned to CLI 1.1.26<br>Agents → `.agents/agents/`; kernel skills → `.agents/skills/`<br>MCP → `.agents/mcp_config.json` (user scope only when explicit)<br>Global skills deferred because official paths conflict<br>Selector `antigravity`; alias and executable `agy` |
| **OpenAI/Codex** | Commands → `~/.codex/prompts/`<br>Skills → project `.agents/skills/` (legacy AIWG entries under `~/.codex/skills/` are pruned)<br>AGENTS.md is free-form Markdown (no YAML frontmatter or structured directives)<br>Rust CLI is current product; TypeScript CLI is legacy<br>Uses Responses API exclusively (`wire_api = "chat"` removed) |
| **GitHub Copilot** | Agents use `.agent.md` format<br>Commands → `.github/prompts/*.prompt.md`<br>Rules → `.github/instructions/*.instructions.md` (with `applyTo` globs)<br>MCP → `.vscode/mcp.json` |
| **Warp Terminal** | Skills natively discovered at `.warp/skills/`; agents and rules aggregated into `WARP.md`; `AGENTS.md` also supported (preferred by Warp, but `WARP.md` takes priority); `.warp/workflows/` for legacy YAML workflows |
| **Devin Desktop** | Agents aggregated to `AGENTS.md`<br>Commands → `.windsurf/workflows/`<br>Rules → `.windsurf/rules/*.md` (with trigger frontmatter)<br>Skills → `.windsurf/skills/`<br>Legacy selector: `windsurf` |
| **Cursor** | Rules use `.mdc` extension (MDC format) with frontmatter (`description`, `globs`, `alwaysApply`)<br>Skills use native `.cursor/skills/*/SKILL.md` format (2.4+)<br>Also supports `AGENTS.md` with directory inheritance<br>Legacy `.cursorrules` still generated for backward compatibility<br>Cloud Agents support MCP for remote AIWG access |
| **OpenClaw** | All artifacts deploy to home directory (`~/.openclaw/`)<br>First provider to support behaviors (`~/.openclaw/behaviors/`) |
| **Oh My Pi** | Experimental integration, distinct from Pi<br>Agents → `.omp/agents/`; prompts → `.omp/prompts/`; rules → `.omp/rules/`<br>Kernel and explicitly copied skills → one-level `.agents/skills/`; standard corpus stays lazy by default<br>Context → `.omp/AGENTS.md` native imports of WORKSPACE.md and AIWG.md<br>User scope honors OMP profiles; lifecycle bridge → `.omp/extensions/` |
| **Pi Coding Agent** | Commands → project `.pi/prompts/*.md`<br>Portable skills and agent roles → project `.agents/skills/*/SKILL.md`<br>AIWG-managed standard skills → `.pi/.aiwg/skills/`<br>Context → `AGENTS.md`<br>User scope honors `${PI_CODING_AGENT_DIR:-~/.pi/agent}` |
| **Hermes** | Skills deploy at user scope under `~/.hermes/skills/.aiwg/`; commands and full rule bodies remain available through `aiwg discover` and `aiwg show` |
| **OpenHuman** | Skills and rules deploy at user scope under `~/.openhuman/.aiwg/`; agents and commands remain available through `aiwg discover` and `aiwg show` |

---

## Migration Guide

**Upgrading from older AIWG versions that only deployed agents?**

Run the deploy command with `--force` to get all four artifact types:

```bash
aiwg use sdlc --provider <your-provider> --force
```

**What changes**:
- New `skills/` directory created alongside `agents/`
- New `rules/` directory created alongside `agents/`
- Existing agent files remain unchanged
- Commands deployed to appropriate location per provider

**No breaking changes** - all existing agents remain compatible.

---

## Agent Loop Multi-Provider Support

AIWG task loops can target different providers, not just deployment. Use
`--provider` to run loops through a selected adapter:

```bash
aiwg ralph "Fix tests" --completion "npm test passes"
aiwg ralph "Fix tests" --completion "npm test passes" --provider codex
```

See [Al Guide](../ralph-guide.md) for full documentation.

---

## Platform Setup Guides

| Platform | Guide |
|----------|-------|
| Google Antigravity CLI | [Provider Guide](../providers/antigravity.md) |
| Claude Code | [Setup Guide](claude-code-quickstart.md) |
| OpenAI/Codex | [Setup Guide](codex-quickstart.md) |
| GitHub Copilot | [Setup Guide](copilot-quickstart.md) |
| Factory AI | [Setup Guide](factory-quickstart.md) |
| Cursor | [Setup Guide](cursor-quickstart.md) |
| OpenCode | [Setup Guide](opencode-quickstart.md) |
| Warp Terminal | [Setup Guide](warp-terminal-quickstart.md) |
| Devin Desktop | [Setup Guide](windsurf-quickstart.md) |
| OpenClaw | [Setup Guide](openclaw-quickstart.md) |
| Grok Bot | [Setup Guide](grokbot-quickstart.md) |
| Hermes | [Setup Guide](hermes-quickstart.md) |
| OpenHuman | [Setup Guide](openhuman-quickstart.md) |
| Oh My Pi | [Setup Guide](omp-quickstart.md) · [Full provider guide](../providers/omp.md) |
| Pi Coding Agent ([pi.dev](https://pi.dev/)) | [Setup Guide](pi-quickstart.md) |

---

## After Setup

After deployment, follow any reload action printed by `aiwg use`, then ask the
assistant to verify the project root, provider files it can read, installed
frameworks, and one useful next action.

Try one small task immediately:

```text
Review this project's README and getting-started docs for unclear positioning,
missing setup steps, or unsupported claims. Return the three highest-priority
fixes with file references and a recommended next edit.
```

Success means the assistant can use the shared context in `WORKSPACE.md` and
`AIWG.md`, produce a concrete review you can inspect, and name the next
workflow or document to update.
