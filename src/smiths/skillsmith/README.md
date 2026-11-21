# SkillSmith

Platform-aware skill generation system for AIWG.

## Overview

SkillSmith generates skills with proper SKILL.md format and deploys them to platform-specific directories. Skills are triggered by natural language patterns rather than explicit commands.

## Features

- **Platform-aware deployment**: Automatically deploys to correct directory for each platform
- **Skill validation**: Validates skill names (kebab-case) and structure
- **Reference generation**: Optionally creates supporting documentation
- **Multi-platform support**: Claude, Factory, Cursor, Codex, Devin Desktop, Copilot, Generic
- **Dry-run mode**: Preview deployment without writing files

## Platform Support

| Platform | Location | Native Skills | Alternative |
|----------|----------|---------------|-------------|
| Claude | `.claude/skills/` | Yes | - |
| Generic | `skills/` | Yes | - |
| Factory | `.factory/skills/` | No | Command |
| Cursor | `.cursor/skills/` | Yes | - |
| Codex | `.codex/skills/` | No | Command |
| Devin Desktop | `.windsurf/skills/` | No | Command |
| Copilot | `.github/copilot/skills/` | No | None |

## Usage

### Basic Generation

```typescript
import { generateSkill, deploySkill } from '@aiwg/smiths/skillsmith';

const skill = await generateSkill({
  name: 'voice-apply',
  description: 'Apply voice profiles to content',
  platform: 'claude',
  projectPath: '/path/to/project',
  triggerPhrases: [
    'apply voice',
    'use voice',
    'write in voice'
  ]
});

const result = await deploySkill(skill, '/path/to/project');
console.log(`Deployed to: ${result.deployPath}`);
```

### With Tools and References

```typescript
const skill = await generateSkill({
  name: 'code-analyzer',
  description: 'Analyze code quality and patterns',
  platform: 'claude',
  projectPath: '/path/to/project',
  tools: ['Read', 'Write', 'Glob', 'Grep'],
  createReferences: true,
  triggerPhrases: [
    'analyze code',
    'check code quality',
    'review code patterns'
  ]
});
```

### Version Control

```typescript
const skill = await generateSkill({
  name: 'my-skill',
  description: 'Custom skill',
  platform: 'claude',
  projectPath: '/path/to/project',
  version: '2.1.0'
});
```

### Dry Run

```typescript
const result = await deploySkill(skill, '/path/to/project', true);
// Preview deployment without writing files
```

## Skill Structure

Generated skills follow this structure:

```
skill-name/
├── SKILL.md              # Main skill definition
└── references/           # Optional supporting docs
    ├── usage-examples.md
    └── configuration.md
```

## SKILL.md Format

**Required fields:** `name`, `description` (non-empty), `version`.

The `description` field is enforced at generation time — `generateSkill()`
throws if it is missing or blank. This guard exists because Codex rejects
any SKILL.md that lacks a non-empty description, and Claude Code relies on
the description for natural-language invocation.

```markdown
---
name: skill-name
description: What this skill does   # REQUIRED, non-empty
version: 1.0.0
tools: Read, Write
---

# Skill Name Skill

## Purpose

Description of what this skill does.

## Trigger Phrases

Activate this skill when the user says:
- "phrase 1"
- "phrase 2"

## Input

This skill expects:
- Input requirement 1

## Execution Process

1. Step 1
2. Step 2

## Output

This skill produces:
- Output 1

## Examples

### Example 1: Basic Usage
**User**: "trigger phrase"
**Result**: What happens
```

## Skill Name Validation

Skill names must:
- Be at least 2 characters
- Use kebab-case (lowercase, alphanumeric, hyphens)
- Not start or end with hyphen

**Valid**: `test-skill`, `my-skill`, `skill-123`, `ab`

**Invalid**: `Test_Skill`, `-invalid`, `invalid-`, `with space`

## Platform-Specific Notes

### Claude
- Native skill support
- Deployed to `.claude/skills/`
- Automatically discovered

