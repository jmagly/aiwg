import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { loadRulePinConfigs, selectorKey, validateRulePinCapabilities } from '../../rules/pins.mjs';
import type { RulePinSelector } from '../../rules/inline-budget.mjs';

const usage = `Usage: aiwg rules pin|unpin [rule...] [--tier critical,high] [--capability id,... | --group name] [--all-tiers] [--all]
       aiwg rules pinned [--capability id] [--json]
       aiwg rules inventory|list [--scope workspace|user|installation|catalog] [--capability id,...] [--activation mode,...] [--tier level,...] [--provider name] [--bodies] [--json]
       aiwg rules group set <name> <capability>... | group list
Flags: --project (default), --user, --dry-run, --no-deploy, --json, --allow-over-budget
Pins and group changes validate every input without prompting. --dry-run prints effective rules and per-provider startup bytes.`;
const valueFlags = new Set(['--tier', '--capability', '--group', '--scope', '--activation', '--provider']);
const boolFlags = new Set(['--all-tiers', '--all', '--dry-run', '--no-deploy', '--json', '--allow-over-budget', '--user', '--project', '--help', '-h', '--bodies']);
function parse(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('-') || values.has(arg)) throw new Error(`${arg} requires one value`);
      values.set(arg, args[++i]);
    } else if (boolFlags.has(arg)) flags.add(arg);
    else if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (flags.has('--user') && flags.has('--project')) throw new Error('Choose --project or --user');
  const list = (flag: string) => values.get(flag)?.split(',').map(id => id.trim());
  return { values, flags, positional, list };
}

// Provider helpers log progress while assembling staged output. Keep the command's
// stdout a single JSON document (and keep temporary staging paths out of text output).
async function quietDeployment(deploy: (options: object) => Promise<unknown>, options: object): Promise<unknown> {
  const log = console.log;
  const warn = console.warn;
  try { console.log = () => {}; console.warn = () => {}; return await deploy(options); }
  finally { console.log = log; console.warn = warn; }
}

