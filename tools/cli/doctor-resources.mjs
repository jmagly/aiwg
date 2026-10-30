// Read-only resource mode; stdout is one normalized report in JSON mode.
import { importImpl } from '../_resolve-impl.mjs';
const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
const { hostResourceReport } = await importImpl(import.meta.url, 'config/host-resource-report.mjs');

export async function runResourceDoctor(projectDir, { json = false, readers, config, group, live, now } = {}) {
  const report = hostResourceReport({ config: config ?? await readAiwgConfig(projectDir), readers, group, live, now, paths: [projectDir] });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Host resources: ${report.ok ? 'OK' : 'BLOCK'}; slots=${report.slots}; limiting=${report.limitingThreshold ?? 'thresholds'}`);
    console.log(`Snapshot: ${report.freshness.status}; collectedAt=${report.freshness.collectedAt ?? 'unavailable'}; ageMs=${report.freshness.ageMs ?? 'unavailable'}; maxAgeMs=${report.freshness.maxAgeMs}; evaluatedAt=${report.freshness.evaluatedAt ?? 'unavailable'}`);
    console.log(`Measured: ${JSON.stringify(report.measured)}`);
    console.log(`Counting: ${report.counting}`);
    for (const [key, value] of Object.entries(report.thresholds ?? {})) {
      console.log(`${key}=${value} (${report.origins[key].join(', ')})`);
    }
    for (const entry of report.groups) console.log(`Group ${entry.group}: maxParallel=${entry.maxParallel ?? 'unset'}; slots=${entry.slots ?? 'unbounded'}; ${entry.reason}`);
    for (const failure of report.failures) console.log(`${failure.signal}: ${failure.reason}`);
  }
  return report.ok ? 0 : 1;
}
