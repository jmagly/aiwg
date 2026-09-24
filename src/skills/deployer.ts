/**
 * Managed Agent Skills provider deployment.
 *
 * Imported source trees remain immutable. Provider surfaces receive an atomic,
 * strict Agent Skills projection plus ownership metadata outside SKILL.md.
 *
 * @implements #1879
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import type { Platform } from '../agents/types.js';
import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
} from '../providers/provider-definitions.js';
import {
  AGENT_SKILLS_SIDECAR_SCHEMA,
  AIWG_SKILL_CONTROL_FIELDS,
  createAgentSkillSidecar,
  projectStrictAgentSkill,
  type AgentSkillDocument,
  type AgentSkillProjectionStatus,
  type AgentSkillSidecarV1,
  type AgentSkillsStandardMetadata,
  type AiwgSkillControlMetadata,
} from './agent-skills.js';
import { getImportedAgentSkill } from './importer.js';
import type {
  AgentSkillDeploymentOptions,
  AgentSkillDeploymentOutcome,
  AgentSkillDeploymentResult,
  AgentSkillImportResult,
} from './types.js';
import { validateAgentSkillContent } from './validator.js';
import { resolveHermesHomePath } from '../providers/hermes-home.js';
import {
  museXdgSkillsDirRemediation,
  resolveMuseXdgSkillsDir,
} from '../providers/muse-paths.js';
import {
  GROKBOT_SKILLS_DIR_ENV,
  grokbotMissingRootRemediation,
  resolveGrokbotSkillsDir,
} from '../providers/grokbot-paths.js';

export const AGENT_SKILL_MANAGED_MARKER = '.aiwg-managed';
export const AGENT_SKILL_DEPLOYMENT_SIDECAR = '.aiwg-agent-skill.json';

const MARKER_CONTENT = 'aiwg-agent-skill-v1\n';
const STANDARD_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const;
const AIWG_FIELDS = new Set<string>(AIWG_SKILL_CONTROL_FIELDS);

interface DesiredDirectory {
  kind: 'directory';
  relativePath: string;
}

interface DesiredFile {
  kind: 'file';
  relativePath: string;
  bytes: Buffer;
}

type DesiredEntry = DesiredDirectory | DesiredFile;

interface ProjectionPolicy {
  provider: Platform;
  root: string;
  status: AgentSkillProjectionStatus;
  supported: boolean;
  reasons: string[];
  warnings: string[];
  appendToDescription?: string;
  maxDescriptionLength?: number;
}

interface ProjectionPlan {
  policy: ProjectionPolicy;
  targetPath: string;
  sourceDigest: string;
  desiredEntries: DesiredEntry[];
}

interface DeploymentSidecar {
  schemaVersion: 1;
  kind: 'aiwg-managed-agent-skill-projection';
  name: string;
  provider: Platform;
  projectionStatus: AgentSkillProjectionStatus;
  sourceDigest: string;
  reasons: string[];
  warnings: string[];
  portable: AgentSkillSidecarV1;
}

export interface AgentSkillProjectionInspection {
  provider: Platform;
  projectionStatus: AgentSkillProjectionStatus;
  path: string;
  sourceDigest: string;
  supported: boolean;
  exists: boolean;
  managed: boolean;
  matches: boolean;
  reasons: string[];
  warnings: string[];
}

export class AgentSkillDeploymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillDeploymentError';
  }
}

function fail(code: string, message: string): never {
  throw new AgentSkillDeploymentError(code, message);
}

function assertPortableName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    fail(
      'AS_DEPLOY_NAME',
      'Agent Skill name must be 1-64 lowercase ASCII letters, numbers, or single hyphens',
    );
  }
}

function resolvedHome(options: AgentSkillDeploymentOptions): string {
  return path.resolve(options.homeDir ?? os.homedir());
}

function resolvePolicy(
  target: string,
  options: AgentSkillDeploymentOptions,
): ProjectionPolicy {
  const provider = normalizeProviderDefinitionId(target);
  if (!provider) {
    fail('AS_DEPLOY_PROVIDER', `unknown Agent Skills target "${target}"`);
  }
  const definition = getProviderDefinition(provider);
  if (!definition) {
    fail('AS_DEPLOY_PROVIDER', `provider definition is unavailable for "${provider}"`);
  }

  const namespace = definition.skillNamespace;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let root = namespace.pathType === 'home-dir'
    ? path.join(resolvedHome(options), namespace.skillsBaseDir)
    : path.join(path.resolve(options.projectDir), namespace.skillsBaseDir);
  let status: AgentSkillProjectionStatus = 'native';
  let supported = true;
  let appendToDescription: string | undefined;
  let maxDescriptionLength: number | undefined;

  switch (provider) {
    case 'codex':
      root = path.join(path.resolve(options.projectDir), '.agents', 'skills');
      status = 'projected';
      maxDescriptionLength = namespace.maxDescriptionLength;
      reasons.push(
        'uses the project .agents/skills compatibility surface without the legacy 100/500 truncation transform',
      );
      break;
    case 'factory':
      status = 'projected';
      appendToDescription = namespace.appendToDescription;
      reasons.push('applies the Factory description guidance before strict validation');
      break;
    case 'grokbot': {
      // Fail closed: never invent ~/grokbot-skills or ~/.grokbot.
      const configured = resolveGrokbotSkillsDir(process.env);
      if (!configured) {
        root = '';
        status = 'unsupported';
        supported = false;
        reasons.push(grokbotMissingRootRemediation(process.env));
        warnings.push(
          `Agent Skills deploy for grokbot requires absolute ${GROKBOT_SKILLS_DIR_ENV}; no filesystem root was invented`,
        );
      } else {
        root = configured;
        reasons.push(
          `uses the operator-configured ${GROKBOT_SKILLS_DIR_ENV} skills root with strict managed ownership markers`,
        );
      }
      break;
    }
    case 'hermes':
      if (options.homeDir === undefined) {
        root = resolveHermesHomePath('skills');
      }
      reasons.push(
        'uses the active HERMES_HOME skills surface with strict managed ownership markers',
      );
      break;
    case 'muse': {
      // #234: resolve the documented XDG user root at deploy time — never
      // invent ~/.muse. An explicit homeDir (tests, operator override) keeps
      // the project-scoped namespace default (<repo>/.agents/skills); bad
      // XDG metadata fails closed instead of writing a bogus tree.
      if (options.homeDir === undefined) {
        const configured = resolveMuseXdgSkillsDir(process.env, os.homedir());
        if (!configured) {
          root = '';
          status = 'unsupported';
          supported = false;
          reasons.push(museXdgSkillsDirRemediation(process.env, os.homedir()));
          warnings.push(
            'Agent Skills deploy for muse requires a valid absolute XDG_CONFIG_HOME; no filesystem root was invented',
          );
        } else {
          root = configured;
          reasons.push(
            'uses the Muse XDG user skills root ($XDG_CONFIG_HOME/muse/skills, default ~/.config/muse/skills) with strict managed ownership markers',
          );
        }
      } else {
        reasons.push(
          'uses the project .agents/skills surface shared with antigravity, codex, and deepseek-harness',
        );
      }
      break;
    }
    case 'openhuman':
      status = 'projected';
      reasons.push(
        'uses the verified global one-level ~/.openhuman/skills layout',
      );
      break;
    case 'windsurf':
      status = 'projected';
      reasons.push(
        'uses one skill bundle directly below the one-level .windsurf/skills surface',
      );
      break;
    default:
      reasons.push('provider exposes a native recursive Agent Skills bundle surface');
  }

  return {
    provider,
    root,
    status,
    supported,
    reasons,
    warnings,
    appendToDescription,
    maxDescriptionLength,
  };
}

function assertSafeSourceEntry(
  sourceRoot: string,
  absolutePath: string,
  relativePath: string,
): fs.Stats {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    fail('AS_DEPLOY_SOURCE_SYMLINK', `managed source contains a symlink: ${relativePath}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    fail(
      'AS_DEPLOY_SOURCE_SPECIAL_FILE',
      `managed source contains a non-regular entry: ${relativePath}`,
    );
  }
  const real = fs.realpathSync.native(absolutePath);
  const relativeReal = path.relative(fs.realpathSync.native(sourceRoot), real);
  if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
    fail('AS_DEPLOY_SOURCE_ESCAPE', `managed source entry escapes its root: ${relativePath}`);
  }
  return stat;
}

function collectSourceEntries(sourceRoot: string): DesiredEntry[] {
  const entries: DesiredEntry[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        relativePath === AGENT_SKILL_MANAGED_MARKER
        || relativePath === AGENT_SKILL_DEPLOYMENT_SIDECAR
      ) {
        fail(
          'AS_DEPLOY_RESERVED_PATH',
          `managed source uses reserved deployment path "${relativePath}"`,
        );
      }
      const absolutePath = path.join(current, entry.name);
      const stat = assertSafeSourceEntry(sourceRoot, absolutePath, relativePath);
      if (stat.isDirectory()) {
        entries.push({ kind: 'directory', relativePath });
        walk(absolutePath, relativePath);
      } else {
        entries.push({
          kind: 'file',
          relativePath,
          bytes: fs.readFileSync(absolutePath),
        });
      }
    }
  };
  walk(sourceRoot, '');
  return entries;
}

function projectionDocument(
  record: AgentSkillImportResult,
): {
  document: AgentSkillDocument;
  sourceEntries: DesiredEntry[];
} {
  const sourceEntries = collectSourceEntries(record.managedLocation);
  const skillFile = sourceEntries.find((entry): entry is DesiredFile => (
    entry.kind === 'file' && entry.relativePath === 'SKILL.md'
  ));
  if (!skillFile) {
    fail('AS_DEPLOY_SKILL_MISSING', 'managed source does not contain SKILL.md');
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.bytes);
  const validation = validateAgentSkillContent(content, {
    profile: record.validationProfile,
    file: path.join(record.managedLocation, 'SKILL.md'),
    directoryName: record.name,
    skillRoot: record.managedLocation,
    checkResources: true,
  });
  if (!validation.valid || !validation.frontmatter) {
    fail(
      'AS_DEPLOY_SOURCE_INVALID',
      `managed source for "${record.name}" no longer passes ${record.validationProfile} validation`,
    );
  }

  const standard: Partial<AgentSkillsStandardMetadata> = {};
  for (const key of STANDARD_FIELDS) {
    const value = validation.frontmatter[key];
    if (value !== undefined) {
      Object.assign(standard, { [key]: structuredClone(value) });
    }
  }
  const aiwg: AiwgSkillControlMetadata = {};
  for (const [key, value] of Object.entries(validation.frontmatter)) {
    if (AIWG_FIELDS.has(key)) {
      aiwg[key as keyof AiwgSkillControlMetadata] = structuredClone(value);
    }
  }
  return {
    document: {
      standard: standard as AgentSkillsStandardMetadata,
      body: validation.body,
      resources: [],
      aiwg,
      unknownFields: [],
    },
    sourceEntries,
  };
}

function strictSkillBytes(
  record: AgentSkillImportResult,
  policy: ProjectionPolicy,
  document: AgentSkillDocument,
): Buffer | undefined {
  const metadata = projectStrictAgentSkill(document);
  if (policy.appendToDescription) {
    const suffix = policy.appendToDescription;
    if (!metadata.description.endsWith(suffix)) {
      metadata.description = `${metadata.description.trimEnd()} ${suffix}`;
    }
  }
  if (
    policy.maxDescriptionLength !== undefined
    && metadata.description.length > policy.maxDescriptionLength
  ) {
    policy.status = 'degraded';
    policy.supported = false;
    policy.reasons.push(
      `description length ${metadata.description.length} exceeds the provider limit ${policy.maxDescriptionLength}; no truncation was applied`,
    );
    return undefined;
  }

  const frontmatter = stringify(metadata, {
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
  const content = `---\n${frontmatter}\n---\n${document.body}`;
  const validation = validateAgentSkillContent(content, {
    profile: 'strict',
    file: 'SKILL.md',
    directoryName: record.name,
  });
  if (!validation.valid) {
    policy.status = 'degraded';
    policy.supported = false;
    policy.reasons.push(
      `provider projection failed strict validation: ${validation.diagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => item.code)
        .join(', ')}`,
    );
    return undefined;
  }
  return Buffer.from(content, 'utf8');
}

function sidecarBytes(
  record: AgentSkillImportResult,
  policy: ProjectionPolicy,
  document: AgentSkillDocument,
): Buffer {
  const portableSidecar = createAgentSkillSidecar(
    document,
    {
      sourceKind: record.source.kind,
      locator: record.source.locator,
      ...(record.source.kind === 'git'
        ? {
            requestedRevision: record.source.requestedRevision,
            resolvedRevision: record.source.resolvedRevision,
          }
        : {}),
      sourceDigest: record.digest,
      importedAt: record.importedAt,
      aiwgVersion: record.aiwgVersion,
    },
    record.validationProfile,
    record.trust,
  );
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'aiwg-managed-agent-skill-projection',
    name: record.name,
    provider: policy.provider,
    projectionStatus: policy.status,
    sourceDigest: record.digest,
    reasons: policy.reasons,
    warnings: policy.warnings,
    portable: portableSidecar,
  }, null, 2)}\n`, 'utf8');
}

function readDeploymentSidecar(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): DeploymentSidecar | undefined {
  try {
    const sidecarPath = path.join(targetPath, AGENT_SKILL_DEPLOYMENT_SIDECAR);
    const stat = fs.lstatSync(sidecarPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as DeploymentSidecar;
    if (
      value.schemaVersion !== 1
      || value.kind !== 'aiwg-managed-agent-skill-projection'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
      || !normalizeProviderDefinitionId(value.provider)
      || !/^[0-9a-f]{64}$/.test(value.sourceDigest)
      || !['native', 'projected', 'degraded', 'unsupported'].includes(
        value.projectionStatus,
      )
      || !Array.isArray(value.reasons)
      || !value.reasons.every((item) => typeof item === 'string')
      || !Array.isArray(value.warnings)
      || !value.warnings.every((item) => typeof item === 'string')
      || value.portable?.$schema !== AGENT_SKILLS_SIDECAR_SCHEMA
      || value.portable.schemaVersion !== 1
      || typeof value.portable.aiwg !== 'object'
      || value.portable.aiwg === null
      || Array.isArray(value.portable.aiwg)
      || value.portable.provenance?.sourceDigest !== value.sourceDigest
      || !['strict', 'compatible', 'discovery'].includes(
        value.portable.validationProfile,
      )
      || !['untrusted', 'trusted', 'revoked'].includes(
        value.portable.trust?.state,
      )
      || !['inactive', 'active', 'blocked'].includes(
        value.portable.trust?.activation,
      )
      || (expectedName !== undefined && value.name !== expectedName)
      || (expectedProvider !== undefined && value.provider !== expectedProvider)
      || path.basename(targetPath) !== value.name
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Codex, Antigravity, DeepSeek Harness, and Muse intentionally consume the
 * same portable project skill surface (<repo>/.agents/skills). A projection
 * written for any member is managed ownership for the others when the
 * desired payload is otherwise byte-identical.
 */
