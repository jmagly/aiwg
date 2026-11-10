import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, open, realpath, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveGrokHomeResult } from '../providers/grok-build-paths.js';
import { SessionContractError } from './contracts.js';
import { validateGrokHeadlessEnvelope, parseGrokSessionIds } from './grok-build-cli-output.js';
import { validateGrokBuildMarkdown } from './adapters/grok-build.js';

const execFile = promisify(execFileCallback);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OUTPUT = 2_000_000;
const TIMEOUT_MS = 15_000;

export interface GrokBuildCliOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  binary?: string;
  runner?: (binary: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number;
  }) => Promise<{ stdout: string; stderr: string }>;
}

export async function grokBuildList(options: GrokBuildCliOptions, limit = 20): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new SessionContractError('INVALID_ARGUMENT', 'Grok Build list limit must be 1..500');
  }
  const stdout = await runGrok(options, ['sessions', 'list', '--limit', String(limit)]);
  return parseGrokSessionIds(stdout, 'list');
}

export async function grokBuildSearch(options: GrokBuildCliOptions, query: string, limit = 20): Promise<string[]> {
  if (!query.trim() || query.length > 500 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new SessionContractError('INVALID_SEARCH_QUERY', 'Grok Build search query must be nonempty plain text under 500 characters');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new SessionContractError('INVALID_ARGUMENT', 'Grok Build search limit must be 1..500');
  }
  const stdout = await runGrok(options, ['sessions', 'search', query, '--limit', String(limit)]);
  return parseGrokSessionIds(stdout, 'search');
}

