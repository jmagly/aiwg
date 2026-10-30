/** Shared runtime resolver for config consumers and direct preflight tools. */
export const DEFAULT_DISPATCH_HOST_THRESHOLDS = Object.freeze({
  min_avail_mem_gb: 8,
  max_load_ratio: 1.0,
  max_mem_psi_avg10: 30,
  max_mem_psi_avg60: 10,
  // 08 brief/evidence retention: stop new admissions when less than 2 GiB free remains.
  min_free_disk_gb: 2,
  max_workers: 5,
  max_snapshot_age_seconds: 300,
});

/**
 * Layers tighten defaults: minimums take MAX and maximums take MIN.
 * Exception: the first configured max_workers replaces its default (even above 5);
 * configured worker caps still take MIN across build, admission and task.
 * Validate each layer before merging so an invalid value cannot be hidden.
 */
export function resolveDispatchHostThresholds(buildDispatch, admissionHostResources, overlay, origins) {
  const configured = { ...DEFAULT_DISPATCH_HOST_THRESHOLDS };
  const keys = Object.keys(DEFAULT_DISPATCH_HOST_THRESHOLDS);
  let workerCapConfigured = false;
  if (origins) for (const key of Object.keys(configured)) origins[key] = ['default'];
  for (const [layer, origin] of [[buildDispatch, 'project:build.resource_preflight.dispatch'],
    [admissionHostResources, 'project:parallelism.admission.hostResources'], [overlay, 'task']]) {
    if (layer === undefined) continue;
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      throw new Error('OG_CONFIG_REFERENCE dispatch thresholds: must be an object');
    }
    for (const key of keys) {
      const value = layer[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`OG_CONFIG_REFERENCE dispatch threshold ${key}: must be a non-negative number`);
      }
      if (key === 'max_snapshot_age_seconds' && value <= 0) {
        throw new Error('OG_CONFIG_REFERENCE dispatch threshold max_snapshot_age_seconds: must be a positive number');
      }
      if (key === 'max_workers' && (!Number.isInteger(value) || value < 1)) {
        throw new Error('OG_CONFIG_REFERENCE dispatch threshold max_workers: must be an integer >= 1 when set');
      }
      const previous = key === 'max_workers' && !workerCapConfigured ? undefined : configured[key];
      if (key === 'max_workers') workerCapConfigured = true;
      configured[key] = previous === undefined ? value
        : key.startsWith('min_') ? Math.max(previous, value) : Math.min(previous, value);
      if (origins && configured[key] === value) {
        origins[key] = previous === value ? [...origins[key], origin] : [origin];
      }
    }
  }
  return { ...DEFAULT_DISPATCH_HOST_THRESHOLDS, ...configured };
}
