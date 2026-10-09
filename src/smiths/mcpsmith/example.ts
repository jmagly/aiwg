/**
 * MCPsmith Example Usage
 *
 * Demonstrates how to use MCPsmith to generate MCP servers.
 *
 * @example
 * ```bash
 * node --loader ts-node/esm src/smiths/mcpsmith/example.ts
 * ```
 */

import { analyzeCLI } from './analyzers/cli-analyzer.js';
import { generateServer, updateRegistry } from './generator.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { projectAiwgPath } from '../../config/project-artifacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('MCPsmith Example: Generating Git MCP Server\n');

  // Step 1: Analyze the git CLI tool
  console.log('Step 1: Analyzing git command...');
  const analyzerResult = await analyzeCLI({
    command: 'git',
    includeSubcommands: true,
    maxDepth: 1,
    timeout: 5000
  });

  console.log(`  Found ${analyzerResult.tools.length} tools`);
  console.log(`  Version: ${analyzerResult.metadata.sourceVersion || 'unknown'}`);
  console.log();

  // Step 2: Generate the MCP server
  console.log('Step 2: Generating MCP server...');
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const outputDir = projectAiwgPath(projectRoot, 'smiths', 'mcpsmith', 'servers');

  const generatedServer = await generateServer({
    serverId: 'git',
    serverName: 'Git CLI MCP Server',
    description: 'Exposes git commands as MCP tools',
    analyzerResult,
    config: {
      tools: {
        // Only allow safe git commands
        prefix: 'git',
        allowlist: ['status', 'log', 'diff', 'branch', 'show'],
        denylist: ['push', 'force', 'reset'],
        dangerousCommands: {
          require_confirmation: ['checkout', 'merge'],
          blocked: ['push --force', 'reset --hard', 'clean -fd']
        }
      },
      security: {
        sandboxed: true,
        maxExecutionTime: 30000,
        allowedPaths: [process.cwd()],
        blockedCommands: [],
        requireConfirmation: []
      }
    },
    outputDir
  });

  console.log(`  Server generated at: ${generatedServer.path}`);
  console.log(`  Files created:`);
  console.log(`    - ${path.basename(generatedServer.files.server)}`);
  console.log(`    - ${path.basename(generatedServer.files.config)}`);
  console.log(`    - ${path.basename(generatedServer.files.manifest)}`);
  console.log(`    - ${generatedServer.files.tools.length} tool definitions`);
  console.log();

  // Step 3: Update registry
  console.log('Step 3: Updating registry...');
  const registryPath = path.join(
    path.dirname(outputDir),
    'registry.json'
  );

  const serverEntry = {
    id: 'git',
    name: 'Git CLI MCP Server',
    description: 'Exposes git commands as MCP tools',
    version: '1.0.0',
    source: {
      type: 'cli' as const,
      command: 'git',
      discovery: 'help-parsing'
    },
    status: 'active' as const,
    path: `servers/${generatedServer.id}/`,
    transport: 'stdio' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tools: analyzerResult.tools.map(t => t.name),
    resources: [],
    prompts: [],
    health: {
      status: 'unknown' as const,
      lastCheck: new Date().toISOString()
    }
  };

  await updateRegistry(registryPath, 'git', serverEntry);
  console.log(`  Registry updated at: ${registryPath}`);
  console.log();

  // Step 4: Display usage instructions
  console.log('Step 4: Usage Instructions');
  console.log('  To test the generated server:');
  console.log(`  node ${generatedServer.files.server}`);
  console.log();
  console.log('  To register with Claude Code:');
  console.log('  Add to .mcp.json:');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "git": {');
  console.log('        "command": "node",');
  console.log(`        "args": ["${generatedServer.files.server}"]`);
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log();

  console.log('Example complete!');
}

// Run example if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
