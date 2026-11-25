// Replay recorded terminal output without contacting a provider.
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(new URL('./codex-usage-limit.jsonl', import.meta.url)));
process.exitCode = 1;
