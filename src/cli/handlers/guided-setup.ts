import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { decisionCapabilities } from '../../decision/driver.js';
import { ConfigLoader } from '../../models/config-loader.js';
import { inspectRecordedWorkerQualifications } from '../../models/worker-installation.mjs';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { readAiwgConfig, validateParallelismConfig } from '../../config/aiwg-config.js';
import { projectAiwgPath } from '../../config/project-artifacts.js';
import { discoverInventory } from '../../discovery/index.js';
import { buildInterviewPlan, credentialEnvName, credentialReference, INSTALL_METHOD_EXPLANATION,
  interviewProviders, interviewQuestions, mergeSetupAnswers, questionId, workspaceSlug,
  type InterviewContext, type InterviewQuestion } from '../../discovery/interview.js';
import { readSetupPlan, unansweredPlanChoices, writeSetupPlan } from '../../discovery/plan-store.js';
import type { CredentialReference, PlanValue, SetupAnswer, SetupPlan } from '../../discovery/plan-types.js';
import { assertPlanRedacted } from '../../discovery/plan-validation.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';
import { AiwgError, EXIT_CODES } from '../errors.js';
import { collectFlagValues, MissingFlagValueError, requireFlagValue } from '../flag-parsing.js';
import { askString, createPromptInterface } from '../prompt-utils.js';
import type { HandlerContext, HandlerResult } from './types.js';

export interface GuidedSetupFlags {
  scope?: 'project' | 'user';
  workspaces?: string[];
  monorepo?: 'root' | 'package';
  packageRoot?: string;
  scanRoots?: string[];
  intent?: 'code' | 'docs' | 'ops' | 'mixed';
  credentials: Record<string, CredentialReference>;
  jev?: 'enable' | 'decline' | 'defer';
  jevOptions?: PlanValue;
  enabled: boolean;
}
const NEW_FLAGS = ['--scope', '--workspace', '--monorepo', '--package', '--scan-roots', '--intent', '--credential', '--jev', '--region', '--endpoint'];
export function parseGuidedSetupFlags(args: readonly string[], command: 'init' | 'setup'): GuidedSetupFlags {
  const usable = (name: string, raw: string): string => {
    if (!raw.trim()) throw new MissingFlagValueError(name);
    return raw;
  };
  const value = (name: string): string | undefined => {
    const raw = requireFlagValue(args, { rejectEmpty: true }, name);
    return raw === undefined ? undefined : usable(name, raw);
  };
  const values = (name: string): string[] => collectFlagValues(args, { rejectEmpty: true }, name).map(raw => usable(name, raw));
  const enumeration = <T extends string>(name: string, options: readonly T[]): T | undefined => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    if (!(options as readonly string[]).includes(raw)) throw new Error(`${name} must be one of: ${options.join(', ')}`);
    return raw as T;
  };
  const jev = enumeration('--jev', ['enable', 'decline', 'defer']);
  const region = value('--region');
  const endpoint = value('--endpoint');
  const switches = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  const verify = switches.includes('--verify');
  const remove = switches.includes('--remove');
  const tokenStdin = switches.includes('--token-stdin');
  if ((jev === 'decline' || jev === 'defer' || remove) && (tokenStdin || region || endpoint || verify)) throw new Error('Jev decline/defer/remove cannot be combined with Jev enable options.');
  if (remove && jev === 'enable') throw new Error('--remove cannot be combined with --jev enable.');
  const jevOptions = region || endpoint || verify || remove ? { ...(region ? { region } : {}), ...(endpoint ? { endpoint } : {}), ...(verify ? { verify } : {}), ...(remove ? { remove } : {}) } : undefined;
  const scope = enumeration('--scope', ['project', 'user']);
  const intent = enumeration('--intent', ['code', 'docs', 'ops', 'mixed']);
  const monorepo = enumeration('--monorepo', ['root', 'package']);
  const packageRoot = value('--package');
  const workspaces = values('--workspace');
  const scanRoots = values('--scan-roots');
  const credentials: GuidedSetupFlags['credentials'] = {};
  for (const raw of values('--credential')) {
    const separator = raw.indexOf('=');
    const provider = raw.slice(0, separator) === 'jev' ? 'jev' : normalizeProviderDefinitionId(raw.slice(0, separator));
    if (separator < 1 || !provider || provider === 'generic') throw new Error('--credential requires a known <provider>=stdin|file:PATH|store:NAME|env:NAME.');
    credentials[provider] = credentialReference(raw.slice(separator + 1));
  }
  if (tokenStdin) {
    if (credentials.jev && credentials.jev.source !== 'stdin-at-apply') throw new Error('--token-stdin conflicts with --credential jev.');
    credentials.jev = credentialReference('stdin');
  }
  if (jevOptions) validateJevOptions(jevOptions);
  if (monorepo === 'package' && !packageRoot) throw new Error('--monorepo package requires --package <root>.');
  if (packageRoot && monorepo !== 'package') throw new Error('--package requires --monorepo package.');
  if (command === 'init' && (workspaces.length || monorepo || packageRoot || scanRoots.length)) {
    throw new Error('--workspace, --monorepo, --package and --scan-roots are available on setup.');
  }
  // The strict helpers honor the bare -- terminator, including malformed later occurrences.
  // Init opts into planning only through its documented selectors; Jev options are answers.
  const enabled = command === 'init' ? ['--scope', '--intent', '--credential'].some(name => value(name) !== undefined)
    : NEW_FLAGS.some(name => value(name) !== undefined) || tokenStdin || verify || remove;
  return { jev: jev ?? (remove ? 'decline' : undefined) ?? (tokenStdin || region || endpoint || verify ? 'enable' : undefined), jevOptions, scope, intent, monorepo, packageRoot, workspaces: workspaces.length ? workspaces : undefined,
    scanRoots: scanRoots.length ? scanRoots : undefined, credentials, enabled };
}

