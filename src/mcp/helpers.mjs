/**
 * AIWG MCP Server — Shared Helpers
 *
 * @architecture @.aiwg/architecture/sketch-hermes-mcp-parity.md
 * @issues #1311 (scope split), #1312 (command-run), #1313 (discover + pairs)
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve AIWG_ROOT, with safe fallback to known install locations.
 */
export const AIWG_ROOT = process.env.AIWG_ROOT ||
  path.join(process.env.HOME || '', '.local/share/ai-writing-guide');

const PROJECT_AIWG_LOCATION_FILE = '.aiwg-location';
const ARTIFACT_PATH_ENV_ALIASES = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
];

function expandProjectArtifactPath(pathValue, projectDir) {
  const trimmed = pathValue.trim();
  if (trimmed === '~') return process.env.HOME || trimmed;
  if (trimmed.startsWith('~/')) return path.resolve(process.env.HOME || '', trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(projectDir, trimmed);
}

function parseProjectArtifactLocation(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const assignment = line.match(/^AIWG_ARTIFACTS_PATH\s*=\s*(.+)$/);
    if (assignment) line = assignment[1].trim();
    if (
      (line.startsWith('"') && line.endsWith('"')) ||
      (line.startsWith("'") && line.endsWith("'"))
    ) {
      line = line.slice(1, -1);
    }
    return line || null;
  }
  return null;
}

export async function resolveProjectAiwgDir(projectDir) {
  for (const key of ARTIFACT_PATH_ENV_ALIASES) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) return expandProjectArtifactPath(value, projectDir);
  }
  try {
    const pointer = await fs.readFile(path.join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'utf-8');
    const configured = parseProjectArtifactLocation(pointer);
    if (configured) return expandProjectArtifactPath(configured, projectDir);
  } catch {
    // no pointer
  }
  return path.resolve(projectDir, '.aiwg');
}

/**
 * Walk up the directory tree looking for `.aiwg/` or `.aiwg-location`.
 *
 * @param {string} startDir
 * @returns {Promise<string>}
 * @throws {Error} when no .aiwg directory or .aiwg-location pointer is found
 */
