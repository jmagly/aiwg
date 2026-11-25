// Persist terminal quota exhaustion in the existing host installation store.
import { lstat } from 'node:fs/promises';
import { installationStorePath, assertTrustedStore, readInstallationStore,
  withWorkerInstallationStore, writeWorkerInstallationStore } from './worker-installation-store.mjs';

const exhausted = /(?:hit your usage limit|usage limit (?:reached|exceeded)|quota (?:exhausted|exceeded)|insufficient_quota)/i;

export function parseWorkerQuotaFailure(output, now = Date.now(), failed = true) {
  let failure = null;
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); }
    catch { if (failed && exhausted.test(line)) event = { type: 'error', message: line }; }
    if (!event || !['error', 'turn.failed'].includes(event.type)
      && !(event.type === 'result' && event.is_error === true)) continue;
    const message = [event.message, event.error?.message, typeof event.error === 'string' ? event.error : '', event.result]
      .filter(value => typeof value === 'string').join(' ');
    if (!exhausted.test(message)) continue;
    const reset = event.reset_at ?? event.resetAt ?? event.error?.reset_at
      ?? message.match(/(?:try again at|resets? (?:at|on))\s+(.+)/i)?.[1];
    const parsed = typeof reset === 'string' ? Date.parse(reset.replace(/(\d)(?:st|nd|rd|th)\b/g, '$1').replace(/[.!]\s*$/, '').trim()) : NaN;
    const seconds = event.retry_after_seconds ?? event.retry_after;
    const resetTime = Number.isFinite(parsed) ? parsed
      : typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : NaN;
    failure = { resetAt: Number.isFinite(resetTime) ? new Date(resetTime).toISOString() : null };
    if (failure.resetAt !== null) return failure;
  }
  return failure;
}

function observations(stored) {
  const values = stored.quotaObservations ?? [];
  if (!Array.isArray(values) || values.length > 128 || values.some(value => !value
    || typeof value.quotaScope !== 'string' || !value.quotaScope.trim() || typeof value.cli !== 'string'
    || !Number.isFinite(Date.parse(value.observedAt))
    || value.resetAt !== null && !Number.isFinite(Date.parse(value.resetAt)))) throw new Error('Invalid worker quota observations');
  return values;
}

export async function loadWorkerQuotaObservations(cwd) {
  const filename = installationStorePath();
  // No observation means no new installation-store requirement for offline renderers.
  try { await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  await assertTrustedStore(filename, [cwd]);
  return observations((await readInstallationStore(filename)).stored);
}

export function workerQuotaExhaustion(values, quotaScope, now) {
  return values?.find(value => value.quotaScope === quotaScope
    && (value.resetAt === null || Date.parse(value.resetAt) > now)) ?? null;
}

export async function recordWorkerQuotaFailure({ cwd, cli, quotaScope, output, exitCode, now = Date.now() }) {
  const failure = parseWorkerQuotaFailure(output, now, exitCode !== 0);
  if (!failure || !quotaScope) return false;
  await withWorkerInstallationStore([cwd], async ({ filename, stored }) => {
    const previous = observations(stored);
    const active = workerQuotaExhaustion(previous, quotaScope, now);
    // A subsequent shorter reset cannot restore an exhausted account early.
    if (active && (active.resetAt === null || failure.resetAt !== null
      && Date.parse(active.resetAt) >= Date.parse(failure.resetAt))) return;
    const retained = previous.filter(value => value.quotaScope !== quotaScope
      && (value.resetAt === null || Date.parse(value.resetAt) > now));
    if (retained.length >= 128) throw new Error('Worker quota observation store is full');
    stored.quotaObservations = [...retained, { cli, quotaScope, observedAt: new Date(now).toISOString(), resetAt: failure.resetAt }];
    await writeWorkerInstallationStore(filename, stored, [cwd]);
  });
  return true;
}
