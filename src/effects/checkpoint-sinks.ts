/**
 * Independent checkpoint sinks. A local chain alone cannot detect deletion of
 * a whole segment or of its tail, so every checkpoint is also published to a
 * sink the ledger directory does not control.
 *
 * - `gitRefCheckpointSink` (the default) stores the canonical checkpoint as a
 *   git blob and moves `refs/aiwg/effects/<subsystem>/checkpoint` to it with a
 *   compare-and-swap `update-ref`.
 * - `memoryCheckpointSink` is for tests and embedding hosts.
 * - Other sinks (for example the #1567 operator-decision audit) implement the
 *   same `CheckpointSink` port.
 */

import { spawn } from 'node:child_process';
import { canonicalJson } from '../security/artifact-trust.js';
import { EffectLedgerError } from './errors.js';
import type { EffectCheckpoint, EffectScope, EffectSubsystem } from './types.js';

export interface CheckpointSinkReceipt {
  sink: string;
  reference: string;
}

export interface CheckpointSink {
  readonly name: string;
  publish(checkpoint: EffectCheckpoint): Promise<CheckpointSinkReceipt>;
  /** The most recent published checkpoint for `scope`, or null when none was published. */
  latest(scope: EffectScope): Promise<EffectCheckpoint | null>;
}

export interface GitResult { stdout: string; exitCode: number }
export type GitRunner = (args: string[], stdin?: string) => Promise<GitResult>;

const sinkError = (message: string) => new EffectLedgerError('internal', message, 'checkpoint-sink-unavailable');

function defaultGitRunner(repoDir: string): GitRunner {
  return (args, stdin = '') => new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoDir, ...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.stdin.once('error', () => { /* the exit code is authoritative */ });
    child.once('close', code => resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

export interface GitRefCheckpointSinkOptions {
  repoDir: string;
  subsystem: EffectSubsystem;
  /** Defaults to `refs/aiwg/effects/<subsystem>/checkpoint`. */
  ref?: string;
  runner?: GitRunner;
}

export function gitRefCheckpointSink(options: GitRefCheckpointSinkOptions): CheckpointSink {
  const ref = options.ref ?? `refs/aiwg/effects/${options.subsystem}/checkpoint`;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new EffectLedgerError('usage', 'Invalid checkpoint ref', 'invalid-ref');
  const git = options.runner ?? defaultGitRunner(options.repoDir);
  const current = async (): Promise<string | null> => {
    const result = await git(['rev-parse', '-q', '--verify', ref]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  return {
    name: 'git-ref',
    async publish(checkpoint) {
      let previous: string | null;
      try { previous = await current(); } catch { throw sinkError('Git checkpoint sink is unavailable'); }
      const stored = await git(['hash-object', '-w', '--stdin'], `${canonicalJson(checkpoint)}\n`).catch(() => null);
      const oid = stored?.stdout.trim();
      if (!stored || stored.exitCode !== 0 || !oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw sinkError('Git checkpoint sink could not store the checkpoint');
      const moved = await git(['update-ref', '-m', `aiwg effect checkpoint ${checkpoint.sequence}`, ref, oid, previous ?? '']).catch(() => null);
      if (!moved || moved.exitCode !== 0) throw sinkError('Git checkpoint sink ref moved concurrently or could not be updated');
      return { sink: 'git-ref', reference: `${ref}@${oid}` };
    },
    async latest() {
      let head: string | null;
      try { head = await current(); } catch { throw sinkError('Git checkpoint sink is unavailable'); }
      if (!head) return null;
      const blob = await git(['cat-file', 'blob', head]).catch(() => null);
      if (!blob || blob.exitCode !== 0) throw sinkError('Git checkpoint sink ref is unreadable');
      try { return JSON.parse(blob.stdout) as EffectCheckpoint; }
      catch { throw sinkError('Git checkpoint sink holds a malformed checkpoint'); }
    },
  };
}

/** In-memory sink. `published` holds every checkpoint in publication order. */
export function memoryCheckpointSink(): CheckpointSink & { published: EffectCheckpoint[] } {
  const published: EffectCheckpoint[] = [];
  return {
    name: 'memory',
    published,
    async publish(checkpoint) {
      published.push(structuredClone(checkpoint));
      return { sink: 'memory', reference: `memory#${published.length - 1}` };
    },
    async latest(scope) {
      const match = [...published].reverse().find(entry => canonicalJson(entry.scope) === canonicalJson(scope));
      return match ? structuredClone(match) : null;
    },
  };
}
