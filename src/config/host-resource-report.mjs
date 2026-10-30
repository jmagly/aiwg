// Normalize host measurements, tighten-only thresholds and remaining worker capacity.
import { getProviderParallelismDefaults } from './aiwg-config.js';
import { expandWorkerGroupTemplates } from './worker-group-templates.js';
import { DEFAULT_DISPATCH_HOST_THRESHOLDS, resolveDispatchHostThresholds } from './dispatch-thresholds-runtime.mjs';
import { evaluateDispatchGate, readLiveHostResources } from './host-resource-runtime.mjs';

// Re-evaluate persisted/remote collection times; never stamp them with the read time.
function snapshotFreshness(measured, evaluated, maxSnapshotAgeSeconds) {
  const collected = Date.parse(measured.collectedAt);
  const ageMs = evaluated - collected;
  const maxAgeMs = maxSnapshotAgeSeconds * 1000;
  const result = { collectedAt: Number.isFinite(collected) ? new Date(collected).toISOString() : null,
    evaluatedAt: Number.isFinite(evaluated) ? new Date(evaluated).toISOString() : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null, maxAgeMs, status: 'fresh' };
  if (!Number.isFinite(ageMs)) {
    result.status = 'unavailable'; result.reason = 'collection time or evaluation clock missing or invalid';
  } else if (ageMs < 0) {
    result.status = 'unavailable'; result.reason = 'collection time is in the future';
  } else if (ageMs > maxAgeMs) {
    result.status = 'stale'; result.reason = `resource snapshot age ${ageMs}ms exceeds ${maxAgeMs}ms`;
  }
  return result;
}

