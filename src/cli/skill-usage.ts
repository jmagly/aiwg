import { mkdir, readFile, rename, stat, writeFile, appendFile, readdir } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import path from 'path';
import { getUserStateDir } from '../config/user-state.js';
import type { AiwgConfig, SkillUsageConfig } from '../config/aiwg-config.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import {
  PROJECT_AIWG_LOCATION_FILE,
  projectAiwgPath,
  projectControlPath,
} from '../config/project-artifacts.js';

export type SkillUsageScope = 'project' | 'global';
export type SkillUsageSource = 'cli' | 'transcript';
export type SkillUsageArtifactKind =
  | 'command'
  | 'skill'
  | 'agent'
  | 'rule'
  | 'framework'
  | 'addon'
  | 'extension'
  | 'unknown';
export type SkillUsageAction = 'invoke' | 'show' | 'discover' | 'delegate' | 'unknown';

export interface SkillUsageEvent {
  schema_version: 1 | 2;
  event_type: 'aiwg.skill_usage';
  timestamp: string;
  observed_timestamp?: string;
  event_id?: string;
  source_generation?: string;
  native_event_id?: string;
  oversized_record?: boolean;
  invocation_id?: string;
  source: SkillUsageSource;
  provider?: string;
  artifact: {
    kind: SkillUsageArtifactKind;
    id: string;
    namespace?: string;
    version?: string;
  };
  action: SkillUsageAction;
  outcome?: 'ok' | 'failed' | 'unknown';
  duration_ms?: number;
  aiwg_version: string;
  project?: {
    root_hash: string;
    relative_path: string;
  };
  cwd_hash: string;
  scope: SkillUsageScope;
}

export interface SkillUsageHeatmapEntry {
  artifact: string;
  kind: SkillUsageArtifactKind;
  id: string;
  count: number;
  last_used_at: string;
  recency_bucket: 'today' | '7d' | '30d' | 'stale';
  frequency_bucket: 'low' | 'medium' | 'high';
}

export interface SkillUsageInventoryEntry {
  kind: 'skill';
  id: string;
  description?: string;
  path: string;
}

export interface SkillUsageSuggestion {
  artifact: string;
  kind: 'skill';
  id: string;
  reason: string;
  score: number;
}

export interface SkillUsageAppendInput {
  command: string;
  args: string[];
  cwd: string;
  frameworkRoot: string;
  durationMs: number;
  exitStatus: number;
  env?: NodeJS.ProcessEnv;
}

