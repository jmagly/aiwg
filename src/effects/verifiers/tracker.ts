/**
 * Tracker verifiers (#2719): `tracker.comment`, `tracker.issue.closed` and
 * `tracker.pr.merged` for Gitea and GitHub.
 *
 * - **Authority.** The tracker comes from `resolveTrackerAuthority` over the
 *   project config and git remote URLs. A target whose forge is neither the
 *   internal nor the customer tracker, or whose repository differs from that
 *   tracker remote, is `unknown` / `tracker-blocked`. The API base is derived
 *   from the selected remote URL; no host is assumed.
 * - **Access order.** `chooseTrackerAccess` over the probes a CLI process can
 *   offer: the tracker HTTP API (with credentials from the existing tracker
 *   token path, `resolveToken`), then the forge CLI (`gh`, GitHub only). MCP
 *   is never offered. A blocker is `unknown` / `tracker-blocked`.
 * - **Matching.** A comment matches exactly when it carries the
 *   `<!-- aiwg-effect: <id> -->` marker and was written by the pinned tracker
 *   actor; a merged PR matches its merge commit's `Effect-Id:` trailer.
 *   Author and time-window matches give `heuristic-match` and never `absent`.
 * - **Absent.** Only after an authenticated, complete query (every comment
 *   page read, or an authoritative issue/PR state read) and once the intent is
 *   older than `minAbsentAgeMs`; a younger intent is `unknown` /
 *   `consistency-lag`.
 *
 * Access material stays inside the transport: evidence carries IDs, SHAs and
 * digests only, and errors carry fixed messages.
 *
 * @see docs/contracts/effect-ledger.v1.md "Tracker verifiers"
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AiwgConfig, TrackerActorConfig } from '../../config/aiwg-config.js';
import { resolveToken } from '../../issues/live.js';
import {
  chooseTrackerAccess,
  resolveTrackerAuthority,
  type TrackerAccessProbe,
  type TrackerAuthority,
} from '../../tracker/capability-protocol.js';
import {
  ForgeReadError,
  cliForgeTransport,
  createForgeReader,
  forgeEndpointFromRemote,
  httpForgeTransport,
  type ForgeCliRunner,
  type ForgeProvider,
  type ForgeReadFailure,
  type ForgeReader,
} from '../../tracker/forge-http.js';
import { sha256Digest } from '../identity.js';
import type { UnknownReason } from '../types.js';
import { EffectVerifierError, type EffectVerifier, type EffectVerifierEvidence, type EffectVerifierObservation, type EffectVerifierRequest } from './types.js';

export const TRACKER_VERIFIER_VERSION = '1.0.0';

/** Default minimum intent age before a tracker verifier may answer `absent`. */
export const DEFAULT_MIN_ABSENT_AGE_MS = 60_000;
/** Default page bound for a comment scan; more pages is `unknown` / `paging-incomplete`. */
export const DEFAULT_MAX_COMMENT_PAGES = 100;

const TARGET = /^(gitea|github):([\w.-]+\/[\w.-]+)#([1-9][0-9]{0,9})$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MARKER = /<!--\s*aiwg-effect:\s*([^\s<>]+)\s*-->/g;
const HEURISTIC_SKEW_MS = 60_000;

/** The hidden marker line a writer embeds in a tracker comment so the verifier can match it exactly. */
export function renderEffectMarker(effectId: string): string {
  if (typeof effectId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(effectId)) throw new TypeError('Effect ID is required');
  return `<!-- aiwg-effect: ${effectId} -->`;
}

/** Effect IDs named by `aiwg-effect` markers in a comment body. */
export function parseEffectMarkers(body: string): string[] {
  return [...String(body ?? '').matchAll(MARKER)].map(match => match[1]);
}

/** Values of `Effect-Id:` trailer lines in a commit message. */
export function parseEffectIdTrailers(message: string): string[] {
  return String(message ?? '').split(/\r?\n/).map(line => /^Effect-Id:\s*(\S+)\s*$/i.exec(line)?.[1]).filter((id): id is string => Boolean(id));
}

export interface TrackerCliOptions {
  /** Whether the forge CLI is installed. Defaults to a PATH lookup of `binary`. */
  available?: boolean;
  /** Whether the CLI is authenticated; `false` removes it from the access order. */
  authenticated?: boolean;
  binary?: string;
  /** Test seam; defaults to spawning `binary`. */
  runner?: ForgeCliRunner;
}

