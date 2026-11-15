// Offline installed publication fixture: no worker, manager, model or network.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWorkerVerifyDeliverTool } from '../../../src/mcp/tools/worker-verify-deliver.mjs';
import { verifyWorkerRun, runWorkerVerificationCli } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';

registerHooks({ load(url, context, next) {
  if (url.endsWith('/dist/src/cli/handlers/models.js')) return { format: 'module', shortCircuit: true,
    source: 'export async function loadWorkerInputs() { return { drivers: {} }; }' };
  return next(url, context);
} });
const projectRoot = process.argv[2], deliverable_path = join(projectRoot, 'answer.json');
let handler;
registerWorkerVerifyDeliverTool({ registerTool(_name, _config, callback) { handler = callback; } }, {
  projectRoot, assertPath: async candidate => candidate, verify: verifyWorkerRun,
});
const typed_stop = { status: 'denied', code: 'POLICY_DENIED', blocking_rule: 'Policy denies this launch.', launch_count: 0 };
const published = await handler({ deliverable_path, typed_stop });
const invalid = await handler({ deliverable_path, typed_stop: { ...typed_stop, launch_count: 1 } });
const conflict = await handler({ deliverable_path, typed_stop });
let lookup;
const exit = await runWorkerVerificationCli(['--verify-worker', '--delivery-status', '--deliverable', deliverable_path, '--json'], {
  stdout: text => { lookup = JSON.parse(text); },
});
console.log(JSON.stringify({ published: JSON.parse(published.content[0].text), lookup, invalid, conflict, bytes: readFileSync(deliverable_path, 'utf8') }));
process.exitCode = published.isError ? 1 : exit;
