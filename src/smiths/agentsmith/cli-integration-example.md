# AgentSmith CLI Integration Example

This document shows how AgentSmith could be integrated into the AIWG CLI.

## Command Syntax

```bash
# Basic generation
aiwg -generate-agent \
  --name security-scanner \
  --description "Scans code for security vulnerabilities" \
  --template validator \
  --platform claude \
  --category security

# With guidance
aiwg -generate-agent \
  --name api-documenter \
  --description "Generates API documentation" \
  --template simple \
  --platform cursor \
  --guidance "Expert in OpenAPI. Must parse JSDoc. Output: markdown files."

# Custom tools
aiwg -generate-agent \
  --name test-runner \
  --description "Runs test suite" \
  --template simple \
  --platform claude \
  --tools Read,Bash

# Model override
aiwg -generate-agent \
  --name complex-formatter \
  --description "Formats complex code" \
  --template simple \
  --model opus \
  --platform factory

# Dry run
aiwg -generate-agent \
  --name preview-agent \
  --description "Preview generation" \
  --platform claude \
  --dry-run

# Interactive mode
aiwg -generate-agent --interactive
```

## CLI Implementation Pseudocode

```typescript
// src/cli/commands/generate-agent.ts

import { AgentGenerator } from '../../smiths/agentsmith/index.js';
import type { AgentOptions } from '../../smiths/agentsmith/types.js';

export async function generateAgentCommand(args: string[]) {
  // Parse CLI arguments
  const options = parseArguments(args);

  // Interactive mode
  if (options.interactive) {
    const responses = await promptUser();
    Object.assign(options, responses);
  }

  // Validate required options
  if (!options.name || !options.description || !options.platform) {
    console.error('Error: --name, --description, and --platform are required');
    process.exit(1);
  }

  // Set project path to current directory if not specified
  options.projectPath = options.projectPath || process.cwd();

  // Generate agent
  const generator = new AgentGenerator();

  try {
    console.log(`Generating agent: ${options.name}...`);
    const agent = await generator.generateAgent(options as AgentOptions);

    if (options.dryRun) {
      console.log('\n--- Dry Run: Agent Preview ---');
      console.log(`Name: ${agent.name}`);
      console.log(`Platform: ${agent.platform}`);
      console.log(`Model: ${agent.model}`);
      console.log(`Tools: ${agent.tools.join(', ')}`);
      console.log(`Path: ${agent.path}`);
      console.log('\n--- Content Preview (first 500 chars) ---');
      console.log(agent.content.slice(0, 500) + '...\n');
    } else {
      await generator.deployAgent(agent);
      console.log(`✓ Agent deployed successfully!`);
      console.log(`  Path: ${agent.path}`);
      console.log(`  Model: ${agent.model}`);
      console.log(`  Tools: ${agent.tools.join(', ')}`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

function parseArguments(args: string[]): Partial<AgentOptions> {
  const options: Partial<AgentOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--name':
        options.name = args[++i];
        break;
      case '--description':
        options.description = args[++i];
        break;
      case '--template':
        options.template = args[++i] as any;
        break;
      case '--platform':
        options.platform = args[++i] as any;
        break;
      case '--project-path':
        options.projectPath = args[++i];
        break;
      case '--guidance':
        options.guidance = args[++i];
        break;
      case '--model':
        options.model = args[++i] as any;
        break;
      case '--tools':
        options.tools = args[++i].split(',').map(t => t.trim());
        break;
      case '--category':
        options.category = args[++i];
        break;
      case '--version':
        options.version = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--interactive':
        options.interactive = true;
        break;
    }
  }

  return options;
}

async function promptUser(): Promise<Partial<AgentOptions>> {
  // Use readline or inquirer for interactive prompts
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query: string): Promise<string> =>
    new Promise(resolve => readline.question(query, resolve));

  console.log('=== AgentSmith Interactive Mode ===\n');

  const name = await question('Agent name (kebab-case): ');
  const description = await question('Description: ');

  console.log('\nAvailable templates:');
  console.log('  1. simple      - Single-purpose tasks (haiku, Read+Write)');
  console.log('  2. complex     - Analysis tasks (sonnet, Read+Write+Grep)');
  console.log('  3. orchestrator - Coordination (opus, Task only)');
  console.log('  4. validator   - Quality checks (sonnet, Read+Grep, read-only)');
  const templateChoice = await question('Select template (1-4): ');
  const template = ['simple', 'complex', 'orchestrator', 'validator'][
    parseInt(templateChoice) - 1
  ];

  console.log('\nAvailable platforms:');
  console.log('  1. claude    - Claude Code (.claude/agents/)');
  console.log('  2. cursor    - Cursor (.cursor/agents/)');
  console.log('  3. codex     - OpenAI Codex (.codex/agents/)');
  console.log('  4. factory   - Factory AI (.factory/droids/)');
  console.log('  5. windsurf  - Devin Desktop (.windsurf/agents/)');
  const platformChoice = await question('Select platform (1-5): ');
  const platform = ['claude', 'cursor', 'codex', 'factory', 'devin'][
    parseInt(platformChoice) - 1
  ];

  const guidance = await question('Guidance (optional, press Enter to skip): ');

  readline.close();

  return {
    name,
    description,
    template: template as any,
    platform: platform as any,
    guidance: guidance || undefined,
  };
}
```

