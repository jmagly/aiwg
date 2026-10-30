// Validate gate declarations and resolve numeric parameter defaults.
import { GateRegistryError } from './registry-error.js';
import type { MetricProviderRegistry } from './providers/registry.js';
import type { GateDefinition, GatePack, GateParameter, GateParamRef } from './types.js';
const fail = (message: string): never => { throw new GateRegistryError(message); };

const STATISTICAL_KINDS = ['interval-bound', 'paired-difference', 'bootstrap-bound'] as const;

function checkThresholdBlock(gate: GateDefinition, params: Record<string, GateParameter>): void {
  const needsThreshold = gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound'
    || gate.kind === 'count-max' || gate.kind === 'count-min' || gate.kind === 'value-threshold';
  const threshold = gate.threshold;
  if (threshold === undefined) {
    if (needsThreshold) fail(`gate ${gate.id} of kind ${gate.kind} requires a threshold`);
    return;
  }
  if (!needsThreshold) fail(`gate ${gate.id} of kind ${gate.kind} must not carry a threshold`);
  const param = threshold.param === undefined ? undefined : params[threshold.param];
  if (threshold.param !== undefined && param === undefined) fail(`gate ${gate.id} references unknown parameter '${threshold.param}'`);
  const expectedParamType = gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound' ? 'bps'
    : gate.kind === 'count-max' || gate.kind === 'count-min' ? 'count' : 'value';
  if (param !== undefined && param.type !== expectedParamType) {
    fail(`gate ${gate.id} parameter '${threshold.param}' must have type ${expectedParamType}`);
  }
  if (threshold.value !== undefined) {
    if (!Number.isFinite(threshold.value)) fail(`gate ${gate.id} threshold value must be finite`);
    if (expectedParamType === 'bps' && (threshold.value < 0 || threshold.value > 10000)) {
      fail(`gate ${gate.id} threshold must be within 0..10000 bps`);
    }
    if (expectedParamType === 'count' && (!Number.isSafeInteger(threshold.value) || threshold.value < 0)) {
      fail(`gate ${gate.id} threshold must be a non-negative integer count`);
    }
  }
  const op = gate.kind === 'count-max' ? 'lte' : gate.kind === 'count-min' ? 'gte' : threshold.op;
  if (gate.kind === 'count-max' && threshold.op !== 'lte') fail(`gate ${gate.id} count-max requires op lte`);
  if (gate.kind === 'count-min' && threshold.op !== 'gte') fail(`gate ${gate.id} count-min requires op gte`);
  if (gate.kind === 'interval-bound' && gate.statistic?.bound === 'upper' && threshold.op !== 'lte') {
    fail(`gate ${gate.id} upper-bound gates require op lte`);
  }
  if (gate.kind === 'interval-bound' && gate.statistic?.bound === 'lower' && threshold.op !== 'gte') {
    fail(`gate ${gate.id} lower-bound gates require op gte`);
  }
  if (gate.kind === 'value-threshold') {
    if (threshold.op === 'lte' && gate.direction !== 'lower-is-stricter') fail(`gate ${gate.id} lte requires direction lower-is-stricter`);
    if (threshold.op === 'gte' && gate.direction !== 'higher-is-stricter') fail(`gate ${gate.id} gte requires direction higher-is-stricter`);
  }
  if (gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound') {
    if (op === 'lte' && gate.direction !== 'lower-is-stricter') fail(`gate ${gate.id} upper-bound gates require direction lower-is-stricter`);
    if (op === 'gte' && gate.direction !== 'higher-is-stricter') fail(`gate ${gate.id} lower-bound gates require direction higher-is-stricter`);
  }
}

export const isParamRef = (value: unknown): value is GateParamRef =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && typeof (value as GateParamRef).param === 'string';

/**
 * Resolve a literal-or-parameter number against pack parameter defaults.
 * Returns the default for a `{param}` reference, or null when the reference
 * names an unknown parameter, the type mismatches, or no default pins it.
 */
export function resolveNumberDefault(
  value: number | GateParamRef | undefined,
  params: Record<string, GateParameter>,
  expectedType: GateParameter['type'],
): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value;
  if (!isParamRef(value)) return null;
  const declared = params[value.param];
  if (declared === undefined || declared.type !== expectedType) return null;
  return declared.default ?? null;
}

/** A literal-or-parameter reference names a known parameter of the expected type. */
function checkParamRef(
  gateId: string,
  value: number | GateParamRef | undefined,
  params: Record<string, GateParameter>,
  expectedType: GateParameter['type'],
  what: string,
): void {
  if (value === undefined || typeof value === 'number') return;
  if (!isParamRef(value) || params[value.param] === undefined) {
    fail(`gate ${gateId} ${what} references unknown parameter '${(value as GateParamRef)?.param}'`);
  }
  if (params[value.param]!.type !== expectedType) {
    fail(`gate ${gateId} ${what} parameter '${value.param}' must have type ${expectedType}`);
  }
}

