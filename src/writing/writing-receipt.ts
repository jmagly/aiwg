import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { integer, dateTime } from '../schema/zod-validation.mjs';
import { redactStructured } from '../governance/redaction.js';
import { resolveProjectAiwgDirForWrite } from '../config/project-artifacts.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const stableId = z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9.-]*$/).refine(value => !value.includes('..'));
const isoDate = dateTime();

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function receiptDigest(receipt: Omit<WritingReceipt, 'receiptSha256'>): string {
  return hash(JSON.stringify(canonicalize(receipt)));
}

function rejectSensitiveReceipt(value: unknown): void {
  const redacted = redactStructured(value);
  if (redacted.sensitivity !== 'none') throw new Error('Writing receipt contains a known secret or credential field');
}

const budgetSchema = z.strictObject({
  limit: integer().nonnegative(),
  used: integer().nonnegative(),
  unit: z.enum(['tokens', 'utf8-bytes', 'characters']),
  measurement: z.enum(['exact', 'upper-bound', 'estimated']),
  tokenizerId: z.string().min(1).max(120),
  tokenizerVersion: z.string().min(1).max(120),
}).refine(value => value.used <= value.limit, 'Budget use cannot exceed limit');

const operationConfigSchema = z.strictObject({
  action: z.enum(['plan', 'proofread', 'draft', 'edit', 'continue']),
  correctionIds: z.array(id).prefault([]),
  channel: z.enum(['article', 'social', 'email', 'engineering', 'conversation']).optional(),
  configSha256: sha.optional(),
});

const receiptInputBaseSchema = z.strictObject({
  schemaVersion: z.literal('aiwg.writing-receipt.v1').default('aiwg.writing-receipt.v1'),
  id: stableId.optional(),
  createdAt: isoDate.default(() => new Date().toISOString()),
  operation: z.enum(['draft-from-notes', 'edit-existing', 'proofread-only', 'continue-author-text']),
  profile: z.strictObject({
    id: stableId,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    revision: integer().positive(),
    cacheEpoch: integer().nonnegative(),
    compiledModeSha256: sha.optional(),
    fallback: z.boolean(),
  }),
  examples: z.strictObject({
    receiptSha256: sha.optional(),
    cacheKey: sha.optional(),
    selections: z.array(z.strictObject({ sampleId: id, sha256: sha })).prefault([]),
    budget: budgetSchema.optional(),
    fallback: z.boolean().default(false),
  }).optional(),
  modes: z.array(z.strictObject({
    id: stableId,
    version: z.string().min(1).max(120),
    profileSha256: sha.optional(),
  })).prefault([]),
  state: z.strictObject({
    selected: z.array(stableId).prefault([]),
    delivered: z.array(stableId).prefault([]),
    applied: z.array(stableId).prefault([]),
    validated: z.array(stableId).prefault([]),
    deliveredTo: z.enum(['local-transform-callback', 'none']),
    fallback: z.enum(['none', 'unaltered']),
  }).optional(),
  modelPrompt: z.strictObject({
    execution: z.enum(['none', 'local-callback', 'hosted']).default('none'),
    provider: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(120).optional(),
    promptSha256: sha,
    templateSha256: sha.optional(),
    decoding: z.strictObject({
      temperature: z.number().finite().min(0).max(2).optional(),
      topP: z.number().finite().min(0).max(1).optional(),
      maxOutputTokens: integer().positive().optional(),
      seed: integer().optional(),
      stopSha256: sha.optional(),
    }).optional(),
    promptConfigSha256: sha.optional(),
    hostedVersion: z.strictObject({
      attested: z.literal(false),
      reason: z.literal('Hosted provider prompt/version cannot be attested from this local receipt.'),
    }).optional(),
  }),
  inputs: z.array(z.strictObject({
    id,
    role: z.enum(['source', 'author-notes', 'existing-draft', 'brief', 'configuration']),
    sha256: sha,
  })).min(1),
  operationConfig: operationConfigSchema.optional(),
  output: z.strictObject({
    sha256: sha,
    path: z.string().min(1).max(2000).optional(),
  }).optional(),
  budget: budgetSchema,
  fallback: z.strictObject({
    applied: z.boolean(),
    reason: z.string().min(1).max(400).optional(),
  }),
  validators: z.array(z.strictObject({
    id,
    version: z.string().min(1).max(120),
    sha256: sha.optional(),
    outcome: z.enum(['pass', 'fail', 'uncertain', 'not-run']),
  })).prefault([]),
  evaluation: z.array(z.strictObject({
    id,
    method: z.string().min(1).max(120),
    sha256: sha,
    outcome: z.enum(['pass', 'fail', 'uncertain', 'not-established']),
  })).prefault([]),
  authorAcceptance: z.strictObject({
    status: z.enum(['accepted', 'pending', 'rejected', 'not-required']),
    acceptedAt: isoDate.optional(),
    acceptedBy: z.string().min(1).max(120).optional(),
  }),
});

