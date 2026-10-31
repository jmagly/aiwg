// Validate pending declarations without accepting incomplete deployment records.
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const kinds = ['agents', 'commands', 'skills', 'rules'];
export function validateInstalled(installed: unknown): void {
  if (installed === undefined) return;
  if (!object(installed)) throw new Error('installed must be an object');
  for (const [id, entry] of Object.entries(installed)) {
    if (!object(entry) || !object(entry.deployedTo)) throw new Error(`installed.${id}.deployedTo must be an object`);
    let deployed = false;
    for (const [provider, counts] of Object.entries(entry.deployedTo)) {
      if (!object(counts)) throw new Error(`installed.${id}.deployedTo.${provider} must be an object`);
      if (counts.copy !== undefined && typeof counts.copy !== 'boolean') throw new Error(`installed.${id}.deployedTo.${provider}.copy must be boolean`);
      if (!Object.keys(counts).some(key => key !== 'copy')) continue;
      if (kinds.some(kind => !Number.isSafeInteger(counts[kind]) || (counts[kind] as number) < 0)) {
        throw new Error(`installed.${id}.deployedTo.${provider} requires all four nonnegative artifact counts or {}`);
      }
      deployed = true;
    }
    if (deployed || ['version', 'source', 'installedAt'].some(key => entry[key] !== undefined)) {
      if (['version', 'source', 'installedAt'].some(key => typeof entry[key] !== 'string' || !entry[key])) throw new Error(`installed.${id} requires version, source and installedAt after deployment`);
    }
  }
}
