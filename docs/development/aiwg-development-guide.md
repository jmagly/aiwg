# AIWG Development Guide

The authoritative reference for enhancing, expanding, and developing AIWG components. Read this before designing any new capability.

## What AIWG Actually Is

AIWG is an **operational framework**, not a documentation project. It deploys specialized agents, manages artifacts, orchestrates workflows, and tracks state. Every component must be integrated into this operational system to function.

Writing a guide, schema, or rule file is **necessary but not sufficient**. A component exists in AIWG only when it is:

1. **Created** in the correct source location
2. **Registered** in the appropriate manifest or registry
3. **Wired** into agents, commands, or hooks that invoke it
4. **Deployable** via `aiwg use` to platform-specific folders

If you create a schema file but no agent references it, it does nothing. If you write a rule but no hook enforces it, it's aspirational prose. Integration is the whole point.

## Prerequisites

### System requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | >= 24 | Matches the package engine requirement. Use [nvm](https://github.com/nvm-sh/nvm) to manage versions. |
| **npm** | >= 11.5 | Bundled with Node 24. |
| **Git** | any | Standard source control. |
| **C++ build tools** | — | Required by native modules. See [CONTRIBUTING.md](https://github.com/jmagly/aiwg/blob/main/CONTRIBUTING.md#prerequisites) for OS-specific install instructions. |

### Installing

```bash
git clone https://github.com/jmagly/aiwg.git
cd aiwg
npm install
npm test              # run unit + UAT stub tests
npm run typecheck     # TypeScript check
```

### Native module dependencies

Several devDependencies compile C++ native addons via node-gyp. These require Python 3 and a C++ compiler:

| Package | Used for | Extra system dep |
|---------|----------|-----------------|
| `better-sqlite3` | Artifact index (SQLite) | none (build tools only) |
| `hnswlib-node` | Semantic ANN search | none (build tools only) |
| `@xenova/transformers` | Text embeddings; pulls in `sharp` | `sharp` downloads a prebuilt binary from GitHub; on restricted networks add `libvips-dev` so it can compile from source |

**Optional runtime deps** are feature-gated. Pure JS / small runtime helpers may
live in `optionalDependencies`; native install-heavy packages such as
`better-sqlite3` and `@xenova/transformers` are optional peers so a default
`npm install` stays quiet. Install a feature explicitly when needed.

| Package | Used for |
|---------|----------|
| `node-pty` | Terminal session management (MC/daemon) |
| `hono` + `@hono/node-server` | Web server mode |
| `ws` | WebSocket support |

### CI vs local install differences

CI uses a two-step install to avoid network calls to GitHub releases on self-hosted runners:

```bash
# Step 1 — skip optional packages (and sharp's binary download doesn't block)
npm ci --omit=optional

# Step 2 — add rollup's platform binding (needed by vitest, but skip install scripts)
ROLLUP_VER=$(node -e "console.log(require('./node_modules/rollup/package.json').version)")
npm install --no-save --omit=optional --ignore-scripts "@rollup/rollup-linux-x64-gnu@${ROLLUP_VER}"
```

Local `npm install` downloads sharp's prebuilt binary automatically and needs no extra steps.

## Architecture Mental Model

### Three-Tier Plugin Taxonomy

| Tier | Scale | Standalone | Source Location | Example |
|------|-------|------------|-----------------|---------|
| **Framework** | Large (50+ agents) | Yes | `agentic/code/frameworks/` | sdlc-complete, media-marketing-kit, media-curator, research-complete |
| **Extension** | Medium (5-20 agents) | No (requires parent framework) | `frameworks/{id}/extensions/` | gdpr, hipaa, sox |
| **Addon** | Small (1-10 agents) | Yes | `agentic/code/addons/` | aiwg-utils, voice-framework |

**When to use each:**

- **Framework**: Complete lifecycle solution (e.g., full SDLC, marketing operations)
- **Extension**: Domain-specific additions to an existing framework (e.g., HIPAA compliance for SDLC)
- **Addon**: Standalone utilities that work anywhere (e.g., voice profiles, validation tools)

For full details: @docs/development/devkit-overview.md

### 10 Extension Types

| Type | Purpose | Key Characteristic |
|------|---------|-------------------|
| **agent** | Specialized AI personas | Has role, model tier, tools |
| **command** | CLI and slash commands | User-invocable action |
| **skill** | Natural language workflows | Auto-triggered by patterns |
| **hook** | Lifecycle event handlers | Fires on events (pre-session, post-write) |
| **tool** | External utilities | Shell commands, scripts |
| **mcp-server** | MCP protocol servers | Standalone server process |
| **framework** | Complete workflows | Contains agents, commands, templates |
| **addon** | Feature bundles | Standalone package |
| **template** | Document templates | Scaffolding for artifacts |
| **prompt** | Reusable prompts | Parameterized prompt text |

For full schema details: @docs/extensions/overview.md and @docs/extensions/extension-types.md

### Source vs Deployment (The Golden Rule)

**Never directly edit platform-specific folders** (`.claude/`, `.factory/`, `.codex/`, `.cursor/`, `.opencode/`).

```
Source (you edit)                    CLI Deploy              Platform (don't edit)
────────────────                     ──────────              ────────────────────
agentic/code/frameworks/      →     aiwg use sdlc     →    .claude/agents/
agentic/code/addons/          →     aiwg use sdlc     →    .factory/droids/
agentic/code/agents/          →     aiwg use sdlc     →    .cursor/rules/
```

For complete placement rules: @docs/development/file-placement-guide.md

### Where Does `.aiwg/` Fit?

`.aiwg/` is neither source nor deployment — it is **project-local runtime output**. AIWG agents populate it when users work on their projects.

```
Source (you edit)          →    CLI Deploy           →    Platform (don't edit)
agentic/code/              →    aiwg use sdlc        →    .claude/agents/

Project output (AIWG creates during use):
.aiwg/                     ←    Agent output          ←    .claude/agents/ (at runtime)
```

Do not place framework components (schemas, templates, agent definitions) in `.aiwg/`. That directory stores project artifacts like requirements docs, architecture decisions, and test plans that are generated during development. Framework source belongs in `agentic/code/`.

### Dual-Write Workflow for `.claude/` Development

`.claude/` is a **deployment target** — generated by `aiwg use` and gitignored. When developing new agents, skills, commands, or rules, you must write to the framework source AND deploy to `.claude/` for testing.

| Path | What it is | Tracked? | Ships to users? |
|------|-----------|----------|-----------------|
| `agentic/code/frameworks/*/agents/` | Agent **source** | Yes | Yes (via `aiwg use`) |
| `agentic/code/frameworks/*/rules/` | Rule **source** | Yes | Yes |
| `agentic/code/addons/*/skills/` | Skill **source** | Yes | Yes |
| `.claude/agents/` | Agent **deployment target** | No | No |
| `.claude/skills/` | Skill **deployment target** | No | No |
| `.claude/commands/` | Command **deployment target** | No | No |
| `.claude/rules/` | Rule **deployment target** | No | No |

**Steps:**

1. **Write to framework source** — this is the real artifact that ships:
   ```
   agentic/code/frameworks/sdlc-complete/agents/my-agent.md
   agentic/code/addons/voice-framework/skills/my-skill/SKILL.md
   ```

2. **Activate dev mode** (one-time setup — points the CLI at your local repo):
   ```bash
   aiwg --use-dev /path/to/ai-writing-guide
   # From inside the repo directory:
   aiwg --use-dev .
   ```

   Dev mode makes the `aiwg` command delegate **all** subcommands to your
   local `src/cli/facade.mjs`, so changes to CLI code take effect after
   `npm run build` without reinstalling the package.

3. **Build and deploy**:
   ```bash
   npm run build          # Compile TypeScript changes
   aiwg use sdlc          # Redeploy framework content from local source
   ```

4. **Test** — the skill/agent is now live in your Claude Code session. CLI
   commands like `aiwg index stats` also run from your local build.

5. **Commit** — only the framework source (`agentic/code/`) goes into git.

6. **Switch back when done**:
   ```bash
   aiwg --use-stable
   ```

**Common Mistake**: Writing ONLY to `.claude/skills/my-skill/` without creating the source in `agentic/code/`. The skill works locally but never ships to users and disappears on next `aiwg use`.

**For AI Agents**: When creating new skills, agents, commands, or rules, you MUST:
1. Create the artifact in the correct `agentic/code/` source location
2. Update the relevant manifest (`manifest.json`) if one exists
3. Run `aiwg --use-dev . && npm run build && aiwg use <framework>`
4. Verify the artifact works from `.claude/`
5. Only commit changes under `agentic/code/`

### `.aiwg/` Tracking and Distribution

User projects still use `.aiwg/` as project-local AIWG memory. AIWG's own
public product repository no longer tracks its full `.aiwg` corpus directly;
that corpus lives in the private `roctinam/aiwg-web-release-ops` repo at
`corpus/.aiwg/`.

| Channel | `.aiwg/` included? | Mechanism |
|---------|-------------------|-----------|
| **public git** | No | `.gitignore` ignores `.aiwg/` and `.aiwg-location` |
| **private git** | Yes | `roctinam/aiwg-web-release-ops/corpus/.aiwg` |
| **npm** | No | `package.json` `files` allowlist + `.npmignore` |
| **edge** (`aiwg --use-main`) | No | Git sparse checkout excludes `.aiwg/` |
| **dev** (`aiwg --use-dev`) | Optional | Use `aiwg artifacts attach --to ../aiwg-web-release-ops/corpus/.aiwg` for the existing private corpus, or `AIWG_ARTIFACTS_PATH=...` for one shell |

See [Private AIWG Corpus](./private-aiwg-corpus.md) for maintainer setup.

`aiwg artifacts attach --to <path>` adopts an existing populated corpus;
`aiwg artifacts move --to <path>` relocates a local corpus into a new or empty
destination. Both write `.aiwg-location`, update local bindings, rebuild the
project index, and sync the Fortemi Core static cache.
`AIWG_ARTIFACTS_PATH` still wins over the pointer file for per-call or per-shell
overrides.

**Ephemeral subdirectories** in ordinary project `.aiwg` roots:
- `.aiwg/working/` — temporary files
- `.aiwg/.index/` — generated index (rebuilt by `aiwg index build`)
- `.aiwg/ralph/archive/` — session logs
- `.aiwg/ralph-external/loops/` — external loop runtime state

## The Component Lifecycle

Every AIWG component follows this lifecycle:

```
Design → Scaffold → Implement → Wire → Test → Deploy
```

**The common mistake** is stopping after Implement. Issues #94-#104 demonstrated this pattern: schemas, guides, and rules were written but never wired into the operational system. The result was inert documentation.

### Stage 1: Design

Decide what you're building and where it fits:

- What extension type(s) does this require?
- Which framework or addon does it belong to?
- What agents need to know about it?
- How will users invoke it?

### Stage 2: Scaffold

Use tooling to create the file structure:

```bash
# CLI scaffolding (outside sessions)
aiwg scaffold-addon my-addon
aiwg add-agent my-agent --to my-addon
aiwg add-command my-command --to my-addon

# In-session commands (inside Claude Code)
/devkit-create-agent my-agent --to my-addon
/devkit-create-command my-command --to my-addon
```

For all scaffolding commands: @docs/development/devkit-overview.md

### Stage 3: Implement

Write the actual content — agent definitions, command logic, schema files, rule files, templates.

### Stage 4: Wire (THE CRITICAL STAGE)

This is where most implementations fail. See the next section for details.

### Stage 5: Test

- Deploy with `aiwg use` and verify components appear
- Invoke commands and confirm behavior
- Check that agents reference new capabilities
- Validate with `aiwg validate-metadata`

### Stage 6: Deploy

```bash
aiwg use sdlc                        # Deploy to Claude Code
aiwg use sdlc --provider copilot     # Deploy to GitHub Copilot
aiwg use sdlc --provider cursor      # Deploy to Cursor
```

## What "Wired" Means

A component is wired when it is connected to the operational system so that agents, commands, or hooks can actually use it. Here is what wiring looks like for each integration point:

### Agent Wiring

Agents are the primary consumers of AIWG capabilities. If you create a schema, rule, or template, at least one agent must know about it.

**What to do:**

1. Update the relevant agent definition(s) in `agentic/code/frameworks/{framework}/agents/`
2. Add references in the agent's `## References` section
3. Add relevant rules to the agent's instruction set
4. Update `manifest.json` if adding new agent capabilities

**Example:** You create a new schema `agentic/code/frameworks/sdlc-complete/schemas/tree-of-thought.yaml`. To wire it:

```markdown
# In agentic/code/frameworks/sdlc-complete/agents/architecture-designer.md

## Schemas
- @agentic/code/frameworks/sdlc-complete/schemas/tree-of-thought.yaml — Tree-of-thought exploration for architecture decisions

## Instructions
When evaluating architecture alternatives with >3 options, use the Tree-of-Thought
schema to structure parallel exploration...
```

> **Note:** Schemas belong in `agentic/code/` (framework source), not in `.aiwg/` (project output). References to `@.aiwg/` paths in agent definitions point to project-local files that won't exist in user projects after deployment.

### Command Wiring

If a capability should be user-invocable, it needs a command.

**What to do:**

1. Create command definition in `agentic/code/frameworks/{framework}/commands/` or `agentic/code/addons/{addon}/commands/`
2. Add to `manifest.json` commands array
3. Ensure the command references the underlying implementation

**Example:** You create a GRADE assessment guide. To make it invocable:

```markdown
# agentic/code/frameworks/sdlc-complete/commands/grade-assess.md

# /grade-assess

Assess evidence quality using GRADE methodology.

## Behavior
1. Load @.aiwg/research/docs/grade-assessment-guide.md
2. Load target artifact
3. Apply GRADE assessment framework
4. Output quality rating with justification
```

### Schema Wiring

Schemas define data contracts. They must be referenced by the agents or commands that produce/consume them.

**What to do:**

1. Create schema in the framework or addon source location:
   - `agentic/code/frameworks/{framework}/schemas/` for framework schemas
   - `agentic/code/addons/{addon}/schemas/` for addon schemas
   - **Note:** `.aiwg/` directories are output locations where user projects store generated artifacts at runtime — they are NOT source locations for framework components
2. Reference from agent definitions that produce/consume this data
3. Reference from any validation commands
4. Add to relevant rule files that enforce the schema

### Rule Wiring

Rules in `.claude/rules/` are path-scoped and auto-loaded, but they are only effective if agents are instructed to follow them.

**What to do:**

1. Create rule file in `.claude/rules/`
2. Reference from relevant agent definitions
3. If rule requires enforcement, create or update a hook
4. Add to quality gate checks if applicable

### Template Wiring

Templates provide scaffolding for artifacts.

**What to do:**

1. Create template in `agentic/code/frameworks/{framework}/templates/`
2. Register in `manifest.json` templates array
3. Reference from agents that generate this artifact type
4. Ensure `aiwg add-template` can find it

### Hook Wiring

Hooks fire on lifecycle events (pre-session, post-write, etc.).

**What to do:**

1. Define hook in addon or framework
2. Register trigger conditions
3. Add to `manifest.json` hooks array
4. Test that the hook fires on the expected event

### The Anti-Pattern: Documentation-Only

This is what issues #94-#104 produced:

```
Created:
  ✓ .aiwg/flows/schemas/tree-of-thought.yaml
  ✓ .aiwg/flows/docs/tot-architecture-guide.md
  ✓ .claude/rules/tot-exploration.md

Missing (the wiring):
  ✗ No agent definition references the schema
  ✗ No command invokes the guide
  ✗ No hook enforces the rule
  ✗ No manifest.json entry
  ✗ No test verifies integration
```

The schema exists but nothing uses it. The guide exists but no agent reads it. The rule exists but nothing enforces it. This is documentation, not integration.

### The `.aiwg/` Confusion Anti-Pattern

A more subtle variant of the documentation-only anti-pattern is placing framework components in `.aiwg/` instead of `agentic/code/`. This happened with 62 schema files created across prior sessions:

```
Created (in the wrong place):
  ✗ .aiwg/flows/schemas/tree-of-thought.yaml
  ✗ .aiwg/ralph/schemas/actionable-feedback.yaml
  ✗ .aiwg/research/schemas/frontmatter-schema.yaml

Should have been (in framework source):
  ✓ agentic/code/frameworks/sdlc-complete/schemas/tree-of-thought.yaml
  ✓ agentic/code/frameworks/sdlc-complete/schemas/actionable-feedback.yaml
  ✓ agentic/code/frameworks/sdlc-complete/schemas/frontmatter-schema.yaml
```

**Why this happens**: AIWG dogfoods itself, so the `.aiwg/` directory has real content. It is easy to mistake `.aiwg/` for a framework source location because it contains schemas, research docs, and flow definitions. But `.aiwg/` is **project-local output** — it stores artifacts generated during project development. Nothing from `.aiwg/` is deployed to other systems via `aiwg use`.

**Why it matters**: Agent definitions that reference `@.aiwg/flows/schemas/foo.yaml` work only inside the AIWG repository. When a user installs AIWG into their project and runs `aiwg use sdlc`, the deployed agents will reference paths that do not exist because `.aiwg/` is not part of the deployment payload.

**The fix**: Framework schemas, templates, and docs belong in `agentic/code/frameworks/{framework}/` or `agentic/code/addons/{addon}/`. Project-local artifacts (requirements, architecture docs, test plans generated during development) belong in `.aiwg/`.

### The Incomplete Docset Anti-Pattern

Another common pattern: agents silently skip or abbreviate SDLC artifacts based on inferred project characteristics ("this is a small utility, no need for a full SAD" or "skip threat model for a CLI tool"). This produces inconsistent, incomplete artifact sets.

**The rule**: **Completeness is the default; incompleteness requires explicit user consent.** No artifact should be omitted based on project type, size, complexity, or agent inference. If an artifact doesn't fully apply, generate it with appropriate scope notes — don't skip it.

Agents MAY suggest an artifact is low-value for the project context, but MUST surface a HITL gate asking the user to confirm the skip. Silent omission is prohibited. See `hitl-gates.md` Rule 8 for the gate schema.

## Creation Guides by Type

| Creating... | Detailed Guide | Key Files |
|-------------|---------------|-----------|
| Agent | @docs/extensions/creating-extensions.md | `agents/*.md`, `manifest.json` |
| Command | @docs/extensions/creating-extensions.md | `commands/*.md`, `manifest.json` |
| Skill | @docs/development/skill-creation-guide.md | `skills/*/SKILL.md` |
| Addon | @docs/development/addon-creation-guide.md | `manifest.json`, `README.md`, `agents/`, `commands/` |
| Framework | @docs/development/framework-creation-guide.md | `manifest.json`, `agents/`, `commands/`, `templates/` |
| Extension (expansion pack) | @docs/development/extension-creation-guide.md | Parent framework's `extensions/` directory |
| Template | @docs/extensions/creating-extensions.md | `templates/*.md` |

For a complete end-to-end walkthrough: @docs/development/walkthrough-create-addon.md

## Tooling

### CLI Scaffolding (Outside Sessions)

```bash
# Create packages
aiwg scaffold-addon <name>                          # New standalone addon
aiwg scaffold-extension <name> --for <framework>    # New extension for framework
aiwg scaffold-framework <name>                      # New complete framework

# Add components to packages
aiwg add-agent <name> --to <target>                 # Add agent definition
aiwg add-command <name> --to <target>               # Add command definition
aiwg add-skill <name> --to <target>                 # Add skill definition
aiwg add-template <name> --to <target>              # Add document template

# Validate
aiwg validate-metadata                              # Check all extension metadata (manifest.md / BEHAVIOR.md)
node tools/linters/skill-frontmatter-linter.mjs    # Check SKILL.md frontmatter (YAML parse, required fields)
```

The skill-frontmatter linter accepts directories or specific files. CI runs it against
the full `agentic/code/` corpus on every PR (after the cleanup work in #1015). Contributors
should run it locally before pushing skill edits to catch invalid YAML or missing fields
like `name`.

### In-Session Commands (Inside Claude Code)

```bash
/devkit-create-addon <name>                         # Interactive addon creation
/devkit-create-agent <name> --to <target>           # Interactive agent creation
/devkit-create-command <name> --to <target>         # Interactive command creation
/devkit-create-skill <name>                         # Interactive skill creation
/devkit-validate <path>                             # Validate package structure
```

### Smithing (On-Demand Creation)

Smiths create assets on-demand during a session without polluting your conversation context:

| Smith | Creates | Deploys To |
|-------|---------|------------|
| ToolSmith | Shell scripts, OS tools | `.aiwg/smiths/toolsmith/` |
| MCPSmith | Dockerized MCP servers | `.aiwg/smiths/mcpsmith/` |
| AgentSmith | Agent definitions | `.claude/agents/` |
| SkillSmith | Skill definitions | `.claude/skills/` |
| CommandSmith | Command definitions | `.claude/commands/` |

For full smithing docs: @docs/smithing/README.md

## Integration Checklist

Use this checklist for every new component. Not all items apply to every type — use judgment.

### Source & Structure

- [ ] Files created in correct source location (not platform folders)
- [ ] `manifest.json` updated with new entries (if package-level change)
- [ ] README updated to document new capability

### Wiring

- [ ] At least one agent definition references the new component
- [ ] Command or skill created if capability should be user-invocable
- [ ] Rule file created if behavioral constraint applies
- [ ] Hook defined if automatic enforcement needed
- [ ] Template added if artifact scaffolding needed
- [ ] Schema registered if data contract defined

### Cross-References

- [ ] @-mentions added connecting new files to related artifacts
- [ ] Bidirectional links established (forward and backward)
- [ ] References section in new files points to dependencies

### Validation & Deployment

- [ ] `aiwg validate-metadata` passes
- [ ] `aiwg use sdlc` deploys without errors
- [ ] Component appears in deployed platform folder
- [ ] Command/skill/agent is invocable after deployment

> **Before filing a PR**, run the aiwg-dev validation skills (requires `aiwg use aiwg-dev`):
>
> ```bash
> /validate-component <path>   # check a single component
> /validate-addon <addon-id>   # check the whole addon
> /dev-doctor                  # full repo health check
> ```
>
> These catch placement violations, missing manifest entries, circular skill calls, and component completeness gaps before review.

## Context Loading Best Practices for CLAUDE.md

Claude Code automatically reads and loads into context any files directly @-linked from `CLAUDE.md` (or `AGENTS.md`) at session start. This is powerful but must be used carefully — large documents linked directly from `CLAUDE.md` consume significant context budget on every session, even when irrelevant to the current task.

### The Layered Linking Strategy

Use a **two-tier approach**: `CLAUDE.md` links to short indices and summaries, which in turn contain @-links to full documents that agents follow on demand.

**Bad** — loads ~9,000 lines of rule files on every session:
```md
## Rules
@agentic/code/addons/aiwg-utils/rules/anti-laziness.md
@agentic/code/frameworks/sdlc-complete/rules/token-security.md
@agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md
... (31 more files)
```

**Good** — loads ~200-line index; agents follow links as needed:
```md
## Rules
@agentic/code/frameworks/sdlc-complete/rules/RULES-INDEX.md
```

### Guidelines

| Principle | Description |
|-----------|-------------|
| **Link indices, not documents** | `CLAUDE.md` should reference `RULES-INDEX.md`, `README.md`, or similar summaries — never individual rule/template/guide files |
| **Keep direct links under 500 lines total** | All files @-linked from `CLAUDE.md` should sum to under ~500 lines of loaded context |
| **Use on-demand loading** | Indices contain @-links to full documents; agents load these only when the topic is relevant to their current task |
| **Large references go in agent definitions** | Agent-specific documentation belongs in agent `.md` files (loaded only when that agent is spawned), not in `CLAUDE.md` |
| **Template variables over @-links** | In CLAUDE.md templates shipped to users, prefer `$AIWG_ROOT/path` references (not auto-loaded) over `@path` references (auto-loaded) for large files |

### When Developing CLAUDE.md Templates

When creating or updating CLAUDE.md templates in `agentic/code/frameworks/*/templates/`:

1. **Audit @-links** — count the total lines that would be auto-loaded at session start
2. **Replace large @-links** with references to index files or use `$AIWG_ROOT` path variables
3. **Test context impact** — deploy the template and verify session startup doesn't load excessive context

### Existing Example

The `RULES-INDEX.md` pattern is the canonical example of layered linking done right:
- `CLAUDE.md` links to `@.claude/rules/RULES-INDEX.md` (~200 lines)
- `RULES-INDEX.md` contains summaries + @-links to 35 individual rule files (~9,300 lines total)
- Agents load individual rules on-demand when the topic is relevant

## Companion CLI Commands in Skills

Skills may call companion `aiwg ...` commands for structured evidence, automation, validation, deployment, or status snapshots. Those commands support the skill workflow; they do not replace the agent's responsibility to inspect relevant context, interpret command output, reconcile local state, and report a reasoned result.

When adding or editing a skill with a companion CLI command:

1. State what the command provides, such as inventory, validation, deployment, or metadata extraction.
2. State what the agent must still assess after the command runs.
3. Avoid blanket wording such as "only run", "just run", or "use this instead of the skill" unless the skill is explicitly a thin command wrapper.
4. Run `aiwg skill-lint` before merging. The companion-CLI inventory must report `0 need review`.

The current full inventory is tracked in @docs/development/companion-cli-skill-inventory.md.

## Platform Deployment

Components flow from source to platform-specific folders via `aiwg use`:

| Platform | Command | Deployment Target |
|----------|---------|-------------------|
| Claude Code | `aiwg use sdlc` | `.claude/agents/`, `.claude/commands/` |
| GitHub Copilot | `aiwg use sdlc --provider copilot` | `.github/agents/`, `copilot-instructions.md` |
| Cursor | `aiwg use sdlc --provider cursor` | `.cursor/rules/` |
| Factory AI | `aiwg use sdlc --provider factory` | `.factory/droids/`, `AGENTS.md` |
| Warp Terminal | `aiwg use sdlc --provider warp` | `WARP.md` |
| OpenAI/Codex | `aiwg use sdlc --provider codex` | `.codex/agents/` |
| OpenCode | `aiwg use sdlc --provider opencode` | `.opencode/agent/` |
| Devin Desktop | `aiwg use sdlc --provider devin` | `.windsurfrules` |

For cross-platform details: @docs/integrations/cross-platform-overview.md

## Existing Documentation Index

All development documentation, organized by topic.

### Architecture & Concepts

| Document | Description |
|----------|-------------|
| @docs/extensions/overview.md | Unified extension schema, 10 types, platform compatibility |
| @docs/extensions/extension-types.md | Complete TypeScript schema reference for all types |
| @docs/development/devkit-overview.md | Three-tier taxonomy, CLI and in-session tooling |
| @docs/development/file-placement-guide.md | Source vs deployment locations, the golden rule |

### Creation Guides

| Document | Description |
|----------|-------------|
| @docs/extensions/creating-extensions.md | Step-by-step creation for agents, commands, skills, templates |
| @docs/development/addon-creation-guide.md | Standalone addon creation and distribution |
| @docs/development/framework-creation-guide.md | Complete framework lifecycle (phases, agents, commands) |
| @docs/development/extension-creation-guide.md | Expansion packs for existing frameworks |
| @docs/development/skill-creation-guide.md | Auto-triggering skills with pattern matching |
| @docs/development/walkthrough-create-addon.md | End-to-end walkthrough building a code-metrics addon |

### Smithing & On-Demand Creation

| Document | Description |
|----------|-------------|
| @docs/smithing/README.md | Smithing framework overview and all smith types |
| @docs/smithing/toolsmith.md | Shell/OS tool creation |
| @docs/smithing/mcpsmith.md | Dockerized MCP server creation |
| @docs/smithing/agentic-smiths.md | AgentSmith, SkillSmith, CommandSmith |
| @docs/smithing/graduating-creations.md | Promoting smith creations to permanent packages |

### Commands & Agents

| Document | Description |
|----------|-------------|
| @docs/cli/reference.md | 67+ CLI commands with usage |
| @docs/commands/DEVELOPMENT_GUIDE.md | Advanced command development, testing, optimization |
| @docs/commands/subagents-and-commands-guide.md | Subagent patterns for command implementations |
| @docs/development/skill-inventory.md | Catalog of available skills |
| @docs/development/companion-cli-skill-inventory.md | Full inventory of skills that reference companion `aiwg ...` commands |

### Contributing & Integration

| Document | Description |
|----------|-------------|
| @docs/contributing/contributor-quickstart.md | First-time contributor onboarding |
| @docs/integrations/claude-code-quickstart.md | Claude Code plugin installation |
| @docs/integrations/cross-platform-overview.md | Multi-platform deployment overview |
| @docs/integrations/cross-platform-config.md | Platform-specific configuration |

### Source Code Reference

| File | Description |
|------|-------------|
| @src/extensions/types.ts | Core TypeScript type definitions (1,328 lines) |
| @src/extensions/registry.ts | Extension registry with O(1) lookup |
| @src/extensions/commands/definitions.ts | All 40 command definitions |
| @src/extensions/validation.ts | Extension validation rules |
| @src/extensions/capability-index.ts | Semantic search by capability |
| @src/extensions/loader.ts | Extension discovery and loading |

## References

- @docs/extensions/overview.md - Extension system architecture
- @docs/development/devkit-overview.md - Development Kit overview
- @docs/development/file-placement-guide.md - Source vs deployment locations
- @docs/smithing/README.md - On-demand asset creation
- @docs/cli/reference.md - Complete CLI command reference
- @docs/development/companion-cli-skill-inventory.md - Companion CLI skill inventory
- @src/extensions/types.ts - Core type definitions
