// Exercise installed MCP launch, status and delivery with synthetic qualification and systemd clients.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../../tools/_resolve-impl.mjs';
import { loadWorkerInputs } from './conductor-worker-inputs.mjs';
const [project, runDir, outcome] = process.argv.slice(2);
const work = path.join(project, '.aiwg', 'working', 'worktrees', 'worker');
const tools = new Map();
const { registerWorkerInvokeToolset } = await importImpl(import.meta.url, 'mcp/tools/worker-invoke.mjs');
await registerWorkerInvokeToolset({ registerTool(name, _schema, handler) { tools.set(name, handler); } }, {
  projectRoot: project, ensureWorkerContext: false,
  loadWorkerInputs: () => loadWorkerInputs({ cwd: project }),
  gateInputs: { live: { supported: true, availMemGb: 64, load1: 0.1, cores: 8, loadRatio: 0.05,
    memPsiAvg10: 0, memPsiAvg60: 0, memPsiAvg300: 0, workers: 0, freeDiskGb: 100 } },
});
const decode = response => response.isError ? { isError: true, text: response.content[0].text } : JSON.parse(response.content[0].text);
const run = decode(await tools.get('worker-invoke')({ operation: 'run', request_id: 'recorded-worker', role: 'coding',
  task: 'implementation', group: 'workers', transport: 'shell', brief: path.join(project, 'brief.md'),
  workdir: work, final_output: path.join(work, 'claims.json'), ...(runDir === 'auto' ? {} : { run_dir: runDir }) }));
const status = decode(await tools.get('worker-invoke')({ operation: 'status', invocation_id: run.invocationId }));
if (run.status !== 'completed') {
  console.log(JSON.stringify({ run, status }));
} else {
  const verification = decode(await tools.get('worker-verify-deliver')({ run_dir: run.run_dir,
    artifact_path: path.join(work, 'artifact.txt'), deliverable_path: path.join(project, 'answer.txt'),
    checks: [{ id: 'protected', command: process.execPath, args: ['-e', outcome === 'rejected' ? 'process.exit(7)' : 'process.exit(0)'] }] }));
  const records = Object.fromEntries(['invocation.json', 'exit.json', 'worker-exit.json', 'final-evidence.json']
    .map(name => [name, JSON.parse(readFileSync(path.join(run.run_dir, name), 'utf8'))]));
  console.log(JSON.stringify({ run, status, verification, records, owner: readFileSync(path.join(run.run_dir, '.launch-owner'), 'utf8'),
    bytes: readFileSync(path.join(project, 'answer.txt'), 'utf8') }));
}
