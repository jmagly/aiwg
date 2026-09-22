import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CalibrationDigest, CalibrationGovernanceReceipt, CalibrationGovernanceReceiptDraft } from './types.js';

export class CalibrationGovernanceReceiptError extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): CalibrationDigest {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function validDigest(value: string): value is CalibrationDigest { return /^sha256:[0-9a-f]{64}$/.test(value); }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
function nonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new CalibrationGovernanceReceiptError(`${name} must not be empty`);
}

export function calibrationGovernanceReceiptDigest(
  receipt: Omit<CalibrationGovernanceReceipt, 'digest'>,
): CalibrationDigest {
  return digest(receipt);
}

export function createCalibrationGovernanceReceipt(draft: CalibrationGovernanceReceiptDraft): CalibrationGovernanceReceipt {
  const payload: Omit<CalibrationGovernanceReceipt, 'digest'> = {
    schemaVersion: 'decision-calibration-governance-receipt/v1', ...structuredClone(draft),
  };
  const receipt = { ...payload, digest: calibrationGovernanceReceiptDigest(payload) };
  validateCalibrationGovernanceReceipt(receipt);
  return immutable(receipt);
}

export function validateCalibrationGovernanceReceipt(receipt: CalibrationGovernanceReceipt): void {
  if (receipt.schemaVersion !== 'decision-calibration-governance-receipt/v1') throw new CalibrationGovernanceReceiptError('unsupported governance receipt schema');
  for (const [name, value] of Object.entries({ receiptId: receipt.receiptId, alias: receipt.alias,
    approvalReference: receipt.approvalReference, evaluationReportId: receipt.reviewedEvidence.evaluationIntegrityReport.id,
    calibrationArtifactId: receipt.reviewedEvidence.calibrationArtifact.id })) nonEmpty(value, name);
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) throw new CalibrationGovernanceReceiptError('sequence must be a positive safe integer');
  if (!Number.isSafeInteger(receipt.from.aliasRevision) || receipt.from.aliasRevision < 1
    || !Number.isSafeInteger(receipt.to.aliasRevision) || receipt.to.aliasRevision < 1) throw new CalibrationGovernanceReceiptError('alias revisions must be positive safe integers');
  if ((receipt.kind === 'promotion' ? 'promote' : 'rollback') !== receipt.action) throw new CalibrationGovernanceReceiptError('receipt kind and action must agree');
  if (!receipt.reasons.length || receipt.reasons.some(reason => !reason.trim())) throw new CalibrationGovernanceReceiptError('receipt reasons must be explicit');
  if (!Number.isFinite(Date.parse(receipt.recordedAt))) throw new CalibrationGovernanceReceiptError('recordedAt must be a valid date-time');
  const digests = [receipt.from.identityDigest, receipt.to.identityDigest,
    receipt.reviewedEvidence.evaluationIntegrityReport.digest, receipt.reviewedEvidence.calibrationArtifact.digest,
    receipt.reviewedEvidence.compatibilityRelation?.digest, receipt.previousReceiptDigest, receipt.digest].filter((item): item is CalibrationDigest => item !== null && item !== undefined);
  if (digests.some(item => !validDigest(item))) throw new CalibrationGovernanceReceiptError('receipt digests must be lowercase sha256 values');
  const { digest: claimed, ...payload } = receipt;
  if (claimed !== calibrationGovernanceReceiptDigest(payload)) throw new CalibrationGovernanceReceiptError('governance receipt digest mismatch');
}

/** Append-only, fsync-backed receipt ledger. A competing sequence writer fails closed. */
export class FileCalibrationGovernanceReceiptStore {
  constructor(private readonly directory: string) {}

  async readHistory(): Promise<CalibrationGovernanceReceipt[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const receiptNames = names.filter(name => /^\d{12}\.json$/.test(name)).sort();
    const history: CalibrationGovernanceReceipt[] = [];
    for (const [index, name] of receiptNames.entries()) {
      const receipt = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as CalibrationGovernanceReceipt;
      validateCalibrationGovernanceReceipt(receipt);
      if (receipt.sequence !== index + 1 || name !== `${String(receipt.sequence).padStart(12, '0')}.json`) throw new CalibrationGovernanceReceiptError('governance receipt sequence gap');
      const previous = history.at(-1);
      if (receipt.previousReceiptDigest !== (previous?.digest ?? null)) throw new CalibrationGovernanceReceiptError('governance receipt hash chain mismatch');
      history.push(receipt);
    }
    return structuredClone(history);
  }

  async append(receipt: CalibrationGovernanceReceipt): Promise<void> {
    validateCalibrationGovernanceReceipt(receipt);
    const history = await this.readHistory();
    if (receipt.sequence !== history.length + 1 || receipt.previousReceiptDigest !== (history.at(-1)?.digest ?? null)) {
      throw new CalibrationGovernanceReceiptError('receipt does not extend the current ledger head');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, `${String(receipt.sequence).padStart(12, '0')}.json`);
    let file;
    try { file = await open(target, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CalibrationGovernanceReceiptError('receipt sequence was concurrently claimed');
      throw error;
    }
    try { await file.writeFile(`${JSON.stringify(receipt)}\n`); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
