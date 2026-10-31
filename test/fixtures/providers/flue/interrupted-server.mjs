// Fake MCP effect: persist the artifact, then pause before acknowledging it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const server = new Server({ name: 'interrupted-effect', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'artifact-write') throw new Error('Only synthetic artifact-write supported');
  const { path: relative, content } = request.params.arguments;
  if (relative !== 'effect.md') throw new Error('Fixture path must be effect.md');
  await writeFile(path.resolve('effect.md'), content);
  await appendFile(path.resolve('effect-count.txt'), 'effect\n');
  await writeFile(path.resolve('entered-tool'), 'ready');
  // Cancellation closes this owned child. No model, network or other effects.
  await new Promise(() => {});
});
await server.connect(new StdioServerTransport());
