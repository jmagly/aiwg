// Narrow workers-toolset adapter: protected checks and publication share one verifier call.
import { mcpError, mcpJson } from '../helpers.mjs';
import { publicationInputSchema, publicationSchema, invalidTypedStop } from './worker-verify-deliver-schema.mjs';

export function registerWorkerVerifyDeliverTool(server, { projectRoot, assertPath, verify }) {
  server.registerTool('worker-verify-deliver', {
    title: 'Verify and Deliver a Worker Artifact or Typed Stop',
    description: 'Publish a checked stopped-worker artifact, or a typed denied/blocked stop with launch_count 0 and no run_dir/artifact_path/checks. Both produce signed delivery records. The server must run outside conductor confinement.',
    inputSchema: publicationInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async input => {
    try {
      const parsed = publicationSchema.safeParse(input);
      if (!parsed.success) throw invalidTypedStop(parsed.error.message);
      const request = parsed.data;
      const deliverablePath = await assertPath(request.deliverable_path);
      if ('typed_stop' in request) return mcpJson(await verify({ projectDir: projectRoot, deliverablePath, typedStop: request.typed_stop }));
      if (new Set(request.checks.map(entry => entry.id)).size !== request.checks.length) throw new Error('Protected check IDs must be unique');
      const runDir = await assertPath(request.run_dir);
      const artifactPath = request.artifact_path && await assertPath(request.artifact_path);
      return mcpJson(await verify({ projectDir: projectRoot, runDir, artifactPath, deliverablePath, checks: request.checks }));
    } catch (error) {
      if (error.code === 'TYPED_STOP_INVALID') return { ...mcpJson({ status: 'rejected', errorCode: error.code, code: error.code, findings: [error.message] }), isError: true };
      return mcpError(`worker-verify-deliver: ${error.message}`);
    }
  });
}
