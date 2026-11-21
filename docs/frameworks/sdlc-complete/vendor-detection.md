# Vendor Detection

This document describes how AIWG regenerate commands detect which AI coding assistant is active, enabling vendor-specific context generation.

## Detection Strategy

Each regenerate command should detect the active vendor to include only relevant commands and references, reducing context pollution.

## Vendor Detection Rules

### Claude Code

**Primary indicators:**
- `.claude/` directory exists
- `.claude/settings.json` or `.claude/settings.local.json` exists
- `CLAUDE.md` exists at project root

**Command format:** Slash commands (`/command-name`)

**Agent format:** Markdown files in `.claude/agents/`

**Features:**
- Native @-mention support for file references
- Project context window controls
- Tool access controls via settings.json
- Command autodiscovery from `.claude/commands/`

### GitHub Copilot

**Primary indicators:**
- `.github/copilot-instructions.md` exists
- `.github/agents/*.yml` files exist
- GitHub Copilot extension detected (check for `.github/copilot/` directory)

**Command format:** Natural language (no slash commands)

**Agent format:** YAML files in `.github/agents/`

**Features:**
- Copilot Chat with @-mention agents
- Issue-to-PR automation via Copilot Coding Agent
- Workspace context awareness
- GitHub ecosystem integration

### Cursor

**Primary indicators:**
- `.cursorrules` file exists at project root
- `.cursor/` directory exists
- `.cursor/rules/` contains rule files

**Command format:** Natural language prompts

**Agent format:** Rules in `.cursorrules` or `.cursor/rules/*.md`

**Features:**
- Inline chat and composer modes
- Codebase-wide search and context
- Custom rules and instructions
- Multi-file editing

### Devin Desktop (Codeium)

**Primary indicators:**
- `.windsurfrules` file exists at project root
- Devin Desktop-specific configuration detected

**Command format:** Natural language prompts

**Agent format:** Instructions in `.windsurfrules`

**Features:**
- Cascade AI assistant
- Flow mode for task completion
- Multi-file awareness
- Codeium context engine

### Warp Terminal

**Primary indicators:**
- `WARP.md` exists at project root
- Terminal context (check `$TERM_PROGRAM` environment variable if available)

**Command format:** Terminal commands and aliases

**Agent format:** Instructions in `WARP.md`

**Features:**
- Terminal-first AI assistance
- Command suggestions
- Error explanations
- Workflow automation

### Factory AI

**Primary indicators:**
- `.factory/` directory exists
- `.factory/droids/` contains droid definitions

**Command format:** Droid invocations

**Agent format:** JSON/YAML in `.factory/droids/*.json`

**Features:**
- Custom droid deployment
- Workflow automation
- CI/CD integration
- Multi-platform support

### OpenCode

**Primary indicators:**
- `.opencode/` directory exists
- `.opencode/agent/` contains agent definitions

**Command format:** Agent commands

**Agent format:** Definitions in `.opencode/agent/`

**Features:**
- Open-source agent framework
- Custom agent development
- Extensible tool system

### Codex (OpenAI)

**Primary indicators:**
- `~/.codex/` directory exists in user home
- Codex configuration files present

**Command format:** Natural language

**Agent format:** Project skills in `.agents/skills/`; optional user skills in `~/.codex/skills/`

**Features:**
- OpenAI Codex integration
- Custom skill deployment
- API-based interactions

## Detection Priority Order

When multiple indicators are present, use this priority order:

1. **Claude Code** - Most specific detection (`.claude/` + `CLAUDE.md`)
2. **GitHub Copilot** - GitHub-specific indicators
3. **Cursor** - `.cursorrules` is distinctive
4. **Devin Desktop** - `.windsurfrules` is distinctive
5. **Warp** - `WARP.md` is distinctive
6. **Factory AI** - `.factory/droids/` structure
7. **OpenCode** - `.opencode/agent/` structure
8. **Codex** - Home directory configuration

## Multi-Vendor Projects

Some projects may support multiple vendors. In these cases:

1. Detect all active vendors
2. Generate separate context files for each
3. Include cross-references in each file
4. Keep each context file focused on its specific vendor

Example:
```
Project has:
  - .claude/ (Claude Code active)
  - .github/copilot-instructions.md (Copilot active)
  - .cursorrules (Cursor active)

Generate:
  - CLAUDE.md (only Claude commands)
  - .github/copilot-instructions.md (only Copilot patterns)
  - .cursorrules (only Cursor rules)

Each file references the others for full picture.
```

## Vendor-Specific Command Inclusion

### Claude Code Context (CLAUDE.md)

