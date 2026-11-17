#!/usr/bin/env node
// Offline Codex version probe fixture; never starts a session or reads credentials.
// Behaviour comes from a sibling file, because the real probe runs with a cleared
// environment; the variable names it received are recorded for isolation checks.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== '--version') process.exit(2);
const dir = path.dirname(fs.realpathSync(process.argv[1]));
fs.writeFileSync(path.join(dir, 'codex-env-seen.json'), JSON.stringify(Object.keys(process.env).sort()));
let banner = 'codex-cli 0.169.0\n';
try { banner = fs.readFileSync(path.join(dir, 'codex-version.txt'), 'utf8'); } catch { /* default banner */ }
if (banner === 'fail') process.exit(1);
process.stdout.write(banner);
