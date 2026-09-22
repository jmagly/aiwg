---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.codex
---

# OpenAI Codex Operational Reference

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed, `all` is deployed for your provider, and `aiwg-regenerate` has connected the agent to this project.

Complete guide for using AIWG with OpenAI Codex CLI, the Codex App, and the Codex API.

> **Implementation note:** The Codex CLI has two implementations. The **Rust implementation** (`codex-rs/`) is the current active product, shipping via `npm install -g @openai/codex` and `brew install --cask codex`. The TypeScript implementation (`codex-cli/`) is officially legacy. All AIWG integration targets the Rust CLI.

---

## Platform Overview

OpenAI Codex is available across multiple interfaces:

| Interface | Model Default | Best For |
|-----------|---------------|----------|
| **Codex CLI** | `gpt-5.6-terra` | Terminal-first development, automation |
| **Codex App** (macOS) | `gpt-5.6-sol` | Parallel agents, long-running tasks |
| **Codex in Copilot** | `gpt-5.6-terra` | GitHub-integrated workflows |
| **Codex API** | `gpt-5.6-terra` | Custom tooling, CI/CD integration |

---

## Available Models (March 2026)

| Model | Capability | Pricing | Notes |
|-------|-----------|---------|-------|
| **GPT-5.6-Sol** | Newest flagship | Premium tier | Priority 0, latest generation |
| **GPT-5.6-Terra** | Proven flagship | Premium tier | Priority 0, combines Codex + GPT-5 stacks |
| **GPT-5.6-Luna** | Budget | Free-tier compat | Listed, priority 12, cost-effective |

Switch models mid-session with `/model` or configure in `config.toml`.

---

## Install & Deploy

### 1. Install AIWG

```bash
npm install -g aiwg
```

### 2. Deploy to your project

```bash
cd /path/to/your/project

# Deploy the complete AIWG system for Codex
aiwg use all --provider codex
```

This deploys to:
- `.codex/agents/` — Project-local agent definitions
- `.codex/rules/` — Project-local context rules
- `~/.codex/prompts/` — User-level command prompts
- `.agents/skills/` — Project-local AIWG kernel and quickref skills
- `AGENTS.md` — Project context file

> **Note:** Codex uses a split deployment model. Agents, rules, and skills are
> project-local, while command prompts remain user-level under `~/.codex/`.
> AIWG prunes its own legacy entries from `~/.codex/skills/` to prevent duplicate
> discovery.

### 3. Deploy commands and skills separately (optional)

```bash
# Skills only (project-level)
aiwg -deploy-skills --provider codex

# Commands/prompts only (user-level)
aiwg -deploy-commands --provider codex
```

### 4. Regenerate for intelligent integration

```text
/aiwg-regenerate
```

`aiwg use` already wrote the project context, so natural-language command mapping ("run security review" maps to the correct workflow) works right away via AIWG's Discover-First protocol. On an **existing project**, or to pull in the latest AIWG, run this to re-tailor the context to your codebase — optional on a brand-new project.

---

## What Gets Created

```text
your-project/
├── .agents/
│   └── skills/          # AIWG kernel and quickrefs; --copy-all adds standard skills
├── .codex/
│   ├── agents/          # SDLC agents (Requirements Analyst, etc.)
│   └── rules/           # Context rules (token security, citation policy, etc.)
├── AGENTS.md            # Project context
└── .aiwg/               # SDLC artifacts

~/.codex/
├── AGENTS.md            # Global personal instructions (optional)
├── config.toml          # Configuration (copy template)
├── auth.json            # Stored auth credentials (ChatGPT login tokens)
├── history.jsonl        # Conversation history
├── prompts/             # AIWG commands as prompts (/project-status, /security-gate, etc.)
└── plugins/             # Installed plugins
```

### Skills Loading

Codex loads skills from two locations:
- `.agents/skills/` — Project-local skills; AIWG's canonical deployment target
- `~/.codex/skills/` — User-level skills; deprecated as an AIWG deployment target

Use the built-in `$skill-creator` to bootstrap new skills.

### Skills Context Budget (2% ceiling)

Codex CLI reserves a hardcoded **2% of the model's context window** for the "available skills" metadata block (skill name + short description) shown to the model at turn start. Source: `codex-rs/core-skills/src/render.rs:18` (`SKILL_METADATA_CONTEXT_WINDOW_PERCENT: usize = 2`).

Approximate budgets:

| Model context window | Skills metadata budget |
|----------------------|------------------------|
| 200k tokens          | ~4,000 tokens          |
| 400k tokens          | ~8,000 tokens          |
| 1M tokens            | ~20,000 tokens         |

When the budget is exceeded, Codex degrades in three stages:
1. Render full descriptions.
2. Truncate descriptions to fit (`Skill descriptions were shortened to fit the 2% skills context budget…`).
3. Drop entire skills from the visible list (`Exceeded skills context budget of 2%. All skill descriptions were removed and N additional skills were not included…`).

**Important nuance:** dropped skills are still on disk and still invocable by exact name — Codex only stops advertising them to the model. SKILL.md is read on selection, not on listing. So this is a **discovery problem, not a capability loss**.

#### Why this hits AIWG users

By default, `aiwg use ... --provider codex` deploys the canonical 25-skill
kernel/quickref inventory to `.agents/skills/`; the remaining skills stay
index-discoverable through `aiwg discover` and `aiwg show`. The listing budget
is normally exceeded only after an explicit `--copy-all`, when project-local
bundles add their own skills, or when unrelated user/plugin skills consume the
cap.

#### What you can do

Codex's 2% ceiling is hardcoded — there is no env var, CLI flag, or config knob to raise it. Tracked upstream as [openai/codex#19679](https://github.com/openai/codex/issues/19679). AIWG's own enforced cap, which keeps the deployer from writing past that ceiling, *is* adjustable (lever 5). The supported levers are:

1. **Disable unused skills in `~/.codex/config.toml`:**
   ```toml
   [[skills.config]]
   name = "soul-blend"
   enabled = false
   ```
   Repeat for every skill you do not actively use. This is Codex's first-class lever (`codex-rs/core-skills/src/config_rules.rs`).

2. **Keep the default copy profile.** Avoid `--copy-all` unless standard skills
   must be visible natively; they remain available through the AIWG index.

3. **Remove unused operator-owned skill directories** from the applicable
   Codex skill root. Re-run `aiwg use` to repair AIWG-managed entries.

4. **Use a larger-context model.** 2% of 1M is 20k tokens versus 4k on a 200k-context model — the budget scales linearly with the configured context window.

5. **Let AIWG's own cap place the overflow.** The deployer keeps the startup
   listing under 8,000 chars: when a bundle's skills would push it over, the
   largest non-kernel entries are written to the standard tier
   (`.codex/.aiwg/skills/`) instead and named in the deploy output. Kernel skills
   are never demoted, and demoted skills stay reachable through `aiwg discover`
   and `aiwg show`. Re-running `aiwg use <bundle> --provider codex` (no
   `--force`) re-places an existing over-cap deployment. Adjust with
   `AIWG_CODEX_LISTING_CAP=<chars>` (`0` disables) or, per invocation,
   `--listing-cap <chars>`; `--listing-budget` applies the cap even under
   `--copy-all`. See [the skills budget guide](../../skills-budget-guide.md).

---

## Configuration

Copy the AIWG config template:

```bash
cp $(npm root -g)/aiwg/agentic/code/frameworks/sdlc-complete/templates/codex/config.toml.aiwg-template ~/.codex/config.toml
```

### Key settings

```toml
# Model selection
model = "gpt-5.6-terra"              # Default CLI model (proven flagship)
review_model = "gpt-5.6-sol"             # Most capable for /review

# Profiles for different workflows
[profiles.aiwg-sdlc]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = "on-request"

[profiles.aiwg-dev]
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
```

### Config layers (precedence order)

1. MDM managed preferences (macOS only) — highest
2. System managed config (`/etc/codex/managed_config.toml`)
3. Session/CLI flags (`--set key=value` dotted-path overrides)
4. User `~/.codex/config.toml`
5. Built-in defaults

> **Note:** Project-level `.codex/config.toml` is not a separate precedence layer — it is loaded as user config when present in the working directory.

Use `/debug-config` in the CLI to inspect the effective configuration.

---

## AGENTS.md Format

AGENTS.md is **free-form Markdown** — there is no structured schema, no YAML frontmatter, and no machine-readable directives. The model reads the content as instructional prose appended to its system context.

**Discovery hierarchy** (merged top-down, later entries take precedence):

1. `~/.codex/AGENTS.md` — Personal global guidance
2. `AGENTS.md` at repo root — Shared project notes
3. `AGENTS.md` in the current working directory — Sub-folder specifics

