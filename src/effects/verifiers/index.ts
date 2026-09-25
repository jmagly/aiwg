/**
 * Effect verifiers (#2718, epic #2714): the tri-state verifier interface, the
 * registry, and the built-in verifiers.
 *
 * ## Interface
 *
 * A verifier is a plain object:
 *
 * ```ts
 * interface EffectVerifier {
 *   readonly kind: string;             // core kind or x.<vendor>.<name>
 *   readonly version: string;          // semver, recorded in every verification
 *   readonly canReportAbsent: boolean; // false: any `absent` becomes `unknown`
 *   verify(request: EffectVerifierRequest): Promise<EffectVerifierObservation>;
 * }
 * ```
 *
 * `verify` receives the intent's identity (`effectId`, `scope`, `kind`,
 * `target`, `context`, `payloadDigest`, `intentRecordedAt`), the caller's
 * `expected` digests and references, and an `AbortSignal` that fires at the
 * framework timeout. It answers `{result, reason, complete, evidence?}` with a
 * reason code from the contract table. Classified failures either return
 * `unknown` or throw `EffectVerifierError(reason)`.
 *
 * The framework (`runVerifier`, used by `reconcileEffect`) never lets a
 * verifier bypass the rules: a missing verifier, a kind or pinned-version
 * mismatch, any throw, a timeout, a malformed answer, a reason that does not
 * belong to the result, `absent` from a verifier that cannot report it, and
 * `absent` without `complete: true` all become `unknown`. Evidence is digested
 * into `evidenceDigest`; only the digest reaches the ledger.
 *
 * ## Registering
 *
 * ```ts
 * const registry = createBuiltinVerifierRegistry(
 *   { git: { repoDir }, file: { root }, decision: { receipts, jobs } },
 *   [...createTrackerVerifiers({ config, remoteUrls }), myVendorVerifier],   // extensions
 * );
 * await reconcileEffect(ledger, id, { verifiers: registry, expected: { signed: true } });
 * ```
 *
 * ## Extension point: `x.<vendor>.<name>`
 *
 * A vendor verifier uses a kind matching
 * `^x\.[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` and a target in the
 * `x-<vendor>:<ref>` scheme, and is passed in the extension list (or to
 * `createVerifierRegistry`). It follows exactly the same interface and rules;
 * it cannot shadow a registered kind, and adding a new core kind is a contract
 * revision.
 *
 * @see docs/contracts/effect-ledger.v1.md "Verifier interface"
 */

import { createVerifierRegistry } from './registry.js';
import { decisionReceiptVerifier, reviewContinuationPlaceholderVerifier, type DecisionReceiptVerifierOptions } from './decision.js';
import { FILE_DIGEST_VERIFIER_VERSION, fileDigestVerifier, type FileDigestVerifierOptions } from './file.js';
import { GIT_VERIFIER_VERSION, gitCommitVerifier, gitTagVerifier, type GitVerifierOptions } from './git.js';
import { EffectVerifierError, type EffectVerifier, type EffectVerifierRegistry } from './types.js';

export * from './types.js';
export {
  DEFAULT_VERIFIER_TIMEOUT_MS,
  createVerifierRegistry,
  evidenceDigest,
  runVerifier,
  type RunVerifierOptions,
  type VerifierRun,
} from './registry.js';
export {
  GIT_VERIFIER_VERSION,
  gitCommitVerifier,
  gitTagVerifier,
  type GitSignatureStatus,
  type GitVerifierOptions,
  type VerifierGitResult,
  type VerifierGitRunner,
} from './git.js';
export { FILE_DIGEST_VERIFIER_VERSION, fileDigestVerifier, type FileDigestVerifierOptions } from './file.js';
export {
  DECISION_RECEIPT_VERIFIER_VERSION,
  REVIEW_CONTINUATION_PLACEHOLDER_VERSION,
  decisionReceiptVerifier,
  reviewContinuationPlaceholderVerifier,
  type DecisionReceiptVerifierOptions,
} from './decision.js';

export {
  DEFAULT_MAX_COMMENT_PAGES,
  DEFAULT_MIN_ABSENT_AGE_MS,
  TRACKER_VERIFIER_VERSION,
  createTrackerVerifiers,
  parseEffectIdTrailers,
  parseEffectMarkers,
  renderEffectMarker,
  trackerCommentVerifier,
  trackerIssueClosedVerifier,
  trackerPrMergedVerifier,
  type TrackerCliOptions,
  type TrackerVerifierOptions,
} from './tracker.js';

export interface BuiltinVerifierOptions {
  /** `git.commit` and `git.tag`. Without it both answer `unknown` / `container-unreadable`. */
  git?: GitVerifierOptions;
  /** `file.digest`. Without it the verifier answers `unknown` / `container-unreadable`. */
  file?: FileDigestVerifierOptions;
  /** `decision.receipt`. Stores that are not supplied answer `unknown` / `container-unreadable`. */
  decision?: DecisionReceiptVerifierOptions;
}

/** Stand-in for a built-in whose container is not configured on this host. */
function unconfigured(kind: string, version: string): EffectVerifier {
  return {
    kind, version, canReportAbsent: true,
    async verify() { throw new EffectVerifierError('container-unreadable', 'Effect verifier is not configured on this host'); },
  };
}

/**
 * The five built-in verifiers: `git.commit`, `git.tag`, `file.digest`,
 * `decision.receipt` and the `decision.review.continuation` placeholder.
 */
export function createBuiltinVerifiers(options: BuiltinVerifierOptions = {}): EffectVerifier[] {
  return [
    options.git ? gitCommitVerifier(options.git) : unconfigured('git.commit', GIT_VERIFIER_VERSION),
    options.git ? gitTagVerifier(options.git) : unconfigured('git.tag', GIT_VERIFIER_VERSION),
    options.file ? fileDigestVerifier(options.file) : unconfigured('file.digest', FILE_DIGEST_VERIFIER_VERSION),
    decisionReceiptVerifier(options.decision ?? {}),
    reviewContinuationPlaceholderVerifier(),
  ];
}

/** A registry of the built-ins plus `extensions` (tracker verifiers, `x.<vendor>.<name>` kinds). Duplicate kinds are refused. */
export function createBuiltinVerifierRegistry(options: BuiltinVerifierOptions = {}, extensions: EffectVerifier[] = []): EffectVerifierRegistry {
  return createVerifierRegistry([...createBuiltinVerifiers(options), ...extensions]);
}