/** Signed margins use value parameters; mode constrains the resolved integer range. */
export function checkPairedMargin(gateId: string, mode: string, margin: number): void {
  if (!Number.isSafeInteger(margin) || margin < -10000 || margin > 10000) {
    fail(`gate ${gateId} marginBps must be an integer within -10000..10000`);
  }
  if (mode === 'non-inferiority' && margin > 0) fail(`gate ${gateId} non-inferiority marginBps must be non-positive`);
  if (mode === 'superiority' && margin < 0) fail(`gate ${gateId} superiority marginBps must be non-negative`);
}

/** Statistic coherence per kind. Irrelevant statistic fields are rejected so confused authoring fails at load. */
function checkStatisticBlock(gate: GateDefinition, params: Record<string, GateParameter>): void {
  const statistic = gate.statistic;
  if (statistic === undefined) {
    if ((STATISTICAL_KINDS as readonly string[]).includes(gate.kind)) {
      fail(`gate ${gate.id} of kind ${gate.kind} requires a statistic`);
    }
    return;
  }
  if (!(STATISTICAL_KINDS as readonly string[]).includes(gate.kind)) {
    fail(`gate ${gate.id} of kind ${gate.kind} must not carry a statistic`);
  }
  if (statistic.kind !== gate.kind) fail(`gate ${gate.id} statistic kind must match the gate kind`);
  const { method, bound, levelBps, mode, marginBps, seed, resamples, bounds } = statistic;
  if (gate.kind === 'interval-bound') {
    if (method !== undefined && method !== 'wilson' && method !== 'clopper-pearson') {
      fail(`gate ${gate.id} interval-bound method must be wilson or clopper-pearson`);
    }
    if (bound !== 'upper' && bound !== 'lower') fail(`gate ${gate.id} interval-bound requires bound upper|lower`);
    if (levelBps === undefined) fail(`gate ${gate.id} interval-bound requires levelBps`);
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    if (mode !== undefined || marginBps !== undefined || seed !== undefined || resamples !== undefined || bounds !== undefined) {
      fail(`gate ${gate.id} interval-bound must not carry mode, margin, seed, resamples or bounds`);
    }
  } else if (gate.kind === 'paired-difference') {
    if (method !== undefined && method !== 'newcombe' && method !== 'tango') {
      fail(`gate ${gate.id} paired-difference method must be newcombe or tango`);
    }
    if (bound !== undefined) fail(`gate ${gate.id} paired-difference must not carry bound`);
    if (levelBps === undefined) fail(`gate ${gate.id} paired-difference requires levelBps`);
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    const resolvedMode = mode ?? 'non-inferiority';
    if (resolvedMode !== 'non-inferiority' && resolvedMode !== 'superiority') fail(`gate ${gate.id} unknown paired mode`);
    if (resolvedMode === 'non-inferiority' && marginBps === undefined) fail(`gate ${gate.id} non-inferiority requires marginBps`);
    checkParamRef(gate.id, marginBps, params, 'value', 'marginBps');
    if (isParamRef(marginBps) && params[marginBps.param]!.direction !== 'higher-is-stricter') {
      fail(`gate ${gate.id} marginBps parameter must be higher-is-stricter`);
    }
    const margin = resolveNumberDefault(marginBps, params, 'value');
    if (margin !== null) checkPairedMargin(gate.id, resolvedMode, margin);
    if (seed !== undefined || resamples !== undefined || bounds !== undefined) {
      fail(`gate ${gate.id} paired-difference must not carry seed, resamples or bounds`);
    }
  } else {
    if (method !== undefined && method !== 'bootstrap') fail(`gate ${gate.id} bootstrap-bound method must be bootstrap`);
    if (bound !== 'upper' && bound !== 'lower') fail(`gate ${gate.id} bootstrap-bound requires bound upper|lower`);
    if (levelBps === undefined || seed === undefined || resamples === undefined || bounds === undefined) {
      fail(`gate ${gate.id} bootstrap-bound requires levelBps, seed, resamples and bounds`);
    }
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    if (mode !== undefined || marginBps !== undefined) fail(`gate ${gate.id} bootstrap-bound must not carry mode or margin`);
  }
}

function checkParameter(name: string, parameter: GateParameter): void {
  if (parameter.default !== undefined) {
    if (!Number.isFinite(parameter.default)) fail(`parameter ${name} default must be finite`);
    if (parameter.type === 'bps' && (parameter.default < 0 || parameter.default > 10000)) {
      fail(`parameter ${name} bps default must be within 0..10000`);
    }
    if (parameter.type === 'level' && (!Number.isSafeInteger(parameter.default)
      || parameter.default <= 5000 || parameter.default >= 9999)) {
      fail(`parameter ${name} level default must be an integer strictly between 5000 and 9999`);
    }
    if (parameter.type === 'count' && (!Number.isSafeInteger(parameter.default) || parameter.default < 0)) {
      fail(`parameter ${name} count default must be a non-negative integer`);
    }
  }
}

