#!/usr/bin/env node
/**
 * Synthetic stand-in for `opencode` 1.19/2.0.26 `run` (roctinam/aiwg#2904).
 * It implements only the help-evidenced surface used by the version-bound
 * direct-shell profile:
 *
 *   opencode run --format json -m M -f F "Follow the instructions in the
 *     attached file exactly."
 *   opencode --version | --help
 *
 * Stdin is confirmed unsupported (conductor disassembly of the installed
 * v2.0.26 binary found no stdin/isTTY handling in the `run` chunk), so the
 * brief rides on `-f`/`--file` as a path; this fixture requires `-f` and
 * rejects any positional message other than the fixed instruction above —
 * a regression that puts brief text back on argv must fail this fixture.
 *
 * No network, model, credential or real OpenCode code is involved. The
 * scenario and record path come from the JSON file named by
 * AIWG_FAKE_WORKER_CONFIG ({ scenario, recordPath, ... }); without it the
 * success scenario runs and nothing is recorded. The JSONL event shape on
 * stdout (`step_start`/`text`/`step_finish`, `sessionID` plus a `part`
 * object; test/fixtures/providers/opencode/health/stream.ndjson, #2896) is
 * synthetic and exercises the adapter's evidenced grammar only; it never
 * qualifies a live run.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION = 'opencode-fixture-session';

const config = process.env.AIWG_FAKE_WORKER_CONFIG
  ? JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8')) : {};
const scenario = config.scenario ?? 'success';
const args = process.argv.slice(2);

let recorded = false;
function record(extra) {
  if (recorded || !config.recordPath) return;
  recorded = true;
  writeFileSync(config.recordPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(), pid: process.pid, ...extra }), { mode: 0o600 });
}

function fail(message, code = 1) {
  record({ error: message });
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

const ROOT_HELP = `DESCRIPTION
  OpenCode command line interface

USAGE
  opencode <subcommand> [flags] [<directory>]

SUBCOMMANDS
  run               Run OpenCode with a message
  serve             Start the v2 API and web server
  mcp               Manage MCP (Model Context Protocol) servers
`;

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(ROOT_HELP);
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write('opencode 2.0.26 (synthetic fixture)\n');
  process.exit(0);
}
// Native worker serving is not advertised on the evidenced CLI: `serve` is
// an HTTP API and `mcp` manages MCP *clients*, neither a worker-serving
// tools/list surface. Any probe here falls back to the root help.
if (args[0] === 'serve' || args[0] === 'mcp') {
  process.stdout.write(ROOT_HELP);
  process.exit(0);
}
if (args[0] !== 'run') fail(`unknown subcommand '${args[0]}'`);

const runArgs = args.slice(1);
if (runArgs[0] === '--help' || runArgs[0] === '-h') {
  process.stdout.write(`USAGE\n  opencode run [flags] [<message...>]\n\nFLAGS\n  --model, -m string\n  --format choice\n  --file, -f string\n  --auto\n`);
  process.exit(0);
}

const FIXED_MESSAGE = 'Follow the instructions in the attached file exactly.';
let format = null;
let model = null;
let variant = null;
let file = null;
let message = null;
for (let i = 0; i < runArgs.length;) {
  const arg = runArgs[i];
  const value = (name) => runArgs[i + 1] ?? fail(`missing value for ${name}`);
  if (arg === '-m' || arg === '--model') { model = value(arg); i += 2; }
  else if (arg === '--variant') {
    if (config.cliVersion?.startsWith('1.') !== true) fail('--variant requires the 1.x fixture');
    variant = value(arg); i += 2;
  }
  else if (arg === '--format') { format = value(arg); i += 2; }
  else if (arg === '-f' || arg === '--file') { file = value(arg); i += 2; }
  else if (arg === '--auto') { fail('--auto is a disallowed permission bypass for this fixture'); }
  else if (!arg.startsWith('-')) {
    if (message !== null) fail('duplicate message argument');
    message = arg; i += 1;
  } else fail(`unknown run flag: ${arg}`);
}
// Stdin is confirmed unsupported; a run with no -f attachment at all has no
// evidenced way to deliver a brief and must fail, same as the real CLI
// would reject an empty, non-interactive run.
if (file === null) fail('no -f/--file attachment provided (stdin is unsupported on this CLI)');
if (message !== FIXED_MESSAGE) {
  // A regression that puts brief text back on the positional argument
  // must fail here, not silently succeed.
  fail(`unexpected positional message (brief content must travel via -f, not argv): ${JSON.stringify(message)}`);
}
let brief;
try { brief = readFileSync(file, 'utf8'); } catch (error) { fail(`cannot read -f attachment ${file}: ${error.message}`); }

record({ model, variant, format, file, message, brief, jsonStream: format === 'json' });

const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const handshake = () => line({ type: 'step_start', sessionID: SESSION, part: {} });
// `complete: false` omits part.time.end, simulating a part whose stream
// never recorded a finish (e.g. a dropped connection mid-text).
const textEvent = (id, text, { complete = true } = {}) => line({ type: 'text', sessionID: SESSION,
  part: { id, sessionID: SESSION, type: 'text', text, time: complete ? { start: 1000, end: 2000 } : { start: 1000 } } });
const finish = (reason = 'stop') => line({ type: 'step_finish', sessionID: SESSION, part: { reason } });

switch (scenario) {
  case 'success': {
    if (format === 'json') {
      handshake();
      textEvent('opencode-fixture-part-1', `synthetic reply (${brief.length} chars)`);
      finish('stop');
    }
    process.exit(0);
    break;
  }
  case 'success-v2': {
    // The real opencode 2.0.26 shape observed live (smoke-opencode.jsonl,
    // #2904 follow-up): a single complete `text` event and NOTHING else —
    // no step_start, no step_finish, no terminal event of any kind. This
    // is the primary success shape this profile must accept.
    if (format === 'json') textEvent('opencode-fixture-part-1', `synthetic reply (${brief.length} chars)`);
    process.exit(0);
    break;
  }
  // #2995: a successful stream whose concatenated text is itself a valid
  // strict workerClaims JSON document, for parseWorkerFinal coverage.
  case 'claims-final': {
    if (format === 'json') {
      handshake();
      textEvent('opencode-fixture-part-1', JSON.stringify({ version: 1, status: 'completed',
        summary: 'Synthetic opencode claims', claims: [], artifacts: [], checks: [], limitations: [] }));
      finish('stop');
    }
    process.exit(0);
    break;
  }
  case 'model-not-found':
    fail(`model_not_found: ${model ?? '(no model)'}`);
    break;
  case 'auth-error':
    fail('authentication expired HTTP 401 (login required)');
    break;
  case 'step-error': {
    // A step that ends for a reason other than "stop": the run must fail
    // even though the process exits zero.
    if (format === 'json') {
      handshake();
      textEvent('opencode-fixture-part-1', 'synthetic partial output');
      finish('error');
    }
    process.exit(0);
    break;
  }
  case 'malformed': {
    if (format === 'json') process.stdout.write('{"type":"step_start","sessionID":"opencode-fix');
    process.exit(0);
    break;
  }
  case 'truncated-after-text': {
    // A text part with NO part.time.end: the stream never recorded a
    // finish for it (e.g. a dropped connection mid-text) and there is no
    // step_finish either. Exit 0 must never substitute for a positive
    // completion signal here.
    if (format === 'json') {
      handshake();
      textEvent('opencode-fixture-part-1', 'synthetic reply with no terminal', { complete: false });
    }
    process.exit(0);
    break;
  }
  case 'crash-mid': {
    if (format === 'json') { handshake(); textEvent('opencode-fixture-part-1', 'synthetic partial'); }
    process.exit(1);
    break;
  }
  case 'leaky-error': {
    const leak = config.leakMarker ?? 'leaky-bearer-marker-default';
    process.stderr.write(`Error: bootstrap failed: 401 unauthorized (Bearer ${leak})\n`);
    process.exit(1);
    break;
  }
  case 'hang':
  case 'stdin-wait':
    setInterval(() => {}, 1000);
    break;
  case 'ignore-term':
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  case 'error-loop': {
    handshake();
    setInterval(() => { textEvent('opencode-fixture-part-1', 'synthetic repeated output'); }, 100);
    break;
  }
  default:
    fail(`unknown fixture scenario ${scenario}`, 64);
}
