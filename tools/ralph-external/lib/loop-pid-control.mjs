// Connect loop-owned metrics and gains through the shipped PIDController interface.
export function processLoopControl(owner, state, iteration) {
  const controller = owner.pidController;
  if (!controller.isInitialized) {
    controller.metricsCollector = owner.metricsCollector;
    controller.gainScheduler = owner.gainScheduler ?? controller.gainScheduler;
    controller.initialize(state);
  }
  const decision = controller.process(iteration, state);
  console.log(`[External Ralph] PID control: P=${decision.metrics.proportional.toFixed(3)}, output=${decision.controlSignal.toFixed(3)}`);
  return decision;
}
