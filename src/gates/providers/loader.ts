import { signalChild } from '../../process/signal-child.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync, lstatSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GateProviderEntrySchema, type GateProviderEntry } from '../../extensions/manifest.js';
import { artifactDigest } from '../../decision/validate.js';
import { providerSourceDigest } from './types.js';
import type { BundleMetricProvider } from './types.js';
import type { GateMetricsDocument, ProviderAllowlistEntry, Sha256Digest } from '../types.js';
import { ISOLATED_CHILD_SOURCE } from './isolated-child-source.js';
import { positiveTimeoutMs } from '../../process/bounded-child-process.mjs';

export type { BundleMetricProvider } from './types.js';

/**
 * Addon/extension metric-provider loading, isolated rework (P1-P5).
 *
 * Providers run ONLY in a separate child Node process inside a bubblewrap
 * sandbox (every namespace unshared, network included; cleared environment;
 * no host filesystem beyond the read-only node runtime; die-with-parent),
 * with node's permission model (`--permission`: no fs, no child processes,
 * no workers) and `--disallow-code-generation-from-strings` as depth. If
 * bwrap is missing or fails its capability self-test, bundle providers are
 * REFUSED (`sandbox-unavailable`); there is no unsandboxed fallback. Provider
 * code is evaluated in a `vm` context with string code generation disabled,
 * frozen intrinsics and only context-realm objects (frozen records, frozen
 * clock, seeded RNG, minimal pure standard library). The `vm` context is NOT
 * the boundary; the sandboxed child (plus the parent's SIGKILL timeout,
 * output cap and nonce-framed result channel) is.
 *
 * Provider code is the entire declared provider directory, read into an
 * in-memory snapshot (no symlinks: lstat-checked, symlinks and non-regular
 * files refuse); the code digest covers the snapshot's sorted module paths
 * and bytes. The loader keeps those bytes in a private record keyed by the
 * frozen provider object it issues; every run re-digests its own copy and
 * sends exactly those bytes to the child over stdin. Modules
 * must be self-contained relative `.mjs` with static string specifiers only:
 * dynamic `import()`, `require`, bare/external imports and non-`.mjs`
 * relatives refuse at load. Bare package imports are FORBIDDEN in phase 1.
 *
 * The trust root is the project config (`aiwg.config` `gates.providers`
 * allowlist): a provider registers only with a matching entry (bundle id,
 * provider id, code digest, reviewer, review timestamp). In-bundle review
 * files are informational (integrity-checked for consistency) only.
 * Unknown or mismatched entries refuse.
 *
 * Loading requires BOTH an explicit `allowBundleProviders: true` option AND
 * an allowlist entry. No environment variable activates it. With no opt-in,
 * resolution and evaluation stay byte-identical to the core-only path.
 */

export const GATE_PROVIDER_MAX_FILE_BYTES = 256 * 1024;
export const GATE_PROVIDER_MAX_FILES = 20;
export const GATE_PROVIDER_MAX_TOTAL_BYTES = 1024 * 1024;
export const GATE_PROVIDER_MAX_REVIEW_BYTES = 8 * 1024;
export const GATE_PROVIDER_DEFAULT_TIMEOUT_MS = 5000;
export const GATE_PROVIDER_MAX_TIMEOUT_MS = 30000;
export const GATE_PROVIDER_DEFAULT_MAX_RECORDS = 50000;
/** Largest accepted isolated-run stdout body (single JSON message). */
export const GATE_PROVIDER_MAX_OUTPUT_BYTES = 1024 * 1024;
/** V8 old generation; RLIMIT_DATA also bounds off-heap ArrayBuffer allocations. */
export const GATE_PROVIDER_MAX_OLD_SPACE_MB = 128;
// Node reserves ~512 MiB for its code range before any provider runs.
export const GATE_PROVIDER_MAX_DATA_BYTES = 768 * 1024 * 1024;

export class GateProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'disabled' | 'path-escape' | 'oversize' | 'missing-attestation' | 'attestation-mismatch'
      | 'invalid-module' | 'external-forbidden' | 'unregistered' | 'timeout' | 'cancelled' | 'rejected'
      | 'budget-exceeded' | 'invalid-records' | 'duplicate' | 'sandbox-unavailable',
  ) {
    super(message);
    this.name = 'GateProviderError';
  }
}

/** One hashed file contributing to a provider code digest (posix-relative path). */
export interface ProviderFileDigest {
  path: string;
  sha256: string;
}

/** Phase-1 providers cannot have externals; the field stays for shape stability. */
export interface ProviderExternalPin {
  specifier: string;
  version: string;
  integrity: string;
}

export interface ProviderCodeDigest {
  codeDigest: Sha256Digest;
  files: ProviderFileDigest[];
  externals: ProviderExternalPin[];
}

export interface BundleProviderOptions {
  allowBundleProviders?: boolean;
  /** P3 trust root: project-config `gates.providers` allowlist. Required to register. */
  allowlist?: ProviderAllowlistEntry[];
  now?: string;
  timeoutMs?: number;
  maxRecords?: number;
  maxOutputBytes?: number;
  /** Frozen clock (epoch ms) injected into the isolated context. Required by `invokeBundleProvider`. */
  clockMs?: number;
  signal?: AbortSignal;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODULE_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.mjs$/;
const REVIEW_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.json$/;
const HARNESS_PREFIX = '__aiwg_';

export function isBundleProvidersEnabled(options?: Pick<BundleProviderOptions, 'allowBundleProviders'>): boolean {
  return options?.allowBundleProviders === true;
}

function bundleRootReal(bundleRoot: string): string {
  const resolved = resolve(bundleRoot);
  try {
    return realpathSync(resolved);
  } catch {
    throw new GateProviderError(`bundle root is unavailable: ${bundleRoot}`, 'path-escape');
  }
}

function assertDeclaredPath(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new GateProviderError(`${label} escapes the bundle: ${String(value)}`, 'path-escape');
  }
  if (isAbsolute(value)) throw new GateProviderError(`${label} must be bundle-relative: ${value}`, 'path-escape');
  return value;
}

/** Deterministic seed for the isolated RNG: pinned by code and records digests. */
export function deriveIsolatedSeed(codeDigest: string, recordsDigest: string): number {
  return parseInt(createHash('sha256').update(`${codeDigest}${recordsDigest}`).digest('hex').slice(0, 8), 16);
}

interface SnapshotWalk {
  /** Bundle-relative posix path -> bytes, sorted by path. */
  modules: Array<{ path: string; bytes: Buffer }>;
}

