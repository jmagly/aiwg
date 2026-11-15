/**
 * Activity Log CLI — `aiwg activity-log <subcommand>`
 *
 * Subcommands:
 *   show [--since DATE] [--operation OP] [--limit N]
 *   append <operation> "<summary>"
 *   stats
 *
 * Persists through `resolveStorage('activity_log')` per #964 — the
 * physical destination is `.aiwg/activity.log` on the default `fs`
 * backend, byte-identical to the legacy `echo >> .aiwg/activity.log`
 * pattern documented in the activity-log skill.
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #964
 */

import {
  ACTIVITY_OPERATIONS,
  formatEntry,
  formatUtcTimestamp,
  isActivityOperation,
  type ActivityEntry,
  type ActivityOperation,
} from './types.js';
import { parseLog, parseUtcDate } from './parser.js';
import { resolveStorage, type StorageAdapter } from '../storage/index.js';
import { redactText } from '../governance/redaction.js';

const LOG_PATH = 'activity.log';
const DEFAULT_LIMIT = 20;

export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'show':
      await handleShow(subArgs);
      break;
    case 'append':
      await handleAppend(subArgs);
      break;
    case 'stats':
      await handleStats();
      break;
    case 'rotate':
      await handleRotate(subArgs);
      break;
    default:
      printUsage();
      if (subcommand) {
        throw new Error(`Unknown activity-log subcommand: ${subcommand}`);
      }
  }
}

interface ShowArgs {
  since?: Date;
  operation?: ActivityOperation;
  limit: number;
}

async function handleShow(args: string[]): Promise<void> {
  const opts = parseShowArgs(args);
  const adapter = await resolveStorage('activity_log');
  const entries = await readEntries(adapter);

  let filtered = entries;
  if (opts.since) {
    const since = opts.since;
    filtered = filtered.filter((e) => e.timestamp >= since);
  }
  if (opts.operation) {
    filtered = filtered.filter((e) => e.operation === opts.operation);
  }

  // Newest first
  filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (filtered.length > opts.limit) {
    filtered = filtered.slice(0, opts.limit);
  }

  if (filtered.length === 0) {
    console.log('No activity log entries match the filters.');
    return;
  }

  for (const entry of filtered) {
    console.log(formatEntry(entry));
  }
}

async function handleAppend(args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new Error(
      `Usage: aiwg activity-log append <operation> "<summary>"\n` +
        `  Valid operations: ${ACTIVITY_OPERATIONS.join(', ')}`
    );
  }
  const op = args[0];
  const summary = redactText(args.slice(1).join(' ').trim(), {
    limits: { maxInputBytes: 16 * 1024 },
  }).text;

  if (!isActivityOperation(op)) {
    throw new Error(
      `Invalid operation "${op}". Valid operations: ${ACTIVITY_OPERATIONS.join(', ')}`
    );
  }
  if (summary.length === 0) {
    throw new Error('Summary must be a non-empty string');
  }
  if (summary.length > 120) {
    // Soft limit per the activity-log rule. Warn but don't refuse —
    // the rule says "≤120 characters" but doesn't promise rejection.
    console.warn(`warning: summary is ${summary.length} chars (rule recommends ≤120)`);
  }

  // #975: honor AIWG_SKIP_ACTIVITY_LOG=1 per the activity-log rule.
  if (isActivityLogSkipped()) {
    return;
  }

  const adapter = await resolveStorage('activity_log');
  const newLine = formatEntry({ timestamp: new Date(), operation: op, summary });

  // #976: prefer atomic append when the backend supports it. The fs
  // backend uses fs.appendFile (O_APPEND) so concurrent appenders don't
  // race with each other. Fall back to read-then-write for backends
  // that don't expose append (e.g., Notion, AnythingLLM, Fortemi) —
  // those backends have their own concurrency models anyway.
  if (typeof adapter.append === 'function') {
    // Append guarantees no read-modify-write race. We need to ensure the
    // existing log ends with a newline before our line; do that with a
    // single-byte preamble append when needed.
    const existing = (await adapter.read(LOG_PATH)) ?? '';
    if (existing.length > 0 && !existing.endsWith('\n')) {
      await adapter.append(LOG_PATH, '\n');
    }
    await adapter.append(LOG_PATH, newLine + '\n');
  } else {
    const existing = (await adapter.read(LOG_PATH)) ?? '';
    const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await adapter.write(LOG_PATH, existing + trailing + newLine + '\n');
  }

  console.log(`Entry appended to .aiwg/activity.log:\n  ${newLine}`);
}