## Integration with Main CLI

```typescript
// src/cli/index.mjs

import { generateAgentCommand } from './commands/generate-agent.js';

// In the main CLI handler
if (args[0] === '-generate-agent') {
  await generateAgentCommand(args.slice(1));
  process.exit(0);
}
```

## Help Text

```text
aiwg -generate-agent - Generate custom agent with platform-aware deployment

Usage:
  aiwg -generate-agent [options]

Required Options:
  --name <name>              Agent name (kebab-case)
  --description <desc>       Agent description
  --platform <platform>      Target platform (claude|cursor|codex|factory|windsurf)

Optional Options:
  --template <template>      Template type (simple|complex|orchestrator|validator)
                             Default: simple
  --guidance <text>          Natural language guidance for agent generation
  --model <tier>             Model tier override (haiku|sonnet|opus)
  --tools <tool1,tool2>      Custom tool list (comma-separated)
  --category <category>      Agent category
  --version <version>        Agent version
  --project-path <path>      Project root path (default: current directory)
  --dry-run                  Preview without writing files
  --interactive              Interactive mode with prompts

Templates:
  simple        Single-purpose tasks (haiku, Read+Write, max 2 tools)
  complex       Analysis and decision-making (sonnet, Read+Write+Grep, max 3 tools)
  orchestrator  Multi-agent coordination (opus, Task only, delegation-only)
  validator     Quality checks (sonnet, Read+Grep, read-only, max 2 tools)

Examples:
  # Basic generation
  aiwg -generate-agent \
    --name security-scanner \
    --description "Scans code for vulnerabilities" \
    --template validator \
    --platform claude

  # With guidance
  aiwg -generate-agent \
    --name api-doc-gen \
    --description "Generates API docs" \
    --platform cursor \
    --guidance "Expert in OpenAPI. Must parse JSDoc. Output: markdown."

  # Interactive mode
  aiwg -generate-agent --interactive

  # Dry run preview
  aiwg -generate-agent \
    --name test-agent \
    --description "Test agent" \
    --platform claude \
    --dry-run

See Also:
  aiwg -deploy-agents        Deploy existing agents to platform
  aiwg -list-agents          List available agents
  aiwg -help                 Show all commands
```

## Expected Output

```text
$ aiwg -generate-agent \
  --name security-validator \
  --description "Validates code security" \
  --template validator \
  --platform claude \
  --category security \
  --guidance "Expert in OWASP Top 10. Must flag SQL injection, XSS."

Generating agent: security-validator...
✓ Agent deployed successfully!
  Path: /path/to/project/.claude/agents/security-validator.md
  Model: sonnet
  Tools: Read, Grep

Agent follows 10 Golden Rules:
  ✓ Single Responsibility
  ✓ Minimal Tools (2)
  ✓ Explicit I/O
  ✓ Grounding
  ✓ Uncertainty Handling
  ✓ Context Scope
  ✓ Recovery
  ✓ Model Tier (sonnet)
  ✓ Parallel Ready
  ✓ Observable
```

## Integration Checklist

- [ ] Add `generate-agent` command to CLI router
- [ ] Implement `parseArguments()` function
- [ ] Add interactive mode with prompts
- [ ] Update help text in main CLI
- [ ] Add validation for required options
- [ ] Add template listing helper
- [ ] Add platform listing helper
- [ ] Add examples to documentation
- [ ] Update `aiwg -help` output
- [ ] Add to CLI test suite
