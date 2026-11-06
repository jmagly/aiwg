import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectAiwgPath, projectAiwgWritePath } from '../config/project-artifacts.js';

export const PROVIDER_TRANSFORMATION_RECEIPT_SCHEMA = 'aiwg.provider-transformation-receipt.v1' as const;

export type ProviderDriftKind =
  | 'source-verification-failure'
  | 'transformation-mismatch'
  | 'user-modification'
  | 'stale-output'
  | 'missing-receipt'
  | 'policy-exempt'
  | 'source-evidence-unavailable';

export interface ProviderTransformationReceipt {
  schemaVersion: typeof PROVIDER_TRANSFORMATION_RECEIPT_SCHEMA;
  generatedAt: string;
  scope: 'project' | 'user';
  provider: string;
  source: {
    subject: string;
    sha256: string;
    verification: 'verified';
  };
  transformer: {
    id: string;
    version: string;
    providerAdapter: string;
    providerAdapterVersion: string;
  };
  outputs: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

export interface ProviderDriftFinding {
  kind: ProviderDriftKind;
  path?: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ProviderTransformationDiagnosis {
  status: 'verified' | 'drifted' | 'missing-receipt' | 'policy-exempt' | 'source-evidence-unavailable';
  receiptPath: string;
  checkedOutputs: number;
  findings: ProviderDriftFinding[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/;
const FILENAME_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function portableRelative(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`${label} must be a portable relative path`);
  }
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must not escape its portable root`);
  }
  return normalized;
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} contains a non-portable identifier`);
  return value;
}

function filenameSegment(value: string, label: string): string {
  if (!FILENAME_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a portable filename segment`);
  }
  return value;
}

function sha(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

async function readRegularOutput(root: string, relative: string): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const absolute = path.resolve(canonicalRoot, relative);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`receipt output '${relative}' must be a regular file and must not be a symbolic link`);
  }
  const canonicalOutput = await realpath(absolute);
  const containment = path.relative(canonicalRoot, canonicalOutput);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error(`receipt output '${relative}' resolves outside its configured root`);
  }
  return readFile(canonicalOutput);
}

export function providerTransformationReceiptPath(
  projectRoot: string,
  provider: string,
  scope: 'project' | 'user',
): string {
  filenameSegment(provider, 'provider');
  if (scope !== 'project' && scope !== 'user') throw new Error('scope must be project or user');
  return projectAiwgPath(projectRoot, 'receipts', 'providers', `${provider}.${scope}.json`);
}

export function validateProviderTransformationReceipt(value: unknown): ProviderTransformationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt must be an object');
  const receipt = value as ProviderTransformationReceipt;
  if (receipt.schemaVersion !== PROVIDER_TRANSFORMATION_RECEIPT_SCHEMA) throw new Error('unsupported receipt schema');
  if (!Number.isFinite(Date.parse(receipt.generatedAt))) throw new Error('generatedAt must be an RFC 3339 date-time');
  if (receipt.scope !== 'project' && receipt.scope !== 'user') throw new Error('scope must be project or user');
  filenameSegment(receipt.provider, 'provider');
  identifier(receipt.source?.subject, 'source.subject');
  sha(receipt.source?.sha256, 'source.sha256');
  if (receipt.source?.verification !== 'verified') {
    throw new Error('source.verification must be verified');
  }
  identifier(receipt.transformer?.id, 'transformer.id');
  identifier(receipt.transformer?.version, 'transformer.version');
  identifier(receipt.transformer?.providerAdapter, 'transformer.providerAdapter');
  identifier(receipt.transformer?.providerAdapterVersion, 'transformer.providerAdapterVersion');
  if (!Array.isArray(receipt.outputs) || receipt.outputs.length === 0) throw new Error('outputs must not be empty');
  const paths = new Set<string>();
  for (const [index, output] of receipt.outputs.entries()) {
    output.path = portableRelative(output.path, `outputs[${index}].path`);
    if (paths.has(output.path)) throw new Error(`duplicate output path '${output.path}'`);
    paths.add(output.path);
    sha(output.sha256, `outputs[${index}].sha256`);
    if (!Number.isSafeInteger(output.bytes) || output.bytes < 0) throw new Error(`outputs[${index}].bytes is invalid`);
  }
  receipt.outputs.sort((a, b) => a.path.localeCompare(b.path));
  return receipt;
}

export async function createProviderTransformationReceipt(options: {
  projectRoot: string;
  /** Filesystem root for emitted outputs; defaults to the project root. */
  outputRoot?: string;
  provider: string;
  scope: 'project' | 'user';
  generatedAt?: string;
  source: ProviderTransformationReceipt['source'];
  transformer: ProviderTransformationReceipt['transformer'];
  outputPaths: string[];
}): Promise<ProviderTransformationReceipt> {
  const outputs: ProviderTransformationReceipt['outputs'] = [];
  for (const raw of [...new Set(options.outputPaths)].sort()) {
    const relative = portableRelative(raw, 'output path');
    const bytes = await readRegularOutput(options.outputRoot ?? options.projectRoot, relative);
    outputs.push({ path: relative, sha256: digest(bytes), bytes: bytes.byteLength });
  }
  return validateProviderTransformationReceipt({
    schemaVersion: PROVIDER_TRANSFORMATION_RECEIPT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: options.scope,
    provider: options.provider,
    source: options.source,
    transformer: options.transformer,
    outputs,
  });
}

export async function writeProviderTransformationReceipt(
  projectRoot: string,
  receipt: ProviderTransformationReceipt,
): Promise<string> {
  validateProviderTransformationReceipt(receipt);
  const destination = projectAiwgWritePath(
    projectRoot, 'receipts', 'providers', `${receipt.provider}.${receipt.scope}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = validateProviderTransformationReceipt(JSON.parse(await readFile(destination, 'utf8')));
    const semantic = (value: ProviderTransformationReceipt) => JSON.stringify({ ...value, generatedAt: undefined });
    if (semantic(existing) === semantic(receipt)) return destination;
  } catch {
    // A missing or invalid prior receipt is replaced atomically below.
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function diagnoseProviderTransformationReceipt(options: {
  projectRoot: string;
  /** Filesystem root for emitted outputs; defaults to the project root. */
  outputRoot?: string;
  provider: string;
  scope: 'project' | 'user';
  source?: { sha256: string; verification: 'verified' | 'policy-exempt' | 'failed' };
  transformer?: ProviderTransformationReceipt['transformer'];
}): Promise<ProviderTransformationDiagnosis> {
  const receiptPath = providerTransformationReceiptPath(options.projectRoot, options.provider, options.scope);
  let receipt: ProviderTransformationReceipt;
  try {
    receipt = validateProviderTransformationReceipt(JSON.parse(await readFile(receiptPath, 'utf8')));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      status: missing ? 'missing-receipt' : 'drifted',
      receiptPath,
      checkedOutputs: 0,
      findings: [{
        kind: 'missing-receipt',
        message: missing
          ? 'No transformation receipt exists for this provider deployment.'
          : `The transformation receipt is unreadable or invalid: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const findings: ProviderDriftFinding[] = [];
  if (options.source?.verification === 'failed') {
    findings.push({ kind: 'source-verification-failure', message: 'The canonical source subject did not verify.' });
  } else if (options.source && options.source.sha256 !== receipt.source.sha256) {
    findings.push({
      kind: 'stale-output',
      message: 'The deployed output was generated from an older canonical source subject.',
      expected: options.source.sha256,
      actual: receipt.source.sha256,
    });
  }
  if (options.transformer) {
    for (const key of ['id', 'version', 'providerAdapter', 'providerAdapterVersion'] as const) {
      if (options.transformer[key] !== receipt.transformer[key]) {
        findings.push({
          kind: 'transformation-mismatch',
          message: `The recorded ${key} does not match the active transformer.`,
          expected: options.transformer[key],
          actual: receipt.transformer[key],
        });
      }
    }
  }
  for (const output of receipt.outputs) {
    try {
      const bytes = await readRegularOutput(options.outputRoot ?? options.projectRoot, output.path);
      const actual = digest(bytes);
      if (actual !== output.sha256 || bytes.byteLength !== output.bytes) {
        findings.push({
          kind: 'user-modification',
          path: output.path,
          message: 'A generated provider output differs from its recorded receipt.',
          expected: output.sha256,
          actual,
        });
      }
    } catch (error) {
      const unsafeType = error instanceof Error
        && (error.message.includes('must be a regular file') || error.message.includes('outside its configured root'));
      findings.push({
        kind: unsafeType ? 'user-modification' : 'stale-output',
        path: output.path,
        message: unsafeType
          ? 'A receipt-bound output was replaced by a symbolic link, non-regular file, or path outside its configured root.'
          : (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'A receipt-bound generated output is missing (partial deployment).'
          : `A receipt-bound generated output could not be read: ${error instanceof Error ? error.message : String(error)}`,
        expected: output.sha256,
      });
    }
  }
  return {
    status: findings.length === 0 ? 'verified' : 'drifted',
    receiptPath,
    checkedOutputs: receipt.outputs.length,
    findings,
  };
}
