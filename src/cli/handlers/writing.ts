import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { parseWritingBrief, prepareWritingBrief, applyProofreadCorrections, writingBriefHash } from '../../writing/writing-brief.js';
import { assessWritingFidelity } from '../../writing/fidelity.js';
import { WriterProfileStore } from '../../writing/writer-profile-store.js';
import { compileWriterProfile } from '../../writing/writer-profile.js';
import { createWritingReceipt, writeWritingReceipt } from '../../writing/writing-receipt.js';
import { resolveOutputModes } from '../../output-modes/registry.js';
import { resolveProjectAiwgDirForWrite } from '../../config/project-artifacts.js';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { resolveArtifactOutputs, recordArtifactOutputProvenance } from '../../artifacts/output-policy.js';
import type { WritingChannel } from '../../writing/channel-packs.js';
import { campaignReport } from '../../writing/campaign-report.js';

async function execute(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.includes('--cross')) return { exitCode: 0, rawOutput: true, message: await campaignReport(ctx.cwd, ctx.args) };
  const [action, ...args] = ctx.args;
  if (!['plan', 'proofread'].includes(action)) throw new Error('Expected writing plan or proofread');
  const flags: Record<string, string> = {};
  const corrections: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index], value = args[++index];
    if (!['--brief', '--profile', '--channel', '--output', '--correction'].includes(key) || !value || value.startsWith('--')) throw new Error('Invalid writing command option');
    if (key === '--correction') corrections.push(value);
    else { if (flags[key]) throw new Error('Duplicate writing command option'); flags[key] = value; }
  }
  if (!flags['--brief'] || !flags['--profile']) throw new Error('--brief and --profile are required');
  const channel = flags['--channel'] ?? 'engineering';
  if (!['article', 'social', 'email', 'engineering', 'conversation'].includes(channel)) throw new Error('Unknown writing channel');
  const brief = parseWritingBrief(JSON.parse(await readFile(path.resolve(ctx.cwd, flags['--brief']), 'utf8')));
  const resolved = await resolveOutputModes(ctx.cwd, ctx.frameworkRoot, [`writer-${flags['--profile']}`]);
  const selected = resolved.modes.find(mode => mode.id === `writer-${flags['--profile']}`)!;
  if (!selected || !['project', 'user'].includes(selected.source)) throw new Error('A stored writer sidecar is required');
  const profile = await new WriterProfileStore({ cwd: ctx.cwd, scope: selected.source as 'project' | 'user' }).read(flags['--profile']);
  const compiled = compileWriterProfile(profile);
  let selectedCorrections: string[] = [];
  let output: string;
  let extension: string;
  let validators: Array<{ id: string; version: string; outcome: 'pass' }>;
  if (action === 'plan') {
    if (corrections.length) throw new Error('Correction selection is only valid for proofreading');
    output = JSON.stringify(prepareWritingBrief(brief, { profileId: profile.id, channel: channel as WritingChannel }), null, 2) + '\n';
    extension = 'json'; validators = [{ id: 'writing-brief-schema', version: '1', outcome: 'pass' }];
  } else {
    if (brief.operation !== 'proofread-only') throw new Error('Proofreading requires a proofread-only brief');
    selectedCorrections = corrections.length ? corrections : brief.permissions.corrections.map(correction => correction.id);
    const result = applyProofreadCorrections(brief, selectedCorrections);
    if (!result.valid) throw new Error('Authorized corrections require review');
    const original = brief.inputs.find(input => input.id === brief.sourceInputId)!.text;
    const selectedBrief = { ...brief, permissions: { ...brief.permissions, corrections: brief.permissions.corrections.filter(correction => selectedCorrections.includes(correction.id)) } };
    const fidelity = assessWritingFidelity(original, result.text, selectedBrief);
    if (fidelity.outcome === 'fail') throw new Error('Proofreading fidelity guard rejected the result');
    output = result.text; extension = 'txt';
    validators = [{ id: 'authorized-proofread-corrections', version: '1', outcome: 'pass' }];
    if (fidelity.outcome === 'pass') validators.push({ id: 'conservative-literal-review', version: '1', outcome: 'pass' });
  }
  const config = await readAiwgConfig(ctx.cwd);
  const destinations = resolveArtifactOutputs({ project: config?.artifact_outputs, supportedDestinations: ['local-file'], explicitDestinations: flags['--output'] ? ['local-file'] : [] });
  if (flags['--output'] && !destinations.presentations.includes('local-file')) throw new Error('Local presentation export is disabled by project artifact policy');
  if (ctx.dryRun) return { exitCode: 0, rawOutput: true, message: JSON.stringify({ valid: true, action, writes: false, selected: resolved.modes.map(mode => mode.id), modelExecution: 'none' }) };
  const id = `wr-${randomUUID()}`;
  const root = resolveProjectAiwgDirForWrite(ctx.cwd);
  const canonical = path.join(root, 'writing', 'outputs', `${id}.${extension}`);
  const receipt = createWritingReceipt({
    id, operation: brief.operation,
    profile: { id: profile.id, version: profile.version, revision: profile.revision, cacheEpoch: profile.cacheEpoch, compiledModeSha256: writingBriefHash(JSON.stringify(compiled.profile)), fallback: compiled.fallback },
    modes: resolved.modes.map(({ source: _source, sourcePath: _sourcePath, scope: _scope, ...mode }) => ({ id: mode.id, version: mode.version, profileSha256: writingBriefHash(JSON.stringify(mode)) })),
    state: { selected: resolved.modes.map(mode => mode.id), delivered: [], applied: [], validated: [], deliveredTo: 'none', fallback: 'none' },
    operationConfig: { action: action as 'plan' | 'proofread', correctionIds: selectedCorrections, channel: channel as WritingChannel },
    modelPrompt: { execution: 'none', promptSha256: writingBriefHash(JSON.stringify(brief)) },
    inputs: [{ id: 'brief', role: 'brief', sha256: writingBriefHash(JSON.stringify(brief)) }, ...brief.inputs.map(input => ({ id: `input-${writingBriefHash(input.id)}`, role: input.kind, sha256: input.sha256 }))],
    output: { sha256: writingBriefHash(output), path: canonical },
    budget: { limit: 0, used: 0, unit: 'tokens', measurement: 'exact', tokenizerId: 'no-model-call', tokenizerVersion: '1' },
    fallback: { applied: false }, validators, authorAcceptance: { status: 'pending' },
  });
  await mkdir(path.dirname(canonical), { recursive: true, mode: 0o700 });
  await writeFile(canonical, output, { flag: 'wx', mode: 0o600 });
  const recorded = await writeWritingReceipt(ctx.cwd, receipt);
  let presentation: string | undefined;
  if (flags['--output']) {
    presentation = path.resolve(ctx.cwd, flags['--output']);
    await writeFile(presentation, output, { flag: 'wx', mode: 0o600 });
    await recordArtifactOutputProvenance(root, { canonicalPath: canonical, presentationDestination: 'local-file', presentationReference: presentation, authority: 'explicit-task' });
  }
  return { exitCode: 0, rawOutput: true, message: JSON.stringify({ canonical, receipt: recorded.path, presentation, action, selected: resolved.modes.map(mode => mode.id), appliedModes: [], modelExecution: 'none', publicationApproval: false }) };
}

export const writingHandler: CommandHandler = {
  id: 'writing', name: 'Writing', description: 'Prepare grounded writing plans and apply authorized proofreading corrections', category: 'project', aliases: [],
  async help() { return { exitCode: 0, rawOutput: true, message: [
    'aiwg writing plan --brief <brief.json> --profile <id> [--channel article|social|email|engineering|conversation] [--output <new-file>]',
    'aiwg writing proofread --brief <brief.json> --profile <id> [--correction <id>]... [--output <new-file>]',
    'aiwg writing --cross [--json] <file-or-dir>...  Review one campaign without writing files',
    'Proofreading applies listed author-authorized corrections (all by default), without a model or voice rewrite.',
    'Canonical output and a receipt are written first. Optional local exports require a new file and project-policy allowance.',
    'Mode selections are inspected; this command does not claim provider response interception or publication approval.',
  ].join('\n') }; },
  async execute(ctx) { try { return await execute(ctx); } catch (error) { if (error instanceof RangeError && error.message.startsWith('Campaign exceeds')) return { exitCode: 1, message: error.message }; return { exitCode: 1, message: 'Writing operation failed. Check the brief, profile, correction IDs, output destination and artifact policy. Private source text is omitted; any completed canonical artifacts remain available.' }; } },
};