export interface TrackerVerifierOptions {
  /** The project `.aiwg/aiwg.config`; tracker authority, remotes and pinned actors come from it. */
  config: AiwgConfig | null | undefined;
  /** Git remote name to URL, e.g. from `git remote get-url`. */
  remoteUrls: Record<string, string | undefined>;
  /** Source of tracker credentials via `resolveToken`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The forge CLI access path (GitHub `gh`), or `false` to disable it. */
  cli?: TrackerCliOptions | false;
  /** Default 60 s. A younger intent never gives `absent`. */
  minAbsentAgeMs?: number;
  /** Author and time-window heuristic for `tracker.comment`; `0` (default) disables it. */
  heuristicWindowMs?: number;
  maxPages?: number;
  pageSize?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

interface Lane {
  provider: ForgeProvider;
  repository: string;
  number: number;
  access: 'http-api' | 'cli';
  reader: ForgeReader;
  actor: TrackerActorConfig | undefined;
}

const FAILURE_REASON: Record<ForgeReadFailure, UnknownReason> = {
  'auth-denied': 'auth-denied',
  'not-found': 'container-unreadable',
  'rate-limited': 'rate-limited',
  'server-error': 'server-error',
  'network-error': 'network-error',
  timeout: 'timeout',
  oversized: 'malformed-response',
  malformed: 'malformed-response',
  'unexpected-status': 'server-error',
};

async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ForgeReadError) throw new EffectVerifierError(FAILURE_REASON[error.code]);
    if (error instanceof EffectVerifierError) throw error;
    throw new EffectVerifierError('network-error');
  }
}

function onPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];
  return dirs.some(dir => names.some(name => {
    try { accessSync(join(dir, name), fsConstants.X_OK); return true; } catch { return false; }
  }));
}

/** Resolve the tracker lane for a target: authority, remote, access path and reader. Throws `tracker-blocked`. */
function resolveLane(options: TrackerVerifierOptions, target: string): Lane {
  const parsed = TARGET.exec(target);
  if (!parsed) throw new EffectVerifierError('malformed-response', 'Tracker target must be gitea:owner/repo#N or github:owner/repo#N');
  const provider = parsed[1] as ForgeProvider;
  const number = Number(parsed[3]);
  const authority = resolveTrackerAuthority(options.config, options.remoteUrls);
  const remotes = options.config?.remotes;
  let lane: { remote: string; url: string | undefined; actor: TrackerActorConfig | undefined } | null = null;
  if (authority.provider === provider) {
    lane = { remote: authority.issueTrackerRemote, url: authority.issueTrackerUrl, actor: remotes?.tracker_actor };
  } else if (authority.customerIssueTrackerRemote && authority.customerProvider === provider) {
    lane = { remote: authority.customerIssueTrackerRemote, url: authority.customerIssueTrackerUrl, actor: remotes?.customer_tracker_actor };
  }
  if (!lane) throw new EffectVerifierError('tracker-blocked');
  const endpoint = forgeEndpointFromRemote(provider, lane.url);
  if (!endpoint || endpoint.repository.toLowerCase() !== parsed[2].toLowerCase()) throw new EffectVerifierError('tracker-blocked');
  const laneAuthority: TrackerAuthority = { ...authority, provider, issueTrackerRemote: lane.remote, issueTrackerUrl: lane.url };

  const token = resolveToken(provider, options.env ?? process.env);
  const cli = options.cli === false ? null : options.cli ?? {};
  const cliAvailable = provider === 'github' && cli !== null && (cli.available ?? onPath(cli.binary ?? 'gh'));
  const probes: TrackerAccessProbe[] = [
    { kind: 'http-api', provider, remoteName: lane.remote, available: Boolean(token), authenticated: Boolean(token) },
    { kind: 'cli', provider, remoteName: lane.remote, cli: cli?.binary ?? 'gh', available: cliAvailable, ...(cli?.authenticated !== undefined ? { authenticated: cli.authenticated } : {}) },
  ];
  const decision = chooseTrackerAccess(laneAuthority, probes);
  const readerOptions = options.pageSize ? { pageSize: options.pageSize } : {};
  if (decision.kind === 'http-api' && token) {
    const transport = httpForgeTransport({ provider, apiBaseUrl: endpoint.apiBaseUrl, token, fetchImpl: options.fetchImpl, maxResponseBytes: options.maxResponseBytes });
    return { provider, repository: endpoint.repository, number, access: 'http-api', reader: createForgeReader(provider, transport, readerOptions), actor: lane.actor };
  }
  if (decision.kind === 'cli' && cli) {
    const transport = cliForgeTransport({ provider, hostname: endpoint.host, runner: cli.runner, binary: cli.binary, maxResponseBytes: options.maxResponseBytes });
    return { provider, repository: endpoint.repository, number, access: 'cli', reader: createForgeReader(provider, transport, readerOptions), actor: lane.actor };
  }
  throw new EffectVerifierError('tracker-blocked');
}

