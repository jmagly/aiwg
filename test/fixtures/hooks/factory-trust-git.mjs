#!/usr/bin/env node
// Offline git fixture for Factory's bounded HEAD prerequisite probe.
import { readFileSync } from 'node:fs';

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['rev-parse', '--verify', 'HEAD'])) process.exit(2);
let head;
try { head = readFileSync('.fixture-head', 'utf8'); } catch { process.exit(128); }
if (head === 'hang') setTimeout(() => process.exit(1), 60000);
else if (head === 'present') process.stdout.write('0123456789abcdef0123456789abcdef01234567\n');
else process.exit(128);
