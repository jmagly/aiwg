// Offline adapter fixture: installed verification, synthetic manager and qualifications.
import { registerWorkerVerifyDeliverTool } from '../../../src/mcp/tools/worker-verify-deliver.mjs';
import { writeFileSync } from 'node:fs';
import { prepareDeliveryRecord } from '../../../tools/ralph-external/lib/worker-delivery-record.mjs';
import { verifyWorkerRun } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
let handler;
registerWorkerVerifyDeliverTool({ registerTool(_name, _config, callback) { handler = callback; } }, {
  projectRoot: process.cwd(), assertPath: async candidate => candidate, verify: input => verifyWorkerRun(input, { prepareRecord: async (project, metadata) => {
    const complete = await prepareDeliveryRecord(project, metadata);
    if (args.includes('--mutate-after-acceptance')) writeFileSync(input.artifactPath ?? value('--fixture-artifact'), 'changed after acceptance');
    return complete;
  } }),
});
const checks = args.flatMap((arg, index) => arg === '--check' ? [JSON.parse(args[index + 1])] : []);
const response = await handler({ run_dir: value('--run-dir'), deliverable_path: value('--deliverable'), checks });
console.log(response.isError ? JSON.stringify({ status: 'rejected', findings: [response.content[0].text] }) : response.content[0].text);
process.exitCode = response.isError ? 1 : 0;
