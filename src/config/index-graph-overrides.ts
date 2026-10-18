/** The bounded operator contract for adapting built-in index scan scope. */
export interface IndexBuiltinGraphOverride {
  scanDirs?: string[];
  extensions?: string[];
}

export const OVERRIDABLE_INDEX_GRAPHS = ['project', 'codebase'] as const;

/** Shared by config validation and graph loading, including non-CLI callers. */
export function validateIndexGraphOverrides(overrides: unknown): string[] {
  if (overrides === undefined) return [];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return ['index.graphOverrides: must be an object mapping supported built-in graph names to overrides'];
  }
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(overrides)) {
    const where = `index.graphOverrides.${name}`;
    if (!(OVERRIDABLE_INDEX_GRAPHS as readonly string[]).includes(name)) {
      errors.push(`${where}: unsupported built-in graph override (supported: ${OVERRIDABLE_INDEX_GRAPHS.join(', ')})`);
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const override = raw as Record<string, unknown>;
    for (const field of Object.keys(override)) {
      if (field !== 'scanDirs' && field !== 'extensions') {
        errors.push(`${where}.${field}: unknown field (supported: scanDirs, extensions)`);
      }
    }
    for (const field of ['scanDirs', 'extensions']) {
      const value = override[field];
      if (value !== undefined && (!Array.isArray(value) || value.length === 0 ||
        !value.every(item => typeof item === 'string' && item.trim().length > 0))) {
        errors.push(`${where}.${field}: must be a non-empty array of strings`);
      }
    }
  }
  return errors;
}
