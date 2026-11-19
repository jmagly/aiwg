// Add Muse's shared skill inventory and use the deployment probe as dashboard health authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';

export async function appendMuseDeployment(projectRoot, deployments, config) {
  const configured = config?.providers?.includes('muse')
    || Object.values(config?.installed ?? {}).some(entry => entry.deployedTo?.muse);
  if (!configured) return deployments;
  const { getProviderDefinition } = await importImpl(import.meta.url, 'providers/provider-definitions.js');
  const definition = getProviderDefinition('muse');
  const counts = {};
  for (const [kind, directory] of Object.entries({
    skills: definition.paths.kernelSkills, rules: definition.paths.artifacts.rules, hooks: '.muse/hooks',
  })) {
    try {
      const entries = await fs.readdir(path.join(projectRoot, directory), { withFileTypes: true });
      const count = entries.filter(entry => !entry.name.startsWith('.')).length;
      if (count) counts[kind] = count;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...deployments, { name: 'muse', path: '.muse', counts, lastRefresh: null }];
}

export async function applyDeploymentHealth(result, projectRoot, frameworkRoot) {
  const { buildDeploymentStatusProbe } = await importImpl(import.meta.url, 'cli/services/deployment-verification.js');
  const probe = await buildDeploymentStatusProbe(projectRoot, frameworkRoot);
  if (probe.status === 'not-configured') return;
  const rank = { unknown: 0, healthy: 1, warning: 2, error: 3 };
  if (rank[probe.checks.health] > rank[result.health.overall]) result.health.overall = probe.checks.health;
  for (const item of probe.deployment_verification.findings) {
    if (item.severity === 'info') continue;
    result.health.issues.push({
      severity: item.severity === 'blocking' ? 'error' : 'warning',
      message: `${item.provider}: ${item.message}`, action: item.remediation,
    });
  }
}
