// Keep automatic redeployment from changing the explicitly installed selection.
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { REGISTRY_ID_TO_USE_NAME, frameworkRegistryId } from './framework-aliases.js';
import type { AiwgConfig } from './aiwg-config.js';

interface Selection {
  project: string;
  installed: AiwgConfig['installed'] | undefined;
}
const selection = new AsyncLocalStorage<Selection>();

export function withInstalledSelection<T>(
  project: string,
  installed: AiwgConfig['installed'] | undefined,
  deploy: () => Promise<T>,
): Promise<T> {
  return selection.run({ project: resolve(project), installed: structuredClone(installed) }, deploy);
}

export function preserveInstalledSelection(project: string, config: AiwgConfig): AiwgConfig {
  const current = selection.getStore();
  if (!current || current.project !== resolve(project)) return config;
  const guarded = { ...config };
  if (current.installed === undefined) delete (guarded as Partial<AiwgConfig>).installed;
  else guarded.installed = Object.fromEntries(Object.entries(current.installed).map(([id, entry]) => [
    id, structuredClone(config.installed?.[REGISTRY_ID_TO_USE_NAME[id] ?? id] ?? config.installed?.[id] ?? entry),
  ]));
  return guarded;
}

/** Automatic framework passes cannot reinstall a local bundle the operator undeclared. */
export function permitsBundleDeployment(project: string, id: string, provider: string): boolean {
  const current = selection.getStore();
  if (!current || current.project !== resolve(project) || current.installed === undefined) return true;
  const entry = Object.entries(current.installed).find(([key]) => frameworkRegistryId(key) === frameworkRegistryId(id))?.[1];
  return Boolean(entry?.deployedTo?.[provider]);
}
