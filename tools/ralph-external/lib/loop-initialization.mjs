// Stop repeated pre-launch failures and keep absent worker output out of selection.
export function recordedOutputs(state) {
  return (state.iterations ?? []).filter(iteration => iteration.status !== 'error'
    && Number.isSafeInteger(iteration.number));
}

export function noRecordedOutput(state) {
  state.bestIterationSelected = null;
  state.selectionSource = 'none';
  state.outputSummary = 'No worker output was recorded; no output is available.';
  console.log(`[External Ralph] ${state.outputSummary}`);
  return { bestIteration: null, selectionSource: 'none', currentIteration: state.currentIteration, wasDifferent: false };
}

export async function handleInitializationFailure(owner, state, error) {
  const failures = state.initializationFailures ??= [];
  const previous = failures.at(-1);
  const signature = JSON.stringify([error.name, error.code ?? null, error.message]);
  failures.push({ attempt: state.currentIteration, signature, message: error.message, code: error.code ?? null });
  const repeated = previous?.signature === signature && previous.attempt === state.currentIteration - 1;
  if (!repeated && state.currentIteration < state.maxIterations) {
    owner.stateManager.save(state);
    console.log('[External Ralph] Initialization failed before worker launch; retrying once for this failure.');
    return null;
  }
  const reason = `${repeated ? 'Repeated initialization failure' : 'Initialization failed'} before worker launch: ${error.message}`;
  state.status = 'failed';
  state.outputSummary = recordedOutputs(state).length === 0
    ? 'No worker was launched; no output exists.'
    : 'Initialization failed before the next worker launch; earlier worker output remains available.';
  console.error(`[External Ralph] ${reason}. ${state.outputSummary}`);
  owner.stateManager.save(state);
  await owner.generateCompletionReport(state, 'failed');
  await owner.recordTaskCompletion(state, 'failure');
  await owner.completeMultiLoop('failed');
  return { success: false, reason, iterations: recordedOutputs(state).length, loopId: state.loopId, selectedIteration: null };
}
