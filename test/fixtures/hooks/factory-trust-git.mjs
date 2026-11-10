#!/usr/bin/env node
// Offline git fixture for Factory's bounded HEAD prerequisite probe.
import { readFileSync } from 'node:fs';

const ref = process.argv[4];
if (process.argv[2] !== 'rev-parse' || process.argv[3] !== '--verify'
  || !['HEAD', 'HEAD^{commit}'].includes(ref) || process.argv.length !== 5) process.exit(2);
let head;
try { head = readFileSync('.fixture-head', 'utf8'); } catch { process.exit(128); }
if (head === 'hang') setTimeout(() => process.exit(1), 60000);
else if (head === 'present' || (head === 'non-commit' && ref === 'HEAD')) process.stdout.write('0123456789abcdef0123456789abcdef01234567\n');
else process.exit(128);
