// Share legacy registry aliases between update planning and config persistence.
/**
 * Maps framework registry IDs (e.g. 'sdlc-complete') to `aiwg use` names (e.g. 'sdlc').
 */
export const REGISTRY_ID_TO_USE_NAME: Record<string, string> = {
  'sdlc-complete': 'sdlc',
  'media-marketing-kit': 'marketing',
  'media-curator': 'media-curator',
  'research-complete': 'research',
  'forensics-complete': 'forensics',
  dfir: 'forensics',
  'ops-complete': 'ops',
  'validation-complete': 'validation',
};

// Reverse aliases without letting a secondary alias (dfir) replace the canonical ID.
const USE_NAME_TO_REGISTRY_ID: Record<string, string> = {
  ...Object.fromEntries(Object.entries(REGISTRY_ID_TO_USE_NAME).reverse().map(([id, alias]) => [alias, id])),
  general: 'writing-quality',
  writing: 'writing-quality',
};

/** Resolve a use name or legacy alias to its canonical bundle directory. */
export function frameworkRegistryId(name: string): string {
  const useName = REGISTRY_ID_TO_USE_NAME[name] ?? name;
  return USE_NAME_TO_REGISTRY_ID[useName] ?? name;
}
