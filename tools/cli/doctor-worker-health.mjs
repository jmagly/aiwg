// Report offline worker health and declared conductor input protection, without launching tools.
import path from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';
import { collectWrapperEnforcement } from './doctor-wrapper-enforcement.mjs';
import { wrapperTextFindings } from './doctor-wrapper-text.mjs';

export async function checkWorkerHealthReadiness({ config, configFailed, AIWG_ROOT, cwd, check }) {
  for (const finding of wrapperTextFindings(await collectWrapperEnforcement({ projectDir: cwd, config, packageRoot: AIWG_ROOT }))) {
    check(finding.name, finding.status, finding.message);
  }
  const { validateParallelismConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  let workerSnapshotModels = null;
  let workerSnapshotCatalog = null;
  let workerSnapshotDigests = null;
  let workerSnapshotRegistry = null;

  // #2913 / T-OG-12: offline health readiness, without installing adapters,
  // reading credentials, probing models, or requiring Mission/admission state.
  try {
    if (configFailed) throw new Error('worker-sections config unavailable');
    if (!config?.parallelism?.worker_dispatch) {
      const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
      const { collectLocalOnlyPaths } = await importImpl(import.meta.url, 'models/conductor-data-policy.mjs');
      const models = await new ConfigLoader(cwd).load(config?.parallelism);
      const paths = collectLocalOnlyPaths(models.defaults.workerSelection, config?.parallelism);
      if (paths.length) check('Worker Health', 'info', `Declared local-only conductor inputs: ${paths.join(', ')}; deploy provider guards before opening inputs; shell coverage is limited.`);
      check('Worker Health', 'info', 'group dispatch is disabled; legacy worker status remains unchanged');
    } else {
      const { diagnoseWorkerHealthReadiness, workerHealthConfigurationFindings, formatWorkerHealthReadinessFinding } = await importImpl(import.meta.url, 'models/worker-health-readiness.js');
      const healthErrors = validateParallelismConfig(config.parallelism);
      if (healthErrors.length) {
        for (const finding of workerHealthConfigurationFindings(config.parallelism, healthErrors).slice(0, 16)) check('Worker Health Configuration', finding.status,
          formatWorkerHealthReadinessFinding(finding));
      } else {
        const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
        const { loadProviderModelCapabilities } = await importImpl(import.meta.url, 'models/provider-policy.js');
        const { resolveDynamicModelCatalog } = await importImpl(import.meta.url, 'models/model-discovery.js');
        const loader = new ConfigLoader(cwd);
        const models = await loader.load(config.parallelism);
        const catalog = await resolveDynamicModelCatalog({ aiwgRoot: AIWG_ROOT,
          inventory: { generatedAt: new Date().toISOString(), projectDir: cwd,
            providers: [], activeProvider: null, activeSource: 'doctor-offline' }, allowNetwork: false });
        const registry = loadProviderModelCapabilities();
        // Shared with the direct-worker dispatch-eligibility check below
        // (#2894): same offline snapshot, no second catalog resolution.
        workerSnapshotModels = models;
        workerSnapshotCatalog = catalog;
        workerSnapshotDigests = loader.getInputDigests();
        workerSnapshotRegistry = registry;
        const { recordedWorkerHealthSnapshot } = await importImpl(import.meta.url, 'models/worker-health-snapshot.js');
        const { readLiveHostResources } = await importImpl(import.meta.url, 'config/host-resource-runtime.mjs');
        const snapshot = await recordedWorkerHealthSnapshot({ config, models,
          modelDigests: workerSnapshotDigests, catalog,
          registry, installations: {}, hostResources: readLiveHostResources({ paths: [cwd], workspace: cwd,
            groupNames: Object.keys(config.parallelism.groups ?? {}) }) }, cwd);
        const report = diagnoseWorkerHealthReadiness(snapshot, {
          now: new Date().toISOString(),
          context: { estimator: 'doctor-offline-context-v1', briefTokens: 0,
            inputTokens: 0, toolOutputAllowance: 0, reservedOutput: 0 },
        }, { catalogFile: catalog.discovery?.source === 'static' ? path.join(AIWG_ROOT, 'agentic/code/providers/model-catalog.v1.json') : undefined });
        if (report.contextDigest) check('Worker Health Context', 'info',
          `offline context digest=${report.contextDigest}; actual task context must be resolved before launch`);
        for (const finding of report.findings.slice(0, 32)) {
          check(`Worker Health${finding.role ? ` (${finding.role})` : finding.roles?.length ? ` (${finding.roles.join(', ')})` : ''}`, finding.status,
            formatWorkerHealthReadinessFinding(finding));
        }
        if (report.findings.length > 32) check('Worker Health', 'warn',
          `${report.findings.length - 32} additional findings; narrow role/group scope with aiwg models resolve`);
        check('Worker Health Qualification', 'info',
          'offline doctor projects recorded qualifications only and cannot authorize onboarding or launch; use aiwg models resolve to recheck the current installation and actual task');
      }
    }
  } catch {
    if (!configFailed) {
      check('Worker Health', 'warn',
        'offline worker health inputs are invalid or unavailable; review models.json and parallelism.health, then qualify the installation/profile');
    }
    // else: the shared config read itself failed. There is nothing
    // worker-health-specific to diagnose beyond the project's other config
    // checks, which already surface the read failure.
  }

  return { workerSnapshotModels, workerSnapshotCatalog, workerSnapshotDigests, workerSnapshotRegistry };
}
