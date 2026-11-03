// Assert the exact #3674 marker additions before comparing frozen legacy records.
import { expect } from 'vitest';

const marker = 'AIWG_WORKER_INVOCATION_ID';
export function normalizeMarkerRunRecord(name, baseline, branch) {
  if (name === 'invocation.json') {
    expect(branch.envNames).toEqual([...new Set([...baseline.envNames, marker, 'AIWG_WORKER_WORKSPACE', 'AIWG_WORKER_GROUP'])]);
    // #3701 also intersects invocation limits with the configured health deadline.
    // Assert every changed byte before restoring the frozen representation below.
    const ceiling = baseline.health.hardTimeoutSeconds;
    const origins = structuredClone(baseline.health.origins);
    const pointer = '/parallelism/health/hardTimeoutSeconds';
    if (baseline.limits.wallSeconds > ceiling && origins.hardTimeoutSeconds.includes(pointer)) {
      expect(branch.limits).toEqual({ ...baseline.limits, wallSeconds: ceiling });
      const runtime = 'runtime/remainingWallSeconds';
      const hardOrigins = [...origins.hardTimeoutSeconds, runtime];
      for (const field of ['diagnosticGraceSeconds', 'terminateGraceSeconds']) {
        if (baseline.health[field] === ceiling) origins[field] = [...origins[field], runtime];
      }
      origins.hardTimeoutSeconds = [...hardOrigins, pointer];
      expect(branch.health).toEqual({ ...baseline.health, origins });
      return { ...branch, envNames: baseline.envNames, limits: baseline.limits, health: baseline.health };
    }
    return { ...branch, envNames: baseline.envNames };
  }
  if (name === 'process.json') {
    expect(baseline).not.toHaveProperty('invocationMarker');
    expect(branch.invocationMarker).toBe(branch.invocationId);
    const { invocationMarker, ...unchanged } = branch;
    return unchanged;
  }
  return branch;
}

export function normalizeMarkerCallbackLog(baseline, branch) {
  let records = 0;
  const normalized = branch.map((entry, index) => {
    const previous = baseline[index];
    if (entry.name !== 'publishRecord' || !previous.args[2]?.includes('worker')) return entry;
    records++;
    expect(previous.args[2]).not.toContain('invocationMarker');
    expect(entry.args[2]).toEqual([...previous.args[2], 'invocationMarker'].sort());
    return { ...entry, args: entry.args.map((arg, n) => n === 2 ? previous.args[2] : arg) };
  });
  expect(records).toBeGreaterThan(0);
  return normalized;
}
