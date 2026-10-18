import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const flowSchemas = 'agentic/code/frameworks/sdlc-complete/schemas/flows';
const addon = 'agentic/code/addons/agent-persistence';
const loadYaml = path => yaml.load(readFileSync(path, 'utf8'));

/** Compile the actual YAML authority, without fetching remote schemas. */
export function compileHitlGateSchema(root) {
  const schema = loadYaml(resolve(root, flowSchemas, 'hitl-gate.yaml'));
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

/** Check shipped instances and partial templates in the existing schema lint lane. */
export function validateHitlGates(root) {
  const validate = compileHitlGateSchema(root);
  const check = (value, label) => {
    if (!validate(value)) {
      throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
    }
  };
  const examples = loadYaml(resolve(root, flowSchemas, 'hitl-gate-examples.yaml'));
  const phaseGates = Object.entries(examples.sdlc_gates);
  if (phaseGates.length === 0) throw new Error('No SDLC HITL gate examples');
  for (const [name, gate] of phaseGates) check(gate, `sdlc_gates.${name}`);
  for (const [name, template] of Object.entries(examples.gate_templates)) {
    // Templates intentionally omit identity and sometimes trigger. Validate all
    // supplied fields against the same contract as complete gate instances.
    check({ id: 'GATE-TEMPLATE', name: 'Template gate', trigger: { type: 'artifact_complete' }, ...template },
      `gate_templates.${name}`);
  }
  const directory = resolve(root, addon, 'gates');
  const files = readdirSync(directory).filter(name => name.endsWith('.yaml')).sort();
  const manifest = JSON.parse(readFileSync(resolve(root, addon, 'manifest.json'), 'utf8'));
  if (JSON.stringify(files) !== JSON.stringify(manifest.gates.map(name => `${name}.yaml`).sort())) {
    throw new Error('Agent-persistence manifest gates differ from shipped YAML files');
  }
  const ids = new Set();
  for (const file of files) {
    const gate = loadYaml(resolve(directory, file));
    check(gate, file);
    if (gate.$schema !== 'https://aiwg.io/schemas/hitl-gate/v1') throw new Error(`${file}: wrong schema`);
    if (ids.has(gate.id)) throw new Error(`${file}: duplicate gate ID ${gate.id}`);
    ids.add(gate.id);
  }
  return { phaseGates: phaseGates.length, addonGates: files.length };
}