/**
 * Reads the provider directory (the directory containing the entry module)
 * into an in-memory snapshot. Every entry is lstat-checked: symlinks (files
 * or dirs) and non-regular files refuse; only regular `.mjs` files are
 * captured (other regular files are inert: the loader never serves them, so
 * they are neither captured nor digested). Module bytes must be valid UTF-8
 * (they round-trip exactly to the source text the sandbox compiles). The
 * walk is sorted, so the snapshot (and its digest) is deterministic. Nothing
 * is written to disk: runs receive the bytes over stdin.
 */
export function snapshotProviderDir(bundleRoot: string, entryModule: string): {
  files: ProviderFileDigest[]; codeDigest: Sha256Digest; entryRel: string;
  modules: Array<{ path: string; bytes: Buffer }>;
} {
  const rel = assertDeclaredPath(entryModule, MODULE_PATTERN, 'provider module');
  const rootReal = bundleRootReal(bundleRoot);
  const entryAbs = resolve(rootReal, rel);
  let entryReal: string;
  try {
    entryReal = realpathSync(entryAbs);
  } catch {
    throw new GateProviderError(`provider module is missing inside the bundle: ${rel}`, 'path-escape');
  }
  if (entryReal !== rootReal && !entryReal.startsWith(rootReal + sep)) {
    throw new GateProviderError(`provider module escapes the bundle root: ${rel}`, 'path-escape');
  }
  let entryStatus;
  try {
    entryStatus = lstatSync(entryReal);
  } catch {
    throw new GateProviderError(`provider module is missing inside the bundle: ${rel}`, 'path-escape');
  }
  if (entryStatus.isSymbolicLink() || !entryStatus.isFile()) {
    throw new GateProviderError(`provider module must be a regular file: ${rel}`, 'path-escape');
  }
  const providerDir = dirname(entryReal);
  const walk: SnapshotWalk = { modules: [] };
  let total = 0;
  const visit = (dirAbs: string): void => {
    let names: string[];
    try {
      names = readdirSync(dirAbs).sort();
    } catch {
      throw new GateProviderError(`provider directory is unreadable: ${relative(rootReal, dirAbs)}`, 'path-escape');
    }
    for (const name of names) {
      if (name.startsWith(HARNESS_PREFIX)) {
        throw new GateProviderError(`provider file uses the reserved prefix: ${name}`, 'invalid-module');
      }
      const abs = join(dirAbs, name);
      let status;
      try {
        status = lstatSync(abs);
      } catch {
        throw new GateProviderError(`provider file is unreadable: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (status.isSymbolicLink()) {
        throw new GateProviderError(`provider file must not be a symlink: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (status.isDirectory()) {
        if (name.endsWith('.mjs')) {
          throw new GateProviderError(`provider module must be a regular file: ${relative(rootReal, abs)}`, 'invalid-module');
        }
        visit(abs);
        continue;
      }
      if (!status.isFile()) {
        throw new GateProviderError(`provider file is not a regular file: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (!name.endsWith('.mjs')) continue;
      if (walk.modules.length >= GATE_PROVIDER_MAX_FILES) {
        throw new GateProviderError(`provider exceeds ${GATE_PROVIDER_MAX_FILES} files`, 'oversize');
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(abs);
      } catch {
        throw new GateProviderError(`provider file is unreadable: ${relative(rootReal, abs)}`, 'path-escape');
      }
      if (bytes.length > GATE_PROVIDER_MAX_FILE_BYTES) {
        throw new GateProviderError(`provider file exceeds size limit: ${relative(rootReal, abs)}`, 'oversize');
      }
      if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
        throw new GateProviderError(`provider module is not valid UTF-8: ${relative(rootReal, abs)}`, 'invalid-module');
      }
      total += bytes.length;
      if (total > GATE_PROVIDER_MAX_TOTAL_BYTES) {
        throw new GateProviderError('provider exceeds total size limit', 'oversize');
      }
      walk.modules.push({ path: relative(rootReal, abs).split(sep).join('/'), bytes });
    }
  };
  visit(providerDir);
  walk.modules.sort((a, b) => (a.path < b.path ? -1 : 1));
  const entryRel = relative(rootReal, entryReal).split(sep).join('/');
  if (!walk.modules.some(file => file.path === entryRel)) {
    throw new GateProviderError(`provider module is missing from its snapshot: ${rel}`, 'path-escape');
  }
  const files: ProviderFileDigest[] = walk.modules.map(file => ({
    path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex'),
  }));
  const codeDigest = artifactDigest({ externals: [], files }) as Sha256Digest;
  return { files, codeDigest, entryRel, modules: walk.modules };
}

/**
 * Digest of provider CODE: the snapshot bytes (sorted module paths plus
 * content hashes) of the entire provider directory. Any byte change anywhere
 * in the directory moves the digest, so a binding pinned to the old digest
 * refuses until re-pinned. Bare/external imports are forbidden in phase 1;
 * the sandboxed linker is authoritative at load/invoke. Pure read: no
 * snapshot is written anywhere.
 */
export function computeProviderCodeDigest(bundleRoot: string, entryModule: string): ProviderCodeDigest {
  const snapshot = snapshotProviderDir(bundleRoot, entryModule);
  return { codeDigest: snapshot.codeDigest, files: snapshot.files, externals: [] };
}

const METRIC_KINDS = new Set(['proportion', 'paired', 'scalar', 'differences', 'evidence']);

function readReview(rootReal: string, entry: GateProviderEntry): { reviewer: string; reviewedAt: string; codeDigest: Sha256Digest } {
  if (entry.review !== undefined) {
    if (typeof entry.review.codeDigest !== 'string') {
      throw new GateProviderError(`provider ${entry.id} review digest is unknown`, 'missing-attestation');
    }
    return {
      reviewer: entry.review.reviewer,
      reviewedAt: entry.review.reviewedAt,
      codeDigest: entry.review.codeDigest as Sha256Digest,
    };
  }
  const rel = assertDeclaredPath(entry.reviewFile, REVIEW_PATTERN, 'provider review');
  const abs = resolve(rootReal, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new GateProviderError(`provider ${entry.id} review file is unreadable: ${rel}`, 'missing-attestation');
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new GateProviderError(`provider review escapes the bundle root: ${rel}`, 'path-escape');
  }
  let raw: string;
  try {
    if (statSync(real).size > GATE_PROVIDER_MAX_REVIEW_BYTES) {
      throw new GateProviderError(`provider review exceeds size limit: ${rel}`, 'oversize');
    }
    raw = readFileSync(real, 'utf8');
  } catch (error) {
    if (error instanceof GateProviderError) throw error;
    throw new GateProviderError(`provider ${entry.id} review file is unreadable: ${rel}`, 'missing-attestation');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GateProviderError(`provider ${entry.id} review file is not JSON: ${rel}`, 'missing-attestation');
  }
  const validated = GateProviderEntrySchema.safeParse({ ...entry, review: parsed, reviewFile: undefined });
  if (!validated.success) {
    throw new GateProviderError(`provider ${entry.id} review file is invalid`, 'missing-attestation');
  }
  if (validated.data.review === undefined) {
    throw new GateProviderError(`provider ${entry.id} review file is invalid`, 'missing-attestation');
  }
  return {
    reviewer: validated.data.review.reviewer,
    reviewedAt: validated.data.review.reviewedAt,
    codeDigest: validated.data.review.codeDigest as Sha256Digest,
  };
}

interface IsolatedRunArgs {
  mode: 'inspect' | 'invoke';
  recordsJson?: string;
  clockMs: number;
  seed: number;
  /** Pinned code digest the run must reproduce (evaluator re-runs). */
  expectedCodeDigest?: string;
}

interface IsolatedRunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/**
 * Trusted, loader-owned state of an issued bundle provider (C2/C3). Held in
 * a module-private WeakMap keyed by the frozen provider object the loader
 * returned: the bytes, identity and digest the runner executes come ONLY
 * from here, never from caller-visible fields (which a caller can copy and
 * rewrite). Only `loadGateBundleProviders` adds entries.
 */
interface TrustedProviderRecord {
  readonly id: string;
  readonly version: string;
  readonly codeDigest: Sha256Digest;
  readonly entryRel: string;
  readonly modules: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer }>;
}

const ISSUED_PROVIDERS = new WeakMap<object, TrustedProviderRecord>();

/** True only for the exact provider objects returned by `loadGateBundleProviders`. */
export function isLoaderIssuedProvider(provider: unknown): boolean {
  return typeof provider === 'object' && provider !== null && ISSUED_PROVIDERS.has(provider);
}

function issuedRecordOrThrow(provider: unknown): TrustedProviderRecord {
  const record = typeof provider === 'object' && provider !== null ? ISSUED_PROVIDERS.get(provider) : undefined;
  if (record === undefined) {
    const id = typeof provider === 'object' && provider !== null ? String((provider as { id?: unknown }).id) : 'unknown';
    throw new GateProviderError(
      `provider ${id} was not issued by the bundle loader: refusing to run caller-supplied provider objects`, 'unregistered');
  }
  return record;
}

function digestModules(modules: ReadonlyArray<{ path: string; bytes: Buffer }>): Sha256Digest {
  const files = [...modules]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(file => ({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex') }));
  return artifactDigest({ externals: [], files }) as Sha256Digest;
}

/**
 * Builds the stdin payload for one run from the runner's OWN copy of the
 * trusted bytes: the copy is re-digested and must equal the issued digest
 * (and the pinned digest, for evaluator re-runs) before anything executes.
 * The child receives exactly these bytes (UTF-8, round-trip checked at
 * snapshot time) and nothing else; no file is read or shared between runs.
 */
function prepareIsolatedRun(record: TrustedProviderRecord, args: IsolatedRunArgs): { nonce: string; input: string } {
  const copy = record.modules.map(module => ({ path: module.path, bytes: Buffer.from(module.bytes) }));
  const digest = digestModules(copy);
  if (digest !== record.codeDigest
    || (args.expectedCodeDigest !== undefined && digest !== args.expectedCodeDigest)) {
    throw new GateProviderError(`provider ${record.id} code does not match its pinned digest`, 'attestation-mismatch');
  }
  const modules: Record<string, string> = {};
  for (const module of copy) modules[module.path] = module.bytes.toString('utf8');
  const nonce = randomBytes(32).toString('hex');
  const request = JSON.stringify({
    entry: record.entryRel,
    modules,
    mode: args.mode,
    ...(args.recordsJson === undefined ? {} : { recordsJson: args.recordsJson }),
    clockMs: args.clockMs,
    seed: args.seed,
    expectedId: record.id,
    expectedVersion: record.version,
  });
  return { nonce, input: `${nonce}\n${request}` };
}

// ---------------------------------------------------------------------------
// OS sandbox (C1c/C1d): bubblewrap is the isolation boundary.
// ---------------------------------------------------------------------------

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];
const PRLIMIT_CANDIDATES = ['/usr/bin/prlimit', '/bin/prlimit', '/usr/local/bin/prlimit'];
const SANDBOX_NODE_PATH = '/aiwg/bin/node';
const SANDBOX_CWD = '/tmp';
const SANDBOX_SELF_TEST_TIMEOUT_MS = 15000;
const SANDBOX_NAMESPACES = ['net', 'pid', 'ipc', 'uts', 'user', 'mnt'] as const;
const MEMORY_NODE_ARGS = [
  `--max-old-space-size=${GATE_PROVIDER_MAX_OLD_SPACE_MB}`, '--max-semi-space-size=16',
];
const DRIVER_NODE_ARGS = [
  ...MEMORY_NODE_ARGS,
  '--experimental-vm-modules', '--permission', '--disallow-code-generation-from-strings',
  '--no-warnings', '--input-type=module', '-e', ISOLATED_CHILD_SOURCE,
];
const RESULT_FRAME = 'AIWG-RESULT ';

/** Self-test body: run inside the sandbox WITHOUT node --permission, so it observes the OS layer alone. */
const SANDBOX_SELF_TEST_SOURCE = [
  "import fs from 'node:fs';",
  "import net from 'node:net';",
  "import v8 from 'node:v8';",
  "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
  'const out = { env: {}, ns: {}, visible: [], connect: null, memory: null };',
  // Read the inherited kernel limits AND exercise the allocation path. Do
  // not touch the allocation if the wrapper is broken: fail without committing it.
  "const data = /^Max data size\\s+(\\S+)\\s+(\\S+)/m.exec(fs.readFileSync('/proc/self/limits', 'utf8'));",
  'let allocationBlocked = false;',
  'try { new Uint8Array(input.maxDataBytes); } catch (error) { allocationBlocked = error instanceof RangeError; }',
  'out.memory = { dataSoftBytes: Number(data?.[1]) || null, dataHardBytes: Number(data?.[2]) || null,',
  '  heapLimitBytes: v8.getHeapStatistics().heap_size_limit, allocationBlocked };',
  'for (const key of Object.keys(process.env)) out.env[key] = String(process.env[key]);',
  "for (const name of input.namespaces) { try { out.ns[name] = fs.readlinkSync('/proc/self/ns/' + name); } catch { out.ns[name] = null; } }",
  'for (const path of input.paths) { try { fs.lstatSync(path); out.visible.push(path); } catch { /* absent */ } }',
  'if (typeof input.port === \'number\') {',
  '  out.connect = await new Promise((resolve) => {',
  "    const socket = net.connect({ host: '127.0.0.1', port: input.port });",
  "    const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 3000);",
  "    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });",
  "    socket.on('error', (error) => { clearTimeout(timer); resolve('refused:' + error.code); });",
  '  });',
  '}',
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

let sandboxOverride: { bwrapPath?: string; prlimitPath?: string } | null = null;
let sandboxVerdict: { key: string; ok: boolean; reason: string } | undefined;
let runtimeBindCache: Array<[string, string]> | undefined;

/**
 * Test-only hook: point the runner at another bwrap/prlimit path (for example a
 * missing binary, or one that fails the self-test) or reset with `null`.
 * It can only make the runner refuse: whatever path is configured must still
 * pass the capability self-test before any provider runs.
 */
export function configureIsolationSandboxForTests(options: { bwrapPath?: string; prlimitPath?: string } | null): void {
  sandboxOverride = options === null ? null : { ...options };
  sandboxVerdict = undefined;
}

function resolveBwrapPath(): string | null {
  const candidates = sandboxOverride?.bwrapPath !== undefined ? [sandboxOverride.bwrapPath] : BWRAP_CANDIDATES;
  return resolveExecutable(candidates);
}

function resolvePrlimitPath(): string | null {
  const candidates = sandboxOverride?.prlimitPath !== undefined ? [sandboxOverride.prlimitPath] : PRLIMIT_CANDIDATES;
  return resolveExecutable(candidates);
}

function resolveExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      const status = statSync(candidate);
      if (status.isFile() && (status.mode & 0o111) !== 0) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** PT_INTERP of an ELF64 little-endian binary (the dynamic loader path), or null. */
function elfInterpreter(binary: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(binary, 'r');
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, 64, 0) !== 64) return null;
    if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1) return null;
    const phoff = Number(header.readBigUInt64LE(0x20));
    const phentsize = header.readUInt16LE(0x36);
    const phnum = header.readUInt16LE(0x38);
    const table = Buffer.alloc(phentsize * phnum);
    readSync(fd, table, 0, table.length, phoff);
    for (let index = 0; index < phnum; index++) {
      const base = index * phentsize;
      if (table.readUInt32LE(base) !== 3) continue;
      const offset = Number(table.readBigUInt64LE(base + 8));
      const size = Number(table.readBigUInt64LE(base + 32));
      if (size <= 0 || size > 4096) return null;
      const buffer = Buffer.alloc(size);
      readSync(fd, buffer, 0, size, offset);
      return buffer.toString('utf8').replace(/\0+$/, '');
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read-only binds for the sandbox: the node binary (at a fixed path) and
 * exactly the shared libraries this node process has mapped, plus their
 * soname aliases and the ELF interpreter. No other host path is visible.
 */
function runtimeBinds(): Array<[string, string]> {
  if (runtimeBindCache !== undefined) return runtimeBindCache;
  const byTarget = new Map<string, string>();
  const nodeReal = realpathSync(process.execPath);
  byTarget.set(SANDBOX_NODE_PATH, nodeReal);
  let maps = '';
  try {
    maps = readFileSync('/proc/self/maps', 'utf8');
  } catch {
    maps = '';
  }
  const libraries = new Set<string>();
  for (const line of maps.split('\n')) {
    const path = line.trim().split(/\s+/).slice(5).join(' ');
    if (path.startsWith('/') && /\.so(?:\.\d+)*$/.test(path)) libraries.add(path);
  }
  for (const library of libraries) {
    let real: string;
    try {
      real = realpathSync(library);
    } catch {
      continue;
    }
    byTarget.set(library, real);
    const match = /^(.*\.so)((?:\.\d+)*)$/.exec(basename(library));
    if (match === null) continue;
    const versions = match[2]!.split('.').filter(Boolean);
    for (let keep = versions.length - 1; keep >= 0; keep--) {
      const alias = join(dirname(library), `${match[1]!}${versions.slice(0, keep).map(part => `.${part}`).join('')}`);
      try {
        if (realpathSync(alias) === real) byTarget.set(alias, real);
      } catch {
        /* no such alias */
      }
    }
  }
  const interpreter = elfInterpreter(nodeReal);
  if (interpreter !== null && isAbsolute(interpreter)) {
    try {
      byTarget.set(interpreter, realpathSync(interpreter));
    } catch {
      /* the self-test will fail closed */
    }
  }
  runtimeBindCache = [...byTarget.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([target, source]) => [source, target]);
  return runtimeBindCache;
}

function sandboxCommand(nodeArgs: readonly string[]): { command: string; args: string[]; env: Record<string, string> } {
  const bwrap = resolveBwrapPath();
  if (bwrap === null) {
    throw new GateProviderError(
      'bundle providers require bubblewrap (bwrap) for OS-level isolation and none was found: refusing to run', 'sandbox-unavailable');
  }
  const prlimit = resolvePrlimitPath();
  if (prlimit === null) {
    throw new GateProviderError(
      'bundle providers require prlimit for a kernel memory cap and none was found: refusing to run', 'sandbox-unavailable');
  }
  const args = [
    '--unshare-all', '--unshare-user', '--disable-userns',
    '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
  ];
  for (const [source, target] of runtimeBinds()) args.push('--ro-bind', source, target);
  args.push('--tmpfs', SANDBOX_CWD, '--proc', '/proc', '--dev', '/dev', '--chdir', SANDBOX_CWD, '--', SANDBOX_NODE_PATH, ...nodeArgs);
  return {
    command: prlimit,
    // Both limits are hard as well as soft, inherited across exec into bwrap
    // and node. Core dumps are disabled for bounded heap exhaustion failures.
    args: [`--data=${GATE_PROVIDER_MAX_DATA_BYTES}:${GATE_PROVIDER_MAX_DATA_BYTES}`, '--core=0:0', '--', bwrap, ...args],
    env: {},
  };
}

/**
 * The exact sandboxed launch used for every provider run: bubblewrap with
 * every namespace unshared (network included), no user namespaces inside,
 * cleared environment, new session, die-with-parent, read-only node runtime
 * binds, a private tmpfs, and node with `--permission` (no fs, no child
 * processes, no workers) plus `--disallow-code-generation-from-strings`.
 * prlimit applies a hard data cap (including off-heap memory); V8 has a
 * separate heap cap. The spawn environment itself is empty.
 */
export function isolationLaunchPlan(): { command: string; args: string[]; env: Record<string, string> } {
  return sandboxCommand(DRIVER_NODE_ARGS);
}

interface SandboxSelfTestReport {
  ok: boolean;
  reason: string;
  envKeys: string[];
  sharedNamespaces: string[];
  hostPathsVisible: string[];
  connect: string | null;
  memory: {
    dataSoftBytes: number | null;
    dataHardBytes: number | null;
    heapLimitBytes: number;
    allocationBlocked: boolean;
  } | null;
}

function hostProbePaths(): string[] {
  const targets = [...runtimeBinds().map(([, target]) => target), SANDBOX_CWD, '/proc', '/dev', '/aiwg'];
  const candidates = [homedir(), process.cwd(), '/etc/passwd', '/home', '/root', '/var', '/run', '/srv'];
  return [...new Set(candidates)].filter(path => {
    if (!path || path === '/' || !isAbsolute(path)) return false;
    if (targets.some(target => target === path || target.startsWith(`${path}/`) || path.startsWith(`${target}/`))) return false;
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  });
}

function selfTestInput(port: number | null): { paths: string[]; input: string } {
  const paths = hostProbePaths();
  return { paths, input: JSON.stringify({ namespaces: SANDBOX_NAMESPACES, paths, port, maxDataBytes: GATE_PROVIDER_MAX_DATA_BYTES }) };
}

function judgeSelfTest(stdout: string, status: number | null, paths: string[], port: number | null): SandboxSelfTestReport {
  const report: SandboxSelfTestReport = {
    ok: false, reason: '', envKeys: [], sharedNamespaces: [], hostPathsVisible: [], connect: null, memory: null,
  };
  let observed: {
    env?: Record<string, string>; ns?: Record<string, string | null>; visible?: string[]; connect?: string | null;
    memory?: SandboxSelfTestReport['memory'];
  };
  try {
    observed = JSON.parse(stdout) as typeof observed;
  } catch {
    report.reason = `sandbox self-test produced no report (exit ${String(status)})`;
    return report;
  }
  if (status !== 0 || !observed || typeof observed !== 'object') {
    report.reason = `sandbox self-test failed (exit ${String(status)})`;
    return report;
  }
  // bwrap always exports PWD for the sandbox working directory; nothing else may leak.
  const env = observed.env ?? {};
  report.envKeys = Object.keys(env).filter(key => !(key === 'PWD' && env[key] === SANDBOX_CWD)).sort();
  for (const name of SANDBOX_NAMESPACES) {
    let host: string | null = null;
    try {
      host = readlinkSync(`/proc/self/ns/${name}`);
    } catch {
      host = null;
    }
    const inside = observed.ns?.[name] ?? null;
    if (host === null || inside === null || host === inside) report.sharedNamespaces.push(name);
  }
  report.hostPathsVisible = (observed.visible ?? []).filter(path => paths.includes(path));
  report.connect = observed.connect ?? null;
  report.memory = observed.memory ?? null;
  const problems: string[] = [];
  const memory = report.memory;
  if (memory === null
    || memory.dataSoftBytes !== GATE_PROVIDER_MAX_DATA_BYTES || memory.dataHardBytes !== GATE_PROVIDER_MAX_DATA_BYTES
    || !(memory.heapLimitBytes > 0 && memory.heapLimitBytes <= (GATE_PROVIDER_MAX_OLD_SPACE_MB + 48) * 1024 * 1024)
    || memory.allocationBlocked !== true) {
    problems.push('memory cap not enforced');
  }
  if (report.envKeys.length) problems.push(`environment leaks ${report.envKeys.join(',')}`);
  if (report.sharedNamespaces.length) problems.push(`namespaces not private: ${report.sharedNamespaces.join(',')}`);
  if (report.hostPathsVisible.length) problems.push(`host paths visible: ${report.hostPathsVisible.join(',')}`);
  if (port !== null && report.connect === 'connected') problems.push('host loopback network reachable');
  report.ok = problems.length === 0;
  report.reason = report.ok ? 'ok' : `sandbox self-test failed: ${problems.join('; ')}`;
  return report;
}

/**
 * Runs the sandbox capability self-test asynchronously and returns the
 * observations (enforced memory caps, empty env, private namespaces, no host paths, optional
 * loopback connect to a parent listener on `connectPort`).
 */
export function probeIsolationSandbox(options?: { connectPort?: number }): Promise<SandboxSelfTestReport> {
  const port = typeof options?.connectPort === 'number' ? options.connectPort : null;
  let plan: { command: string; args: string[]; env: Record<string, string> };
  let probe: { paths: string[]; input: string };
  try {
    plan = sandboxCommand([...MEMORY_NODE_ARGS, '--no-warnings', '--input-type=module', '-e', SANDBOX_SELF_TEST_SOURCE]);
    probe = selfTestInput(port);
  } catch (error) {
    return Promise.resolve({
      ok: false, reason: error instanceof Error ? error.message : 'sandbox unavailable',
      envKeys: [], sharedNamespaces: [], hostPathsVisible: [], connect: null, memory: null,
    });
  }
  return new Promise((resolvePromise) => {
    const child = spawn(plan.command, plan.args, { env: plan.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { try { signalChild(child, 'SIGKILL'); } catch { /* exited */ } }, SANDBOX_SELF_TEST_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stdin?.on('error', () => { /* reported via exit status */ });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false, reason: `sandbox failed to start: ${error.message}`,
        envKeys: [], sharedNamespaces: [], hostPathsVisible: [], connect: null, memory: null,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(judgeSelfTest(Buffer.concat(chunks).toString('utf8'), code, probe.paths, port));
    });
    child.stdin?.end(probe.input);
  });
}

/**
 * Fail-closed gate before every provider run: bwrap must exist and pass the
 * capability self-test (cached per bwrap/prlimit path for the process lifetime).
 * There is no unsandboxed fallback.
 */
function ensureIsolationSandbox(): void {
  const key = JSON.stringify([resolveBwrapPath(), resolvePrlimitPath()]);
  if (sandboxVerdict === undefined || sandboxVerdict.key !== key) {
    let verdict: { ok: boolean; reason: string };
    try {
      const plan = sandboxCommand([...MEMORY_NODE_ARGS, '--no-warnings', '--input-type=module', '-e', SANDBOX_SELF_TEST_SOURCE]);
      const probe = selfTestInput(null);
      const completed = spawnSync(plan.command, plan.args, {
        env: plan.env, input: probe.input, encoding: 'utf8', timeout: SANDBOX_SELF_TEST_TIMEOUT_MS,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
      });
      verdict = completed.error !== undefined
        ? { ok: false, reason: `sandbox failed to start: ${completed.error.message}` }
        : judgeSelfTest(typeof completed.stdout === 'string' ? completed.stdout : '', completed.status, probe.paths, null);
    } catch (error) {
      verdict = { ok: false, reason: error instanceof Error ? error.message : 'sandbox unavailable' };
    }
    sandboxVerdict = { key, ...verdict };
  }
  if (!sandboxVerdict.ok) {
    throw new GateProviderError(
      `bundle providers are refused: the OS isolation sandbox is unavailable (${sandboxVerdict.reason})`, 'sandbox-unavailable');
  }
}

/**
 * Whether bundle providers can run here: bwrap present and passing its
 * capability self-test. Never throws; `reason` explains a refusal.
 */
export function isolationSandboxStatus(): { ok: boolean; reason: string } {
  try {
    ensureIsolationSandbox();
    return { ok: true, reason: 'ok' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'sandbox unavailable' };
  }
}

function parseIsolatedResponse(body: string, stderr: string, providerId: string): { descriptor?: Record<string, unknown>; result?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new GateProviderError(
      `provider ${providerId} returned an unreadable message${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GateProviderError(`provider ${providerId} returned an unreadable message`, 'rejected');
  }
  const message = parsed as { ok?: unknown; error?: unknown; descriptor?: unknown; result?: unknown };
  if (message.ok !== true) {
    throw new GateProviderError(
      `provider ${providerId} rejected: ${typeof message.error === 'string' && message.error ? message.error.slice(0, 300) : 'unknown'}`,
      'rejected');
  }
  return { descriptor: message.descriptor as Record<string, unknown> | undefined, result: message.result };
}

/**
 * C1e: the parent accepts exactly one line on stdout, framed by the trusted
 * driver with the per-run nonce it read from stdin before any provider code
 * was compiled. Anything else (an unframed message, a wrong nonce, extra or
 * missing bytes) is a forgery attempt and rejects.
 */
export function parseIsolatedFrame(
  stdout: string, nonce: string, providerId: string, stderr = '',
): { descriptor?: Record<string, unknown>; result?: unknown } {
  const prefix = `${RESULT_FRAME}${nonce} `;
  if (!/^[0-9a-f]{64}$/.test(nonce) || !stdout.startsWith(prefix) || !stdout.endsWith('\n')
    || stdout.indexOf('\n') !== stdout.length - 1) {
    throw new GateProviderError(
      `provider ${providerId} wrote outside its result frame${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected');
  }
  return parseIsolatedResponse(stdout.slice(prefix.length, -1), stderr, providerId);
}

function runIsolatedRecordSync(
  record: TrustedProviderRecord, args: IsolatedRunArgs, limits: IsolatedRunLimits,
): { descriptor?: Record<string, unknown>; result?: unknown } {
  ensureIsolationSandbox();
  const { nonce, input } = prepareIsolatedRun(record, args);
  const plan = isolationLaunchPlan();
  const completed = spawnSync(plan.command, plan.args, {
    env: plan.env,
    input,
    // Validated upstream; clamped here so the bound holds at the call site.
    timeout: positiveTimeoutMs(limits.timeoutMs, GATE_PROVIDER_DEFAULT_TIMEOUT_MS),
    killSignal: 'SIGKILL',
    maxBuffer: limits.maxOutputBytes,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = typeof completed.stderr === 'string' ? completed.stderr : '';
  if (completed.error !== undefined) {
    const code = (completed.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT' || completed.signal === 'SIGKILL') {
      throw new GateProviderError(`provider ${record.id} timed out`, 'timeout');
    }
    if (code === 'ENOBUFS') {
      throw new GateProviderError(`provider ${record.id} exceeds its output cap`, 'rejected');
    }
    throw new GateProviderError(`provider ${record.id} failed to start: ${completed.error.message}`, 'rejected');
  }
  if (completed.status !== 0) {
    throw new GateProviderError(
      `provider ${record.id} rejected${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected');
  }
  return parseIsolatedFrame(completed.stdout as string, nonce, record.id, stderr);
}

function runIsolatedRecord(
  record: TrustedProviderRecord, args: IsolatedRunArgs, limits: IsolatedRunLimits,
): Promise<{ descriptor?: Record<string, unknown>; result?: unknown }> {
  if (limits.signal?.aborted === true) {
    return Promise.reject(new GateProviderError(`provider ${record.id} was cancelled before dispatch`, 'cancelled'));
  }
  let nonce: string;
  let input: string;
  let plan: { command: string; args: string[]; env: Record<string, string> };
  try {
    ensureIsolationSandbox();
    ({ nonce, input } = prepareIsolatedRun(record, args));
    plan = isolationLaunchPlan();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener('abort', onAbort);
      action();
    };
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, { env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(new GateProviderError(
        `provider ${record.id} failed to start: ${error instanceof Error ? error.message : 'unknown'}`, 'rejected'));
      return;
    }
    const timer = setTimeout(() => {
      try { signalChild(child, 'SIGKILL'); } catch { /* already exited */ }
      settle(() => rejectPromise(new GateProviderError(`provider ${record.id} timed out`, 'timeout')));
    }, limits.timeoutMs);
    const onAbort = (): void => {
      try { signalChild(child, 'SIGKILL'); } catch { /* already exited */ }
      settle(() => rejectPromise(new GateProviderError(`provider ${record.id} was cancelled`, 'cancelled')));
    };
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) {
        capped = true;
        try { signalChild(child, 'SIGKILL'); } catch { /* already exited */ }
        settle(() => rejectPromise(new GateProviderError(`provider ${record.id} exceeds its output cap`, 'rejected')));
        return;
      }
      chunks.push(chunk);
    });
    const errors: Buffer[] = [];
    let errorBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errorBytes + chunk.length <= 4096) {
        errors.push(chunk);
        errorBytes += chunk.length;
      }
    });
    child.stdin?.on('error', () => { /* the exit status reports a dead child */ });
    child.on('error', (error) => {
      settle(() => rejectPromise(new GateProviderError(
        `provider ${record.id} failed to start: ${error.message}`, 'rejected')));
    });
    child.on('close', (code) => {
      if (capped) return;
      const stderr = Buffer.concat(errors).toString('utf8');
      if (code !== 0) {
        settle(() => rejectPromise(new GateProviderError(
          `provider ${record.id} rejected${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, 'rejected')));
        return;
      }
      // Parse BEFORE settling: a throwing parse must still reach the
      // rejection below (settling first would swallow the settlement).
      let parsed: { descriptor?: Record<string, unknown>; result?: unknown };
      try {
        parsed = parseIsolatedFrame(Buffer.concat(chunks).toString('utf8'), nonce, record.id, stderr);
      } catch (error) {
        settle(() => rejectPromise(error));
        return;
      }
      settle(() => resolvePromise(parsed));
    });
    child.stdin?.end(input);
  });
}

/**
 * Synchronous isolated run of a LOADER-ISSUED provider (evaluator re-runs):
 * sandboxed, SIGKILL timeout, output cap. Caller-supplied provider objects
 * (copies, hand-made objects) refuse; the executed bytes come only from the
 * loader's private record and are re-digested before every run.
 */
export function runIsolatedProviderSync(
  provider: Pick<BundleMetricProvider, 'id'>,
  args: IsolatedRunArgs,
  limits: IsolatedRunLimits,
): { descriptor?: Record<string, unknown>; result?: unknown } {
  return runIsolatedRecordSync(issuedRecordOrThrow(provider), args, limits);
}

/** Asynchronous isolated run of a LOADER-ISSUED provider: abortable, sandboxed, SIGKILL timeout, output cap. */
export function runIsolatedProvider(
  provider: Pick<BundleMetricProvider, 'id'>,
  args: IsolatedRunArgs,
  limits: IsolatedRunLimits,
): Promise<{ descriptor?: Record<string, unknown>; result?: unknown }> {
  let record: TrustedProviderRecord;
  try {
    record = issuedRecordOrThrow(provider);
  } catch (error) {
    return Promise.reject(error);
  }
  return runIsolatedRecord(record, args, limits);
}

/**
 * Load and register every `gateProviders` entry from a bundle manifest. The
 * manifest entry is re-validated here so direct callers cannot bypass Zod.
 * Registration requires BOTH an explicit `allowBundleProviders: true` option
 * AND a matching project-config allowlist entry (bundle id, provider id,
 * isolated code digest, reviewer, review timestamp); in-bundle reviews are
 * integrity-checked for consistency but are informational only. The provider
 * module graph is validated by the isolated child (parse + link over the
 * snapshot) before anything registers — nothing executes in-process, ever.
 */
export async function loadGateBundleProviders(
  bundleRoot: string,
  manifest: { id: string; gateProviders?: unknown },
  options?: BundleProviderOptions,
): Promise<BundleMetricProvider[]> {
  if (!isBundleProvidersEnabled(options)) {
    throw new GateProviderError('bundle metric providers are disabled: pass allowBundleProviders', 'disabled');
  }
  const entries: unknown[] = Array.isArray(manifest.gateProviders) ? [...manifest.gateProviders] : [];
  if (!Array.isArray(manifest.gateProviders) && manifest.gateProviders !== undefined) {
    throw new GateProviderError('bundle gateProviders must be an array', 'invalid-module');
  }
  if (!entries.length) return [];
  const nowMs = Date.parse(options?.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new GateProviderError('provider review clock is not a valid date-time', 'invalid-records');
  const timeoutMs = options?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_PROVIDER_MAX_TIMEOUT_MS) {
    throw new GateProviderError('provider timeout must be a positive integer within bounds', 'invalid-records');
  }
  const maxOutputBytes = options?.maxOutputBytes ?? GATE_PROVIDER_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) {
    throw new GateProviderError('provider output cap is invalid', 'invalid-records');
  }
  const rootReal = bundleRootReal(bundleRoot);
  const allowlist = options?.allowlist ?? [];
  const seen = new Set<string>();
  const loaded: BundleMetricProvider[] = [];
  for (const raw of entries) {
    const parsed = GateProviderEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new GateProviderError(
        `bundle provider declaration is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 'invalid-module');
    }
    const entry = parsed.data;
    if (seen.has(entry.id)) throw new GateProviderError(`duplicate bundle provider: ${entry.id}`, 'duplicate');
    seen.add(entry.id);
    const snapshot = snapshotProviderDir(rootReal, entry.module);
    const review = readReview(rootReal, entry);
    if (review.codeDigest !== snapshot.codeDigest) {
      throw new GateProviderError(`provider ${entry.id} review digest does not match its code digest`, 'attestation-mismatch');
    }
    const reviewedMs = Date.parse(review.reviewedAt);
    if (!Number.isFinite(reviewedMs)) throw new GateProviderError(`provider ${entry.id} review date is invalid`, 'missing-attestation');
    if (reviewedMs > nowMs) throw new GateProviderError(`provider ${entry.id} review is dated in the future`, 'missing-attestation');
    // P3 trust root: the project-config allowlist authorizes registration.
    const trusted = allowlist.find(candidate =>
      candidate.bundleId === manifest.id && candidate.providerId === entry.id);
    if (trusted === undefined) {
      throw new GateProviderError(
        `provider ${entry.id} is not allowlisted for bundle ${manifest.id}: refusing registration`, 'unregistered');
    }
    if (trusted.codeDigest !== snapshot.codeDigest) {
      throw new GateProviderError(`provider ${entry.id} code digest does not match its allowlist entry`, 'attestation-mismatch');
    }
    if (trusted.reviewer !== review.reviewer || trusted.reviewedAt !== review.reviewedAt) {
      throw new GateProviderError(`provider ${entry.id} review does not match its allowlist entry`, 'attestation-mismatch');
    }
    if (!DIGEST_PATTERN.test(snapshot.codeDigest)) {
      throw new GateProviderError(`provider ${entry.id} code digest is unknown`, 'attestation-mismatch');
    }
    // Validate the module graph in the sandboxed child (parse + link over the
    // snapshot, identity-checked against the manifest). Dynamic import(),
    // require, bare/absolute/escaping/non-.mjs specifiers refuse here.
    const record: TrustedProviderRecord = Object.freeze({
      id: entry.id, version: entry.version, codeDigest: snapshot.codeDigest, entryRel: snapshot.entryRel,
      modules: Object.freeze(snapshot.modules.map(module => Object.freeze({ path: module.path, bytes: Buffer.from(module.bytes) }))),
    });
    let descriptor: Record<string, unknown>;
    try {
      const inspected = await runIsolatedRecord(record, {
        mode: 'inspect', clockMs: nowMs, seed: 1,
      }, { timeoutMs, maxOutputBytes, signal: options?.signal });
      if (!inspected.descriptor || typeof inspected.descriptor !== 'object') {
        throw new GateProviderError(`provider ${entry.id} module has no provider export`, 'invalid-module');
      }
      descriptor = inspected.descriptor;
    } catch (error) {
      if (error instanceof GateProviderError
        && (error.code === 'timeout' || error.code === 'cancelled' || error.code === 'sandbox-unavailable')) throw error;
      throw new GateProviderError(
        `provider ${entry.id} module is invalid: ${error instanceof Error ? error.message : 'unknown'}`, 'invalid-module');
    }
    const metrics = descriptor.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new GateProviderError(`provider ${entry.id} metrics declaration is invalid`, 'invalid-module');
    }
    for (const [name, declared] of Object.entries(metrics as Record<string, unknown>)) {
      const kind = (declared as { kind?: unknown }).kind;
      if (typeof name !== 'string' || !name || !METRIC_KINDS.has(kind as string)) {
        throw new GateProviderError(`provider ${entry.id} metric ${name} has an unknown kind`, 'invalid-module');
      }
    }
    const sourceDigest = providerSourceDigest({ id: entry.id, version: entry.version, metrics });
    const provider: BundleMetricProvider = Object.freeze({
      id: entry.id, version: entry.version, description: descriptor.description as string,
      metrics: deepFreeze(metrics) as BundleMetricProvider['metrics'], sourceDigest,
      codeDigest: snapshot.codeDigest,
      review: Object.freeze({ reviewer: trusted.reviewer, reviewedAt: trusted.reviewedAt, codeDigest: snapshot.codeDigest }),
      bundleId: manifest.id, modulePath: entry.module,
      snapshotFiles: Object.freeze(snapshot.files.map(file => file.path)) as string[],
      compute: () => {
        throw new GateProviderError(
          `provider ${entry.id} cannot run in-process: use invokeBundleProvider (isolated child)`, 'invalid-module');
      },
    });
    // C3: the loader-issued token. Only this exact frozen object runs or registers.
    ISSUED_PROVIDERS.set(provider, record);
    loaded.push(provider);
  }
  return loaded;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Reserve-then-dispatch isolated provider invocation with a SIGKILL timeout.
 * Only loader-issued providers run; the clock (`clockMs`) is required, so
 * standalone invocations are reproducible (no real-clock default).
 */
export async function invokeBundleProvider(
  provider: Pick<BundleMetricProvider, 'id'>,
  records: readonly unknown[],
  options?: BundleProviderOptions,
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS;
  const maxRecords = options?.maxRecords ?? GATE_PROVIDER_DEFAULT_MAX_RECORDS;
  const maxOutputBytes = options?.maxOutputBytes ?? GATE_PROVIDER_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_PROVIDER_MAX_TIMEOUT_MS) {
    throw new GateProviderError('provider timeout must be a positive integer within bounds', 'invalid-records');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new GateProviderError('provider record budget is invalid', 'invalid-records');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) {
    throw new GateProviderError('provider output cap is invalid', 'invalid-records');
  }
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  if (records.length > maxRecords) throw new GateProviderError(`provider ${provider.id} exceeds its record budget`, 'budget-exceeded');
  if (options?.signal?.aborted === true) throw new GateProviderError(`provider ${provider.id} was cancelled before dispatch`, 'cancelled');
  let recordsJson: string;
  try {
    const serialized = JSON.stringify(records);
    if (typeof serialized !== 'string') throw new Error('unserializable');
    recordsJson = serialized;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not JSON-serializable`, 'invalid-records');
  }
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  const clockMs = options?.clockMs;
  if (clockMs === undefined) {
    throw new GateProviderError(`provider ${provider.id} invocation requires an explicit clockMs`, 'invalid-records');
  }
  if (!Number.isSafeInteger(clockMs)) throw new GateProviderError('provider clock is not an integer', 'invalid-records');
  const record = issuedRecordOrThrow(provider);
  try {
    const ran = await runIsolatedRecord(record, {
      mode: 'invoke', recordsJson, clockMs, seed: deriveIsolatedSeed(record.codeDigest, recordsDigest),
    }, { timeoutMs, maxOutputBytes, signal: options?.signal });
    if (ran.result === undefined) throw new GateProviderError(`provider ${provider.id} returned no metrics`, 'rejected');
    return ran.result;
  } catch (error) {
    if (error instanceof GateProviderError) throw error;
    throw new GateProviderError(
      `provider ${provider.id} rejected: ${error instanceof Error ? error.message : 'unknown'}`, 'rejected');
  }
}

/**
 * Builds the binding pin for a bundle provider over caller-supplied records,
 * including the records digest the evaluator reproduces (records binding).
 */
export function providerBindingPin(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'sourceDigest' | 'codeDigest'>,
  records: readonly unknown[],
): { id: string; version: string; sourceDigest: Sha256Digest; codeDigest: Sha256Digest; recordsDigest: Sha256Digest } {
  if (typeof provider.codeDigest !== 'string' || !DIGEST_PATTERN.test(provider.codeDigest)) {
    throw new GateProviderError(`provider ${provider.id} code digest is unknown`, 'attestation-mismatch');
  }
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  return {
    id: provider.id, version: provider.version,
    sourceDigest: provider.sourceDigest, codeDigest: provider.codeDigest, recordsDigest,
  };
}

/**
 * Bind a provider result to its trusted code digest and input-records digest.
 * The returned section overwrites any self-declared `version`/`sourceDigest`:
 * callers must use the sealed values, and the evaluator verifies the pin
 * against the loaded provider, never against provider-declared fields.
 */
export function sealProviderSection(
  provider: Pick<BundleMetricProvider, 'id' | 'version' | 'sourceDigest' | 'codeDigest'>,
  records: readonly unknown[],
  result: { metrics?: unknown },
): GateMetricsDocument['providers'][string] {
  if (!Array.isArray(records)) throw new GateProviderError('provider records must be an array', 'invalid-records');
  let recordsDigest: Sha256Digest;
  try {
    recordsDigest = artifactDigest(records) as Sha256Digest;
  } catch {
    throw new GateProviderError(`provider ${provider.id} records are not digestible`, 'invalid-records');
  }
  if (!result || typeof result !== 'object' || !result.metrics || typeof result.metrics !== 'object') {
    throw new GateProviderError(`provider ${provider.id} returned no metrics`, 'rejected');
  }
  if (typeof provider.codeDigest !== 'string' || !DIGEST_PATTERN.test(provider.codeDigest)) {
    throw new GateProviderError(`provider ${provider.id} code digest is unknown`, 'attestation-mismatch');
  }
  return {
    version: provider.version,
    sourceDigest: provider.sourceDigest,
    codeDigest: provider.codeDigest,
    recordsDigest,
    metrics: result.metrics as GateMetricsDocument['providers'][string]['metrics'],
  } as GateMetricsDocument['providers'][string];
}
