// Register pinned packs and resolve validated binding parameters against them.
import { artifactDigest } from '../decision/validate.js';
import type { MetricProviderRegistry } from './providers/registry.js';
import { validateGateDocument } from './schema.js';
import type {
  ArtifactPinLike, GateBinding, GatePack, GateParameter, Sha256Digest,
} from './types.js';
import { qualifyGateParameter } from './types.js';
import type { ProjectFloors } from './floors.js';

import { GateRegistryError } from './registry-error.js';
import { checkPairedMargin, isParamRef, validateResolvedPack } from './pack-validation.js';
import { composeGatePack, expandFloorPacks, enforceProjectFloors } from './pack-composition.js';
export { GateRegistryError } from './registry-error.js';
export { validateResolvedPack, resolveNumberDefault } from './pack-validation.js';
export { assertGateTightens, resolveThresholdDefault } from './pack-tightening.js';
export { applyGateExtends, composeGatePack, expandFloorPacks, enforceProjectFloors, type ExpandedFloorPack } from './pack-composition.js';

export const GATE_NAMESPACES = ['aiwg', 'framework', 'addon', 'extension', 'project'] as const;
export type GateNamespace = typeof GATE_NAMESPACES[number];

export function splitPackId(id: unknown): { namespace: GateNamespace; rest: string } {
  if (typeof id !== 'string') throw new GateRegistryError('pack id must be a string');
  const separator = id.indexOf(':');
  const namespace = separator < 0 ? '' : id.slice(0, separator);
  const rest = separator < 0 ? '' : id.slice(separator + 1);
  if (!(GATE_NAMESPACES as readonly string[]).includes(namespace) || !rest || /\s/.test(rest)) {
    throw new GateRegistryError(`pack id must be <namespace>:<path> with namespace ${GATE_NAMESPACES.join('/')}: '${id}'`);
  }
  if (namespace === 'project') {
    if (rest.includes(':') || rest.includes('/')) throw new GateRegistryError(`project pack ids are project:<name>: '${id}'`);
  } else if (!/^[^/\s:]+\/[^/\s:]+$/.test(rest)) {
    throw new GateRegistryError(`pack id must be <namespace>:<bundle>/<name>: '${id}'`);
  }
  return { namespace: namespace as GateNamespace, rest };
}

export interface ResolvedPack {
  authored: GatePack;
  digest: Sha256Digest;
  /** Digest of the composed (extends-resolved) pack. Pinned in bindings and reports. */
  resolvedDigest: Sha256Digest;
  resolved: GatePack;
}

export interface ResolvedBinding {
  binding: GateBinding;
  packs: ResolvedPack[];
  /** Parameter values keyed by qualified name `<packId>.<param>`. */
  parameters: Record<string, number>;
}

const pinLabel = (pin: ArtifactPinLike): string => `${pin.id}@${pin.version}`;

export type AuthoredGatePackEntry = { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace };
export type AuthoredGatePackMap = Map<string, AuthoredGatePackEntry>;

/**
 * Standalone snapshot readers. These are module functions, not `GateRegistry`
 * methods, so a subclass override of `resolveBinding`/`resolvePack`/`getPack`
 * cannot intercept them. The evaluator reads registry state only through these
 * and recomposes through the pure functions above.
 */
export function authoredGatePacksOf(registry: GateRegistry): AuthoredGatePackMap {
  const packs = (registry as unknown as { packs?: unknown }).packs;
  if (!(packs instanceof Map)) throw new GateRegistryError('gate registry packs are unavailable');
  return packs as AuthoredGatePackMap;
}

export function gateProvidersOf(registry: GateRegistry): MetricProviderRegistry {
  const providers = (registry as unknown as { providers?: unknown }).providers;
  if (providers === undefined || providers === null) throw new GateRegistryError('gate registry providers are unavailable');
  return providers as MetricProviderRegistry;
}

/**
 * Pure binding resolution over an explicit authored-pack map and provider registry.
 * Project floors (`floors`, loaded from `aiwg.config` by the caller via
 * `resolveProjectFloors`) are an optional trusted input: when present, the
 * binding must include and tighten every floor gate and respect its per-study
 * ceiling. When absent the check is skipped entirely and resolution is
 * byte-identical to the floors-unaware path.
 */