function providersShareProjectionSurface(
  actual: Platform,
  expected: Platform,
): boolean {
  const shared = new Set<Platform>(['antigravity', 'codex', 'deepseek-harness', 'muse']);
  return actual === expected || (shared.has(actual) && shared.has(expected));
}

function buildProjectionPlan(
  record: AgentSkillImportResult,
  options: AgentSkillDeploymentOptions,
): ProjectionPlan {
  const policy = resolvePolicy(options.target, options);
  const targetPath = path.join(policy.root, record.name);
  if (!policy.supported) {
    return {
      policy,
      targetPath,
      sourceDigest: record.digest,
      desiredEntries: [],
    };
  }

  const { document, sourceEntries } = projectionDocument(record);
  const skillBytes = strictSkillBytes(record, policy, document);
  if (!skillBytes) {
    return {
      policy,
      targetPath,
      sourceDigest: record.digest,
      desiredEntries: [],
    };
  }
  const desiredEntries: DesiredEntry[] = sourceEntries
    .filter((entry) => entry.relativePath !== 'SKILL.md')
    .map((entry) => (
      entry.kind === 'directory'
        ? { ...entry }
        : { ...entry, bytes: Buffer.from(entry.bytes) }
    ));
  desiredEntries.push(
    { kind: 'file', relativePath: 'SKILL.md', bytes: skillBytes },
    {
      kind: 'file',
      relativePath: AGENT_SKILL_MANAGED_MARKER,
      bytes: Buffer.from(MARKER_CONTENT, 'utf8'),
    },
    {
      kind: 'file',
      relativePath: AGENT_SKILL_DEPLOYMENT_SIDECAR,
      bytes: sidecarBytes(record, policy, document),
    },
  );
  desiredEntries.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
    || left.kind.localeCompare(right.kind)
  ));
  return {
    policy,
    targetPath,
    sourceDigest: record.digest,
    desiredEntries,
  };
}

