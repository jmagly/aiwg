// Bind resolved MCP shell requests to the installed launcher's capture owner.
export function recordedShellLauncher({ loadRalphExternal, loadInputs, assertPath, registry, now }) {
  const requests = new WeakMap();
  return {
    async bindPlan(plan, { resolve, snapshot, drivers, at, invocationId, input }) {
      if (plan.invocation?.readiness !== 'launchable'
        || (plan.invocation.isolation !== 'native-sandbox' && input.run_dir === undefined)) return plan;
      return resolve(snapshot, plan.request, drivers, at, { digests: plan.digests,
        briefDigest: plan.invocation.briefDigest, invocationId });
    },
    requested(invocation) { return invocation.isolation === 'native-sandbox' || requests.get(invocation)?.input.run_dir !== undefined; },
    prepare(invocation, request) { requests.set(invocation, request); },
    async launch(invocation, options) {
      const request = requests.get(invocation);
      try {
        const runDir = request.input.run_dir && await assertPath(request.input.run_dir);
        const { launchMcpShellWorker } = await loadRalphExternal('lib/mcp-worker-launch.mjs');
        return await launchMcpShellWorker(invocation, { ...options, ...request, runDir, loadInputs, now,
          onRunDir: run_dir => registry.update(request.invocationId, { run_dir }) });
      } catch (error) {
        if (!error.launchAttempted) error.workerNotLaunched = true;
        throw error;
      }
    },
  };
}