export interface GuidedSuppliedValues {
  providers?: string[];
  workerDispatch?: 'enable' | 'decline';
  scripts?: PlanValue;
  signing?: PlanValue;
  delivery?: PlanValue;
  tracker?: PlanValue;
  team?: PlanValue;
}
function existingValues(config: AiwgConfig | null): GuidedSuppliedValues {
  if (!config) return {};
  const { require_signed_commits, signing, committer: _committer, ...delivery } = config.delivery ?? {};
  const remotes = config.remotes;
  // Read only settings owned by these questions, never transport/auth configuration.
  const tracker = remotes ? Object.fromEntries(Object.entries({ primary: remotes.primary,
    issue_tracker: remotes.issue_tracker, issue_provider: remotes.issue_provider, ci: remotes.ci,
    customer_issue_tracker: remotes.customer_issue_tracker, customer_issue_provider: remotes.customer_issue_provider,
    tracker_actor_login: remotes.tracker_actor?.login, tracker_actor_via: remotes.tracker_actor?.via,
    customer_tracker_actor_login: remotes.customer_tracker_actor?.login, customer_tracker_actor_via: remotes.customer_tracker_actor?.via,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined)) : undefined;
  return { providers: config.providers,
    scripts: { defaultScripts: false, customScripts: true, scripts: config.scripts },
    ...(config.parallelism?.worker_dispatch === true ? { workerDispatch: 'enable' as const }
      : config.setup?.worker_dispatch_offer === 'declined' ? { workerDispatch: 'decline' as const } : {}),
    ...(require_signed_commits !== undefined || signing ? { signing: require_signed_commits === false ? false
      : Object.fromEntries(Object.entries({ required: require_signed_commits ?? false,
        format: signing?.format, key: signing?.key, enforce: signing?.enforce }).filter(([, value]) => value !== undefined)) as PlanValue } : {}),
    ...(Object.keys(delivery).length ? { delivery: delivery as unknown as PlanValue } : {}),
    ...(tracker ? { tracker } : {}),
  };
}
function answersFromValues(context: InterviewContext, values: GuidedSuppliedValues, flags: GuidedSetupFlags | undefined,
  source: SetupAnswer['source'], now: string, roots?: string[]): SetupPlan['answers'] {
  const answers: SetupPlan['answers'] = {};
  const put = (id: string, value: PlanValue | undefined): void => { if (value !== undefined) answers[id] = { value, source, answeredAt: now }; };
  if (flags) {
    put(questionId('targets', 'scope'), flags.scope);
    put(questionId('targets', 'workspaces', context.workspaceRoot), flags.workspaces);
    put(questionId('targets', 'scan-opt-in'), flags.scanRoots);
  }
  for (const project of context.inventory.projects) {
    const root = project.root;
    if (roots && !roots.includes(root)) continue;
    if (flags?.monorepo && ['monorepo', 'ambiguous'].includes(project.layout)) {
      const choice = flags.monorepo === 'root' ? 'root' : flags.packageRoot!;
      if (choice !== 'root' && !project.packageRoots.includes(choice)) throw new AiwgError({ code: 'ERR_INVALID_VALUE',
        exitCode: EXIT_CODES.USAGE, message: '--package must name an observed package root.' });
      put(questionId('targets', 'root', root), choice);
    }
    put(questionId('intent', 'use', root), flags?.intent);
    put(questionId('intent', 'team', root), values.team);
    if (values.providers) {
      // Explicit selection also records false for observed providers not selected.
      const candidates = interviewProviders(context);
      for (const provider of new Set([...candidates, ...values.providers])) put(questionId('tools', 'provider', root, provider), values.providers.includes(provider));
    }
    put(questionId('tools', 'worker-dispatch', root), values.workerDispatch);
    put(questionId('tools', 'scripts', root), values.scripts);
    if (flags?.jev !== 'defer') put(questionId('capabilities', 'jev', root),
      (flags?.jevOptions as Record<string, PlanValue> | undefined)?.remove === true ? 'remove' : flags?.jev);
    put(questionId('capabilities', 'jev-options', root, 'jev'), flags?.jevOptions);
    put(questionId('capabilities', 'signing', root), values.signing);
    put(questionId('capabilities', 'delivery', root), values.delivery);
    put(questionId('capabilities', 'tracker', root), values.tracker);
    for (const [provider, reference] of Object.entries(flags?.credentials ?? {})) put(questionId('locations', 'credential-source', root, provider), reference);
  }
  return answers;
}

function missingChoice(question: InterviewQuestion): Error {
  return new AiwgError({ code: 'ERR_MISSING_SETUP_CHOICE', exitCode: EXIT_CODES.USAGE,
    message: `Missing required choice '${question.questionId}': re-run with ${question.flag}` });
}
/** Jev uses the existing decision setup option names, with no credential bytes. */
export function validateJevOptions(value: PlanValue): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Jev settings must be an object.');
  const options = value as Record<string, PlanValue>;
  if (Object.keys(options).some(key => !['region', 'endpoint', 'verify', 'remove'].includes(key)) ||
    (options.region !== undefined && (typeof options.region !== 'string' || !options.region.trim())) ||
    (options.verify !== undefined && typeof options.verify !== 'boolean') ||
    (options.remove !== undefined && typeof options.remove !== 'boolean')) throw new Error('Invalid Jev setup settings.');
  if (options.endpoint !== undefined) {
    const url = new URL(String(options.endpoint));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Jev endpoint must be HTTPS without auth, query, or fragment.');
  }
}
/** Parse only the displayed value format. Invalid input never becomes an answer. */
export function parseInterviewAnswer(question: InterviewQuestion, raw: string): PlanValue {
  if (question.input === 'credential') return credentialReference(raw);
  if (raw === '') return question.default;
  if (question.input === 'boolean') {
    if (['true', 'yes', 'y'].includes(raw)) return true;
    if (['false', 'no', 'n'].includes(raw)) return false;
  } else if (question.input === 'roots') {
    if (raw === 'off') return [];
    const roots = raw.split(',').map(root => root.trim()).filter(Boolean);
    if (question.topic === 'workspaces' && !roots.every(root => question.options.some(o => o.value === root))) throw new Error('Select only observed workspace roots.');
    return roots;
  } else if (question.input === 'path') {
    if (isAbsolute(raw)) return raw;
  } else if (question.input === 'scripts') {
    if (['true', 'yes', 'y', 'false', 'no', 'n'].includes(raw)) return { defaultScripts: ['true', 'yes', 'y'].includes(raw), customScripts: false, scripts: {} };
    if (raw.startsWith('{')) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.defaultScripts === 'boolean' && typeof value.customScripts === 'boolean' &&
        value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts) &&
        Object.values(value.scripts).every(command => typeof command === 'string')) return value as PlanValue;
    }
  } else if (question.input === 'policy') {
    if (['false', 'no', 'n', 'decline'].includes(raw)) return false;
    if (question.topic === 'signing' && ['true', 'yes', 'y'].includes(raw)) return true;
    if (question.topic === 'tracker' && ['gitea', 'github', 'local'].includes(raw)) return { issue_provider: raw };
    // Structured policies share exactly the same JSON shape as flag answers.
    if (raw.startsWith('{')) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error('Invalid structured settings; enter a JSON object.'); }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (question.topic === 'jev-options') {
          validateJevOptions(value as PlanValue);
          if (Object.hasOwn(value, 'remove')) throw new Error('Use the explicit --remove flag to remove Jev setup.');
        }
        if (question.topic === 'worker-config') {
          if (Object.keys(value).some(key => !['clis', 'groups', 'admission', 'budgets'].includes(key)) || validateParallelismConfig(value).length) throw new Error('Invalid worker parallelism settings.');
        }
        return value as PlanValue;
      }
    }
  } else if (question.options.some(o => o.value === raw)) return raw;
  throw new Error(`Invalid answer for '${question.questionId}'; use one of the displayed options.`);
}

