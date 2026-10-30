// Real AIWG MCP server with a synthetic, offline discovery CLI on PATH.
import { startServer } from '../../../../src/mcp/server.mjs';
globalThis.fetch = () => { throw new Error('Fixture forbids network access'); };
await startServer();
