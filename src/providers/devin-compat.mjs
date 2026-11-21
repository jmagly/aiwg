// Read pre-buyout Desktop configuration and deployment records under the canonical identity.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const canonicalDesktopProviderId = provider => provider === 'windsurf' ? 'devin' : provider;

export function canonicalizeDesktopProviderKeys(records) {
  if (!record(records) || !Object.hasOwn(records, 'windsurf')) return records;
  const { windsurf, ...current } = records;
  if (!Object.hasOwn(current, 'devin')) return { ...current, devin: windsurf };
  return { ...current, devin: record(windsurf) && record(current.devin)
    ? { ...windsurf, ...current.devin } : current.devin };
}

export function normalizeDesktopConfig(config) {
  if (!record(config)) return config;
  if (Array.isArray(config.providers) && config.providers.includes('windsurf')) {
    config.providers = config.providers.map(canonicalDesktopProviderId)
      .filter((id, index, ids) => id !== 'devin' || ids.indexOf(id) === index);
  }
  if (record(config.installed)) for (const entry of Object.values(config.installed)) {
    if (record(entry) && record(entry.deployedTo)) entry.deployedTo = canonicalizeDesktopProviderKeys(entry.deployedTo);
  }
  return config;
}

// Model validation and loading share a pure conversion of the deprecated selector.
export function normalizeDesktopModelConfig(config) {
  if (!record(config) || !record(config.defaults) || config.defaults.provider !== 'windsurf') return config;
  return { ...config, defaults: { ...config.defaults, provider: 'devin' } };
}