function isManagedTarget(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): boolean {
  if (!fs.existsSync(targetPath)) return false;
  try {
    const targetStat = fs.lstatSync(targetPath);
    const marker = path.join(targetPath, AGENT_SKILL_MANAGED_MARKER);
    const sidecar = readDeploymentSidecar(targetPath, expectedName);
    return (
      targetStat.isDirectory()
      && !targetStat.isSymbolicLink()
      && fs.lstatSync(marker).isFile()
      && !fs.lstatSync(marker).isSymbolicLink()
      && fs.readFileSync(marker, 'utf8') === MARKER_CONTENT
      && sidecar !== undefined
      && (expectedProvider === undefined
        || providersShareProjectionSurface(sidecar.provider, expectedProvider))
    );
  } catch {
    return false;
  }
}

function targetMatches(
  targetPath: string,
  desired: DesiredEntry[],
  name: string,
  provider: Platform,
): boolean {
  if (!isManagedTarget(targetPath, name, provider)) return false;
  const actual = new Map<string, 'directory' | Buffer>();
  const walk = (current: string, prefix: string): boolean => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        actual.set(relativePath, 'directory');
        if (!walk(absolutePath, relativePath)) return false;
      } else if (stat.isFile()) {
        actual.set(relativePath, fs.readFileSync(absolutePath));
      } else {
        return false;
      }
    }
    return true;
  };
  if (!walk(targetPath, '')) return false;
  if (actual.size !== desired.length) return false;
  return desired.every((entry) => {
    if (
      entry.kind === 'file'
      && entry.relativePath === AGENT_SKILL_DEPLOYMENT_SIDECAR
    ) {
      const sidecar = readDeploymentSidecar(targetPath, name);
      return sidecar !== undefined
        && providersShareProjectionSurface(sidecar.provider, provider)
        && sidecar.sourceDigest === JSON.parse(
          entry.bytes.toString('utf8'),
        ).sourceDigest;
    }
    const value = actual.get(entry.relativePath);
    return entry.kind === 'directory'
      ? value === 'directory'
      : Buffer.isBuffer(value) && value.equals(entry.bytes);
  });
}

