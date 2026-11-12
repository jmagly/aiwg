#!/usr/bin/env node
// Optional namespace-host probe: synthetic shell attacks followed by real local MCP delivery.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildConductorArgs } from '../ralph-external/lib/conductor-isolation.mjs';
import { buildSystemdClientEnv, resolveSystemdRun } from '../ralph-external/lib/systemd-client.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { probeVerificationIsolationCapabilities } from '../ralph-external/lib/verification-isolation.mjs';

if (process.env.AIWG_LIVE_CONDUCTOR_PROBE !== '1') {
  console.log('SKIP: set AIWG_LIVE_CONDUCTOR_PROBE=1 on a namespace-enabled host');
  process.exit(0);
}
const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-live-'));
const project = path.join(scratch, 'project');
const control = path.join(project, 'control');
const deliver = path.join(control, 'deliver');
const worker = path.join(project, 'worker');
const run = path.join(project, 'run');
const clients = path.join(scratch, 'clients');
const home = path.join(scratch, 'home');
const repo = path.resolve(import.meta.dirname, '../..');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
let service;
try {
  for (const directory of [project, control, deliver, worker, run, clients, home, path.join(clients, 'proc'), path.join(project, '.aiwg')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Probe HOME is synthetic; preserve the operator's manager connection only outside the unit.
  writeFileSync(path.join(home, 'home-read-sentinel'), 'must be hidden');
  process.env.HOME = home;
  process.env.CI = '1';
  process.env.AIWG_EFFECT_LEDGER_TEST_KEY = '42'.repeat(32);
  process.env.AIWG_RESOLVE_IMPL_FROM = 'dist';
  const capabilities = probeVerificationIsolationCapabilities({ force: true });
  if (capabilities.mode !== 'systemd-unit' || ['writeConfinement', 'homeReadIsolation', 'tmpIsolation', 'networkIsolation'].some(name => capabilities[name] !== 'enforced')) {
    console.log('SKIP: host does not enforce required user-unit namespaces');
  } else {
    const artifact = path.join(worker, 'final.txt');
    const destination = path.join(deliver, 'answer.txt');
    writeFileSync(artifact, 'accepted-probe-bytes');
    writeFileSync(destination, 'original');
    const record = (name, value) => writeFileSync(path.join(run, name), JSON.stringify(value), { mode: 0o600 });
    writeFileSync(path.join(run, '.launch-owner'), 'probe-1', { mode: 0o600 });
    record('invocation.json', { origin: 'launcher', invocationId: 'probe-1', worktree: { path: worker }, paths: { final: artifact } });
    record('exit.json', { invocationId: 'probe-1', termination: 'confirmed' });
    // Only installed qualification input is synthetic. systemd, verification and
    // publication are real; no model CLI, credential home or paid call is used.
    copyFileSync(path.join(repo, 'test/fixtures/ralph-external/verification-inputs.mjs'), path.join(clients, 'inputs.mjs'));
    writeFileSync(path.join(clients, 'qualified-roots.json'), JSON.stringify([worker]));
    await import(pathToFileURL(path.join(clients, 'inputs.mjs')).href);
    process.chdir(project);
    process.env.AIWG_CONDUCTOR_PROBE_TOKEN = 'synthetic-conductor-probe-token';
    const { startHttpServer } = await importImpl(import.meta.url, 'mcp/http-transport.mjs');
    service = await startHttpServer({ projectDir: project, port: 0, toolsets: 'workers', tools: ['worker-verify-deliver'], tokenEnv: 'AIWG_CONDUCTOR_PROBE_TOKEN' });
    const url = `http://127.0.0.1:${service.listener.address().port}/mcp`;
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'conductor-probe', version: '1' } } };
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worker-verify-deliver', arguments: { run_dir: run, artifact_path: artifact, deliverable_path: destination, checks: [{ id: 'shell-check', command: '/bin/sh', args: ['-c', ':'] }] } } };
    writeFileSync(path.join(control, 'initialize.json'), JSON.stringify(initialize));
    writeFileSync(path.join(control, 'call.json'), JSON.stringify(call));
    const script = path.join(control, 'probe.sh');
    writeFileSync(script, `#!/bin/sh
set -eu
deny() { if "$@" >/dev/null 2>&1; then echo "FAIL: write succeeded: $1" >&2; exit 1; fi; }
deny /bin/sh -c 'echo attack > "$1"' sh ${quote(destination)}
printf attack > ${quote(path.join(control, 'attack'))}
deny cp ${quote(path.join(control, 'attack'))} ${quote(destination)}
deny /usr/bin/python3 -c 'import sys; open(sys.argv[1], "w").write("attack")' ${quote(destination)}
deny ${quote(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], "attack")' ${quote(destination)}
deny mv ${quote(path.join(control, 'attack'))} ${quote(destination)}
deny ${quote(resolveSystemdRun())} --user --pipe --wait /bin/sh -c 'echo attack > "$1"' sh ${quote(destination)}
[ "$(cat ${quote(destination)})" = original ]
# Bearer material travels on stdin, never curl's argv.
post() {
  printf 'header = "Authorization: Bearer %s"\\n' "$AIWG_CONDUCTOR_PROBE_TOKEN" |
    curl --fail --silent --show-error --max-time 120 --config - -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@" ${quote(url)}
}
post -D ${quote(path.join(control, 'headers'))} --data-binary @${quote(path.join(control, 'initialize.json'))} > /dev/null
session=$(sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii][Dd]: *//p' ${quote(path.join(control, 'headers'))} | tr -d '\\r')
[ -n "$session" ]
post -H "Mcp-Session-Id: $session" --data-binary @${quote(path.join(control, 'call.json'))} > ${quote(path.join(control, 'result'))}
[ "$(cat ${quote(destination)})" = accepted-probe-bytes ]
echo 'PASS: shell/cp/python/node/mv/manager writes blocked; MCP delivered'
`, { mode: 0o700 });
    const args = buildConductorArgs({ conductorRoot: control, binds: [], deliverables: [deliver], envNames: ['AIWG_CONDUCTOR_PROBE_TOKEN'], command: ['/bin/sh', script] });
    const child = spawn(resolveSystemdRun(), args, { stdio: 'inherit', env: buildSystemdClientEnv({ envNames: ['AIWG_CONDUCTOR_PROBE_TOKEN'] }) });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (exit !== 0 || readFileSync(destination, 'utf8') !== 'accepted-probe-bytes') throw new Error(`Conductor probe failed (${exit})`);
  }
} finally {
  await service?.close();
  process.chdir(repo);
  rmSync(scratch, { recursive: true, force: true });
}
