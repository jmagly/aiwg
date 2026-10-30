// Keep a spawned MCP child alive without ever answering initialize, even on EOF.
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
