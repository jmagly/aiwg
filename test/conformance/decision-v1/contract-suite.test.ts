import { describe, it } from 'vitest';
import { CONTRACT_EVIDENCE_IDS, contractChecks } from './vectors/contract.js';

describe('CON contract-conformance suite', () => {
  it.each(CONTRACT_EVIDENCE_IDS)('%s', async id => { await contractChecks[id](); });
});