export async function findProjectRoot(startDir = process.cwd()) {
  let currentDir = startDir;
  while (true) {
    const aiwgPath = path.join(currentDir, '.aiwg');
    const pointerPath = path.join(currentDir, PROJECT_AIWG_LOCATION_FILE);
    try {
      const stat = await fs.stat(aiwgPath);
      if (stat.isDirectory()) return currentDir;
    } catch {
      // continue to pointer check
    }
    try {
      const stat = await fs.stat(pointerPath);
      if (stat.isFile()) return currentDir;
    } catch {
      // continue up
    }
    // Inspect the root candidate too, then stop instead of revisiting it.
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  throw new Error('No .aiwg directory or .aiwg-location pointer found. Run from an AIWG project or `aiwg new` first.');
}

/**
 * Resolve project root with optional global fallback (#1311).
 *
 * Tools that operate on global registries (discover, *-show against the
 * canonical corpus) accept a missing project root and fall back to AIWG_ROOT.
 * Tools that operate on `.aiwg/` artifacts (artifact-read, memory-*) reject
 * with a structured remediation message.
 *
 * @param {string|undefined} explicitDir
 * @param {{ allowGlobal?: boolean, toolName?: string }} [options]
 * @returns {Promise<{ root: string, isGlobal: boolean }>}
 */
export async function resolveProjectRoot(explicitDir, { allowGlobal = false, toolName = 'tool' } = {}) {
  if (explicitDir && explicitDir !== '.') {
    return { root: path.resolve(explicitDir), isGlobal: false };
  }
  try {
    const root = await findProjectRoot();
    return { root, isGlobal: false };
  } catch (err) {
    if (allowGlobal) {
      return { root: AIWG_ROOT, isGlobal: true };
    }
    throw new Error(
      `Tool "${toolName}" requires a project root. ${err.message} ` +
      `Remediation: Run from an AIWG project directory or pass project_dir explicitly.`
    );
  }
}

/**
 * The set of MCP tools that are allowed to operate without a project root
 * (they fall back to AIWG_ROOT). Maintained here so tool registrations
 * stay in sync (#1311).
 */
export const GLOBAL_ALLOWED_TOOLS = new Set([
  'discover',
  'skill-list',
  'skill-show',
  'command-list',
  'command-show',
  'rule-list',
  'rule-show',
  'agent-list',  // existing; canonical corpus enumeration
  'agent-show',
  'template-list',
  'template-show',
  'template-render',  // existing; uses corpus templates
]);

export function isGlobalAllowed(toolName) {
  return GLOBAL_ALLOWED_TOOLS.has(toolName);
}

/**
 * Spawn the `aiwg` CLI as a subprocess with safe argv handling (#1312).
 *
 * NEVER use `shell: true` — args must pass as an array so user-provided
 * strings are never interpreted as shell metacharacters. Token security
 * (RULES: token-security) — command path is logged, args content is not.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: object, timeoutMs?: number, input?: string }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runAiwgCli(args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('aiwg', args, {
      shell: false,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let killTimer;
    const rejectAndTerminate = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Settlement must not depend on a cooperative close event. Give the
      // owned child one second to exit gracefully, then escalate cleanup.
      reject(err);
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* child may already have exited */ }
      }, 1000);
      killTimer.unref?.();
      // Install cleanup first: kill() can synchronously trigger close in an adapter.
      try { proc.kill('SIGTERM'); } catch { /* retain the original failure */ }
    };
    const timer = setTimeout(() => {
      rejectAndTerminate(new Error(`aiwg ${args[0] || ''} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += stdoutDecoder.write(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += stderrDecoder.write(chunk); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      // A late error must not cancel cleanup of a failed, still-live child.
      if (settled) return;
      settled = true;
      reject(err);
    });

    // Pipe errors are emitted on stdin, not on the ChildProcess. Register
    // before writing so synchronous adapter events and late EPIPE are handled.
    proc.stdin.on('error', rejectAndTerminate);
    try {
      if (input !== undefined) proc.stdin.write(input);
      if (!settled) proc.stdin.end();
    } catch (err) {
      rejectAndTerminate(err);
    }
  });
}

/**
 * Structured MCP error response.
 */
export function mcpError(message, { remediation, requiresConfirmation } = {}) {
  const body = { error: message };
  if (remediation) body.remediation = remediation;
  if (requiresConfirmation) body.requires_confirmation = true;
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/**
 * Structured MCP success response wrapping a JSON or text payload.
 */
export function mcpJson(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * Read AIWG CLI command registry to build the command-run allow-list.
 *
 * Lazily loaded from `src/extensions/commands/definitions.ts` — extracts
 * `id:` fields. Cached after first read.
 */
let _commandIds = null;
export async function loadCommandAllowList() {
  if (_commandIds) return _commandIds;
  const defPath = path.join(AIWG_ROOT, 'src/extensions/commands/definitions.ts');
  // Fall back to source-checkout location if AIWG_ROOT points to the project itself
  const candidates = [
    defPath,
    path.resolve(process.cwd(), 'src/extensions/commands/definitions.ts'),
  ];
  let text = '';
  for (const c of candidates) {
    try {
      text = await fs.readFile(c, 'utf-8');
      break;
    } catch {
      // try next
    }
  }
  if (!text) {
    // Installed packages need not contain TypeScript sources. Ask the CLI for
    // its versioned canonical registry; human help is incomplete and contains examples.
    try {
      const { stdout, code } = await runAiwgCli(['help', '--json'], { timeoutMs: 30_000 });
      if (code !== 0) throw new Error('Command registry subprocess failed');
      const registry = JSON.parse(stdout);
      const ids = registry?.commandIds;
      if (registry?.schema !== 'aiwg.command-registry.v1'
        || !Array.isArray(ids) || ids.length === 0
        || ids.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id))
        || new Set(ids).size !== ids.length) {
        throw new Error('Invalid command registry response');
      }
      _commandIds = new Set(ids);
      return _commandIds;
    } catch (e) {
      _commandIds = new Set();
      return _commandIds;
    }
  }
  const ids = new Set();
  for (const m of text.matchAll(/^  id: '([^']+)'/gm)) {
    ids.add(m[1]);
  }
  _commandIds = ids;
  return _commandIds;
}

/**
 * Commands that mutate fleet/project state and require explicit `confirmed: true`
 * before `command-run` will execute them. Defensive default.
 */
export const DESTRUCTIVE_COMMANDS = new Set([
  'remove',
  'rollback-workspace',
  'promote',
  'uninstall-plugin',
  'cleanup-audit',
  'doc-sync',
  'sandbox',  // local executor sandbox
  'ralph',    // long-running loop
  'agent-loop-ext',
  'ralph-abort',
]);

export function isDestructive(command) {
  return DESTRUCTIVE_COMMANDS.has(command);
}
