// Adapt the canonical wrapper enforcement report into additive offline doctor checks.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importImpl } from '../_resolve-impl.mjs';
import { readWrapperSettings } from './doctor-wrapper-settings.mjs';

export async function collectWrapperEnforcement({ projectDir, config, packageRoot, provider: selectedProvider,
  flagshipAllowlist = [] }) {
  const { wrapperEnforcementReport, deployedWrapperEnforcement, wrapperModelRisks, wrapperControls, GLOBAL_WRAPPER_SETTINGS } =
    await importImpl(import.meta.url, 'models/wrapper-enforcement.js');
  const { readModelWrapperArtifacts } = await importImpl(import.meta.url, 'models/wrapper-deployment.js');
  const { MODEL_WRAPPER_DEFINITIONS } = await importImpl(import.meta.url, 'models/wrapper-definitions.js');
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const { loadProviderModelCatalog } = await importImpl(import.meta.url, 'models/catalog-policy.js');
  const catalog = loadProviderModelCatalog();
  const locations = new ConfigLoader(projectDir).getLocations();
  const overrides = {};
  let defaults = {};
  const checks = [];
  try {
    for (const file of [locations.userConfig, locations.projectConfig]) {
      let content;
      try { content = await readFile(file, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const operator = JSON.parse(content);
      defaults = { ...defaults, ...operator.defaults };
      for (const [name, value] of Object.entries(operator.agentOverrides ?? {})) {
        overrides[name] = { ...overrides[name], ...value };
      }
    }
  } catch {
    checks.push({ name: 'Wrapper enforcement', status: 'warn', message: 'Operator election settings unavailable; review models.json with `aiwg models validate --all`.' });
  }
  for (const provider of [...new Set(config?.providers ?? [])].filter(name => !selectedProvider || name === selectedProvider)) {
    checks.push({ name: 'Wrapper enforcement', provider, status: 'info', message: `${provider}: ${wrapperEnforcementReport(provider)}` });
    try {
      const settings = await readWrapperSettings(provider, projectDir);
      const mod = await import(pathToFileURL(path.join(packageRoot, 'tools/agents/providers', `${provider}.mjs`)).href);
      const agents = (mod.default ?? mod).paths?.agents;
      const agentsPath = typeof agents === 'string' && agents ? path.resolve(projectDir, agents) : null;
      const artifacts = await readModelWrapperArtifacts(agentsPath);
      if (!artifacts.length && deployedWrapperEnforcement(provider, {}).model === 'global-only') {
        for (const wrapper of MODEL_WRAPPER_DEFINITIONS) artifacts.push({ wrapper, file: null, fields: null });
      }
      for (const { wrapper, fields, file } of artifacts) {
        const controls = wrapperControls(provider);
        const string = value => typeof value === 'string' ? value : value === undefined ? undefined : 'unresolved';
        const override = overrides[wrapper.name];
        const electedTier = override?.['model-tier'] ?? defaults.tier;
        const electedModel = catalog.providers[provider]?.tiers?.[electedTier === 'max-quality' ? 'flagship' : electedTier]?.id;
        const artifact = { ...settings, model: string(fields?.[controls.model ?? 'model']),
          effort: string(fields?.[controls.effort]), agentName: wrapper.name, flagshipAllowlist,
        };
        const resolvedModel = deployedWrapperEnforcement(provider, artifact).effectiveModel;
        if (resolvedModel && (override?.['model-override'] === resolvedModel || electedModel === resolvedModel)) {
          artifact.election = 'user';
        }
        const state = deployedWrapperEnforcement(provider, artifact);
        checks.push({ name: 'Wrapper enforcement', status: 'info', provider, wrapper: wrapper.name,
          file: file ? path.relative(projectDir, file) : null, modelEnforcement: state.model, effortEnforcement: state.effort,
          message: `${provider} ${wrapper.name}: ${wrapperEnforcementReport(provider, artifact)}` });
        // Without native wrapper controls, an unobserved session model is a support
        // limitation (reported above), not an unresolved pin on each wrapper.
        if (!controls.model && state.effectiveModel === undefined) continue;
        for (const id of wrapperModelRisks(provider, artifact)) {
          const remediation = `aiwg models resolve --agent ${wrapper.name} --provider ${provider} --tier standard`;
          const reason = id === 'delegation.flagship-inheritance'
            ? 'resolves to an unelected flagship or premium model'
            : 'has a placeholder or unresolved model value';
          checks.push({ name: id, id, provider, wrapper: wrapper.name, status: 'warn', remediation,
            message: `${provider} ${wrapper.name} ${reason}; run \`${remediation}\`, then set the concrete model in ${controls.model ? `${file} (${controls.model})` : (GLOBAL_WRAPPER_SETTINGS[provider] ?? 'the provider session model settings')}.` });
        }
      }
    } catch {
      checks.push({ name: 'Wrapper enforcement', status: 'warn', provider,
        message: `${provider}: deployed wrapper or native model settings unavailable; run \`aiwg models audit --all --provider ${provider}\`.` });
    }
  }
  return checks;
}
