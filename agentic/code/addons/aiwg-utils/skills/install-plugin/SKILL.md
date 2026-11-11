---
namespace: aiwg
name: install-plugin
platforms: [all]
description: Install Claude Code marketplace plugins or route local/Git wrappers through the supported package workflow
---

# Install Plugin

You install a Claude Code marketplace plugin. In AIWG vocabulary, a plugin is a delivery wrapper around an extension, addon, or framework, not a separate content type. You handle registry lookup, download, and local deployment.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I want the SDLC plugin" → install sdlc@aiwg
- "add the voice bundle" → install voice@aiwg
- "get me the marketing kit" → install marketing@aiwg
- "set up the testing tools" → install utils@aiwg

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Install plugin | "install plugin sdlc@aiwg" | Run `aiwg install-plugin sdlc@aiwg` |
| Add plugin | "add plugin voice@aiwg" | Run `aiwg install-plugin voice@aiwg` |
| Plugin install | "plugin install marketing@aiwg" | Run `aiwg install-plugin marketing@aiwg` |
| Claude Code plugin | "install claude code plugin utils" | Run `aiwg install-plugin utils@aiwg` |
| Dry run | "show me what installing sdlc would do" | Run `aiwg install-plugin sdlc@aiwg --dry-run` |
| Specific version | "install sdlc version 2026.3.0" | Run `aiwg install-plugin sdlc@aiwg@2026.3.0` |
| Local wrapper | "install this local plugin wrapper" | Run `aiwg install <path> --dry-run`, then `aiwg use <plugin-id>` |
| Git wrapper | "install this plugin Git URL" | Run `aiwg install <git-url> --dry-run`, then `aiwg use <plugin-id>` |

## Behavior

When triggered:

1. **Extract intent**:
   - Which plugin is being requested? (name and optional `@scope`)
   - Is a specific version mentioned?
   - Is this a dry run?

2. **Run the appropriate command**:

   ```bash
   # Install from AIWG marketplace (default scope)
   aiwg install-plugin sdlc@aiwg
   aiwg install-plugin voice@aiwg
   aiwg install-plugin marketing@aiwg
   aiwg install-plugin utils@aiwg

   # Install a specific version
   aiwg install-plugin sdlc@aiwg@2026.3.0

   # Preview what would be installed
   aiwg install-plugin sdlc@aiwg --dry-run

   # Force reinstall even if already installed
   aiwg install-plugin sdlc@aiwg --force

   # Standalone local/Git wrappers use the package installer, not the legacy
   # manifest-only install-plugin backend.
   aiwg install ./path/to/wrapper --dry-run
   aiwg install https://example.invalid/owner/wrapper.git --dry-run
   aiwg use <plugin-id>
   ```

3. **Report the result** — name the installed marketplace wrapper and confirm which agents, skills, commands, and rules were deployed and where.

## Finding third-party plugins

For a capability request without a selected plugin, use
[plugin-search](../plugin-search/SKILL.md):
`aiwg marketplace search "<capability>" --plugins` reads configured local
marketplaces and caches without installing anything. The four packages below
are AIWG's packages, not a complete directory of third-party plugins. Use the
provider's installer for third-party results; search does not extend this backend.

## Available Marketplace Packages

| Package | Payload | Use Case |
|--------|----------|----------|
| `sdlc@aiwg` | 58 agents, 42 commands, SDLC workflows | Full software development lifecycle |
| `voice@aiwg` | Voice profiles, soul system | Content style and persona management |
| `marketing@aiwg` | Marketing agents, campaigns, media | Marketing operations framework |
| `utils@aiwg` | Core utility skills and rules | Foundational cross-framework utilities |

## What Happens on Install

1. Delivery manifest fetched from marketplace
2. Agents deployed to `.claude/agents/`
3. Commands deployed to `.claude/commands/`
4. Skills deployed to `.claude/skills/`
5. Rules deployed to `.claude/rules/`
6. Delivery wrapper registered in local plugin registry

## Examples

### Example 1: Install SDLC plugin

**User**: "Install the SDLC plugin"

**Extraction**: Plugin name is `sdlc`, scope is `aiwg`

**Action**:
```bash
aiwg install-plugin sdlc@aiwg
```

**Response**: "Installed sdlc@aiwg v2026.3.15. Deployed 58 agents to .claude/agents/, 42 commands to .claude/commands/, 12 skills to .claude/skills/, 33 rules to .claude/rules/."

### Example 2: Dry run before installing

**User**: "What would installing the voice plugin add?"

**Extraction**: Dry-run for voice plugin

**Action**:
```bash
aiwg install-plugin voice@aiwg --dry-run
```

**Response**: "Dry run — voice@aiwg v2026.3.15 would add: 6 voice profiles to .claude/skills/voices/, 4 soul system skills, 2 rules. No changes made."

### Example 3: Force reinstall after corruption

**User**: "The SDLC plugin seems broken, reinstall it"

**Extraction**: Force reinstall of sdlc

**Action**:
```bash
aiwg install-plugin sdlc@aiwg --force
```

**Response**: "Force reinstalled sdlc@aiwg. All 58 agents and 42 commands redeployed cleanly."

## Clarification Prompts

If the plugin name is ambiguous:

- "Which plugin would you like to install? Available: sdlc@aiwg, voice@aiwg, marketing@aiwg, utils@aiwg"
- "Did you mean `sdlc@aiwg`? Run `aiwg catalog list` to see all available plugins."

## References

- @$AIWG_ROOT/src/cli/handlers/utilities.ts — Command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