const enforceReceiptRules = (value: z.infer<typeof receiptInputBaseSchema>, ctx: z.RefinementCtx): void => {
  if (new Set(value.inputs.map(input => input.id)).size !== value.inputs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input IDs must be unique' });
  }
  if (value.fallback.applied && !value.fallback.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fallback receipts require a reason' });
  }
  if (!value.fallback.applied && value.fallback.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fallback reason is only valid when fallback is applied' });
  }
  if (value.authorAcceptance.status === 'accepted' && (!value.authorAcceptance.acceptedAt || !value.authorAcceptance.acceptedBy)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted receipts require acceptedAt and acceptedBy' });
  }
  if (value.authorAcceptance.status !== 'accepted' && (value.authorAcceptance.acceptedAt || value.authorAcceptance.acceptedBy)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Acceptance identity is only valid for accepted receipts' });
  }
  if (new Set(value.modes.map(mode => mode.id)).size !== value.modes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode IDs must be unique' });
  }
  if (value.state) {
    const knownModes = new Set(value.modes.map(mode => mode.id));
    const stateGroups = [value.state.selected, value.state.delivered, value.state.applied, value.state.validated];
    if (stateGroups.some(group => new Set(group).size !== group.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode state IDs must be unique within each state set' });
    }
    if (stateGroups.some(group => group.some(modeId => !knownModes.has(modeId)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode state can reference only declared mode IDs' });
    }
    if (value.state.applied.some(modeId => !value.state!.delivered.includes(modeId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Applied modes must be a subset of delivered modes' });
    }
    if (value.state.validated.some(modeId => !value.state!.applied.includes(modeId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Validated modes must be a subset of applied modes' });
    }
    if (value.state.deliveredTo === 'none' && value.state.delivered.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No delivery target means no delivered modes' });
    }
    if (value.fallback.applied !== (value.state.fallback !== 'none')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode state fallback must agree with receipt fallback' });
    }
  }
  if (value.modelPrompt.execution !== 'hosted' && value.modelPrompt.hostedVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Hosted uncertainty is only valid for hosted execution receipts' });
  }
  if ((value.fallback.applied || value.state?.fallback !== 'none') && value.state && (value.state.applied.length > 0 || value.state.validated.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fallback receipts cannot report applied or validated modes' });
  }
};

const receiptInputSchema = receiptInputBaseSchema.superRefine(enforceReceiptRules);

export const writingReceiptSchema = receiptInputBaseSchema.extend({ id: stableId, operationConfig: operationConfigSchema, receiptSha256: sha }).superRefine(enforceReceiptRules);
export type WritingReceiptInput = z.input<typeof receiptInputSchema>;
export type WritingReceipt = z.infer<typeof writingReceiptSchema>;

export function createWritingReceipt(input: WritingReceiptInput): WritingReceipt {
  const parsed = receiptInputSchema.parse(input);
  const defaultAction = {
    'draft-from-notes': 'draft',
    'edit-existing': 'edit',
    'proofread-only': 'proofread',
    'continue-author-text': 'continue',
  }[parsed.operation] as WritingReceipt['operationConfig']['action'];
  const body = {
    ...parsed,
    id: parsed.id ?? `wr-${hash(JSON.stringify(canonicalize({ ...parsed, createdAt: undefined }))).slice(0, 24)}`,
    operationConfig: parsed.operationConfig ?? { action: defaultAction, correctionIds: [] },
    modelPrompt: parsed.modelPrompt.execution === 'hosted' && !parsed.modelPrompt.hostedVersion
      ? { ...parsed.modelPrompt, hostedVersion: { attested: false as const, reason: 'Hosted provider prompt/version cannot be attested from this local receipt.' as const } }
      : parsed.modelPrompt,
  };
  rejectSensitiveReceipt(body);
  const receiptSha256 = receiptDigest(body);
  return writingReceiptSchema.parse({ ...body, receiptSha256 });
}

export function validateWritingReceipt(value: unknown): WritingReceipt {
  const parsed = writingReceiptSchema.parse(value);
  const { receiptSha256, ...body } = parsed;
  if (receiptDigest(body) !== receiptSha256) throw new Error('Writing receipt integrity mismatch');
  rejectSensitiveReceipt(parsed);
  return parsed;
}

export function writingReceiptPath(cwd: string, receiptId: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(receiptId)) throw new Error('Invalid writing receipt ID');
  return join(resolveProjectAiwgDirForWrite(cwd), 'writing', 'receipts', `${receiptId}.json`);
}

export async function writeWritingReceipt(cwd: string, receiptInput: WritingReceipt): Promise<{ path: string; sha256: string }> {
  const receipt = validateWritingReceipt(receiptInput);
  const destination = writingReceiptPath(cwd, receipt.id);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(receipt, null, 2) + '\n';
  const existing = await readFile(destination, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    if (existing === payload) return { path: destination, sha256: hash(payload) };
    throw new Error('Writing receipt already exists with different content');
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const lock = `${destination}.lock`;
  let locked = false;
  try {
    await mkdir(lock, { mode: 0o700 });
    locked = true;
    await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
    const raced = await readFile(destination, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (raced !== null) {
      if (raced === payload) return { path: destination, sha256: hash(payload) };
      throw new Error('Writing receipt already exists with different content');
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
    if (locked) await rm(lock, { recursive: true, force: true });
  }
  return { path: destination, sha256: hash(payload) };
}

export async function readWritingReceipt(cwd: string, receiptId: string): Promise<{ receipt: WritingReceipt; path: string; sha256: string }> {
  const path = writingReceiptPath(cwd, receiptId);
  const payload = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Writing receipt is corrupt or not JSON');
  }
  return { receipt: validateWritingReceipt(parsed), path, sha256: hash(payload) };
}