**Disable loading:** `--no-project-doc` flag or `CODEX_DISABLE_PROJECT_DOC=1` environment variable.

**Size limit:** Configurable via `project_doc_max_bytes` in `config.toml` (default: 32KB). Fallback filenames are configurable via `project_doc_fallback_filenames` (defaults include `CLAUDE.md`).

> **No `model:` directive:** Model selection is exclusively a `config.toml` concern, not an AGENTS.md field. Similarly, `allowed-tools` and `shell-environment` are config.toml settings, not AGENTS.md directives.

---

## Approval Policy & Sandboxing

### Dangerous mode

AIWG maps `--dangerous` to Codex's current explicit bypass flag:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

This disables both approval prompts and sandboxing. Use it only in an already
trusted environment. AIWG launchers do not emit the removed `--full-auto`
compatibility flag.

### Approval Policy (config.toml)

Five policy variants for fine-grained control:

| Policy | Behavior |
|--------|----------|
| `untrusted` | Only known-safe read commands auto-approved; everything else prompts |
| `on-failure` | **Deprecated** — was full auto-approve with sandbox escalation on failure |
| `on-request` | Model decides when to prompt |
| `never` | Never prompt; failures go directly back to the model |
| `granular` | Fine-grained sub-fields for shell, rules, MCP, permissions, skills |

The `approvals_reviewer` setting controls who handles escalated approvals: `user` (default) or `guardian_subagent` (a risk-assessment subagent that auto-decides).

### Sandbox Modes

Three named modes via `sandbox_mode` in config.toml:

| Mode | Config value | Description |
|------|-------------|-------------|
| **Read-only** | `read-only` | Default for Suggest. All writes and shell commands need approval |
| **Workspace Write** | `workspace-write` | Default for Full Auto. Read/write within configured roots, network disabled |
| **Danger Full Access** | `danger-full-access` | No sandboxing. All operations permitted |

**Platform implementations:**
- **macOS 12+:** Apple Seatbelt (`sandbox-exec`). Writable roots: `$PWD`, `$TMPDIR`, `~/.codex`. Outbound network blocked.
- **Linux:** Bubblewrap (`bwrap`) with `iptables`/`ipset` firewall rules. Egress denied except OpenAI API.
- **Windows:** Restricted-token sandboxing (native Rust binary, no WSL required).

Configure additional writable paths:

```toml
[sandbox_workspace_write]
writable_roots = ["/path/to/extra"]
network_access = false
```

---

## CLI Features

### Mid-Turn Steering

Submit messages while Codex is working to redirect behavior. Steer mode is now stable and the default — Enter sends immediately, Tab queues a follow-up.

### Code Review

```text
/review
```

Opens review presets. Reads the selected diff, reports prioritized actionable findings without touching the working tree. Trained to catch critical flaws and match PR intent to diff.

### Web Search

Built-in first-party web search. Defaults to cached mode for speed. Use `--search` flag for live browsing when you need the latest information.

### Image Attachments

Attach PNG and JPEG images directly in the CLI composer or via command line for visual context.

### Cloud Tasks

```bash
codex cloud
```

Interactive picker for cloud tasks. List, filter, and browse cloud task results. Apply cloud task diffs locally. Cloud environments use 12-hour container caching.

```bash
# JSON output for automation
codex cloud --json
```

### AIWG Orchestration — `/aiwg-mission`

AIWG deploys its own orchestration command to `~/.codex/prompts/aiwg-mission.md`, so it renders as **`/aiwg-mission`** in the Codex TUI. It launches an **AIWG Mission** — durable, audited dynamic agent orchestration toward a measurable completion criterion, with AIWG owning the bookkeeping (activity-log, gates, best-output selection, crash-resilient checkpoint/resume, cost) while the worker mechanism runs on whatever stack fits. Missions are cross-stack capable (a Codex Mission can coordinate workers on other stacks via the AIWG `serve` executor registry).

`/aiwg-mission` is **AIWG-owned** and always present once AIWG is deployed. Do not confuse it with a `/workflow` command you may see from an installed Codex **plugin** (e.g. `temporal`, `superpowers`) — that is plugin-provided and environment-specific, **not a core Codex primitive**, so AIWG never assumes it. For in-session "iterate until a condition" on Codex alone, use the native `/goal`.

For a *pre-established* repeatable sequence (rather than dynamic orchestration), discover a **Flow** instead: `aiwg discover "<goal>"`.

### Plugins

