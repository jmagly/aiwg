# AgentSmith

Custom agent generation with platform-aware deployment following the 10 Golden Rules.

## Overview

AgentSmith generates custom agents that follow best practices from the Agent Design Bible and automatically deploys them to platform-specific locations with proper format transformations.

## Features

- **Template-based generation**: Simple, Complex, Orchestrator, Validator
- **10 Golden Rules compliance**: Automatic adherence to agent design principles
- **Platform-aware deployment**: Transforms agents for Claude, Cursor, Codex, Factory, Windsurf, etc.
- **Model tier selection**: Auto-selects appropriate model based on template
- **Tool constraints**: Enforces minimal tool usage (0-3 tools max)
- **Interactive mode**: Guided agent creation via prompts

## Templates

| Template | Model | Tools | Use Case |
|----------|-------|-------|----------|
| `simple` | haiku | Read, Write | Single-purpose, focused tasks |
| `complex` | sonnet | Read, Write, Grep | Analysis and decision-making |
| `orchestrator` | opus | Task | Delegation and coordination (Task tool only) |
| `validator` | sonnet | Read, Grep | Quality checks (read-only) |

## Usage

### Basic Generation

```typescript
import { AgentGenerator } from './smiths/agentsmith/index.js';

const generator = new AgentGenerator();

const agent = await generator.generateAgent({
  name: 'security-scanner',
  description: 'Scans code for security vulnerabilities',
  template: 'validator',
  platform: 'claude',
  projectPath: '/path/to/project',
  guidance: 'Expert in OWASP Top 10, SQL injection, XSS. Must flag high-risk patterns.',
});

// Deploy to .claude/agents/
await generator.deployAgent(agent);
```

### Custom Tools

```typescript
const agent = await generator.generateAgent({
  name: 'api-documenter',
  description: 'Generates API documentation from code',
  template: 'simple',
  platform: 'cursor',
  projectPath: '/path/to/project',
  tools: ['Read', 'Write'], // Override template defaults
  guidance: 'Parse function signatures, extract JSDoc comments, generate OpenAPI specs.',
});
```

### Dry Run

```typescript
const agent = await generator.generateAgent({
  name: 'test-agent',
  description: 'Test agent',
  platform: 'claude',
  projectPath: '/path/to/project',
  dryRun: true, // Preview without writing files
});

console.log(agent.content); // See generated content
console.log(agent.path);    // See where it would be deployed
```

### List Templates

```typescript
const templates = generator.listTemplates();

for (const { name, config } of templates) {
  console.log(`${name}: ${config.description}`);
  console.log(`  Model: ${config.modelTier}`);
  console.log(`  Tools: ${config.tools.join(', ')}`);
  console.log(`  Max Tools: ${config.maxTools}`);
}
```

## 10 Golden Rules

AgentSmith automatically enforces:

1. **Single Responsibility**: Focuses responsibilities (max 5)
2. **Minimal Tools**: 0-3 tools based on template
3. **Explicit I/O**: Generates clear input/output specs
4. **Grounding**: Includes verification steps
5. **Uncertainty**: Adds escalation workflow
6. **Context Scope**: Defines scope boundaries
7. **Recovery**: Includes error handling
8. **Model Tier**: Selects appropriate model
9. **Parallel Ready**: Safe for concurrent execution
10. **Observable**: Traceable output format

## Platform Transformations

AgentSmith automatically transforms agents for each platform:

### Claude (.md with YAML frontmatter)

```markdown
---
name: agent-name
description: Agent description
model: haiku
model-role: efficiency
model-tier: economy
tools: Read, Write
---

# Agent Title

[Content]
```

### Cursor (JSON)

```json
{
  "name": "agent-name",
  "description": "Agent description",
  "prompt": "[Content]",
  "tools": ["read", "write"],
  "model": "auto",
  "modelRole": "efficiency",
  "modelTier": "economy"
}
```

### Codex (standalone TOML custom agent)

```toml
name = "agent-name"
description = "Agent description"
developer_instructions = "[Content]"
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
```

### Windsurf (Plain markdown)

```markdown
### agent-name

> Agent description

<capabilities>
- Read
- Write
</capabilities>

**Model**: sonnet

[Content]
```

## Guidance Format

The `guidance` parameter accepts natural language. AgentSmith extracts:

- **Expertise**: "expert in X", "knowledge of Y", "understands Z"
- **Responsibilities**: "must X", "should Y", "responsible for Z"
- **Examples**: "example: X"
- **Output format**: "output format: X"

Example:

```typescript
guidance: `
  Expert in GraphQL schema design and REST API conventions.
  Must validate endpoint naming, parameter types, and response structures.
  Should flag inconsistencies with OpenAPI 3.0 spec.
  Example: GET /users/:id should return 200 with user object.
  Output format: List of violations with severity and line numbers.
`
```

## Deployment Paths

| Platform | Default Path |
|----------|--------------|
| claude | `.claude/agents/` |
| cursor | `.cursor/agents/` |
| codex | `.codex/agents/` |
| copilot | `.github/agents/` |
| factory | `.factory/droids/` |
| generic | `agents/` |
| windsurf | `.windsurf/agents/` |

## Error Handling

AgentSmith validates:

- Agent name must be kebab-case
- Description must be at least 10 characters
- Custom tools cannot exceed template max (Golden Rule #2)
- Platform must be valid
- Project path must exist

## Integration with Model Selection

AgentSmith uses model tiers (haiku, sonnet, opus) which map to actual models via the enhanced model selection system. Users can override:

```typescript
const agent = await generator.generateAgent({
  name: 'my-agent',
  description: 'Custom agent',
  template: 'simple',  // Default: haiku
  model: 'sonnet',     // Override: use sonnet instead
  platform: 'claude',
  projectPath: '/path/to/project',
});
```

## Examples

### Security Validator

```typescript
const securityAgent = await generator.generateAgent({
  name: 'security-validator',
  description: 'Validates code security practices',
  template: 'validator',
  platform: 'claude',
  projectPath: '/my/project',
  category: 'security',
  version: '1.0.0',
  guidance: `
    Expert in OWASP Top 10, secure coding practices, and common vulnerabilities.
    Must scan for SQL injection, XSS, CSRF, insecure deserialization.
    Should flag hardcoded secrets, weak crypto, and unsafe dependencies.
    Example: Detect "SELECT * FROM users WHERE id=" + userId as SQL injection risk.
    Output format: JSON report with severity (critical/high/medium/low), file, line, description.
  `,
});
```

### Test Orchestrator

```typescript
const testOrchestrator = await generator.generateAgent({
  name: 'test-orchestrator',
  description: 'Coordinates comprehensive test suite execution',
  template: 'orchestrator',
  platform: 'factory',
  projectPath: '/my/project',
  category: 'testing',
  guidance: `
    Expert in test strategy and parallel test execution.
    Must delegate to unit-test-runner, integration-test-runner, e2e-test-runner agents.
    Should synthesize coverage reports and failure summaries.
    Output format: Aggregated test results with pass/fail counts and coverage percentages.
  `,
});
```

### Documentation Generator

```typescript
const docAgent = await generator.generateAgent({
  name: 'api-doc-generator',
  description: 'Generates API documentation from source code',
  template: 'complex',
  platform: 'cursor',
  projectPath: '/my/project',
  tools: ['Read', 'Write', 'Grep'],
  category: 'documentation',
  guidance: `
    Expert in JSDoc, TypeScript, and OpenAPI specification.
    Must parse function signatures, extract type information, generate markdown docs.
    Should include examples from test files.
    Output format: Markdown files with sections for endpoints, parameters, responses, examples.
  `,
});
```

## API Reference

### `AgentGenerator`

#### `generateAgent(options: AgentOptions): Promise<GeneratedAgent>`

Generates an agent following the 10 Golden Rules.

**Parameters:**

- `options.name` (string, required): Kebab-case agent name
- `options.description` (string, required): Agent description (min 10 chars)
- `options.template` (AgentTemplate, optional): Template type (default: 'simple')
- `options.platform` (Platform, required): Target platform
- `options.projectPath` (string, required): Project root path
- `options.guidance` (string, optional): Natural language guidance
- `options.interactive` (boolean, optional): Enable interactive mode
- `options.model` (ModelTier, optional): Override template model tier
- `options.tools` (string[], optional): Override template tools
- `options.dryRun` (boolean, optional): Preview without writing
- `options.category` (string, optional): Agent category
- `options.version` (string, optional): Agent version

**Returns:** `GeneratedAgent` with name, path, content, platform, model, tools

#### `deployAgent(agent: GeneratedAgent): Promise<void>`

Deploys a generated agent to its target path.

#### `getTemplateConfig(template: AgentTemplate): TemplateConfig`

Retrieves configuration for a template.

#### `listTemplates(): Array<{ name: AgentTemplate; config: TemplateConfig }>`

Lists all available templates with their configurations.

## See Also

- [10 Golden Rules](../../docs/agent-design-bible.md) - Agent design principles
- [Agent Packager](../../agents/agent-packager.ts) - Platform transformations
- [Agent Deployer](../../agents/agent-deployer.ts) - Deployment engine
