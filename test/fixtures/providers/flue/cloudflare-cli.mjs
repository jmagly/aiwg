#!/usr/bin/env node
// Offline fake for Wrangler and cloudflared; never opens a socket or writes secret input.
import fs from 'node:fs';
const args = process.argv.slice(2);
const trace = value => fs.appendFileSync(process.env.FAKE_CF_TRACE, value + '\n');
if (args[0] === '--version') console.log('cloudflared synthetic-test');
else if (args[0] === 'tunnel') {
  trace(`tunnel ${process.pid}`);
  process.on('SIGTERM', () => { trace('tunnel stopped'); process.exit(0); });
  console.error('https://synthetic-check.trycloudflare.com');
  setInterval(() => {}, 1000);
} else if (args[0] === 'deploy') {
  trace('deploy ' + args.join(' '));
  if (process.env.FAKE_CF_MODE === 'wait') setInterval(() => {}, 1000);
  else if (process.env.FAKE_CF_MODE === 'deploy-fail') {
    console.error('synthetic upload failure ' + process.env.CLOUDFLARE_API_TOKEN);
    process.exitCode = 1;
  } else console.log(`https://${args[args.indexOf('--name') + 1]}.synthetic.workers.dev`);
} else if (args[0] === 'delete') {
  trace('delete ' + args.join(' '));
  if (process.env.FAKE_CF_MODE === 'delete-fail') process.exitCode = 1;
} else if (args[0] === 'secret') {
  let input = '';
  for await (const bytes of process.stdin) input += bytes;
  trace(`secret ${args[2]} stdin=${Boolean(input.trim())}`);
  // Exercise output redaction, including secrets split across stream chunks.
  process.stdout.write(input.slice(0, 4));
  setTimeout(() => { process.stdout.write(input.slice(4)); }, 5);
} else { console.error('unexpected fake CLI arguments'); process.exitCode = 2; }
