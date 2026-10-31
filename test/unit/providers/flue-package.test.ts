// Validate rejected static imports and explicit specialist capability bindings.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { validateFlueSkill } from '../../../tools/agents/providers/flue-validation.mjs';
vi.mock('@flue/runtime', () => ({ defineSubagent: (value: unknown) => value, useTool: vi.fn(), useMcpConnection: vi.fn() }));
import { createSpecialist } from '../../../packages/flue/specialist-binding.js';
const definition = { name: 'synthetic', description: 'Synthetic delegate', agent: () => 'instructions' };
it('names the bad fixture and validates name and description bounds', () => {
  const file = path.resolve('test/fixtures/providers/flue/bad-skill/SKILL.md');
  expect(() => validateFlueSkill(fs.readFileSync(file, 'utf8'), file)).toThrow(`${file}: Flue skill name`);
  for (const description of ['', 'x'.repeat(1025)]) expect(() => validateFlueSkill(`---\nname: bad-skill\ndescription: '${description}'\n---\n`, file)).toThrow(`${file}: Flue skill description`);
  expect(validateFlueSkill(`---\nname: bad-skill\ndescription: '${'x'.repeat(1024)}'\n---\n`, file).description).toHaveLength(1024);
});
it('fails before mounting when any required tool is missing and names both supplying exports', () => {
  const names = ['aiwg_discover', 'aiwg_show', 'aiwg_artifact_write'];
  for (const missing of names) {
    const tools = names.filter(name => name !== missing).map(name => ({ name }));
    expect(() => createSpecialist(definition, { tools })).toThrow(missing);
    expect(() => createSpecialist(definition, { tools })).toThrow('@aiwg/flue/tools/node');
    expect(() => createSpecialist(definition, { tools })).toThrow('@aiwg/flue/tools');
  }
  const options = { model: 'caller-model', connection: { name: 'aiwg', tools: ['discover', 'skill-show', 'artifact-write'] } };
  expect(createSpecialist(definition, options).model).toBe('caller-model');
  expect(() => createSpecialist(definition, { ...options, connection: { ...options.connection, optional: true } })).toThrow('missing tool');
});
