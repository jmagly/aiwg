# SkillSmith Implementation

## Overview

SkillSmith is a tool for generating skills with platform-aware deployment. It creates properly formatted SKILL.md files and deploys them to the correct platform-specific directories.

## Architecture

### Components

1. **types.ts** - TypeScript type definitions
   - `SkillOptions`: Configuration for skill generation
   - `GeneratedSkill`: Result of skill generation
   - `SkillDeploymentResult`: Result of deployment
   - `SkillFrontmatter`: YAML frontmatter structure
   - `SkillReference`: Supporting reference files
   - `PlatformSkillConfig`: Platform-specific configuration

2. **platform-resolver.ts** - Platform-specific path resolution
   - Resolves deployment paths for each platform
   - Validates skill names (kebab-case)
   - Identifies native skill support
   - Provides alternative strategies for non-skill platforms

3. **generator.ts** - Core skill generation logic
   - `generateSkill()`: Creates skill from options
   - `deploySkill()`: Writes skill to filesystem
   - `generateSkillContent()`: Formats SKILL.md
   - `generateDefaultReferences()`: Creates reference docs

4. **index.ts** - Public API exports

5. **examples.ts** - Usage examples

## Platform Support

### Native Skill Support
- **Claude**: `.claude/skills/` - Full support
- **Generic**: `skills/` - Full support

### Command Mapping
- **Factory**: `.factory/skills/` - Maps to commands
- **Cursor**: `.cursor/skills/` - Maps to commands
- **Codex**: `.codex/skills/` - Maps to commands
- **Devin Desktop**: `.windsurf/skills/` - Maps to commands

### Limited/Manual
- **Copilot**: `.github/copilot/skills/` - Manual integration

## Skill Format

### Frontmatter

**`name`, `description`, and `version` are REQUIRED.** `description` must be
non-empty — Codex rejects SKILL.md files without it, and the SkillSmith
generator throws at runtime if it is missing or blank.

```yaml
---
name: skill-name
description: Brief description   # REQUIRED, non-empty
version: 1.0.0
tools: Read, Write, Glob
---
```

### Structure
```markdown
# Skill Name Skill

## Purpose
What this skill does

## Trigger Phrases
- "trigger 1"
- "trigger 2"

## Input
Expected inputs

## Execution Process
1. Step 1
2. Step 2

## Output
What it produces

## Examples
Usage examples
```

## API

### generateSkill(options: SkillOptions): Promise<GeneratedSkill>

**Parameters:**
- `name` (required): Skill name (kebab-case)
- `description` (required, non-empty): What the skill does. Throws if missing or blank.
- `platform` (required): Target platform
- `projectPath` (required): Deployment directory
- `triggerPhrases?`: Natural language triggers
- `tools?`: Tools this skill uses
- `createReferences?`: Create reference docs
- `version?`: Skill version (default: "1.0.0")
- `guidance?`: User guidance text
- `dryRun?`: Preview only

**Returns:** GeneratedSkill object with content and metadata

### deploySkill(skill: GeneratedSkill, projectPath: string, dryRun?: boolean): Promise<SkillDeploymentResult>

**Parameters:**
- `skill`: Generated skill object
- `projectPath`: Project root directory
- `dryRun`: If true, preview without writing

**Returns:** Deployment result with success status and file paths

### PlatformSkillResolver (static class)

**Methods:**
- `getConfig(platform)`: Get platform configuration
- `getBaseDir(platform, projectPath)`: Get skills base directory
- `getSkillPath(platform, projectPath, skillName)`: Get skill directory
- `getSkillFilePath(platform, projectPath, skillName)`: Get SKILL.md path
- `getReferencesPath(platform, projectPath, skillName)`: Get references directory
- `supportsSkills(platform)`: Check native support
- `getAlternativeStrategy(platform)`: Get fallback strategy
- `validateSkillName(name)`: Validate name format

## Validation

### Skill Name Rules
- Minimum 2 characters
- kebab-case only (lowercase, alphanumeric, hyphens)
- Cannot start or end with hyphen
- No underscores or spaces

**Valid:** `test-skill`, `my-skill`, `skill-123`
**Invalid:** `Test_Skill`, `-invalid`, `with space`

## File Structure

Generated skills create:
```
{platform}/skills/{skill-name}/
├── SKILL.md
└── references/              # Optional
    ├── usage-examples.md
    └── configuration.md
```

## Testing

Tests located in `test/unit/smiths/skillsmith.test.ts`:
- Platform resolver validation
- Skill name validation
- Content generation
- Trigger phrase inclusion
- Tool specification
- Reference generation
- Deployment (including dry-run)

Run tests:
```bash
npx vitest run test/unit/smiths/skillsmith.test.ts
```

## Integration Points

### With AIWG Deployment
Skills can be deployed alongside agents and commands during AIWG installation.

### With CLI (Future)
```bash
aiwg skill create <name> --platform claude --triggers "apply voice, use voice"
```

### Programmatic
```typescript
import { generateSkill, deploySkill } from '@aiwg/smiths/skillsmith';

const skill = await generateSkill({
  name: 'my-skill',
  description: 'Custom skill',
  platform: 'claude',
  projectPath: process.cwd()
});

await deploySkill(skill, process.cwd());
```

## Future Enhancements

1. **Interactive Mode**: Guided skill creation with prompts
2. **Template System**: Reusable skill templates
3. **Skill Discovery**: Auto-detect existing skills
4. **Skill Validation**: Runtime validation of skill structure
5. **Multi-Platform Bundle**: Generate for all platforms at once
6. **Skill Migration**: Migrate skills between platforms
7. **Reference Templates**: More reference doc types
8. **AI-Assisted Generation**: Use LLM to generate skill content

## Design Decisions

### Why Separate from CommandSmith?
Skills differ from commands:
- **Commands**: Explicit invocation (`/command-name`)
- **Skills**: Natural language triggers ("apply voice")
- Different file structures and metadata
- Different platform support levels

### Why Platform-Specific Paths?
Each platform has conventions:
- Claude uses `.claude/skills/`
- Factory uses `.factory/` structure
- Consistent with agent deployment patterns

### Why Validate Skill Names?
- Ensures cross-platform compatibility
- Prevents filesystem issues
- Matches Claude skill naming conventions
- Improves discoverability

## Dependencies

- Node.js fs/promises for file operations
- Path module for cross-platform paths
- Agents types for Platform enum
- TypeScript for type safety

## References

- [SKILL.md Format](../../agentic/code/addons/)
- [Platform Deployment](../../agents/)
- [devkit-create-skill command](../../../.claude/commands/devkit-create-skill.md)
