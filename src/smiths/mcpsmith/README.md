# MCPsmith - MCP Server Generator

MCPsmith generates Model Context Protocol (MCP) servers from various sources, making it easy to expose any CLI tool, REST API, or custom functionality as MCP tools.

## Phase 1 Implementation Status

Phase 1 (Foundation) is complete with the following components:

- **Directory Structure**: `.aiwg/smiths/mcpsmith/` created with `servers/`, `templates/`, and `analyzers/` subdirectories
- **TypeScript Types**: Complete type definitions in `src/smiths/mcpsmith/types.ts`
- **CLI Analyzer**: Parses `--help` output to extract tool definitions (`src/smiths/mcpsmith/analyzers/cli-analyzer.ts`)
- **Server Template**: MCP server boilerplate with security controls (`.aiwg/smiths/mcpsmith/templates/server-template.mjs`)
- **Server Generator**: Generates complete MCP servers from analyzer results (`src/smiths/mcpsmith/generator.ts`)
- **Registry**: Empty registry initialized at `.aiwg/smiths/mcpsmith/registry.json`
- **Tests**: Unit tests for CLI analyzer (`test/unit/smiths/mcpsmith/cli-analyzer.test.ts`)

## Architecture

See architecture documentation:
- `@docs/smithing/mcpsmith.md` - Complete architecture specification
- `@docs/smithing/mcpsmith.md` - Architecture decision record
- `@.aiwg/planning/smiths-implementation-roadmap.md` - Implementation roadmap

## Usage Example

```typescript
import { analyzeCLI } from './analyzers/cli-analyzer.js';
import { generateServer } from './generator.js';

// Step 1: Analyze CLI tool
const result = await analyzeCLI({
  command: 'git',
  includeSubcommands: true,
  timeout: 5000
});

// Step 2: Generate MCP server
const server = await generateServer({
  serverId: 'git',
  serverName: 'Git CLI MCP Server',
  description: 'Exposes git commands as MCP tools',
  analyzerResult: result,
  config: {
    tools: {
      allowlist: ['status', 'log', 'diff'],
      denylist: ['push', 'force']
    }
  },
  outputDir: '.aiwg/smiths/mcpsmith/servers'
});

console.log(`Server generated at: ${server.path}`);
```

## Running the Example

```bash
# Run the example script
npx tsx src/smiths/mcpsmith/example.ts
```

This will:
1. Analyze the `git` command
2. Generate a complete MCP server in `.aiwg/smiths/mcpsmith/servers/git/`
3. Update the registry
4. Display usage instructions

## Directory Structure

```
.aiwg/smiths/mcpsmith/
├── registry.json              # Server registry
├── servers/                   # Generated servers
│   └── {server-id}/
│       ├── server.mjs         # MCP server entry point
│       ├── manifest.json      # Server metadata
│       ├── config.json        # Runtime configuration
│       ├── .mcpsmith          # Generation marker
│       └── tools/             # Tool definitions
│           └── {tool}.json
├── templates/                 # Generation templates
│   └── server-template.mjs    # Base server template
└── analyzers/                 # Analyzer configurations (future)
```

## Generated Server Structure

Each generated server includes:

- **server.mjs**: Executable MCP server with stdio transport
- **config.json**: Runtime configuration including security settings
- **manifest.json**: Server metadata and capabilities
- **tools/*.json**: Individual tool definitions with schemas
- **.mcpsmith**: Marker file indicating MCPsmith-generated server

## Security Features

All generated servers include:

- **Sandboxed Execution**: Commands run with restricted permissions
- **Command Allowlisting**: Only explicitly allowed commands execute
- **Path Validation**: Working directory must be in allowed paths
- **Input Sanitization**: Protection against path traversal and command injection
- **Timeout Limits**: All operations have configurable timeouts
- **Dangerous Command Blocking**: High-risk operations blocked by default

## Testing

Run the test suite:

```bash
# Run all MCPsmith tests
npm test -- test/unit/smiths/mcpsmith/

# Run specific test file
npm test -- test/unit/smiths/mcpsmith/cli-analyzer.test.ts
```

## Type Checking

```bash
# Type check all MCPsmith code
npx tsc --noEmit src/smiths/mcpsmith/*.ts
```

## Next Steps (Phase 2)

- API Analyzer for OpenAPI/Swagger specs
- Catalog Analyzer for YAML/JSON tool catalogs
- Natural Language Analyzer for generating from descriptions
- Interactive tool selection UI
- `aiwg smith` CLI commands

## References

- MCP Specification: https://modelcontextprotocol.io/specification/2025-11-25
- Existing AIWG MCP Server: `@src/mcp/server.mjs`
- Templates: `@agentic/code/frameworks/sdlc-complete/templates/`
