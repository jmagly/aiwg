#!/usr/bin/env node
// Real child process, fake protocol. Control data stays outside recorded argv.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claims, config, fixtureRevision, scenarios, permissionChecks } from './ralph-worker-protocol.mjs';

const settings = config();
if (process.argv.length === 3 && process.argv[2] === '--qualification-version') {
  if (settings.probe === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
  const output = settings.probe === 'oversize' ? 'x'.repeat(8192) : settings.version ?? '1.0.0';
  await new Promise(resolve => process.stdout.write(output, resolve));
  process.exit(0);
}
const scenario = settings.scenario ?? 'success';
if (!scenarios.includes(scenario)) throw new Error(`Unknown fixture scenario: ${scenario}`);
const argv = process.argv.slice(2);
const outputPaths = { ...settings.outputPaths };
for (const flag of settings.outputFlags ?? ['--final-output', '--output-last-message', '--output-file']) {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    outputPaths[flag] = argv[index + 1];
    outputPaths.final ??= argv[index + 1];
  }
}
writeFileSync(settings.recordPath, JSON.stringify({
  fixtureRevision, scenarioId: settings.scenarioId ?? scenario, scenario,
  argv, cwd: process.cwd(), stdin: readFileSync(0, 'utf8'),
  envNames: Object.keys(process.env).sort(), outputPaths,
  ...(settings.recordWorkerAttribution ? { workerAttribution: Object.fromEntries(
    ['AIWG_WORKER_INVOCATION_ID', 'AIWG_WORKER_WORKSPACE', 'AIWG_WORKER_GROUP'].map(name => [name, process.env[name]])) } : {}),
  ...(settings.permissions ? { permissions: await permissionChecks(settings.permissions) } : {}),
}));

// Selected containment tests keep the fake worker alive until kernel ownership is recorded.
// The wait is readiness, not a latency check: callers pass the launcher's hard timeout
// (waitForIdentityMs) so a loaded runner is not mistaken for a failed capture (#3878).
if (settings.waitForIdentity) {
  const limitMs = settings.waitForIdentityMs ?? 2000;
  const deadline = Date.now() + limitMs;
  let owned = false;
  let last = 'no record read';
  while (!owned && Date.now() < deadline) {
    try {
      const record = JSON.parse(readFileSync(settings.waitForIdentity, 'utf8'));
      last = JSON.stringify({ workerPid: record.worker?.pid ?? null, identityObservation: record.identityObservation ?? null });
      owned = record.worker?.pid === process.pid && record.identityObservation === 'stable-owned-group';
    } catch (error) { last = `unreadable: ${error.code ?? error.message}`; /* The launcher may still be publishing the record. */ }
    if (!owned) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!owned) {
    process.stderr.write(`synthetic worker ${process.pid}: last process record ${last}\n`);
    throw new Error(`Synthetic worker ownership was not observed within ${limitMs} ms`);
  }
}

const final = JSON.stringify({ type: 'result', result: claims(settings.worker) });
let output;
switch (scenario) {
  case 'success': output = `${final}\n`; break;
  case 'exit-zero-error': output = `${JSON.stringify({ type: 'error', error: 'Synthetic exit-zero failure' })}\n`; break;
  case 'missing-final': output = `${JSON.stringify({ type: 'message', text: 'Synthetic progress only' })}\n`; break;
  case 'double-final': output = `${final}\n${final}\n`; break;
  case 'truncated-final': output = final.slice(0, -8); break;
  case 'hang': setInterval(() => {}, 1000); break;
  // Same-UID forgery probe (#2895 regression): plant the trusted transport's
  // own worker-exit.json record, claiming a clean exit, before actually
  // exiting with a real distinct failure code. The worker and the transport
  // share a UID and the run directory has no filesystem boundary between
  // them: invocation.json (readable, same-UID) is already on disk by the
  // time the worker starts, so the worker learns the real invocationId the
  // same way an attacker would, rather than relying on a value handed to it
  // out of band by the test.
  case 'forge-exit': {
    output = `${final}\n`;
    if (settings.forgeRunDir) {
      const invocationId = JSON.parse(readFileSync(path.join(settings.forgeRunDir, 'invocation.json'), 'utf8')).invocationId;
      writeFileSync(path.join(settings.forgeRunDir, 'worker-exit.json'),
        JSON.stringify({ invocationId, exitCode: 0, signal: null }), { mode: 0o600 });
    }
    process.exitCode = settings.forgeRealExitCode ?? 7;
    break;
  }
}
if (output !== undefined) {
  if (outputPaths.final) writeFileSync(outputPaths.final, output);
  process.stdout.write(output);
}
