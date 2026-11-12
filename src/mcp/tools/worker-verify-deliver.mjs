// Narrow workers-toolset adapter: protected checks and publication share one verifier call.
import { z } from 'zod';
import { mcpError, mcpJson } from '../helpers.mjs';

const absolute = z.string().startsWith('/').max(4096).refine(value => !value.includes('\0'));
const check = z.strictObject({
  id: z.string().min(1).max(256), command: absolute,
  args: z.array(z.string().max(65536).refine(value => !value.includes('\0'))).max(256).optional(),
  cwd: absolute.optional(),
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128).optional(),
  timeoutMs: z.number().int().positive().max(86400000).optional(),
});
const schema = z.strictObject({ run_dir: absolute, artifact_path: absolute.optional(), deliverable_path: absolute, checks: z.array(check).min(1).max(32) });
export function registerWorkerVerifyDeliverTool(server, { projectRoot, assertPath, verify }) {
  server.registerTool('worker-verify-deliver', {
    title: 'Verify and Deliver a Worker Artifact',
    description: 'Run conductor-defined checks against a stopped launcher run; publish only accepted bytes with a signed effect-ledger delivery record. The server must run outside conductor confinement.',
    inputSchema: schema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async input => {
    try {
      const request = schema.parse(input);
      if (new Set(request.checks.map(entry => entry.id)).size !== request.checks.length) throw new Error('Protected check IDs must be unique');
      const runDir = await assertPath(request.run_dir);
      const artifactPath = request.artifact_path && await assertPath(request.artifact_path);
      const deliverablePath = await assertPath(request.deliverable_path);
      return mcpJson(await verify({ projectDir: projectRoot, runDir, artifactPath, deliverablePath, checks: request.checks }));
    } catch (error) { return mcpError(`worker-verify-deliver: ${error.message}`); }
  });
}