/**
 * Returns true when AIWG_SKIP_ACTIVITY_LOG is set (per the activity-log
 * rule's documented opt-out). Accepts "1", "true" (case-insensitive),
 * or any non-empty value other than "0"/"false".
 */
function isActivityLogSkipped(): boolean {
  const raw = process.env['AIWG_SKIP_ACTIVITY_LOG'];
  if (!raw) return false;
  const v = raw.toLowerCase().trim();
  if (v === '0' || v === 'false' || v === '') return false;
  return true;
}

async function handleStats(): Promise<void> {
  const adapter = await resolveStorage('activity_log');
  const entries = await readEntries(adapter);

  if (entries.length === 0) {
    console.log('Activity log is empty.');
    return;
  }

  const counts = new Map<ActivityOperation, number>();
  for (const op of ACTIVITY_OPERATIONS) counts.set(op, 0);
  for (const e of entries) counts.set(e.operation, (counts.get(e.operation) ?? 0) + 1);

  const sorted = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const first = sorted[0].timestamp;
  const last = sorted[sorted.length - 1].timestamp;
  const days = Math.max(1, Math.ceil((last.getTime() - first.getTime()) / 86_400_000) + 1);

  console.log(`Activity Log Statistics`);
  console.log(`Log file: .aiwg/activity.log`);
  console.log(
    `Date range: ${formatUtcTimestamp(first).slice(0, 10)} → ${formatUtcTimestamp(last).slice(0, 10)} (${days} day${days === 1 ? '' : 's'})`
  );
  console.log(`Total entries: ${entries.length}`);
  console.log('');
  console.log(`By operation:`);

  // Sort by count desc, then by op name asc for stability
  const ranked = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const maxCount = ranked[0]?.[1] ?? 1;
  for (const [op, n] of ranked) {
    const pct = Math.round((n / entries.length) * 100);
    const barLen = Math.max(1, Math.round((n / maxCount) * 20));
    const bar = '█'.repeat(barLen);
    console.log(`  ${op.padEnd(8)} ${String(n).padStart(3)} ${bar.padEnd(20)} ${pct}%`);
  }
}

interface RotateArgs {
  /** Tail of recent entries to retain inline. Either entry-count or duration. */
  keepLast?: { kind: 'count'; n: number } | { kind: 'duration_ms'; ms: number };
  /** Override archive path (subsystem-relative). Default: archive/activity-log/<timestamp>.log */
  to?: string;
}

async function handleRotate(args: string[]): Promise<void> {
  const opts = parseRotateArgs(args);
  const adapter = await resolveStorage('activity_log');
  const existing = (await adapter.read(LOG_PATH)) ?? '';
  const entries = parseLog(existing);

  if (entries.length === 0) {
    throw new Error(
      'Nothing to rotate: the activity log is empty (or contains no parseable entries).'
    );
  }

  // Decide what stays inline vs what goes to archive
  const sortedAsc = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const { kept, archived } = splitForRotation(sortedAsc, opts.keepLast);

  if (archived.length === 0) {
    throw new Error(
      `Nothing to archive: --keep-last would retain all ${entries.length} entries inline.`
    );
  }

  // Determine archive destination (subsystem-relative)
  const stamp = formatArchiveStamp(new Date());
  const archivePath = opts.to ?? `archive/activity-log/${stamp}.log`;

  // Refuse to overwrite an existing archive
  const existingArchive = await adapter.read(archivePath);
  if (existingArchive !== null) {
    throw new Error(
      `Refusing to overwrite existing archive: ${archivePath}\n` +
        `  Either pass --to <other-path> or remove the existing archive first.`
    );
  }

  // Write archive (full historical content, oldest-first to match log order)
  const archiveBody = archived.map((e) => formatEntry(e)).join('\n') + '\n';
  await adapter.write(archivePath, archiveBody);

  // Rewrite the live log with the retained tail
  const liveBody = kept.length > 0 ? kept.map((e) => formatEntry(e)).join('\n') + '\n' : '';
  await adapter.write(LOG_PATH, liveBody);

  // Append a rotate-record entry to the live log (also exercises the
  // append path so concurrent-write protection still applies).
  const recordSummary = `activity-log rotated, archived ${archived.length} entries to ${archivePath}`;
  if (typeof adapter.append === 'function') {
    await adapter.append(
      LOG_PATH,
      formatEntry({ timestamp: new Date(), operation: 'archive', summary: recordSummary }) + '\n'
    );
  } else {
    const live = (await adapter.read(LOG_PATH)) ?? '';
    const trailing = live.length === 0 || live.endsWith('\n') ? '' : '\n';
    await adapter.write(
      LOG_PATH,
      live +
        trailing +
        formatEntry({ timestamp: new Date(), operation: 'archive', summary: recordSummary }) +
        '\n'
    );
  }

  console.log(`Rotated activity log:`);
  console.log(`  Archived ${archived.length} entr${archived.length === 1 ? 'y' : 'ies'} to ${archivePath}`);
  console.log(`  Retained ${kept.length} entr${kept.length === 1 ? 'y' : 'ies'} inline`);
}

