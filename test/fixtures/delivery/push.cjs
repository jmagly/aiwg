// Synthetic transport records only its inputs and pushes into the fixture's local bare repository.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.dirname(__filename);
fs.appendFileSync(path.join(root, 'push-log'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\n');
execFileSync('git', ['push', 'origin', ...process.argv.slice(2)], { stdio: 'pipe' });
