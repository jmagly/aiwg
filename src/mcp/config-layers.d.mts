export interface Layering {
  lowerPolicy?: import('./credentials.mjs').McpCredentialPolicy;
  ownPolicy?: import('./credentials.mjs').McpCredentialPolicy;
  effectivePolicy?: import('./credentials.mjs').McpCredentialPolicy;
  lower: Map<string, string>;
  own: Set<string>;
  lowerFields: Map<string, string>;
  ownFields: Set<string>;
}

export function resolveConfigLayers(
  configDirOverride?: string,
  env?: Record<string, string | undefined>,
): string[] | null;
export function loadLayered<T extends object>(
  layers: string[],
  filename: string,
  collection: string,
  defaults: T,
): Promise<{ data: T; layering: Layering }>;
export function isLowerLayerEntry(layering: Layering, name: string): boolean;
export function writeLayerData<T extends object>(data: T, collection: string, layering: Layering, explicitPolicy?: boolean): T;
export function resolveProfileExtends<P extends {
  extends?: string[];
  servers?: string[];
  providerOverrides?: Record<string, { toolDeny?: string[]; toolAllow?: string[] }>;
}>(name: string, profiles: Record<string, P>, seen?: string[]): P & { servers: string[] };

export function assertLayerWriteDestination(layers: string[], filename: string): Promise<void>;
export function saveLayerData(file: string, data: object, collection: string, layers: string[] | null, layering: Layering | null, explicitPolicy?: boolean): Promise<void>;

export function isCaseInsensitivePath(path: string): Promise<boolean>;
