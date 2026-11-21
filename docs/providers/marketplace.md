# Provider Marketplace Reference

Complete reference for how AIWG integrates with each supported provider's marketplace or plugin system. For providers without a native marketplace, file-based deployment is the intentional adapter.

**Design principle**: *Augment not replace.* When a platform has native marketplace capability, AIWG registers itself via that system. When a platform has no marketplace, file-based deployment via `aiwg use <framework> --provider <name>` acts as the adapter.

**Related issue**: #783

---

## At-a-Glance Matrix

| Provider | Marketplace | Format | AIWG Status | Install Path |
|----------|-------------|--------|-------------|--------------|
| Claude Code | Git-based, decentralized | `.claude-plugin/plugin.json` + root `marketplace.json` | ✅ Implemented | `/plugin install sdlc@aiwg` |
| OpenAI Codex | Project + personal | `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` | ✅ Implemented | Codex reads manifest at project root |
| Cursor | cursor.com (centralized) | `.cursor-plugin/plugin.json` | ⚠️ Manifest only (no API submission) | Manual install via file deploy |
| Factory AI | Git-URL based | `.factory-plugin/plugin.json` | ✅ Implemented | Factory reads manifest from plugin repo |
| OpenClaw | ClawHub registry | `clawhub.json` | ⚠️ Manifest only (publish workflow TBD) | `aiwg use sdlc --provider openclaw` |
| Devin Desktop | *No marketplace* | *N/A* | 📄 Adapter pattern (file-deploy) | `aiwg use sdlc --provider devin` |
| Warp | *No marketplace* | *N/A* | 📄 Adapter pattern (file-deploy) | `aiwg use sdlc --provider warp` |
| OpenCode | *No marketplace* | *N/A* | 📄 Adapter pattern (file-deploy) | `aiwg use sdlc --provider opencode` |
| Hermes | *No marketplace* | *N/A* | 📄 Adapter pattern (file-deploy) | `aiwg use sdlc --provider hermes` |
| Copilot / VS Code | VS Code Marketplace (extensions only) | *N/A for skill/agent packages* | 📄 Adapter + separate extension | `aiwg use sdlc --provider copilot` |

**Legend:**
- ✅ **Implemented**: AIWG generates the manifest, packaging works, integration complete
- ⚠️ **Manifest only**: Manifest is generated but publishing workflow is manual or pending API access
- 📄 **Adapter pattern**: No native marketplace — file-based deployment is the intentional adapter

---

## 1. Claude Code (Git-based Marketplace)

**Architecture**: Decentralized. Each marketplace is a Git repository with a `marketplace.json` at the root listing the plugins it publishes. There is no central registry.

**Manifest formats**:

`marketplace.json` (repo root — the catalog):

```json
{
  "name": "aiwg",
  "displayName": "AI Writing Guide",
  "description": "Multi-agent framework for SDLC, research, marketing, and more",
  "version": "1.0.0",
  "plugins": [
    { "name": "sdlc", "source": "./agentic/code/plugins/sdlc" },
    { "name": "marketing", "source": "./agentic/code/plugins/marketing" },
    { "name": "voice", "source": "./agentic/code/plugins/voice" }
  ]
}
```

`.claude-plugin/plugin.json` (per-plugin manifest inside each plugin directory):

```json
{
  "name": "sdlc",
  "version": "2024.12.4",
  "description": "Complete SDLC framework with 180+ specialized agents...",
  "author": { "name": "AIWG Contributors", "email": "support@aiwg.io" },
  "homepage": "https://aiwg.io",
  "repository": "https://github.com/jmagly/aiwg",
  "license": "MIT",
  "keywords": ["sdlc", "software-development", "..."]
}
```

**Plugin contents**: `agents/`, `commands/`, `skills/`, `rules/`, plus optional `.mcp.json` and `README.md`.

**Versioning**: Git SHA pinning via `/plugin install <name>@<sha>` or branch tracking via `/plugin install <name>@aiwg`. The `FORCE_AUTOUPDATE_PLUGINS` environment variable controls auto-update behavior.

