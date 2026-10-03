export interface Layering {
  lower: Map<string, string>;
  own: Set<string>;
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
export function writeLayerData<T extends object>(data: T, collection: string, layering: Layering): T;
export function resolveProfileExtends<P extends {
  extends?: string[];
  servers?: string[];
  providerOverrides?: Record<string, { toolDeny?: string[]; toolAllow?: string[] }>;
}>(name: string, profiles: Record<string, P>, seen?: string[]): P & { servers: string[] };
