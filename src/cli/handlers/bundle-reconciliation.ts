// Reconcile provider bundle declarations through the existing receipt removal path.
import { providerCopyMode } from '../../providers/deployment-preservation.mjs';
import { bundleDeploymentHistory, markBundleReconciled } from './bundle-deployment-mode.js';
import fs from 'node:fs';
import path from 'node:path';
import { readAiwgConfig, type AiwgConfig } from '../../config/aiwg-config.js';
import { REGISTRY_ID_TO_USE_NAME, frameworkRegistryId } from '../../config/framework-aliases.js';
import { getProviderArtifactPathStrings, PROVIDER_IDS } from '../../providers/provider-definitions.js';
import { deployedSkillRoots } from '../../providers/deployed-skill-roots.js';
import { pruneUndeclaredHashes } from './bundle-hash-prune.js';
import { removeBundledDeployment } from './remove-bundled.js';
import { frameworkAdditiveBundles } from './use-additive-bundles.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';

export const bundleUseName = (id: string) => REGISTRY_ID_TO_USE_NAME[id] ?? id;
export function bundleProviders(installed: AiwgConfig['installed'], id: string, requested?: string): string[] {
  const entry = Object.entries(installed).find(([key]) => frameworkRegistryId(key) === frameworkRegistryId(id))?.[1];
  return Object.keys(entry?.deployedTo ?? {}).filter(provider => !requested || requested.split(',').includes(provider));
}

function hasLegacyAllSelection(config: AiwgConfig, provider: string): boolean {
  const flags = config.installed.all?.deployedTo[provider];
  return provider !== 'flue' && flags !== undefined && flags.skipUtils === undefined && flags.kernelOnly === undefined;
}

export async function expectedBundleOwners(config: AiwgConfig, provider: string, frameworkRoot: string): Promise<Set<string>> {
  const selected = Object.keys(config.installed).filter(id => bundleProviders(config.installed, id, provider).length);
  const expected = new Set(selected.map(frameworkRegistryId));
  for (const id of selected) {
    if (!(id === 'all' || fs.existsSync(path.join(frameworkRoot, 'agentic/code/frameworks', frameworkRegistryId(id), 'manifest.json'))
      || ['writing', 'general'].includes(id))) continue;
    const flags = config.installed[id].deployedTo[provider];
    if (id === 'all' && provider !== 'flue' && (flags.skipUtils !== undefined || flags.kernelOnly !== undefined)) {
      // The composed pass owns outputs as `all`; expanding its scope must retain that owner.
      for (const name of fs.readdirSync(path.join(frameworkRoot, 'agentic/code/frameworks'))) {
        if (fs.existsSync(path.join(frameworkRoot, 'agentic/code/frameworks', name, 'manifest.json'))) expected.add(frameworkRegistryId(name));
      }
    }
    // Unknown history must retain the broader additive surface.
    const { addons, extensions } = await frameworkAdditiveBundles(frameworkRoot, provider, flags.skipUtils === true, flags.kernelOnly === true);
    for (const owner of [...addons, ...extensions]) expected.add(frameworkRegistryId(owner));
  }
  if (provider !== 'flue') for (const id of selected) {
    const addon = frameworkRegistryId(id);
    if (!fs.existsSync(path.join(frameworkRoot, 'agentic/code/addons', addon, 'manifest.json'))) continue;
    const { resolveRequiredAddonActivationOrder } = await import('./use.js');
    for (const owner of await resolveRequiredAddonActivationOrder(frameworkRoot, addon)) expected.add(frameworkRegistryId(owner));
  }
  return expected;
}

function receiptOwners(project: string, provider: string): Set<string> {
  const owners = new Set<string>();
  const visit = (file: string) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) visit(path.join(file, name)); return; }
    if (path.basename(file) !== '.aiwg-manifest.json') return;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of Object.values(receipt.managed ?? {}) as Array<{ owners?: string[]; frameworkSlug?: string }>) {
      for (const owner of record.owners ?? (record.frameworkSlug ? [record.frameworkSlug] : [])) owners.add(owner);
    }
  };
  const paths = Object.values(getProviderArtifactPathStrings(provider) ?? {}).filter(Boolean);
  // Never follow provider home paths during project reconciliation.
  const roots = paths.filter(dir => !path.isAbsolute(dir) && !dir.startsWith('~')).map(dir => path.join(project, dir.split(/[\\/]/)[0]));
  for (const root of new Set([...roots, ...deployedSkillRoots(project, provider).filter(dir => dir.startsWith(`${project}${path.sep}`))])) visit(root);
  // Flue's generated app modules live in the project-scoped receipt.
  if (provider === 'flue') visit(path.join(project, '.aiwg/.aiwg-manifest.json'));
  return owners;
}

