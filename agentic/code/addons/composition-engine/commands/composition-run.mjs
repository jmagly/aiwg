import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { executeFlowGraph, FlowGraphRuntimeError } from '../lib/runtime.mjs';

const VALUE_OPTIONS = new Set(['--format', '--adapter', '--checkpoint', '--resume', '--run-id']);

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function positional(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (VALUE_OPTIONS.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('-')) values.push(args[index]);
  }
  return values;
}

async function loadAdapter(adapterArg, context) {
  if (context.compositionAdapter) return context.compositionAdapter;
  if (!adapterArg) throw new FlowGraphRuntimeError(
    'ADAPTER_REQUIRED',
    'Execution requires --adapter <module.mjs> (or a host-provided compositionAdapter).',
  );
  const adapterPath = path.resolve(context.cwd, adapterArg);
  const module = await import(pathToFileURL(adapterPath).href);
  const adapter = module.default ?? module;
  if (typeof adapter.invokeNode !== 'function') {
    throw new FlowGraphRuntimeError('ADAPTER_INVALID', 'Composition adapter must export invokeNode(request).');
  }
  return adapter;
}

function formatHuman(report) {
  return [
    `FlowGraph ${report.graphId}: ${report.status}`,
    `Run: ${report.runId}`,
    `Stop reason: ${report.stopReason}`,
    `Resources: ${report.realizedResources.activations}/${report.requestedResources.activations} activations, `
      + `${report.realizedResources.tokens}/${report.requestedResources.tokens} tokens, `
      + `$${report.realizedResources.costUsd}/$${report.requestedResources.costUsd}`,
    `Output: ${report.output === undefined ? '(none)' : JSON.stringify(report.output)}`,
  ].join('\n');
}

export default async function compositionRun(args, context) {
  if (args.includes('--help') || args.includes('-h')) {
    return {
      exitCode: 0,
      message: [
        'Usage: aiwg composition run <manifest.yaml|json> --adapter <module.mjs> [options]',
        '',
        'Options:',
        '  --format human|json       Output format (default: human)',
        '  --run-id <id>             Stable run identity',
        '  --checkpoint <file.json>  Atomically save conductor-owned checkpoint projections',
        '  --resume <file.json>      Resume from a prior checkpoint projection',
        '',
        'The adapter exports invokeNode(request) and may export parallelDispatch and evaluatePredicate.',
      ].join('\n'),
    };
  }

  const [manifestArg] = positional(args);
  if (!manifestArg) return { exitCode: 2, message: 'Missing FlowGraph manifest path. Run with --help for usage.' };
  const format = option(args, '--format', 'human');
  if (!['human', 'json'].includes(format)) return { exitCode: 2, message: '--format must be human or json.' };

  try {
    const manifest = parseYaml(await fs.readFile(path.resolve(context.cwd, manifestArg), 'utf8'));
    const adapter = await loadAdapter(option(args, '--adapter'), context);
    const resumeArg = option(args, '--resume');
    const resumeFrom = resumeArg
      ? JSON.parse(await fs.readFile(path.resolve(context.cwd, resumeArg), 'utf8'))
      : undefined;
    const checkpointArg = option(args, '--checkpoint');
    const checkpointPath = checkpointArg ? path.resolve(context.cwd, checkpointArg) : undefined;
    const saveCheckpoint = checkpointPath
      ? async (checkpoint) => {
          await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
          const temporary = `${checkpointPath}.${process.pid}.tmp`;
          await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
          await fs.rename(temporary, checkpointPath);
        }
      : undefined;
    const report = await executeFlowGraph(manifest, {
      projectDir: context.cwd,
      runId: option(args, '--run-id'),
      adapterId: adapter.id ?? 'external',
      workerMode: adapter.workerMode,
      workerConsumer: adapter.workerConsumer,
      invokeNode: adapter.invokeNode,
      parallelDispatch: adapter.parallelDispatch,
      evaluatePredicate: adapter.evaluatePredicate,
      allowedCapabilities: adapter.allowedCapabilities,
      allowedPermissions: adapter.allowedPermissions,
      approvedGates: adapter.approvedGates,
      cancelledGates: adapter.cancelledGates,
      resumeFrom,
      saveCheckpoint,
    });
    return {
      exitCode: report.status === 'failed' ? 1 : 0,
      message: format === 'json' ? JSON.stringify(report, null, 2) : formatHuman(report),
    };
  } catch (error) {
    const report = {
      schemaVersion: 'flow.aiwg.io/v1alpha1',
      kind: 'FlowGraphRunReport',
      status: 'failed',
      code: error instanceof FlowGraphRuntimeError ? error.code : 'RUN_FAILED',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof FlowGraphRuntimeError ? { details: error.details } : {}),
    };
    return {
      exitCode: error instanceof FlowGraphRuntimeError && ['ADAPTER_REQUIRED', 'ADAPTER_INVALID'].includes(error.code) ? 2 : 1,
      message: format === 'json' ? JSON.stringify(report, null, 2) : `${report.code}: ${report.message}`,
    };
  }
}