export function resolveGateBinding(
  doc: unknown,
  authoredById: AuthoredGatePackMap,
  providers: MetricProviderRegistry,
  floors?: ProjectFloors,
): ResolvedBinding {
  const binding = validateGateDocument<GateBinding>(doc);
  if (binding.kind !== 'GateBinding') throw new GateRegistryError('resolveBinding requires a GateBinding document');
  const seenPins = new Set<string>();
  for (const pin of binding.spec.packs) {
    if (seenPins.has(pin.id)) throw new GateRegistryError(`binding ${binding.metadata.id} pins pack ${pin.id} twice`);
    seenPins.add(pin.id);
  }
  const lookupAuthored = (id: string): GatePack => {
    if (id.includes(':')) {
      const entry = authoredById.get(id);
      if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
      return entry.authored;
    }
    const matches = [...authoredById.keys()].filter(key => splitPackId(key).rest === id);
    if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${id}`);
    if (matches.length > 1) {
      throw new GateRegistryError(`ambiguous gate pack '${id}': ${matches.sort().join(', ')} (pin the full id)`);
    }
    return authoredById.get(matches[0] as string)!.authored;
  };
  const packs = binding.spec.packs.map(pin => {
    const entry = pin.id.includes(':') ? authoredById.get(pin.id) : (() => {
      const matches = [...authoredById.keys()].filter(key => splitPackId(key).rest === pin.id);
      if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${pin.id}`);
      if (matches.length > 1) {
        throw new GateRegistryError(`ambiguous gate pack '${pin.id}': ${matches.sort().join(', ')} (pin the full id)`);
      }
      return authoredById.get(matches[0] as string)!;
    })();
    if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${pin.id}`);
    if (entry.authored.metadata.id !== pin.id) {
      throw new GateRegistryError(`binding ${binding.metadata.id} must pin the full pack id (got '${pin.id}')`);
    }
    if ((artifactDigest(entry.authored) as Sha256Digest) !== entry.digest
      || entry.authored.metadata.version !== pin.version || entry.digest !== pin.digest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} pack pin mismatch for ${pinLabel(pin)}`);
    }
    const resolved = composeGatePack(entry.authored, lookupAuthored);
    if ((artifactDigest(resolved) as Sha256Digest) !== pin.resolvedDigest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} composed-pack pin mismatch for ${pinLabel(pin)}`);
    }
    return {
      authored: entry.authored, digest: entry.digest,
      resolvedDigest: pin.resolvedDigest, resolved,
    };
  });
  for (const pin of binding.spec.metricProviders) {
    if (!providers.has(pin.id)) throw new GateRegistryError(`binding ${binding.metadata.id} pins unknown provider ${pin.id}`);
    const provider = providers.get(pin.id);
    if (provider.version !== pin.version || provider.sourceDigest !== pin.sourceDigest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} provider pin mismatch for ${pin.id}`);
    }
    // Bundle providers (#2831 rework): the pin must carry the loader-computed
    // code digest, verified here against the loaded provider, plus the
    // records digest the evaluator reproduces (records binding, P4). A byte
    // change moves the code digest, so an old pin refuses until re-pinned.
    // Null never verifies. Core pins carry neither digest.
    const expectedCode = (provider as { codeDigest?: unknown }).codeDigest;
    const pinnedCode = (pin as { codeDigest?: unknown }).codeDigest;
    const pinnedRecords = (pin as { recordsDigest?: unknown }).recordsDigest;
    if (typeof expectedCode === 'string') {
      if (typeof pinnedCode !== 'string' || pinnedCode !== expectedCode) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider code pin mismatch for ${pin.id}`);
      }
      if (typeof pinnedRecords !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pinnedRecords)) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider records pin mismatch for ${pin.id}`);
      }
    } else {
      if (pinnedCode !== undefined) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider code pin mismatch for ${pin.id}`);
      }
      if (pinnedRecords !== undefined) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider records pin mismatch for ${pin.id}`);
      }
    }
  }
  const requiredProviders = new Set<string>();
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      if (gate.metric !== undefined) requiredProviders.add(gate.metric.provider);
    }
  }
  const pinnedProviders = new Set(binding.spec.metricProviders.map(pin => pin.id));
  for (const id of requiredProviders) {
    if (!pinnedProviders.has(id)) {
      throw new GateRegistryError(`binding ${binding.metadata.id} leaves provider ${id} used by a gate unpinned`);
    }
  }
  const declared = new Map<string, GateParameter>();
  for (const pack of packs) {
    for (const [name, parameter] of Object.entries(pack.resolved.spec.parameters ?? {})) {
      declared.set(qualifyGateParameter(pack.authored.metadata.id, name), parameter);
    }
  }
  const parameters: Record<string, number> = {};
  for (const [qualified, parameter] of declared) {
    const value = binding.spec.parameters[qualified] ?? parameter.default;
    if (value === undefined) throw new GateRegistryError(`binding ${binding.metadata.id} is missing required parameter ${qualified}`);
    checkBindingValue(qualified, parameter, value);
    parameters[qualified] = value;
  }
  for (const name of Object.keys(binding.spec.parameters)) {
    if (!declared.has(name)) throw new GateRegistryError(`binding ${binding.metadata.id} sets undeclared parameter ${name}`);
  }
  const slices = new Set(binding.spec.slices);
  for (const [group, members] of Object.entries(binding.spec.sliceGroups ?? {})) {
    for (const slice of members) {
      if (!slices.has(slice)) {
        throw new GateRegistryError(`binding ${binding.metadata.id} sliceGroup '${group}' names slice '${slice}' outside the binding inventory`);
      }
    }
  }
  const references = new Set(binding.spec.references.map(reference => reference.name));
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      if (gate.kind === 'paired-difference' && gate.statistic?.marginBps !== undefined) {
        const ref = gate.statistic.marginBps;
        const margin = isParamRef(ref) ? parameters[qualifyGateParameter(pack.authored.metadata.id, ref.param)]! : ref;
        checkPairedMargin(gate.id, gate.statistic.mode ?? 'non-inferiority', margin);
      }
      for (const slice of [...(gate.scope.slices ?? []), ...(gate.scope.except ?? [])]) {
        if (!slices.has(slice)) throw new GateRegistryError(`gate ${gate.id} names slice '${slice}' outside the binding inventory`);
      }
      if (gate.statistic?.vs !== undefined && !references.has(gate.statistic.vs)) {
        throw new GateRegistryError(`gate ${gate.id} contrasts undeclared reference '${gate.statistic.vs}'`);
      }
      if (gate.scope.mode === 'each') {
        const excluded = new Set(gate.scope.except ?? []);
        if (binding.spec.slices.every(slice => excluded.has(slice))) {
          throw new GateRegistryError(`gate ${gate.id} each-scope excludes every binding slice`);
        }
      }
    }
  }
  const registeredAt = Date.parse(binding.spec.registeredAt);
  const frozenAt = Date.parse(binding.spec.frozenAt);
  if (!Number.isFinite(registeredAt) || !Number.isFinite(frozenAt)) {
    throw new GateRegistryError(`binding ${binding.metadata.id} has unparseable preregistration timestamps`);
  }
  if (registeredAt > frozenAt) {
    throw new GateRegistryError(`binding ${binding.metadata.id} registers after it freezes`);
  }
  // Project floors run after every legacy check, so floors-unaware diagnostics
  // keep their exact messages and order. Floor expansion reuses the same pure
  // lookup the binding pins above, never registry instance state.
  if (floors !== undefined) {
    enforceProjectFloors(binding, packs, parameters,
      expandFloorPacks(floors, lookupAuthored, providers), floors.ceilings ?? {});
  }
  return { binding, packs, parameters };
}