const unknown = (reason: UnknownReason, evidence?: EffectVerifierEvidence): EffectVerifierObservation =>
  ({ result: 'unknown', reason, complete: false, ...(evidence ? { evidence } : {}) });

/** `absent` once the intent is old enough, else `unknown` / `consistency-lag`. */
function absentOrLag(options: TrackerVerifierOptions, request: EffectVerifierRequest, evidence: EffectVerifierEvidence): EffectVerifierObservation {
  const recorded = Date.parse(request.intentRecordedAt);
  if (!Number.isFinite(recorded)) return unknown('malformed-response');
  const now = (options.now ?? Date.now)();
  if (now - recorded < (options.minAbsentAgeMs ?? DEFAULT_MIN_ABSENT_AGE_MS)) return unknown('consistency-lag', evidence);
  return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence };
}

const sameLogin = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function expectedString(request: EffectVerifierRequest, name: 'digest' | 'object'): string | undefined {
  const value = request.expected[name] ?? request.context[name];
  return typeof value === 'string' ? value : undefined;
}

function laneEvidence(lane: Lane): EffectVerifierEvidence {
  return { tracker: lane.provider, repository: lane.repository, number: lane.number, access: lane.access };
}

/** `tracker.comment`: target `gitea:owner/repo#N` or `github:owner/repo#N` (an issue or PR). */
export function trackerCommentVerifier(options: TrackerVerifierOptions): EffectVerifier {
  return {
    kind: 'tracker.comment',
    version: TRACKER_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const lane = resolveLane(options, request.target);
      const expectedDigest = expectedString(request, 'digest');
      if (expectedDigest !== undefined && !DIGEST.test(expectedDigest)) return unknown('malformed-response');
      const pinned = lane.actor?.login;
      const forbidden = lane.actor?.forbid_actors ?? [];
      const recorded = Date.parse(request.intentRecordedAt);
      const windowMs = options.heuristicWindowMs ?? 0;
      const maxPages = options.maxPages ?? DEFAULT_MAX_COMMENT_PAGES;
      const base = laneEvidence(lane);
      let foreignMarker = false;
      let digestMatch: { id: number; bodyDigest: string } | null = null;
      let heuristic: { id: number; bodyDigest: string } | null = null;
      let scanned = 0;
      let complete = false;
      let pages = 0;
      for (let page: number | null = 1; page !== null;) {
        if (pages >= maxPages) break;
        const current: number = page;
        const result = await read(() => lane.reader.listIssueComments(lane.repository, lane.number, current, request.signal));
        pages += 1;
        for (const comment of result.items) {
          scanned += 1;
          const authorIsPinned = Boolean(pinned) && sameLogin(comment.author, pinned) && !forbidden.some(name => sameLogin(name, comment.author));
          const bodyDigest = sha256Digest(comment.body);
          if (parseEffectMarkers(comment.body).includes(request.effectId)) {
            if (!authorIsPinned) { foreignMarker = true; continue; }
            const evidence = { ...base, commentId: comment.id, bodyDigest, pages, scanned, confidence: 'exact' };
            if (expectedDigest !== undefined) {
              return bodyDigest === expectedDigest
                ? { result: 'present', reason: 'digest-match', complete: true, evidence }
                : unknown('evidence-conflict', evidence);
            }
            return { result: 'present', reason: bodyDigest === request.payloadDigest ? 'digest-match' : 'marker-match', complete: true, evidence };
          }
          if (!authorIsPinned) continue;
          if (!digestMatch && bodyDigest === (expectedDigest ?? request.payloadDigest)) digestMatch = { id: comment.id, bodyDigest };
          const created = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
          if (!heuristic && windowMs > 0 && Number.isFinite(recorded) && Number.isFinite(created)
            && created >= recorded - HEURISTIC_SKEW_MS && created <= recorded + windowMs) heuristic = { id: comment.id, bodyDigest };
        }
        if (result.nextPage === null) { complete = result.complete; page = null; }
        else if (result.nextPage <= current) { page = null; }
        else page = result.nextPage;
      }
      const summary = { ...base, pages, scanned };
      // A marker for this effect under another author is never ours; escalate instead of replaying.
      if (foreignMarker) return unknown('evidence-conflict', { ...summary, foreignMarker: true });
      if (digestMatch) {
        return { result: 'present', reason: 'digest-match', complete, evidence: { ...summary, commentId: digestMatch.id, bodyDigest: digestMatch.bodyDigest, confidence: 'exact' } };
      }
      if (heuristic) {
        return { result: 'present', reason: 'heuristic-match', complete: false, evidence: { ...summary, commentId: heuristic.id, bodyDigest: heuristic.bodyDigest, confidence: 'heuristic' } };
      }
      if (!complete) return unknown('paging-incomplete', summary);
      return absentOrLag(options, request, { ...summary, found: false });
    },
  };
}

