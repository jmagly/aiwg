// Compose inherited packs and enforce their project floor minima.
import { artifactDigest } from '../decision/validate.js';
import { GateRegistryError } from './registry-error.js';
import { isParamRef, validateResolvedPack } from './pack-validation.js';
import { assertGateTightens } from './pack-tightening.js';
import { validateGateDocument } from './schema.js';
import { qualifyGateParameter } from './types.js';
import type { ArtifactPinLike, GateBinding, GateDefinition, GateOutcome, GatePack, GateParameter, Sha256Digest } from './types.js';
import type { MetricProviderRegistry } from './providers/registry.js';
import type { ResolvedPack } from './registry.js';
import { INTEGRITY_CEILING_FLOOR_PACK_ID, assertCeilingDefaults, projectCeilingSatisfied } from './floors.js';
import type { ProjectFloors } from './floors.js';
const fail = (message: string): never => { throw new GateRegistryError(message); };
const pinLabel = (pin: ArtifactPinLike): string => `${pin.id}@${pin.version}`;

/**
 * Pure `extends` composition: merges a child's declarations over its already
 * resolved parent. No registry state is read, so a `GateRegistry` subclass
 * cannot change tightening semantics by overriding an instance method. The
 * evaluator calls this (via `composeGatePack`/`resolveGateBinding`) instead of
 * any overridable `GateRegistry` method for security-relevant resolution.
 */