export function hostResourceReport({ config, live, readers, paths, thresholdOverlay, caps, group, now = readers?.now ?? Date.now } = {}) {
  const expansion = expandWorkerGroupTemplates(config?.parallelism);
  if (expansion.errors.length) throw new Error(expansion.errors.join('; '));
  const parallelism = expansion.parallelism;
  const configured = parallelism?.groups ?? {};
  if (group !== undefined && !Object.hasOwn(configured, group)) {
    throw new Error(`Unknown group "${group}"; configured groups: ${Object.keys(configured).join(', ') || '(none)'}`);
  }
  // Local collection and evaluation share one clock; supplied snapshots retain their source time.
  const measured = live ?? readLiveHostResources({ ...readers, now, paths, groupNames: Object.keys(configured) });
  const evaluated = now();
  const origins = {};
  let thresholds;
  try {
    thresholds = resolveDispatchHostThresholds(config?.build?.resource_preflight?.dispatch,
      config?.parallelism?.admission?.hostResources, thresholdOverlay, origins);
  } catch (error) {
    const snapshot = snapshotFreshness(measured, evaluated, DEFAULT_DISPATCH_HOST_THRESHOLDS.max_snapshot_age_seconds);
    return { measured, freshness: snapshot, thresholds: null, origins, slots: 0, ok: false, limits: [], groups: [],
      failures: [{ signal: 'thresholds', reason: error.message }] };
  }
  const snapshot = snapshotFreshness(measured, evaluated, thresholds.max_snapshot_age_seconds);
  const gate = evaluateDispatchGate(measured, thresholds);
  if (!Number.isFinite(measured.load1) || !Number.isFinite(measured.cores) || measured.cores <= 0) {
    gate.failures.push({ signal: 'load', reason: 'load headroom requires detectable load1 and positive cores' });
  }
  const names = { 'avail-mem': 'min_avail_mem_gb', load: 'max_load_ratio',
    'mem-psi-avg10': 'max_mem_psi_avg10', 'mem-psi-avg60': 'max_mem_psi_avg60',
    'free-disk': 'min_free_disk_gb', workers: 'max_workers' };
  const failures = gate.failures.map(failure => ({ ...failure, signal: names[failure.signal] ?? failure.signal,
    reason: failure.actual === undefined ? `unavailable: ${failure.reason}` : failure.reason }));
  if (snapshot.status !== 'fresh') failures.unshift({ signal: 'snapshot', reason: `${snapshot.status}: ${snapshot.reason}` });
  else if (failures.some(failure => failure.reason.startsWith('unavailable:'))) {
    snapshot.status = 'unavailable'; snapshot.reason = 'required host signals unavailable';
  }
  const limits = [];
  const add = (threshold, available, reason) => {
    const slots = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
    limits.push({ threshold, slots });
    if (slots === 0) failures.push({ signal: threshold, reason });
  };
  // Floors act as conservative per-slot budgets; PSI is a binary pressure gate.
  if (thresholds.min_avail_mem_gb > 0) add('min_avail_mem_gb', measured.availMemGb / thresholds.min_avail_mem_gb,
    'insufficient available memory for another worker');
  if (thresholds.min_free_disk_gb > 0) add('min_free_disk_gb', measured.freeDiskGb / thresholds.min_free_disk_gb,
    'insufficient free disk for another worker');
  add('max_load_ratio', thresholds.max_load_ratio * measured.cores - measured.load1,
    'less than one core of load headroom');
  if (thresholds.max_workers !== undefined) add('max_workers', thresholds.max_workers - measured.workers,
    'running workers exhaust the host ceiling or cannot be counted');
  const admission = [
    { threshold: 'max_parallel_subagents', limit: parallelism?.max_parallel_subagents
      ?? (parallelism?.worker_dispatch ? getProviderParallelismDefaults(config?.providers?.[0]).max_parallel_subagents : undefined) },
    ...(caps ?? []),
  ];
  // Tuple-specific caps are supplied by the resolver, never inferred globally.
  for (const { threshold, limit, running = measured.workers } of admission) {
    if (limit !== undefined && limit !== null) add(threshold, limit - running,
      'admission capacity exhausted or worker count unavailable');
  }
  const groups = Object.entries(configured).map(([id, settings]) => {
    const unknown = measured.workers - Object.values(measured.workerGroups ?? {}).reduce((sum, count) => sum + count, 0);
    const running = (measured.workerGroups?.[id] ?? 0) + unknown;
    const candidates = [
      { threshold: `groups.${id}.maxParallel`, limit: settings.maxParallel },
      { threshold: `admission.groupCaps.${id}`, limit: parallelism?.admission?.groupCaps?.[id] },
    ].filter(entry => entry.limit !== undefined);
    const capacities = candidates.map(entry => ({ ...entry,
      slots: Number.isFinite(running) ? Math.max(0, entry.limit - running) : 0 }));
    const binding = capacities.sort((a, b) => a.slots - b.slots)[0];
    const disabled = settings.enabled === false;
    const slots = disabled ? 0 : binding?.slots ?? null;
    const threshold = disabled ? `groups.${id}.enabled` : binding?.threshold;
    const reason = disabled ? 'group disabled' : slots === null ? 'no group ceiling configured'
      : slots === 0 ? 'admission capacity exhausted or worker count unavailable' : 'remaining group capacity';
    if (id === group && threshold) add(threshold, slots, reason);
    return { group: id, maxParallel: settings.maxParallel ?? null, slots,
      reason: threshold ? `${threshold}: ${reason}` : reason };
  });
  const slots = failures.length ? 0 : Math.min(...limits.map(limit => limit.slots));
  const limitingThreshold = failures[0]?.signal ?? [...limits].sort((a, b) => a.slots - b.slots)[0]?.threshold;
  return { measured, freshness: snapshot, thresholds, origins, slots, ok: slots > 0, limits, failures, groups, limitingThreshold,
    counting: 'current UID AIWG worker units plus distinct AIWG_WORKER_INVOCATION_ID markers outside those units; '
      + (measured.workerCountingSource === 'owned-process-fallback' ? 'systemd unavailable: owned-process fallback; ' : '')
      + 'hostCliProcesses: exact codex/muse/muse-bin comm, informational, not used for admission; group attribution uses unambiguous configured prefixes in existing invocation markers or unit names; unattributed workers count against every group; tuple caps without attribution use owned worker total' };
}
