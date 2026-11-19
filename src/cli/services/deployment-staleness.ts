// Share refresh's read-only drift checks with status and doctor.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { lt, valid } from 'semver';
import { readAiwgConfig, type InstalledEntry, type AiwgConfig } from '../../config/aiwg-config.js';
import { readUserRegistry } from '../../config/user-registry.js';
import { checkManagedDeployment } from '../handlers/refresh-managed-deployment.js';
import type { DeploymentVerificationFinding, ProviderDeploymentVerification, VerifyProviderDeploymentOptions } from './deployment-verification.js';

export async function deploymentStaleness(options: Pick<VerifyProviderDeploymentOptions,
  'projectRoot' | 'frameworkRoot' | 'provider' | 'scope' | 'requestedBundles' | 'outputRoot'>,
  installedSnapshot?: Record<string, InstalledEntry>,
): Promise<DeploymentVerificationFinding[]> {
  const { provider, frameworkRoot } = options;
  const findings: DeploymentVerificationFinding[] = [];
  const remediation = `Run aiwg refresh --provider ${provider}${options.scope === 'user' ? ' --global' : ''} to refresh the managed deployment; review operator edits before replacing files.`;
  const advisory = (id: string, message: string) => findings.push({ id, provider, severity: 'advisory', message, remediation });
  let version: string;
  try { version = JSON.parse(await readFile(path.join(frameworkRoot, 'package.json'), 'utf8')).version; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return findings;
    advisory('deployment-staleness-unreadable', `Deployment freshness could not be checked: ${String(error)}`);
    return findings;
  }
  if (!valid(version)) return findings;
  const projectRoot = options.outputRoot ?? (options.scope === 'user' ? homedir() : options.projectRoot);
  try {
    const installed = installedSnapshot ?? (options.scope === 'user' ? await readUserRegistry() : await readAiwgConfig(options.projectRoot))?.installed;
    // Bundle manifest semver (e.g. utils 1.5.0) is independent of runtime CalVer.
    for (const bundle of options.requestedBundles) {
      const entry = installed?.[bundle];
      if (!entry || (entry.source && entry.source !== 'bundled') || !entry.version || !/^\d{4}\./.test(entry.version) || !valid(entry.version) || !lt(entry.version, version)) continue;
      advisory(`deployment-stale-bundle:${bundle}`, `Stale deployment: ${bundle} (v${entry.version} → v${version}) for ${provider}.`);
    }
    for (const item of await checkManagedDeployment({ projectRoot, frameworkRoot, provider, quiet: true, scope: options.scope })) {
      if (item.reason === 'missing' && !options.requestedBundles.some(bundle => ['all', 'utils', 'aiwg-hooks'].includes(bundle))) continue;
      advisory(`deployment-stale-managed:${item.file}:${item.name}`, `Stale deployment: ${item.reason} ${item.name} — ${item.file}`);
    }
    // Import lazily: refresh also owns the use handler, which consumes verification.
    const { detectStaleProviderTrees } = await import('../handlers/refresh.js');
    for (const tree of await detectStaleProviderTrees({ projectRoot, frameworkRoot, currentVersion: version })) {
      if (tree.provider !== provider) continue;
      advisory('deployment-stale-tree', `Stale ${provider} deployment: ${tree.total} AIWG-managed file(s) from v${tree.version}.`);
    }
  } catch (error) {
    advisory('deployment-staleness-unreadable', `Deployment freshness could not be checked: ${String(error)}`);
  }
  return findings;
}

export async function configuredDeploymentStaleness(projectRoot: string, frameworkRoot: string, snapshot?: AiwgConfig | null): Promise<DeploymentVerificationFinding[]> {
  const config = snapshot === undefined ? await readAiwgConfig(projectRoot) : snapshot;
  const installed = config?.installed ?? {};
  const providers = new Set([...(config?.providers ?? []), ...Object.values(installed).flatMap(entry => Object.keys(entry.deployedTo))]);
  const findings: DeploymentVerificationFinding[] = [];
  for (const provider of providers) {
    const requestedBundles = Object.keys(installed).filter(bundle => installed[bundle].deployedTo[provider]);
    if (!requestedBundles.length) continue;
    findings.push(...await deploymentStaleness({ projectRoot, frameworkRoot, provider, scope: 'project', requestedBundles }, installed));
  }
  return findings;
}

export async function withDeploymentStaleness(result: ProviderDeploymentVerification,
  options: Parameters<typeof deploymentStaleness>[0],
  installedSnapshot?: Record<string, InstalledEntry>,
): Promise<ProviderDeploymentVerification> {
  const stale = await deploymentStaleness(options, installedSnapshot);
  if (!stale.length) return result;
  const findings = [...result.findings, ...stale];
  const outcome = result.outcome === 'failed' ? 'failed' : 'degraded';
  return { ...result, outcome, findings, phases: result.phases.map(phase => {
    if (phase.id === 'deploy') return { ...phase, summary: `${phase.summary} Deployment freshness advisories need review.` };
    if (phase.id === 'verify') return { ...phase, summary: `${findings.filter(item => item.severity === 'blocking').length} blocking and ${findings.filter(item => item.severity === 'advisory').length} advisory finding(s).` };
    if (phase.id === 'report') return { ...phase, summary: `Final provider outcome: ${outcome}.` };
    return phase;
  }) };
}
