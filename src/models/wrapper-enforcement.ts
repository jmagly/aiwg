// Describes controls on deployed wrapper artifacts, distinct from headless CLI controls.
import { compileModelPolicy, loadProviderModelCatalog, type ProviderModelCatalog, type ModelPolicyProvider } from './catalog-policy.js';
import { MODEL_WRAPPER_DEFINITIONS, type ModelWrapperDefinition } from './wrapper-definitions.js';
import type { ModelEffort, ModelTier } from './types.js';
import { flagshipElected, isFlagshipModel, type FlagshipAuthority } from './tiers.js';
import { loadProviderModelCapabilities } from './provider-policy.js';

export type WrapperTierEnforcement = 'pinned' | 'inherited' | 'global-only';
export interface WrapperControls { model?: string; effort?: string }
const NATIVE_CONTROLS: Record<string, WrapperControls> = {
  claude: { model: 'model', effort: 'effort' },
  codex: { model: 'model', effort: 'model_reasoning_effort' },
  copilot: { model: 'model' }, cursor: { model: 'model' },
  factory: { model: 'model', effort: 'reasoningEffort' },
  opencode: { model: 'model' }, omp: { model: 'model', effort: 'thinkingLevel' },
};
export const GLOBAL_WRAPPER_SETTINGS: Record<string, string> = {
  hermes: 'Hermes config.yaml: delegation.model / delegation.effort',
  warp: 'Warp agent run --model <MODEL_ID> (run/profile-wide); effort: unavailable',
  muse: 'Muse --model / --reasoning-effort; $XDG_CONFIG_HOME/muse/settings.json model supplies the model fallback',
  grokbot: 'Grok Bot model: unavailable; effort: unavailable (no verified native setting in the provider catalog)',
};
const GLOBAL_ONLY = new Set(['warp', 'hermes', 'grokbot', 'muse']);

export function wrapperControls(provider: string): WrapperControls {
  return NATIVE_CONTROLS[provider] ?? {};
}

