// Validate pinned inputs and combine per-gate outcomes into a deterministic report.
import { seriesFor, metricKindOf, expandScope, evaluateObservation } from './observations.js';
import { ceilingDecision, maxOutcome } from './lattice.js';
import { evaluateUpstreamCeiling, type QualificationIntegrityMetadata } from './upstream-ceiling.js';
import { artifactDigest } from '../decision/validate.js';
import { GateRegistry, authoredGatePacksOf, gateProvidersOf, resolveGateBinding } from './registry.js';
import type { ProjectFloors } from './floors.js';
import {
  GATE_PROVIDER_DEFAULT_TIMEOUT_MS, GATE_PROVIDER_MAX_OUTPUT_BYTES,
  deriveIsolatedSeed, isLoaderIssuedProvider, runIsolatedProviderSync, sealProviderSection,
} from './providers/loader.js';
import type { ProviderRuntime } from './providers/types.js';
import type {
  GateBinding, GateDefinition, GateEvidence, GateHoldoutInputs, GateMetricsDocument, GateOutcome, GateReport,
  GateStatus, ProviderMetrics, Sha256Digest, UpstreamCeiling,
} from './types.js';

export class GateEvaluationError extends Error {
  constructor(message: string) { super(message); this.name = 'GateEvaluationError'; }
}

export { maxOutcome } from './lattice.js';

/**
 * Per-gate outcome from its own status: `pass` promotes, `fail` takes the
 * gate's `onFail`, `insufficient` takes `onInsufficient` (always HOLD by load
 * validation; ROLLBACK needs an observed blocking failure). Shortfalls never PROMOTE.
 */
export function gateStatusOutcome(status: GateStatus, gate: Pick<GateDefinition, 'onFail' | 'onInsufficient'>): GateOutcome {
  if (status === 'pass') return 'PROMOTE';
  if (status === 'fail') return gate.onFail;
  return gate.onInsufficient ?? 'HOLD';
}

export interface EvaluateGatesInput {
  /** The binding under evaluation. Resolved internally against `registry`; never trusted from the caller. */
  binding: GateBinding;
  /** Registry holding every pinned pack and provider. Resolution re-derives packs, digests and parameters. */
  registry: GateRegistry;
  trustedBindingDigest: Sha256Digest;
  /** Required trusted holdout record (first-access time + frozen-record digest). Absent refuses. */
  holdout: GateHoldoutInputs;
  metrics: GateMetricsDocument;
  upstream: UpstreamCeiling | null;
  /**
   * Required trusted project floors, loaded from `.aiwg/aiwg.config` by the
   * caller via `resolveProjectFloors` (see `src/gates/floors.ts`). Like
   * `trustedBindingDigest` and `holdout`, floors are caller-asserted project
   * policy: the evaluator re-derives pack pins, composition and tightening
   * from them but never fetches them. There is no absent state: pass
   * `'none-explicit-opt-out'` only for tests or legacy callers with a
   * documented reason, which skips the check exactly like the pre-floors
   * path. An `undefined` floors input refuses evaluation.
   */
  floors: ProjectFloors | 'none-explicit-opt-out';
  /** Fake-clock timestamp (ISO date-time). Recorded as evaluatedAt, so identical inputs give identical bytes. */
  now: string;
  /**
   * Isolated re-run inputs for bundle-provider bindings (records binding,
   * P4). Every binding pin carrying a code digest must be covered: the
   * evaluator re-runs the pinned provider over records digesting to the
   * pin's records digest and uses the re-run output. Caller-asserted metrics
   * for provider-backed gates are never accepted. Absent coverage refuses
   * evaluation (the file path cannot reproduce provider output).
   */
  providerRuntime?: ProviderRuntime;
  /**
   * Report provenance label, recorded in the report body (and its digest).
   * The offline CLI passes `'offline-cli'`; library callers leave it absent,
   * which keeps their reports byte-identical.
   */
  attestation?: 'offline-cli';
  /**
   * Removed: caller-supplied resolution is never accepted (it let callers drop
   * packs, empty gates or loosen parameters under a pinned digest). Present only
   * so old call sites fail with a clear refusal instead of a type error.
   */
  resolved?: never;
}

/** Binds an integrity report for evaluation. The digest is re-derived on every use; a forged copy is refused. */
export function sealUpstream(metadata: QualificationIntegrityMetadata): UpstreamCeiling {
  return { metadata, digest: artifactDigest(metadata) };
}

