/**
 * Built-in `file.digest` verifier: a realpath-contained regular file exists
 * with the expected SHA-256.
 *
 * Target `file:<path>@sha256:<hex>`; `<path>` is relative to the configured
 * root (an absolute path must lie inside it). A lexical or symlink escape from
 * the root is `unknown` / `container-unreadable`, never `absent`.
 *
 * @see docs/contracts/effect-ledger.v1.md "Built-in verifiers"
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { EffectVerifier, EffectVerifierObservation } from './types.js';

export interface FileDigestVerifierOptions {
  /** The only directory tree this verifier may read. */
  root: string;
}

export const FILE_DIGEST_VERIFIER_VERSION = '1.0.0';

const TARGET = /^file:(.+)@(sha256:[a-f0-9]{64})$/;

const unknown = (reason: EffectVerifierObservation['reason']): EffectVerifierObservation => ({ result: 'unknown', reason, complete: false });

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' ? false : !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

export function fileDigestVerifier(options: FileDigestVerifierOptions): EffectVerifier {
  if (!options || typeof options.root !== 'string' || !options.root) throw new TypeError('file.digest verifier needs a root');
  const configuredRoot = resolve(options.root);
  return {
    kind: 'file.digest',
    version: FILE_DIGEST_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const match = TARGET.exec(request.target);
      if (!match) return unknown('malformed-response');
      const [, path, digest] = match;
      const expected = request.expected.digest ?? request.context.digest;
      if (expected !== undefined && expected !== digest) return unknown('evidence-conflict');
      let root: string;
      try { root = await realpath(configuredRoot); } catch { return unknown('container-unreadable'); }
      // An absolute path spelled under the configured (non-canonical) root is rebased onto its realpath.
      const lexical = isAbsolute(path) && inside(configuredRoot, resolve(path))
        ? resolve(root, relative(configuredRoot, resolve(path)))
        : resolve(root, path);
      if (!inside(root, lexical)) return unknown('container-unreadable');
      let real: string;
      try { real = await realpath(lexical); }
      catch (error) {
        if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTDIR') return unknown('container-unreadable');
        // Missing: `absent` only when the nearest existing ancestor is itself contained.
        let parent = dirname(lexical);
        for (;;) {
          try {
            const realParent = await realpath(parent);
            if (realParent !== root && !inside(root, realParent)) return unknown('container-unreadable');
            break;
          } catch (inner) {
            if (errno(inner) !== 'ENOENT' && errno(inner) !== 'ENOTDIR') return unknown('container-unreadable');
            if (parent === dirname(parent)) return unknown('container-unreadable');
            parent = dirname(parent);
          }
        }
        const evidence = { path, expectedDigest: digest, found: false };
        return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence };
      }
      if (!inside(root, real)) return unknown('container-unreadable');
      let actual: string;
      try {
        const stats = await lstat(real);
        if (!stats.isFile()) return unknown('evidence-conflict');
        actual = await sha256File(real, request.signal);
      } catch (error) {
        if (request.signal.aborted) throw error;
        return unknown('container-unreadable');
      }
      const evidence = { path, expectedDigest: digest, actualDigest: actual, found: true };
      return actual === digest
        ? { result: 'present', reason: 'digest-match', complete: true, evidence }
        : { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence };
    },
  };
}
