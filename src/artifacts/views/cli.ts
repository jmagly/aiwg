/**
 * `aiwg index views` subcommand router.
 *
 * Subcommands:
 *   add <name>          — scaffold a definition YAML interactively or via flags
 *   list                — list all views with freshness
 *   show <name>         — print stored results
 *   build [<name>]      — emit dispatch plan(s) for stale or named views
 *   remove <name>       — delete definition + results
 *
 * `build` does NOT directly invoke RLM. RLM dispatch is an agent skill
 * (/rlm-batch). This CLI prints a dispatch plan that the agent reads
 * and acts on, then writes the result back via putResult().
 *
 * @implements #1207
 */

import { join } from 'node:path';
import { computeHash } from '../../rlm/cache/hash.js';
import { parseViewYaml, validate, ViewValidationError } from './definition.js';
import {
  getDefinition,
  getResult,
  listViews,
  putDefinition,
  removeView,
  resolveViewsRoot,
} from './store.js';
import type { ViewBuildPlan, ViewDefinition } from './types.js';
import { readFileSync } from 'node:fs';

export async function main(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add':    handleAdd(rest);    break;
    case 'list':   handleList(rest);   break;
    case 'show':   handleShow(rest);   break;
    case 'build':  handleBuild(rest);  break;
    case 'remove': handleRemove(rest); break;
    default:
      printUsage();
      if (sub) throw new Error(`Unknown views subcommand: ${sub}`);
  }
}

