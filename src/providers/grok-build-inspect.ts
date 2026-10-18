/**
 * Grok Build verification via `grok inspect` when the binary is available.
 * Presence-only remediation when absent — never invents inspect output.
 *
 * @issue #2575
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type GrokInspectExpectedArtifacts = {
  /** Absolute or project-relative paths that should appear in instructions/skills/config. */
  instructionPaths?: string[];
  skillNames?: string[];
  agentNames?: string[];
  /** Substrings that should appear in config layer paths (e.g. `.grok/config.toml`). */
  configPathSubstrings?: string[];
};

export type GrokInspectMismatch = {
  kind: 'instructions' | 'skills' | 'agents' | 'config' | 'shape';
  expected: string;
  detail: string;
};

export type GrokInspectResult =
  | {
      status: 'ok';
      binary: string;
      stdout: string;
      parsed: Record<string, unknown>;
      cwd: string;
      mismatches: GrokInspectMismatch[];
    }
  | {
      status: 'failed';
      binary: string;
      exitCode: number | null;
      stderr: string;
      stdout: string;
      cwd: string;
      mismatches?: GrokInspectMismatch[];
    }
  | {
      status: 'absent';
      remediation: string;
    };

export type RunGrokInspectOptions = {
  env?: NodeJS.ProcessEnv;
  /** Deployment / project directory to inspect (passed as spawn cwd). */
  cwd?: string;
  /** When set, exit-zero JSON must mention these AIWG artifacts. */
  expected?: GrokInspectExpectedArtifacts;
};

export function grokExecutableCandidates(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const pathDirs = (env.PATH ?? env.Path ?? process.env.PATH ?? '')
    .split(pathDelimiter)
    // An empty PATH segment means the child cwd on POSIX and Windows.
    .map((entry) => entry || '.');
  const suffixes = platform === 'win32'
    ? [...(env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean), '']
    : [''];
  const candidates = new Set<string>();
  for (const dir of pathDirs) {
    const absoluteDir = pathApi.isAbsolute(dir) ? dir : pathApi.resolve(cwd, dir);
    for (const suffix of suffixes) candidates.add(pathApi.join(absoluteDir, `grok${suffix}`));
  }
  return [...candidates];
}

