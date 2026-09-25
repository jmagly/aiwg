/**
 * Built-in `git.commit` and `git.tag` verifiers over a local repository.
 *
 * - Object lookups go through `git cat-file --batch-check` on stdin, so a
 *   target is never parsed as a command-line option and "missing" is a
 *   complete, successful answer rather than an error exit.
 * - `absent` needs a complete repository: a shallow or partial clone gives
 *   `unknown` / `paging-incomplete` for a missing commit.
 * - Signature checks reuse `git verify-commit` / `git verify-tag` (as
 *   `tools/ci/verify-signed-tag.sh` does). A required signature that is not
 *   good is never `present`: it is `unknown` / `evidence-conflict`, or
 *   `unknown` / `container-unreadable` when it cannot be checked (no key).
 *
 * @see docs/contracts/effect-ledger.v1.md "Built-in verifiers"
 */

import { spawn } from 'node:child_process';
import { EffectVerifierError, type EffectVerifier, type EffectVerifierObservation, type EffectVerifierRequest } from './types.js';

export interface VerifierGitResult { stdout: string; stderr: string; exitCode: number }
/** Runs `git -C <repo> <args>`. Rejects when git cannot be started. */
export type VerifierGitRunner = (args: string[], options?: { stdin?: string; signal?: AbortSignal }) => Promise<VerifierGitResult>;

export interface GitVerifierOptions {
  repoDir: string;
  /** Defaults to `git` on PATH. */
  gitBinary?: string;
  /** Test seam; defaults to spawning `gitBinary`. */
  runner?: VerifierGitRunner;
}

/** `good` passes a signature requirement; every other status is never `present` when one is required. */
export type GitSignatureStatus = 'good' | 'unsigned' | 'bad' | 'unverifiable' | 'expired' | 'revoked' | 'unchecked';

export const GIT_VERIFIER_VERSION = '1.0.0';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,254}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

function spawnRunner(repoDir: string, binary: string): VerifierGitRunner {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(binary, ['-C', repoDir, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill();
      else sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    // A git binary that cannot start is an unreadable container; an abort is the framework timeout.
    child.once('error', error => reject(options.signal?.aborted ? error : new EffectVerifierError('container-unreadable')));
    child.stdin.once('error', () => { /* the exit code is authoritative */ });
    child.once('close', code => {
      if (size > MAX_OUTPUT) reject(new EffectVerifierError('malformed-response'));
      else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code ?? 1 });
    });
    child.stdin.end(options.stdin ?? '');
  });
}

const unknown = (reason: EffectVerifierObservation['reason'], evidence?: EffectVerifierObservation['evidence']): EffectVerifierObservation =>
  ({ result: 'unknown', reason, complete: false, ...(evidence ? { evidence } : {}) });

/** Read an expectation member from `expected`, falling back to the identity context. */
function expectation<T extends 'object' | 'signed'>(request: EffectVerifierRequest, name: T): unknown {
  return request.expected[name] ?? request.context[name];
}

interface Git {
  run: VerifierGitRunner;
  /** Resolve one object name to `{oid, type}` or `null` when the repository says it is missing. */
  lookup(name: string, signal: AbortSignal): Promise<{ oid: string; type: string } | null>;
  /** Throws `unknown` unless the repository is readable. */
  assertReadable(signal: AbortSignal): Promise<void>;
  /** True for a full clone, false for a shallow or partial one. */
  complete(signal: AbortSignal): Promise<boolean>;
}

function gitFor(options: GitVerifierOptions): Git {
  if (!options || typeof options.repoDir !== 'string' || !options.repoDir) throw new TypeError('git verifiers need repoDir');
  const run = options.runner ?? spawnRunner(options.repoDir, options.gitBinary ?? 'git');
  return {
    run,
    async assertReadable(signal) {
      const result = await run(['rev-parse', '--git-dir'], { signal });
      if (result.exitCode !== 0) throw new EffectVerifierError('container-unreadable');
    },
    async lookup(name, signal) {
      const result = await run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { stdin: `${name}\n`, signal });
      if (result.exitCode !== 0) throw new EffectVerifierError('container-unreadable');
      const line = result.stdout.trim();
      if (line === `${name} missing`) return null;
      if (line === `${name} ambiguous`) throw new EffectVerifierError('evidence-conflict');
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+)$/.exec(line);
      if (!match) throw new EffectVerifierError('malformed-response');
      return { oid: match[1], type: match[2] };
    },
    async complete(signal) {
      const shallow = await run(['rev-parse', '--is-shallow-repository'], { signal });
      if (shallow.exitCode !== 0 || !/^(?:true|false)$/.test(shallow.stdout.trim())) throw new EffectVerifierError('container-unreadable');
      if (shallow.stdout.trim() === 'true') return false;
      const partial = await run(['config', '--get', 'extensions.partialclone'], { signal });
      if (partial.exitCode === 0 && partial.stdout.trim()) return false;
      if (partial.exitCode !== 0 && partial.exitCode !== 1) throw new EffectVerifierError('container-unreadable');
      return true;
    },
  };
}

