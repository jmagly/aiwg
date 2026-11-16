// Retain cumulative server-session launch counts independently of registry pruning.
export function createWorkerLaunchLedger() {
  let count = 0;
  return {
    count: () => count,
    track(launch, transport) {
      return async (...args) => {
        let recorded = false;
        const record = () => { if (!recorded) { recorded = true; count++; } };
        // MCP calls can remain pending long after their process starts.
        // A registered non-null stop control is already launch evidence.
        const context = args[2];
        if (transport === 'mcp' && typeof context?.registerControl === 'function') {
          args[2] = { ...context, registerControl(control) {
            if (control) record();
            return context.registerControl(control);
          } };
        }
        let result;
        try { result = await launch(...args); }
        catch (error) {
          if (error.launchAttempted) record();
          throw error;
        }
        const launched = transport === 'shell'
          ? result.launched || result.launchAttempted || result.dispatchState === 'submission-uncertain'
          : result.dispatchState ? result.dispatchState !== 'never-began' : result.outcome !== 'blocked';
        if (launched) record();
        return result;
      };
    },
  };
}
