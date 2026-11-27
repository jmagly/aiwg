// Audit deployed agent and skill model inheritance offline, using existing election policy.
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { importImpl } from '../_resolve-impl.mjs';
import { readWrapperSettings } from './doctor-wrapper-settings.mjs';
import { collectWrapperEnforcement } from './doctor-wrapper-enforcement.mjs';

async function filesUnder(root) {
  if (!root) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

async function metadata(file) {
  try {
    const content = await readFile(file, 'utf8');
    if (file.endsWith('.toml')) return getStaticTOMLValue(parseTOML(content));
    if (file.endsWith('.json')) return JSON.parse(content);
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return frontmatter ? loadYaml(frontmatter[1]) : null;
  } catch { return null; }
}

async function operatorElections(projectDir) {
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const locations = new ConfigLoader(projectDir).getLocations();
  const overrides = {};
  let defaults = {};
  for (const file of [locations.userConfig, locations.projectConfig]) {
    let content;
    try { content = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const config = JSON.parse(content);
    defaults = { ...defaults, ...config.defaults };
    for (const [name, override] of Object.entries(config.agentOverrides ?? {})) {
      overrides[name] = { ...overrides[name], ...override };
    }
  }
  return { defaults, overrides };
}

export async function collectDelegationInheritance({ projectDir, config, packageRoot,
  provider: selectedProvider, flagshipAllowlist = [] }) {
  const { deployedWrapperEnforcement, wrapperModelRisks, isConcreteWrapperModel, wrapperControls } =
    await importImpl(import.meta.url, 'models/wrapper-enforcement.js');
  const { loadProviderModelCatalog } = await importImpl(import.meta.url, 'models/catalog-policy.js');
  const { flagshipElected } = await importImpl(import.meta.url, 'models/tiers.js');
  const { loadProviderModelCapabilities } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const catalog = loadProviderModelCatalog();
  const capabilities = loadProviderModelCapabilities();
  const checks = [];
  let elections;
  try { elections = await operatorElections(projectDir); }
  catch {
    elections = { defaults: {}, overrides: {} };
    checks.push({ id: 'delegation.election-settings', name: 'delegation.election-settings', status: 'warn',
      message: 'Operator election settings unavailable; no flagship exemptions applied.' });
  }
  for (const provider of [...new Set(config?.providers ?? [])].filter(p => !selectedProvider || selectedProvider === p)) {
    try {
      const mod = await import(pathToFileURL(path.join(packageRoot, 'tools/agents/providers', `${provider}.mjs`)).href);
      const native = mod.default ?? mod;
      const resolve = root => root ? path.resolve(projectDir, root) : null;
      const sources = [
        { kind: 'agent', root: resolve(native.paths?.agents) },
        ...[...new Set([mod.kernelSkillsPath, native.paths?.skills].filter(Boolean))]
          .map(root => ({ kind: 'skill', root: resolve(root) })),
      ];
      const settings = await readWrapperSettings(provider, projectDir);
      const skillSettings = await readWrapperSettings(provider, projectDir, 'skill');
      const controls = wrapperControls(provider);
      const seen = new Set();
      for (const { kind, root } of sources) {
        for (const file of await filesUnder(root)) {
          if (kind === 'skill' ? path.basename(file) !== 'SKILL.md'
            : !/\.(?:md|toml|json|yaml|yml)$/i.test(file)) continue;
          if (seen.has(file)) continue;
          seen.add(file);
          const name = kind === 'skill' ? path.basename(path.dirname(file))
            : path.basename(file).replace(/(?:\.agent)?\.[^.]+$/, '');
          const fields = await metadata(file);
          // commandHint.modelTier is dispatch intent; it does not pin the skill's native model.
          const rawModel = kind === 'skill' && capabilities.providers[provider]?.skill !== 'native'
            ? undefined : fields?.[controls.model ?? 'model'];
          const model = typeof rawModel === 'string' ? rawModel.trim() : undefined;
          const inherited = kind === 'skill' && fields?.context !== 'fork' ? skillSettings : settings;
          const artifact = { ...inherited, model, agentName: name, flagshipAllowlist };
          const state = deployedWrapperEnforcement(provider, artifact);
          const override = elections.overrides[name];
          const tier = override?.['model-tier'] ?? elections.defaults.tier;
          const electedModel = catalog.providers[provider]?.tiers?.[tier === 'max-quality' ? 'flagship' : tier]?.id;
          if (state.effectiveModel && (override?.['model-override'] === state.effectiveModel
            || electedModel === state.effectiveModel)) artifact.election = 'user';
          const risks = wrapperModelRisks(provider, artifact, catalog);
          // Missing pins are actionable only on native artifact controls. Global/session-only
          // providers are described by the wrapper support report, not N speculative warnings.
          const nativeModelControl = controls.model
            && (kind === 'agent' || capabilities.providers[provider]?.skill === 'native');
          if (!flagshipElected(artifact) && ((nativeModelControl && !isConcreteWrapperModel(state.effectiveModel))
            || risks.includes('delegation.flagship-inheritance'))) {
            const id = 'delegation.flagship-inheritance';
            checks.push({ id, name: id, status: 'warn', provider, kind, artifact: name,
              file: path.relative(projectDir, file), resolvedModel: state.effectiveModel ?? null,
              message: `${provider} ${kind} ${name} (${path.relative(projectDir, file)}): `
                + `resolved model ${state.effectiveModel ?? 'missing (session inheritance unknown)'} may inherit or select an unelected flagship; `
                + 'use an AIWG wrapper or an explicit standard-tier model. Native global settings may override artifact pins.' });
          }
        }
      }
    } catch {
      checks.push({ id: 'delegation.artifacts-unavailable', name: 'delegation.artifacts-unavailable', status: 'warn', provider,
        message: `${provider}: cannot audit deployed delegation artifacts or native model settings.` });
    }
  }
  return checks;
}

export async function collectDoctorModelChecks(options) {
  const wrappers = await collectWrapperEnforcement(options);
  const artifacts = await collectDelegationInheritance(options);
  return [...wrappers, ...artifacts.filter(row => !wrappers.some(wrapper =>
    wrapper.provider === row.provider && wrapper.wrapper === row.artifact && wrapper.id === row.id))];
}

export async function reportDoctorModels(projectDir, packageRoot, provider, detectProviders) {
  const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const configured = await readAiwgConfig(projectDir);
  const providers = provider ? [provider] : await detectProviders(configured);
  const config = { ...configured, providers };
  const checks = await collectDoctorModelChecks({ projectDir, packageRoot, provider, config });
  process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
}
