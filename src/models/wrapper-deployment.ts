import { promises as fs } from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { MODEL_WRAPPER_DEFINITIONS, type ModelRole, type ModelWrapperDefinition } from './wrapper-definitions.js';
import { isFlagshipModel } from './tiers.js';

export interface WrapperDeploymentMismatch {
  wrapper: string;
  path: string;
  field: string;
  expected?: string;
  actual?: string;
  reason: string;
}

export interface WrapperDeploymentVerification {
  supported: boolean;
  valid: boolean;
  agentsPath: string | null;
  found: string[];
  missing: string[];
  mismatches: WrapperDeploymentMismatch[];
}

export interface WrapperDeploymentExpectation {
  provider?: string;
  models?: Partial<Record<ModelRole, string>>;
}

const CLAUDE_ALIASES: Record<ModelRole, string> = {
  reasoning: 'opus',
  coding: 'sonnet',
  efficiency: 'haiku',
};

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(item);
      else if (entry.isFile()) files.push(item);
    }
  }
  await walk(root);
  return files.sort();
}

function tomlFields(content: string): Record<string, unknown> | null {
  try { return getStaticTOMLValue(parseTOML(content)) as Record<string, unknown>; }
  catch { return null; }
}

function markdownFields(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const parsed = loadYaml(match[1]);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
}

