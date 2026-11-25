---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.claude
---

# Claude Code Operational Reference

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed, `all` is deployed for your provider, and `aiwg-regenerate` has connected the agent to this project.

---

## Install & Deploy

### Option A: Plugin (Recommended)

Native Claude Code integration - no npm required:

```bash
# Add AIWG marketplace (one-time)
/plugin marketplace add jmagly/ai-writing-guide
# Install the frameworks you need
/plugin install sdlc@aiwg        # Full SDLC framework
/plugin install marketing@aiwg   # Full marketing framework
/plugin install utils@aiwg       # Core utilities
/plugin install voice@aiwg       # Voice profiles
```

> **No account required** - Plugin distribution is decentralized. No registry signup, no approval process - just add and install from any git repository.

### Option B: npm + CLI

For CLI tools and multi-platform deployment:

```bash
# Install CLI
npm install -g aiwg

# Deploy to your project
cd /path/to/your/project
aiwg use all --provider claude
```

---

## After Installation

**1. Open your project in Claude Code**

```bash
claude .
```

**2. Wire the context to your project (existing projects)**

`aiwg use` already wrote the project context (`CLAUDE.md` + `AIWG.md`), so natural-language command mapping ("run security review" → workflow) works right away via AIWG's Discover-First protocol. On an **existing project**, or to pull in the latest AIWG, run this once inside Claude Code to re-tailor that context to your codebase and preserve any edits you've made (optional on a brand-new project):

```text
/aiwg-regenerate
```

**3. You're ready.** See the [Intake Guide](../../intake-guide.md) for starting projects.

---

## What Gets Created

```text
.claude/
├── agents/      # SDLC agents (Requirements Analyst, Architecture Designer, etc.)
├── commands/    # Slash commands (/project-status, /security-gate, etc.)
├── skills/      # Skill directories (voice profiles, project awareness, etc.)
└── rules/       # Context rules (token security, citation policy, etc.)

CLAUDE.md        # Project context
.aiwg/           # SDLC artifacts
```

Claude Code deploys all 4 artifact types natively: agents, commands, skills, and rules.

---

## Troubleshooting

### Plugin Issues

**Marketplace not loading?**

```bash
# Verify marketplace was added
/plugin marketplace list

# Re-add if missing
/plugin marketplace add jmagly/ai-writing-guide
```

**Plugin installation fails?**

```bash
# Check available plugins
/plugin search @aiwg

# Verify plugin exists
/plugin info sdlc@aiwg
```

**Files not found after installation?**

Plugins are copied to a cache directory. If you see missing file errors:

```bash
# Reinstall the plugin
/plugin uninstall sdlc@aiwg
/plugin install sdlc@aiwg
```

**Update plugins to latest version?**

```bash
# Update marketplace catalog
/plugin marketplace update

# Reinstall for latest
/plugin uninstall sdlc@aiwg
/plugin install sdlc@aiwg
```

### General Issues

**Natural language not working?**

```text
/aiwg-regenerate
```

**Commands/agents missing?**

```bash
# npm method
aiwg use sdlc

# or reinstall plugin
/plugin install sdlc@aiwg
```

**Check installation:**

```bash
aiwg version
```

---

## PR Steward repository guidance

Claude Code's built-in `/steward` watches an open PR, fixes CI failures, conflicts
and review feedback, and can commit and push as the user. It never merges; only
a user-typed command starts it. AIWG does not start or drive it.

To supply repository policy on each watch pass, explicitly set this boolean in
the existing `.aiwg/aiwg.config` delivery block:

```json
{ "delivery": { "pr_steward_guidance": true } }
```

Claude deployment and refresh then manage `.claude/skills/steward/SKILL.md`,
with an `.aiwg-managed` stamp and ownership receipt. The default is false;
`aiwg use all --provider claude` never enables it. No `babysit` file or user HOME
guidance is generated. Existing unmanaged or edited guidance is preserved with
a notice. Set the option to false (or remove it) and refresh to remove unedited
managed guidance; unrelated files remain.

Identity, signing, delivery mode, force-push and CI policy come from `delivery`.
For checks and protected paths, declare bullet lists under the exact headings
`## PR Steward verification commands` and `## PR Steward off-limits paths` in
`WORKSPACE.md`. For example:

```markdown
## PR Steward verification commands
- `npm run typecheck`

## PR Steward off-limits paths
- `.github/workflows/`
```

Commands are copied as instructions, never executed by deployment. Missing lists or signing metadata
produce a note and omit the corresponding section; commands are never inferred.
Commit and reply instructions prohibit AI attribution.

