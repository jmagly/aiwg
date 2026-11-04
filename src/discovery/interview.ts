import { evaluateWorkerDispatchOffer, knownWorkerCliExecutables } from '../models/worker-dispatch-offer.js';
import { createHash } from 'node:crypto';
import { isAbsolute, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getProviderDefinition, normalizeProviderDefinitionId, resolveProviderPathValue } from '../providers/provider-definitions.js';
import { assertPlanRedacted, validateSetupPlan } from './plan-validation.js';
import type { DiscoveryInventory } from './types.js';
import type { AnswerSource, CredentialReference, InventoryFact, PlannedAction, PlanValue, SetupAnswer,
  SetupPlan, SetupRecommendation, UnresolvedChoice } from './plan-types.js';

export const INTERVIEW_BLOCKS = ['targets', 'intent', 'tools', 'locations', 'capabilities'] as const;
export type InterviewBlock = typeof INTERVIEW_BLOCKS[number];
export interface InterviewQuestion extends UnresolvedChoice {
  explanation: string;
  block: InterviewBlock;
  topic: string;
  workspace?: string;
  provider?: string;
  flag: string;
  required: boolean;
  /** Optional choices do not become consent just because a default exists. */
  optional: boolean;
  input: 'choice' | 'boolean' | 'roots' | 'path' | 'credential' | 'scripts' | 'policy';
}
export const INSTALL_METHOD_EXPLANATION = 'Installing the aiwg CLI globally with npm updates it for every project; global provider config (--scope user) only changes one provider\'s user-level files.';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Roots come from discovery, which owns realpath canonicalization. No filesystem access here. */
export function workspaceSlug(canonicalRoot: string): string {
  // Leave room for the setup- prefix and hash inside the plan ID's 120 chars.
  const slug = posix.basename(canonicalRoot.replace(/\\/g, '/')).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 105) || 'workspace';
  return `${slug}-${hash(canonicalRoot).slice(0, 8)}`;
}
export function inventoryId(inventory: DiscoveryInventory): string {
  return `inv-${hash(JSON.stringify({ projects: inventory.projects.map(p => p.root).sort(),
    tools: inventory.tools.map(t => t.executable).sort(), limits: inventory.limits })).slice(0, 16)}`;
}
export function questionId(block: InterviewBlock, topic: string, root?: string, provider = 'shared'): string {
  return `${block}.${topic}.${root ? `ws-${workspaceSlug(root)}.` : ''}${provider}`;
}

const precedence: Record<AnswerSource, number> = {
  'explicit-flag': 5, 'existing-setting': 4, interview: 3, discovered: 2, default: 1,
};
/** Discovery is advisory even when it wins over a default. It is never an answer. */
export function mergeSetupAnswers(...layers: Record<string, SetupAnswer>[]): {
  answers: SetupPlan['answers']; recommendations: SetupRecommendation[];
} {
  const answers: SetupPlan['answers'] = {};
  const recommendations: SetupRecommendation[] = [];
  for (const layer of layers) for (const [id, answer] of Object.entries(layer)) {
    if (answer.source === 'discovered') {
      recommendations.push({ questionId: id, value: answer.value, reason: 'Observed by workspace discovery.' });
    } else if (!Object.hasOwn(answers, id) || precedence[answer.source] >= precedence[answers[id].source]) {
      answers[id] = answer;
    }
  }
  return { answers, recommendations };
}
export function isAnswered(plan: Pick<SetupPlan, 'answers'>, id: string): boolean {
  return Object.hasOwn(plan.answers, id);
}

