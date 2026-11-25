/**
 * Workflow Metalanguage Schema Validation
 *
 * Foundational validation harness for the AIWG workflow metalanguage (the
 * declarative YAML "Flow" spec under agentic/code/addons/aiwg-utils/workflow/).
 * Before this, the schemas shipped with example documents but NO test proved
 * the examples conform — and any flow-* → YAML Flow migration (#1539) needs a
 * validator to assert converted flows are well-formed.
 *
 * This harness:
 *   1. Compiles every workflow-*.schema.json (draft-07) — guards malformed schemas.
 *   2. Validates each shipped example YAML against its kind's schema.
 *   3. Negative test: a structurally-broken doc is rejected.
 *
 * @issue #1539 (flows → YAML Flow spec), #1534 (epic)
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WF_DIR = path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils/workflow');
const SCHEMA_DIR = path.join(WF_DIR, 'schemas');
const EXAMPLE_DIR = path.join(WF_DIR, 'examples');

function makeAjv(): Ajv {
  // Schemas are draft-07; strict:false tolerates the descriptive keywords
  // these schemas use without erroring on unknown formats.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

function loadYaml(name: string): unknown {
  return yaml.load(fs.readFileSync(path.join(EXAMPLE_DIR, name), 'utf8'));
}

const SCHEMA_FILES = [
  'workflow-capability.schema.json',
  'workflow-playbook.schema.json',
  'workflow-inventory.schema.json',
  'workflow-target.schema.json',
  'workflow-gate.schema.json',
  'workflow-role.schema.json',
  'workflow-extension.schema.json',
];

describe('workflow metalanguage schemas', () => {
  it('every workflow-*.schema.json compiles under ajv (draft-07)', () => {
    const ajv = makeAjv();
    for (const file of SCHEMA_FILES) {
      const schema = loadSchema(file);
      expect(() => ajv.compile(schema), `${file} should compile`).not.toThrow();
    }
  });

  it('all seven documented kinds have a schema file present', () => {
    for (const file of SCHEMA_FILES) {
      expect(fs.existsSync(path.join(SCHEMA_DIR, file)), `${file} exists`).toBe(true);
    }
  });
});

describe('workflow metalanguage example documents conform to their schemas', () => {
  it('capability-minimal.yaml validates against WorkflowCapability', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-capability.schema.json'));
    const doc = loadYaml('capability-minimal.yaml');
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('playbook-with-gate.yaml validates against WorkflowPlaybook', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = loadYaml('playbook-with-gate.yaml');
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe('pilot Flow conversion validates against the schema (#1539)', () => {
  const FLOWS_DIR = path.join(REPO_ROOT, 'agentic/code/frameworks/sdlc-complete/flows');

  it('flow-release.playbook.yaml validates against WorkflowPlaybook', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = yaml.load(fs.readFileSync(path.join(FLOWS_DIR, 'flow-release.playbook.yaml'), 'utf8'));
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('every pilot release capability validates against WorkflowCapability', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-capability.schema.json'));
    const capDir = path.join(FLOWS_DIR, 'capabilities');
    const caps = fs.readdirSync(capDir).filter((f) => f.endsWith('.yaml'));
    expect(caps.length, 'pilot capabilities present').toBeGreaterThan(0);
    for (const f of caps) {
      const doc = yaml.load(fs.readFileSync(path.join(capDir, f), 'utf8'));
      const ok = validate(doc);
      expect(ok, `${f}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  it('heavy-flow proof: flow-architecture-evolution playbook (with a fanout step) validates (#1547)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = yaml.load(
      fs.readFileSync(path.join(FLOWS_DIR, 'flow-architecture-evolution.playbook.yaml'), 'utf8'),
    ) as { spec: { steps: Array<Record<string, unknown>> } };
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    // It genuinely exercises the agentic-step extension: the review panel is a fanout step.
    const reviewStep = doc.spec.steps.find((s) => s.id === 'architecture-review') as
      | { fanout?: { agents: string[]; synthesize: string } }
      | undefined;
    expect(reviewStep?.fanout, 'review step is a fanout panel').toBeTruthy();
    expect(reviewStep!.fanout!.agents.length, 'four parallel reviewers').toBe(4);
    expect(reviewStep!.fanout!.synthesize).toBe('incorporate-review');
  });
});

describe('bulk Flow conversion: every flow-* is a conformant declarative Flow (#1539, #1534)', () => {
  const FLOWS_DIR = path.join(REPO_ROOT, 'agentic/code/frameworks/sdlc-complete/flows');
  const RESEARCH_FLOWS_DIR = path.join(REPO_ROOT, 'agentic/code/frameworks/research-complete/flows');
  const CAP_DIR = path.join(FLOWS_DIR, 'capabilities');
  const SKILLS_DIR = path.join(REPO_ROOT, 'agentic/code/frameworks/sdlc-complete/skills');

  type Step = {
    id: string;
    capability?: string;
    fanout?: { strategy?: string; agents: string[]; synthesize: string };
    kind?: string;
  };
  type Playbook = { spec: { steps: Step[] } };

  const playbookFiles = fs
    .readdirSync(FLOWS_DIR)
    .filter((f) => f.endsWith('.playbook.yaml'))
    .sort();
  const capFiles = fs
    .readdirSync(CAP_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  it('the full flow-* set has been converted (every skills/flow-* has a playbook)', () => {
    const flowSkillDirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('flow-'))
      .map((d) => d.name);
    expect(flowSkillDirs.length, 'flow-* skills present').toBeGreaterThan(20);
    const missing = flowSkillDirs.filter(
      (name) => !fs.existsSync(path.join(FLOWS_DIR, `${name}.playbook.yaml`)),
    );
    expect(missing, `flow-* skills with no playbook: ${missing.join(', ')}`).toEqual([]);
  });

  it('every flow playbook validates against WorkflowPlaybook', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    expect(playbookFiles.length, 'playbooks present').toBeGreaterThan(20);
    for (const f of playbookFiles) {
      const doc = yaml.load(fs.readFileSync(path.join(FLOWS_DIR, f), 'utf8'));
      expect(validate(doc), `${f}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  it('every flow capability validates against WorkflowCapability', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-capability.schema.json'));
    expect(capFiles.length, 'capabilities present').toBeGreaterThan(20);
    for (const f of capFiles) {
      const doc = yaml.load(fs.readFileSync(path.join(CAP_DIR, f), 'utf8'));
      expect(validate(doc), `${f}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  it('research corpus-snapshot Flow validates and references existing capabilities (#1647)', () => {
    const ajv = makeAjv();
    const validatePlaybook = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const validateCapability = ajv.compile(loadSchema('workflow-capability.schema.json'));
    const playbook = yaml.load(
      fs.readFileSync(path.join(RESEARCH_FLOWS_DIR, 'corpus-snapshot.playbook.yaml'), 'utf8'),
    ) as { spec: { steps: Array<{ capability?: string }> } };
    expect(validatePlaybook(playbook), JSON.stringify(validatePlaybook.errors, null, 2)).toBe(true);
    for (const step of playbook.spec.steps) {
      if (!step.capability) continue;
      const file = path.join(RESEARCH_FLOWS_DIR, 'capabilities', `${step.capability}.yaml`);
      expect(fs.existsSync(file), `${step.capability} exists`).toBe(true);
      const cap = yaml.load(fs.readFileSync(file, 'utf8'));
      expect(validateCapability(cap), `${step.capability}: ${JSON.stringify(validateCapability.errors, null, 2)}`).toBe(true);
    }
  });

  it('referential integrity: every capability/fanout reference resolves to a capability file, no orphans', () => {
    const present = new Set(capFiles.map((f) => f.replace(/\.yaml$/, '')));
    const referenced = new Set<string>();
    for (const f of playbookFiles) {
      const pb = yaml.load(fs.readFileSync(path.join(FLOWS_DIR, f), 'utf8')) as Playbook;
      for (const s of pb.spec.steps) {
        if (s.capability) referenced.add(s.capability);
        if (s.fanout) {
          for (const a of s.fanout.agents) referenced.add(a);
          referenced.add(s.fanout.synthesize);
        }
      }
    }
    const missing = [...referenced].filter((r) => !present.has(r));
    const orphans = [...present].filter((c) => !referenced.has(c));
    expect(missing, `referenced-but-missing capabilities: ${missing.join(', ')}`).toEqual([]);
    expect(orphans, `orphan capability files (unreferenced): ${orphans.join(', ')}`).toEqual([]);
  });

  it('fanout (#1547) and gate steps are well-formed wherever used', () => {
    for (const f of playbookFiles) {
      const pb = yaml.load(fs.readFileSync(path.join(FLOWS_DIR, f), 'utf8')) as Playbook;
      for (const s of pb.spec.steps) {
        // A step sets capability XOR fanout (the schema's `not` guard) — assert it here too.
        expect(!(s.capability && s.fanout), `${f}:${s.id} sets both capability and fanout`).toBe(
          true,
        );
        if (s.fanout) {
          expect(s.fanout.agents.length, `${f}:${s.id} fanout has >=1 agent`).toBeGreaterThan(0);
          expect(typeof s.fanout.synthesize, `${f}:${s.id} fanout has a synthesize cap`).toBe(
            'string',
          );
        }
        if (s.kind === 'gate') {
          expect(s.capability, `${f}:${s.id} gate must not reference a capability`).toBeUndefined();
        }
      }
    }
  });

  it('every converted flow-* SKILL.md carries the declarative-Flow wrapper banner', () => {
    const flowSkillDirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('flow-'))
      .map((d) => d.name);
    const missing: string[] = [];
    for (const name of flowSkillDirs) {
      const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const body = fs.readFileSync(skillPath, 'utf8');
      if (!/Declarative Flow \(#1539\)|\.playbook\.yaml/.test(body)) missing.push(name);
    }
    expect(missing, `flow-* SKILL.md missing the #1539 wrapper banner: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('workflow schema rejects malformed documents (negative guard)', () => {
  it('rejects a playbook missing required spec.steps', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const broken = {
      apiVersion: 'workflow.aiwg.io/v1',
      kind: 'WorkflowPlaybook',
      metadata: { name: 'broken' },
      spec: { inventory: 'x', targets: { groups: ['edge'] } }, // no steps
    };
    expect(validate(broken)).toBe(false);
  });

  it('rejects a capability with the wrong kind const', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-capability.schema.json'));
    const broken = {
      apiVersion: 'workflow.aiwg.io/v1',
      kind: 'NotACapability',
      metadata: { name: 'x' },
      spec: { description: 'x', agent: 'workflow-executor' },
    };
    expect(validate(broken)).toBe(false);
  });
});

describe('forward Flows aliases validate (#1536)', () => {
  it('accepts apiVersion flow.aiwg.io/v1 + kind FlowPlaybook', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = {
      apiVersion: 'flow.aiwg.io/v1',
      kind: 'FlowPlaybook',
      metadata: { name: 'f' },
      spec: { inventory: 'x', targets: { groups: ['g'] }, steps: [{ id: 's', capability: 'c' }] },
    };
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts apiVersion flow.aiwg.io/v1 + kind FlowCapability', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-capability.schema.json'));
    const doc = {
      apiVersion: 'flow.aiwg.io/v1',
      kind: 'FlowCapability',
      metadata: { name: 'c' },
      spec: { description: 'd', version: '1.0.0', inputs: [], outputs: [], agent: 'workflow-executor' },
    };
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe('non-iterating Flows omit inventory/targets (#1539)', () => {
  it('a playbook with only spec.steps (no inventory/targets) validates', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = {
      apiVersion: 'flow.aiwg.io/v1',
      kind: 'FlowPlaybook',
      metadata: { name: 'project-flow' },
      // SDLC/project Flow: single project context, no host inventory to fan over.
      spec: { steps: [{ id: 'gate', kind: 'gate', description: 'human gate' }] },
    };
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe('agentic fan-out steps (#1547)', () => {
  const base = (step: Record<string, unknown>) => ({
    apiVersion: 'flow.aiwg.io/v1',
    kind: 'FlowPlaybook',
    metadata: { name: 'panel-flow' },
    spec: {
      steps: [
        { id: 'draft', capability: 'primary-author' },
        step,
        { id: 'archive', capability: 'archive-artifact', depends_on: ['review'] },
      ],
    },
  });

  it('a fan-out step (panel + synthesize) validates', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = base({
      id: 'review',
      fanout: {
        strategy: 'parallel',
        agents: ['security-review', 'test-review', 'architecture-review'],
        synthesize: 'review-synthesizer',
      },
      depends_on: ['draft'],
    });
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('rejects a fan-out missing synthesize', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = base({ id: 'review', fanout: { agents: ['a', 'b'] }, depends_on: ['draft'] });
    expect(validate(doc)).toBe(false);
  });

  it('rejects a fan-out with an empty agents panel', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = base({
      id: 'review',
      fanout: { agents: [], synthesize: 's' },
      depends_on: ['draft'],
    });
    expect(validate(doc)).toBe(false);
  });

  it('rejects a step that sets both capability and fanout', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(loadSchema('workflow-playbook.schema.json'));
    const doc = base({
      id: 'review',
      capability: 'one-agent',
      fanout: { agents: ['a'], synthesize: 's' },
      depends_on: ['draft'],
    });
    expect(validate(doc)).toBe(false);
  });
});

describe('WorkflowExtension framework ownership (#4427)', () => {
  const extension = (extendsFramework: string) => ({
    apiVersion: 'workflow.aiwg.io/v1',
    kind: 'WorkflowExtension',
    metadata: { name: 'cicd-provider' },
    spec: { extends: extendsFramework, description: 'CI provider extension', version: '1.0.0' },
  });

  it.each(['ops-complete', 'cicd-complete'])('accepts the %s parent', parent => {
    const validate = makeAjv().compile(loadSchema('workflow-extension.schema.json'));
    expect(validate(extension(parent)), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects an unknown parent with enum', () => {
    const validate = makeAjv().compile(loadSchema('workflow-extension.schema.json'));
    expect(validate(extension('unknown-framework'))).toBe(false);
    expect(validate.errors?.map(error => error.keyword)).toContain('enum');
  });

  it('preserves the ops-only OpsExtension contract', () => {
    const schemaPath = path.join(REPO_ROOT, 'agentic/code/frameworks/ops-complete/schemas/metalanguage/ops-extension.schema.json');
    const validate = makeAjv().compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
    const doc = { ...extension('ops-complete'), apiVersion: 'ops.aiwg.io/v1', kind: 'OpsExtension' };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    doc.spec.extends = 'cicd-complete';
    expect(validate(doc)).toBe(false);
    expect(validate.errors?.map(error => error.keyword)).toContain('const');
  });
});
