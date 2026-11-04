// Curated session continuity and test repair intents for discovery facet fusion.
import type { FacetEntry } from './discover-facets.js';
export const SESSION_FACETS: FacetEntry[] = [
  {
    facet: 'feature-domain', label: 'Session checkpoint and handoff',
    intents: ['resume conductor handoff', 'continue session handoff', 'write session handoff',
      'create session handoff', 'resume interrupted work'],
    capabilities: ['checkpoint'],
  },
  {
    facet: 'feature-domain', label: 'Repair failing tests',
    intents: ['fix failing test', 'repair failing tests', 'fix flaky tests'],
    capabilities: ['flaky-fix', 'executable-feedback'],
  },
];
