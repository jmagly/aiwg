// Prove monotone gate tightening across inheritance and project floors.
import { ceilingDecision } from './lattice.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { GateRegistryError } from './registry-error.js';
import { isParamRef, resolveNumberDefault } from './pack-validation.js';
import type { GateDefinition, GateParameter } from './types.js';
const fail = (message: string): never => { throw new GateRegistryError(message); };

/** Resolve a `$param` threshold against pack parameter defaults. Null when no default pins it. */
export function resolveThresholdDefault(gate: GateDefinition, params: Record<string, GateParameter>): number | null {
  if (gate.threshold === undefined) return null;
  if (gate.threshold.value !== undefined) return gate.threshold.value;
  if (gate.threshold.param === undefined) return null;
  return params[gate.threshold.param]?.default ?? null;
}

/**
 * Scope-tightening rules per gate kind. A scope change is a tightening only when
 * the child observes every slice the parent observes under every possible
 * binding inventory (so a breach the parent sees can never go unobserved)
 * and every world that fails the child also fails the parent:
 * - `listed` may only widen (more slices fail in a superset of worlds);
 * - `pooled` sets are fixed;
 * - `listed -> each` widens coverage to the whole binding inventory, so the
 *   child's `except` must exclude none of the parent's listed slices;
 * - `all -> each` covers the whole inventory only with no exceptions, and is a
 *   tightening only when per-slice checks are strictly harder than the pooled
 *   check (`count-min`, `minimum-n`); for `count-max` the pooled bound is
 *   strictly harder (pooled<=2 implies per-slice<=2, not vice versa), and for
 *   interval/paired/bootstrap/value gates pooled and per-slice bounds are
 *   incomparable — so the change is rejected for every other kind.
 * Every other cross-mode change crosses aggregation or drops coverage and is
 * rejected for every kind.
 */
function assertScopeTightens(parent: GateDefinition, child: GateDefinition): void {
  const from = parent.scope;
  const to = child.scope;
  if (from.mode === to.mode) {
    if (to.mode === 'listed' || to.mode === 'pooled') {
      const before = new Set(from.slices ?? []);
      const after = new Set(to.slices ?? []);
      if (to.mode === 'listed') {
        // A wider listed set fails in a superset of worlds, so it tightens.
        for (const slice of before) {
          if (!after.has(slice)) fail(`gate ${child.id} scope listed may not drop inherited slices`);
        }
      } else if (after.size !== before.size || [...after].some(slice => !before.has(slice))) {
        fail(`gate ${child.id} scope pooled may not change its slice set`);
      }
    }
    const beforeExcept = new Set(from.except ?? []);
    for (const slice of to.except ?? []) {
      if (!beforeExcept.has(slice)) fail(`gate ${child.id} scope may only narrow inherited exceptions`);
    }
    return;
  }
  if (from.mode === 'listed' && to.mode === 'each') {
    const excluded = new Set(to.except ?? []);
    for (const slice of from.slices ?? []) {
      if (excluded.has(slice)) fail(`gate ${child.id} scope listed -> each may not except inherited slice '${slice}'`);
    }
    return;
  }
  if (from.mode === 'all' && to.mode === 'each'
    && (child.kind === 'count-min' || child.kind === 'minimum-n')) {
    // `all` watches the whole inventory: any exception drops a watched slice.
    if ((to.except ?? []).length) fail(`gate ${child.id} scope all -> each may not except slices`);
    return;
  }
  fail(`gate ${child.id} scope change ${from.mode} -> ${to.mode} is not a monotone tightening`);
}

/**
 * Proves monotone tightening of a child gate over its parent. Any loosening —
 * a relaxed threshold, a literal rewritten as a bindable parameter, a renamed
 * parameter, a lowered minimumN, a demoted outcome, a widened scope
 * or a changed statistic — is a load error.
 */
