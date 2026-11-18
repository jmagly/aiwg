// Select registry authority for an unqualified deployment probe.
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { inspectUserRegistry } from '../../config/user-registry.js';
import { frameworkRegistryId } from '../../config/framework-aliases.js';
import type { DeploymentScope, UseDeploymentResult } from './deployment-verification.js';

/** An indexed selection still requires a valid index, but may own no provider payload. */
export async function deploymentIndexesOnly(projectRoot: string, provider: string, bundles: string[], scope: DeploymentScope = 'project'): Promise<boolean> {
  const config = await readAiwgConfig(projectRoot);
  const nativeInstalled = scope === 'user' ? (await inspectUserRegistry()).registry.installed : config?.installed;
  return bundles.length > 0 && bundles.every(bundle => {
    const flags = Object.entries(config?.installed ?? {}).find(([id]) => frameworkRegistryId(id) === frameworkRegistryId(bundle))?.[1].deployedTo[provider];
    const native = Object.entries(nativeInstalled ?? {}).find(([id]) => frameworkRegistryId(id) === frameworkRegistryId(bundle))?.[1].deployedTo[provider];
    return flags?.copy === false && native !== undefined && (['agents', 'commands', 'skills', 'rules'] as const).every(kind => !native[kind]);
  });
}

export async function deploymentProbeScope(
  projectRoot: string,
  explicitScope?: DeploymentScope,
): Promise<DeploymentScope> {
  if (explicitScope) return explicitScope;
  // A global (user-scope) install lives in the home directory. Other projects keep project
  // scope unless --scope user is passed, so a project without its own deployment is not
  // reported as a broken user deployment.
  const real = (dir: string) => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };
  if (real(projectRoot) !== real(os.homedir())) return 'project';
  const config = await readAiwgConfig(projectRoot);
  if (Object.values(config?.installed ?? {}).some(entry => Object.keys(entry.deployedTo ?? {}).length > 0)) {
    return 'project';
  }
  const user = await inspectUserRegistry();
  return Object.values(user.registry.installed).some(entry => Object.keys(entry?.deployedTo ?? {}).length > 0)
    ? 'user' : 'project';
}

export function deploymentProbeNextCommand(result: UseDeploymentResult, engaged: boolean, notConfigured: boolean): string | null {
  if (engaged) return null;
  if (notConfigured) return 'aiwg wizard --dry-run';
  const blocking = result.findings.filter(item => item.severity === 'blocking');
  if (result.scope === 'user' && blocking.length > 0 && blocking.every(item => item.id.startsWith('context-'))) {
    return result.providers.map(item => `aiwg regenerate --provider ${item.provider}`).join(' && ');
  }
  return `aiwg doctor --deployment${result.scope === 'user' ? ' --scope user' : ''}`;
}