export function credentialReference(input: string, paths: Pick<typeof import('node:path'), 'isAbsolute'> = { isAbsolute }): CredentialReference {
  let reference: CredentialReference;
  if (input === 'stdin') reference = { kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' };
  else if (input.startsWith('env:') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(input.slice(4))) {
    reference = { kind: 'credential-ref', source: 'env', name: input.slice(4) };
  } else if (input.startsWith('store:') && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.slice(6))) {
    reference = { kind: 'credential-ref', source: 'store', name: input.slice(6) };
  } else if (input.startsWith('file:') && paths.isAbsolute(input.slice(5))) {
    reference = { kind: 'credential-ref', source: 'file', name: input.slice(5) };
  } else throw new Error('--credential requires <provider>=stdin|file:PATH|store:NAME|env:NAME (file paths must be absolute).');
  assertPlanRedacted(reference);
  return reference;
}
export function credentialEnvName(provider: string): string {
  return provider === 'claude' ? 'ANTHROPIC_API_KEY' : provider === 'codex' ? 'OPENAI_API_KEY' : `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

export interface InterviewContext {
  inventory: DiscoveryInventory;
  workspaceRoot: string;
  /** Host path operations are injectable for cross-platform planning fixtures. */
  paths?: Pick<typeof import('node:path'), 'join' | 'isAbsolute'>;
  /** Additional canonical providers from flags or existing settings. */
  providers?: readonly string[];
  unknownRemote?: boolean;
  trackerRecommendation?: PlanValue;
  jevStatus?: Record<string, { enabled: boolean; backend: { status: string } }>;
  /** Historical qualification evidence, scoped to the workspace; launch revalidates. */
  qualifiedWorkers?: Record<string, string[]>;
}
export function interviewProviders(context: InterviewContext): string[] {
  return [...new Set(['claude', ...(context.providers ?? []),
    ...context.inventory.tools.map(t => normalizeProviderDefinitionId(t.executable))
      .filter((p): p is NonNullable<typeof p> => p !== null && p !== 'generic')])].sort();
}
export function interviewQuestions(context: InterviewContext, answers: SetupPlan['answers'] = {}): InterviewQuestion[] {
  const { inventory, workspaceRoot } = context;
  const paths = context.paths ?? { join, isAbsolute };
  const workerExecutables = new Set(knownWorkerCliExecutables());
  const questions: InterviewQuestion[] = [];
  const add = (block: InterviewBlock, topic: string, whyItMatters: string, defaultValue: PlanValue,
    values: PlanValue[], flag: string, input: InterviewQuestion['input'] = 'choice',
    workspace?: string, provider?: string, optional = false, required = false): void => {
    questions.push({ block, topic, questionId: questionId(block, topic, workspace, provider), workspace, provider,
      // The store's sensitive-assignment scan treats "credential from?" as a value.
      // Keep the full prompt in the presentation model and persist a safe purpose sentence.
      explanation: whyItMatters, whyItMatters: input === 'credential' ? "A4 reads the provider's credential." : whyItMatters,
      default: defaultValue, options: values.map(value => ({ label: typeof value === 'string' ? value : JSON.stringify(value), value })),
      flag, input, optional, required });
  };
  add('targets', 'scope', 'Project writes `.aiwg/` here; user writes your global provider config.', 'project', ['project', 'user'], '--scope project|user');
  add('targets', 'workspaces', 'Which observed roots get configured?', [workspaceRoot], inventory.projects.map(p => p.root), '--workspace <root>', 'roots', workspaceRoot);
  const selection = answers[questionId('targets', 'workspaces', workspaceRoot)]?.value ?? [workspaceRoot];
  const selected = Array.isArray(selection) ? selection : [];
  const projects = inventory.projects.filter(p => selected.includes(p.root)).sort((a, b) => a.root.localeCompare(b.root));
  for (const project of projects) if (['monorepo', 'ambiguous'].includes(project.layout)) {
    add('targets', 'root', 'Monorepo: configure the root once, or one package?', 'root', ['root', ...project.packageRoots],
      '--monorepo root|package --package <root>', 'choice', project.root, undefined, false, true);
  }
  add('targets', 'scan-opt-in', 'Also scan these extra directories (bounded)?', [], ['off'], '--scan-roots <dir>', 'roots', undefined, undefined, true);
  for (const project of projects) {
    add('intent', 'use', 'What will this workspace use AIWG for (code, docs, ops)? Drives framework/capability suggestions.', 'code', ['code', 'docs', 'ops', 'mixed'], '--intent code|docs|ops|mixed', 'choice', project.root);
    add('intent', 'team', 'Solo or shared repo? Shared repos keep force_push_policy=never.', 'solo', ['solo', 'shared'], '--force-push-policy <policy>', 'choice', project.root);
  }
  const providers = interviewProviders(context);
  for (const project of projects) {
    for (const provider of providers) add('tools', 'provider', 'Which provider toolchains does this project target?', provider === 'claude', [true, false], '--providers <list>', 'boolean', project.root, provider);
    add('tools', 'scripts', 'Add default scripts (deploy/doctor/sync)?', { defaultScripts: true, customScripts: false, scripts: {} }, [true, false], '--default-scripts true|false --script <name>=<command> --custom-scripts true|false', 'scripts', project.root);
  }
  for (const project of projects) for (const provider of providers) {
    if (answers[questionId('tools', 'provider', project.root, provider)]?.value !== true) continue;
    const target = answers[questionId('targets', 'root', project.root)]?.value;
    const targetRoot = typeof target === 'string' && target !== 'root' ? target : project.root;
    const configPath = (targetRoot === project.root ? project.providerFiles.find(f => f.provider === provider && f.kind === 'config')?.path : undefined)
      ?? (resolveProviderPathValue(getProviderDefinition(provider)?.paths.configFile ?? null, targetRoot, paths) || targetRoot);
    add('locations', 'config-dir', "Where this provider's config file lives (informational; A3 writes nothing).", configPath, [configPath], '--target <dir>', 'path', project.root, provider);
    add('locations', 'credential-source', "Where should A4 read this provider's credential from?", null,
      [{ kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' },
        { kind: 'credential-ref', source: 'file', name: paths.join(project.root, '.credentials', provider) },
        { kind: 'credential-ref', source: 'store', name: provider },
        { kind: 'credential-ref', source: 'env', name: credentialEnvName(provider) }], '--credential <provider>=stdin|file:PATH|store:NAME|env:NAME', 'credential', project.root, provider, true);
  }
  for (const project of projects) {
    const rootChoice = answers[questionId('targets', 'root', project.root)]?.value;
    const targetWorkspace = typeof rootChoice === 'string' && rootChoice !== 'root' ? rootChoice : project.root;
    const detected = inventory.tools.filter(t => t.installed === 'yes' && workerExecutables.has(t.executable));
    const dispatch = answers[questionId('tools', 'worker-dispatch', project.root)]?.value;
    if (evaluateWorkerDispatchOffer(undefined, dispatch === 'decline' ? { worker_dispatch_offer: 'declined' } : undefined,
      detected.map(t => t.executable)).shouldOffer || dispatch === 'enable') {
      // Keep A3's stable question ID while presenting the offer in optional capabilities.
      add('capabilities', 'worker-dispatch', `Direct workers use their own accounts' quota; shared quotaScope labels share limits. No daemon or scheduler is required. ${detected.map(t =>
        `${t.executable}: ${context.qualifiedWorkers?.[targetWorkspace]?.includes(t.executable) ? 'qualified (recorded evidence; launch rechecks)' : 'installed-not-qualified'}`).join('; ')}.`,
        false, ['enable', 'decline'], '--worker-dispatch enable|decline', 'choice', project.root, undefined, true);
      questions[questions.length - 1].questionId = questionId('tools', 'worker-dispatch', project.root);
    }
    if (dispatch === 'enable') {
      add('capabilities', 'worker-config', 'Optional worker paths (clis), model roles (groups), and limits (admission/budgets) as existing parallelism JSON; skip preserves current settings. Qualification runs only at apply.',
        null, [null], '--worker-dispatch enable (configure parallelism with aiwg config set)', 'policy', project.root, undefined, true);
    }
    const jev = answers[questionId('capabilities', 'jev', project.root)]?.value;
    const jevStatus = context.jevStatus?.[targetWorkspace];
    add('capabilities', 'jev', `Jev status: ${jevStatus ? jevStatus.enabled ? 'enabled' : 'off' : 'unknown'}; backend ${jevStatus?.backend.status ?? 'not-probed'}. Decisions are sent to an external service; a Jev account/API access and usage charges apply. Enable decision offload?`,
      false, ['enable', 'decline'], '--jev enable|decline|defer', 'choice', project.root, undefined, true);
    if (jev === 'enable') {
      add('capabilities', 'credential-source', 'Where should A4 read the Jev API input from? Enter a reference only; setup/defer works without an API input.', null,
        [{ kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' },
          { kind: 'credential-ref', source: 'file', name: paths.join(project.root, '.credentials', 'jev') },
          { kind: 'credential-ref', source: 'store', name: 'jev' }, { kind: 'credential-ref', source: 'env', name: 'JEV_API_KEY' }], '--credential jev=stdin|file:PATH|store:NAME|env:NAME', 'credential', project.root, 'jev', true);
      questions[questions.length - 1].questionId = questionId('locations', 'credential-source', project.root, 'jev');
      add('capabilities', 'jev-options', 'Optional Jev settings as JSON: region, endpoint, verify. Verification sends a billable request at apply.',
        null, [null], '--region <r> --endpoint <url> --verify', 'policy', project.root, 'jev', true);
    }
    add('capabilities', 'signing', 'Optional: require signed delivery commits? Signed local merges are recommended where permitted; skip preserves unsigned delivery. Set up with aiwg steward signed-merges.', false, [true, false], '--require-signed-commits --signing-format --signing-key --signing-enforce', 'policy', project.root, undefined, true);
    add('capabilities', 'delivery', 'Delivery mode and branch protections.', { mode: 'pr-required', force_push_policy: 'never' },
      [false, { mode: 'pr-required', force_push_policy: 'never' }], '--delivery-mode --default-branch --require-ci-green --auto-close-issues --issue-comment-on-cycle --force-push-policy', 'policy', project.root, undefined, true);
    add('capabilities', 'tracker', 'Issue tracker provider and remotes.', null,
      ['gitea', 'github', 'local'].map(issue_provider => ({ issue_provider })), '--issue-provider gitea|github|local', 'policy', project.root, undefined, !context.unknownRemote, !!context.unknownRemote);
  }
  return questions;
}

export function interviewRecommendations(context: InterviewContext): SetupRecommendation[] {
  const recommendations: SetupRecommendation[] = [];
  for (const project of [...context.inventory.projects].sort((a, b) => a.root.localeCompare(b.root))) {
    if (context.trackerRecommendation) recommendations.push({ questionId: questionId('capabilities', 'tracker', project.root),
      value: context.trackerRecommendation, reason: 'Detected repository remotes (provider and remote names only).' });
    for (const tool of context.inventory.tools) {
      const provider = normalizeProviderDefinitionId(tool.executable);
      if (provider && provider !== 'generic' && tool.installed === 'yes') recommendations.push({
        questionId: questionId('tools', 'provider', project.root, provider), value: true,
        reason: `PATH contains ${tool.executable}; installed=${tool.installed}, configured=${tool.configured}, authenticated=${tool.authenticated}, qualified=${tool.qualified}.`,
      });
    }
    for (const file of project.providerFiles.filter(f => f.kind === 'config')) recommendations.push({
      questionId: questionId('locations', 'config-dir', project.root, file.provider), value: file.path,
      reason: `Discovery observed a ${file.provider} config path.`,
    });
  }
  return recommendations.sort((a, b) => a.questionId.localeCompare(b.questionId));
}

/** Recompute only from current answers. Declines and unresolved optionals create no capability actions. */
export function buildInterviewPlan(context: InterviewContext, answers: SetupPlan['answers'], now: string, previous?: SetupPlan): SetupPlan {
  const paths = context.paths ?? { join, isAbsolute };
  const questions = interviewQuestions(context, answers);
  const workerExecutables = new Set(knownWorkerCliExecutables());
  const actions: PlannedAction[] = [];
  const scope = answers[questionId('targets', 'scope')]?.value === 'user' ? 'user' : 'project';
  const chosen = answers[questionId('targets', 'workspaces', context.workspaceRoot)]?.value;
  const add = (workspace: string, provider: string, kind: string, dependsOn: InventoryFact[]): void => {
    const base = `${provider}-${kind}-${workspaceSlug(workspace)}`;
    let id = base;
    for (let n = 2; actions.some(a => a.id === id); n++) id = `${base}-${n}`;
    actions.push({ id, workspace, provider, scope, kind, dependsOn });
  };
  for (const project of [...context.inventory.projects].sort((a, b) => a.root.localeCompare(b.root))) {
    if (!Array.isArray(chosen) || !chosen.includes(project.root)) continue;
    const rootChoice = answers[questionId('targets', 'root', project.root)];
    if (['monorepo', 'ambiguous'].includes(project.layout) && !Object.hasOwn(answers, questionId('targets', 'root', project.root))) continue;
    const workspace = typeof rootChoice?.value === 'string' && rootChoice.value !== 'root' ? rootChoice.value : project.root;
    const layout: InventoryFact = { kind: 'project', root: workspace, field: 'layout' };
    const path = (value: string): InventoryFact => ({ kind: 'path', workspace, path: value });
    // The selected package must itself be in A1's snapshot before A4 can apply it.
    const selectedProviders = questions.filter(q => q.workspace === project.root && q.topic === 'provider' && answers[q.questionId]?.value === true);
    for (const { provider } of selectedProviders) {
      const id = provider!;
      const executable = context.inventory.tools.find(tool => normalizeProviderDefinitionId(tool.executable) === id)?.executable ?? id;
      const tool = (field: 'installed' | 'version'): InventoryFact => ({ kind: 'tool', executable, field });
      const config = answers[questionId('locations', 'config-dir', project.root, id)]?.value;
      if (typeof config === 'string') add(workspace, id, 'configure-provider', [tool('installed'), path(config), layout]);
      add(workspace, id, 'verify-provider', [tool('version'), layout]);
      const intent = answers[questionId('intent', 'use', project.root)];
      const dispatch = answers[questionId('tools', 'worker-dispatch', project.root)];
      if ((intent && intent.source !== 'default') || dispatch?.value === 'enable') add(workspace, id, 'deploy-framework', [layout, tool('installed')]);
    }
    if (selectedProviders.length > 0) {
      add(workspace, 'shared', 'write-project-config', [path(paths.join(workspace, 'package.json')), layout, path(paths.join(workspace, '.aiwg', 'aiwg.config'))]);
      add(workspace, 'shared', 'register-project', [{ kind: 'project', root: workspace, field: 'root' }, path(paths.join(workspace, '.aiwg'))]);
    }
    const jevChoice = answers[questionId('capabilities', 'jev', project.root)]?.value;
    if (jevChoice === 'enable' || jevChoice === 'remove') {
      add(workspace, 'jev', 'configure-jev', [layout]);
    }
    if (answers[questionId('tools', 'worker-dispatch', project.root)]?.value === 'enable') {
      add(workspace, 'shared', 'configure-worker-dispatch', [layout, ...context.inventory.tools
        .filter(t => t.installed === 'yes' && workerExecutables.has(t.executable))
        .flatMap(t => [{ kind: 'tool' as const, executable: t.executable, field: 'installed' as const },
          { kind: 'tool' as const, executable: t.executable, field: 'path' as const }])]);
    }
    if (answers[questionId('tools', 'worker-dispatch', project.root)]?.value === 'decline') add(workspace, 'shared', 'record-decline', []);
  }
  const validIds = new Set(actions.map(a => a.id));
  const answerValues = (values: SetupPlan['answers']): Record<string, PlanValue> => Object.fromEntries(
    Object.entries(values).map(([id, answer]) => [id, answer.value]));
  const sameAnswers = previous && isDeepStrictEqual(answerValues(previous.answers), answerValues(answers));
  return validateSetupPlan({ schemaVersion: 1, id: previous?.id ?? `setup-${workspaceSlug(context.workspaceRoot)}`,
    inventoryId: inventoryId(context.inventory), createdAt: previous?.createdAt ?? now, updatedAt: now,
    inventory: context.inventory, answers: Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))), recommendations: interviewRecommendations(context),
    unresolvedChoices: questions.map(({ questionId, options, default: defaultValue, whyItMatters }) => {
      const deferredAt = previous?.unresolvedChoices.find(q => q.questionId === questionId)?.deferredAt;
      return { questionId, options, default: defaultValue, whyItMatters, ...(deferredAt ? { deferredAt } : {}) };
    }), actions, receipts: (sameAnswers ? previous.receipts : []).map(r => ({ ...r,
      actions: Object.fromEntries(Object.entries(r.actions).filter(([id]) => validIds.has(id) &&
        isDeepStrictEqual(previous?.actions.find(action => action.id === id), actions.find(action => action.id === id)))) })),
  });
}