export interface InterviewSessionOptions {
  context: InterviewContext;
  answers: SetupPlan['answers'];
  previous?: SetupPlan;
  interactive: boolean;
  ask: (question: InterviewQuestion, current?: SetupAnswer) => Promise<string>;
  save: (plan: SetupPlan) => Promise<unknown>;
  now?: () => string;
  scan?: (roots: string[]) => Promise<InterviewContext['inventory']>;
  answersForInventory?: () => Promise<SetupPlan['answers']>;
  deferJev?: boolean;
  signal?: AbortSignal;
}
/** The caller owns interactivity. No stdio/environment checks or credential resolution here. */
export async function conductInterview(options: InterviewSessionOptions): Promise<{ plan: SetupPlan; cancelled: boolean }> {
  const now = options.now ?? (() => new Date().toISOString());
  let plan = buildInterviewPlan(options.context, options.answers, now(), options.previous);
  const visited = new Set<string>(options.deferJev ? plan.unresolvedChoices.filter(q => q.questionId.startsWith('capabilities.jev.')).map(q => q.questionId) : []);
  const history: string[] = [];
  let active: string | undefined;
  let block: string | undefined;
  let dirty = Object.keys(options.answers).length > 0;
  const save = async (): Promise<void> => {
    if (!dirty) return;
    await options.save(plan);
    dirty = false;
  };
  for (;;) {
    if (options.signal?.aborted) return { plan, cancelled: true };
    const questions = interviewQuestions(options.context, plan.answers);
    const unanswered = new Set(unansweredPlanChoices(plan).map(q => q.questionId));
    const deferred = new Set(plan.unresolvedChoices.filter(q => q.deferredAt && unanswered.has(q.questionId)).map(q => q.questionId));
    const queue = [...questions].sort((a, b) => Number(deferred.has(b.questionId)) - Number(deferred.has(a.questionId)));
    const question = active ? questions.find(q => q.questionId === active)
      : queue.find(q => unanswered.has(q.questionId) && !visited.has(q.questionId));
    active = undefined;
    if (!question) break;
    if (block && block !== question.block) await save();
    block = question.block;
    if (!options.interactive) {
      if (question.required) throw missingChoice(question);
      if (!question.optional) {
        plan.answers[question.questionId] = { value: question.default, source: 'default', answeredAt: now() };
        dirty = true;
      }
    } else {
      const raw = (await options.ask(question, plan.answers[question.questionId])).trim();
      if (raw === 'cancel') return { plan, cancelled: true };
      if (raw === 'back') {
        active = history.pop();
        continue;
      }
      if (raw.startsWith('edit ')) {
        const id = raw.slice(5).trim();
        if (!Object.hasOwn(plan.answers, id) || !questions.some(q => q.questionId === id)) throw new Error('Edit requires an answered question ID.');
        if (plan.answers[id].source === 'explicit-flag') throw new Error('An explicit flag takes precedence; change the flag to edit this answer.');
        active = id;
        continue;
      }
      if (raw === 'skip' || raw === 'defer' || (raw === '' && question.optional)) {
        // Revisiting an answered question and skipping keeps its previous answer.
        if (raw === 'defer' && !Object.hasOwn(plan.answers, question.questionId)) {
          plan.unresolvedChoices.find(q => q.questionId === question.questionId)!.deferredAt = now();
          dirty = true;
        }
      } else {
        let value = parseInterviewAnswer(question, raw);
        if (question.topic === 'scan-opt-in' && Array.isArray(value)) value = value.map(root => resolve(options.context.workspaceRoot, String(root)));
        const answer: SetupAnswer = { value, source: 'interview', answeredAt: now() };
        assertPlanRedacted({ answers: { [question.questionId]: answer } });
        plan.answers[question.questionId] = answer;
        if (question.topic === 'scan-opt-in' && Array.isArray(value) && value.length && options.scan) {
          options.context.inventory = await options.scan(value as string[]);
          if (options.answersForInventory) plan.answers = mergeSetupAnswers(plan.answers, await options.answersForInventory()).answers;
        }
        dirty = true;
      }
      history.push(question.questionId);
    }
    visited.add(question.questionId);
    plan = buildInterviewPlan(options.context, plan.answers, now(), plan);
  }
  // Flags are provisionally available to every observed root while the user can
  // still edit the workspace selection. Persist only the selected roots' answers
  // once the interview completes, just as prompting only visits those roots.
  const selectionId = questionId('targets', 'workspaces', options.context.workspaceRoot);
  const selected = plan.answers[selectionId]?.value;
  if (Array.isArray(selected)) {
    const unselected = options.context.inventory.projects.filter(project => !selected.includes(project.root))
      .map(project => `.ws-${workspaceSlug(project.root)}.`);
    const answers = Object.fromEntries(Object.entries(plan.answers).filter(([id]) =>
      id === selectionId || !unselected.some(slug => id.includes(slug))));
    if (Object.keys(answers).length !== Object.keys(plan.answers).length) {
      plan = buildInterviewPlan(options.context, answers, now(), plan);
      dirty = true;
    }
  }
  await save();
  const required = interviewQuestions(options.context, plan.answers).find(q => q.required && !Object.hasOwn(plan.answers, q.questionId));
  if (required) throw missingChoice(required);
  return { plan, cancelled: false };
}