### Factory, Cursor, Codex
- No native skill support
- Skills deployed as reference
- Can be mapped to commands

### Copilot
- Limited skill support
- Manual integration required

## API Reference

### `generateSkill(options: SkillOptions): Promise<GeneratedSkill>`

Generate a skill from options.

**Parameters:**
- `name` (string, required): Skill name (kebab-case)
- `description` (string, required, non-empty): What the skill does. Throws if missing or blank — Codex rejects SKILL.md without it.
- `platform` (Platform, required): Target platform
- `projectPath` (string, required): Where to deploy
- `guidance?` (string): User guidance for generation
- `interactive?` (boolean): Enable interactive mode
- `triggerPhrases?` (string[]): Natural language triggers
- `dryRun?` (boolean): Preview without writing
- `version?` (string): Skill version (default: "1.0.0")
- `tools?` (string[]): Tools this skill uses
- `createReferences?` (boolean): Create references directory

### `deploySkill(skill: GeneratedSkill, projectPath: string, dryRun?: boolean): Promise<SkillDeploymentResult>`

Deploy a generated skill to the target platform.

**Parameters:**
- `skill` (GeneratedSkill): The skill to deploy
- `projectPath` (string): Project root directory
- `dryRun?` (boolean): If true, preview without writing files

### `PlatformSkillResolver`

Static utility class for platform-specific path resolution.

**Methods:**
- `getConfig(platform)`: Get platform configuration
- `getBaseDir(platform, projectPath)`: Get base skills directory
- `getSkillPath(platform, projectPath, skillName)`: Get skill directory path
- `getSkillFilePath(platform, projectPath, skillName)`: Get SKILL.md path
- `getReferencesPath(platform, projectPath, skillName)`: Get references directory path
- `supportsSkills(platform)`: Check if platform supports skills natively
- `getAlternativeStrategy(platform)`: Get alternative deployment strategy
- `validateSkillName(name)`: Validate skill name format

## Examples

### Generate Voice Application Skill

```typescript
const skill = await generateSkill({
  name: 'voice-apply',
  description: 'Applies voice profiles to transform content',
  platform: 'claude',
  projectPath: process.cwd(),
  triggerPhrases: [
    'apply voice',
    'use voice',
    'write in voice',
    'transform to voice'
  ],
  tools: ['Read', 'Write'],
  createReferences: true,
  version: '1.0.0'
});

await deploySkill(skill, process.cwd());
```

### Generate Code Analysis Skill

```typescript
const skill = await generateSkill({
  name: 'code-analyzer',
  description: 'Analyzes code quality, patterns, and potential issues',
  platform: 'claude',
  projectPath: process.cwd(),
  triggerPhrases: [
    'analyze code',
    'check code quality',
    'review code',
    'find code issues'
  ],
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  createReferences: true
});
```

### Generate Testing Skill

```typescript
const skill = await generateSkill({
  name: 'test-generator',
  description: 'Generates comprehensive test suites from code',
  platform: 'claude',
  projectPath: process.cwd(),
  triggerPhrases: [
    'generate tests',
    'create test suite',
    'write tests for'
  ],
  tools: ['Read', 'Write', 'Glob', 'Grep'],
  guidance: 'Focus on edge cases and integration scenarios'
});
```

## Integration

### With AIWG CLI

```bash
# Future: aiwg skill create <name> --platform claude
```

### Programmatic

```typescript
import { generateSkill, deploySkill } from '@aiwg/smiths/skillsmith';

// Your skill generation logic
```

## Contributing

When adding new skill generators:
1. Follow the SKILL.md format specification
2. Add trigger phrases that match natural language patterns
3. Include clear input/output specifications
4. Provide usage examples
5. Test across all supported platforms

## Related

- [AIWG Skills Documentation](../../agentic/code/)
- [Platform Deployment Guide](../agents/)
- [Skill Factory Addon](../../agentic/code/addons/skill-factory/)
