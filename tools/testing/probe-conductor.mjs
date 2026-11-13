#!/usr/bin/env node
// Optional namespace-host probe: synthetic shell attacks followed by real local MCP delivery.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
// Local copy of the test helper (test/ is not shipped): sealed .captures-* snapshot
// directories are read-only, so restore owner write before removing the synthetic tree.
import { chmodSync, lstatSync, readdirSync, rmSync as removeSync } from 'node:fs';
function rmSync(root, options) {
  const unlock = dir => {
    let stat; try { stat = lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) return;
    if (path.basename(dir).startsWith('.captures-')) chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unlock(path.join(dir, entry.name));
  };
  if (options?.recursive) unlock(root);
  return removeSync(root, options);
}
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
const worker = path.join(project, '.aiwg', 'working', 'worktrees', 'worker');
const clients = path.join(scratch, 'clients');
const home = path.join(scratch, 'home');
const install = path.join(scratch, 'install');
const repo = path.resolve(import.meta.dirname, '../..');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
let service;
try {
  for (const directory of [project, control, deliver, worker, clients, home, install, path.join(clients, 'proc'), path.join(project, '.aiwg')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    writeFileSync(path.join(install, 'read-only-sentinel'), 'readable-install');
    mkdirSync(path.join(worker, '.agents', 'skills'), { recursive: true });
    mkdirSync(path.join(worker, '.codex', 'rules'), { recursive: true });
    writeFileSync(path.join(worker, '.agents', 'skills', 'fixture.md'), 'fixture context');
    writeFileSync(path.join(worker, '.codex', 'rules', 'fixture.md'), 'fixture rules');
    writeFileSync(path.join(worker, 'AGENTS.md'), '<!-- AIWG:rule-startup:start -->\nSynthetic worker rules.\n<!-- AIWG:rule-startup:end -->');
    const fixtureCli = readFileSync(path.join(repo, 'test/fixtures/ralph-external/conductor-worker-cli.mjs'), 'utf8');
    writeFileSync(path.join(project, 'codex'), fixtureCli.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o700 });
    writeFileSync(path.join(project, 'brief.md'), 'Synthetic worker: exercise native isolation and write your tree.');
    writeFileSync(destination, 'original');
    // Only installed qualification input is synthetic. systemd, verification and
    // publication are real; no model CLI, credential home or paid call is used.
    copyFileSync(path.join(repo, 'test/fixtures/ralph-external/verification-inputs.mjs'), path.join(clients, 'inputs.mjs'));
    writeFileSync(path.join(clients, 'qualified-roots.json'), JSON.stringify([worker]));
    await import(pathToFileURL(path.join(clients, 'inputs.mjs')).href);
    process.chdir(project);
    process.env.AIWG_CONDUCTOR_PROBE_TOKEN = 'synthetic-conductor-probe-token';
    process.env.AIWG_CONDUCTOR_PROBE_INPUTS = path.join(repo, 'test/fixtures/ralph-external/conductor-worker-inputs.mjs');
    const { startHttpServer } = await importImpl(import.meta.url, 'mcp/http-transport.mjs');
    service = await startHttpServer({ projectDir: project, port: 0, toolsets: 'workers', tools: ['worker-invoke', 'worker-verify-deliver'], tokenEnv: 'AIWG_CONDUCTOR_PROBE_TOKEN' });
    const url = `http://127.0.0.1:${service.listener.address().port}/mcp`;
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'conductor-probe', version: '1' } } };
    writeFileSync(path.join(control, 'initialize.json'), JSON.stringify(initialize));
    writeFileSync(path.join(control, 'invoke.json'), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'worker-invoke', arguments: { operation: 'run', request_id: 'native-probe', role: 'coding', task: 'implementation',
        group: 'workers', brief: path.join(project, 'brief.md'), workdir: worker, final_output: path.join(worker, 'claims.json'), transport: 'shell' } } }));
    const script = path.join(control, 'probe.sh');
    writeFileSync(script, `#!/bin/sh
set -eu
cat /proc/self/cgroup > ${quote(path.join(control, 'conductor-cgroup'))}
deny() { if "$@" >/dev/null 2>&1; then echo "FAIL: write succeeded: $1" >&2; exit 1; fi; }
[ "$(cat ${quote(path.join(install, 'read-only-sentinel'))})" = readable-install ]
deny /bin/sh -c 'echo attack > "$1"' sh ${quote(path.join(install, 'read-only-sentinel'))}
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
post -H "Mcp-Session-Id: $session" --data-binary @${quote(path.join(control, 'invoke.json'))} > ${quote(path.join(control, 'worker-result'))}
${quote(process.execPath)} -e ${quote(`
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[1], 'utf8');
const response = JSON.parse(text.trim().startsWith('{') ? text : text.split('\\n').find(line => line.startsWith('data:')).slice(5));
const worker = JSON.parse(response.result.content[0].text);
if (worker.status !== 'completed' || !worker.run_dir) throw new Error('MCP launch failed: ' + JSON.stringify(worker));
fs.writeFileSync(process.argv[2], JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
  name: 'worker-verify-deliver', arguments: { run_dir: worker.run_dir, artifact_path: process.argv[3], deliverable_path: process.argv[4],
  checks: [{ id: 'shell-check', command: '/bin/sh', args: ['-c', ':'] }] } } }));