Plugins are installable bundles that package skills, app integrations, and MCP server configurations into a single distributable unit. They are the recommended way to share reusable Codex workflows across teams and projects.

#### What plugins contain

A plugin can bundle any combination of:
- **Skills** — Workflow prompts progressively discovered by the agent
- **Apps** — Optional app integrations or connector mappings
- **MCP servers** — Remote tools or shared context the plugin needs

#### Plugin structure

Every plugin requires a manifest at `.codex-plugin/plugin.json`:

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json          # Required: plugin manifest
├── skills/
│   └── my-skill/
│       └── SKILL.md         # Optional: skill instructions
├── .app.json                # Optional: app/connector mappings
├── .mcp.json                # Optional: MCP server configuration
└── assets/                  # Optional: icons, logos, screenshots
```

#### Minimal manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Reusable workflow bundle",
  "skills": "./skills/"
}
```

#### Full manifest fields

| Field | Purpose |
|-------|---------|
| `name`, `version`, `description` | Package identity |
| `author`, `homepage`, `repository`, `license`, `keywords` | Publisher and discovery metadata |
| `skills`, `mcpServers`, `apps` | Paths to bundled components (relative to plugin root, `./` prefix) |
| `interface` | Install-surface metadata (display name, descriptions, icons, screenshots, brand color, default prompts, legal links) |

#### Installing plugins

```bash
# In-session plugin management
codex
/plugins

# Use the built-in @plugin-creator skill to scaffold a new plugin
```

#### Plugin marketplaces

Codex reads plugin catalogs from three locations:

| Marketplace | Location | Scope |
|-------------|----------|-------|
| **Official directory** | Curated by OpenAI | Global |
| **Repo marketplace** | `$REPO_ROOT/.agents/plugins/marketplace.json` | Project team |
| **Personal marketplace** | `~/.agents/plugins/marketplace.json` | Individual developer |

Marketplace file format:

```json
{
  "name": "local-repo",
  "interface": {
    "displayName": "My Team Plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./agentic/code/plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

**Key marketplace rules:**
- `source.path` is relative to the marketplace root, must start with `./`
- `policy.installation` values: `AVAILABLE`, `INSTALLED_BY_DEFAULT`, `NOT_AVAILABLE`
- `policy.authentication`: `ON_INSTALL` or on first use
- Plugins are cached at `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`
- Enable/disable state stored in `~/.codex/config.toml`

#### AIWG as a Codex plugin

AIWG can be deployed as a Codex plugin bundle, generating a `.codex-plugin/plugin.json` manifest and a repo marketplace entry:

```bash
# Deploy and generate plugin bundle in one step
aiwg use sdlc --provider codex --as-plugin

# Or package the plugin bundle separately
node tools/plugin/package-plugins.mjs --plugin codex-sdlc
```

The bundle is written to `agentic/code/plugins/sdlc/` and a marketplace entry is created at `.agents/plugins/marketplace.json` so your team can install it via the Codex `/plugins` panel without any external registry.

#### Local plugin development workflow

```bash
# 1. Scaffold with built-in skill
# Use @plugin-creator in Codex

# 2. Or manually create
mkdir -p my-plugin/.codex-plugin my-plugin/skills/hello

# 3. Add manifest
cat > my-plugin/.codex-plugin/plugin.json << 'EOF'
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom workflow",
  "skills": "./skills/"
}
EOF

# 4. Add a skill
cat > my-plugin/skills/hello/SKILL.md << 'EOF'
---
name: hello
description: Greet the user with a friendly message.
---

Greet the user warmly and ask how you can help.
EOF

# 5. Add to repo marketplace
mkdir -p .agents/plugins
# Add marketplace.json pointing to ./agentic/code/plugins/my-plugin

