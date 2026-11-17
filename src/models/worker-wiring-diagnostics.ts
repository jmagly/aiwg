// Audit declared worker routes without granting qualification or launch authority.
import { expandWorkerGroupTemplates } from '../config/worker-group-templates.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';
import type { WorkerPolicyDiagnostic, WorkerSelectionPolicy } from './types.js';

export function workerWiringDiagnostics(parallelism: ParallelismConfig | undefined,
  policy: WorkerSelectionPolicy | undefined): WorkerPolicyDiagnostic[] {
  const groups = expandWorkerGroupTemplates(parallelism).parallelism?.groups ?? {};
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  for (const [id, group] of Object.entries(groups)) {
    const roles = new Set([...group.members.filter(member => member.enabled !== false
      && parallelism?.clis?.[member.cli]?.enabled !== false).flatMap(member => member.roles), ...group.requiredRoles ?? []]);
    for (const role of roles) {
      if (policy?.roleGuidance?.[role]?.groups.includes(id)) continue;
      diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: `/defaults/workerSelection/roleGuidance/${role}/groups`,
        message: `Group ${JSON.stringify(id)} is outside role guidance for ${role}. Edit models.json: add ${JSON.stringify(id)} to defaults.workerSelection.roleGuidance.${role}.groups.`,
        roles: [role] });
    }
  }
  for (const cli of Object.keys(parallelism?.clis ?? {})) {
    if (Object.values(groups).some(group => group.members.some(member => member.cli === cli))) continue;
    diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: `/parallelism/clis/${cli}`, blocking: false,
      message: `Declared CLI ${JSON.stringify(cli)} is used by no group. Add a member with cli=${JSON.stringify(cli)} to parallelism.groups in .aiwg/aiwg.config, or remove parallelism.clis.${cli}.` });
  }
  return diagnostics;
}
