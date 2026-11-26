// Launch one bounded cycle while Ralph retains evaluation and recovery ownership.
import { CheckpointManager } from '../checkpoint-manager.mjs';
import { prepareNativeAttempt, finishNativeAttempt, persistCycleAttempt } from './session-attempt.mjs';
import { prepareGroupCycle, launchGroupCycle } from './ralph-group-cycle.mjs';
import { routeRalphWorker } from './ralph-delegation.mjs';

export async function launchRalphCycle(owner, state, { prompt, systemPrompt, outputPaths, iterationDir, timeoutMs }) {
  const routing = state.config.groupWorker ? undefined : await routeRalphWorker(owner, state, iterationDir, state.objective ?? prompt);
  const options = { prompt, model: routing?.resolved_model, budget: state.config.budgetPerIteration,
    systemPrompt, mcpConfig: state.config.mcpConfig, thinking: state.config.thinking, tools: state.config.tools,
    workingDir: state.config.workingDir, stdoutPath: outputPaths.stdout, stderrPath: outputPaths.stderr,
    outputDir: iterationDir, timeoutMs, verbose: state.config.verbose };
  let prepared;
  try {
    prepared = state.config.groupWorker ? await prepareGroupCycle(owner, state, options)
      : prepareNativeAttempt(owner, state, options);
    if (state.config.enableCheckpoints) {
      owner.checkpointManager = new CheckpointManager({ stateDir: iterationDir, projectRoot: owner.projectRoot,
        interval: state.config.checkpointIntervalMinutes * 60 * 1000,
        sessionId: prepared.sessionId, attempt: prepared.attempt });
      owner.checkpointManager.start();
    }
    const result = state.config.groupWorker ? await launchGroupCycle(owner, state, prepared)
      : await owner.sessionLauncher.launch(prepared);
    if (!state.config.groupWorker) finishNativeAttempt(owner, state, prepared, result);
    return result;
  } catch (error) {
    if (!state.config.groupWorker && state.sessionBinding) state.sessionBinding.valid = false;
    const attempt = prepared?.attempt ?? state.currentAttempt;
    if (attempt) {
      attempt.status = 'blocked';
      attempt.errorCode = error.code ?? 'CYCLE_LAUNCH_FAILED';
      persistCycleAttempt(owner, state, iterationDir, attempt);
    }
    throw error;
  }
}
