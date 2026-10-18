import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileHitlGateSchema, validateHitlGates } from '../../../tools/validation/hitl-gates.mjs';
import { GATES, loadGateConfig } from '../../../agentic/code/addons/agent-persistence/gates/index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const validate = compileHitlGateSchema(root);

describe('shipped HITL contract', () => {
  it('strictly compiles the YAML schema and validates all shipped gates and templates', () => {
    expect(validateHitlGates(root)).toEqual({ phaseGates: 4, addonGates: 3 });
  });

  it('keeps runtime IDs, YAML identities and packaged gates aligned', async () => {
    expect(Object.values(GATES).sort()).toEqual([
      'GATE-AP-DESTRUCTIVE', 'GATE-AP-FALSE-POSITIVE', 'GATE-AP-RECOVERY',
    ]);
    for (const id of Object.values(GATES)) {
      const gate = await loadGateConfig(id);
      expect(gate.id).toBe(id);
      expect(validate(gate), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const file of ['destructive-action-gate.yaml', 'false-positive-override-gate.yaml', 'recovery-escalation-gate.yaml', 'index.mjs']) {
      const source = readFileSync(resolve(root, 'agentic/code/addons/agent-persistence/gates', file), 'utf8');
      expect(readFileSync(resolve(root, 'agentic/code/plugins/agent-persistence/gates', file), 'utf8')).toBe(source);
    }
  });

  it.each(['GATE-', 'GATE-AP-', 'GATE--AP', 'GATE-ap-RECOVERY', 'AP-RECOVERY', 'GATE-AP_RECOVERY'])
  ('rejects malformed gate ID %s', async id => {
    const gate = await loadGateConfig(GATES.RECOVERY_ESCALATION);
    expect(validate({ ...gate, id })).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: '/id' })]));
  });

  it('rejects drift in required fields, trigger, behavior and metric vocabulary', async () => {
    const gate = await loadGateConfig(GATES.RECOVERY_ESCALATION);
    const { behavior, ...missingBehavior } = gate;
    for (const changed of [
      missingBehavior,
      { ...gate, trigger: { type: 'made_up' } },
      { ...gate, behavior: { ...behavior, mode: 'AUTO' } },
      { ...gate, behavior: { ...behavior, timeout_action: 'ignore' } },
      { ...gate, behavior: { ...behavior, timeout: -1 } },
      { ...gate, cost_tracking: { metrics: ['made_up'] } },
    ]) expect(validate(changed), JSON.stringify(changed)).toBe(false);
  });
});