function asJson(args: string[]): boolean {
  return args.includes('--json');
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function handleAdd(args: string[]): void {
  const fileFlag = flagValue(args, '--from');
  if (fileFlag) {
    const yaml = readFileSync(fileFlag, 'utf-8');
    let def: ViewDefinition;
    try {
      def = parseViewYaml(yaml);
    } catch (err) {
      console.error(err instanceof ViewValidationError ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const root = resolveViewsRoot();
    const path = putDefinition(root, def);
    console.log(`Added view '${def.name}' from ${fileFlag}`);
    console.log(`  Definition: ${path}`);
    return;
  }

  // Non-interactive add via flags: --name --producer --glob/--query/--neighbors-of --prompt --aggregate
  const name      = flagValue(args, '--name');
  const producer  = (flagValue(args, '--producer') ?? 'rlm-batch') as 'rlm-batch' | 'rlm-query';
  const prompt    = flagValue(args, '--prompt');
  const aggregate = (flagValue(args, '--aggregate') ?? 'concat') as
    | 'concat' | 'summarize' | 'filter-true' | 'filter-false' | 'json-merge';
  const glob        = flagValue(args, '--glob');
  const query       = flagValue(args, '--query');
  const neighborsId = flagValue(args, '--neighbors-of');

  if (!name || !prompt) {
    console.error('Usage: aiwg index views add --name <name> --prompt <prompt> [--producer rlm-batch] [--glob <p>|--query <q>|--neighbors-of <id>] [--aggregate <strategy>]');
    console.error('   or: aiwg index views add --from <path/to/view.yaml>');
    process.exitCode = 1;
    return;
  }

  const inputs: ViewDefinition['inputs'] = {};
  if (glob) inputs.glob = glob;
  else if (query) inputs.query = query;
  else if (neighborsId) {
    inputs.neighborsOf = {
      id:        neighborsId,
      depth:     parseInt(flagValue(args, '--depth') ?? '1', 10),
      direction: (flagValue(args, '--direction') as 'in' | 'out' | 'both') ?? 'both',
      ...(flagValue(args, '--graph') ? { graph: flagValue(args, '--graph') as string } : {}),
    };
  } else {
    console.error('Specify exactly one input source: --glob | --query | --neighbors-of');
    process.exitCode = 1;
    return;
  }

  let def: ViewDefinition;
  try {
    def = validate({
      name,
      producer,
      inputs: renderInputsForValidate(inputs),
      prompt,
      aggregate,
      refresh: { on_artifact_change: true, schedule: 'never', manual_only: false },
      output_format: 'json',
    });
  } catch (err) {
    console.error(err instanceof ViewValidationError ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const root = resolveViewsRoot();
  const path = putDefinition(root, def);
  console.log(`Added view '${def.name}'`);
  console.log(`  Definition: ${path}`);
  console.log('');
  console.log('Build with: aiwg index views build ' + def.name);
}

function renderInputsForValidate(inputs: ViewDefinition['inputs']): Record<string, unknown> {
  if (inputs.glob)  return { glob: inputs.glob };
  if (inputs.query) return { query: inputs.query };
  if (inputs.neighborsOf) {
    return {
      'neighbors-of': {
        id:        inputs.neighborsOf.id,
        depth:     inputs.neighborsOf.depth,
        direction: inputs.neighborsOf.direction,
        ...(inputs.neighborsOf.graph ? { graph: inputs.neighborsOf.graph } : {}),
      },
    };
  }
  return {};
}

function handleList(args: string[]): void {
  const root = resolveViewsRoot();
  const views = listViews(root);
  if (asJson(args)) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }
  if (views.length === 0) {
    console.log('No views defined.');
    console.log(`Views root: ${root}`);
    return;
  }
  console.log(`name                          producer    aggregate     status            built`);
  console.log(`────────────────────────────  ──────────  ────────────  ────────────────  ─────`);
  for (const v of views) {
    const status = v.staleReason ?? 'unknown';
    const built  = v.builtAt ? `${v.ageDays}d ago` : '—';
    console.log(
      `${v.name.padEnd(28).slice(0, 28)}  ${v.producer.padEnd(10)}  ${v.aggregate.padEnd(12)}  ${status.padEnd(16)}  ${built}`
    );
  }
  console.log(`\n${views.length} views at ${root}`);
}

function handleShow(args: string[]): void {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: aiwg index views show <name> [--json]');
    process.exitCode = 1;
    return;
  }
  const root = resolveViewsRoot();
  try {
    const r = getResult(root, name);
    if (asJson(args)) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`View:     ${r.name}`);
      console.log(`Built:    ${r.meta.builtAt}`);
      console.log(`Inputs:   ${r.meta.inputCount} (cache hits: ${r.meta.cacheHits}, misses: ${r.meta.cacheMisses})`);
      console.log(`Duration: ${r.meta.durationMs}ms`);
      console.log('');
      console.log(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2));
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

function handleBuild(args: string[]): void {
  const root = resolveViewsRoot();
  const named = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force');
  const json  = asJson(args);
  const targets = named
    ? [named]
    : listViews(root)
        .filter((v) => force || v.staleReason !== 'fresh')
        .map((v) => v.name);

  if (targets.length === 0) {
    console.log('No views need building. Use --force to rebuild all, or pass a name.');
    return;
  }

  const plans: ViewBuildPlan[] = [];
  for (const name of targets) {
    let def: ViewDefinition;
    try {
      def = getDefinition(root, name);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      continue;
    }
    const cacheKey = computeHash({
      inputs: [
        { artifactId: `view:${def.name}`, contentHash: 'pending' },
      ],
      query:             def.prompt,
      subPrompt:         def.prompt,
      model:             'claude-sonnet-5',
      aggregateStrategy: def.aggregate,
    });
    plans.push({
      name:       def.name,
      producer:   def.producer,
      inputs:     def.inputs,
      prompt:     def.prompt,
      aggregate:  def.aggregate,
      cacheKey,
      outputPath: join(root, 'results', `${def.name}.json`),
      metaPath:   join(root, 'results', `${def.name}.meta.json`),
    });
  }

  if (json) {
    console.log(JSON.stringify({ plans }, null, 2));
    return;
  }

  console.log('NOTE: This command emits dispatch plans. The RLM agent (/rlm-batch or /rlm-query)');
  console.log('reads the plan, runs the prompt against the input set, and writes results to outputPath.');
  console.log('');
  for (const p of plans) {
    console.log(`╭─ View: ${p.name}`);
    console.log(`│  Producer:   ${p.producer}`);
    console.log(`│  Inputs:     ${describeInputs(p.inputs)}`);
    console.log(`│  Aggregate:  ${p.aggregate}`);
    console.log(`│  Cache key:  ${p.cacheKey.slice(0, 16)}...`);
    console.log(`│  Output:     ${p.outputPath}`);
    console.log('╰─');
  }
  console.log('');
  console.log(`${plans.length} plan(s) emitted. Re-run with --json to consume programmatically.`);
}

function describeInputs(i: { glob?: string; query?: string; neighborsOf?: { id: string; depth: number; direction: string } }): string {
  if (i.glob) return `glob: ${i.glob}`;
  if (i.query) return `query: ${i.query}`;
  if (i.neighborsOf) return `neighbors-of: ${i.neighborsOf.id} (depth ${i.neighborsOf.depth}, ${i.neighborsOf.direction})`;
  return '<none>';
}

function handleRemove(args: string[]): void {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: aiwg index views remove <name>');
    process.exitCode = 1;
    return;
  }
  const root = resolveViewsRoot();
  const r = removeView(root, name);
  if (!r.defRemoved) {
    console.log(`No view named '${name}'.`);
    return;
  }
  console.log(`Removed view '${name}' (definition${r.resultRemoved ? ' + results' : ''})`);
}

function printUsage(): void {
  console.log('aiwg index views <subcommand>');
  console.log('');
  console.log('Subcommands:');
  console.log('  add --name <n> --prompt <p> [--glob <g>|--query <q>|--neighbors-of <id>] [--aggregate <s>] [--producer <rlm-batch|rlm-query>]');
  console.log('  add --from <path/to/view.yaml>');
  console.log('  list [--json]');
  console.log('  show <name> [--json]');
  console.log('  build [<name>] [--force] [--json]');
  console.log('  remove <name>');
}
