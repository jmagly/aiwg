---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.windsurf
---

# Devin Desktop Operational Reference

> **Deprecated reference ID:** `windsurf` remains discoverable for legacy installs;
> new deployments use the canonical provider id `devin`.

> **Selector and paths:** Use `--provider devin`. AIWG preserves the existing
> `.windsurf/` files because AIWG retains the legacy compatibility
> adapter. The deprecated alias `--provider windsurf` remains accepted with a deprecation notice;
> the distinct `devin-cli` surface is not supported.

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed, `all` is deployed for your provider, and `aiwg-regenerate` has connected the agent to this project.

---

See [Desktop path verification](../../providers/devin-desktop-paths.md) for retained paths and the pending 3.14 check.

## Install & Deploy

**1. Install**

```bash
npm install -g aiwg
```

**2. Deploy to your project**

```bash
cd /path/to/your/project

# Deploy SDLC framework:
aiwg use all --provider devin
```

**3. Open in Devin Desktop**

```bash
# Devin Desktop automatically loads rules and agents
code /path/to/your/project  # or use the Devin Desktop launcher
```

**4. Regenerate for intelligent integration**

```text
/aiwg-regenerate
```

`aiwg use` writes a usable project context immediately. Run regeneration for
every existing project and after upgrades so the context is re-tailored to the
current codebase. A newly scaffolded project can defer it until project content
exists. See the [Regenerate Guide](#regenerate-guide) for details.

**5. You're ready.** See the [Intake Guide](../../intake-guide.md) for starting projects.

---

## What Gets Created

```text
AGENTS.md                    # Aggregated agent definitions (auto-loaded)
.windsurf/
├── workflows/               # Commands deployed as native workflows
├── skills/                  # Skill directories (native since v1.13.6)
└── rules/                   # Rule files with trigger frontmatter
.aiwg/                       # SDLC artifacts
```

**Key Architecture**:
- **Agents**: Aggregated into single `AGENTS.md` at project root (Devin Desktop auto-discovers at root and subdirectories)
- **Commands**: Deployed as native workflows to `.windsurf/workflows/` (manual invocation via `/workflow-name`)
- **Skills**: Deployed to `.windsurf/skills/` (native platform support — Cascade auto-matches by description)
- **Rules**: Deployed to `.windsurf/rules/` with YAML frontmatter for trigger control (`always_on`, `model_decision`, `glob`, `manual`)

---

## Using Agents

Devin Desktop reads `AGENTS.md` automatically. Use natural language to invoke agents:

```text
"Generate intake for an e-commerce platform"
"Transition to Elaboration"
"Run security review"
"Where are we in the project?"
```

### @-Mention Patterns

Reference agents directly using @-mentions:

```text
"@requirements-analyst create user stories for checkout"
"@architecture-designer review the SAD"
"@test-engineer generate integration tests"
```

### Workflow Commands

Commands are deployed as Devin Desktop workflows:

```text
/transition inception elaboration
/security-review
/project-status
```

---

## Agent Aggregation

Devin Desktop discovers agent definitions exclusively via `AGENTS.md` files (no `.windsurf/agents/` directory support):

**Why Aggregation?**
- Devin Desktop's rules engine processes `AGENTS.md` natively — root-level files are always-on
- Subdirectory `AGENTS.md` files auto-scope via generated globs (`<directory>/**`)
- All agent definitions remain accessible via @-mentions
- Regenerate updates aggregation when framework changes

**How It Works**:
1. Framework defines agents in `agentic/code/frameworks/sdlc-complete/agents/`
2. Deployment aggregates all agents into root `AGENTS.md`
3. Devin Desktop's rules engine loads `AGENTS.md` automatically — treated as always-on rules
4. Regenerate command updates aggregation if needed

---

## Regenerate Guide

The regenerate command is essential for Devin Desktop integration:

```text
/aiwg-regenerate
```

**What it does**:
- Aggregates all agent definitions into `AGENTS.md`
- Updates `.windsurf/rules/` with latest orchestration patterns (with `trigger: always_on` frontmatter)
- Synchronizes `.windsurf/workflows/` with command definitions
- Enables natural language → workflow mapping

**When to regenerate**:
- After initial deployment
- After updating AIWG framework (`npm update -g aiwg`)
- When adding custom agents or commands
- If natural language workflows stop working

---

## Devin Desktop Commands

```bash
# Regenerate aggregated files
/aiwg-regenerate

# Project setup
/aiwg-setup-project

# Workflow commands (examples)
/transition <from-phase> <to-phase>
/security-review
/project-status
```

---

## Troubleshooting

### Natural language not working?

Run regenerate to update mappings:

```text
/aiwg-regenerate
```

### AGENTS.md not loading?

Devin Desktop reads root `AGENTS.md` automatically. If agents aren't available:

1. Verify `AGENTS.md` exists at project root
2. Check file isn't empty
3. Restart Devin Desktop
4. Regenerate if needed

### Workflows missing?

Check deployment:

```bash
# Redeploy framework
aiwg use sdlc --provider devin --force

# Verify workflows exist
ls .windsurf/workflows/
```

### Commands not found?

Ensure rules are up to date:

```text
/aiwg-regenerate
```

Then verify:

```bash
ls .windsurf/rules/
ls .windsurf/workflows/
```

### Agents not responding correctly?

1. Check `AGENTS.md` contains expected agents:
   ```bash
   grep "^# Agent:" AGENTS.md
   ```

2. Verify aggregation is recent:
   ```bash
   head -n 5 AGENTS.md  # Check timestamp comment
   ```

3. Regenerate if stale:
   ```text
   /aiwg-regenerate
   ```

### Skills not available?

Skills are deployed to `.windsurf/skills/`:

```bash
# Check skills directory
ls .windsurf/skills/

# Redeploy if missing
aiwg use sdlc --provider devin --force
```

---

## Support Levels

| Artifact Type | Support | Location |
|---------------|---------|----------|
| **Agents** | Aggregated | `AGENTS.md` (root) |
| **Commands** | Native | `.windsurf/workflows/` |
| **Skills** | Native | `.windsurf/skills/` |
| **Rules** | Native | `.windsurf/rules/` |

**Aggregated**: All agent definitions combined into single file (auto-discovered by rules engine)
**Native**: Deployed to platform-specific location with full auto-discovery support

---

## Rules System

Devin Desktop uses `.windsurf/rules/*.md` files with optional YAML frontmatter for trigger control. AIWG deploys rules with appropriate trigger modes:

### Trigger Modes

| Mode | Behavior | AIWG Usage |
|------|----------|-----------|
| `always_on` | Included in system prompt every message | Orchestration rules, core conventions |
| `model_decision` | Description shown; full content loaded on demand | Optional guidance |
| `glob` | Activated when matching files are edited | Language-specific rules |
| `manual` | Activated via `@rule-name` mention | Reference rules |

### Example Rule File

```markdown
---
trigger: always_on
---

Follow AIWG SDLC conventions. Use @-mentions for traceability.
```

### Character Limits

| Scope | Limit |
|-------|-------|
| Workspace rules (per file) | 12,000 chars |
| Global rules | 6,000 chars |

---

## Skills

Devin Desktop natively supports skills since v1.13.6 (January 2026). Each skill is a directory with a `SKILL.md` file:

```
.windsurf/skills/
  project-awareness/
    SKILL.md
```

Skills require `name` and `description` in YAML frontmatter. Cascade auto-matches skills by evaluating user requests against descriptions — only `name` and `description` are in context by default (progressive disclosure).

Skills are also discoverable at `.agents/skills/` (cross-agent compatibility path) and `~/.codeium/windsurf/skills/` (global).

---

## Memories

Devin Desktop has an automatic memory system (since v1.1.0) that persists context across conversations:

- Cascade auto-generates memories when it encounters reusable context
- Stored locally at `~/.codeium/windsurf/memories/` (per-machine)
- Users can explicitly request: "remember that X"
- Retrieved automatically when relevant to current conversation

**AIWG and Memories**: Memories are local and cannot be committed to version control. For team-shareable context, AIWG uses `.windsurf/rules/` (always-on rules) and `AGENTS.md` instead. There is currently no external API for writing to the memories store.

---

## Agent Loop

Agent loops support multi-provider execution. While Devin Desktop agents are deployed via AIWG, agent task loops run through the CLI:

```bash
aiwg ralph "Fix all tests" --completion "npm test passes"
```

See [Agent Loop Guide](../../agent-loop-guide.md) for full documentation including `--provider` options.

---

## Next Steps

- [Cross-Platform Overview](../../integrations/cross-platform-overview.md) - Compare platform differences
- [Intake Guide](../../intake-guide.md) - Start your first project
- [SDLC Framework](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/README.md) - Complete framework reference
- [Commands Reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md) - All 40 AIWG commands

---

## MCP Sidecar (Unrestricted AIWG Access)

Devin Desktop has no dangerous mode flag. The MCP sidecar is the only path to unrestricted AIWG tool access:

```bash
aiwg mcp install devin
```

See the [Devin Desktop MCP Sidecar Guide](../../integrations/windsurf-mcp-sidecar.md) for complete setup including tool whitelisting and context optimization.

---

## Additional Resources

**Devin Desktop Documentation**: [legacy documentation URL](https://docs.windsurf.com)
**AIWG Repository**: [github.com/jmagly/aiwg](https://github.com/jmagly/aiwg)
**Support**: [Discord](https://discord.gg/BuAusFMxdA) | [AIWG Telegram foyer](https://t.me/joinaiwg)
