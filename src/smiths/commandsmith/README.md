# CommandSmith

Platform-aware slash command generator for AIWG.

## Overview

CommandSmith generates slash commands with:

- **Three template types**: Utility, Transformation, Orchestration
- **Multi-platform support**: Claude, Factory, Cursor, Codex, Copilot, Devin Desktop, Generic
- **Standard options**: All commands support `--interactive` and `--guidance`
- **Platform-specific formats**: Markdown for most, JSON for Cursor
- **Validation**: Ensures proper naming and structure

## Quick Start

```typescript
import { generateAndDeploy } from './smiths/commandsmith/index.js';

// Generate and deploy a command
const result = await generateAndDeploy({
  name: 'my-workflow',
  description: 'Execute my custom workflow',
  template: 'orchestration',
  platform: 'claude',
  projectPath: '/path/to/project',
  args: [
    { name: 'target', description: 'Target environment', required: true },
  ],
  options: [
    { name: 'dry-run', description: 'Preview changes', type: 'boolean' },
  ],
}, { backup: true });

if (result.success) {
  console.log(`Deployed to ${result.command.path}`);
}
```

## Command Templates

### Utility

Simple operations and single-action commands.

**Best for:**
- Quick tasks
- File operations
- Status checks
- Simple workflows

**Example:**
```bash
/lint-check
/deploy-status
/backup-config
```

**Sections:**
- Usage
- Arguments
- Options
- Execution
- Output
- Examples

### Transformation

Content/code transformation pipelines with input/output handling.

**Best for:**
- Format conversion
- Code refactoring
- Content processing
- Data transformation

**Example:**
```bash
/convert-format
/refactor-code
/migrate-schema
```

**Sections:**
- Usage
- Arguments
- Options
- Transformation Pipeline
- Input Requirements
- Output Format
- Validation
- Examples

### Orchestration

Multi-agent workflow coordination with phases and parallel execution.

**Best for:**
- Complex workflows
- Phase transitions
- Multi-step processes
- Team coordination

**Example:**
```bash
/flow-deploy-to-production
/flow-security-review
/flow-inception-to-elaboration
```

**Sections:**
- Usage
- Arguments
- Options
- Workflow Phases
- Agent Coordination
- Artifacts Generated
- Success Criteria
- Examples

## Platform Support

| Platform | Directory | Format | Extension |
|----------|-----------|--------|-----------|
| Claude | `.claude/commands` | Markdown | `.md` |
| Factory | `.factory/commands` | Markdown | `.md` |
| Cursor | `.cursor/commands` | JSON | `.json` |
| Codex | `.codex/commands` | Markdown | `.md` |
| Copilot | `.github/agents` | Markdown | `.md` |
| Devin Desktop | `.windsurf/workflows` | Markdown | `.md` |
| Generic | `commands` | Markdown | `.md` |

## API Reference

### generateCommand(options)

Generate a command without deploying.

```typescript
const command = await generateCommand({
  name: 'my-command',
  description: 'What it does',
  template: 'utility',
  platform: 'claude',
  projectPath: '/path/to/project',
  args: [
    { name: 'input', description: 'Input file', required: true },
  ],
  options: [
    { name: 'format', description: 'Output format', type: 'string', default: 'json' },
  ],
});
```

**Returns:** `GeneratedCommand`

### deployCommand(command, options)

Deploy a generated command to filesystem.

```typescript
const result = await deployCommand(command, {
  force: false,   // Overwrite existing file
  backup: true,   // Backup existing file before overwrite
});
```

**Returns:** `CommandDeploymentResult`

### generateAndDeploy(options, deployOptions)

Generate and deploy in one step.

```typescript
const result = await generateAndDeploy(
  {
    name: 'my-command',
    description: 'What it does',
    template: 'utility',
    platform: 'claude',
    projectPath: '/path/to/project',
  },
  { backup: true }
);
```

**Returns:** `CommandDeploymentResult`

### validateCommand(command)

Validate a generated command.

```typescript
const validation = validateCommand(command);

if (!validation.valid) {
  validation.issues.forEach(issue => {
    console.error(`${issue.type}: ${issue.message}`);
  });
}
```

**Returns:** `ValidationResult`

### listCommands(platform, projectPath)

List existing commands in a project.

```typescript
const commands = await listCommands('claude', '/path/to/project');
console.log(commands); // ['deploy-all', 'lint-check', ...]
```

**Returns:** `string[]`

## Platform Utilities

### getCommandsDirectory(platform, projectPath)

Get the commands directory for a platform.

```typescript
import { getCommandsDirectory } from './smiths/platform-paths.js';

const dir = getCommandsDirectory('claude', '/path/to/project');
// Returns: /path/to/project/.claude/commands
```

### getPlatformDirectories(platform, projectPath)

Get all platform-specific directories.