export interface SkillUsageReportOptions {
  cwd: string;
  frameworkRoot: string;
  json?: boolean;
  limit?: number;
  scope?: SkillUsageScope | 'all';
  suggestFor?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface SkillUsageTranscriptIngestOptions {
  transcriptPath: string;
  provider: string;
  cwd: string;
  projectRoot?: string;
  frameworkRoot: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SkillUsageImportReceipt {
  source_generation: string;
  provider: string;
  records_read: number;
  events_extracted: number;
  events_appended: number;
  duplicates_skipped: number;
  malformed_skipped: number;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_REPORT_LIMIT = 20;
const MAX_TRANSCRIPT_LINE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_BYTES = 256 * 1_048_576;
const MAX_TRANSCRIPT_RECORDS = 1_000_000;

export async function maybeAppendSkillUsage(input: SkillUsageAppendInput): Promise<void> {
  const env = input.env ?? process.env;
  const resolved = await resolveSkillUsageSettings(input.cwd, env);
  if (!resolved.enabled || resolved.scopes.length === 0) return;

  const identity = classifyCliUsage(input.command, input.args);
  const version = await readAiwgVersion(input.frameworkRoot);
  const context = await resolvePathContext(input.cwd);

  for (const scope of resolved.scopes) {
    const filePath = resolveUsagePath(scope, context.projectRoot, env);
    if (!filePath) continue;

    const event = buildUsageEvent({
      env,
      source: 'cli',
      provider: env.AIWG_PROVIDER || env.CLAUDE_CODE_ENTRYPOINT || undefined,
      artifact: {
        kind: identity.kind,
        id: identity.id,
      },
      action: identity.action,
      outcome: input.exitStatus === 0 ? 'ok' : 'failed',
      durationMs: Math.max(0, Math.round(input.durationMs)),
      version,
      cwd: input.cwd,
      context,
      scope,
    });

    await appendBoundedJsonl(filePath, event, resolved.maxBytes);
  }
}

export async function ingestSkillUsageTranscript(options: SkillUsageTranscriptIngestOptions): Promise<{
  events: SkillUsageEvent[];
  appended: number;
  skipped: number;
  paths: string[];
  receipt: SkillUsageImportReceipt;
}> {
  const env = options.env ?? process.env;
  const contextCwd = options.projectRoot ?? options.cwd;
  const resolved = await resolveSkillUsageSettings(contextCwd, env);
  if (!resolved.enabled || resolved.scopes.length === 0) {
    return {
      events: [], appended: 0, skipped: 0, paths: [],
      receipt: {
        source_generation: '', provider: normalizeProvider(options.provider),
        records_read: 0, events_extracted: 0, events_appended: 0,
        duplicates_skipped: 0, malformed_skipped: 0,
      },
    };
  }

  const provider = normalizeProvider(options.provider);
  if (provider !== 'claude-code') {
    throw new Error(`unsupported skill-usage transcript provider: ${provider}`);
  }
  const sourceStat = await stat(options.transcriptPath);
  const sourceGeneration = digest([
    provider, String(sourceStat.size), String(sourceStat.mtimeMs),
  ].join('\0'));
  const version = await readAiwgVersion(options.frameworkRoot);
  const context = await resolvePathContext(contextCwd);
  const extracted: Array<{
    artifact: SkillUsageEvent['artifact'];
    action: SkillUsageAction;
    occurredAt?: string;
    nativeEventId?: string;
    position: number;
    contentDigest: string;
  }> = [];
  let skipped = 0;
  let recordsRead = 0;
  let bytesRead = 0;

  for await (const line of streamTranscriptLines(options.transcriptPath)) {
    recordsRead += 1;
    bytesRead += Buffer.byteLength(line) + 1;
    if (recordsRead > MAX_TRANSCRIPT_RECORDS || bytesRead > MAX_TRANSCRIPT_BYTES) {
      throw new Error('skill-usage transcript exceeds bounded ingestion limits');
    }
    if (Buffer.byteLength(line) > MAX_TRANSCRIPT_LINE_BYTES) {
      throw new Error('skill-usage transcript record exceeds bounded line limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const events = extractClaudeCodeUsage(parsed);
    if (events.length === 0) {
      skipped += 1;
    } else {
      extracted.push(...events.map(event => ({
        ...event,
        occurredAt: sourceOccurrenceTime(parsed),
        nativeEventId: sourceNativeEventId(parsed),
        position: recordsRead,
        contentDigest: digest(line),
      })));
    }
  }

  const persisted: SkillUsageEvent[] = [];
  const paths = resolved.scopes
    .map(scope => resolveUsagePath(scope, context.projectRoot, env))
    .filter((p): p is string => Boolean(p));
  const knownEventIdsByPath = new Map<string, Set<string>>();
  for (const filePath of paths) {
    const knownEventIds = new Set<string>();
    for (const event of await readJsonlEvents(filePath)) {
      if (event.event_id) knownEventIds.add(event.event_id);
    }
    knownEventIdsByPath.set(filePath, knownEventIds);
  }
  let duplicatesSkipped = 0;

  for (const scope of resolved.scopes) {
    const filePath = resolveUsagePath(scope, context.projectRoot, env);
    if (!filePath) continue;
    const knownEventIds = knownEventIdsByPath.get(filePath) ?? new Set<string>();
    for (const item of extracted) {
      const eventId = digest([
        sourceGeneration,
        item.nativeEventId ?? String(item.position),
        item.contentDigest,
        item.artifact.kind,
        item.artifact.id,
      ].join('\0'));
      if (knownEventIds.has(eventId)) {
        duplicatesSkipped += 1;
        continue;
      }
      const event = buildUsageEvent({
        env,
        source: 'transcript',
        provider,
        artifact: item.artifact,
        action: item.action,
        outcome: 'unknown',
        version,
        cwd: context.projectRoot ?? contextCwd,
        context,
        scope,
        occurredAt: item.occurredAt,
        eventId,
        sourceGeneration,
        nativeEventId: item.nativeEventId,
      });
      persisted.push(event);
      knownEventIds.add(eventId);
      if (!options.dryRun) {
        await appendBoundedJsonl(filePath, event, resolved.maxBytes);
      }
    }
  }

  return {
    events: persisted,
    appended: options.dryRun ? 0 : persisted.length,
    skipped,
    paths,
    receipt: {
      source_generation: sourceGeneration,
      provider,
      records_read: recordsRead,
      events_extracted: extracted.length,
      events_appended: options.dryRun ? 0 : persisted.length,
      duplicates_skipped: duplicatesSkipped,
      malformed_skipped: skipped,
    },
  };
}

export async function readSkillUsageReport(options: SkillUsageReportOptions): Promise<{
  events: SkillUsageEvent[];
  summary: {
    total: number;
    by_artifact: Record<string, number>;
    by_kind: Record<string, number>;
    by_action: Record<string, number>;
    failures_by_artifact: Record<string, number>;
    by_scope: Record<string, number>;
  };
  heatmap: SkillUsageHeatmapEntry[];
  cold_spots: SkillUsageInventoryEntry[];
  suggestions: SkillUsageSuggestion[];
  paths: string[];
  window: { retained_segments: number; truncated_before: boolean };
}> {
  const env = options.env ?? process.env;
  const context = await resolvePathContext(options.cwd);
  const scope = options.scope ?? 'all';
  const scopes: SkillUsageScope[] = scope === 'all' ? ['project', 'global'] : [scope];
  const paths = scopes
    .map(s => resolveUsagePath(s, context.projectRoot, env))
    .filter((p): p is string => Boolean(p));

  const events: SkillUsageEvent[] = [];
  for (const filePath of paths) {
    events.push(...await readJsonlEvents(filePath));
  }

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = events.slice(0, options.limit ?? DEFAULT_REPORT_LIMIT);
  const inventory = await discoverSkillInventory(options.frameworkRoot);
  const heatmap = buildHeatmap(events, options.now ?? new Date());
  const coldSpots = buildColdSpots(inventory, events).slice(0, 20);
  return {
    events: limited,
    summary: summarizeEvents(events),
    heatmap,
    cold_spots: coldSpots,
    suggestions: buildSuggestions({
      inventory,
      events,
      query: options.suggestFor,
      limit: 5,
    }),
    paths,
    window: {
      retained_segments: paths.reduce(
        (count, filePath) => count + retainedUsagePaths(filePath).filter(existsSync).length,
        0,
      ),
      truncated_before: paths.some(filePath => existsSync(`${filePath}.1`)),
    },
  };
}

export async function printSkillUsageReport(options: SkillUsageReportOptions): Promise<void> {
  const report = await readSkillUsageReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('AIWG skill usage');
  console.log(`Events: ${report.summary.total}`);
  if (report.paths.length > 0) {
    console.log(`Stores: ${report.paths.join(', ')}`);
  }

  const artifacts = Object.entries(report.summary.by_artifact)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (artifacts.length > 0) {
    console.log('');
    console.log('Top artifacts');
    for (const [artifact, count] of artifacts) {
      const failures = report.summary.failures_by_artifact[artifact] ?? 0;
      const failureText = failures > 0 ? `, ${failures} failed` : '';
      console.log(`  ${artifact}: ${count}${failureText}`);
    }
  }

  if (report.events.length > 0) {
    console.log('');
    console.log('Recent usage');
    for (const event of report.events) {
      const status = event.outcome ?? 'unknown';
      const rel = event.project?.relative_path ? ` path=${event.project.relative_path}` : '';
      const artifact = `${event.artifact.kind}:${event.artifact.id}`;
      const duration = event.duration_ms === undefined ? '' : ` ${event.duration_ms}ms`;
      console.log(`  ${event.timestamp} ${event.scope} ${event.action} ${artifact} ${status}${duration}${rel}`);
    }
  }

  if (report.heatmap.length > 0) {
    console.log('');
    console.log('Heatmap');
    for (const entry of report.heatmap.slice(0, 10)) {
      console.log(`  ${entry.artifact}: ${entry.frequency_bucket} frequency, ${entry.recency_bucket} recency (${entry.count})`);
    }
  }

  if (report.cold_spots.length > 0) {
    console.log('');
    console.log('Cold spots');
    for (const entry of report.cold_spots.slice(0, 10)) {
      console.log(`  skill:${entry.id}`);
    }
  }

  if (report.suggestions.length > 0) {
    console.log('');
    console.log('Suggestions');
    for (const suggestion of report.suggestions) {
      console.log(`  ${suggestion.artifact}: ${suggestion.reason}`);
    }
  }
}

function classifyCliUsage(command: string, args: string[]): {
  kind: SkillUsageArtifactKind;
  id: string;
  action: SkillUsageAction;
} {
  if (command === 'run' && args[0] === 'skill' && isIdentifier(args[1])) {
    return { kind: 'skill', id: args[1], action: 'invoke' };
  }
  if (command === 'run' && args[0] === 'agent' && isIdentifier(args[1])) {
    return { kind: 'agent', id: args[1], action: 'delegate' };
  }
  if (command === 'show' && isArtifactKind(args[0]) && isIdentifier(args[1])) {
    return { kind: args[0], id: args[1], action: 'show' };
  }
  if (command === 'discover') {
    return { kind: 'command', id: 'discover', action: 'discover' };
  }
  return { kind: 'command', id: command, action: 'invoke' };
}

function buildUsageEvent(input: {
  env: NodeJS.ProcessEnv;
  source: SkillUsageSource;
  provider?: string;
  artifact: SkillUsageEvent['artifact'];
  action: SkillUsageAction;
  outcome?: SkillUsageEvent['outcome'];
  durationMs?: number;
  version: string;
  cwd: string;
  context: { projectRoot: string | null; relativePath: string };
  scope: SkillUsageScope;
  occurredAt?: string;
  eventId?: string;
  sourceGeneration?: string;
  nativeEventId?: string;
}): SkillUsageEvent {
  const observedTimestamp = new Date().toISOString();
  const event: SkillUsageEvent = {
    schema_version: input.eventId ? 2 : 1,
    event_type: 'aiwg.skill_usage',
    timestamp: input.occurredAt ?? observedTimestamp,
    ...(input.eventId ? {
      observed_timestamp: observedTimestamp,
      event_id: input.eventId,
      source_generation: input.sourceGeneration,
      native_event_id: input.nativeEventId,
    } : {}),
    invocation_id: input.env.AIWG_INVOCATION_ID,
    source: input.source,
    provider: input.provider,
    artifact: input.artifact,
    action: input.action,
    outcome: input.outcome,
    aiwg_version: input.version,
    cwd_hash: hashPath(input.cwd),
    scope: input.scope,
  };

  if (input.durationMs !== undefined) {
    event.duration_ms = input.durationMs;
  }
  if (input.context.projectRoot) {
    event.project = {
      root_hash: hashPath(input.context.projectRoot),
      relative_path: input.context.relativePath,
    };
  }
  return event;
}

function extractClaudeCodeUsage(value: unknown): Array<{
  artifact: SkillUsageEvent['artifact'];
  action: SkillUsageAction;
}> {
  const toolUses = collectToolUses(value);
  const events: Array<{
    artifact: SkillUsageEvent['artifact'];
    action: SkillUsageAction;
  }> = [];

  for (const toolUse of toolUses) {
    const name = typeof toolUse.name === 'string' ? toolUse.name : '';
    const input = isRecord(toolUse.input) ? toolUse.input : {};
    if (name === 'Skill') {
      const id = firstString(input, ['skill', 'skill_name', 'name', 'id']);
      if (id) events.push({ artifact: { kind: 'skill', id }, action: 'invoke' });
      continue;
    }
    if (name === 'Task') {
      const id = firstString(input, ['subagent_type', 'agent', 'agent_name', 'name']);
      if (id) events.push({ artifact: { kind: 'agent', id }, action: 'delegate' });
      continue;
    }
    if (name === 'SlashCommand') {
      const id = firstString(input, ['command', 'name', 'id']);
      if (id) events.push({ artifact: { kind: 'command', id: id.replace(/^\//, '') }, action: 'invoke' });
    }
  }

  return events;
}

function collectToolUses(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node['type'] === 'tool_use' && typeof node['name'] === 'string') {
      found.push(node);
    }
    for (const child of Object.values(node)) {
      if (typeof child === 'object' && child !== null) visit(child);
    }
  };
  visit(value);
  return found;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'claude_code') return 'claude-code';
  return normalized || 'unknown';
}

function sourceOccurrenceTime(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['timestamp', 'created_at', 'createdAt', 'time']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) {
      return new Date(candidate).toISOString();
    }
  }
  return undefined;
}

function sourceNativeEventId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return firstString(value, ['uuid', 'event_id', 'eventId', 'id', 'message_id']);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isArtifactKind(value: string | undefined): value is SkillUsageArtifactKind {
  return value === 'skill' ||
    value === 'agent' ||
    value === 'rule' ||
    value === 'framework' ||
    value === 'addon' ||
    value === 'extension' ||
    value === 'command';
}

function isIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-');
}

async function resolveSkillUsageSettings(cwd: string, env: NodeJS.ProcessEnv): Promise<{
  enabled: boolean;
  scopes: SkillUsageScope[];
  maxBytes: number;
}> {
  const envSetting = env.AIWG_SKILL_USAGE?.trim().toLowerCase();
  const envMax = parsePositiveInt(env.AIWG_SKILL_USAGE_MAX_BYTES);
  if (envSetting) {
    const scopes = scopesFromString(envSetting);
    return {
      enabled: scopes.length > 0,
      scopes,
      maxBytes: envMax ?? DEFAULT_MAX_BYTES,
    };
  }

  const config = await readNearestProjectConfig(cwd);
  const skillUsage = config?.telemetry?.skill_usage;
  if (skillUsage?.enabled) {
    return settingsFromConfig(skillUsage, envMax);
  }

  const commandLog = config?.command_log;
  if (commandLog?.enabled) {
    return settingsFromConfig(commandLog, envMax);
  }

  return { enabled: false, scopes: [], maxBytes: envMax ?? DEFAULT_MAX_BYTES };
}

function settingsFromConfig(
  config: SkillUsageConfig,
  envMax: number | undefined,
): { enabled: boolean; scopes: SkillUsageScope[]; maxBytes: number } {
  return {
    enabled: true,
    scopes: normalizeScopes(config.scopes ?? ['project']),
    maxBytes: config.max_bytes ?? envMax ?? DEFAULT_MAX_BYTES,
  };
}

function scopesFromString(value: string): SkillUsageScope[] {
  if (['0', 'false', 'off', 'none', 'disabled'].includes(value)) return [];
  if (['1', 'true', 'on', 'project'].includes(value)) return ['project'];
  if (value === 'global') return ['global'];
  if (['both', 'all'].includes(value)) return ['project', 'global'];
  return normalizeScopes(value.split(','));
}

function normalizeScopes(values: readonly string[]): SkillUsageScope[] {
  const scopes: SkillUsageScope[] = [];
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

function resolveUsagePath(
  scope: SkillUsageScope,
  projectRoot: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (scope === 'project') {
    if (!projectRoot) return null;
    return projectAiwgPath(projectRoot, 'telemetry', 'skill-usage.jsonl');
  }

  return path.join(getUserStateDir(env), 'skill-usage.jsonl');
}

async function appendBoundedJsonl(filePath: string, event: SkillUsageEvent, maxBytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(event) + '\n';
  const lineBytes = Buffer.byteLength(line);
  if (maxBytes > 0 && lineBytes > maxBytes) event.oversized_record = true;
  const finalLine = JSON.stringify(event) + '\n';
  await rotateIfNeeded(filePath, maxBytes, Buffer.byteLength(finalLine));
  await appendFile(filePath, finalLine, 'utf8');
}

async function rotateIfNeeded(filePath: string, maxBytes: number, appendBytes: number): Promise<void> {
  if (maxBytes <= 0) return;
  try {
    const current = await stat(filePath);
    if (current.size === 0 || current.size + appendBytes <= maxBytes) return;
    const rotated = `${filePath}.1`;
    if (existsSync(rotated)) {
      await writeFile(rotated, '', 'utf8');
    }
    await rename(filePath, rotated);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readJsonlEvents(filePath: string): Promise<SkillUsageEvent[]> {
  const events: SkillUsageEvent[] = [];
  for (const retainedPath of retainedUsagePaths(filePath)) {
    try {
      for await (const line of streamTranscriptLines(retainedPath)) {
        if (line.trim()) events.push(JSON.parse(line) as SkillUsageEvent);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return events;
}

function retainedUsagePaths(filePath: string): string[] {
  return [`${filePath}.1`, filePath];
}

async function* streamTranscriptLines(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function summarizeEvents(events: SkillUsageEvent[]) {
  const by_artifact: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  const by_action: Record<string, number> = {};
  const failures_by_artifact: Record<string, number> = {};
  const by_scope: Record<string, number> = {};
  for (const event of events) {
    const artifact = `${event.artifact.kind}:${event.artifact.id}`;
    by_artifact[artifact] = (by_artifact[artifact] ?? 0) + 1;
    by_kind[event.artifact.kind] = (by_kind[event.artifact.kind] ?? 0) + 1;
    by_action[event.action] = (by_action[event.action] ?? 0) + 1;
    by_scope[event.scope] = (by_scope[event.scope] ?? 0) + 1;
    if (event.outcome === 'failed') {
      failures_by_artifact[artifact] = (failures_by_artifact[artifact] ?? 0) + 1;
    }
  }
  return {
    total: events.length,
    by_artifact,
    by_kind,
    by_action,
    failures_by_artifact,
    by_scope,
  };
}

function buildHeatmap(events: SkillUsageEvent[], now: Date): SkillUsageHeatmapEntry[] {
  const byArtifact = new Map<string, { event: SkillUsageEvent; count: number; last: string }>();
  for (const event of events) {
    const key = `${event.artifact.kind}:${event.artifact.id}`;
    const existing = byArtifact.get(key);
    if (!existing) {
      byArtifact.set(key, { event, count: 1, last: event.timestamp });
      continue;
    }
    existing.count += 1;
    if (event.timestamp > existing.last) existing.last = event.timestamp;
  }

  return [...byArtifact.entries()]
    .map(([artifact, item]) => ({
      artifact,
      kind: item.event.artifact.kind,
      id: item.event.artifact.id,
      count: item.count,
      last_used_at: item.last,
      recency_bucket: recencyBucket(item.last, now),
      frequency_bucket: frequencyBucket(item.count),
    }))
    .sort((a, b) => b.count - a.count || b.last_used_at.localeCompare(a.last_used_at) || a.artifact.localeCompare(b.artifact));
}

function buildColdSpots(inventory: SkillUsageInventoryEntry[], events: SkillUsageEvent[]): SkillUsageInventoryEntry[] {
  const used = new Set(events
    .filter(event => event.artifact.kind === 'skill')
    .map(event => event.artifact.id));
  return inventory
    .filter(item => !used.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildSuggestions(input: {
  inventory: SkillUsageInventoryEntry[];
  events: SkillUsageEvent[];
  query?: string;
  limit: number;
}): SkillUsageSuggestion[] {
  const queryTerms = tokenize(input.query ?? '');
  if (queryTerms.length === 0) return [];

  const counts = new Map<string, number>();
  for (const event of input.events) {
    if (event.artifact.kind !== 'skill') continue;
    counts.set(event.artifact.id, (counts.get(event.artifact.id) ?? 0) + 1);
  }

  return input.inventory
    .map(item => {
      const haystack = tokenize(`${item.id} ${item.description ?? ''}`);
      const relevance = queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
      const usageCount = counts.get(item.id) ?? 0;
      const underUsedBoost = usageCount === 0 ? 2 : usageCount === 1 ? 1 : 0;
      return { item, relevance, usageCount, score: relevance * 10 + underUsedBoost };
    })
    .filter(candidate => candidate.relevance > 0 && candidate.usageCount <= 1)
    .sort((a, b) => b.score - a.score || a.usageCount - b.usageCount || a.item.id.localeCompare(b.item.id))
    .slice(0, input.limit)
    .map(candidate => ({
      artifact: `skill:${candidate.item.id}`,
      kind: 'skill' as const,
      id: candidate.item.id,
      reason: candidate.usageCount === 0
        ? 'Matches the query and has no local usage events.'
        : 'Matches the query and has only one local usage event.',
      score: candidate.score,
    }));
}

async function discoverSkillInventory(frameworkRoot: string): Promise<SkillUsageInventoryEntry[]> {
  const root = path.join(frameworkRoot, 'agentic', 'code');
  const entries: SkillUsageInventoryEntry[] = [];
  await collectSkillFiles(root, entries);
  const byId = new Map<string, SkillUsageInventoryEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing || entry.path < existing.path) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function collectSkillFiles(dir: string, out: SkillUsageInventoryEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
    const skillPath = path.join(dir, 'SKILL.md');
    const id = path.basename(dir);
    out.push({
      kind: 'skill',
      id,
      description: await readSkillDescription(skillPath),
      path: normalizeRelativePath(skillPath),
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    await collectSkillFiles(path.join(dir, entry.name), out);
  }
}

async function readSkillDescription(skillPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(skillPath, 'utf8');
    const match = raw.match(/^description:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

function recencyBucket(timestamp: string, now: Date): SkillUsageHeatmapEntry['recency_bucket'] {
  const ageMs = now.getTime() - new Date(timestamp).getTime();
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 1) return 'today';
  if (ageDays <= 7) return '7d';
  if (ageDays <= 30) return '30d';
  return 'stale';
}

function frequencyBucket(count: number): SkillUsageHeatmapEntry['frequency_bucket'] {
  if (count >= 10) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function tokenize(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length >= 2))];
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