export function isConcreteWrapperModel(model: string | undefined): model is string {
  return Boolean(model?.trim() && !/^(?:configured\/|Hint\(|auto$|inherit(?:ed)?$|default$|profile-selected$|global-delegation-model$|unknown$|unresolved$|placeholder$|todo$)|\$\{|<[^>]+>/i.test(model.trim()));
}

export interface DeployedWrapperControls extends FlagshipAuthority {
  model?: string;
  effort?: string;
  inheritedModel?: string;
  inheritedEffort?: string;
  forceInheritedModel?: boolean;
}

/** Observed artifact controls, never a claim about an active provider session. */
export function deployedWrapperEnforcement(provider: string, artifact: DeployedWrapperControls) {
  const controls = wrapperControls(provider);
  const globalOnly = GLOBAL_ONLY.has(provider);
  const pinned = Boolean(controls.model && isConcreteWrapperModel(artifact.model) && !artifact.forceInheritedModel);
  const model: WrapperTierEnforcement = globalOnly ? 'global-only' : pinned ? 'pinned' : 'inherited';
  const effort: WrapperTierEnforcement = globalOnly ? 'global-only'
    : controls.effort && artifact.effort && loadProviderModelCapabilities().providers[provider as ModelPolicyProvider]?.effortValues?.includes(artifact.effort as ModelEffort) ? 'pinned' : 'inherited';
  return { model, effort, effectiveModel: pinned ? artifact.model : artifact.inheritedModel,
    effectiveEffort: effort === 'pinned' ? artifact.effort : artifact.inheritedEffort };
}

export function wrapperModelRisks(provider: string, artifact: DeployedWrapperControls,
  catalog = loadProviderModelCatalog()): string[] {
  const state = deployedWrapperEnforcement(provider, artifact);
  const findings: string[] = [];
  if ((artifact.model !== undefined && !isConcreteWrapperModel(artifact.model))
    || !isConcreteWrapperModel(state.effectiveModel)) findings.push('delegation.unresolved-model');
  const matches = (ids: Array<string | undefined>) => ids.filter(isConcreteWrapperModel)
    .some(id => state.effectiveModel === id || state.effectiveModel?.endsWith(`/${id}`));
  const flagship = !!state.effectiveModel && (isFlagshipModel(state.effectiveModel)
    || Object.values(catalog.providers).some(entry => matches([entry?.tiers?.flagship?.id])));
  const premium = !!state.effectiveModel && (Object.values(catalog.providers)
    .some(entry => matches([entry?.tiers?.premium?.id, entry?.roles.reasoning.id]))
    || (provider === 'claude' && state.effectiveModel === 'opus'));
  // Flagship always needs an operator election, pinned or not. Premium is a normal ladder tier
  // (the reasoning role's default), so it is a risk only when a wrapper inherits it.
  if ((flagship || (premium && state.model !== 'pinned')) && !flagshipElected(artifact)) {
    findings.push('delegation.flagship-inheritance');
  }
  return findings;
}

export function resolveWrapperPin(provider: ModelPolicyProvider, wrapper: ModelWrapperDefinition,
  options: { catalog?: ProviderModelCatalog; override?: string; effort?: ModelEffort } = {}) {
  const controls = wrapperControls(provider);
  const catalog = options.catalog ?? loadProviderModelCatalog();
  let tier: ModelTier = wrapper.tier;
  let role = wrapper.role;
  const compile = () => compileModelPolicy({ provider, artifact: 'agent', catalog,
    policy: { role, tier, effort: options.effort ?? wrapper.effort,
      ...(options.override ? { override: options.override } : {}) } });
  let policy = compile();
  // Auto can select a flagship; every economy wrapper needs the concrete fallback.
  if (controls.model && policy.effectiveModel === 'auto' && !options.override) {
    tier = 'standard';
    role = 'coding';
    policy = compile();
  }
  if (controls.model && options.override && !isConcreteWrapperModel(options.override)) {
    throw new Error(`${provider}: wrapper override must be a concrete model pin`);
  }
  const model = controls.model && isConcreteWrapperModel(policy.effectiveModel) ? policy.effectiveModel : undefined;
  const effort = model && controls.effort ? policy.fields[controls.effort] : undefined;
  if (model && controls.effort && !effort) throw new Error(`${provider}: unsupported wrapper effort`);
  return { tier, role, model, effort, controls,
    enforcement: (GLOBAL_ONLY.has(provider) ? 'global-only' : model ? 'pinned' : 'inherited') as WrapperTierEnforcement };
}

/** Static artifact defaults; this does not inspect live sessions or assert runtime enforcement. */
export function wrapperEnforcementReport(provider: string, artifact?: DeployedWrapperControls): string {
  const catalog = loadProviderModelCatalog();
  const controls = wrapperControls(provider);
  const known = provider in catalog.providers;
  const states = known ? MODEL_WRAPPER_DEFINITIONS.map(wrapper =>
    resolveWrapperPin(provider as ModelPolicyProvider, wrapper, { catalog }).enforcement) : [];
  const observed = artifact ? deployedWrapperEnforcement(provider, artifact) : undefined;
  const state: WrapperTierEnforcement = observed?.model ?? (GLOBAL_ONLY.has(provider) ? 'global-only'
    : states.length > 0 && states.every(value => value === 'pinned') ? 'pinned' : 'inherited');
  const effort = observed ? `${observed.effort}${observed.effort === 'pinned' ? ` via ${controls.effort}` : ''}` : state === 'pinned' && controls.effort
    ? `pinned via ${controls.effort} (high/medium/low by wrapper)` : 'not enforced per wrapper';
  const details: Record<string, string> = {
    claude: 'Use AIWG wrappers or an explicit invocation model. Unpinned general-purpose agents inherit; CLAUDE_CODE_SUBAGENT_MODEL supplies a fallback and CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 can override pins.',
    omp: 'Native model and thinkingLevel fields can pin exact operator role models; configured/* catalog entries are placeholders.',
    'grok-build': 'Grok Build 1.0.77: frontmatter model is ignored; agents inherit the session model. Select worker models with CLI -m; role/tier intent is informational.',
    openclaw: 'Markdown wrapper mirrors do not set native subagents.model or per-spawn overrides.',
    openhuman: 'User harness wrappers carry semantic model hints; project wrappers omit model. Neither is an exact pin.',
    antigravity: 'Wrapper mirrors do not project native CLI model/effort flags.',
    windsurf: 'Portable wrapper model selection is unsupported; the main UI session controls selection.',
    pi: 'Agents are reference skills; CLI model/thinking flags are separate from deployed wrappers.',
    'deepseek-harness': 'Agent references do not pin the configured Harness route.',
    hermes: 'All delegated workers share the provider delegation configuration.',
    warp: 'Model selection follows the Warp run/profile.',
    grokbot: 'No verified AIWG-owned per-worker model setting is available.',
    muse: 'Session --model or settings.json model controls selection; per-agent pins are unverified.',
  };
  return `Tier enforcement (${artifact ? 'deployed wrapper' : 'generated wrapper defaults'}): ${state}; effort: ${effort}. `
    + `${GLOBAL_WRAPPER_SETTINGS[provider] ? `${GLOBAL_WRAPPER_SETTINGS[provider]}. ` : ''}${details[provider] ?? (known ? 'Native custom subagents carry explicit catalog model selectors.' : 'Provider wrapper controls are unverified.')} `
    + 'Explicit operator pins are preserved where supported. This is not a live resolved-model audit; provider/account policy may substitute models.';
}