**Installation UX**:
```bash
/plugin marketplace add jmagly/ai-writing-guide
/plugin install sdlc@aiwg
/plugin list
```

**Scope semantics**: `/plugin install` is project-level by default. Add `--scope user` for cross-project installation.

**AIWG's marketplace entry**: The AIWG repository root contains `marketplace.json` pointing to plugin bundles under `agentic/code/plugins/` such as `agentic/code/plugins/sdlc/`, `agentic/code/plugins/marketing/`, `agentic/code/plugins/voice/`, `agentic/code/plugins/hooks/`, `agentic/code/plugins/utils/`, and `agentic/code/plugins/writing/`. Each plugin directory contains a complete `.claude-plugin/plugin.json`.

**Current manifest coverage**: AIWG plugin manifests populate 11 Claude Code manifest fields (name, version, description, author, homepage, repository, license, keywords, dependencies, files, engines). Extended fields like `categories`, `tags`, and `compatibility` are candidates for future enhancement.

---

## 2. OpenAI Codex (Project + Personal Marketplace)

**Architecture**: Two-tier marketplace discovery:
- **Project-level**: `.agents/plugins/marketplace.json` in the project root — discovered by Codex when working in that project
- **Personal-level**: `~/.agents/plugins/marketplace.json` — user-wide catalog

Codex caches installed plugins at `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`.

**Manifest formats**:

`.agents/plugins/marketplace.json` (Codex catalog — note: different from Claude Code's `marketplace.json` format):

```json
{
  "name": "aiwg",
  "interface": { "displayName": "AIWG Framework" },
  "plugins": [
    {
      "name": "sdlc",
      "source": { "source": "local", "path": "./agentic/code/plugins/sdlc" },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

`.codex-plugin/plugin.json` (per-plugin manifest — distinct from Claude Code's `.claude-plugin/plugin.json`):

```json
{
  "name": "aiwg-sdlc",
  "version": "2026.4.0",
  "description": "AIWG SDLC framework agents, commands, and skills",
  "author": "AIWG Contributors",
  "license": "MIT",
  "contents": {
    "agents": "agents/",
    "commands": "commands/",
    "skills": "skills/"
  }
}
```

**Implementation status**: `tools/agents/providers/codex.mjs` exports `generatePluginBundle()` which produces both manifests. Invoked via `node tools/plugin/package-plugins.mjs --plugin sdlc` when `pluginType: 'codex'` is configured.

**Installation UX**:
```bash
# Codex reads the manifest automatically when you work in the project
cd /path/to/project-with-marketplace.json
codex chat
# Codex discovers AIWG via .agents/plugins/marketplace.json
```

**Note on deployment paths**: Codex prompts remain user-level under
`~/.codex/prompts/`. Current AIWG framework skills and standard-aware managed
Agent Skills deploy to the project `.agents/skills/` compatibility surface.
AIWG-owned entries in the legacy `~/.codex/skills/` path are pruned; user-owned
content is preserved.

---

## 3. Cursor (Centralized Marketplace)

**Architecture**: cursor.com/marketplace is a centralized catalog. Third-party submission requires partner approval — it is not fully open.

**Manifest format**:

`.cursor-plugin/plugin.json` (for local installation or future submission):

```json
{
  "name": "aiwg-sdlc",
  "version": "2026.4.0",
  "displayName": "AIWG SDLC",
  "description": "Complete SDLC framework",
  "publisher": "aiwg",
  "contents": {
    "agents": "agents/",
    "commands": "commands/",
    "skills": "skills/",
    "rules": "rules/"
  }
}
```

**Implementation status**: AIWG generates the `.cursor-plugin/plugin.json` manifest but does not submit to cursor.com. Users install via file deployment (`aiwg use sdlc --provider cursor`).

**Why not submitted**: cursor.com/marketplace approval process is partner-oriented. Pending clarification of submission policy, file deployment via the `--provider cursor` path remains the primary distribution channel.

**Local marketplace fallback**: Cursor does not appear to support self-hosted marketplaces like Claude Code and Codex do (no project-root manifest discovery documented at time of writing). This is a key difference — submission or file-deploy are the only paths.

**Installation UX**:
```bash
aiwg use sdlc --provider cursor
# Deploys to .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
```

---

## 4. Factory AI (Git-URL Plugin System)

**Architecture**: Factory uses Git-URL-based plugin distribution. A plugin is any Git repository containing a `.factory-plugin/plugin.json` manifest at its root. Factory's `droid` CLI installs plugins from URLs.

**Manifest format**:

`.factory-plugin/plugin.json`:

```json
{
  "name": "aiwg-sdlc",
  "version": "2026.4.0",
  "displayName": "AIWG SDLC",
  "description": "Complete SDLC framework agents",
  "author": "AIWG Contributors",
  "license": "MIT",
  "contents": {
    "droids": "droids/",
    "commands": "commands/",
    "skills": "skills/",
    "rules": "rules/"
  },
  "compatibility": {
    "minFactoryVersion": "1.0.0"
  }
}
```

Note: Factory uses "droids" as the term for specialized agents — the directory layout reflects this.

**Implementation status**: `tools/agents/providers/factory.mjs` generates `.factory-plugin/plugin.json` (see `generatePluginBundle()` at line 643). No central registry exists — distribution is via Git URL.

**Installation UX** (when Factory CLI supports plugin install):
```bash
droid plugin install https://github.com/jmagly/aiwg/tree/main/agentic/code/plugins/sdlc
# OR via file deploy:
aiwg use sdlc --provider factory
```

Factory's API key requirement: Factory droid operations require `FACTORY_API_KEY`. File-based deployment via `aiwg use sdlc --provider factory` doesn't require the API key — only the runtime droid invocations do.

---

## 5. OpenClaw (ClawHub Registry)

**Architecture**: ClawHub is OpenClaw's central registry for packages. Each package declares its capabilities in `clawhub.json`.

**Manifest format**:

`clawhub.json`:

```json
{
  "name": "aiwg-sdlc",
  "version": "2026.4.0",
  "description": "AIWG SDLC framework for OpenClaw",
  "author": "AIWG Contributors",
  "license": "MIT",
  "tags": ["sdlc", "agents", "multi-agent"],
  "contents": {
    "agents": "~/.openclaw/agents/aiwg-sdlc/",
    "commands": "~/.openclaw/commands/aiwg-sdlc/",
    "skills": "~/.openclaw/skills/aiwg-sdlc/",
    "rules": "~/.openclaw/rules/aiwg-sdlc/",
    "behaviors": "~/.openclaw/behaviors/aiwg-sdlc/"
  }
}
```

**Unique feature**: OpenClaw is the first provider to support **behaviors** (reactive event handlers). AIWG deploys behaviors to `~/.openclaw/behaviors/` only for this provider.

**Implementation status**: `clawhub.json` is generated alongside file deployment, but ClawHub publishing API/workflow has not been implemented. Users install via `aiwg use sdlc --provider openclaw` (deploys to `~/.openclaw/`).

**Deployment convention**: OpenClaw artifacts deploy to **home directory** (`~/.openclaw/`) rather than project directories — cross-project availability by default.

---

## 6. Devin Desktop (No Marketplace — Adapter Pattern)

**Status**: Devin Desktop does not have a native marketplace or plugin system. AIWG uses file-based deployment as the intentional adapter.

**Deployment pattern**:

```bash
aiwg use sdlc --provider devin
```

**What gets deployed**:
- Agents aggregated into `AGENTS.md` at project root (Devin Desktop's convention)
- Commands → `.windsurf/workflows/`
- Skills → `.windsurf/skills/`
- Rules → `.windsurf/rules/`

**Why this is the adapter, not a gap**: Devin Desktop's context model is MCP-centric and file-based. There is no plugin manifest to populate. File deployment gives Devin Desktop everything it needs for AIWG agents to function.

**Future marketplace support**: If Devin Desktop adds a plugin system, AIWG would add a corresponding provider in `tools/agents/providers/windsurf.mjs` to generate the manifest.

---

## 7. Warp (No Marketplace — Adapter Pattern)

**Status**: Warp's Oz Platform offers cloud-based agent distribution, but it is a different concept from a local plugin marketplace. There is no plugin manifest to publish. AIWG uses file-based deployment as the adapter.

**Deployment pattern**:

```bash
aiwg use sdlc --provider warp
```

**What gets deployed**:
- Agents aggregated into `WARP.md` at project root (Warp's single-file convention)
- Agents also deployed to `.warp/agents/` as discrete files
- Commands → `.warp/commands/`
- Skills → `.warp/skills/`
- Rules → `.warp/rules/`

**Why dual deployment (single-file + discrete)**: Warp reads `WARP.md` for aggregated context but also supports discrete agent files. AIWG provides both to maximize compatibility.

**Oz Platform distinction**: Oz is for hosted agent-as-a-service, not local plugin distribution. AIWG does not publish to Oz — the framework is designed for local, file-based agent deployment.

---

## 8. OpenCode (No Marketplace — Adapter Pattern)

**Status**: No plugin marketplace identified at time of writing. AIWG uses file-based deployment as the adapter.

**Deployment pattern**:

```bash
aiwg use sdlc --provider opencode
```

**What gets deployed**: `.opencode/agent/`, `.opencode/command/`, `.opencode/skill/`, `.opencode/rule/` — OpenCode's directory convention (singular names).

**Naming convention**: OpenCode uses singular directory names (`agent/` not `agents/`). The provider config in `tools/agents/providers/opencode.mjs` handles this naming translation.

---

## 9. Hermes (No Marketplace — Adapter Pattern)

**Status**: No plugin marketplace identified. AIWG uses file-based deployment as the adapter with limited scope.

**Deployment pattern**:

```bash
aiwg use sdlc --provider hermes
```

**What gets deployed**:
- Agents → `AGENTS.md` at project root (aggregated)
- Skills → `~/.hermes/skills/`
- **No commands or rules** (Hermes doesn't currently support them)

Managed imported Agent Skills use the separate `aiwg skills deploy <name>
--target hermes` path. That command writes strict portable bundles directly
under `~/.hermes/skills/<name>` and protects them with AIWG ownership sidecars.

**Current limitations**: Hermes has the narrowest integration surface of any supported provider. As Hermes's capabilities grow, the provider config can be extended.

---

## 10. Copilot / VS Code (Extension vs Framework Adapter)

**Status**: VS Code Marketplace exists but hosts **extensions**, not skill/agent packages. These are distinct concepts:

- **VS Code Extension** (hosted on Marketplace): compiled extension that integrates with VS Code APIs — this is how AIWG integrates as a tool (tracked separately in #623)
- **Framework Adapter** (via `aiwg use`): agents, commands, skills deployed as files Copilot can reference

The two are complementary, not alternatives.

**Deployment pattern** (for the framework adapter):

```bash
aiwg use sdlc --provider copilot
```

**What gets deployed**:
- Agents → `.github/agents/` in `.agent.md` format (Markdown + YAML frontmatter)
- Commands → `.github/prompts/` as prompt files
- Skills → `.github/prompts/` (alongside commands)
- Rules → `.github/instructions/` as path-scoped instructions

**Copilot's unique format**: Agents use the `.agent.md` extension with YAML frontmatter specifying model, tools, and instructions. Commands are not slash commands — they are prompt templates discoverable via Copilot's prompt picker.

---

## Common Patterns

### Package Plugin Command

AIWG exposes a unified packaging command that emits provider-appropriate artifacts:

```bash
# Package for all providers (Claude Code default)
node tools/plugin/package-plugins.mjs --all

# Package for a specific provider
node tools/plugin/package-plugins.mjs --plugin sdlc --provider codex

# Dry run
node tools/plugin/package-plugins.mjs --all --dry-run
```

The packaging logic lives in `tools/plugin/package-plugins.mjs` and delegates to provider-specific generators in `tools/agents/providers/<provider>.mjs`.

### Namespace Conventions

All AIWG plugins use the `aiwg` namespace:

- `aiwg/sdlc` — SDLC framework
- `aiwg/marketing` — Marketing kit
- `aiwg/voice` — Voice framework
- `aiwg/hooks` — Workflow hooks
- `aiwg/utils` — Core utilities
- `aiwg/writing` — Writing quality

Third-party marketplace plugins install under their own namespace (not `aiwg/`). The collision detector treats non-`aiwg/` content as `warn` severity (prompt before overwrite).

### Versioning

AIWG uses CalVer (`YYYY.M.PATCH`). Plugin manifests reflect the AIWG version at packaging time. Individual plugin versions can diverge for targeted releases but typically track the main AIWG release.

### License

All AIWG-bundled plugins are MIT-licensed. Third-party plugins installed via the marketplace retain their original license — AIWG does not relicense third-party content.

---

## Implementation Inventory

| Capability | Status | File |
|-----------|--------|------|
| Claude Code `marketplace.json` | ✅ Root file exists | `marketplace.json` |
| Claude Code `.claude-plugin/plugin.json` | ✅ Per-plugin manifests | `agentic/code/plugins/*/.claude-plugin/plugin.json` |
| Codex `generatePluginBundle()` | ✅ Implemented | `tools/agents/providers/codex.mjs:327` |
| Codex `.agents/plugins/marketplace.json` | ⚠️ Generated per-plugin, needs root aggregation | N/A |
| Codex `.codex-plugin/plugin.json` | ✅ Generated by codex.mjs | `agentic/code/plugins/*/.codex-plugin/plugin.json` |
| Cursor `.cursor-plugin/plugin.json` | ⚠️ Manifest template documented, generator TODO | N/A |
| Factory `generatePluginBundle()` | ✅ Implemented | `tools/agents/providers/factory.mjs:657` |
| Factory `.factory-plugin/plugin.json` | ✅ Generated by factory.mjs | `agentic/code/plugins/*/.factory-plugin/plugin.json` |
| OpenClaw `clawhub.json` | ✅ Generated alongside deployment | `agentic/code/frameworks/*/clawhub.json` |
| OpenClaw publishing workflow | ❌ Not implemented — manual publish | N/A |
| Devin Desktop adapter | ✅ File deployment | `tools/agents/providers/windsurf.mjs` |
| Warp adapter | ✅ File deployment + `WARP.md` | `tools/agents/providers/warp.mjs` |
| OpenCode adapter | ✅ File deployment | `tools/agents/providers/opencode.mjs` |
| Hermes adapter | ✅ Limited file deployment plus managed Agent Skills projection | `tools/agents/providers/hermes.mjs`; `src/skills/deployer.ts` |
| Copilot adapter | ✅ `.agent.md` generation | `tools/agents/providers/copilot.mjs` |

---

## Related Issues

- **#783** — This document (native marketplace integration)
- **#787** — Consumer side: install third-party marketplaces via AIWG
- **#623** — VS Code extension (separate from framework adapter)
- **ADR-016** — Claude Code plugin distribution architecture

## Related Documentation

- `@docs/providers/git-native-marketplace.md` — Git-native provenance,
  immutable locks, signed catalogs, project/global scope, and offline exchange
- `@docs/providers/skills-paths.md` — Provider deployment paths reference
- `@docs/providers/capability-matrix.md` — Feature capability matrix
- `@.aiwg/references/platforms/claude-code.md` — Claude Code deep reference
- `@.aiwg/references/platforms/codex.md` — Codex deep reference
- `@.aiwg/references/platforms/cursor.md` — Cursor deep reference
- `@.aiwg/references/platforms/factory-ai.md` — Factory AI deep reference
- `@.aiwg/references/platforms/openclaw.md` — OpenClaw deep reference