/**
 * Seals trusted holdout inputs for evaluation. The seal covers
 * `{frozenDigest, firstAccessedAt}` and is re-derived by `evaluateGates` on
 * every use, following the HeldoutFrozen seal (`readHeldoutFrozen` checks
 * `frozen.digest === heldoutDigest(frozen.bundle)`): a spread-copied or edited
 * record is refused. The seal is an unkeyed integrity digest, not an
 * authenticity proof, so the holdout inputs are trusted caller inputs built from
 * verified HeldoutFrozen and access records via `sealGateHoldoutFromFrozen`
 * in `./heldout.js`. `frozenDigest` is the binding digest pinned by that record.
 */
export function sealGateHoldout(input: {
  frozenDigest: Sha256Digest; firstAccessedAt: string | null;
}): import('./types.js').GateHoldoutInputs {
  const payload = { frozenDigest: input.frozenDigest, firstAccessedAt: input.firstAccessedAt };
  return { ...payload, digest: artifactDigest(payload) as Sha256Digest };
}

const fail = (message: string): never => { throw new GateEvaluationError(message); };

function digestRecordsOrFail(records: readonly unknown[], providerId: string): Sha256Digest {
  try {
    return artifactDigest(records) as Sha256Digest;
  } catch {
    return fail(`metric provider ${providerId} records are not digestible`);
  }
}

function serializeRecordsOrFail(records: readonly unknown[], providerId: string): string {
  try {
    const serialized = JSON.stringify(records);
    if (typeof serialized !== 'string') throw new Error('unserializable');
    return serialized;
  } catch {
    return fail(`metric provider ${providerId} records are not JSON-serializable`);
  }
}