export function assertGateTightens(parent: GateDefinition, child: GateDefinition,
  params: Record<string, GateParameter>): void {
  if (parent.kind !== child.kind) fail(`gate ${child.id} may not change kind ${parent.kind} -> ${child.kind}`);
  if (canonicalJson(parent.metric ?? null) !== canonicalJson(child.metric ?? null)) {
    fail(`gate ${child.id} may not change its metric reference`);
  }
  if (parent.direction !== child.direction) fail(`gate ${child.id} may not change its tightening direction`);
  const parentStatistic = parent.statistic;
  const childStatistic = child.statistic;
  if (canonicalJson({ ...parentStatistic, levelBps: 0, marginBps: 0 })
    !== canonicalJson({ ...childStatistic, levelBps: 0, marginBps: 0 })) {
    fail(`gate ${child.id} may not change its statistic (levelBps and marginBps aside)`);
  }
  // A literal level is a pinned bound: rewriting it as a parameter hands the
  // bound to the binding, whose allowed range is wider than the literal.
  const parentLevel = parentStatistic?.levelBps;
  const childLevel = childStatistic?.levelBps;
  if (typeof parentLevel === 'number' && isParamRef(childLevel)) {
    fail(`gate ${child.id} may not convert a literal levelBps into a parameter`);
  }
  if (isParamRef(parentLevel) && isParamRef(childLevel) && parentLevel.param !== childLevel.param) {
    fail(`gate ${child.id} may not rename its levelBps parameter`);
  }
  const levelBefore = parentLevel === undefined ? undefined : resolveNumberDefault(parentLevel, params, 'level');
  const levelAfter = childLevel === undefined ? undefined : resolveNumberDefault(childLevel, params, 'level');
  if (levelBefore === null || levelAfter === null) {
    if (canonicalJson(parentLevel ?? null) !== canonicalJson(childLevel ?? null)) {
      fail(`gate ${child.id} levelBps change is unresolvable without parameter defaults`);
    }
  } else if ((levelAfter ?? levelBefore) !== undefined && (levelAfter ?? 0) < (levelBefore ?? 0)) {
    fail(`gate ${child.id} may only raise levelBps`);
  }
  if ((parentStatistic?.mode ?? 'non-inferiority') !== (childStatistic?.mode ?? 'non-inferiority')) {
    fail(`gate ${child.id} may not change its paired mode`);
  }
  const parentMargin = parentStatistic?.marginBps;
  const childMargin = childStatistic?.marginBps;
  if (typeof parentMargin === 'number' && isParamRef(childMargin)) {
    fail(`gate ${child.id} may not convert a literal marginBps into a parameter`);
  }
  if (isParamRef(parentMargin) && isParamRef(childMargin) && parentMargin.param !== childMargin.param) {
    fail(`gate ${child.id} may not rename its marginBps parameter`);
  }
  const marginBefore = resolveNumberDefault(parentMargin ?? 0, params, 'value');
  const marginAfter = resolveNumberDefault(childMargin ?? 0, params, 'value');
  if (marginBefore === null || marginAfter === null) {
    if (canonicalJson(parentMargin ?? null) !== canonicalJson(childMargin ?? null)) {
      fail(`gate ${child.id} marginBps change is unresolvable without parameter defaults`);
    }
  } else if (marginAfter < marginBefore) {
    fail(`gate ${child.id} may only raise marginBps`);
  }
  // A literal threshold is a pinned bound. Rewriting it as a parameter hands the
  // bound to the binding, whose allowed range (e.g. 0..10000 bps) is wider than
  // the literal — a loosening no default-equality check can see. Forbid it.
  if (parent.threshold?.value !== undefined && child.threshold?.param !== undefined) {
    fail(`gate ${child.id} may not convert a literal threshold into a parameter`);
  }
  // Renaming a parameter rebinds the gate to a fresh default and range. Params
  // may only keep their name with a tighter-or-equal default.
  if (parent.threshold?.param !== undefined && child.threshold?.param !== undefined
    && parent.threshold.param !== child.threshold.param) {
    fail(`gate ${child.id} may not rename its threshold parameter`);
  }
  const before = resolveThresholdDefault(parent, params);
  const after = resolveThresholdDefault(child, params);
  if (before === null || after === null) {
    if (canonicalJson(parent.threshold ?? null) !== canonicalJson(child.threshold ?? null)) {
      fail(`gate ${child.id} threshold change is unresolvable without parameter defaults`);
    }
  } else if (child.direction === 'lower-is-stricter' ? after > before : after < before) {
    fail(`gate ${child.id} threshold ${before} -> ${after} loosens direction ${child.direction}`);
  }
  if (typeof parent.minimumN === 'number' && isParamRef(child.minimumN)) {
    fail(`gate ${child.id} may not convert a literal minimumN into a parameter`);
  }
  if (isParamRef(parent.minimumN) && isParamRef(child.minimumN) && parent.minimumN.param !== child.minimumN.param) {
    fail(`gate ${child.id} may not rename its minimumN parameter`);
  }
  const minimumBefore = parent.minimumN === undefined ? 0 : resolveNumberDefault(parent.minimumN, params, 'count');
  const minimumAfter = child.minimumN === undefined ? 0 : resolveNumberDefault(child.minimumN, params, 'count');
  if (minimumBefore === null || minimumAfter === null) {
    if (canonicalJson(parent.minimumN ?? null) !== canonicalJson(child.minimumN ?? null)) {
      fail(`gate ${child.id} minimumN change is unresolvable without parameter defaults`);
    }
  } else if (minimumAfter < minimumBefore) {
    fail(`gate ${child.id} may only raise minimumN`);
  }
  if (ceilingDecision(child.onFail, parent.onFail) !== child.onFail) {
    fail(`gate ${child.id} may not demote onFail ROLLBACK -> HOLD`);
  }
  // Insufficient evidence always holds: ROLLBACK needs an observed blocking
  // failure, so neither side may name it. Checked here as well as in schema
  // and pack validation because this pure function is the tightening gate.
  if ((parent.onInsufficient ?? 'HOLD') !== 'HOLD' || (child.onInsufficient ?? 'HOLD') !== 'HOLD') {
    fail(`gate ${child.id} onInsufficient must be HOLD: insufficient evidence never rolls back`);
  }
  if (parent.floor === true && child.floor !== true) fail(`gate ${child.id} is a floor gate and cannot be un-floored`);
  assertScopeTightens(parent, child);
  const afterEvidence = new Set(child.evidence?.required ?? []);
  for (const id of parent.evidence?.required ?? []) {
    if (!afterEvidence.has(id)) fail(`gate ${child.id} may not drop required evidence ${id}`);
  }
  if (canonicalJson(parent.predicate ?? null) !== canonicalJson(child.predicate ?? null)) {
    fail(`gate ${child.id} may not change its predicate`);
  }
}

