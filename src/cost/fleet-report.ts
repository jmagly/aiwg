/**
 * OpenRouter fleet spend observation and local activity correlation.
 *
 * Secrets are resolved only from the process environment or the user's
 * ~/.config/aiwg/keys directory. Fleet configuration contains references,
 * never credential values.
 *
 * @issue #1187
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const KEY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_FIELD_PATTERN = /(?:api[_-]?key|token|secret|credential|authorization)/i;
const GENERATION_ID_PATTERN = /(?:generation(?:_id|-id)?)[=:]\s*(gen-[A-Za-z0-9_-]+)/i;
const TAG_PATTERN = (name: string) => new RegExp(`${name}[=:]\\s*([A-Za-z0-9._/-]+)`, 'i');

export interface FleetEntry {
  bot: string;
  machine: string;
  key_ref: string;
  monthly_cap: number;
}

export interface FleetConfig {
  provider?: 'openrouter';
  activity_log?: string;
  fleet: FleetEntry[];
}

export interface CorrelatedSession {
  session: string;
  cost: number;
  generations: number;
}

export interface FleetBotReport {
  bot: string;
  machine: string;
  spend_mtd: number | null;
  cap: number;
  percent_used: number | null;
  top_sessions: CorrelatedSession[];
  model_tier_breakdown: Record<string, number>;
  anomalies: string[];
  error?: string;
}

export interface FleetSpendReport {
  source: 'openrouter';
  observed_at: string;
  enforcement: 'openrouter';
  activity_log: string;
  bots: FleetBotReport[];
}

export interface FleetReportOptions {
  cwd: string;
  configPath?: string;
  /** Direct entries support single-key CLI observation without a fleet file. */
  fleet?: FleetEntry[];
  activityLog?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: Date;
  signal?: AbortSignal;
}

interface ActivityGeneration {
  id: string;
  bot?: string;
  session: string;
}

interface OpenRouterKeyData {
  usage_monthly?: number;
  usage?: number;
  limit?: number | null;
  limit_reset?: string | null;
}

interface OpenRouterGenerationData {
  id?: string;
  total_cost?: number;
  usage?: number;
  model?: string;
  service_tier?: string;
  created_at?: string;
}

export class FleetConfigMissingError extends Error {
  constructor(public readonly configPath: string) {
    super(
      `No fleet config found at ${configPath}. Create it with a top-level fleet list; `
      + 'store only key_ref values there, and place credentials in ~/.config/aiwg/keys/ or AIWG_OPENROUTER_KEY_* environment variables.',
    );
    this.name = 'FleetConfigMissingError';
  }
}

function hasEmbeddedSecret(value: unknown): boolean {
  if (typeof value === 'string') return /^sk-or-/i.test(value.trim());
  if (Array.isArray(value)) return value.some(hasEmbeddedSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    (key !== 'key_ref' && SECRET_FIELD_PATTERN.test(key)) || hasEmbeddedSecret(child)
  ));
}

function validateFleetConfig(value: unknown): FleetConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Fleet config must be a YAML object.');
  }
  if (hasEmbeddedSecret(value)) {
    throw new Error('Fleet config contains a credential-like field or value; store only key_ref values.');
  }
  const candidate = value as Partial<FleetConfig>;
  if (candidate.provider && candidate.provider !== 'openrouter') {
    throw new Error(`Unsupported fleet provider '${candidate.provider}'. Only openrouter is currently supported.`);
  }
  if (!Array.isArray(candidate.fleet) || candidate.fleet.length === 0) {
    throw new Error('Fleet config must contain a non-empty fleet list.');
  }
  const seenBots = new Set<string>();
  const seenKeyRefs = new Set<string>();
  const fleet = candidate.fleet.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`fleet[${index}] must be an object.`);
    const entry = raw as Partial<FleetEntry>;
    if (!entry.bot?.trim() || !entry.machine?.trim() || !entry.key_ref?.trim()) {
      throw new Error(`fleet[${index}] requires bot, machine, and key_ref.`);
    }
    if (!KEY_REF_PATTERN.test(entry.key_ref)) {
      throw new Error(`fleet[${index}].key_ref contains unsupported characters.`);
    }
    if (typeof entry.monthly_cap !== 'number' || !Number.isFinite(entry.monthly_cap) || entry.monthly_cap < 0) {
      throw new Error(`fleet[${index}].monthly_cap must be a non-negative number.`);
    }
    if (seenBots.has(entry.bot)) throw new Error(`Duplicate fleet bot '${entry.bot}'.`);
    if (seenKeyRefs.has(entry.key_ref)) throw new Error(`Duplicate fleet key_ref '${entry.key_ref}'.`);
    seenBots.add(entry.bot);
    seenKeyRefs.add(entry.key_ref);
    return {
      bot: entry.bot.trim(),
      machine: entry.machine.trim(),
      key_ref: entry.key_ref,
      monthly_cap: entry.monthly_cap,
    };
  });
  return {
    provider: 'openrouter',
    ...(typeof candidate.activity_log === 'string' ? { activity_log: candidate.activity_log } : {}),
    fleet,
  };
}