/** Classify a failed `verify-commit` / `verify-tag --raw` from its status output. */
function failedSignature(stderr: string): GitSignatureStatus {
  if (/\b(?:REVKEYSIG)\b|revoked/i.test(stderr)) return 'revoked';
  if (/\b(?:EXPKEYSIG|EXPSIG)\b|expired/i.test(stderr)) return 'expired';
  if (/\bBADSIG\b|bad signature/i.test(stderr)) return 'bad';
  if (/\b(?:NO_PUBKEY|ERRSIG)\b|allowedSignersFile|No principal matched|no public key|can't check signature|gpg failed|cannot run/i.test(stderr)) return 'unverifiable';
  return 'bad';
}

async function signatureStatus(git: Git, command: 'verify-commit' | 'verify-tag', oid: string, hasSignature: boolean, signal: AbortSignal): Promise<GitSignatureStatus> {
  if (!hasSignature) return 'unsigned';
  const result = await git.run([command, '--raw', oid], { signal });
  return result.exitCode === 0 ? 'good' : failedSignature(result.stderr);
}

/** A required signature that is not good is never `present`. */
function signatureBlocks(status: GitSignatureStatus): EffectVerifierObservation['reason'] | null {
  if (status === 'good' || status === 'unchecked') return null;
  return status === 'unverifiable' ? 'container-unreadable' : 'evidence-conflict';
}

/** `git.commit`: target `git:<sha>` (full 40 or 64 hex). */
export function gitCommitVerifier(options: GitVerifierOptions): EffectVerifier {
  const git = gitFor(options);
  return {
    kind: 'git.commit',
    version: GIT_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const sha = request.target.startsWith('git:') ? request.target.slice(4) : '';
      if (!OBJECT_ID.test(sha)) return unknown('malformed-response');
      const signed = expectation(request, 'signed') === true;
      await git.assertReadable(request.signal);
      const object = await git.lookup(sha, request.signal);
      if (!object) {
        if (!await git.complete(request.signal)) return unknown('paging-incomplete');
        return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { object: sha, found: false } };
      }
      if (object.type !== 'commit' || object.oid !== sha) return unknown('evidence-conflict', { object: sha, type: object.type });
      const body = await git.run(['cat-file', 'commit', sha], { signal: request.signal });
      if (body.exitCode !== 0) return unknown('container-unreadable');
      const header = body.stdout.split('\n\n', 1)[0] ?? '';
      const hasSignature = /^gpgsig(?:-sha256)? /m.test(header);
      const signature = signed ? await signatureStatus(git, 'verify-commit', sha, hasSignature, request.signal) : 'unchecked';
      const trailers = await git.run(['log', '-1', '--format=%(trailers:key=Effect-Id,valueonly)', sha], { signal: request.signal });
      if (trailers.exitCode !== 0) return unknown('container-unreadable');
      const marker = trailers.stdout.split('\n').map(line => line.trim()).includes(request.effectId);
      const evidence = { object: sha, type: 'commit', signature, signatureRequired: signed, marker };
      const blocked = signed ? signatureBlocks(signature) : null;
      if (blocked) return unknown(blocked, evidence);
      return { result: 'present', reason: marker ? 'marker-match' : 'state-match', complete: true, evidence };
    },
  };
}

/** `git.tag`: target `git-tag:<name>`; the expected peeled object comes from `expected.object` or `context.object`. */
export function gitTagVerifier(options: GitVerifierOptions): EffectVerifier {
  const git = gitFor(options);
  return {
    kind: 'git.tag',
    version: GIT_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const name = request.target.startsWith('git-tag:') ? request.target.slice(8) : '';
      if (!TAG_NAME.test(name) || name.includes('..') || name.includes('//') || name.endsWith('.lock') || name.endsWith('/') || name.endsWith('.')) {
        return unknown('malformed-response');
      }
      const expectedObject = expectation(request, 'object');
      if (expectedObject !== undefined && (typeof expectedObject !== 'string' || !OBJECT_ID.test(expectedObject))) return unknown('malformed-response');
      const signed = expectation(request, 'signed') === true;
      await git.assertReadable(request.signal);
      const ref = `refs/tags/${name}`;
      const tag = await git.lookup(ref, request.signal);
      if (!tag) return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { tag: name, found: false } };
      const peeled = await git.lookup(`${ref}^{}`, request.signal);
      if (!peeled) return unknown('evidence-conflict');
      let hasSignature = false;
      if (tag.type === 'tag') {
        const body = await git.run(['cat-file', 'tag', tag.oid], { signal: request.signal });
        if (body.exitCode !== 0) return unknown('container-unreadable');
        hasSignature = /-----BEGIN (?:PGP|SSH) SIGNATURE-----/.test(body.stdout);
      }
      const signature = signed ? await signatureStatus(git, 'verify-tag', tag.oid, hasSignature, request.signal) : 'unchecked';
      const evidence = {
        tag: name, tagObject: tag.oid, annotated: tag.type === 'tag', object: peeled.oid,
        expectedObject: typeof expectedObject === 'string' ? expectedObject : null, signature, signatureRequired: signed,
      };
      // The tag name exists but points elsewhere: a replay would collide, so never `absent`.
      if (typeof expectedObject === 'string' && peeled.oid !== expectedObject && tag.oid !== expectedObject) return unknown('evidence-conflict', evidence);
      const blocked = signed ? signatureBlocks(signature) : null;
      if (blocked) return unknown(blocked, evidence);
      return { result: 'present', reason: 'state-match', complete: true, evidence };
    },
  };
}
