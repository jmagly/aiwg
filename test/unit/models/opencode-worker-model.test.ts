// Check OpenCode distribution boundaries and the model/effort argv contract.
import { describe, expect, it } from 'vitest';
import { opencodeWorkerModelArgs } from '../../../src/models/opencode-worker-model.mjs';

const model = 'synthetic/local-model';

describe('OpenCode worker model arguments', () => {
  it.each([undefined, null, 2, '', 'not-a-version', '1.17.9', '2.0.25', '3.0.0',
    '1.18.0-rc.1', '2.0.26-rc.1'])('rejects missing, invalid or unsupported version %s', cliVersion => {
    expect(() => opencodeWorkerModelArgs(model, 'high', cliVersion))
      .toThrow('OpenCode worker requires a supported installed CLI version');
  });

  it.each(['1.18.0', '1.19.5'])('renders %s with a separate variant or no effort', cliVersion => {
    expect(opencodeWorkerModelArgs(model, 'high', cliVersion)).toEqual(['-m', model, '--variant', 'high']);
    expect(opencodeWorkerModelArgs(model, null, cliVersion)).toEqual(['-m', model]);
  });

  it.each(['2.0.26', '2.9.0'])('renders %s with a model suffix or no effort', cliVersion => {
    expect(opencodeWorkerModelArgs(model, 'high', cliVersion)).toEqual(['-m', `${model}#high`]);
    expect(opencodeWorkerModelArgs(model, null, cliVersion)).toEqual(['-m', model]);
  });
});
