import { mkdir, readFile, rename, stat, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getUserStateDir } from '../config/user-state.js';
import type { AiwgConfig, CommandLogConfig } from '../config/aiwg-config.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import {
  PROJECT_AIWG_LOCATION_FILE,
  projectAiwgPath,
  projectControlPath,
} from '../config/project-artifacts.js';

export type CommandLogScope = 'project' | 'global';

export interface CommandLogEvent {
  schema_version: 1;
  timestamp: string;
  invocation_id?: string;
  command: string;
  flags: string[];
  positional_count: number;
  duration_ms: number;
  exit_status: number;
  aiwg_version: string;
  provider?: string;
  project?: {
    root_hash: string;
    relative_path: string;
  };
  cwd_hash: string;
  scope: CommandLogScope;
}

export interface CommandLogAppendInput {
  command: string;
  args: string[];
  cwd: string;
  frameworkRoot: string;
  durationMs: number;
  exitStatus: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandLogReportOptions {
  cwd: string;
  frameworkRoot: string;
  json?: boolean;
  limit?: number;
  scope?: CommandLogScope | 'all';
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_REPORT_LIMIT = 20;

export async function maybeAppendCommandLog(input: CommandLogAppendInput): Promise<void> {
  const env = input.env ?? process.env;
  const resolved = await resolveCommandLogSettings(input.cwd, env);
  if (!resolved.enabled || resolved.scopes.length === 0) return;

  const version = await readAiwgVersion(input.frameworkRoot);
  const context = await resolvePathContext(input.cwd);
  const shape = summarizeArgs(input.args);

  for (const scope of resolved.scopes) {
    const filePath = resolveLogPath(scope, context.projectRoot, env);
    if (!filePath) continue;

    const event: CommandLogEvent = {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      invocation_id: env.AIWG_INVOCATION_ID,
      command: input.command,
      flags: shape.flags,
      positional_count: shape.positionalCount,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      exit_status: input.exitStatus,
      aiwg_version: version,
      provider: env.AIWG_PROVIDER || env.CLAUDE_CODE_ENTRYPOINT || undefined,
      cwd_hash: hashPath(input.cwd),
      scope,
    };

    if (context.projectRoot) {
      event.project = {
        root_hash: hashPath(context.projectRoot),
        relative_path: context.relativePath,
      };
    }

    await appendBoundedJsonl(filePath, event, resolved.maxBytes);
  }
}

export async function readCommandLogReport(options: CommandLogReportOptions): Promise<{
  events: CommandLogEvent[];
  summary: {
    total: number;
    by_command: Record<string, number>;
    failures_by_command: Record<string, number>;
    by_scope: Record<string, number>;
  };
  paths: string[];
}> {
  const env = options.env ?? process.env;
  const context = await resolvePathContext(options.cwd);
  const scope = options.scope ?? 'all';
  const scopes: CommandLogScope[] = scope === 'all' ? ['project', 'global'] : [scope];
  const paths = scopes
    .map(s => resolveLogPath(s, context.projectRoot, env))
    .filter((p): p is string => Boolean(p));

  const events: CommandLogEvent[] = [];
  for (const filePath of paths) {
    events.push(...await readJsonlEvents(filePath));
  }

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = events.slice(0, options.limit ?? DEFAULT_REPORT_LIMIT);
  return {
    events: limited,
    summary: summarizeEvents(events),
    paths,
  };
}

export async function printCommandLogReport(options: CommandLogReportOptions): Promise<void> {
  const report = await readCommandLogReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('AIWG command log');
  console.log(`Events: ${report.summary.total}`);
  if (report.paths.length > 0) {
    console.log(`Stores: ${report.paths.join(', ')}`);
  }

  const commands = Object.entries(report.summary.by_command)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (commands.length > 0) {
    console.log('');
    console.log('Top commands');
    for (const [command, count] of commands) {
      const failures = report.summary.failures_by_command[command] ?? 0;
      const failureText = failures > 0 ? `, ${failures} failed` : '';
      console.log(`  ${command}: ${count}${failureText}`);
    }
  }

  if (report.events.length > 0) {
    console.log('');
    console.log('Recent invocations');
    for (const event of report.events) {
      const status = event.exit_status === 0 ? 'ok' : `exit ${event.exit_status}`;
      const rel = event.project?.relative_path ? ` path=${event.project.relative_path}` : '';
      console.log(`  ${event.timestamp} ${event.scope} ${event.command} ${status} ${event.duration_ms}ms${rel}`);
    }
  }
}

async function resolveCommandLogSettings(cwd: string, env: NodeJS.ProcessEnv): Promise<{
  enabled: boolean;
  scopes: CommandLogScope[];
  maxBytes: number;
}> {
  const envSetting = env.AIWG_COMMAND_LOG?.trim().toLowerCase();
  const envMax = parsePositiveInt(env.AIWG_COMMAND_LOG_MAX_BYTES);
  if (envSetting) {
    const scopes = scopesFromString(envSetting);
    return {
      enabled: scopes.length > 0,
      scopes,
      maxBytes: envMax ?? DEFAULT_MAX_BYTES,
    };
  }

  const config = await readNearestProjectConfig(cwd);
  const commandLog = config?.command_log;
  if (!commandLog?.enabled) {
    return { enabled: false, scopes: [], maxBytes: envMax ?? DEFAULT_MAX_BYTES };
  }

  return {
    enabled: true,
    scopes: normalizeScopes(commandLog.scopes ?? ['project']),
    maxBytes: commandLog.max_bytes ?? envMax ?? DEFAULT_MAX_BYTES,
  };
}

function scopesFromString(value: string): CommandLogScope[] {
  if (['0', 'false', 'off', 'none', 'disabled'].includes(value)) return [];
  if (['1', 'true', 'on', 'project'].includes(value)) return ['project'];
  if (value === 'global') return ['global'];
  if (['both', 'all'].includes(value)) return ['project', 'global'];
  return normalizeScopes(value.split(','));
}

function normalizeScopes(values: readonly string[]): CommandLogScope[] {
  const scopes: CommandLogScope[] = [];
  for (const value of values) {
    if (value === 'project' || value === 'global') scopes.push(value);
  }
  return [...new Set(scopes)];
}

async function readNearestProjectConfig(cwd: string): Promise<AiwgConfig | null> {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) return null;
  return readAiwgConfig(projectRoot);
}

async function resolvePathContext(cwd: string): Promise<{
  projectRoot: string | null;
  relativePath: string;
}> {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) return { projectRoot: null, relativePath: '(no-project)' };
  const rel = path.relative(projectRoot, cwd);
  return {
    projectRoot,
    relativePath: rel === '' ? '.' : normalizeRelativePath(rel),
  };
}

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (current !== path.dirname(current)) {
    if (
      existsSync(path.join(current, '.aiwg')) ||
      existsSync(path.join(current, PROJECT_AIWG_LOCATION_FILE)) ||
      existsSync(projectControlPath(current, 'aiwg.config'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function resolveLogPath(
  scope: CommandLogScope,
  projectRoot: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (scope === 'project') {
    if (!projectRoot) return null;
    return projectAiwgPath(projectRoot, 'telemetry', 'cli-commands.jsonl');
  }

  return path.join(getUserStateDir(env), 'cli-commands.jsonl');
}

async function appendBoundedJsonl(filePath: string, event: CommandLogEvent, maxBytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await rotateIfNeeded(filePath, maxBytes);
  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}

async function rotateIfNeeded(filePath: string, maxBytes: number): Promise<void> {
  if (maxBytes <= 0) return;
  try {
    const current = await stat(filePath);
    if (current.size <= maxBytes) return;
    const rotated = `${filePath}.1`;
    if (existsSync(rotated)) {
      await writeFile(rotated, '', 'utf8');
    }
    await rename(filePath, rotated);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readJsonlEvents(filePath: string): Promise<CommandLogEvent[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as CommandLogEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function summarizeEvents(events: CommandLogEvent[]) {
  const by_command: Record<string, number> = {};
  const failures_by_command: Record<string, number> = {};
  const by_scope: Record<string, number> = {};
  for (const event of events) {
    by_command[event.command] = (by_command[event.command] ?? 0) + 1;
    by_scope[event.scope] = (by_scope[event.scope] ?? 0) + 1;
    if (event.exit_status !== 0) {
      failures_by_command[event.command] = (failures_by_command[event.command] ?? 0) + 1;
    }
  }
  return {
    total: events.length,
    by_command,
    failures_by_command,
    by_scope,
  };
}

function summarizeArgs(args: string[]): { flags: string[]; positionalCount: number } {
  const flags = new Set<string>();
  let positionalCount = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      positionalCount += Math.max(0, args.length - i - 1);
      break;
    }
    if (arg.startsWith('--')) {
      flags.add(arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      flags.add(arg);
      continue;
    }
    positionalCount += 1;
  }
  return { flags: [...flags].sort(), positionalCount };
}

async function readAiwgVersion(frameworkRoot: string): Promise<string> {
  try {
    const raw = await readFile(path.join(frameworkRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '(unknown)';
  } catch {
    return '(unknown)';
  }
}

function hashPath(value: string): string {
  return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 16);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).filter(Boolean).join('/');
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type { CommandLogConfig };