export async function loadFleetConfig(configPath: string): Promise<FleetConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FleetConfigMissingError(configPath);
    throw error;
  }
  return validateFleetConfig(loadYaml(raw));
}

export function keyEnvironmentName(keyRef: string): string {
  return `AIWG_OPENROUTER_KEY_${keyRef.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export async function loadFleetKey(
  keyRef: string,
  options: Pick<FleetReportOptions, 'homeDir' | 'env'> = {},
): Promise<string> {
  if (!KEY_REF_PATTERN.test(keyRef)) throw new Error('Invalid key_ref.');
  const env = options.env ?? process.env;
  const environmentName = keyEnvironmentName(keyRef);
  const environmentValue = env[environmentName]?.trim();
  if (environmentValue) return environmentValue;

  const homeDir = options.homeDir ?? os.homedir();
  const keyDirectory = path.resolve(homeDir, '.config', 'aiwg', 'keys');
  const keyPath = path.resolve(keyDirectory, keyRef);
  if (path.dirname(keyPath) !== keyDirectory) throw new Error(`Invalid key_ref '${keyRef}'.`);
  let directoryStat;
  try {
    directoryStat = await fs.lstat(keyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No secure credential directory exists for key_ref '${keyRef}'; use ${environmentName} or create ~/.config/aiwg/keys with mode 0700.`);
    }
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('The AIWG credential directory must be a regular directory, not a symlink.');
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    throw new Error('The AIWG credential directory must not be accessible by group or other users.');
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('The AIWG credential directory must be owned by the current user.');
  }
  let stat;
  try {
    stat = await fs.lstat(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No credential found for key_ref '${keyRef}' in the secure key directory or ${environmentName}.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Credential for key_ref '${keyRef}' must be a regular file, not a symlink.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Credential file for key_ref '${keyRef}' must not be accessible by group or other users.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Credential file for key_ref '${keyRef}' must be owned by the current user.`);
  }
  const value = (await fs.readFile(keyPath, 'utf8')).trim();
  if (!value) throw new Error(`Credential file for key_ref '${keyRef}' is empty.`);
  return value;
}

function parseActivityLog(raw: string): ActivityGeneration[] {
  const entries: ActivityGeneration[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const generationId = line.match(GENERATION_ID_PATTERN)?.[1];
    if (!generationId) continue;
    const bot = line.match(TAG_PATTERN('bot'))?.[1];
    const session = line.match(TAG_PATTERN('session'))?.[1] ?? generationId;
    entries.push({ id: generationId, ...(bot ? { bot } : {}), session });
  }
  return entries;
}

async function readActivityLog(file: string): Promise<ActivityGeneration[]> {
  try {
    return parseActivityLog(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function openRouterGet<T>(
  endpoint: string,
  key: string,
  options: FleetReportOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.apiBaseUrl ?? OPENROUTER_API}${endpoint}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: requestSignal(options.signal),
    });
  } catch {
    // Transport diagnostics can embed Authorization headers or request bodies.
    throw new Error('OpenRouter request could not complete. Check connectivity, timeout, or cancellation.');
  }
  if (!response.ok) throw new Error(`OpenRouter request failed with status ${response.status}.`);
  let payload: { data?: T };
  try {
    payload = await response.json() as { data?: T };
  } catch {
    // Decoder exceptions can quote arbitrary response content.
    throw new Error('OpenRouter returned unreadable JSON. Check the API response format.');
  }
  if (!payload || typeof payload !== 'object' || !payload.data) throw new Error('OpenRouter returned an invalid response.');
  return payload.data;
}

function correlateGenerations(
  records: Array<{ activity: ActivityGeneration; data: OpenRouterGenerationData }>,
): Pick<FleetBotReport, 'top_sessions' | 'model_tier_breakdown'> {
  const sessions = new Map<string, CorrelatedSession>();
  const breakdown: Record<string, number> = {};
  for (const { activity, data } of records) {
    const cost = Number(data.total_cost ?? data.usage ?? 0);
    const current = sessions.get(activity.session) ?? { session: activity.session, cost: 0, generations: 0 };
    current.cost += Number.isFinite(cost) ? cost : 0;
    current.generations += 1;
    sessions.set(activity.session, current);
    const tier = data.service_tier || data.model || 'unknown';
    breakdown[tier] = (breakdown[tier] ?? 0) + (Number.isFinite(cost) ? cost : 0);
  }
  return {
    top_sessions: [...sessions.values()].sort((a, b) => b.cost - a.cost || a.session.localeCompare(b.session)).slice(0, 3),
    model_tier_breakdown: Object.fromEntries(
      Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    ),
  };
}

async function reportBot(
  entry: FleetEntry,
  activity: ActivityGeneration[],
  options: FleetReportOptions,
): Promise<FleetBotReport> {
  try {
    const key = await loadFleetKey(entry.key_ref, options);
    const keyData = await openRouterGet<OpenRouterKeyData>('/key', key, options);
    const spend = Number(keyData.usage_monthly ?? keyData.usage ?? 0);
    if (!Number.isFinite(spend) || spend < 0) throw new Error('OpenRouter returned invalid monthly usage.');
    const matching = activity.filter(item => item.bot === entry.bot || (!item.bot && options.fleet?.length === 1));
    const unique = [...new Map(matching.map(item => [item.id, item])).values()].slice(0, 100);
    const generationResults = await Promise.allSettled(unique.map(async item => ({
      activity: item,
      data: await openRouterGet<OpenRouterGenerationData>(`/generation?id=${encodeURIComponent(item.id)}`, key, options),
    })));
    const now = options.now ?? new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const generations = generationResults
      .filter((result): result is PromiseFulfilledResult<{ activity: ActivityGeneration; data: OpenRouterGenerationData }> => result.status === 'fulfilled')
      .map(result => result.value)
      .filter(({ data }) => {
        if (!data.created_at) return true;
        const created = Date.parse(data.created_at);
        return Number.isFinite(created) && created >= monthStart && created < monthEnd;
      });
    const correlated = correlateGenerations(generations);
    const apiMonthlyCap = keyData.limit_reset === 'monthly' && typeof keyData.limit === 'number' ? keyData.limit : 0;
    const cap = entry.monthly_cap > 0 ? entry.monthly_cap : apiMonthlyCap;
    const percent = cap > 0 ? (spend / cap) * 100 : null;
    const anomalies: string[] = [];
    if (generationResults.some(result => result.status === 'rejected')) anomalies.push('generation-correlation-partial');
    if (percent !== null && percent >= 100) anomalies.push('cap-exceeded');
    else if (percent !== null && percent >= 80) anomalies.push('cap-near-limit');
    if (correlated.top_sessions[0] && spend > 0 && correlated.top_sessions[0].cost / spend >= 0.5) {
      anomalies.push('single-session-spike');
    }
    return {
      bot: entry.bot,
      machine: entry.machine,
      spend_mtd: spend,
      cap,
      percent_used: percent,
      ...correlated,
      anomalies,
    };
  } catch (error) {
    return {
      bot: entry.bot,
      machine: entry.machine,
      spend_mtd: null,
      cap: entry.monthly_cap,
      percent_used: null,
      top_sessions: [],
      model_tier_breakdown: {},
      anomalies: ['observation-error'],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function generateFleetSpendReport(options: FleetReportOptions): Promise<FleetSpendReport> {
  const homeDir = options.homeDir ?? os.homedir();
  let fleet = options.fleet;
  let configuredActivityLog: string | undefined;
  if (!fleet) {
    const configPath = options.configPath ?? path.join(homeDir, '.config', 'aiwg', 'fleet.yaml');
    const config = await loadFleetConfig(configPath);
    fleet = config.fleet;
    configuredActivityLog = config.activity_log;
  }
  const activityLog = path.resolve(options.cwd, options.activityLog ?? configuredActivityLog ?? '.aiwg/activity.log');
  const activity = await readActivityLog(activityLog);
  const bots = await Promise.all(fleet.map(entry => reportBot(entry, activity, { ...options, homeDir })));
  return {
    source: 'openrouter',
    observed_at: (options.now ?? new Date()).toISOString(),
    enforcement: 'openrouter',
    activity_log: activityLog,
    bots,
  };
}

function money(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(2)}`;
}

export function formatFleetSpendReport(report: FleetSpendReport): string {
  const headers = ['bot', 'machine', 'spend MTD', 'cap', '% used', 'top-3 expensive sessions'];
  const rows = report.bots.map(bot => [
    bot.bot,
    bot.machine,
    money(bot.spend_mtd),
    money(bot.cap),
    bot.percent_used === null ? 'n/a' : `${bot.percent_used.toFixed(1)}%`,
    bot.top_sessions.length
      ? bot.top_sessions.map(session => `${session.session} (${money(session.cost)})`).join(', ')
      : '—',
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  const output = [
    'OpenRouter Fleet Cost Report',
    `Observed: ${report.observed_at}`,
    'AIWG observes and correlates spend; OpenRouter enforces all key limits and caps.',
    '',
    line(headers),
    widths.map(width => '-'.repeat(width)).join('-|-'),
    ...rows.map(line),
  ];
  for (const bot of report.bots) {
    if (bot.anomalies.length) output.push(`! ${bot.bot}: ${bot.anomalies.join(', ')}${bot.error ? ` (${bot.error})` : ''}`);
    const breakdown = Object.entries(bot.model_tier_breakdown);
    if (breakdown.length) output.push(`  ${bot.bot} model/tier: ${breakdown.map(([name, cost]) => `${name} ${money(cost)}`).join(', ')}`);
  }
  return output.join('\n');
}