# 6. Restart Codex to pick up the plugin
```

### Feature Flags

```bash
codex features enable unified_exec
codex features disable some_feature
```

Manage CLI feature flags for experimental capabilities (e.g., `child_agents_md` for hierarchical AGENTS.md).

### Model Switching

```text
/model gpt-5.6-terra
```

Switch models mid-session without restarting.

---

## Codex App (macOS)

The Codex App (launched February 2, 2026) provides a native macOS interface for:

- **Parallel agents** — Run multiple Codex agents simultaneously on different tasks
- **Long-running tasks** — Background processing with notification on completion
- **Automations** — Schedule recurring tasks combining instructions and optional skills
- **Review queue** — Automation results are queued for human review before applying

### Automations

Schedule tasks to run periodically:
- Issue triage and categorization
- CI failure summaries
- Release briefs
- Automated bug checking

Results go to a review queue — you approve before changes are applied.

---

## Using AIWG Prompts

```text
/prompts:aiwg-pr-review PR_NUMBER=123
/prompts:aiwg-security-audit
/prompts:aiwg-generate-tests
```

---

## Wire Protocol

Codex uses the **OpenAI Responses API** (`/v1/responses`) exclusively for all model communication. The legacy Chat Completions API (`wire_api = "chat"`) has been removed — any config using it produces a hard error at startup.

Custom model providers are configured in `config.toml`:

```toml
[model_providers.my-proxy]
name = "My Proxy"
base_url = "https://proxy.example.com/v1"
env_key = "MY_PROXY_API_KEY"
wire_api = "responses"    # Only "responses" is supported
```

Built-in providers: `openai` (default), `ollama` (localhost:11434), `lmstudio` (localhost:1234).

---

## Codex as MCP Server

Codex can also **expose itself as an MCP server** for programmatic control from other tools:

```bash
codex mcp-server
```

This is a separate capability from Codex consuming MCP tools (the sidecar pattern). The internal MCP server uses stdio JSON-RPC 2.0 and is experimental.

---

## Non-Interactive / CI Mode

```bash
# Unrestricted non-interactive execution
codex exec --dangerously-bypass-approvals-and-sandbox "Perform AIWG security review"

# With specific model
codex exec --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-terra "Fix failing tests"
```

---

## AIWG Model Mapping

When AIWG deploys agents, model shorthands are mapped:

| AIWG Shorthand | Codex Model | Use Case |
|----------------|-------------|----------|
| `opus` | `gpt-5.6-sol` | Architecture, complex reasoning |
| `sonnet` | `gpt-5.6-terra` | Code generation, implementation |
| `haiku` | `gpt-5.6-luna` | Quick tasks, file operations |

---

## GitHub Integration

Codex is available as a coding agent for GitHub Copilot Pro+ and Enterprise customers. AIWG agents deployed via `--provider copilot` work with this integration.

---

## Agent Loop

Agent loops can target Codex directly via `--provider codex`:

```bash
# Run Al with Codex as the execution provider
aiwg ralph "Fix all failing tests" \
  --completion "npm test passes" \
  --provider codex

# External Al with Codex for long-running tasks
aiwg ralph-external "Migrate codebase to TypeScript" \
  --completion "npx tsc --noEmit exits 0" \
  --provider codex \
  --budget 5.0
```

Model mapping: opus → gpt-5.6-sol, sonnet → gpt-5.6-terra, haiku → gpt-5.6-luna.

See [Al Guide](../ralph-guide.md) for full documentation.

---

## Troubleshooting

**Natural language not working?** Run regenerate:
```text
/aiwg-regenerate
```

**Skills not loading?** Check the canonical project location and any optional user skills:
```bash
ls .agents/skills/    # Project-local
ls ~/.codex/skills/   # Optional user-owned skills; AIWG does not deploy here
```
Restart Codex after installing new skills.

**Warning: `Exceeded skills context budget of 2%, all skill descriptions were removed and N additional skills were not included…`?** This is Codex's hardcoded 2% skills metadata ceiling — see [Skills Context Budget](#skills-context-budget-2-ceiling) above. Dropped skills are still invocable by exact name; only their visibility to the model is removed. Mitigate by disabling unused skills in `~/.codex/config.toml` (`[[skills.config]] name = "..." enabled = false`), deploying fewer frameworks, or using a larger-context model. Tracking issue: [openai/codex#19679](https://github.com/openai/codex/issues/19679).

**Config not applying?** Inspect effective config:
```text
/debug-config
```

**Model not available?** Check your tier:
- GPT-5.6-Terra requires Pro/Team plan
- gpt-5.6-luna available on all plans (including free tier)
- GPT-5.6-Luna auto-offered at 90% usage

**Verify installation:**
```bash
ls .agents/skills/
ls ~/.codex/prompts/
ls .codex/agents/
ls .codex/rules/
cat AGENTS.md | head -20
```

---

## MCP Sidecar (AIWG Tooling Layer)

For structured AIWG tool access beyond what Codex's explicit approval/sandbox
bypass provides, connect the MCP sidecar:

```bash
aiwg mcp install codex
```

See the [Codex MCP Sidecar Guide](codex-mcp-sidecar.md) for the two-layer model and setup details.