function writeDesiredTree(root: string, desired: DesiredEntry[]): void {
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  for (const entry of desired.filter(
    (item): item is DesiredDirectory => item.kind === 'directory',
  ).sort((left, right) => (
    left.relativePath.split('/').length - right.relativePath.split('/').length
    || left.relativePath.localeCompare(right.relativePath)
  ))) {
    fs.mkdirSync(path.join(root, ...entry.relativePath.split('/')), {
      recursive: true,
      mode: 0o700,
    });
  }
  for (const entry of desired.filter(
    (item): item is DesiredFile => item.kind === 'file',
  ).sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const target = path.join(root, ...entry.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode: 0o600 });
  }
}

function promoteAtomically(
  name: string,
  plan: ProjectionPlan,
): AgentSkillDeploymentOutcome {
  const parent = path.dirname(plan.targetPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const suffix = randomUUID();
  const staging = path.join(parent, `.${path.basename(plan.targetPath)}.staging-${suffix}`);
  const backup = path.join(parent, `.${path.basename(plan.targetPath)}.backup-${suffix}`);
  const existed = fs.existsSync(plan.targetPath);
  try {
    writeDesiredTree(staging, plan.desiredEntries);
    if (existed) {
      if (!isManagedTarget(plan.targetPath, name, plan.policy.provider)) {
        fail(
          'AS_DEPLOY_COLLISION_RACE',
          'deployment target ownership changed before atomic promotion',
        );
      }
      fs.renameSync(plan.targetPath, backup);
    }
    try {
      fs.renameSync(staging, plan.targetPath);
    } catch (error) {
      if (fs.existsSync(plan.targetPath)) {
        fs.rmSync(plan.targetPath, { recursive: true, force: true });
      }
      if (fs.existsSync(backup)) fs.renameSync(backup, plan.targetPath);
      throw error;
    }
    if (fs.existsSync(backup)) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(plan.targetPath, { recursive: true, force: true });
        fs.renameSync(backup, plan.targetPath);
        throw error;
      }
    }
    return existed ? 'updated' : 'deployed';
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(plan.targetPath)) {
      fs.renameSync(backup, plan.targetPath);
    }
  }
}

