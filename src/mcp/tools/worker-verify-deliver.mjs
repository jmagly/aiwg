// Narrow workers-toolset adapter: protected checks and publication share one verifier call.
import { mcpError, mcpJson } from '../helpers.mjs';
import { publicationInputSchema, parsePublication } from './worker-verify-deliver-schema.mjs';

export function registerWorkerVerifyDeliverTool(server, { projectRoot, assertPath, verify }) {
  server.registerTool('worker-verify-deliver', {
    title: 'Verify and Deliver a Worker Artifact or Typed Stop',
    description: 'Publish a checked stopped-worker artifact, or a typed denied/blocked stop with launch_count 0 and no run_dir/artifact_path/checks. Malformed publications return PUBLICATION_INVALID; malformed typed stops return TYPED_STOP_INVALID. launch_count is checked against this MCP server session\'s recorded worker-invoke launches; undercounts return TYPED_STOP_LAUNCH_MISMATCH. A typed stop can only be published before any worker launch in this session; after a launch, the conductor must retry the worker or publish a verified worker artifact. Both produce signed delivery records. The server must run outside conductor confinement.',
    inputSchema: publicationInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async input => {
    try {
      const request = parsePublication(input);
      const deliverablePath = await assertPath(request.deliverable_path);
      if ('typed_stop' in request) return mcpJson(await verify({ projectDir: projectRoot, deliverablePath, typedStop: request.typed_stop }));
      if (new Set(request.checks.map(entry => entry.id)).size !== request.checks.length) throw new Error('Protected check IDs must be unique');
      const runDir = await assertPath(request.run_dir);
      const artifactPath = request.artifact_path && await assertPath(request.artifact_path);
      return mcpJson(await verify({ projectDir: projectRoot, runDir, artifactPath, deliverablePath, checks: request.checks }));
    } catch (error) {
      if (['PUBLICATION_INVALID', 'TYPED_STOP_INVALID', 'TYPED_STOP_LAUNCH_MISMATCH'].includes(error.code)) return { ...mcpJson({ status: 'rejected', errorCode: error.code, code: error.code, findings: error.findings ?? [error.message] }), isError: true };
      return mcpError(`worker-verify-deliver: ${error.message}`);
    }
  });
}
