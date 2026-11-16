// Match declared template output kinds and their existing trigger/alias phrases.
import type { MetadataEntry } from './types.js';

export function matchTemplateOutputKind(entry: MetadataEntry, phrase: string): string | undefined {
  if (entry.type !== 'template' || !entry.outputKind) return undefined;
  const normalize = (value: string) => value.toLowerCase().replace(/[._\s-]+/g, ' ').trim();
  const query = normalize(phrase).replace(/ templates?$/, '').trim();
  if (!query) return undefined;
  return [entry.outputKind, ...(entry.triggers ?? [])].find(value => normalize(value) === query);
}