function artifactFields(file: string, content: string): Record<string, unknown> | null {
  if (/\.toml$/i.test(file)) return tomlFields(content);
  if (/\.json$/i.test(file)) {
    try {
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }
  if (/\.(?:md|yaml|yml)$/i.test(file)) return markdownFields(content);
  return null;
}

/** Read the same deployed artifacts used by verification, without repairing them. */
export async function readModelWrapperArtifacts(agentsPath: string | null) {
  const artifacts: { wrapper: ModelWrapperDefinition; file: string; fields: Record<string, unknown> | null }[] = [];
  if (!agentsPath) return artifacts;
  for (const file of await collectFiles(agentsPath)) {
    const name = path.basename(file).replace(/(?:\.agent)?\.(?:md|toml|json|yaml|yml)$/i, '');
    const wrapper = MODEL_WRAPPER_DEFINITIONS.find(item => item.name === name);
    if (!wrapper) continue;
    let fields = null;
    try { fields = artifactFields(file, await fs.readFile(file, 'utf8')); } catch { /* unresolved metadata */ }
    artifacts.push({ wrapper, file, fields });
  }
  return artifacts;
}

function fieldValue(fields: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function addMismatch(
  mismatches: WrapperDeploymentMismatch[],
  wrapper: string,
  file: string,
  field: string,
  reason: string,
  expected?: string,
  actual?: string,
): void {
  mismatches.push({
    wrapper,
    path: file,
    field,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    reason,
  });
}

async function validateArtifact(
  file: string,
  definition: ModelWrapperDefinition,
  expectation: WrapperDeploymentExpectation,
): Promise<WrapperDeploymentMismatch[]> {
  const { name: wrapper, role, tier, effort, readOnly } = definition;
  const mismatches: WrapperDeploymentMismatch[] = [];
  const content = await fs.readFile(file, 'utf8');
  if (!content.trim()) {
    addMismatch(mismatches, wrapper, file, 'content', 'wrapper artifact is empty');
    return mismatches;
  }
  const fields = artifactFields(file, content)
    ?? (expectation.provider === 'devin' && content.includes(`### ${wrapper}`) ? { name: wrapper } : null);
  if (!fields) {
    addMismatch(mismatches, wrapper, file, 'format', 'wrapper artifact is malformed or has no parseable metadata');
    return mismatches;
  }

  const actualName = fieldValue(fields, 'name') ?? (expectation.provider === 'opencode' ? wrapper : undefined);
  if (actualName !== wrapper) addMismatch(
    mismatches, wrapper, file, 'name', 'wrapper identity does not match its deployed filename', wrapper, actualName,
  );

  const actualRole = fieldValue(fields, 'model-role', 'modelRole', 'aiwg-model-role');
  if (actualRole && actualRole !== role) addMismatch(
    mismatches, wrapper, file, 'model-role', 'wrapper role is stale or mismatched', role, actualRole,
  );
  const actualTier = fieldValue(fields, 'model-tier', 'modelTier', 'aiwg-model-tier');
  const standardFallback = tier === 'economy' && actualTier === 'standard'
    && (readOnly || expectation.provider === 'cursor');
  if (actualTier && actualTier !== tier && !standardFallback) addMismatch(
    mismatches, wrapper, file, 'model-tier', 'wrapper tier is stale or mismatched', tier, actualTier,
  );

  const actualModel = fieldValue(fields, 'model', 'model_hint', 'modelHint');
  const expectedModel = expectation.models?.[role];
  if (actualModel && isFlagshipModel(actualModel)) addMismatch(
    mismatches, wrapper, file, 'model', 'wrapper model is flagship; wrappers cannot elect flagship', undefined, actualModel,
  );
  if (readOnly) {
    if (expectation.provider === 'codex' && fields.sandbox_mode !== 'read-only') addMismatch(
      mismatches, wrapper, file, 'sandbox_mode', 'read-only wrapper must use the native read-only sandbox', 'read-only', fieldValue(fields, 'sandbox_mode'),
    );
    const tools = Array.isArray(fields.tools) ? fields.tools : typeof fields.tools === 'string' ? fields.tools.split(/[,\s]+/) : [];
    if (['claude', 'copilot', 'factory', 'omp', 'antigravity', 'openclaw'].includes(expectation.provider ?? '') && tools.length === 0) addMismatch(
      mismatches, wrapper, file, 'tools', 'read-only wrapper is missing its explicit tool allowlist',
    );
    if (tools.some(tool => /^(?:write(?:_file)?|edit(?:_file)?|create|apply[_-]?patch|multiedit|task|agent|write_to_file|replace_file_content)$/i.test(String(tool)))) addMismatch(
      mismatches, wrapper, file, 'tools', 'read-only wrapper exposes mutation or delegation tools',
    );
    const allowlists: Record<string, readonly string[]> = {
      claude: ['Read', 'Grep', 'Glob', 'Bash'], copilot: ['search/codebase', 'terminal'],
      factory: ['Execute', 'Glob', 'Grep', 'Read'], omp: ['read', 'grep', 'glob', 'bash'],
      antigravity: ['read_file', 'grep_search', 'run_command'], openclaw: ['Read', 'Grep', 'Glob', 'Bash'],
    };
    const allowed = allowlists[expectation.provider ?? ''];
    if (allowed && (tools.length !== allowed.length || allowed.some(tool => !tools.includes(tool)))) addMismatch(
      mismatches, wrapper, file, 'tools', 'read-only wrapper tools differ from the provider allowlist',
    );
    if (expectation.provider === 'opencode') {
      const permissions = fields.permission as Record<string, unknown> | undefined;
      if (permissions?.edit !== 'deny' || permissions?.task !== 'deny' || permissions?.['*'] !== 'deny') addMismatch(
        mismatches, wrapper, file, 'permission', 'read-only wrapper must deny edits, delegation and unlisted tools',
      );
    }
    if (expectation.provider === 'cursor' && fields.readonly !== true) addMismatch(
      mismatches, wrapper, file, 'readonly', 'Cursor wrapper must enable its native read-only control',
    );
    if (!content.includes('WorkerClaims') || !content.includes('criterion') || !content.includes('Stop rules')) addMismatch(
      mismatches, wrapper, file, 'return-contract', 'read-only wrapper is missing its condensed worker return contract',
    );
  }
  if (expectation.provider === 'codex') {
    if (!actualModel) addMismatch(mismatches, wrapper, file, 'model', 'Codex wrapper has no exact model pin', expectedModel);
    else if (expectedModel && actualModel !== expectedModel) addMismatch(
      mismatches, wrapper, file, 'model', 'Codex wrapper model does not match the effective catalog', expectedModel, actualModel,
    );
    const actualEffort = fieldValue(fields, 'model_reasoning_effort');
    if (actualEffort !== effort) addMismatch(
      mismatches, wrapper, file, 'model_reasoning_effort', 'Codex wrapper effort does not match its role', effort, actualEffort,
    );
    if (!fieldValue(fields, 'developer_instructions')) addMismatch(
      mismatches, wrapper, file, 'developer_instructions', 'Codex wrapper has no bootstrap instructions', 'non-empty',
    );
  } else if (expectation.provider === 'claude') {
    const accepted = new Set([CLAUDE_ALIASES[role], expectedModel].filter(Boolean));
    if (!actualModel || !accepted.has(actualModel)) addMismatch(
      mismatches, wrapper, file, 'model', 'Claude wrapper does not carry the semantic role alias or effective model',
      [...accepted].join(' or '), actualModel,
    );
    if (!actualRole) addMismatch(mismatches, wrapper, file, 'model-role', 'Claude wrapper is missing its canonical role', role);
    if (!actualTier) addMismatch(mismatches, wrapper, file, 'model-tier', 'Claude wrapper is missing its canonical tier', tier);
  }
  return mismatches;
}

export async function verifyModelWrapperDeployment(
  agentsPath: string | null,
  expectation: WrapperDeploymentExpectation = {},
): Promise<WrapperDeploymentVerification> {
  const expected = MODEL_WRAPPER_DEFINITIONS;
  if (!agentsPath) return {
    supported: false,
    valid: false,
    agentsPath: null,
    found: [],
    missing: expected.map(({ name }) => name),
    mismatches: [],
  };
  const files = await collectFiles(agentsPath);
  const found: string[] = [];
  const missing: string[] = [];
  const mismatches: WrapperDeploymentMismatch[] = [];
  for (const definition of expected) {
    const wrapper = definition.name;
    const matches = files.filter(file => path.basename(file).replace(/(?:\.agent)?\.(?:md|toml|json|yaml|yml)$/i, '') === wrapper);
    if (matches.length === 0) {
      missing.push(wrapper);
      continue;
    }
    found.push(wrapper);
    if (matches.length > 1) addMismatch(
      mismatches, wrapper, matches[0], 'path', `multiple deployed wrapper artifacts found: ${matches.join(', ')}`,
    );
    mismatches.push(...await validateArtifact(matches[0], definition, expectation));
  }
  return {
    supported: true,
    valid: missing.length === 0 && mismatches.length === 0,
    agentsPath,
    found,
    missing,
    mismatches,
  };
}