function rerunProviderOrFail(
  provider: Parameters<typeof runIsolatedProviderSync>[0],
  args: { recordsJson: string; clockMs: number; seed: number; timeoutMs: number; codeDigest: Sha256Digest },
  providerId: string,
): unknown {
  // C2: execute only the registry's loader-issued provider. The runner makes
  // its own copy of the loader-captured bytes, re-digests exactly the bytes it
  // sends to the sandbox and refuses unless they match the pinned digest.
  // Caller-supplied runtime objects (snapshot paths, digests) are never used.
  if (!isLoaderIssuedProvider(provider)) {
    return fail(`metric provider ${providerId} was not issued by the bundle loader: refusing to re-run it`);
  }
  try {
    return runIsolatedProviderSync(provider, {
      mode: 'invoke', recordsJson: args.recordsJson, clockMs: args.clockMs, seed: args.seed,
      expectedCodeDigest: args.codeDigest,
    }, { timeoutMs: args.timeoutMs, maxOutputBytes: GATE_PROVIDER_MAX_OUTPUT_BYTES }).result;
  } catch (error) {
    return fail(`metric provider ${providerId} re-run failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

function upstreamOutcome(upstream: UpstreamCeiling | null): { ceiling: GateOutcome; problems: string[] } {
  return evaluateUpstreamCeiling(upstream?.metadata ?? null);
}

/**
 * Pure, deterministic gate evaluation. The binding is resolved internally
 * against the registry: pack pins (authored + composed digests), provider pins
 * and parameters are re-derived, so no caller-supplied resolution is accepted.
 * Precondition violations (untrusted digests, provider pin mismatches,
 * missing trusted holdout inputs, frozen-after-holdout bindings) throw before
 * any gate runs, so failure paths never discard completed results. Per-gate
 * shortfalls report `insufficient`, which never promotes.
 *
 * Interval levels are two-sided confidence levels applied to one-sided bounds:
 * the reported bound is the one-sided edge of a two-sided interval, which is
 * conservative (wider) relative to a one-sided interval at the same level.
 */
export function evaluateGates(input: EvaluateGatesInput): GateReport {
  const { binding, registry, trustedBindingDigest, holdout, metrics, upstream, now } = input;
  if ('resolved' in (input as unknown as Record<string, unknown>)
    && (input as unknown as Record<string, unknown>).resolved !== undefined) {
    fail('caller-supplied gate resolution is not accepted: pass the binding and registry');
  }
  if (!(registry instanceof GateRegistry)) fail('a GateRegistry is required for internal resolution');
  if (input.floors === undefined) {
    fail('project floors are required: pass resolveProjectFloors(config) or \'none-explicit-opt-out\' with a documented reason');
  }
  const floors = input.floors === 'none-explicit-opt-out' ? undefined : input.floors;
  // Reserve before dispatch: resolve and fully validate the binding (pins,
  // providers, parameters, slices) before any gate observes any metric. The
  // resolution runs through the pure `resolveGateBinding` over a standalone
  // snapshot of the registry's authored packs: no overridable `GateRegistry`
  // instance method is called for anything security-relevant, so a subclass
  // that overrides `resolveBinding` (or a duck-typed `{resolveBinding}`)
  // cannot empty gates, loosen parameters or forge digests.
  const resolved = resolveGateBinding(binding, authoredGatePacksOf(registry), gateProvidersOf(registry), floors);
  const { packs, parameters } = resolved;
  // 1:1 pins<->packs: the pin list and the resolved packs must match exactly.
  if (packs.length !== binding.spec.packs.length) fail('binding pins do not match resolved packs 1:1');
  for (const pack of packs) {
    // Recompute the authored digest: the stored pin is never trusted on its own.
    if ((artifactDigest(pack.authored) as Sha256Digest) !== pack.digest) {
      fail(`pack digest mismatch for ${pack.authored.metadata.id}`);
    }
    // Recompute the composed digest from the evaluator's own pure composition
    // (`resolveGateBinding` above): registry-provided resolved bytes and
    // digests are never trusted.
    if ((artifactDigest(pack.resolved) as Sha256Digest) !== pack.resolvedDigest) {
      fail(`composed pack digest mismatch for ${pack.authored.metadata.id}`);
    }
    const pin = binding.spec.packs.find(candidate => candidate.id === pack.authored.metadata.id);
    if (pin === undefined || pin.version !== pack.authored.metadata.version
      || pin.digest !== pack.digest || pin.resolvedDigest !== pack.resolvedDigest) {
      fail(`pack pin mismatch for ${pack.authored.metadata.id}`);
    }
  }
  // Every metric section consumed must be pinned; an unpinned section is
  // refused rather than evaluated. Null version/digests never match. Bundle
  // sections (#2831 rework) additionally carry the trusted code digest and
  // the input-records digest sealed by the host: the section code digest must
  // match the binding pin (verified above against the loaded provider), never
  // a provider-declared field on its own. Sections covered by an isolated
  // re-run are reproduced below and their caller-asserted values ignored, so
  // a missing caller section is tolerated only with runtime coverage.
  const runtimeById = new Map((input.providerRuntime?.providers ?? []).map(provider => [provider.id, provider]));
  const runtimeCovers = (id: string): boolean =>
    runtimeById.has(id) && input.providerRuntime?.records[id] !== undefined;
  for (const pin of binding.spec.metricProviders) {
    const section = metrics.providers[pin.id];
    if (section === undefined && runtimeCovers(pin.id)) continue;
    if (section === undefined || section.version !== pin.version || section.sourceDigest !== pin.sourceDigest) {
      fail(`metric provider pin mismatch for ${pin.id}`);
    }
    const pinnedCode = (pin as { codeDigest?: unknown }).codeDigest;
    const sectionCode = (section as { codeDigest?: unknown }).codeDigest;
    const sectionRecords = (section as { recordsDigest?: unknown }).recordsDigest;
    if (typeof pinnedCode === 'string') {
      if (sectionCode !== pinnedCode) fail(`metric provider pin mismatch for ${pin.id}`);
      if (typeof sectionRecords !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(sectionRecords)) {
        fail(`metric provider pin mismatch for ${pin.id}`);
      }
    } else if (sectionCode !== undefined) {
      fail(`metric provider pin mismatch for ${pin.id}`);
    }
  }
  for (const id of Object.keys(metrics.providers)) {
    if (!binding.spec.metricProviders.some(pin => pin.id === id)) {
      fail(`metric provider ${id} is not pinned by the binding`);
    }
  }
  if (upstream !== null && artifactDigest(upstream.metadata) !== upstream.digest) {
    fail('upstream integrity digest does not match its report');
  }
  // Omitting the upstream record must never downgrade a bound ceiling to
  // HOLD: when the resolved binding observes any upstream-ceiling gate
  // (including the default floor's), evaluation without a sealed upstream is
  // refused here in the evaluator, not just at the CLI.
  if (upstream === null
    && packs.some(pack => pack.resolved.spec.gates.some(gate => gate.kind === 'upstream-ceiling'))) {
    fail('evaluation requires a sealed upstream record: the binding observes an upstream-ceiling gate');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('evaluation timestamp is not a valid date-time');
  if (artifactDigest(binding) !== trustedBindingDigest) fail('binding digest does not match its trusted pin');
  // Holdout freeze is enforced from the REQUIRED sealed holdout record, never
  // from binding fields (which the study author controls). The seal is
  // re-derived here: `frozenDigest` and `firstAccessedAt` come only from a
  // `sealGateHoldout` record whose digest matches its content.
  if (holdout === undefined || holdout === null) fail('trusted holdout inputs are required for evaluation');
  const sealed = holdout as { frozenDigest?: unknown; firstAccessedAt?: unknown; digest?: unknown };
  if (typeof sealed.digest !== 'string'
    || artifactDigest({ frozenDigest: sealed.frozenDigest, firstAccessedAt: sealed.firstAccessedAt }) !== sealed.digest) {
    fail('holdout record seal does not match its content');
  }
  if (sealed.frozenDigest !== trustedBindingDigest) fail('binding digest does not match the frozen record digest');
  const frozenDigest = sealed.frozenDigest as Sha256Digest;
  const firstAccessedAt = sealed.firstAccessedAt as string | null;
  if (firstAccessedAt !== null && typeof firstAccessedAt !== 'string') {
    fail('trusted holdout first-access time must be a date-time or null');
  }
  // Null access is allowed only when the binding declares no held-out split:
  // a split binding with a null record would disable the freeze check.
  const declaresSplit = binding.spec.splitDigest !== undefined
    || binding.spec.corpusDigest !== undefined || binding.spec.goldDigest !== undefined;
  if (firstAccessedAt === null && declaresSplit) {
    fail('holdout record reports no access but the binding declares held-out data');
  }
  const frozenAt = Date.parse(binding.spec.frozenAt);
  if (!Number.isFinite(frozenAt)) fail('binding freeze timestamp is not a valid date-time');
  if (frozenAt > nowMs) fail('binding freezes after the evaluation timestamp');
  if (firstAccessedAt !== null) {
    const accessedAt = Date.parse(firstAccessedAt);
    if (!Number.isFinite(accessedAt)) fail('holdout access timestamp is not a valid date-time');
    if (frozenAt >= accessedAt) fail('binding froze at or after holdout access: evaluation refused');
    if (accessedAt > nowMs) fail('holdout access timestamp is after the evaluation timestamp');
  }
  // Records binding (P4): every bundle-provider pin is reproduced by an
  // isolated re-run of the pinned provider over records digesting to the
  // pin's records digest, and the re-run output replaces the caller-asserted
  // section. Without runtime coverage the section cannot be reproduced and
  // evaluation refuses (fail closed, including the file path).
  const effectiveProviders: Record<string, ProviderMetrics> = { ...metrics.providers };
  for (const pin of binding.spec.metricProviders) {
    const pinnedCode = (pin as { codeDigest?: unknown }).codeDigest;
    if (typeof pinnedCode !== 'string') continue;
    const pinnedRecords = (pin as { recordsDigest?: unknown }).recordsDigest as Sha256Digest;
    const snapshot = runtimeById.get(pin.id) ?? fail(`metric provider ${pin.id} requires an isolated re-run`
      + ' over its pinned records: caller-asserted metrics cannot reproduce provider output');
    const records = input.providerRuntime?.records[pin.id] ?? fail(`metric provider ${pin.id} requires an isolated re-run`
      + ' over its pinned records: caller-asserted metrics cannot reproduce provider output');
    const registered = gateProvidersOf(registry).get(pin.id) as {
      version: string; sourceDigest: Sha256Digest; codeDigest?: unknown;
    };
    if (registered.version !== pin.version || registered.sourceDigest !== pin.sourceDigest
      || (registered.codeDigest as unknown) !== pinnedCode
      || snapshot.version !== pin.version || snapshot.sourceDigest !== pin.sourceDigest
      || snapshot.codeDigest !== pinnedCode) {
      fail(`metric provider pin mismatch for ${pin.id}`);
    }
    if (!Array.isArray(records)) fail(`metric provider ${pin.id} records must be an array`);
    const actualRecordsDigest = digestRecordsOrFail(records, pin.id);
    if (actualRecordsDigest !== pinnedRecords) {
      fail(`metric provider ${pin.id} records do not match the pinned records digest`);
    }
    const recordsJson = serializeRecordsOrFail(records, pin.id);
    const reproduced = rerunProviderOrFail(registered as unknown as { id: string }, {
      recordsJson, clockMs: nowMs, seed: deriveIsolatedSeed(pinnedCode, pinnedRecords),
      timeoutMs: input.providerRuntime?.timeoutMs ?? GATE_PROVIDER_DEFAULT_TIMEOUT_MS,
      codeDigest: pinnedCode as Sha256Digest,
    }, pin.id);
    try {
      effectiveProviders[pin.id] = sealProviderSection(
        registered as { id: string; version: string; sourceDigest: Sha256Digest; codeDigest: Sha256Digest },
        records, reproduced as { metrics: unknown });
    } catch (error) {
      fail(`metric provider ${pin.id} re-run failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  const effectiveMetrics: GateMetricsDocument = { ...metrics, providers: effectiveProviders };
  const gateEvidence: GateEvidence[] = [];
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      const kind = metricKindOf(gate, pack);
      const series = seriesFor(gate, pack, effectiveMetrics);
      const targets = gate.kind === 'upstream-ceiling' || gate.kind === 'predicate'
        ? [{ slice: null as string | null, observation: null }]
        : expandScope(gate, kind, series, binding.spec.slices);
      if (!targets.length) {
        // Unreachable through resolveBinding (vacuous scopes are load errors),
        // but a zero-target gate must never PROMOTE vacuously.
        gateEvidence.push({
          gateId: gate.id, kind: gate.kind,
          scope: { mode: gate.scope.mode, ...(gate.scope.slices === undefined ? {} : { slices: [...gate.scope.slices] }) },
          slice: null, n: null, status: 'insufficient', outcome: gate.onInsufficient ?? 'HOLD',
          reasons: [`${gate.id}:no-evaluation-targets`],
        });
        continue;
      }
      for (const target of targets) {
        const evaluation = evaluateObservation(gate, target.observation,
          { packId: pack.authored.metadata.id, parameters, metrics: effectiveMetrics, upstream, nowMs,
            slice: target.slice, slices: binding.spec.slices });
        // Upstream-ceiling gates mirror the upstream verdict exactly: compromise
        // rolls back, allowlist problems hold, clean promotes. The gate's own
        // onFail never escalates (or softens) the trusted verdict.
        const outcome = gate.kind === 'upstream-ceiling' && evaluation.status === 'fail'
          ? upstreamOutcome(upstream).ceiling
          : gateStatusOutcome(evaluation.status, gate);
        gateEvidence.push({
          gateId: gate.id, kind: gate.kind,
          scope: { mode: gate.scope.mode, ...(gate.scope.slices === undefined ? {} : { slices: [...gate.scope.slices] }) },
          slice: evaluation.slice, n: evaluation.n,
          ...(evaluation.events === undefined ? {} : { events: evaluation.events }),
          ...(evaluation.statistic === undefined ? {} : { statistic: evaluation.statistic }),
          ...(evaluation.threshold === undefined ? {} : { threshold: evaluation.threshold }),
          status: evaluation.status,
          outcome,
          reasons: [`${gate.id}:${evaluation.reason}`],
        });
      }
    }
  }
  const packOutcome = maxOutcome(...gateEvidence.map(entry => entry.outcome));
  const { ceiling: upstreamCeiling, problems: upstreamProblems } = upstreamOutcome(upstream);
  const bindingCeiling = binding.spec.ceiling ?? 'PROMOTE';
  const decision = ceilingDecision(packOutcome, upstreamCeiling, bindingCeiling);
  const body = {
    apiVersion: binding.apiVersion,
    kind: 'GateReport' as const,
    metadata: { id: binding.metadata.id, version: binding.metadata.version,
      description: `GateReport for ${binding.metadata.id}` },
    binding: { id: binding.metadata.id, version: binding.metadata.version, digest: trustedBindingDigest },
    packs: packs.map(pack => ({ id: pack.authored.metadata.id, version: pack.authored.metadata.version,
      digest: pack.digest, resolvedDigest: pack.resolvedDigest })),
    metricProviders: binding.spec.metricProviders.map(pin => ({ ...pin })),
    metricsDigest: artifactDigest(effectiveMetrics),
    floors: input.floors === 'none-explicit-opt-out'
      ? { mode: 'opt-out' as const }
      : { mode: 'applied' as const, digest: artifactDigest(input.floors) as Sha256Digest },
    holdout: { digest: sealed.digest as Sha256Digest, frozenDigest, firstAccessedAt },
    gateEvidence,
    references: binding.spec.references.map(reference => ({
      name: reference.name, kind: reference.kind, observed: effectiveMetrics.references?.[reference.name] !== undefined,
    })),
    upstream: upstream === null ? null : {
      decision: upstreamCeiling,
      reasons: upstreamProblems.map(problem => `upstream:${problem}`),
      digest: upstream.digest,
    },
    ceilings: { packOutcome, upstreamCeiling, bindingCeiling },
    decision,
    evaluatedAt: now,
    ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
  };
  return { ...body, digest: artifactDigest(body) };
}
