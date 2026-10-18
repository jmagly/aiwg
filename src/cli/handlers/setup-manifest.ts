import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { findPackageRoot } from '../find-package-root.js';
import { isInteractive } from '../env.js';
import { boundedSpawnSync } from '../../process/bounded-child-process.mjs';
import { sha256 } from '../../security/artifact-trust.js';
import type { ArtifactVerificationResult } from '../../security/artifact-verifier.js';
import { artifactVerifyHandler } from './artifact-verify.js';
import { requireFlagValue, MissingFlagValueError, collectFlagValues, hasPositionalOrSwitch, argsTerminatorIndex, valueTokenIndexes } from '../flag-parsing.js';
import { exitCodeForSpawnResult } from '../child-process-result.js';
import { askString, createPromptInterface } from '../prompt-utils.js';

type Severity = 'error' | 'warning';

export interface SetupValidationFinding {
  severity: Severity;
  path: string;
  rule: string;
  message: string;
}

interface SetupManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    description?: string;
    version?: string;
    install_type?: 'user' | 'developer' | 'ci';
    execution_mode?: 'deterministic' | 'provider-orchestrated';
  };
  spec: {
    platforms: Array<{ os: string; distros?: string[]; arch?: string[]; shell?: string }>;
    params?: SetupParam[];
    prerequisites?: Array<{ name: string; detect: string; required?: boolean; install_hint?: string }>;
    os_config?: Array<{
      id: string;
      description: string;
      check: string;
      apply: string;
      requires_relogin?: boolean;
      interactive?: boolean;
      platforms?: string[];
    }>;
    steps: SetupStep[];
    recovery?: Array<{ id: string; steps: SetupStep[] }>;
    briefing?: { success?: string; next_steps?: string[] };
  };
}

interface SetupParam {
  name: string;
  type: 'string' | 'path' | 'bool' | 'int' | 'choice';
  default?: unknown;
  required?: boolean;
  description?: string;
  choices?: string[];
  interactive_required?: boolean;
}

interface SetupStep {
  id: string;
  type: 'script' | 'detect' | 'ask' | 'verify' | 'agentic' | 'platform-route' | 'chain' | 'os-config';
  platform?: string | string[];
  config_id?: string;
  script?: string;
  params?: string[];
  verify?: string | string[];
  commands?: string[];
  message?: string;
  on_deny?: 'abort' | 'skip';
  on_fail?: string;
  instruction?: string;
  manifest?: string;
  depends_on?: string[];
  when?: string;
  routes?: Array<{ platform: string; steps: SetupStep[] }>;
  /**
   * If true, this step itself prompts directly (beyond the generic
   * possibility that any shell command/script might) and requires an
   * interactive terminal. `setup-run` refuses a marked step up front,
   * before running it, when no terminal is attached (#3062).
   */
  interactive?: boolean;
}

interface LoadedManifest {
  manifest: SetupManifest | null;
  raw: unknown;
  manifestPath: string;
  manifestDir: string;
  schemaPath: string;
  findings: SetupValidationFinding[];
}

interface ValidationOptions {
  cwd: string;
  frameworkRoot: string;
  manifestPath?: string;
  schemaPath?: string;
  strict?: boolean;
}

interface RunOptions {
  cwd: string;
  frameworkRoot: string;
  manifestPath?: string;
  dryRun?: boolean;
  platform?: string;
  distro?: string;
  paramsFile?: string;
  paramValues: Record<string, string>;
  step?: string;
  skip: Set<string>;
  type?: string;
  yes?: boolean;
  artifactVerification?: ArtifactVerificationResult;
}

interface GenerateOptions {
  cwd: string;
  output?: string;
  name?: string;
  type?: 'user' | 'developer' | 'ci';
  platform?: string;
  force?: boolean;
  json?: boolean;
}

const SETUP_SCHEMA_REL = 'agentic/code/addons/agentic-installer/schemas/v1/setup-manifest.schema.json';

const GENERATE_HELP = `aiwg setup-generate - generate a starter setup.aiwg.io/v1 SetupManifest

Usage:
  aiwg setup-generate [--output PATH] [--name NAME] [--type user|developer|ci]
                      [--platform OS] [--force] [--json]

Options:
  --output PATH   Manifest path to create. Defaults to ./setup.manifest.yaml.
  --name NAME     Manifest metadata.name. Defaults to package name or directory name.
  --type TYPE     Install type: user, developer, or ci. Defaults to developer.
  --platform OS   Platform target: linux, macos, windows, docker. Defaults to current OS.
  --force         Overwrite existing generated files.
  --json          Emit machine-readable generation result.
  --help, -h      Show this help.
`;

const VALIDATE_HELP = `aiwg setup-validate - validate a setup.aiwg.io/v1 SetupManifest

Usage:
  aiwg setup-validate [manifest-path] [--schema PATH] [--strict] [--fix] [--json]
  aiwg setup-validate --manifest PATH [--json]

Options:
  --manifest PATH   Manifest path. Defaults to ./setup.manifest.yaml.
  --schema PATH     Override canonical schema path.
  --strict          Treat warnings as failures.
  --fix             Reserved for future safe autofixes; currently validates only.
  --json            Emit machine-readable validation results.
  --help, -h        Show this help.
`;

const RUN_HELP = `aiwg setup-run - execute a setup.aiwg.io/v1 SetupManifest

Usage:
  aiwg setup-run [manifest-path] [--manifest PATH] [--dry-run] [--platform OS]
                 [--distro NAME] [--params-file PATH] [--param KEY=VALUE]
                 [--step STEP_ID] [--skip A,B] [--type user|developer|ci]
                 [--yes|--confirm] [--attestation PATH] [--policy ROOT]
                 [--state PATH] [--offline]

Options:
  --manifest PATH      Manifest path. Defaults to ./setup.manifest.yaml.
  --dry-run            Validate and print the execution plan without running steps.
  --platform OS        Override platform detection: linux, macos, windows, docker.
  --distro NAME        Override Linux distro detection.
  --params-file PATH   YAML object containing parameter values.
  --param KEY=VALUE    Parameter override. Repeatable; --set is also accepted.
  --step STEP_ID       Run only one step, useful after a failed setup.
  --skip A,B           Comma-separated step IDs to skip.
  --type TYPE          Select default manifest by install type when no path is given.
  --yes, --confirm     Explicitly authorize mutating step execution and recovery.
  --attestation PATH   Adjacent AIWG attestation for provider-orchestrated handoff.
  --policy ROOT        Explicit cross-asset trust root; required for agent handoff.
  --state PATH         Persisted trust/freshness state used by verification.
  --offline            Forbid network retrieval and require portable evidence.
  --help, -h           Show this help.

Safety:
  setup-run always runs setup-validate before platform detection or execution.
  Mutating execution refuses to run without explicit confirmation.
  Provider-orchestrated manifests are never handed to an agent unless their
  exact bytes have status verified under the explicit trust policy.

Headless input steps (#3062):
  A 'type: ask' step resolves its declared 'params' the same way a 'script'
  step's env vars do (--param/--params-file/env/default); if every declared
  param is already resolved it runs headless; otherwise a terminal prompts
  for missing values. Without a terminal it refuses and names the missing params. A step marked
  'interactive: true' runs an arbitrary script whose questions cannot be
  enumerated; without a terminal it is refused outright. Every selected
  step (including nested 'platform-route' steps) is preflighted for both
  conditions before any step executes — never partway through.
`;

