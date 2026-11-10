#!/usr/bin/env node
// Factory qualification fixture refuses every operation except a version probe.
import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify(process.argv.slice(2)) + '\n');
if (process.argv.slice(2).join(' ') !== '--version') process.exit(90);
console.log('1.0.0');