export class GateRegistry {
  private readonly packs = new Map<string, { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace }>();

  constructor(private readonly providers: MetricProviderRegistry) {}

  registerPack(doc: unknown, origin: { namespace: GateNamespace; bundle?: string }): GatePack {
    const pack = validateGateDocument<GatePack>(doc);
    if (pack.kind !== 'GatePack') throw new GateRegistryError('registerPack requires a GatePack document');
    const { namespace, rest } = splitPackId(pack.metadata.id);
    if (namespace !== origin.namespace) {
      throw new GateRegistryError(`pack ${pack.metadata.id} namespace does not match contribution origin ${origin.namespace}`);
    }
    if (namespace !== 'project') {
      if (origin.bundle === undefined || !origin.bundle.trim()) throw new GateRegistryError('bundle origin is required outside project:');
      if (rest !== `${origin.bundle}/${rest.slice(origin.bundle.length + 1)}` || !rest.startsWith(`${origin.bundle}/`)) {
        throw new GateRegistryError(`pack ${pack.metadata.id} does not belong to bundle ${origin.bundle}`);
      }
    }
    if (this.packs.has(pack.metadata.id)) throw new GateRegistryError(`duplicate gate pack: ${pack.metadata.id}`);
    // Shipped-name protection, order-independent: an aiwg: rest-path can never
    // coexist with the same rest-path from any other namespace, whichever
    // registers first.
    for (const id of this.packs.keys()) {
      if (splitPackId(id).rest !== rest) continue;
      const otherShipped = id.startsWith('aiwg:');
      const nextShipped = pack.metadata.id.startsWith('aiwg:');
      if (otherShipped || nextShipped) {
        const shipped = nextShipped ? pack.metadata.id : id;
        const shadow = nextShipped ? id : pack.metadata.id;
        throw new GateRegistryError(`pack ${shadow} shadows shipped pack ${shipped}`);
      }
    }
    if (pack.spec.extends !== undefined) {
      this.requireParent(pack.metadata.id, pack.spec.extends);
    }
    const resolved = this.composeAuthored(pack);
    validateResolvedPack(resolved, this.providers);
    const { digest } = { digest: artifactDigest(pack) as Sha256Digest };
    this.packs.set(pack.metadata.id, { authored: pack, digest, namespace });
    return pack;
  }