function parseRotateArgs(args: string[]): RotateArgs {
  const opts: RotateArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keep-last') {
      const v = args[++i];
      if (!v) throw new Error(`--keep-last requires a value (e.g., 90d or 1000)`);
      opts.keepLast = parseKeepLast(v);
    } else if (a === '--to') {
      const v = args[++i];
      if (!v) throw new Error(`--to requires a path`);
      opts.to = v;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return opts;
}

function parseKeepLast(raw: string): NonNullable<RotateArgs['keepLast']> {
  const dur = /^(\d+)d$/.exec(raw);
  if (dur) return { kind: 'duration_ms', ms: Number(dur[1]) * 86_400_000 };
  const cnt = /^(\d+)$/.exec(raw);
  if (cnt) {
    const n = Number(cnt[1]);
    if (n <= 0) throw new Error(`--keep-last count must be positive (got ${raw})`);
    return { kind: 'count', n };
  }
  throw new Error(`--keep-last must be <N>d or <N> (got ${JSON.stringify(raw)})`);
}

function splitForRotation(
  sortedAsc: ActivityEntry[],
  keepLast: RotateArgs['keepLast']
): { kept: ActivityEntry[]; archived: ActivityEntry[] } {
  if (!keepLast) {
    return { kept: [], archived: sortedAsc };
  }
  if (keepLast.kind === 'count') {
    if (sortedAsc.length <= keepLast.n) {
      return { kept: [...sortedAsc], archived: [] };
    }
    const cut = sortedAsc.length - keepLast.n;
    return {
      archived: sortedAsc.slice(0, cut),
      kept: sortedAsc.slice(cut),
    };
  }
  // duration_ms
  const cutoff = Date.now() - keepLast.ms;
  const kept: ActivityEntry[] = [];
  const archived: ActivityEntry[] = [];
  for (const e of sortedAsc) {
    if (e.timestamp.getTime() >= cutoff) kept.push(e);
    else archived.push(e);
  }
  return { kept, archived };
}

function formatArchiveStamp(d: Date): string {
  // YYYYMMDD-HHMMSS UTC — sortable, unique to the second
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}-${h}${mi}${s}`;
}

// ── helpers ──────────────────────────────────────────────────────────

async function readEntries(adapter: StorageAdapter): Promise<ActivityEntry[]> {
  const content = await adapter.read(LOG_PATH);
  if (content === null) return [];
  return parseLog(content);
}

function parseShowArgs(args: string[]): ShowArgs {
  const opts: ShowArgs = { limit: DEFAULT_LIMIT };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') {
      const v = args[++i];
      const d = parseUtcDate(v);
      if (!d) throw new Error(`--since must be YYYY-MM-DD (got ${JSON.stringify(v)})`);
      opts.since = d;
    } else if (a === '--operation') {
      const v = args[++i];
      if (!isActivityOperation(v)) {
        throw new Error(
          `--operation must be one of ${ACTIVITY_OPERATIONS.join(', ')} (got ${JSON.stringify(v)})`
        );
      }
      opts.operation = v;
    } else if (a === '--limit') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`--limit must be a positive integer`);
      }
      opts.limit = Math.floor(v);
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: aiwg activity-log <subcommand>

Subcommands:
  show [--since YYYY-MM-DD] [--operation OP] [--limit N]
  append <operation> "<summary>"
  stats
  rotate [--keep-last <Nd|N>] [--to <path>]

Operations: ${ACTIVITY_OPERATIONS.join(', ')}

Examples:
  aiwg activity-log show
  aiwg activity-log show --since 2026-04-01 --operation deploy
  aiwg activity-log show --limit 5
  aiwg activity-log append create ".aiwg/requirements/UC-007 created"
  aiwg activity-log stats
  aiwg activity-log rotate                    # archive everything
  aiwg activity-log rotate --keep-last 90d    # archive entries older than 90 days
  aiwg activity-log rotate --keep-last 1000   # keep last 1000 entries inline

Environment:
  AIWG_SKIP_ACTIVITY_LOG=1   suppress append (per the activity-log rule)

The log persists at .aiwg/activity.log on the default fs backend.
Configure .aiwg/storage.config to route to an external backend (#934).`);
}