/** Semantic validation of one fully resolved pack against the provider registry. */
export function validateResolvedPack(pack: GatePack, providers: MetricProviderRegistry): void {
  const ids = pack.spec.gates.map(gate => gate.id);
  if (new Set(ids).size !== ids.length) fail(`pack ${pack.metadata.id} has duplicate gate ids`);
  const params = pack.spec.parameters ?? {};
  for (const [name, parameter] of Object.entries(params)) checkParameter(name, parameter);
  for (const [name, metric] of Object.entries(pack.spec.metrics)) {
    if (!providers.has(metric.provider)) fail(`pack ${pack.metadata.id} metric ${name} names unknown provider ${metric.provider}`);
    const provider = providers.get(metric.provider);
    const declared = provider.metrics[name];
    if (declared === undefined) fail(`pack ${pack.metadata.id} metric ${name} is not computed by ${metric.provider}`);
    if (declared.kind !== metric.kind) {
      fail(`pack ${pack.metadata.id} metric ${name} kind ${metric.kind} does not match provider kind ${declared.kind}`);
    }
  }
  for (const gate of pack.spec.gates) {
    if (gate.onFail !== 'HOLD' && gate.onFail !== 'ROLLBACK') {
      fail(`gate ${gate.id} onFail must be HOLD or ROLLBACK, never PROMOTE`);
    }
    // Insufficient evidence always holds: ROLLBACK needs an observed blocking
    // failure, never a shortfall. Rejected here at load, not just in schema.
    if (gate.onInsufficient !== undefined && gate.onInsufficient !== 'HOLD') {
      fail(`gate ${gate.id} onInsufficient must be HOLD: insufficient evidence never rolls back`);
    }
    if (gate.metric !== undefined) {
      const declared = pack.spec.metrics[gate.metric.name];
      if (declared === undefined || declared.provider !== gate.metric.provider) {
        fail(`gate ${gate.id} references undeclared metric ${gate.metric.provider}:${gate.metric.name}`);
      }
    }
    const metricKind = gate.metric === undefined ? undefined : pack.spec.metrics[gate.metric.name]?.kind;
    const expectedKind = gate.kind === 'interval-bound' || gate.kind === 'count-max' || gate.kind === 'count-min' ? 'proportion'
      : gate.kind === 'paired-difference' ? 'paired' : gate.kind === 'bootstrap-bound' ? 'differences'
      : gate.kind === 'value-threshold' ? 'scalar' : gate.kind === 'evidence' ? 'evidence' : undefined;
    if (expectedKind !== undefined && metricKind !== expectedKind) {
      fail(`gate ${gate.id} of kind ${gate.kind} requires a ${expectedKind} metric`);
    }
    checkThresholdBlock(gate, params);
    checkStatisticBlock(gate, params);
    checkParamRef(gate.id, gate.minimumN, params, 'count', 'minimumN');
    if (gate.kind === 'minimum-n') {
      if (gate.minimumN === undefined) fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      // A default is the enforced minimum, so a defaulted reference must pin
      // at least 1; a defaultless reference is supplied by the binding and an
      // unresolvable value holds at evaluation, never promotes.
      const resolved = resolveNumberDefault(gate.minimumN, params, 'count');
      if (typeof gate.minimumN === 'number' && gate.minimumN < 1) {
        fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      }
      if (isParamRef(gate.minimumN) && params[gate.minimumN.param]?.default !== undefined && (resolved ?? 0) < 1) {
        fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      }
      if (metricKind === 'evidence') fail(`gate ${gate.id} minimum-n cannot observe an evidence metric`);
    } else if (gate.minimumN !== undefined && typeof gate.minimumN === 'number'
      && (!Number.isSafeInteger(gate.minimumN) || gate.minimumN < 0)) {
      fail(`gate ${gate.id} minimumN must be a non-negative integer`);
    }
    if (gate.kind === 'evidence' && (gate.evidence === undefined || !gate.evidence.required.length)) {
      fail(`gate ${gate.id} evidence requires a nonempty required list`);
    }
    if (gate.kind !== 'evidence' && gate.evidence !== undefined) fail(`gate ${gate.id} of kind ${gate.kind} must not carry evidence`);
    if (gate.kind !== 'predicate' && gate.predicate !== undefined) fail(`gate ${gate.id} of kind ${gate.kind} must not carry a predicate`);
    if ((gate.scope.mode === 'listed' || gate.scope.mode === 'pooled')
      && (gate.scope.slices === undefined || !gate.scope.slices.length)) {
      fail(`gate ${gate.id} scope ${gate.scope.mode} requires a nonempty slices list`);
    }
    // `except` is honoured only by `each` (per-slice minus exclusions). Any other
    // mode silently ignoring it would be a fail-open scoping bug, so it is a load error.
    if (gate.scope.except !== undefined && gate.scope.mode !== 'each') {
      fail(`gate ${gate.id} scope except is only allowed with mode each`);
    }
  }
}