function whichGrok(env: NodeJS.ProcessEnv, cwd: string): string | null {
  // Resolve from the supplied environment and deployment cwd without a shell.
  for (const candidate of grokExecutableCandidates(env, cwd)) {
    try {
      accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

function pathMentions(haystack: string, needle: string): boolean {
  const normalizedHay = haystack.replace(/\\/g, '/');
  const normalizedNeedle = needle.replace(/\\/g, '/');
  return normalizedHay.includes(normalizedNeedle);
}

/**
 * Validate a `grok inspect --json` report against artifacts AIWG intended to deploy.
 * Shape follows xAI InspectReport (camelCase): projectInstructions, skills, agents, configSources.
 */
export function validateGrokInspectReport(
  parsed: Record<string, unknown>,
  expected: GrokInspectExpectedArtifacts = {},
): GrokInspectMismatch[] {
  const mismatches: GrokInspectMismatch[] = [];
  const instructions = asRecordArray(parsed.projectInstructions);
  const skills = asRecordArray(parsed.skills);
  const agents = asRecordArray(parsed.agents);
  const configSources = parsed.configSources;
  const layers = configSources && typeof configSources === 'object' && !Array.isArray(configSources)
    ? asRecordArray((configSources as Record<string, unknown>).layers)
    : [];

  const hasReportShape =
    Array.isArray(parsed.projectInstructions)
    || Array.isArray(parsed.skills)
    || Array.isArray(parsed.agents)
    || Boolean(configSources);

  if (!hasReportShape) {
    mismatches.push({
      kind: 'shape',
      expected: 'InspectReport fields (projectInstructions/skills/agents/configSources)',
      detail: `parsed keys: ${Object.keys(parsed).slice(0, 20).join(',') || '(none)'}`,
    });
    return mismatches;
  }

  for (const instructionPath of expected.instructionPaths ?? []) {
    const found = instructions.some((entry) =>
      typeof entry.path === 'string' && pathMentions(entry.path, instructionPath));
    if (!found) {
      mismatches.push({
        kind: 'instructions',
        expected: instructionPath,
        detail: `not listed in projectInstructions (${instructions.length} entries)`,
      });
    }
  }

  for (const skillName of expected.skillNames ?? []) {
    const found = skills.some((entry) =>
      (typeof entry.name === 'string' && entry.name === skillName)
      || (typeof entry.source === 'object' && entry.source !== null
        && typeof (entry.source as Record<string, unknown>).path === 'string'
        && pathMentions(String((entry.source as Record<string, unknown>).path), skillName)));
    if (!found) {
      mismatches.push({
        kind: 'skills',
        expected: skillName,
        detail: `not listed in skills (${skills.length} entries)`,
      });
    }
  }

  for (const agentName of expected.agentNames ?? []) {
    const found = agents.some((entry) => typeof entry.name === 'string' && entry.name === agentName);
    if (!found) {
      mismatches.push({
        kind: 'agents',
        expected: agentName,
        detail: `not listed in agents (${agents.length} entries)`,
      });
    }
  }

  for (const substring of expected.configPathSubstrings ?? []) {
    const found = layers.some((entry) =>
      typeof entry.path === 'string' && pathMentions(entry.path, substring));
    if (!found) {
      mismatches.push({
        kind: 'config',
        expected: substring,
        detail: `not listed in configSources.layers (${layers.length} entries)`,
      });
    }
  }

  return mismatches;
}

const ABSENT_REMEDIATION =
  'Install the Grok Build CLI so `grok` is on PATH, then re-run verification. '
  + 'Until then AIWG only confirms provider registration and on-disk .grok paths — it does not invent inspect output.';

function isRunOptions(value: unknown): value is RunGrokInspectOptions {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value as object);
  if (keys.length === 0) return false;
  return keys.every((key) => key === 'env' || key === 'cwd' || key === 'expected');
}

/**
 * Run `grok inspect` (prefer `--json` when the CLI accepts it).
 * Accepts either a ProcessEnv (legacy) or an options bag with env/cwd/expected.
 */
export function runGrokInspect(
  envOrOptions: NodeJS.ProcessEnv | RunGrokInspectOptions = process.env,
): GrokInspectResult {
  const options: RunGrokInspectOptions = isRunOptions(envOrOptions)
    ? envOrOptions
    : { env: envOrOptions as NodeJS.ProcessEnv };

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const binary = whichGrok(env, cwd);
  if (!binary) {
    return { status: 'absent', remediation: ABSENT_REMEDIATION };
  }

  // Prefer machine-readable inspect; fall back to plain inspect if --json is rejected.
  // Use length/index checks — tuple `includes()` narrows incorrectly under TS (TS2345).
  const argSets: ReadonlyArray<ReadonlyArray<string>> = [
    ['inspect', '--json'],
    ['inspect'],
  ];

  for (let i = 0; i < argSets.length; i++) {
    const args = argSets[i]!;
    const wantsJson = args.length > 1 && args[1] === '--json';
    const result = spawnSync(binary, [...args], {
      encoding: 'utf8',
      env,
      cwd,
      timeout: 15_000,
      maxBuffer: 2_000_000,
      // npm exposes Grok through a .cmd shim on Windows; Node requires a shell
      // for .cmd/.bat launchers. Native .exe installs stay shell-free.
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary),
      killSignal: 'SIGKILL',
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent', remediation: ABSENT_REMEDIATION };
    }
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    if (result.status === 0) {
      const parsed = tryParseJson(stdout);
      if (!parsed) {
        return {
          status: 'failed',
          binary,
          exitCode: 0,
          stderr,
          stdout,
          cwd,
          mismatches: [{
            kind: 'shape',
            expected: 'JSON InspectReport',
            detail: 'exit 0 but stdout was not a JSON object',
          }],
        };
      }
      const mismatches = validateGrokInspectReport(parsed, options.expected);
      if (mismatches.length > 0) {
        return {
          status: 'failed',
          binary,
          exitCode: 0,
          stderr,
          stdout,
          cwd,
          mismatches,
        };
      }
      return {
        status: 'ok',
        binary,
        stdout,
        parsed,
        cwd,
        mismatches: [],
      };
    }
    if (wantsJson && /unknown|unrecognized|invalid/i.test(`${stderr}\n${stdout}`)) {
      continue;
    }
    return {
      status: 'failed',
      binary,
      exitCode: result.status,
      stderr,
      stdout,
      cwd,
    };
  }

  return {
    status: 'failed',
    binary,
    exitCode: null,
    stderr: 'grok inspect did not succeed',
    stdout: '',
    cwd,
  };
}