**Include:**
- Claude Code slash commands from `.claude/commands/`
- Claude-specific agent definitions
- Claude settings and tool configurations
- @-mention references to local files

**Exclude:**
- Copilot YAML agent definitions
- Cursor rule syntax
- Factory droid configurations
- Terminal-specific commands (unless WARP.md also present)

**Reference (don't inline):**
- Full command list at AIWG installation path
- Links to Copilot/Cursor docs for multi-vendor setups
- Framework documentation

### GitHub Copilot Context (.github/copilot-instructions.md)

**Include:**
- Copilot agent YAML references
- GitHub Actions workflow integration
- Natural language command patterns
- Issue-to-PR automation notes

**Exclude:**
- Claude Code slash commands
- Cursor-specific rule syntax
- Warp terminal commands
- Factory droid definitions

**Reference (don't inline):**
- AIWG framework documentation
- Links to Claude/Cursor for multi-vendor setups

### Cursor Context (.cursorrules)

**Include:**
- Cursor rule syntax
- Project-specific coding conventions
- Natural language prompts
- File path references

**Exclude:**
- Claude Code slash commands
- Copilot YAML syntax
- Warp terminal commands
- Factory droid JSON

**Reference (don't inline):**
- AIWG documentation
- Links to other vendor configs

### Devin Desktop Context (.windsurfrules)

**Include:**
- Devin Desktop-specific instructions
- Cascade AI patterns
- Flow mode guidelines

**Exclude:**
- Other vendor-specific syntax

### Warp Context (WARP.md)

**Include:**
- Terminal commands and aliases
- Shell script patterns
- CLI workflow automation
- Environment-specific notes

**Exclude:**
- IDE-specific commands
- GUI-based workflow instructions

### Factory AI Context (.factory/droids/)

**Include:**
- Droid definitions (JSON/YAML)
- Factory-specific workflow patterns
- CI/CD integration notes

**Exclude:**
- IDE-specific commands
- Other agent formats

### AGENTS.md (Multi-vendor fallback)

**Include:**
- Generic agent descriptions
- Natural language patterns
- Project structure and commands
- Framework references

**Purpose:** Used by platforms without specific context files (OpenCode, Codex, custom platforms)

## Implementation Pattern

Each regenerate command should:

```typescript
// Pseudo-code
function regenerateContext(vendor: string, options: RegenerateOptions) {
  // 1. Detect active vendor
  const detectedVendor = detectVendor();

  // 2. Load vendor-specific template
  const template = loadTemplate(detectedVendor);

  // 3. Gather project info (common across vendors)
  const projectInfo = analyzeProject();

  // 4. Load ONLY vendor-specific commands/agents
  const vendorCommands = loadCommandsForVendor(detectedVendor);
  const vendorAgents = loadAgentsForVendor(detectedVendor);

  // 5. Generate context with vendor-specific content
  const context = template.render({
    project: projectInfo,
    commands: vendorCommands,
    agents: vendorAgents,
    references: generateReferences(detectedVendor)
  });

  // 6. Add "Full Reference" section with links (not inline content)
  context += generateFullReferenceSection(detectedVendor);

  return context;
}

function generateFullReferenceSection(vendor: string): string {
  return `
## Full Command Reference

For complete AIWG command documentation, see:
- Installation: ~/.local/share/ai-writing-guide/
- SDLC Commands: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/
- Utilities: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/commands/

Multi-vendor setup? See ${getOtherVendorLinks(vendor)}
`;
}
```

## Context Size Guidelines

Each vendor context file should target:

- **Claude Code (CLAUDE.md)**: 300-500 lines
- **GitHub Copilot**: 250-400 lines
- **Cursor (.cursorrules)**: 200-350 lines
- **Devin Desktop (.windsurfrules)**: 200-350 lines
- **Warp (WARP.md)**: 150-300 lines
- **AGENTS.md**: 300-450 lines

If a context file exceeds these ranges, move detailed content to separate docs and use @-mentions/references.

## Testing Detection

To test vendor detection:

1. Create test projects with various vendor indicators
2. Run regenerate command without arguments
3. Verify correct vendor is detected
4. Verify only vendor-specific content is included
5. Verify references section points to full docs

## Migration Notes

Existing regenerate commands that inline all content should be updated to:

1. Add vendor detection logic
2. Filter commands/agents by vendor
3. Replace full content inlining with reference sections
4. Maintain backward compatibility with explicit vendor flags

Example:
```bash
# Auto-detect (new behavior)
/aiwg-regenerate-claude

# Explicit vendor (backward compatible)
/aiwg-regenerate --vendor claude

# Include everything (opt-in for full context)
/aiwg-regenerate-claude --full-reference
```
