#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDocument, loadProtocol, validateContract } from '../lib/contracts.mjs';
import { targetPath, writeNew } from '../lib/workspace.mjs';
import { inventoryWorkspace, sampleFrame } from '../lib/inventory.mjs';
import { collectEvidence, verifyReceipt } from '../lib/collector.mjs';
import { createProtocol } from '../lib/profiles.mjs';
import { researchRecommendations } from '../lib/research.mjs';
import { createPlan, applyPlan, rollbackPlan } from '../lib/normalization.mjs';

export const COMMANDS = {
  init: 'Create a platform protocol for review', inventory: 'Hash source, configuration and candidate tests',
  sample: 'Draw a reproducible stratified review sample', collect: 'Collect runner discovery or execution evidence',
  assess: 'Assess current evidence and complete reviews', plan: 'Create a guarded normalization plan',
  apply: 'Apply a plan with a recovery journal', rollback: 'Restore an applied plan without overwriting drift',
  templates: 'List, develop or plan deployment of templates', research: 'Find corpus evidence and platform tools',
  validate: 'Validate an artifact against a strict schema', report: 'Render a conformance assessment',
};
const common = ['root', 'output', 'format'];
const allowed = {
  init: ['platform', 'system', 'name'], inventory: ['protocol'], sample: ['protocol', 'inventory', 'evidence', 'unit', 'seed', 'size'],
  collect: ['protocol', 'mode', 'lane', 'evidence', 'control'], assess: ['protocol', 'inventory', 'evidence', 'reviews', 'baseline'],
  plan: ['changes'], apply: ['plan', 'receipt'], rollback: ['receipt'],
  templates: ['action', 'platform', 'template', 'source', 'variables'], research: ['protocol', 'query'],
  validate: ['input', 'schema'], report: ['assessment'],
};
function options(args, command) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match || ![...common, ...allowed[command]].includes(match[1])) throw new Error(`Unknown argument: ${args[i]}`);
    const key = match[1]; const value = match[2] ?? args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'evidence' || key === 'reviews') (result[key] ??= []).push(value);
    else { if (key in result) throw new Error(`Duplicate --${key}`); result[key] = value; }
  }
  return result;
}
function required(opts, key) { if (!opts[key]) throw new Error(`Required --${key}`); return opts[key]; }
const json = value => JSON.stringify(value, null, 2) + '\n';
function markdown(value) {
  const { spec } = value;
  return `# Test conformance: ${spec.status}\n\nSnapshot: \`${spec.snapshotHash}\`\n\n` +
    spec.gates.map(g => `- **${g.status} — ${g.id}**: ${g.message}`).join('\n') +
    '\n\n' + (spec.limitations ?? []).map(l => `- ${l}`).join('\n') + '\n';
}
export async function execute(command, args, context = {}) {
  if (!command || command === '--help' || command === '-h' || args.includes('--help')) {
    return { exitCode: 0, text: 'aiwg test-conformance <command> [--root PATH] [--output FILE] [--format json|human]\n' + Object.entries(COMMANDS).map(([c,d]) => `  ${c.padEnd(12)} ${d}`).join('\n') + '\n' };
  }
  if (!COMMANDS[command]) throw new Error(`Unknown command: ${command}`);
  const opts = options(args, command);
  const root = await fs.realpath(path.resolve(context.cwd ?? process.cwd(), opts.root ?? '.'));
  const format = opts.format ?? 'json';
  if (!['json', 'human', ...(command === 'report' ? ['markdown'] : [])].includes(format)) throw new Error(`Unsupported format: ${format}`);
  const read = async relative => readDocument(await targetPath(root, relative));
  const protocol = async () => loadProtocol(await targetPath(root, opts.protocol ?? '.aiwg/testing/conformance.yaml'));
  let value; let exitCode = 0; let output = opts.output;
  switch (command) {
    case 'init':
      value = await createProtocol(root, opts); output ??= '.aiwg/testing/conformance.yaml'; break;
    case 'inventory':
      value = await inventoryWorkspace(root, await protocol()); exitCode = value.spec.complete ? 0 : 2; break;
    case 'collect': {
      const mode = opts.mode ?? 'execution';
      if (mode === 'controls') {
        if (opts.evidence?.length !== 1) throw new Error('Control collection requires one baseline --evidence receipt');
        const { collectControls } = await import('../lib/controls.mjs');
        value = await collectControls(root,await protocol(),{evidence:await read(opts.evidence[0]),lane:opts.lane ?? 'all',controlId:opts.control ?? null});
        exitCode = value.spec.status === 'passed' ? 0 : 2; break;
      }
      if (opts.control) throw new Error('--control only applies to --mode controls');
      if (!['discovery','execution'].includes(mode)) throw new Error('Mode must be discovery, execution or controls');
      value = await collectEvidence(root, await protocol(), {mode, lane: opts.lane ?? 'all'});
      exitCode = !value.spec.sourceStable || value.spec.diagnostics.length || value.spec.lanes.some(l => !l.process || l.process.exitCode !== 0 || l.process.reason !== 'exit' || l.process.signal || l.diagnostics.length || !l.normalized.complete || l.normalized.summary.failed || l.normalized.files.some(f => f.status === 'failed') || (l.coverage && !l.coverage.normalized.complete)) ? 2 : 0;
      break;
    }
    case 'sample': {
      const p = await protocol();
      const inv = await validateContract(await read(required(opts,'inventory')), 'test-inventory.v1');
      const current = await inventoryWorkspace(root, p);
      if (inv.spec.snapshotHash !== current.spec.snapshotHash || !inv.spec.complete) throw new Error('Inventory is incomplete or stale');
      const unit = opts.unit ?? 'test-file'; let records;
      if (unit === 'test-file') records = current.spec.files.filter(f => f.role === 'test').map(f => ({id:f.path,area:f.areas[0],path:f.path,hash:f.hash}));
      else if (unit === 'registered-case') {
        if (opts.evidence?.length !== 1) throw new Error('Registered-case sampling requires one discovery receipt');
        const receipt = await read(opts.evidence[0]);
        const verified = await verifyReceipt(root, p, receipt, {inventory:current});
        if (verified.length || receipt.spec.mode !== 'discovery' || receipt.spec.diagnostics.length || receipt.spec.lanes.some(l => !l.normalized.complete || !l.process || l.process.exitCode !== 0 || l.process.reason !== 'exit' || l.process.signal || l.diagnostics.length)) throw new Error('Discovery receipt is incomplete, stale or invalid');
        records = receipt.spec.lanes.flatMap(l => l.normalized.cases.map(c => {
          const file = current.spec.files.find(f => f.path === c.file && f.role === 'test');
          if (!file || file.areas.length !== 1) throw new Error(`Registered case has no unique inventoried area: ${c.id}`);
          return {...c,area:file.areas[0],hash:file.hash};
        }));
      } else throw new Error('Unit must be test-file or registered-case');
      value = sampleFrame(records,{seed:required(opts,'seed'),size:opts.size === undefined ? 20 : Number(opts.size),unit,populationHash:inv.spec.snapshotHash}); break;
    }
    case 'assess': {
      const { assessConformance } = await import('../lib/assessment.mjs');
      value = await assessConformance(root,await protocol(),{inventory:await read(required(opts,'inventory')),evidence:await Promise.all((opts.evidence ?? []).map(read)),reviews:await Promise.all((opts.reviews ?? []).map(read)),previous:opts.baseline ? await read(opts.baseline) : undefined});
      exitCode = value.spec.status === 'conformant' ? 0 : 2; break;
    }
    case 'plan': {
      const changes = await read(required(opts,'changes'));
      if (!changes || !Array.isArray(changes.edits) || typeof changes.purpose !== 'string' || Object.keys(changes).some(k => !['edits','purpose'].includes(k))) throw new Error('Changes must contain only edits and purpose');
      value = await createPlan(root,changes.edits,{purpose:changes.purpose}); break;
    }
    case 'apply': value = await applyPlan(root,await read(required(opts,'plan')),{receiptPath:opts.receipt}); break;
    case 'rollback': value = await rollbackPlan(root,await read(required(opts,'receipt')),{receiptPath:output}); output = undefined; break;
    case 'templates': {
      const templates = await import('../lib/templates.mjs');
      const action = required(opts,'action');
      if (action === 'list') value = await templates.listTemplates({platform:opts.platform});
      else if (action === 'develop') value = await templates.developTemplate(root,{source:required(opts,'source')});
      else if (action === 'deploy') value = await templates.deployTemplate(root,{platform:opts.platform,template:opts.template,source:opts.source,variables:opts.variables ? await read(opts.variables) : {}});
      else throw new Error('Template action must be list, develop or deploy');
      break;
    }
    case 'research': value = await researchRecommendations(root,await protocol(),{query:opts.query}); break;
    case 'validate': value = await validateContract(await read(required(opts,'input')),required(opts,'schema')); break;
    case 'report':
      value = await validateContract(await read(required(opts,'assessment')),'test-conformance-assessment.v1');
      exitCode = value.spec.status === 'conformant' ? 0 : 2; break;
  }
  const rendered = command === 'report' && format !== 'json' ? markdown(value) : json(value);
  if (output) await writeNew(root,output,rendered);
  return {exitCode,value,text:rendered};
}
export default async function main(args, context) {
  try { const result = await execute(context.subcommand,args,context); process.stdout.write(result.text); return {exitCode:result.exitCode}; }
  catch (error) { process.stderr.write(json({error:error.message,code:error.code ?? 'CONFORMANCE_ERROR',...(error.receipt ? {receipt:error.receipt} : {})})); return {exitCode:1}; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await main(process.argv.slice(3),{subcommand:process.argv[2],cwd:process.cwd()}); process.exitCode = result.exitCode;
}