function result(
  operation: AgentSkillDeploymentResult['operation'],
  outcome: AgentSkillDeploymentOutcome,
  dryRun: boolean,
  name: string,
  plan: ProjectionPlan,
): AgentSkillDeploymentResult {
  return {
    schemaVersion: 1,
    operation,
    outcome,
    dryRun,
    name,
    provider: plan.policy.provider,
    projectionStatus: plan.policy.status,
    path: plan.targetPath,
    reasons: [...plan.policy.reasons],
    warnings: [...plan.policy.warnings],
    sourceDigest: plan.sourceDigest,
  };
}

function requireDeployableImport(
  name: string,
  projectDir: string,
): AgentSkillImportResult {
  const record = getImportedAgentSkill(projectDir, name);
  if (!record) {
    fail('AS_DEPLOY_IMPORT_MISSING', `managed Agent Skill "${name}" is not imported`);
  }
  if (
    record.trust.state !== 'trusted'
    || record.trust.activation !== 'active'
  ) {
    fail(
      'AS_DEPLOY_IMPORT_INACTIVE',
      `managed Agent Skill "${name}" is ${record.trust.state}/${record.trust.activation}`,
    );
  }
  if (record.diagnostics.some((item) => item.code === 'AS_IMPORT_MANAGED_DRIFT')) {
    fail(
      'AS_DEPLOY_IMPORT_DRIFT',
      `managed Agent Skill "${name}" no longer matches digest ${record.digest}`,
    );
  }
  return record;
}

