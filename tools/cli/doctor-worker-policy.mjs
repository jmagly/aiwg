// Surface static wiring and signed policy drift before dispatch, without launching workers.
import { importImpl } from '../_resolve-impl.mjs';

export async function collectWorkerPolicyDiagnostics(projectDir, config, { requiredRoles = true } = {}) {
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const { workerWiringDiagnostics } = await importImpl(import.meta.url, 'models/worker-wiring-diagnostics.js');
  const { inspectRecordedWorkerQualifications } = await importImpl(import.meta.url, 'models/worker-installation.mjs');
  const { validateWorkerGroupQualifications } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const { expandWorkerGroupTemplates } = await importImpl(import.meta.url, 'config/worker-group-templates.js');
  let policy;
  try { policy = (await new ConfigLoader(projectDir).load(config?.parallelism)).defaults.workerSelection; }
  catch (error) {
    return [{ code: 'OG_CONFIG_REFERENCE', pointer: '/defaults/workerSelection',
      message: `Review models.json and parallelism in .aiwg/aiwg.config: ${error.message}` }];
  }
  const diagnostics = workerWiringDiagnostics(config?.parallelism, policy);
  if (!config?.parallelism?.worker_dispatch) return diagnostics;
  const records = await inspectRecordedWorkerQualifications({ cwd: projectDir, policy,
    parallelism: config.parallelism, includeInputs: true, diagnostics }).catch(() => []);
  const qualifiedRoles = {};
  const parallelism = expandWorkerGroupTemplates(config.parallelism).parallelism;
  for (const [id, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group.members) {
      const observation = records.find(record => record.cli === member.cli)?.observations?.models
        .find(row => row.id === member.model || row.apiModelId === member.model)?.worker;
      qualifiedRoles[`${id}/${member.id}`] = observation?.qualification.status === 'qualified'
        ? observation.qualification.roles : [];
    }
  }
  for (const diagnostic of requiredRoles ? validateWorkerGroupQualifications(parallelism, qualifiedRoles) : []) {
    const group = diagnostic.pointer.split('/')[3];
    if (diagnostic.roles.some(role => !policy?.roleGuidance?.[role]?.groups.includes(group))) continue;
    diagnostics.push({ ...diagnostic, message: `${diagnostic.message}. Run aiwg doctor --probe-workers --qualify.` });
  }
  return diagnostics;
}