/** `tracker.issue.closed`: target `gitea:owner/repo#N` or `github:owner/repo#N`. */
export function trackerIssueClosedVerifier(options: TrackerVerifierOptions): EffectVerifier {
  return {
    kind: 'tracker.issue.closed',
    version: TRACKER_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const lane = resolveLane(options, request.target);
      const issue = await read(() => lane.reader.getIssue(lane.repository, lane.number, request.signal));
      const evidence = { ...laneEvidence(lane), state: issue.state, closedAt: issue.closedAt };
      if (issue.state === 'closed') return { result: 'present', reason: 'state-match', complete: true, evidence };
      return absentOrLag(options, request, evidence);
    },
  };
}

/**
 * `tracker.pr.merged`: target `gitea:owner/repo#N` or `github:owner/repo#N`.
 * The expected merge commit comes from `expected.object` or `context.object`.
 */
export function trackerPrMergedVerifier(options: TrackerVerifierOptions): EffectVerifier {
  return {
    kind: 'tracker.pr.merged',
    version: TRACKER_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const expectedSha = expectedString(request, 'object');
      if (expectedSha !== undefined && !OBJECT_ID.test(expectedSha)) return unknown('malformed-response');
      const lane = resolveLane(options, request.target);
      const pr = await read(() => lane.reader.getPullState(lane.repository, lane.number, request.signal));
      const evidence: EffectVerifierEvidence = {
        ...laneEvidence(lane), state: pr.state, merged: pr.merged, mergedAt: pr.mergedAt,
        mergeCommit: pr.mergeCommitSha, expectedMergeCommit: expectedSha ?? null, baseSha: pr.baseSha,
      };
      if (!pr.merged) return absentOrLag(options, request, evidence);
      if (!pr.mergeCommitSha) return unknown(expectedSha ? 'malformed-response' : 'consistency-lag', evidence);
      if (expectedSha !== undefined && pr.mergeCommitSha !== expectedSha) {
        // Merged, but not as this effect expected: the expected merge did not happen.
        return absentOrLag(options, request, { ...evidence, mergeCommitMatch: false });
      }
      // The merge commit trailer is a second, exact check; the PR state stays authoritative without it.
      let marker: boolean | null = null;
      try {
        const message = await lane.reader.getCommitMessage(lane.repository, pr.mergeCommitSha, request.signal);
        marker = message === null ? null : parseEffectIdTrailers(message).includes(request.effectId);
      } catch {
        marker = null;
      }
      return {
        result: 'present', reason: marker ? 'marker-match' : 'state-match', complete: true,
        evidence: { ...evidence, mergeCommitMatch: expectedSha !== undefined ? true : null, marker },
      };
    },
  };
}

/** The three tracker verifiers, for `createBuiltinVerifierRegistry(options, createTrackerVerifiers(...))`. */
export function createTrackerVerifiers(options: TrackerVerifierOptions): EffectVerifier[] {
  return [trackerCommentVerifier(options), trackerIssueClosedVerifier(options), trackerPrMergedVerifier(options)];
}