/**
 * A value-taking flag present without a usable value is a usage error, not
 * "not given" (#3062 review item 11) — delegates to the shared strict
 * parser. Callers (the three handlers below) catch `MissingFlagValueError`
 * and report it before any preflight check, spawn, or write.
 * `precedence: 'first'` matches this command's own pre-#3062 behavior (a
 * hand-rolled loop that returned on the first match), unchanged by the
 * shared parser's second-round fix (#3062 second review, finding 4).
 */
function flagValue(args: readonly string[], name: string): string | undefined {
  return requireFlagValue(args, {}, name);
}

const VALUE_FLAGS = [
  '--manifest', '--schema', '--platform', '--distro', '--params-file', '--param', '--set',
  '--step', '--skip', '--type', '--output', '--name', '--attestation', '--policy', '--state',
  '--asset-type', '--namespace', '--channel',
];

function hasFlag(args: readonly string[], ...names: string[]): boolean {
  return names.some(name => hasPositionalOrSwitch(args, name, VALUE_FLAGS));
}

function positionalManifest(args: readonly string[]): string | undefined {
  const consumed = valueTokenIndexes(args, VALUE_FLAGS);
  return args.slice(0, argsTerminatorIndex(args)).find((arg, index) => !consumed.has(index) && !arg.startsWith('-'));
}

function resolveSchemaPath(frameworkRoot: string, cwd: string, override?: string): string {
  if (override) return path.resolve(cwd, override);
  const candidates = [
    path.join(frameworkRoot, SETUP_SCHEMA_REL),
    path.join(cwd, SETUP_SCHEMA_REL),
  ];
  const packageRoot = findPackageRoot(path.dirname(new URL(import.meta.url).pathname));
  if (packageRoot) candidates.push(path.join(packageRoot, SETUP_SCHEMA_REL));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`setup schema not found; expected ${SETUP_SCHEMA_REL}`);
  }
  return found;
}

function parseYamlFile(filePath: string): { value: unknown; errors: SetupValidationFinding[] } {
  const text = readFileSync(filePath, 'utf8');
  const doc = parseDocument(text, { prettyErrors: false });
  const errors: SetupValidationFinding[] = doc.errors.map((error) => ({
    severity: 'error',
    path: '/',
    rule: 'yaml',
    message: error.message,
  }));
  return { value: errors.length ? null : doc.toJSON(), errors };
}

function jsonPointer(parent: string, segment: string | number): string {
  const safe = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return parent === '/' ? `/${safe}` : `${parent}/${safe}`;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function schemaTypeMatches(value: unknown, expected: string): boolean {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  return true;
}

function resolveRef(rootSchema: any, ref: string): any {
  if (!ref.startsWith('#/')) throw new Error(`unsupported schema ref: ${ref}`);
  return ref.slice(2).split('/').reduce((current, part) => current?.[part], rootSchema);
}

function validateAgainstSchema(value: unknown, schema: any, rootSchema: any, pointer = '/'): SetupValidationFinding[] {
  const findings: SetupValidationFinding[] = [];
  if (schema.$ref) return validateAgainstSchema(value, resolveRef(rootSchema, schema.$ref), rootSchema, pointer);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate: any) => validateAgainstSchema(value, candidate, rootSchema, pointer).length === 0);
    if (matches.length !== 1) {
      findings.push({ severity: 'error', path: pointer, rule: 'oneOf', message: `must match exactly one allowed schema shape; matched ${matches.length}` });
    }
    return findings;
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    findings.push({ severity: 'error', path: pointer, rule: 'type', message: `expected ${schema.type}, got ${typeName(value)}` });
    return findings;
  }
  if (schema.const !== undefined && value !== schema.const) {
    findings.push({ severity: 'error', path: pointer, rule: 'const', message: `expected ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    findings.push({ severity: 'error', path: pointer, rule: 'enum', message: `must be one of: ${schema.enum.join(', ')}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      findings.push({ severity: 'error', path: pointer, rule: 'minItems', message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, index) => findings.push(...validateAgainstSchema(item, schema.items, rootSchema, jsonPointer(pointer, index))));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in obj)) {
        findings.push({ severity: 'error', path: pointer, rule: 'required', message: `missing required property '${required}'` });
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          findings.push({ severity: 'error', path: jsonPointer(pointer, key), rule: 'additionalProperties', message: 'unknown property' });
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) findings.push(...validateAgainstSchema(obj[key], childSchema, rootSchema, jsonPointer(pointer, key)));
    }
  }
  return findings;
}

function asManifest(value: unknown): SetupManifest | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SetupManifest : null;
}

function allSteps(manifest: SetupManifest): Array<{ step: SetupStep; pointer: string }> {
  const out: Array<{ step: SetupStep; pointer: string }> = [];
  const visit = (steps: SetupStep[] | undefined, base: string) => {
    steps?.forEach((step, index) => {
      const pointer = jsonPointer(base, index);
      out.push({ step, pointer });
      step.routes?.forEach((route, routeIndex) => visit(route.steps, `${pointer}/routes/${routeIndex}/steps`));
    });
  };
  visit(manifest.spec.steps, '/spec/steps');
  manifest.spec.recovery?.forEach((recovery, index) => visit(recovery.steps, `/spec/recovery/${index}/steps`));
  return out;
}

function existingRelative(manifestDir: string, rel: string | undefined): boolean {
  return !!rel && existsSync(path.resolve(manifestDir, rel));
}

/**
 * Detect `on_fail` reference cycles among recovery procedures themselves —
 * go/no-go review blocker 3. A step's `on_fail` can name any recovery
 * procedure, including (structurally, per the shared `SetupStep` type) a
 * step *inside* a recovery procedure's own `steps`. A recovery procedure
 * that (directly, or through another recovery procedure) names itself used
 * to make the old, eager preflight recurse into it forever —
 * `RangeError: Maximum call stack size exceeded`, reproduced in memory by
 * the review.
 *
 * This is a one-time, bounded graph walk over `manifest.spec.recovery[]`
 * only (at most `recovery.length` nodes) — a visited/"on the current path"
 * marker per node means each node is fully explored exactly once, so this
 * terminates and never re-enters a node already being explored; it reports
 * one finding per distinct cycle instead of throwing. An `on_fail` that
 * does not resolve to a known recovery id is reported separately by the
 * existing unresolved-recovery check (`installerConsistencyChecks` above)
 * and is not itself a cycle.
 *
 * This graph check is independent of, and does not change, how `on_fail`
 * references are actually used (`collectPreflightBlockers()`/`runStep()`
 * below): execution never follows an `on_fail` reference more than once
 * (a failing recovery step reports failure directly, it does not itself
 * trigger further recovery), so neither the main-sequence preflight nor a
 * selected recovery's own preflight recurses through `on_fail` at all —
 * see `collectPreflightBlockers()`'s own doc comment. This cycle check
 * exists for the case the type system permits but execution never
 * exercises: a recovery procedure's own steps declaring `on_fail`.
 */