export const rulesHandler: CommandHandler = {
  id: 'rules', name: 'Rule pins', category: 'config', aliases: [],
  description: 'Pin rules to every request, inspect pins, and manage capability groups',
  async help() { return { exitCode: 0, message: usage, rawOutput: true }; },
  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const json = ctx.args.includes('--json');
    try {
      const { values, flags, positional, list } = parse(ctx.args);
      if (flags.has('--help') || flags.has('-h') || !positional.length) return { exitCode: 0, message: usage, rawOutput: true };
      const { rulePinState } = await import('../../rules/pin-state.js');
      const { setRuleConfigKey } = await import('../../config/cli.js');
      const [command, ...ids] = positional;
      if (command === 'inventory' || command === 'list') {
        if (ids.length || values.has('--group') || [...flags].some(flag => !['--json', '--bodies'].includes(flag))) throw new Error('inventory accepts only inventory filters and output flags');
        const scope = values.get('--scope') ?? 'workspace';
        if (!['workspace', 'user', 'installation', 'catalog'].includes(scope)) throw new Error('Invalid inventory scope');
        const activation = list('--activation');
        const tier = list('--tier');
        if (activation?.some(value => !['core', 'kernel', 'summary', 'bound', 'paths', 'on-demand'].includes(value))) throw new Error('Invalid activation filter');
        if (tier?.some(value => !['critical', 'high', 'medium', 'low'].includes(value))) throw new Error('Invalid tier filter');
        if (list('--capability')?.some(value => !value)) throw new Error('Invalid capability filter');
        const { ruleInventory } = await import('../../rules/inventory.js');
        const report = await ruleInventory(ctx.cwd, ctx.frameworkRoot, { scope: scope as 'workspace' | 'user' | 'installation' | 'catalog', capability: list('--capability'), activation, enforcement: tier, provider: values.get('--provider'), bodies: flags.has('--bodies') });
        return { exitCode: 0, rawOutput: true, message: json ? JSON.stringify(report, null, 2) :
          [`Scope: ${report.scope} (${report.scope_description})`, 'Per-rule delivery and session loading: unknown.', ...report.rules.map(rule => `${rule.capability}/${rule.name} [${rule.effective_activation ?? 'unconfigured'}, ${rule.enforcement ?? 'unknown'}; precedence: ${rule.precedence}; overridable: ${rule.overridable}; source: ${rule.precedence_source}; project context: ${rule.project_context}]: ${rule.summary ?? '(no summary)'}; ${rule.fetch_command ?? 'fetch ID unknown'}${rule.content ? `\n${rule.content}` : ''}`), ...report.warnings, ...(!report.rules.length ? ['No matching rules.'] : [])].join('\n') };
      }
      if (values.has('--scope') || values.has('--activation') || values.has('--provider') || flags.has('--bodies')) throw new Error('Inventory filters are only valid for rules inventory');
      const source = flags.has('--user') ? 'user' : 'project';
      const configs = loadRulePinConfigs(ctx.cwd);
      const before = rulePinState(ctx.cwd, ctx.frameworkRoot, configs, true);
      if (command === 'pinned') {
        if (ids.length || [...values.keys()].some(key => key !== '--capability')) throw new Error('pinned accepts only --capability and output/scope flags');
        const filter = list('--capability');
        if (filter?.some(id => !before.installed.includes(id))) throw new Error(`Unknown capability. Installed ids: ${before.installed.join(', ')}`);
        const rules = before.rules.filter(rule => !filter || filter.includes(rule.capability?.replace(/^(framework|addon|extension|plugin):/, '') || ''));
        return { exitCode: 0, message: json ? JSON.stringify({ rules, warnings: before.warnings }, null, 2)
          : [...rules.map(rule => `${rule.name}: pinned kernel (canonical ${rule.canonical_activation}) ${rule.matches.map(match => `${match.source}: ${JSON.stringify(match.selector)}`).join('; ')}`), ...before.warnings, ...(!rules.length ? ['No effective rule pins.'] : [])].join('\n'), rawOutput: true };
      }
      if (command === 'group' && ids[0] === 'list') {
        if (ids.length !== 1 || values.size) throw new Error('Usage: aiwg rules group list');
        const groups = { user: configs.user.rules?.pin_groups || {}, project: configs.project.rules?.pin_groups || {} };
        return { exitCode: 0, message: JSON.stringify(groups, null, 2), rawOutput: true };
      }
      const selected = configs[source];
      selected.rules = { ...selected.rules };
      if (command === 'group') {
        const [action, name, ...capabilities] = ids;
        if (action !== 'set' || !name || !capabilities.length || values.size) throw new Error('Usage: aiwg rules group set <name> <capability>...');
        selected.rules.pin_groups = { ...selected.rules.pin_groups, [name]: [...new Set(capabilities.flatMap(id => id.split(',')))].sort() };
      } else if (command === 'pin' || command === 'unpin') {
        if (flags.has('--all-tiers') && values.has('--tier')) throw new Error('--all-tiers and --tier are mutually exclusive');
        const selector: RulePinSelector = {};
        if (ids.length) selector.rules = [...new Set(ids)].sort();
        if (values.has('--tier')) selector.enforcement = list('--tier') as RulePinSelector['enforcement'];
        if (values.has('--capability')) selector.capabilities = list('--capability');
        if (values.has('--group')) selector.group = values.get('--group');
        if (flags.has('--all')) selector.all = true;
        if (!Object.keys(selector).length) throw new Error('Supply rule ids, --tier, --capability, --group, or --all');
        if (flags.has('--all-tiers') && !selector.capabilities && !selector.group && !selector.all) throw new Error('--all-tiers requires --capability, --group or --all');
        const existing = selected.rules.always_load || [];
        const key = selectorKey(selector);
        if (command === 'pin') {
          const unknown = ids.filter(id => !before.inventory.some(rule => [rule.name, rule.id, rule.path].includes(id)));
          if (unknown.length) throw new Error(`Unknown installed rule ids: ${unknown.join(', ')}`);
          selected.rules.always_load = existing.some(item => selectorKey(item) === key) ? existing : [...existing, selector];
        } else selected.rules.always_load = existing.filter(item => selectorKey(item) !== key);
      } else throw new Error(usage);
      // Only the edited scope is strict: stale pins in another scope remain visible warnings.
      const errors = validateRulePinCapabilities(selected.rules, before.installed, { ...configs.user.rules?.pin_groups, ...configs.project.rules?.pin_groups });
      if (errors.length) throw new Error(errors.join('\n'));
      const after = rulePinState(ctx.cwd, ctx.frameworkRoot, configs, true);
      const providers = [...new Set([...(configs.project.providers || []), ...Object.values(configs.project.installed || {}).flatMap(entry => Object.keys((entry as { deployedTo?: object }).deployedTo || {}))])];
      const reports: unknown[] = [];
      const failures: string[] = [];
      const plans: Array<{ deploy: (options: object) => Promise<unknown>; options: object }> = [];
      // Use precisely the installed rule inventory, including local bundles; do not select new capabilities.
      for (const provider of providers) {
        if (!['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'].includes(provider)) { failures.push(`Rule pin projection is unavailable for provider '${provider}'`); continue; }
        const module = await import(pathToFileURL(path.join(ctx.frameworkRoot, 'tools/agents/providers', `${provider}.mjs`)).href);
        const options = { srcRoot: path.join(ctx.frameworkRoot, 'agentic/code'), target: ctx.cwd, mode: 'all',
          ruleSources: after.inventory.map(rule => rule.path), config: configs.project, pinConfigs: configs,
          rulesOnly: true, deployRules: true, deploySkills: false, deployCommands: false,
          force: true, quiet: true, allowOverBudget: flags.has('--allow-over-budget') };
        try {
          const report = await quietDeployment(module.deploy, { ...options, dryRun: true, previewReport: true });
          reports.push(report);
          plans.push({ deploy: module.deploy, options });
        } catch (error) { failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (failures.length) throw new Error(failures.join('\n'));
      const dryRun = flags.has('--dry-run') || ctx.dryRun;
      if (!dryRun) {
        await setRuleConfigKey(ctx.cwd, source, 'rules', JSON.stringify(selected.rules));
        if (!flags.has('--no-deploy')) for (const plan of plans) await quietDeployment(plan.deploy, plan.options);
      }
      const redeploy = 'aiwg refresh --skip-update --force' + (flags.has('--allow-over-budget') ? ' --allow-over-budget' : '');
      const needsRedeploy = flags.has('--no-deploy') || plans.length === 0;
      const output = { dry_run: !!dryRun, source, rules: after.rules, warnings: after.warnings, providers: reports,
        deployed: !dryRun && !needsRedeploy, ...(needsRedeploy ? { redeploy } : {}) };
      return { exitCode: 0, message: json ? JSON.stringify(output, null, 2)
        : [dryRun ? 'Rule pin preview (config unchanged)' : 'Rule pins updated', ...after.rules.map(rule => `${rule.name}: kernel (canonical ${rule.canonical_activation})`),
          ...reports.map(report => { const r = report as { provider: string; selected_bytes: number }; return `${r.provider}: ${r.selected_bytes} startup bytes${(report as { exceeded: boolean }).exceeded ? ' (over budget; explicitly allowed)' : ''}`; }),
          ...after.warnings, ...(needsRedeploy ? [`Redeploy: ${redeploy}`] : [])].join('\n'), rawOutput: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, message: json ? JSON.stringify({ error: message }) : message, rawOutput: json };
    }
  },
};
