#!/usr/bin/env node
// Offline Codex version probe fixture; never starts a session or reads credentials.
if (process.argv[2] !== '--version') process.exit(2);
if (process.env.AIWG_TEST_CODEX_VERSION === 'fail') process.exit(1);
process.stdout.write(process.env.AIWG_TEST_CODEX_VERSION || 'codex-cli 0.169.0\n');