export async function runGuidedSetup(ctx: HandlerContext, flags: GuidedSetupFlags, supplied: GuidedSuppliedValues,
  interactive: boolean, projectDir: string, unknownRemote = false, trackerRecommendation?: PlanValue): Promise<HandlerResult> {
  const absolute = (root: string): string => resolve(projectDir, root);
  if (flags.workspaces) flags.workspaces = flags.workspaces.map(absolute);
  if (flags.scanRoots) flags.scanRoots = flags.scanRoots.map(absolute);
  if (flags.packageRoot) flags.packageRoot = absolute(flags.packageRoot);
  const inventory = await discoverInventory({ workspaceRoot: projectDir, roots: flags.scanRoots });
  const workspaceRoot = inventory.projects.find(p => p.sources.includes('workspace'))?.root;
  if (!workspaceRoot) throw new Error('Discovery could not observe the workspace root.');
  if (flags.workspaces?.some(root => !inventory.projects.some(p => p.root === root))) throw new AiwgError({ code: 'ERR_INVALID_VALUE',
    exitCode: EXIT_CODES.USAGE, message: '--workspace must name an observed root; opt in with --scan-roots if needed.' });
  const force = ctx.args.includes('--force');
  const settings = await Promise.all(inventory.projects.map(async project => ({ root: project.root,
    values: existingValues(force ? null : await readAiwgConfig(project.root)) })));
  const context: InterviewContext = { inventory, workspaceRoot, unknownRemote, trackerRecommendation,
    providers: [...new Set([...settings.flatMap(s => s.values.providers ?? []), ...(supplied.providers ?? []), ...Object.keys(flags.credentials).filter(p => p !== 'jev')])] };
  context.jevStatus = {};
  context.qualifiedWorkers = {};
  // Observe existing metadata for A1's roots only. No driver import, auth read, or CLI probe.
  for (const root of new Set(inventory.projects.flatMap(project => [project.root, ...project.packageRoots]))) {
    try { context.jevStatus[root] = decisionCapabilities({ cwd: root, env: process.env }); }
    catch { /* An unavailable optional status must not block core setup. */ }
    try {
      const config = await readAiwgConfig(root);
      if (!config?.parallelism?.worker_dispatch) continue;
      const models = await new ConfigLoader(root).load(config.parallelism);
      if (!models.defaults.workerSelection) continue;
      const recorded = await inspectRecordedWorkerQualifications({ cwd: root, parallelism: config.parallelism,
        policy: models.defaults.workerSelection });
      context.qualifiedWorkers[root] = recorded.map(row => row.provider);
    } catch { context.qualifiedWorkers[root] = []; }
  }
  const id = `setup-${workspaceSlug(workspaceRoot)}`;
  let previous: SetupPlan | undefined;
  // Use A2's loader for every persisted snapshot; an unreadable or invalid plan is never replaced silently.
  try {
    await stat(projectAiwgPath(projectDir, 'setup', 'plans', `${id}.json`));
    previous = await readSetupPlan(projectDir, id);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const timestamp = new Date().toISOString();
  const retained = force ? {} : previous?.answers ?? {};
  const storedSettings = Object.assign({}, ...settings.map(setting =>
    answersFromValues(context, setting.values, undefined, 'existing-setting', timestamp, [setting.root]))) as SetupPlan['answers'];
  // An explicitly edited setting remains edited on resume. New settings still use normal precedence.
  for (const [id, answer] of Object.entries(retained)) if (answer.source === 'interview') delete storedSettings[id];
  const baseAnswers = mergeSetupAnswers(retained, storedSettings).answers;
  const explicitAnswers = answersFromValues(context, supplied, flags, 'explicit-flag', timestamp);
  for (const [id, answer] of Object.entries(explicitAnswers)) {
    const priorValue = baseAnswers[id]?.value;
    if (id.startsWith('capabilities.') && priorValue && typeof priorValue === 'object' && !Array.isArray(priorValue) &&
      answer.value && typeof answer.value === 'object' && !Array.isArray(answer.value)) answer.value = { ...priorValue, ...answer.value };
  }
  const answers = mergeSetupAnswers(baseAnswers, explicitAnswers).answers;
  let incompleteTracker: Record<string, PlanValue> | undefined;
  if (unknownRemote) {
    const trackerId = questionId('capabilities', 'tracker', workspaceRoot);
    const tracker = answers[trackerId]?.value;
    if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker) || !Object.hasOwn(tracker, 'issue_provider')) {
      if (!interactive) throw missingChoice(interviewQuestions(context, answers).find(q => q.topic === 'tracker')!);
      // A supplied remote name does not answer the unknown provider selection.
      if (tracker && typeof tracker === 'object' && !Array.isArray(tracker)) incompleteTracker = tracker as Record<string, PlanValue>;
      delete answers[trackerId];
      assertPlanRedacted(incompleteTracker);
    }
  }
  if (flags.jev === 'defer') {
    for (const project of inventory.projects) delete answers[questionId('capabilities', 'jev', project.root)];
    previous = buildInterviewPlan(context, answers, timestamp, previous);
    for (const choice of previous.unresolvedChoices) if (choice.questionId.startsWith('capabilities.jev.')) choice.deferredAt = timestamp;
  }
  let destination: string | undefined;
  const dryRun = ctx.dryRun || ctx.args.includes('--dry-run');
  const rl = interactive ? createPromptInterface() : undefined;
  try {
    if (interactive) console.log(INSTALL_METHOD_EXPLANATION);
    const result = await conductInterview({ context, answers, previous, interactive, deferJev: flags.jev === 'defer', signal: ctx.signal,
      scan: roots => discoverInventory({ workspaceRoot: projectDir, roots }),
      answersForInventory: async () => {
        const added = await Promise.all(context.inventory.projects.filter(project => !settings.some(setting => setting.root === project.root))
          .map(async project => ({ root: project.root, values: existingValues(force ? null : await readAiwgConfig(project.root)) })));
        settings.push(...added);
        context.providers = [...new Set([...(context.providers ?? []), ...added.flatMap(setting => setting.values.providers ?? [])])];
        return mergeSetupAnswers(...added.map(setting => answersFromValues(context, setting.values, undefined, 'existing-setting', new Date().toISOString(), [setting.root])),
          answersFromValues(context, supplied, flags, 'explicit-flag', new Date().toISOString())).answers;
      },
      ask: async (question, current) => {
        console.log(`${question.questionId}: ${question.explanation}`);
        if (question.topic === 'provider') {
          const tool = context.inventory.tools.find(t => t.executable === question.provider);
          console.log(`${question.provider}: installed=${tool?.installed ?? 'unknown'}, configured=${tool?.configured ?? 'unknown'}, authenticated=${tool?.authenticated ?? 'unknown'}, qualified=${tool?.qualified ?? 'unknown'}`);
        }
        if (question.input === 'credential') console.log(`${question.provider}: A4 provider credential; env:NAME (name suggestion ${credentialEnvName(question.provider!)}), file:/absolute/path, stdin [skip] [defer]`);
        else console.log(`Options: ${question.options.map(o => o.label).join(', ')}; default: ${JSON.stringify(question.default)}`);
        if (current) console.log(`Current: ${JSON.stringify(current.value)}`);
        const response = await askString(rl!, '[back | edit <question-id> | skip | defer | cancel] > ', 'cancel', ctx.signal);
        if (question.topic === 'tracker' && incompleteTracker && ['gitea', 'github', 'local'].includes(response)) {
          return JSON.stringify({ ...incompleteTracker, issue_provider: response });
        }
        return response;
      },
      save: async plan => { if (!dryRun) destination = await writeSetupPlan(projectDir, plan); },
    });
    if (ctx.args.includes('--json')) return { exitCode: 0, rawOutput: true, message: JSON.stringify(result.plan, null, 2) };
    return { exitCode: 0, message: result.cancelled ? 'Guided setup cancelled; last saved plan retained.'
      : dryRun ? 'Guided setup plan preview complete.' : destination ? `Saved setup plan: ${destination}` : 'Setup plan is unchanged.' };
  } finally { rl?.close(); }
}