```typescript
import { getPlatformDirectories } from './smiths/platform-paths.js';

const dirs = getPlatformDirectories('claude', '/path/to/project');
// Returns:
// {
//   agents: '/path/to/project/.claude/agents',
//   commands: '/path/to/project/.claude/commands',
//   skills: '/path/to/project/.claude/skills',
//   rules: '/path/to/project/.claude/rules',
//   extension: '.md',
//   config: '/path/to/project/CLAUDE.md',
//   aggregated: false,
// }
```

## Command Naming

Commands must follow kebab-case naming:

**Valid:**
- `my-command`
- `deploy-all`
- `flow-security-review`
- `lint-check`

**Invalid:**
- `MyCommand` (PascalCase)
- `my_command` (snake_case)
- `myCommand` (camelCase)
- `-my-command` (starts with hyphen)
- `my-command-` (ends with hyphen)
- `my--command` (consecutive hyphens)

## Command Frontmatter

All commands (except Cursor) include YAML frontmatter:

```yaml
---
name: my-command
description: What the command does
args: <required-arg> [optional-arg] [--option value] [--interactive] [--guidance "text"]
---
```

**Standard options** (always included):
- `--interactive` - Enable interactive mode with guided questions
- `--guidance` - Provide strategic guidance for execution

## Cursor JSON Format

Cursor uses JSON instead of Markdown:

```json
{
  "name": "my-command",
  "description": "What the command does",
  "arguments": [
    {
      "name": "input",
      "description": "Input file",
      "required": true,
      "type": "string"
    }
  ],
  "options": [
    {
      "name": "format",
      "description": "Output format",
      "type": "string",
      "default": "json"
    },
    {
      "name": "interactive",
      "description": "Enable interactive mode",
      "type": "boolean",
      "default": false
    },
    {
      "name": "guidance",
      "description": "Strategic guidance",
      "type": "string"
    }
  ],
  "execution": {
    "steps": [
      "Validate inputs",
      "Process request",
      "Generate output",
      "Report status"
    ]
  }
}
```

## Validation

CommandSmith validates:

1. **Name format**: Must be kebab-case
2. **Content**: Cannot be empty
3. **Platform**: Must be valid platform
4. **Standard options**: Warns if missing `--interactive` or `--guidance`

Validation errors prevent deployment. Warnings are informational.

## Examples

### Simple Utility Command

```typescript
import { generateAndDeploy } from './smiths/commandsmith/index.js';

await generateAndDeploy({
  name: 'backup-config',
  description: 'Backup project configuration files',
  template: 'utility',
  platform: 'claude',
  projectPath: process.cwd(),
  args: [
    { name: 'destination', description: 'Backup location', required: false, default: './backups' },
  ],
});
```

### Transformation Pipeline

```typescript
await generateAndDeploy({
  name: 'convert-docs',
  description: 'Convert documentation from Markdown to HTML',
  template: 'transformation',
  platform: 'claude',
  projectPath: process.cwd(),
  args: [
    { name: 'input', description: 'Input directory', required: true },
    { name: 'output', description: 'Output directory', required: true },
  ],
  options: [
    { name: 'theme', description: 'HTML theme', type: 'string', default: 'default' },
    { name: 'minify', description: 'Minify output', type: 'boolean', default: false },
  ],
});
```

### Orchestration Workflow

```typescript
await generateAndDeploy({
  name: 'flow-security-audit',
  description: 'Execute comprehensive security audit workflow',
  template: 'orchestration',
  platform: 'claude',
  projectPath: process.cwd(),
  args: [
    { name: 'scope', description: 'Audit scope', required: true },
  ],
  options: [
    { name: 'severity', description: 'Minimum severity level', type: 'string', default: 'medium' },
  ],
  guidance: 'Focus on OWASP Top 10 and supply chain security',
});
```

### Multi-Platform Deployment

```typescript
const platforms = ['claude', 'factory', 'cursor'];

for (const platform of platforms) {
  await generateAndDeploy({
    name: 'lint-all',
    description: 'Run all linters on the codebase',
    template: 'utility',
    platform: platform as any,
    projectPath: process.cwd(),
  });
}
```

## Integration with SDLC Framework

CommandSmith is designed to work with the AIWG SDLC framework:

1. **Flow commands**: Generate orchestration commands for phase transitions
2. **Agent coordination**: Commands specify Primary Author, Reviewers, Synthesizer
3. **Artifact management**: Commands define artifacts to generate and where to store
4. **Traceability**: Commands support @-mention wiring for requirements tracking

See `.claude/rules/sdlc-orchestration.md` for orchestration patterns.

## Related

- **AgentSmith**: Generate platform-aware agents
- **SkillSmith**: Generate platform-aware skills
- **Platform Paths**: Shared utilities for platform directory resolution

## License

Part of the AIWG project.