export async function pruneUndeclaredBundles(project: string, config: AiwgConfig | null, requested?: string, dryRun = false, frameworkRoot?: string): Promise<number> {
  if (!config) return 0;
  if (requested?.split(',').some(provider => !getProviderArtifactPathStrings(provider))) {
    console.error(`Cannot reconcile unknown provider: ${requested}`);
    return 1;
  }
  const history = bundleDeploymentHistory(project);
  const hashPruned = await pruneUndeclaredHashes(project, config, requested, dryRun);
  let failures = 0;
  const knownProviders = [...new Set([...Object.keys(history), ...(config.providers ?? []), ...Object.values(config.installed).flatMap(entry => Object.keys(entry.deployedTo ?? {})),
    ...PROVIDER_IDS.filter(provider => fs.existsSync(path.join(project, `.${provider}`)))])];
  const providers = requested ? requested.split(',') : knownProviders;
  const root = frameworkRoot ?? await getFrameworkRoot();
  const expected = new Map<string, Set<string>>();
  for (const provider of new Set([...knownProviders, ...providers])) {
    if (getProviderArtifactPathStrings(provider)) expected.set(provider, await expectedBundleOwners(config, provider, root));
  }
  for (const provider of providers) {
    for (const owner of Object.keys(history[provider] ?? {})) {
      if (!history[provider][owner].reconciled && !bundleProviders(config.installed, owner, provider).length) expected.get(provider)?.delete(owner);
    }
    if (!getProviderArtifactPathStrings(provider)) continue;
    const selected = expected.get(provider)!;
    for (const owner of receiptOwners(project, provider)) {
      if (hashPruned.has(`${provider}:${owner}`) || hasLegacyAllSelection(config, provider) || selected.has(frameworkRegistryId(owner))) continue;
      const implicit = !history[provider]?.[frameworkRegistryId(owner)] && Object.values(history[provider] ?? {}).some(entry =>
        entry.produces?.includes(frameworkRegistryId(owner)) || entry.produces?.includes('*'));
      if (implicit) continue;
      if (providerCopyMode(project, provider, owner, config)) {
        console.log(`${bundleUseName(owner)} for ${provider}: kept (copy mode); run \`aiwg remove ${bundleUseName(owner)}\` to delete`);
        continue;
      }
      const otherProviders = [...expected].filter(([other, owners]) => other !== provider
        && (history[other]?.[frameworkRegistryId(owner)]?.copy || history[other]?.[frameworkRegistryId(owner)]?.package || owners.has(frameworkRegistryId(owner)) || hasLegacyAllSelection(config, other))).map(([other]) => other);
      const sharedRoots = deployedSkillRoots(project, provider).filter(root => otherProviders.some(other => deployedSkillRoots(project, other).includes(root)));
      console.log(`${dryRun ? 'Would remove' : 'Removing'} ${bundleUseName(owner)} for ${provider}`);
      // A temporary historical record supplies context for the public per-bundle
      // remover. --keep-registry leaves the operator's declaration byte-for-byte.
      const historical = structuredClone(config);
      historical.installed[owner] = { deployedTo: { [provider]: { agents: 0, commands: 0, skills: 0, rules: 0 } } };
      const result = await removeBundledDeployment(project, owner, owner, historical, [provider], { dryRun, keepRegistry: true, preserveRoots: sharedRoots, includeProject: !otherProviders.length });
      if (result.message) console.log(result.message);
      if (result.exitCode) failures++;
      else if (!dryRun) markBundleReconciled(project, owner, provider);
    }
  }
  return failures;
}

// Root collectors can recreate additive copies; enforce a recorded restricted scope last.
export async function pruneAfterScopedDeployments(project: string, config: AiwgConfig | null, requested?: string, frameworkRoot?: string): Promise<number> {
  const restricted = Object.values(config?.installed ?? {}).some(entry => Object.entries(entry.deployedTo).some(([provider, flags]) =>
    (!requested || requested.split(',').includes(provider)) && (flags.skipUtils === true || flags.kernelOnly === true)));
  return restricted ? pruneUndeclaredBundles(project, await readAiwgConfig(project), requested, false, frameworkRoot) : 0;
}