export async function grokBuildExport(
  options: GrokBuildCliOptions,
  sessionId: string,
  outputDirectory: string,
): Promise<string> {
  const id = assertGrokSessionId(sessionId);
  const directory = await safeDirectory(outputDirectory);
  const stdout = await runGrok(options, ['export', id]);
  if (Buffer.byteLength(stdout) > MAX_OUTPUT) {
    throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build export is not a bounded documented Markdown transcript');
  }
  validateGrokBuildMarkdown(stdout);
  const destination = join(directory, `${id}.md`);
  try {
    await writeFile(destination, stdout.endsWith('\n') ? stdout : `${stdout}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SessionContractError('IMPORT_CONFLICT', 'Grok Build export already exists; select a new output directory');
    }
    throw error;
  }
  return destination;
}

export function assertGrokSessionId(value: string): string {
  if (!UUID.test(value)) {
    throw new SessionContractError('INVALID_ARGUMENT', 'Grok Build session ID must be a UUID');
  }
  return value.toLowerCase();
}

export function parseGrokHeadlessSessionId(output: string, format: 'json' | 'streaming-json'): string {
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Grok Build headless output exceeds 2 MB');
  }
  const lines = format === 'json' ? [output] : output.trim().split(/\r?\n/);
  const ids = new Set<string>();
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build headless output is not valid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build headless event must be an object');
    }
    validateGrokHeadlessEnvelope(value as Record<string, unknown>, format);
    const id = (value as Record<string, unknown>).sessionId;
    if (id !== undefined) {
      if (typeof id !== 'string' || !UUID.test(id)) {
        throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build headless event has an invalid sessionId');
      }
      ids.add(id.toLowerCase());
    }
  }
  if (ids.size !== 1) {
    throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build headless output must expose exactly one consistent sessionId');
  }
  return [...ids][0];
}

export async function grokHeadlessSessionIdFromFile(
  input: string,
  format: 'json' | 'streaming-json',
): Promise<string> {
  const path = resolve(input);
  const parent = await safeDirectory(dirname(path));
  if (dirname(path) !== parent) {
    throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', 'Grok Build headless output escapes its authorized directory');
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const item = await handle.stat();
    if (!item.isFile() || item.size > MAX_OUTPUT) {
      throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build headless output must be a bounded regular file');
    }
    return parseGrokHeadlessSessionId(await handle.readFile('utf8'), format);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SessionContractError('SOURCE_SYMLINK', 'Grok Build headless output cannot be a symlink');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function runGrok(options: GrokBuildCliOptions, args: string[]): Promise<string> {
  const cwd = await safeDirectory(options.cwd);
  const env = options.env ?? process.env;
  const home = resolveGrokHomeResult(env);
  if (!home.ok) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', home.message);
  await rejectSymlinkComponents(home.path);
  if (options.binary !== undefined && !isAbsolute(options.binary)) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build binary override must be absolute');
  }
  const binary = options.binary ?? await defaultGrokBinary(env, home.path);
  const runner = options.runner ?? execFile;
  try {
    const result = await runner(binary, ['--no-auto-update', ...args], {
      cwd, env: { ...env, GROK_HOME: home.path, NO_COLOR: '1' },
      timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    });
    if (Buffer.byteLength(result.stdout) > MAX_OUTPUT) {
      throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Grok Build CLI output exceeds 2 MB');
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof SessionContractError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Grok Build CLI output exceeds 2 MB');
    }
    throw grokFailure(error as GrokProcessError, binary);
  }
}

interface GrokProcessError {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/**
 * Map a failed `grok` launch to an actionable error (#2968). stderr is never
 * echoed: Grok Build diagnostics can carry session content.
 */
function grokFailure(error: GrokProcessError, binary: string): SessionContractError {
  const name = binary === 'grok' ? '`grok`' : `\`${binary}\``;
  if (error.code === 'ENOENT') {
    return new SessionContractError(
      'UNSUPPORTED_OPERATION',
      `Grok Build CLI not found: ${name} is not on PATH and no $GROK_HOME/bin/grok was found; `
        + 'pass --grok-bin <absolute path> or add the Grok Build bin directory to PATH.',
    );
  }
  if (error.code === 'EACCES') {
    return new SessionContractError(
      'UNSUPPORTED_OPERATION',
      `Grok Build CLI ${name} is not executable; check its permissions or pass --grok-bin <absolute path>.`,
    );
  }
  if (error.killed || error.signal) {
    return new SessionContractError(
      'UNSUPPORTED_OPERATION',
      `Grok Build CLI ${name} timed out after ${TIMEOUT_MS / 1000}s; check that it is authenticated `
        + 'and does not prompt for input.',
    );
  }
  if (typeof error.code === 'number') {
    return new SessionContractError(
      'UNSUPPORTED_OPERATION',
      `Grok Build CLI ${name} exited with code ${error.code}; run \`grok sessions list\` in the selected `
        + 'workspace to check authentication and installation.',
    );
  }
  return new SessionContractError(
    'UNSUPPORTED_OPERATION',
    'Grok Build CLI failed; check the local `grok` installation, authentication, and selected workspace.',
  );
}

/**
 * Resolve `grok` from PATH, else the installer's `$GROK_HOME/bin/grok` (#2968).
 * The installer links `bin/grok` to a versioned binary beside it, so that one
 * link is followed only when it resolves to a regular file inside `bin`.
 */
async function defaultGrokBinary(env: NodeJS.ProcessEnv, grokHome: string): Promise<string> {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    if (await isExecutableFile(join(directory, 'grok'))) return 'grok';
  }
  const binDirectory = join(grokHome, 'bin');
  try {
    await rejectSymlinkComponents(binDirectory);
    const canonicalBin = await realpath(binDirectory);
    const target = await realpath(join(binDirectory, 'grok'));
    if (dirname(target) !== canonicalBin || !(await isExecutableFile(target))) return 'grok';
    return target;
  } catch (error) {
    if (error instanceof SessionContractError) throw error;
    return 'grok';
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const item = await stat(path);
    if (!item.isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeDirectory(input: string): Promise<string> {
  if (!isAbsolute(input) || parse(resolve(input)).root === resolve(input)) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build directory must be an absolute non-root path');
  }
  await rejectSymlinkComponents(input);
  const canonical = await realpath(input);
  if (!(await lstat(canonical)).isDirectory()) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build directory must exist and be a directory');
  }
  return canonical;
}

async function rejectSymlinkComponents(input: string): Promise<void> {
  let current = resolve(input);
  while (current !== parse(current).root) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SessionContractError('SOURCE_SYMLINK', 'Grok Build path contains a symlink');
      }
    } catch (error) {
      if (error instanceof SessionContractError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = dirname(current);
  }
}