export function applyGateExtends(parentResolved: GatePack, child: GatePack): GatePack {
  const mergedParams: Record<string, GateParameter> = { ...(parentResolved.spec.parameters ?? {}) };
  for (const [name, parameter] of Object.entries(child.spec.parameters ?? {})) {
    const before = mergedParams[name];
    if (before === undefined) {
      mergedParams[name] = parameter;
      continue;
    }
    if (before.type !== parameter.type || before.direction !== parameter.direction) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not change parameter ${name} type or direction`);
    }
    if (before.default === undefined && parameter.default !== undefined) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not add a default to required parameter ${name}`);
    }
    if (before.default !== undefined && parameter.default === undefined) {
      mergedParams[name] = parameter;
      continue;
    }
    if (before.default !== undefined && parameter.default !== undefined) {
      const tightens = parameter.direction === 'lower-is-stricter'
        ? parameter.default <= before.default : parameter.default >= before.default;
      if (!tightens) throw new GateRegistryError(`pack ${child.metadata.id} parameter ${name} default loosens`);
      mergedParams[name] = parameter;
    }
  }
  const parentGates = new Map(parentResolved.spec.gates.map(gate => [gate.id, gate]));
  const merged: GateDefinition[] = [];
  const seen = new Set<string>();
  for (const gate of parentResolved.spec.gates) {
    const override = (child.spec.gates ?? []).find(candidate => candidate.id === gate.id);
    if (override === undefined) {
      // Removing a non-floor gate is allowed; floor gates pin the minimum.
      if (gate.floor === true) throw new GateRegistryError(`pack ${child.metadata.id} may not remove floor gate ${gate.id}`);
      continue;
    }
    seen.add(gate.id);
    assertGateTightens(gate, override, mergedParams);
    merged.push(override);
  }
  for (const gate of child.spec.gates ?? []) {
    if (!seen.has(gate.id) && !parentGates.has(gate.id)) merged.push(gate);
    else if (!seen.has(gate.id)) fail(`pack ${child.metadata.id} duplicates gate ${gate.id}`);
  }
  const mergedMetrics = { ...parentResolved.spec.metrics };
  for (const [name, metric] of Object.entries(child.spec.metrics ?? {})) {
    const before = mergedMetrics[name];
    if (before !== undefined && (before.provider !== metric.provider || before.kind !== metric.kind)) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not change inherited metric ${name}`);
    }
    mergedMetrics[name] = metric;
  }
  return {
    apiVersion: child.apiVersion, kind: child.kind, metadata: child.metadata,
    spec: {
      extends: child.spec.extends, parameters: mergedParams, metrics: mergedMetrics, gates: merged,
      // Omit `combine` when the child leaves it unset: a present-but-undefined
      // key is not JSON and would poison the composed-pack digest.
      ...(child.spec.combine === undefined ? {} : { combine: child.spec.combine }),
    },
  };
}

/**
 * Pure extends-chain composition. The lookup returns authored packs by full id;
 * parent pins (version + authored digest) are enforced here, so a loosened
 * parent always moves the composed digest.
 */
export function composeGatePack(
  pack: GatePack,
  lookupAuthored: (id: string) => GatePack,
): GatePack {
  if (pack.spec.extends === undefined) return pack;
  const parentAuthored = lookupAuthored(pack.spec.extends.id);
  const parentPin = pack.spec.extends;
  if (parentAuthored.metadata.version !== parentPin.version
    || (artifactDigest(parentAuthored) as Sha256Digest) !== parentPin.digest) {
    throw new GateRegistryError(`pack ${pack.metadata.id} parent pin mismatch for ${pinLabel(parentPin)}`);
  }
  return applyGateExtends(composeGatePack(parentAuthored, lookupAuthored), pack);
}

/** One floor pack expanded to its composed gates and parameter defaults. */
export interface ExpandedFloorPack {
  packId: string;
  gates: GateDefinition[];
  params: Record<string, GateParameter>;
}

/**
 * Whether one expanded floor's `integrity-ceiling` gate genuinely governs the
 * default ceiling: it must be an all-scoped `upstream-ceiling` gate that
 * tightens the shipped default gate (floor flag included). A same-id gate of
 * any other kind or scope never suppresses the default.
 */
function governsDefaultCeiling(floor: ExpandedFloorPack, defaultGate: GateDefinition): boolean {
  return floor.gates.some(gate => {
    if (gate.id !== 'integrity-ceiling' || gate.kind !== 'upstream-ceiling' || gate.scope.mode !== 'all') {
      return false;
    }
    try {
      assertGateTightens(defaultGate, gate, floor.params);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Expands project floors over an explicit authored-pack map: inline packs are
 * schema-checked again (direct registry callers bypass config validation) and
 * semantically validated, pack references are verified by version and authored
 * digest and composed through the pure `composeGatePack` (so `extends` floors
 * enforce their composed minima). Every floor gate that binds a threshold
 * parameter must declare a default for it: the default is the enforced
 * minimum, and a required (default-less) floor parameter is a load error.
 *
 * The operator default floor — the composed gates of the shipped
 * `aiwg:decision-engine/integrity-ceiling` pack, the single source of truth —
 * is appended unless a configured floor governs it via `governsDefaultCeiling`
 * above. An inline gate that merely reuses the id (any other kind or scope)
 * never suppresses the default; the binding must then satisfy both, which
 * fails closed with a diagnostic.
 */
export function expandFloorPacks(
  floors: ProjectFloors,
  lookupAuthored: (id: string) => GatePack,
  providers: MetricProviderRegistry,
): ExpandedFloorPack[] {
  const expanded: ExpandedFloorPack[] = (floors.floors ?? []).map(source => {
    if ('packRef' in source) {
      const pin = source.packRef;
      const authored = lookupAuthored(pin.id);
      if (authored.metadata.version !== pin.version
        || (artifactDigest(authored) as Sha256Digest) !== pin.digest) {
        throw new GateRegistryError(`project floor pack pin mismatch for ${pinLabel(pin)}`);
      }
      const composed = composeGatePack(authored, lookupAuthored);
      validateResolvedPack(composed, providers);
      return {
        packId: authored.metadata.id,
        gates: composed.spec.gates,
        params: { ...(composed.spec.parameters ?? {}) },
      };
    }
    const pack = validateGateDocument<GatePack>(source.pack);
    if (pack.kind !== 'GatePack') throw new GateRegistryError('project floor pack requires a GatePack document');
    const composed = pack.spec.extends === undefined ? pack : composeGatePack(pack, lookupAuthored);
    validateResolvedPack(composed, providers);
    for (const gate of composed.spec.gates) {
      const level = gate.statistic?.levelBps;
      const margin = gate.statistic?.marginBps;
      const refs = [gate.threshold?.param, isParamRef(gate.minimumN) ? gate.minimumN.param : undefined,
        isParamRef(level) ? level.param : undefined, isParamRef(margin) ? margin.param : undefined];
      for (const name of refs) {
        if (name !== undefined && composed.spec.parameters?.[name]?.default === undefined) {
          throw new GateRegistryError(
            `project floor gate '${gate.id}' parameter '${name}' requires a default: it is the enforced minimum`);
        }
      }
    }
    return {
      packId: pack.metadata.id,
      gates: composed.spec.gates,
      params: { ...(composed.spec.parameters ?? {}) },
    };
  });
  const defaultAuthored = lookupAuthored(INTEGRITY_CEILING_FLOOR_PACK_ID);
  const defaultComposed = composeGatePack(defaultAuthored, lookupAuthored);
  validateResolvedPack(defaultComposed, providers);
  const defaultGate = defaultComposed.spec.gates.find(gate => gate.id === 'integrity-ceiling');
  if (defaultGate === undefined) {
    throw new GateRegistryError(`shipped default floor ${INTEGRITY_CEILING_FLOOR_PACK_ID} has no integrity-ceiling gate`);
  }
  if (!expanded.some(floor => governsDefaultCeiling(floor, defaultGate))) {
    expanded.push({
      packId: defaultAuthored.metadata.id,
      gates: defaultComposed.spec.gates,
      params: { ...(defaultComposed.spec.parameters ?? {}) },
    });
  }
  return expanded;
}

/**
 * Resolves a binding gate's threshold parameter to its preregistered binding
 * value, so floor comparison is always value-against-minimum in the gate's
 * declared direction. A binding may parameterize a floor literal: the value,
 * not the spelling, must tighten.
 */
function synthesizeFloorCandidate(
  gate: GateDefinition,
  packId: string,
  parameters: Record<string, number>,
): GateDefinition {
  const materialize = (ref: { param: string }): number => {
    const value = parameters[qualifyGateParameter(packId, ref.param)];
    if (value === undefined) {
      throw new GateRegistryError(`binding gate '${gate.id}' parameter '${ref.param}' has no resolved value`);
    }
    return value;
  };
  let candidate = gate;
  if (gate.threshold !== undefined && gate.threshold.param !== undefined) {
    const { op, param } = gate.threshold;
    candidate = { ...candidate, threshold: { op, value: materialize({ param }) } };
  }
  if (isParamRef(gate.minimumN)) candidate = { ...candidate, minimumN: materialize(gate.minimumN) };
  const statistic = gate.statistic;
  if (statistic !== undefined) {
    candidate = { ...candidate, statistic: { ...statistic,
      ...(isParamRef(statistic.levelBps) ? { levelBps: materialize(statistic.levelBps) } : {}),
      ...(isParamRef(statistic.marginBps) ? { marginBps: materialize(statistic.marginBps) } : {}),
    } };
  }
  return candidate;
}

/**
 * Enforces project floors over already-resolved binding packs. Project policy
 * outranks addon and framework packs: a binding that omits a floor gate, or
 * whose gate loosens any floor gate's threshold, parameter value, scope or
 * outcome (via the shared per-kind `assertGateTightens` and the scope-superset
 * rule), is refused with a diagnostic naming the binding, the gate and the
 * floor pack. Every binding gate sharing a floor gate id must tighten it, so
 * a loosened duplicate cannot evade the floor.
 */
export function enforceProjectFloors(
  binding: GateBinding,
  packs: ResolvedPack[],
  parameters: Record<string, number>,
  expanded: ExpandedFloorPack[],
  ceilings: Record<string, GateOutcome>,
): void {
  // The '*' key is the project-wide default ceiling for every binding; a
  // per-study key overrides it for that study only (exact match — renames
  // never inherit). The star rule is re-checked here (C6): floors handed in
  // directly, bypassing `validateGatesConfig`/`resolveProjectFloors`, still
  // cannot carry starless or loosening per-study ceilings.
  try {
    assertCeilingDefaults(ceilings);
  } catch (error) {
    throw new GateRegistryError(error instanceof Error ? error.message : 'invalid project ceilings');
  }
  const configured = ceilings[binding.metadata.id] ?? ceilings['*'];
  if (!projectCeilingSatisfied(binding.spec.ceiling, configured)) {
    throw new GateRegistryError(
      `binding '${binding.metadata.id}' declares ceiling ${binding.spec.ceiling ?? 'PROMOTE'}`
      + ` below the project ceiling ${configured} for this study`);
  }
  const union: Array<{ gate: GateDefinition; packId: string }> = [];
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) union.push({ gate, packId: pack.authored.metadata.id });
  }
  for (const floor of expanded) {
    for (const floorGate of floor.gates) {
      const matches = union.filter(candidate => candidate.gate.id === floorGate.id);
      if (!matches.length) {
        throw new GateRegistryError(
          `binding '${binding.metadata.id}' omits project floor gate '${floorGate.id}'`
          + ` (floor pack '${floor.packId}'): every binding in this project must include and tighten it`);
      }
      for (const match of matches) {
        try {
          assertGateTightens(floorGate, synthesizeFloorCandidate(match.gate, match.packId, parameters), floor.params);
        } catch (error) {
          throw new GateRegistryError(
            `binding '${binding.metadata.id}' loosens project floor gate '${floorGate.id}'`
            + ` (floor pack '${floor.packId}'): ${error instanceof Error ? error.message : 'invalid tightening'}`);
        }
      }
    }
  }
}

