// Reuse the existing harness adapters to interpret fatal CLI events and observed Codex models.
import type { JudgeConfiguration, Observation } from './judge-types.js';
export async function observeCli(config: JudgeConfiguration, stdout: string, observation: Observation) {
  const provider = config.group === 'workers' ? 'codex' : config.group === 'cursor' ? 'cursor' : 'muse';
  const moduleUrl = new URL(`../../ralph-external/lib/${provider}-adapter.mjs`, import.meta.url).href;
  const module = await import(moduleUrl);
  const Adapter = module[`${provider[0].toUpperCase()}${provider.slice(1)}Adapter`];
  const adapter = new Adapter();
  const binding: { sessionId?: string; runId?: string } = {};
  for (const line of stdout.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const result = adapter.observeHealthEvent(event, { kind: 'stdout' }, binding);
    if (result?.sessionId) binding.sessionId = result.sessionId;
    if (result?.runId) binding.runId = result.runId;
    if (result?.fatal || (result?.kind === 'terminal' && result.success === false)) {
      observation.status = 'provider-error'; observation.flags.push('provider-error-event');
    }
  }
  if (provider === 'codex') observation.observed_model = module.summarizeCodexStream(stdout, undefined).observedModel ?? 'unknown';
}
