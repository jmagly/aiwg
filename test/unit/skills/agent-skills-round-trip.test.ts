import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import {
  AGENT_SKILLS_BASELINE,
  AIWG_SKILL_CONTROL_FIELDS,
  STANDARD_SKILL_FIELDS,
  restoreAgentSkillFromSidecar,
  type AgentSkillProjectionStatus,
  type AgentSkillResource,
  type AgentSkillSidecarV1,
  type AgentSkillsStandardMetadata,
} from '../../../src/skills/agent-skills.js';
import {
  AGENT_SKILL_DEPLOYMENT_SIDECAR,
  deployImportedAgentSkill,
  uninstallImportedAgentSkill,
} from '../../../src/skills/deployer.js';
import { importAgentSkill } from '../../../src/skills/importer.js';
import type { AgentSkillDeploymentOutcome } from '../../../src/skills/types.js';
import {
  validateAgentSkillContent,
  validateAgentSkillFile,
} from '../../../src/skills/validator.js';

const FIXTURE_ROOT = path.resolve('test/fixtures/agent-skills/lifecycle');
const SOURCE_ROOT = path.join(FIXTURE_ROOT, 'portable-complete');
const IMPORTED_AT = '2026-07-26T12:00:00.000Z';
const AIWG_VERSION = 'test-version';

interface ProviderFixture {
  id: string;
  location: 'project' | 'home' | 'configured';
  root: string;
  status: AgentSkillProjectionStatus;
  outcome: AgentSkillDeploymentOutcome;
  validator: 'pass' | 'not-applicable';
  resources: 'exact' | 'not-applicable';
  descriptionSuffix?: string;
  allowedReason?: string;
}

interface ProviderOracle {
  schemaVersion: 1;
  upstreamBaseline: {
    repository: string;
    revision: string;
    referenceValidatorVersion: string;
  };
  skill: {
    name: string;
    resourceSha256: Record<string, string>;
    aiwg: Record<string, unknown>;
  };
  providers: ProviderFixture[];
}

interface RepeatValue {
  $repeat: string;
  count: number;
}

interface ValidationFixture {
  id: string;
  directoryName: string;
  raw?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  bodyRepeat?: {
    value: string;
    count: number;
  };
  expectedCodes: string[];
}

interface ValidationOracle {
  schemaVersion: 1;
  upstreamRevision: string;
  cases: ValidationFixture[];
}

interface DeploymentSidecar {
  portable: AgentSkillSidecarV1;
}

const providerOracle = JSON.parse(fs.readFileSync(
  path.join(FIXTURE_ROOT, 'provider-oracle.json'),
  'utf8',
)) as ProviderOracle;
const validationOracle = JSON.parse(fs.readFileSync(
  path.join(FIXTURE_ROOT, 'validation-oracle.json'),
  'utf8',
)) as ValidationOracle;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function relativeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(root, '');
  return files;
}

function resolveFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolveFixtureValue);
  }
  if (value && typeof value === 'object') {
    const candidate = value as Partial<RepeatValue>;
    if (
      typeof candidate.$repeat === 'string'
      && typeof candidate.count === 'number'
    ) {
      return candidate.$repeat.repeat(candidate.count);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveFixtureValue(item)]),
    );
  }
  return value;
}