`)} ${quote(path.join(control, 'worker-result'))} ${quote(path.join(control, 'call.json'))} ${quote(artifact)} ${quote(destination)}
post -H "Mcp-Session-Id: $session" --data-binary @${quote(path.join(control, 'call.json'))} > ${quote(path.join(control, 'result'))}
[ "$(cat ${quote(destination)})" = accepted-probe-bytes ]
echo 'PASS: shell/cp/python/node/mv/manager/install writes blocked; MCP invoked worker and delivered'
`, { mode: 0o700 });
    const args = buildConductorArgs({ conductorRoot: control, binds: [], readOnlyBinds: [install], deliverables: [deliver], envNames: ['AIWG_CONDUCTOR_PROBE_TOKEN'], command: ['/bin/sh', script] });
    const child = spawn(resolveSystemdRun(), args, { stdio: 'inherit', env: buildSystemdClientEnv({ envNames: ['AIWG_CONDUCTOR_PROBE_TOKEN'] }) });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (exit !== 0 || readFileSync(destination, 'utf8') !== 'accepted-probe-bytes') throw new Error(`Conductor probe failed (${exit})`);
    const responseText = readFileSync(path.join(control, 'worker-result'), 'utf8');
    const response = JSON.parse(responseText.startsWith('event:') ? responseText.split('\n').find(line => line.startsWith('data:')).slice(5) : responseText);
    const result = JSON.parse(response.result.content[0].text);
    const deliveryText = readFileSync(path.join(control, 'result'), 'utf8');
    const deliveryResponse = JSON.parse(deliveryText.trim().startsWith('{') ? deliveryText : deliveryText.split('\n').find(line => line.startsWith('data:')).slice(5));
    const delivery = JSON.parse(deliveryResponse.result.content[0].text);
    if (delivery.status !== 'accepted' || delivery.deliveryRecord?.phase !== 'completed') throw new Error('MCP verification did not publish a signed delivery record');
    const proof = JSON.parse(readFileSync(path.join(worker, 'worker-proof.json'), 'utf8'));
    if (result.status !== 'completed' || result.termination !== 'confirmed' || result.isolationMode !== 'native-sandbox'
      || proof.cwd !== worker || proof.write !== 'native-worker'
      || proof.cgroup === readFileSync(path.join(control, 'conductor-cgroup'), 'utf8')) throw new Error('MCP worker did not complete with normal native isolation outside the conductor');
    console.log('PASS: external MCP worker completed its native bwrap write and its returned run_dir verified and delivered');
  }
} finally {
  await service?.close();
  process.chdir(repo);
  rmSync(scratch, { recursive: true, force: true });
}