The forge note uses `remotes.issue_provider`. GitHub PR checks, review threads
and mergeability are GitHub-oriented; Gitea permits only git-state watching here.
An undeclared forge never implies GitHub tooling is available.

This input file is unrelated to AIWG's `aiwg-steward-routing` skill, which routes
AIWG capabilities. Other skills and commands still cannot use Claude's reserved
`steward` or `babysit` names.

## Check catalog names after Claude Code upgrades

Run the offline catalog check from the repository root:

```bash
node tools/check-claude-catalog-names.mjs
```

It compares deployable skill folders and command filenames (including native
frontmatter names) against `test/fixtures/providers/claude/builtin-names.json`.
The report separates bundled skills, unshadowable built-in commands, reserved
folders, and local commands with unverified blocking behaviour. It exits nonzero
when a blocking collision is neither renamed nor rejected by the deployment guard.
`--root <catalog-root>` and `--fixture <name-list.json>` select alternate inputs.

Claude Code 2.1.331 rejects the bundled skill names `schedule` and `run`.
AIWG deploys them as `aiwg-schedule` and `aiwg-run` on Claude; other providers
keep their source names. Neither skill is in either command mirror policy.
`steward` retains its `aiwg-steward-routing` alias, and `steward`/`babysit`
remain reserved folders. The local-command names `config`, `skills`, `install`,
`update`, `export`, `checkpoint`, `session`, and `feedback` are reported without
renaming until live verification establishes whether they block custom names.

After upgrading an installed Claude Code binary, explicitly refresh the fixture:

```bash
node tools/check-claude-catalog-names.mjs --refresh-from-claude
# Optional: select the installed binary rather than finding claude on PATH.
node tools/check-claude-catalog-names.mjs --refresh-from-claude --claude-binary /path/to/claude
```

Refresh reads the installed bundle offline without executing Claude or making a
model call. It recognizes Claude 2.1.x literal local-command headers and bundled
skill registrations; an unsupported format fails before writing. It retains
reviewed categories, adds observed bundled skills, and records newly observed
local commands as unverified. It preserves old names conservatively and records
the bundle digest. Review the fixture diff and verify conditional availability,
unshadowable flags, reserved folders, and local-command blocking behaviour
manually before updating `tools/agents/providers/claude-builtins.json`. A static
scan cannot establish those runtime behaviours. Rerun the offline check after
updating the guard. Tests and CI use the checked-in fixture and never pass the
refresh flag.

## Context Window Defaults

AIWG-launched Claude sessions default `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` when the variable is unset. This removes Claude Code's 1M-context model variants from `/model` for AIWG-launched sessions.

Why: AIWG already manages context with scoped skills, RLM patterns, and compact handoffs. On credit-billed Claude accounts, accidentally selecting a 1M-context variant can spend credits much faster than a bounded 200k session. Subscription accounts can opt back in when large-context work is intentional.

To opt in for an AIWG-launched session, set the variable explicitly before launching:

```bash
export CLAUDE_CODE_DISABLE_1M_CONTEXT=0
```

AIWG preserves any explicit value. Unset means AIWG injects the safe default; `0` means you chose to keep 1M variants available.

---

## Agent Loop

Agent loops support multi-provider execution via `--provider`:

```bash
aiwg ralph "Fix all tests" --completion "npm test passes"
aiwg ralph "Migrate to TS" --completion "tsc passes" --provider codex
```

See [Agent Loop Guide](../../agent-loop-guide.md) for full documentation.

---

## Common Marketplace Packages

The table below is a quick-start subset. The marketplace currently contains 40
packages; see `.claude-plugin/marketplace.json` for the authoritative catalog,
versions, descriptions, and sources.

| Package | Description | Install |
|--------|-------------|---------|
| `sdlc@aiwg` | Full SDLC framework | `/plugin install sdlc@aiwg` |
| `marketing@aiwg` | Full marketing framework | `/plugin install marketing@aiwg` |
| `utils@aiwg` | Core utilities, regenerate commands | `/plugin install utils@aiwg` |
| `voice@aiwg` | Voice profiles for consistent writing | `/plugin install voice@aiwg` |
| `writing@aiwg` | AI pattern detection, validation | `/plugin install writing@aiwg` |
| `hooks@aiwg` | Workflow tracing, observability | `/plugin install hooks@aiwg` |

---

## MCP Sidecar (AIWG Tooling Layer)

For structured AIWG tool access (artifact management, workflow execution, template rendering), connect the AIWG MCP server:

```bash
aiwg mcp install claude
```

The sidecar complements `--dangerously-skip-permissions` — use both for the full AIWG experience. See the [Claude MCP Sidecar Guide](../../integrations/claude-mcp-sidecar.md) for details.