  getPack(id: string): GatePack {
    return this.lookupPack(id).authored;
  }

  resolvePack(id: string): ResolvedPack {
    const entry = this.lookupPack(id);
    const resolved = this.composeAuthored(entry.authored);
    return {
      authored: entry.authored, digest: entry.digest,
      resolvedDigest: artifactDigest(resolved) as Sha256Digest, resolved,
    };
  }

  /**
   * Full-id lookup, or rest-path lookup when the id carries no namespace.
   * A rest-path shared by two namespaces is `ambiguous`: callers must pin the
   * full id. Bindings always pin full ids, so they never hit ambiguity.
   */
  private lookupPack(id: string): { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace } {
    if (id.includes(':')) {
      const entry = this.packs.get(id);
      if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
      return entry;
    }
    const matches = [...this.packs.keys()].filter(key => splitPackId(key).rest === id);
    if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${id}`);
    if (matches.length > 1) {
      throw new GateRegistryError(`ambiguous gate pack '${id}': ${matches.sort().join(', ')} (pin the full id)`);
    }
    return this.packs.get(matches[0] as string)!;
  }

  private requireParent(childId: string, pin: GatePack['spec']['extends'] & object): {
    authored: GatePack; digest: Sha256Digest;
  } {
    const entry = this.packs.get(pin.id);
    if (entry === undefined) throw new GateRegistryError(`pack ${childId} extends unknown pack ${pin.id}`);
    if (entry.authored.metadata.version !== pin.version || entry.digest !== pin.digest) {
      throw new GateRegistryError(`pack ${childId} parent pin mismatch for ${pinLabel(pin)}`);
    }
    return entry;
  }

  private composeAuthored(pack: GatePack): GatePack {
    return composeGatePack(pack, id => {
      const parent = this.packs.get(id);
      if (parent === undefined) throw new GateRegistryError(`pack ${pack.metadata.id} extends unknown pack ${id}`);
      return parent.authored;
    });
  }

  resolveBinding(doc: unknown, floors?: ProjectFloors): ResolvedBinding {
    return resolveGateBinding(doc, this.packs, this.providers, floors);
  }
}

function checkBindingValue(name: string, parameter: GateParameter, value: number): void {
  if (!Number.isFinite(value)) throw new GateRegistryError(`binding parameter ${name} must be finite`);
  if (parameter.type === 'bps' && (value < 0 || value > 10000)) {
    throw new GateRegistryError(`binding parameter ${name} must be within 0..10000 bps`);
  }
  if (parameter.type === 'level' && (!Number.isSafeInteger(value) || value <= 5000 || value >= 9999)) {
    throw new GateRegistryError(`binding parameter ${name} must be an integer strictly between 5000 and 9999`);
  }
  if (parameter.type === 'count' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new GateRegistryError(`binding parameter ${name} must be a non-negative integer`);
  }
}