export function deployImportedAgentSkill(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillDeploymentResult {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = requireDeployableImport(name, projectDir);
  const plan = buildProjectionPlan(record, { ...options, projectDir });
  const dryRun = options.dryRun ?? false;
  if (!plan.policy.supported) {
    return result('deploy', 'blocked', dryRun, name, plan);
  }
  if (
    fs.existsSync(plan.targetPath)
    && !isManagedTarget(plan.targetPath, name, plan.policy.provider)
  ) {
    plan.policy.status = 'degraded';
    plan.policy.reasons.push('target collision is not owned by AIWG');
    plan.policy.warnings.push('the existing user-owned target was not modified');
    return result('deploy', 'blocked', dryRun, name, plan);
  }
  if (targetMatches(
    plan.targetPath,
    plan.desiredEntries,
    name,
    plan.policy.provider,
  )) {
    return result('deploy', 'unchanged', dryRun, name, plan);
  }
  if (dryRun) return result('deploy', 'planned', true, name, plan);
  return result('deploy', promoteAtomically(name, plan), false, name, plan);
}

export function uninstallImportedAgentSkill(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillDeploymentResult {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = getImportedAgentSkill(projectDir, name);
  const policy = resolvePolicy(options.target, { ...options, projectDir });
  const plan: ProjectionPlan = {
    policy,
    targetPath: path.join(policy.root, name),
    sourceDigest: record?.digest ?? '',
    desiredEntries: [],
  };
  const deployedSidecar = readDeploymentSidecar(
    plan.targetPath,
    name,
    policy.provider,
  );
  if (deployedSidecar) {
    plan.sourceDigest = deployedSidecar.sourceDigest;
  }
  const dryRun = options.dryRun ?? false;
  if (!fs.existsSync(plan.targetPath)) {
    return result('uninstall', 'absent', dryRun, name, plan);
  }
  if (!isManagedTarget(plan.targetPath, name, plan.policy.provider)) {
    plan.policy.status = 'degraded';
    plan.policy.reasons.push('target collision is not owned by AIWG');
    plan.policy.warnings.push('the existing user-owned target was not removed');
    return result('uninstall', 'blocked', dryRun, name, plan);
  }
  if (dryRun) return result('uninstall', 'planned', true, name, plan);
  fs.rmSync(plan.targetPath, { recursive: true, force: true });
  return result('uninstall', 'removed', false, name, plan);
}

export function inspectImportedAgentSkillProjection(
  name: string,
  options: AgentSkillDeploymentOptions,
): AgentSkillProjectionInspection {
  assertPortableName(name);
  const projectDir = path.resolve(options.projectDir);
  const record = getImportedAgentSkill(projectDir, name);
  if (!record) {
    fail('AS_DEPLOY_IMPORT_MISSING', `managed Agent Skill "${name}" is not imported`);
  }
  const plan = buildProjectionPlan(record, { ...options, projectDir, dryRun: true });
  const exists = fs.existsSync(plan.targetPath);
  const managed = exists && isManagedTarget(
    plan.targetPath,
    name,
    plan.policy.provider,
  );
  return {
    provider: plan.policy.provider,
    projectionStatus: plan.policy.status,
    path: plan.targetPath,
    sourceDigest: plan.sourceDigest,
    supported: plan.policy.supported,
    exists,
    managed,
    matches: (
      plan.policy.supported
      && managed
      && targetMatches(
        plan.targetPath,
        plan.desiredEntries,
        name,
        plan.policy.provider,
      )
    ),
    reasons: [...plan.policy.reasons],
    warnings: [...plan.policy.warnings],
  };
}