function detectRecoveryReferenceCycles(manifest: SetupManifest): SetupValidationFinding[] {
  const recoveries = manifest.spec.recovery ?? [];
  if (recoveries.length === 0) return [];

  const onFailTargets = new Map<string, string[]>();
  for (const recovery of recoveries) {
    const targets: string[] = [];
    const collect = (steps: SetupStep[] | undefined): void => {
      steps?.forEach((step) => {
        if (step.on_fail && step.on_fail !== 'recover') targets.push(step.on_fail);
        step.routes?.forEach((route) => collect(route.steps));
      });
    };
    collect(recovery.steps);
    onFailTargets.set(recovery.id, targets);
  }

  const findings: SetupValidationFinding[] = [];
  const reportedCycles = new Set<string>();
  const state = new Map<string, 'on-path' | 'done'>();

  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'on-path') {
      const cycle = [...path.slice(path.indexOf(id)), id];
      const key = [...new Set(cycle)].sort().join('\u0000');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        findings.push({
          severity: 'error',
          path: '/spec/recovery',
          rule: 'recoveryCycle',
          message: `recovery reference cycle: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }
    state.set(id, 'on-path');
    for (const next of onFailTargets.get(id) ?? []) {
      if (onFailTargets.has(next)) visit(next, [...path, id]);
    }
    state.set(id, 'done');
  };

  for (const recovery of recoveries) visit(recovery.id, []);
  return findings;
}

function installerConsistencyChecks(manifest: SetupManifest | null, manifestDir: string): SetupValidationFinding[] {
  if (!manifest) return [];
  const findings: SetupValidationFinding[] = [];
  const topStepIds = new Set(manifest.spec.steps.map((step) => step.id));
  const allStepIds = new Set<string>();
  const recoveryIds = new Set((manifest.spec.recovery ?? []).map((recovery) => recovery.id));
  const osConfigIds = new Set((manifest.spec.os_config ?? []).map((entry) => entry.id));
  const installType = manifest.metadata.install_type ?? 'user';
  const executionMode = manifest.metadata.execution_mode ?? 'deterministic';

  for (const [index, step] of manifest.spec.steps.entries()) {
    if (allStepIds.has(step.id)) {
      findings.push({ severity: 'error', path: `/spec/steps/${index}/id`, rule: 'uniqueStepId', message: `duplicate step id '${step.id}'` });
    }
    allStepIds.add(step.id);
    for (const dep of step.depends_on ?? []) {
      if (!topStepIds.has(dep)) {
        findings.push({ severity: 'error', path: `/spec/steps/${index}/depends_on`, rule: 'depends_on', message: `unresolved step id '${dep}'` });
      }
    }
    if (step.on_fail && !recoveryIds.has(step.on_fail) && step.on_fail !== 'recover') {
      findings.push({ severity: 'error', path: `/spec/steps/${index}/on_fail`, rule: 'on_fail', message: `unresolved recovery '${step.on_fail}'` });
    }
  }

  // Go/no-go review blocker 3.
  findings.push(...detectRecoveryReferenceCycles(manifest));

  for (const { step, pointer } of allSteps(manifest)) {
    if (step.type === 'script' && !existingRelative(manifestDir, step.script)) {
      findings.push({ severity: 'error', path: `${pointer}/script`, rule: 'scriptExists', message: `script not found: ${step.script ?? '(missing)'}` });
    }
    if (step.type === 'chain' && !existingRelative(manifestDir, step.manifest)) {
      findings.push({ severity: 'error', path: `${pointer}/manifest`, rule: 'chainManifestExists', message: `chain manifest not found: ${step.manifest ?? '(missing)'}` });
    }
    if (step.type === 'os-config' && (!step.config_id || !osConfigIds.has(step.config_id))) {
      findings.push({ severity: 'error', path: `${pointer}/config_id`, rule: 'osConfigReference', message: `config_id '${step.config_id ?? '(missing)'}' not found in spec.os_config` });
    }
    if (step.type === 'agentic') {
      if (!step.instruction) {
        findings.push({ severity: 'error', path: `${pointer}/instruction`, rule: 'agenticInstruction', message: 'agentic step requires instruction' });
      } else if (executionMode !== 'provider-orchestrated') {
        findings.push({ severity: 'warning', path: pointer, rule: 'agenticStep', message: 'agentic steps are exception handling only and require manual intervention during setup-run' });
      }
    }
    if (step.type === 'platform-route') {
      for (const [routeIndex, route] of (step.routes ?? []).entries()) {
        if (!route.steps?.length) {
          findings.push({ severity: 'error', path: `${pointer}/routes/${routeIndex}/steps`, rule: 'platformRouteSteps', message: 'platform-route must contain route steps' });
        }
      }
    }
  }

  for (const [index, param] of (manifest.spec.params ?? []).entries()) {
    if (installType === 'developer' && param.interactive_required && param.default !== undefined) {
      findings.push({ severity: 'error', path: `/spec/params/${index}/default`, rule: 'interactiveDefault', message: 'interactive_required params must not define a default in developer manifests' });
    }
    if (param.interactive_required && param.required) {
      findings.push({ severity: 'warning', path: `/spec/params/${index}/required`, rule: 'redundantRequired', message: 'required is redundant when interactive_required is true' });
    }
  }

  if (installType === 'developer') {
    if (!(manifest.spec.os_config ?? []).length && !/no os configuration/i.test(manifest.metadata.description ?? '')) {
      findings.push({ severity: 'warning', path: '/spec/os_config', rule: 'developerOsConfig', message: 'developer manifest has no os_config block' });
    }
    const applied = new Set(manifest.spec.steps.filter((step) => step.type === 'os-config').map((step) => step.config_id));
    for (const [index, entry] of (manifest.spec.os_config ?? []).entries()) {
      if (entry.requires_relogin && !applied.has(entry.id)) {
        findings.push({ severity: 'warning', path: `/spec/os_config/${index}`, rule: 'unusedReloginOsConfig', message: `os_config '${entry.id}' requires relogin but no step applies it` });
      }
      if (entry.interactive && !entry.description.trim()) {
        findings.push({ severity: 'warning', path: `/spec/os_config/${index}/description`, rule: 'interactiveDescription', message: 'interactive os_config entries need a user-facing description' });
      }
    }
  }

  for (const [index, prereq] of (manifest.spec.prerequisites ?? []).entries()) {
    if (prereq.required !== false && !prereq.install_hint) {
      findings.push({ severity: 'warning', path: `/spec/prerequisites/${index}/install_hint`, rule: 'installHint', message: `required prerequisite '${prereq.name}' has no install_hint` });
    }
  }
  return findings;
}

export function validateSetupManifest(options: ValidationOptions): LoadedManifest {
  const manifestPath = path.resolve(options.cwd, options.manifestPath ?? 'setup.manifest.yaml');
  const schemaPath = resolveSchemaPath(options.frameworkRoot, options.cwd, options.schemaPath);
  const findings: SetupValidationFinding[] = [];
  if (!existsSync(manifestPath)) {
    findings.push({ severity: 'error', path: manifestPath, rule: 'manifestExists', message: `manifest not found: ${manifestPath}` });
    return { manifest: null, raw: null, manifestPath, manifestDir: path.dirname(manifestPath), schemaPath, findings };
  }
  const parsed = parseYamlFile(manifestPath);
  findings.push(...parsed.errors);
  let manifest = asManifest(parsed.value);
  if (!parsed.errors.length) {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    findings.push(...validateAgainstSchema(parsed.value, schema, schema));
    manifest = findings.some((finding) => finding.severity === 'error') ? null : asManifest(parsed.value);
    findings.push(...installerConsistencyChecks(manifest, path.dirname(manifestPath)));
  }
  if (options.strict) {
    for (const finding of findings) {
      if (finding.severity === 'warning') finding.severity = 'error';
    }
  }
  return { manifest, raw: parsed.value, manifestPath, manifestDir: path.dirname(manifestPath), schemaPath, findings };
}

function renderValidationText(result: LoadedManifest): string {
  const errors = result.findings.filter((finding) => finding.severity === 'error');
  const warnings = result.findings.filter((finding) => finding.severity === 'warning');
  const manifest = result.manifest;
  const lines = [
    `Validating: ${result.manifestPath}`,
    '',
    `  Schema:        ${errors.length ? 'invalid' : 'valid'} (${result.schemaPath})`,
  ];
  if (manifest) {
    lines.push(`  Install type:  ${manifest.metadata.install_type ?? 'user'}`);
    lines.push(`  Metadata:      name=${manifest.metadata.name}${manifest.metadata.version ? ` version=${manifest.metadata.version}` : ''}`);
    lines.push(`  Platform:      ${manifest.spec.platforms.map((p) => p.os).join(', ')}`);
    lines.push(`  Params:        ${(manifest.spec.params ?? []).length}`);
    lines.push(`  Prerequisites: ${(manifest.spec.prerequisites ?? []).length}`);
    lines.push(`  OS Config:     ${(manifest.spec.os_config ?? []).length}`);
    lines.push(`  Steps:         ${manifest.spec.steps.length}`);
    lines.push(`  Recovery:      ${(manifest.spec.recovery ?? []).length}`);
  }
  if (errors.length) {
    lines.push('', `  Errors (${errors.length}):`);
    errors.forEach((finding) => lines.push(`    x ${finding.path}: ${finding.rule} - ${finding.message}`));
  }
  if (warnings.length) {
    lines.push('', `  Warnings (${warnings.length}):`);
    warnings.forEach((finding) => lines.push(`    ! ${finding.path}: ${finding.rule} - ${finding.message}`));
  }
  lines.push('', `Result: ${errors.length ? 'INVALID' : 'VALID'}${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`);
  return lines.join('\n') + '\n';
}

function parseParamValues(args: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of collectFlagValues(args, {}, '--param', '--set')) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || !raw.slice(0, eq).trim()) throw new MissingFlagValueError('--param KEY=VALUE');
    // An empty parameter value is supported (e.g. explicitly clearing a default).
    values[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return values;
}

function parseRunOptions(ctx: HandlerContext): RunOptions {
  const args = ctx.args;
  const type = flagValue(args, '--type');
  let manifest = flagValue(args, '--manifest') ?? positionalManifest(args);
  if (!manifest && type === 'developer' && existsSync(path.join(ctx.cwd, 'installer/setup.dev.manifest.yaml'))) {
    manifest = 'installer/setup.dev.manifest.yaml';
  }
  if (!manifest && type === 'user' && existsSync(path.join(ctx.cwd, 'installer/setup.user.manifest.yaml'))) {
    manifest = 'installer/setup.user.manifest.yaml';
  }
  return {
    cwd: ctx.cwd,
    frameworkRoot: ctx.frameworkRoot,
    manifestPath: manifest,
    dryRun: hasFlag(args, '--dry-run') || ctx.dryRun,
    platform: flagValue(args, '--platform'),
    distro: flagValue(args, '--distro'),
    paramsFile: flagValue(args, '--params-file'),
    paramValues: parseParamValues(args),
    step: flagValue(args, '--step'),
    skip: new Set((flagValue(args, '--skip') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    type,
    yes: hasFlag(args, '--yes', '--confirm'),
  };
}

function detectPlatform(options: RunOptions): { os: string; distro?: string; arch: string; shell: string } {
  const mappedOs = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  let distro = options.distro;
  if (!distro && mappedOs === 'linux' && existsSync('/etc/os-release')) {
    const match = readFileSync('/etc/os-release', 'utf8').match(/^ID=(.+)$/m);
    distro = match?.[1]?.replace(/^"|"$/g, '');
  }
  return {
    os: options.platform ?? mappedOs,
    distro,
    arch: os.arch() === 'arm64' ? 'arm64' : os.arch(),
    shell: process.env.SHELL ? path.basename(process.env.SHELL) : (mappedOs === 'windows' ? 'native' : 'sh'),
  };
}

function currentSetupOs(): 'linux' | 'macos' | 'windows' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function defaultManifestName(cwd: string): string {
  const packagePath = path.join(cwd, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
      if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
    } catch {
      // Fall back to directory name.
    }
  }
  return path.basename(cwd);
}

function parseGenerateOptions(ctx: HandlerContext): GenerateOptions {
  const type = flagValue(ctx.args, '--type') as GenerateOptions['type'] | undefined;
  if (type && !['user', 'developer', 'ci'].includes(type)) {
    throw new Error(`setup-generate: unsupported --type '${type}'`);
  }
  return {
    cwd: ctx.cwd,
    output: flagValue(ctx.args, '--output') ?? flagValue(ctx.args, '--manifest') ?? positionalManifest(ctx.args),
    name: flagValue(ctx.args, '--name'),
    type: type ?? 'developer',
    platform: flagValue(ctx.args, '--platform') ?? currentSetupOs(),
    force: hasFlag(ctx.args, '--force'),
    json: hasFlag(ctx.args, '--json'),
  };
}

export function generateSetupManifest(options: GenerateOptions): HandlerResult {
  const manifestPath = path.resolve(options.cwd, options.output ?? 'setup.manifest.yaml');
  const manifestDir = path.dirname(manifestPath);
  const scriptRel = 'scripts/setup.sh';
  const scriptPath = path.join(manifestDir, scriptRel);
  const conflicts = [manifestPath, scriptPath].filter((candidate) => existsSync(candidate));
  if (conflicts.length && !options.force) {
    return {
      exitCode: 1,
      message: `setup-generate: refusing to overwrite existing files without --force: ${conflicts.join(', ')}`,
    };
  }

  const manifest = {
    apiVersion: 'setup.aiwg.io/v1',
    kind: 'SetupManifest',
    metadata: {
      name: options.name ?? defaultManifestName(options.cwd),
      description: 'Generated starter manifest; no os configuration required.',
      install_type: options.type ?? 'developer',
    },
    spec: {
      platforms: [
        { os: options.platform ?? currentSetupOs() },
      ],
      steps: [
        {
          id: 'setup',
          type: 'script',
          script: scriptRel,
        },
      ],
      briefing: {
        success: 'Setup completed.',
        next_steps: [
          'Review generated script bodies before running against a real environment.',
        ],
      },
    },
  };

  mkdirSync(path.dirname(scriptPath), { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(scriptPath, [
    '#!/usr/bin/env sh',
    'set -eu',
    `echo "Setup placeholder for ${manifest.metadata.name}"`,
    '',
  ].join('\n'), 'utf8');
  chmodSync(scriptPath, 0o755);
  writeFileSync(manifestPath, stringify(manifest), 'utf8');

  const payload = { manifestPath, scriptPath, manifest };
  if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    process.stdout.write([
      `Generated: ${manifestPath}`,
      `Script:    ${scriptPath}`,
      'Next:      aiwg setup-validate --manifest ' + manifestPath,
      '',
    ].join('\n'));
  }
  return { exitCode: 0 };
}

function platformMatches(target: { os: string; distro?: string; arch: string; shell: string }, candidate: SetupManifest['spec']['platforms'][number]): boolean {
  if (candidate.os !== target.os) return false;
  if (candidate.distros?.length && (!target.distro || !candidate.distros.includes(target.distro))) return false;
  if (candidate.arch?.length && !candidate.arch.includes(target.arch)) return false;
  if (candidate.shell && candidate.shell !== target.shell) return false;
  return true;
}

function stepPlatformMatches(target: string, step: SetupStep): boolean {
  if (!step.platform) return true;
  return Array.isArray(step.platform) ? step.platform.includes(target) : step.platform === target;
}

function loadParamsFile(cwd: string, paramsFile?: string): Record<string, string> {
  if (!paramsFile) return {};
  const full = path.resolve(cwd, paramsFile);
  const parsed = parseYamlFile(full);
  if (parsed.errors.length) throw new Error(`params file is invalid YAML: ${parsed.errors[0].message}`);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new Error('params file must be a YAML object');
  }
  return Object.fromEntries(Object.entries(parsed.value as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

function expandPathValue(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value.replace(/\$HOME\b/g, os.homedir());
}

function resolveParams(manifest: SetupManifest, options: RunOptions): { values: Record<string, string>; missing: string[] } {
  const fileValues = loadParamsFile(options.cwd, options.paramsFile);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const param of manifest.spec.params ?? []) {
    let value = options.paramValues[param.name] ?? fileValues[param.name] ?? process.env[param.name];
    if (value === undefined && !param.interactive_required && param.default !== undefined) value = String(param.default);
    if ((param.required || param.interactive_required) && value === undefined) {
      missing.push(param.name);
      continue;
    }
    if (value !== undefined) {
      if (param.type === 'choice' && param.choices?.length && !param.choices.includes(value)) {
        missing.push(`${param.name} (must be one of: ${param.choices.join(', ')})`);
        continue;
      }
      values[param.name] = param.type === 'path' ? expandPathValue(value) : value;
    }
  }
  return { values, missing };
}

function selectedSteps(manifest: SetupManifest, options: RunOptions): SetupStep[] {
  let steps = manifest.spec.steps;
  if (options.step) steps = steps.filter((step) => step.id === options.step);
  return steps.filter((step) => !options.skip.has(step.id));
}

function planLines(manifest: SetupManifest, manifestPath: string, target: ReturnType<typeof detectPlatform>, params: Record<string, string>, steps: SetupStep[]): string {
  const lines = [
    `[setup:dry-run] Would execute: ${manifestPath}`,
    `  Platform: ${target.os}${target.distro ? `/${target.distro}` : ''}/${target.arch}`,
    `  Install type: ${manifest.metadata.install_type ?? 'user'}`,
    '',
    `  Params (${Object.keys(params).length}):`,
    ...Object.keys(params).sort().map((key) => `    ${key}=${params[key]}`),
    '',
    `  Steps (${steps.length}):`,
  ];
  steps.forEach((step, index) => {
    lines.push(`    ${index + 1}. ${step.id} (${step.type})${step.script ? ` script=${step.script}` : ''}${step.config_id ? ` config_id=${step.config_id}` : ''}${step.manifest ? ` manifest=${step.manifest}` : ''}`);
  });
  return lines.join('\n') + '\n';
}

/**
 * #3062 review item 7: a `null` status already falls through to `code = 1`
 * (not success); this also surfaces the bounded helper's `error`/`signal`
 * diagnostic (e.g. the enriched timeout message naming the bound and
 * override variable) instead of silently dropping it.
 */
function commandResult(result: { status: number | null; error?: Error | null; signal?: NodeJS.Signals | null }): { ok: boolean; status: number } {
  const outcome = exitCodeForSpawnResult(result);
  if (outcome.message) console.error(`[setup] ${outcome.message}`);
  const code = result.status === null ? 1 : result.status;
  return { ok: code === 0 && !result.error && !result.signal, status: code };
}

/**
 * Run one manifest-author-defined shell command (#3062).
 *
 * Without a terminal, a command that tries to prompt must fail fast instead
 * of hanging forever: bounded (long tier, stdin ignored). With a terminal,
 * unchanged — inherited stdio, unbounded, so a human can actually answer a
 * prompt the command issues.
 */
function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; status: number } {
  if (!isInteractive()) {
    const result = boundedSpawnSync(command, [], 'long', {
      cwd, env, shell: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    return commandResult(result);
  }
  // sync-spawn: interactive manifest-shell-command — runs an arbitrary
  // manifest-author-defined shell command with inherited stdio; it may
  // itself prompt (see tools/testing/sync-spawn-allowlist.json). Reached
  // only when isInteractive() is true (#3062) — the no-terminal path above
  // uses the bounded helper instead. Not a candidate for a bounded timeout.
  const result = spawnSync(command, { cwd, env, shell: true, stdio: 'inherit' });
  return commandResult(result);
}

function isDestructiveScript(filePath: string): boolean {
  const name = path.basename(filePath);
  if (/reset/i.test(name)) return true;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const text = readFileSync(filePath, 'utf8');
  return /\brm\s+-rf\b|\b(cp|mv)\s+-f\b|>\s*\S+/.test(text);
}

/**
 * Param names a `type: ask` step resolves (#3062 review item 10). Reuses
 * the same `params` field `type: script` steps already use to pass env
 * vars — there is no separate "ask step input" field in the schema, and
 * this is the same mechanism, just read by the `ask` branch below instead
 * of passed to a script.
 */
function askStepParams(step: SetupStep): string[] {
  return step.params ?? [];
}

/** Which of an `ask` step's declared params are not yet resolved (missing from `--param`/params-file/env/default). */
function missingAskParams(step: SetupStep, params: Record<string, string>): string[] {
  return askStepParams(step).filter((name) => params[name] === undefined);
}

/**
 * Preflight every step in `steps` (recursively into `platform-route` nested
 * steps only) for conditions that would block it from running at all, and
 * return one message per blocker — never a partial list halted at the
 * first step (#3062 review item 13, and the second review's finding 7:
 * refusal must happen before ANY step executes).
 *
 * Used for two distinct call sites, both passing only the steps that are
 * actually about to run:
 *
 *   1. The main selected sequence, up front, before any of it runs
 *      (`runSetupManifest()`'s own preflight call, below).
 *   2. A *specific* recovery procedure's own steps, called again at the
 *      moment a failed step selects it — completely, before that
 *      recovery's first step runs (go/no-go review blocker 3).
 *
 * This function never itself follows a step's `on_fail` into another
 * recovery procedure, in either case — go/no-go review blocker 3's
 * "preflight is too eager" finding: the previous version always recursed
 * into every selected step's `on_fail` recovery during the main, up-front
 * preflight, which (a) refused a manifest whose main sequence would
 * succeed outright, solely because its *unused* recovery contained an
 * unsupported step, and (b) had no cycle protection, so a recovery whose
 * own steps' `on_fail` pointed back into a recovery already being
 * preflighted recursed without bound (`RangeError: Maximum call stack
 * size exceeded`, reproduced by the review). Not recursing into `on_fail`
 * here also matches what execution itself does: a failing step triggers
 * its *one* named recovery exactly once; a failing step *within* that
 * recovery reports failure directly rather than following a further
 * `on_fail` — so preflight never needs to follow one either. (A
 * recovery-to-recovery `on_fail` reference cycle in the manifest itself is
 * still caught — as a graph check over `manifest.spec.recovery[]`, not a
 * recursive preflight — by `detectRecoveryReferenceCycles()` during
 * manifest validation.)
 *
 *   - `interactive: true` without a terminal AND without every declared
 *     `params` entry resolved: with every declared param supplied, the
 *     step runs headless instead (review item 10; second review finding
 *     5b — the step itself is trusted not to need to prompt once its
 *     declared inputs are present). With no declared params at all
 *     ("undeclared interaction" — the step's questions cannot be
 *     enumerated or supplied via `--param`) this always requires a
 *     terminal.
 *   - `type: ask` with no declared `params`: always refused — unlike
 *     `interactive: true`, this CLI itself owns the prompting for `ask`
 *     steps (there is no separate script to hand a terminal to), and
 *     with nothing declared there is no destination to store an answer
 *     in. This is one of the two agreed, permanent exceptions (the other
 *     is the contributor sync-upstream strategy choice).
 *   - `type: ask` with declared params not all resolved, and no
 *     terminal: refused, naming the missing names so `--param` can
 *     supply them. With a terminal, this is *not* a blocker — the
 *     missing ones are prompted for when the step actually runs (second
 *     review finding 5b).
 *   - `type: agentic`/`type: chain`: `runStep()` refuses both
 *     unconditionally; preflighted the same way so an earlier, unrelated
 *     step is never executed ahead of this unconditional refusal (second
 *     review finding 7).
 */
function collectPreflightBlockers(
  steps: SetupStep[],
  manifest: SetupManifest,
  targetOs: string,
  params: Record<string, string>,
  terminalPresent: boolean,
): string[] {
  const blockers: string[] = [];
  for (const step of steps) {
    if (!stepPlatformMatches(targetOs, step)) continue;

    if (step.interactive) {
      const names = askStepParams(step);
      const missing = missingAskParams(step, params);
      const fullySupplied = names.length > 0 && missing.length === 0;
      if (!fullySupplied && !terminalPresent) {
        blockers.push(
          names.length === 0
            ? `step '${step.id}' is marked interactive (its prompts cannot be enumerated or supplied via --param) and requires a terminal`
            : `step '${step.id}' is marked interactive and is missing required param(s): ${missing.join(', ')} (supply with --param <name>=<value>, or run with a terminal attached)`,
        );
      }
    }

    if (step.type === 'ask') {
      const names = askStepParams(step);
      if (names.length === 0) {
        blockers.push(
          `ask step '${step.id}' declares no params to resolve via --param; interactive capture for ask ` +
          "steps is not implemented — declare 'params' on the step and supply them with --param <name>=<value>",
        );
      } else {
        const missing = missingAskParams(step, params);
        if (missing.length > 0 && !terminalPresent) {
          blockers.push(
            `ask step '${step.id}' is missing required param(s): ${missing.join(', ')} (supply with --param ` +
            '<name>=<value>, or run with a terminal attached to be prompted for them)',
          );
        }
      }
    }

    if (step.type === 'agentic' || step.type === 'chain') {
      blockers.push(
        `${step.type} step '${step.id}' is not supported by deterministic CLI execution and is always refused`,
      );
    }

    if (step.type === 'platform-route') {
      const route = step.routes?.find((item) => item.platform === targetOs);
      if (route) blockers.push(...collectPreflightBlockers(route.steps, manifest, targetOs, params, terminalPresent));
    }
  }
  return blockers;
}

/**
 * Preflight a *specific* recovery procedure's own steps — go/no-go review
 * blocker 3. Called at the moment a failed step selects it, completely,
 * before any of its steps run. Returns `undefined` when the recovery id
 * does not resolve to a known procedure (the schema/consistency check
 * already reports that as a manifest error; this function's caller treats
 * an unresolved id as "no recovery available", same as before).
 */
function findRecoveryProcedure(manifest: SetupManifest, recoveryId: string): { id: string; steps: SetupStep[] } | undefined {
  return manifest.spec.recovery?.find((item) => item.id === recoveryId);
}

/**
 * Prompt interactively for each of `missingNames`, one per declared `ask`-
 * step param still unresolved (#3062 second review, finding 5b: declared
 * ask inputs missing AT a terminal are prompted for, not refused — this
 * is reachable only when `isInteractive()` is true, so it is always safe
 * to open a prompt interface here).
 */
async function promptForAskStep(step: SetupStep, missingNames: string[]): Promise<Record<string, string>> {
  const rl = createPromptInterface();
  const answers: Record<string, string> = {};
  try {
    if (step.message) console.log(`[setup] ${step.message}`);
    for (const name of missingNames) {
      const answer = await askString(rl, `  ${name}: `, '', undefined);
      if (answer) answers[name] = answer;
    }
  } finally {
    rl.close();
  }
  return answers;
}

async function runStep(step: SetupStep, manifest: SetupManifest, manifestDir: string, params: Record<string, string>, targetOs: string, confirmed: boolean, recovery = false): Promise<{ ok: boolean; status: number; failedStep?: string }> {
  if (!stepPlatformMatches(targetOs, step)) return { ok: true, status: 0 };
  // A step marked `interactive: true` (#3062) declares that it prompts
  // directly. For a top-level selected step this condition is already
  // preflighted before any step runs (review item 13; second review
  // finding 7); this remains the only gate for a recovery step, which
  // isn't known until a step actually fails. With every declared `params`
  // entry resolved, the step is trusted not to need to prompt and runs
  // headless below like any other step (second review finding 5b — the
  // bug this fixes: it used to be refused here even when fully supplied).
  // With no declared params at all ("undeclared interaction") or some
  // still missing, a terminal is required.
  if (step.interactive) {
    const names = askStepParams(step);
    const missing = missingAskParams(step, params);
    const fullySupplied = names.length > 0 && missing.length === 0;
    if (!fullySupplied && !isInteractive()) {
      console.error(
        names.length === 0
          ? `setup-run: step '${step.id}' is marked interactive (its prompts cannot be enumerated or supplied ` +
            'via --param) and requires a terminal; re-run from an interactive shell.'
          : `setup-run: step '${step.id}' is marked interactive and is missing required param(s): ` +
            `${missing.join(', ')}; supply with --param <name>=<value>, or re-run from an interactive shell.`,
      );
      return { ok: false, status: 2, failedStep: step.id };
    }
  }
  const env = { ...process.env, ...params };
  console.log(`[setup] Step ${step.id} (${step.type})`);
  if (step.type === 'script') {
    const scriptPath = path.resolve(manifestDir, step.script!);
    console.log(`  script: ${scriptPath}`);
    console.log(`  env: ${Object.keys(params).sort().join(', ') || '(none)'}`);
    if (step.verify) console.log(`  verify: ${Array.isArray(step.verify) ? step.verify.join(' && ') : step.verify}`);
    if ((recovery || isDestructiveScript(scriptPath)) && !confirmed) {
      console.error(`setup-run: refusing destructive step '${step.id}' without --yes/--confirm`);
      return { ok: false, status: 2, failedStep: step.id };
    }
    // Without a terminal, a script that tries to prompt must fail fast
    // instead of hanging forever: bounded (long tier, stdin ignored). With
    // a terminal, unchanged (#3062).
    const result = isInteractive()
      // sync-spawn: interactive manifest-script-step — runs an arbitrary
      // manifest-author-defined script file with inherited stdio; it may
      // itself prompt (see tools/testing/sync-spawn-allowlist.json). Reached
      // only when isInteractive() is true (#3062) — the no-terminal path
      // uses the bounded helper instead. Not a candidate for a bounded
      // timeout.
      ? spawnSync(scriptPath, [], { cwd: manifestDir, env, stdio: 'inherit' })
      : boundedSpawnSync(scriptPath, [], 'long', { cwd: manifestDir, env, stdio: ['ignore', 'inherit', 'inherit'] });
    const ran = commandResult(result);
    if (!ran.ok) return { ...ran, failedStep: step.id };
    const verifies = Array.isArray(step.verify) ? step.verify : step.verify ? [step.verify] : [];
    for (const verify of verifies) {
      const verified = runShell(verify, manifestDir, env);
      if (!verified.ok) return { ...verified, failedStep: step.id };
    }
    return ran;
  }
  if (step.type === 'verify' || step.type === 'detect') {
    const commands = step.commands ?? (Array.isArray(step.verify) ? step.verify : step.verify ? [step.verify] : []);
    for (const command of commands) {
      console.log(`  command: ${command}`);
      const result = runShell(command, manifestDir, env);
      if (!result.ok) return { ...result, failedStep: step.id };
    }
    return { ok: true, status: 0 };
  }
  if (step.type === 'os-config') {
    const entry = manifest.spec.os_config?.find((item) => item.id === step.config_id)!;
    console.log(`  os_config: ${entry.id} - ${entry.description}`);
    const check = runShell(entry.check, manifestDir, env);
    if (check.ok) return { ok: true, status: 0 };
    if (!confirmed) {
      console.error(`setup-run: refusing OS configuration '${entry.id}' without --yes/--confirm`);
      return { ok: false, status: 2, failedStep: step.id };
    }
    return runShell(entry.apply, manifestDir, env);
  }
  if (step.type === 'agentic') {
    console.error(`setup-run: agentic step '${step.id}' requires manual installer-agent handling; aborting deterministic CLI execution`);
    return { ok: false, status: 2, failedStep: step.id };
  }
  if (step.type === 'chain') {
    console.error(`setup-run: chain step '${step.id}' validated manifest existence but deterministic nested execution is not supported yet`);
    return { ok: false, status: 2, failedStep: step.id };
  }
  if (step.type === 'ask') {
    // #3062 review item 10: a top-level selected step with all its declared
    // params already resolved is already caught as *not* blocking by
    // `collectPreflightBlockers` and runs headless here; this remains the
    // gate for a recovery-path `ask` step, which isn't preflighted.
    const names = askStepParams(step);
    if (names.length === 0) {
      // Agreed, permanent exception (second review finding 5b): this CLI
      // owns the prompting for `ask` steps directly (there is no separate
      // script to hand a terminal to), and with nothing declared there is
      // no destination to store an answer in — always refused, with or
      // without a terminal.
      console.error(
        `setup-run: ask step '${step.id}' declares no params to resolve via --param; interactive capture ` +
        "for ask steps is not implemented — declare 'params' on the step and supply them with --param " +
        '<name>=<value>.',
      );
      return { ok: false, status: 2, failedStep: step.id };
    }
    const missing = missingAskParams(step, params);
    if (missing.length === 0) {
      console.log(`  ask: ${step.message ?? step.id} -> answered via --param (${names.join(', ')})`);
      return { ok: true, status: 0 };
    }
    if (!isInteractive()) {
      console.error(
        `setup-run: ask step '${step.id}' is missing required param(s): ${missing.join(', ')}; supply with ` +
        '--param <name>=<value>, or re-run from an interactive shell to be prompted for them.',
      );
      return { ok: false, status: 2, failedStep: step.id };
    }
    // #3062 second review, finding 5b: declared ask inputs missing AT a
    // terminal are prompted for, not refused.
    const answers = await promptForAskStep(step, missing);
    const stillMissing = missing.filter((name) => !answers[name]);
    if (stillMissing.length > 0) {
      console.error(`setup-run: ask step '${step.id}' did not receive a value for: ${stillMissing.join(', ')}.`);
      return { ok: false, status: 2, failedStep: step.id };
    }
    // Merged into the same object reference the caller's loop (and every
    // later step) reads from, so a later step sees the interactively-
    // captured answer exactly like a `--param`-supplied one.
    Object.assign(params, answers);
    console.log(`  ask: ${step.message ?? step.id} -> answered interactively (${missing.join(', ')})`);
    return { ok: true, status: 0 };
  }
  if (step.type === 'platform-route') {
    const route = step.routes?.find((item) => item.platform === targetOs);
    for (const nested of route?.steps ?? []) {
      const result = await runStep(nested, manifest, manifestDir, params, targetOs, confirmed);
      if (!result.ok) return result;
    }
    return { ok: true, status: 0 };
  }
  return { ok: true, status: 0 };
}

export async function runSetupManifest(options: RunOptions): Promise<HandlerResult> {
  const validation = validateSetupManifest({
    cwd: options.cwd,
    frameworkRoot: options.frameworkRoot,
    manifestPath: options.manifestPath,
  });
  const errors = validation.findings.filter((finding) => finding.severity === 'error');
  if (errors.length || !validation.manifest) {
    process.stdout.write(renderValidationText(validation));
    return { exitCode: 1, message: 'setup-run: manifest validation failed before execution' };
  }
  const manifest = validation.manifest;
  if (manifest.metadata.execution_mode === 'provider-orchestrated') {
    const expectedDigest = sha256(readFileSync(validation.manifestPath));
    if (options.artifactVerification?.status !== 'verified'
      || options.artifactVerification.artifact.sha256 !== expectedDigest) {
      return {
        exitCode: 29,
        message: 'setup-run: provider-orchestrated handoff blocked; verify these exact manifest bytes with an explicit trust root and adjacent attestation first',
      };
    }
    return {
      exitCode: 2,
      message: `setup-run: verified provider-orchestrated manifest (${options.artifactVerification.artifact.sha256}); give these exact contents to a supported AI provider instead of executing them as a deterministic CLI manifest`,
    };
  }
  const target = detectPlatform(options);
  if (!manifest.spec.platforms.some((candidate) => platformMatches(target, candidate))) {
    return { exitCode: 1, message: `setup-run: platform ${target.os}${target.distro ? `/${target.distro}` : ''}/${target.arch}/${target.shell} is not declared in the manifest` };
  }
  const params = resolveParams(manifest, options);
  const steps = selectedSteps(manifest, options);
  const askSteps: SetupStep[] = [];
  const collectAsks = (selected: SetupStep[]) => {
    for (const step of selected) {
      if (step.type === 'ask') askSteps.push(step);
      if (step.type === 'platform-route') collectAsks(step.routes?.find(route => route.platform === target.os)?.steps ?? []);
    }
  };
  collectAsks(steps);
  const promptable = new Set(isInteractive() ? askSteps.flatMap(askStepParams) : []);
  if (params.missing.some(name => !promptable.has(name))) {
    return { exitCode: 1, message: `setup-run: required params missing before execution: ${params.missing.join(', ')}` };
  }
  if (options.step && steps.length === 0) return { exitCode: 1, message: `setup-run: step '${options.step}' not found` };
  if (options.dryRun) {
    process.stdout.write(planLines(manifest, validation.manifestPath, target, params.values, steps));
    return { exitCode: 0 };
  }
  if (!options.yes) {
    return { exitCode: 2, message: 'setup-run: mutating execution requires --yes or --confirm after reviewing the plan with --dry-run' };
  }
  // #3062 review item 13: preflight every selected step (recursively into
  // `platform-route` nesting) before executing any of them — the previous
  // behavior checked `interactive`/`ask` conditions inside the per-step
  // loop below, so an earlier normal step could already perform work
  // before a later step's refusal fired.
  const blockers = collectPreflightBlockers(steps, manifest, target.os, params.values, isInteractive());
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(`setup-run: ${blocker}.`);
    return {
      exitCode: 2,
      message: `setup-run: refusing before executing any step:\n${blockers.map((b) => `  - ${b}`).join('\n')}`,
    };
  }
  // Resolve required ask inputs before any scripts can consume them.
  for (const step of askSteps) {
    const missing = missingAskParams(step, params.values).filter(name => params.missing.includes(name));
    if (!missing.length) continue;
    Object.assign(params.values, await promptForAskStep(step, missing));
  }
  const checked = resolveParams(manifest, { ...options, paramValues: { ...options.paramValues, ...params.values } });
  if (checked.missing.length) return { exitCode: 1, message: `setup-run: required params missing before execution: ${checked.missing.join(', ')}` };
  Object.assign(params.values, checked.values);
  for (const step of steps) {
    const result = await runStep(step, manifest, validation.manifestDir, params.values, target.os, options.yes);
    if (!result.ok) {
      if (result.failedStep && step.on_fail) {
        const recovery = findRecoveryProcedure(manifest, step.on_fail);
        if (recovery) {
          // Go/no-go review blocker 3: preflight the *selected* recovery's
          // own steps completely, now that a failure has actually chosen
          // it — not when the manifest was first loaded (that preflighted
          // the main sequence only, above) — and before any of its steps
          // run. Refuses with zero recovery steps executed, same
          // all-blockers-at-once shape as the main-sequence preflight.
          const recoveryBlockers = collectPreflightBlockers(recovery.steps, manifest, target.os, params.values, isInteractive());
          if (recoveryBlockers.length > 0) {
            for (const blocker of recoveryBlockers) console.error(`setup-run: [recovery '${recovery.id}'] ${blocker}.`);
            return {
              exitCode: 2,
              message: `setup-run: recovery '${recovery.id}' (for failed step '${result.failedStep}') refusing before executing any recovery step:\n${recoveryBlockers.map((b) => `  - ${b}`).join('\n')}`,
            };
          }
          console.error(`[setup] recovery '${recovery.id}' available for failed step '${result.failedStep}'`);
          for (const recoveryStep of recovery.steps) {
            const recoveryResult = await runStep(recoveryStep, manifest, validation.manifestDir, params.values, target.os, options.yes, true);
            if (!recoveryResult.ok) return { exitCode: recoveryResult.status || 1, message: `setup-run: recovery '${recovery.id}' failed` };
          }
        }
      }
      return { exitCode: result.status || 1, message: `setup-run: step '${result.failedStep ?? step.id}' failed` };
    }
  }
  console.log('[setup] Installation complete');
  if (manifest.spec.briefing?.success) console.log(manifest.spec.briefing.success);
  for (const next of manifest.spec.briefing?.next_steps ?? []) console.log(`  - ${next}`);
  return { exitCode: 0 };
}

export const setupValidateHandler: CommandHandler = {
  id: 'setup-validate',
  name: 'Setup Manifest Validate',
  description: 'Validate setup.aiwg.io/v1 manifests against the canonical schema and consistency checks',
  category: 'project',
  aliases: [],
  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (hasFlag(ctx.args, '--help', '-h')) {
      process.stdout.write(VALIDATE_HELP);
      return { exitCode: 0 };
    }
    const strict = hasFlag(ctx.args, '--strict');
    let manifestPath: string | undefined;
    let schemaPath: string | undefined;
    try {
      manifestPath = flagValue(ctx.args, '--manifest') ?? positionalManifest(ctx.args);
      schemaPath = flagValue(ctx.args, '--schema');
    } catch (err) {
      if (err instanceof MissingFlagValueError) return { exitCode: 2, message: `${err.message}.` };
      throw err;
    }
    const result = validateSetupManifest({
      cwd: ctx.cwd,
      frameworkRoot: ctx.frameworkRoot,
      manifestPath,
      schemaPath,
      strict,
    });
    const payload = {
      valid: !result.findings.some((finding) => finding.severity === 'error'),
      manifestPath: result.manifestPath,
      schemaPath: result.schemaPath,
      findings: result.findings,
    };
    if (hasFlag(ctx.args, '--json')) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else process.stdout.write(renderValidationText(result));
    return { exitCode: payload.valid ? 0 : 1 };
  },
};

export const setupGenerateHandler: CommandHandler = {
  id: 'setup-generate',
  name: 'Setup Manifest Generate',
  description: 'Generate starter setup.aiwg.io/v1 manifests for agentic installer automation',
  category: 'project',
  aliases: [],
  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (hasFlag(ctx.args, '--help', '-h')) {
      process.stdout.write(GENERATE_HELP);
      return { exitCode: 0 };
    }
    try {
      return generateSetupManifest(parseGenerateOptions(ctx));
    } catch (error) {
      return {
        // #3062 review item 11: a missing flag value is a usage error.
        exitCode: error instanceof MissingFlagValueError ? 2 : 1,
        message: error instanceof Error ? `${error.message}.` : String(error),
      };
    }
  },
};

export const setupRunHandler: CommandHandler = {
  id: 'setup-run',
  name: 'Setup Manifest Run',
  description: 'Validate and execute setup.aiwg.io/v1 manifests with installer safety gates',
  category: 'project',
  aliases: [],
  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (hasFlag(ctx.args, '--help', '-h')) {
      process.stdout.write(RUN_HELP);
      return { exitCode: 0 };
    }
    let options: RunOptions;
    let policyFlag: string | undefined;
    let verificationArgs: string[] = [];
    try {
      options = parseRunOptions(ctx);
      policyFlag = flagValue(ctx.args, '--policy');
      if (policyFlag) {
        const manifestPathForVerification = options.manifestPath ?? 'setup.manifest.yaml';
        verificationArgs = [
          manifestPathForVerification,
          '--attestation', flagValue(ctx.args, '--attestation') ?? `${manifestPathForVerification}.aiwg-attestation.json`,
          '--policy', policyFlag,
          '--asset-type', flagValue(ctx.args, '--asset-type') ?? 'setup-manifest',
          '--namespace', flagValue(ctx.args, '--namespace') ?? 'aiwg',
          '--channel', flagValue(ctx.args, '--channel') ?? 'stable',
          '--json',
          ...(flagValue(ctx.args, '--state') ? ['--state', flagValue(ctx.args, '--state')!] : []),
          ...(hasFlag(ctx.args, '--offline') ? ['--offline'] : []),
        ];
      }
    } catch (err) {
      if (err instanceof MissingFlagValueError) return { exitCode: 2, message: `setup-run: ${err.message}.` };
      throw err;
    }
    let artifactVerification: ArtifactVerificationResult | undefined;
    if (policyFlag) {
      const verification = await artifactVerifyHandler.execute({ ...ctx, args: verificationArgs, rawArgs: verificationArgs });
      try {
        artifactVerification = JSON.parse(verification.message ?? '') as ArtifactVerificationResult;
      } catch {
        return { exitCode: verification.exitCode || 27, message: `setup-run: artifact verification failed: ${verification.message ?? 'invalid verifier output'}` };
      }
      if (artifactVerification.status !== 'verified') {
        return { exitCode: artifactVerification.exitCode, message: `setup-run: provider handoff blocked by artifact verification status '${artifactVerification.status}'` };
      }
    }
    return runSetupManifest({ ...options, artifactVerification });
  },
};