function validationContent(fixture: ValidationFixture): string {
  if (fixture.raw !== undefined) return fixture.raw;
  const frontmatter = stringify(resolveFixtureValue(fixture.frontmatter), {
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
  const body = fixture.bodyRepeat
    ? fixture.bodyRepeat.value.repeat(fixture.bodyRepeat.count)
    : (fixture.body ?? '');
  return `---\n${frontmatter}\n---\n${body}`;
}

function standardMetadata(
  frontmatter: Record<string, unknown>,
): AgentSkillsStandardMetadata {
  return Object.fromEntries(
    STANDARD_SKILL_FIELDS.flatMap((field) => (
      frontmatter[field] === undefined ? [] : [[field, frontmatter[field]]]
    )),
  ) as unknown as AgentSkillsStandardMetadata;
}

describe('Agent Skills malformed and advisory lifecycle corpus', () => {
  it('pins the controlled oracle to the reviewed upstream baseline', () => {
    expect(providerOracle.upstreamBaseline).toEqual({
      repository: AGENT_SKILLS_BASELINE.repository,
      revision: AGENT_SKILLS_BASELINE.revision,
      referenceValidatorVersion: AGENT_SKILLS_BASELINE.referenceValidatorVersion,
    });
    expect(validationOracle.upstreamRevision).toBe(AGENT_SKILLS_BASELINE.revision);
  });

  it('contains every normative diagnostic family plus size and reference advisories', () => {
    const covered = new Set(
      validationOracle.cases.flatMap((fixture) => fixture.expectedCodes),
    );
    expect(covered).toEqual(new Set([
      'AS_ADVISORY_LINES',
      'AS_ADVISORY_RESOURCE_DEPTH',
      'AS_ADVISORY_TOKENS',
      'AS_ALLOWED_TOOLS_EXPERIMENTAL',
      'AS_ALLOWED_TOOLS_FORMAT',
      'AS_ALLOWED_TOOLS_TYPE',
      'AS_BODY_REQUIRED',
      'AS_COMPATIBILITY_LENGTH',
      'AS_COMPATIBILITY_TYPE',
      'AS_DESCRIPTION_LENGTH',
      'AS_DESCRIPTION_REQUIRED',
      'AS_FIELD_UNKNOWN',
      'AS_FRONTMATTER_REQUIRED',
      'AS_LICENSE_TYPE',
      'AS_METADATA_TYPE',
      'AS_METADATA_VALUE_TYPE',
      'AS_NAME_DIRECTORY',
      'AS_NAME_FORMAT',
      'AS_NAME_REQUIRED',
      'AS_RESOURCE_PATH',
      'AS_YAML_PARSE',
      'AS_YAML_TYPE',
    ]));
  });

  it.each(validationOracle.cases)('$id matches its diagnostic oracle', (fixture) => {
    const result = validateAgentSkillContent(validationContent(fixture), {
      profile: 'strict',
      file: `${fixture.id}.md`,
      directoryName: fixture.directoryName,
    });
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(expect.arrayContaining(fixture.expectedCodes));
    if (fixture.expectedCodes.length === 0) {
      expect(result.valid).toBe(true);
      expect(result.diagnostics).toEqual([]);
    }
  });
});

describe('Agent Skills import-to-provider round trip', () => {
  let root: string;
  let projectDir: string;
  let homeDir: string;
  let managedLocation: string;
  let sentinel: string;
  let sourceValidation: ReturnType<typeof validateAgentSkillFile>;
  let validatePortableSidecar: ReturnType<Ajv2020['compile']>;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-agent-skills-round-trip-'));
    projectDir = path.join(root, 'project');
    homeDir = path.join(root, 'home');
    sentinel = path.join(root, 'script-executed');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(homeDir);
    process.env.AIWG_GROKBOT_SKILLS_DIR = path.join(
      homeDir,
      'configured-grokbot-skills',
    );
    process.env.AIWG_FIXTURE_SENTINEL = sentinel;

    sourceValidation = validateAgentSkillFile(path.join(SOURCE_ROOT, 'SKILL.md'), {
      profile: 'compatible',
      directoryName: providerOracle.skill.name,
      skillRoot: SOURCE_ROOT,
      checkResources: true,
    });
    expect(sourceValidation.valid).toBe(true);

    const imported = await importAgentSkill(
      { kind: 'directory', path: SOURCE_ROOT },
      {
        projectDir,
        profile: 'compatible',
        trust: true,
        activate: true,
        importedAt: IMPORTED_AT,
        aiwgVersion: AIWG_VERSION,
      },
    );
    managedLocation = imported.managedLocation;

    const schema = JSON.parse(fs.readFileSync(
      path.resolve('schemas/skills/agent-skill-sidecar.v1.schema.json'),
      'utf8',
    )) as object;
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    validatePortableSidecar = ajv.compile(schema);
  });

  afterAll(() => {
    delete process.env.AIWG_FIXTURE_SENTINEL;
    delete process.env.AIWG_GROKBOT_SKILLS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the provider oracle explicit and aligned with all canonical IDs', () => {
    expect(providerOracle.providers.map((provider) => provider.id))
      .toEqual([...PROVIDER_IDS]);
    expect(providerOracle.providers).toHaveLength(19);
  });

  it('preserves every managed source file as exact bytes without running scripts', () => {
    const sourceFiles = relativeFiles(SOURCE_ROOT);
    expect(relativeFiles(managedLocation)).toEqual(sourceFiles);
    for (const relative of sourceFiles) {
      expect(fs.readFileSync(path.join(managedLocation, relative)))
        .toEqual(fs.readFileSync(path.join(SOURCE_ROOT, relative)));
    }
    expect(fs.existsSync(sentinel)).toBe(false);
    for (const [relative, expectedDigest] of Object.entries(
      providerOracle.skill.resourceSha256,
    )) {
      expect(sha256(fs.readFileSync(path.join(managedLocation, relative))))
        .toBe(expectedDigest);
    }
  });

  it.each(providerOracle.providers)(
    '$id: path=$root status=$status validator=$validator resources=$resources',
    (provider) => {
      const result = deployImportedAgentSkill(providerOracle.skill.name, {
        projectDir,
        homeDir,
        target: provider.id,
      });
      const configuredRoot = process.env.AIWG_GROKBOT_SKILLS_DIR!;
      const expectedBase = provider.location === 'home'
        ? homeDir
        : provider.location === 'configured'
          ? configuredRoot
          : projectDir;
      const expectedPath = path.join(
        expectedBase,
        provider.root,
        providerOracle.skill.name,
      );

      expect(result).toMatchObject({
        provider: provider.id,
        path: expectedPath,
        projectionStatus: provider.status,
        outcome: ['codex', 'deepseek-harness', 'muse'].includes(provider.id)
          ? 'unchanged'
          : provider.outcome,
      });

      expect(provider.validator).toBe('pass');
      expect(provider.resources).toBe('exact');
      const projected = validateAgentSkillFile(path.join(expectedPath, 'SKILL.md'), {
        profile: 'strict',
        directoryName: providerOracle.skill.name,
        skillRoot: expectedPath,
        checkResources: true,
      });
      expect(projected.valid, projected.diagnostics.map(
        (diagnostic) => diagnostic.code,
      ).join(', ')).toBe(true);
      expect(projected.body).toBe(sourceValidation.body);

      const expectedStandard = standardMetadata(sourceValidation.frontmatter ?? {});
      if (provider.descriptionSuffix) {
        expectedStandard.description =
          `${expectedStandard.description} ${provider.descriptionSuffix}`;
      }
      expect(projected.frontmatter).toEqual(expectedStandard);
      expect(
        Object.keys(projected.frontmatter ?? {})
          .filter((field) => AIWG_SKILL_CONTROL_FIELDS.includes(
            field as (typeof AIWG_SKILL_CONTROL_FIELDS)[number],
          )),
      ).toEqual([]);

      const resources: AgentSkillResource[] = Object.entries(
        providerOracle.skill.resourceSha256,
      ).map(([relative, digest]) => {
        const sourceBytes = fs.readFileSync(path.join(SOURCE_ROOT, relative));
        const deployedBytes = fs.readFileSync(path.join(expectedPath, relative));
        expect(deployedBytes).toEqual(sourceBytes);
        expect(sha256(deployedBytes)).toBe(digest);
        return {
          path: relative,
          digest,
          size: deployedBytes.length,
        };
      });

      const deploymentSidecar = JSON.parse(fs.readFileSync(
        path.join(expectedPath, AGENT_SKILL_DEPLOYMENT_SIDECAR),
        'utf8',
      )) as DeploymentSidecar;
      expect(
        validatePortableSidecar(deploymentSidecar.portable),
        JSON.stringify(validatePortableSidecar.errors),
      ).toBe(true);
      const restored = restoreAgentSkillFromSidecar(
        standardMetadata(projected.frontmatter ?? {}),
        projected.body,
        resources,
        deploymentSidecar.portable,
      );
      expect(restored.standard).toEqual(expectedStandard);
      expect(restored.body).toBe(sourceValidation.body);
      expect(restored.resources).toEqual(resources);
      expect(restored.aiwg).toEqual(providerOracle.skill.aiwg);
    },
  );

  it('is byte-idempotent and removes every supported managed projection', () => {
    for (const provider of providerOracle.providers) {
      if (provider.status === 'unsupported') continue;
      const options = {
        projectDir,
        homeDir,
        target: provider.id,
      };
      deployImportedAgentSkill(providerOracle.skill.name, options);
      expect(deployImportedAgentSkill(providerOracle.skill.name, options).outcome)
        .toBe('unchanged');
      expect(uninstallImportedAgentSkill(providerOracle.skill.name, options).outcome)
        .toBe('removed');
      const rootDir = provider.location === 'home' ? homeDir : projectDir;
      expect(fs.existsSync(path.join(
        rootDir,
        provider.root,
        providerOracle.skill.name,
      ))).toBe(false);
    }
  });
});
