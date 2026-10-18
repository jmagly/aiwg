/**
 * Process Monitor for External Ralph Multi-Loop
 *
 * Monitors multiple loop processes for health, heartbeats, and crash detection.
 * Uses heartbeat mechanism for stale detection and resource monitoring.
 *
 * @implements @.aiwg/requirements/use-cases/UC-273-multi-loop-supervisor.md
 */

import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readlinkSync, readdirSync } from 'fs';
import { hostname } from 'node:os';
import { join, dirname } from 'path';
import { constants } from 'node:fs';
import { open, opendir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createWorkerHealthObserver } from './lib/worker-health.mjs';

// This module is loaded standalone in some contexts (e.g. staged/partial
// installs, or copied in isolation for a test) without its sibling
// tools/_resolve-impl.mjs, or without src/dist/ nearby for it to resolve.
// boundedExecFileSync is only needed by getProcessHealth()'s `ps` sampling
// below; degrade that one feature instead of failing to load this module
// at all for everything else (#3062 finding 1 — regression covered by
// `WS19 staged installed monitor loads with no src/dist or MC state` in
// test/conformance/orchestration-v1/worker-status.test.ts). The
// `../_resolve-impl.mjs` import itself must be dynamic here, not a
// top-level static import: a missing *static* import specifier fails
// module linking before any of this module's own code (including a
// try/catch) ever runs.
//
// Only the specific "this dependency is genuinely missing" error is
// tolerated (#3062 B/C finding 12): a bare `catch {}` here would also
// swallow a real defect in bounded-child-process.mjs itself (a syntax
// error, a thrown assertion, ...) and silently report every live-process
// health query as unavailable instead of surfacing the actual failure.
let boundedExecFileSync = null;
let processHealthUnavailableReason = null;
let importImpl;
try {
  ({ importImpl } = await import('../_resolve-impl.mjs'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== new URL('../_resolve-impl.mjs', import.meta.url).href) throw error;
  processHealthUnavailableReason = 'bounded-child-process helper unavailable: resolver missing (tools/_resolve-impl.mjs)';
}
if (importImpl) {
  try {
    ({ boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs'));
  } catch (error) {
    if (!['AIWG_IMPLEMENTATION_MISSING', 'AIWG_PACKAGE_ROOT_MISSING'].includes(error?.code)) throw error;
    processHealthUnavailableReason = `bounded-child-process helper unavailable: implementation missing: ${error.message}`;
  }
}

/** Side-effect-free Linux sample. Unknown identity never grants signal authority. */
export function sampleWorkerIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const executable = readlinkSync(`/proc/${pid}/exe`);
    if (!Number.isSafeInteger(uid) || !bootId || !fields[19]) return null;
    return { pid, pgid: Number(fields[2]), uid, parentPid: Number(fields[1]), sessionId: Number(fields[3]),
      host: hostname(), bootId, startTicks: fields[19], executable, state: fields[0],
      // /proc stat fields 14/15 are utime/stime; 16/17 are cutime/cstime
      // accumulated for waited-for children, including child-heavy CLIs.
      cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]) };
  } catch { return null; }
}

export function sameWorkerIdentity(expected, actual) {
  return !!expected && !!actual && ['pid', 'pgid', 'uid', 'parentPid', 'sessionId', 'host', 'bootId', 'startTicks', 'executable']
    .every(key => expected[key] === actual[key]);
}

/** A negative PID must name a worker group, never broadcast or select our own. */
export function isSafeWorkerGroupTarget(pgid, supervisor = sampleWorkerIdentity(process.pid)) {
  return Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid
    && (supervisor ? Number.isSafeInteger(supervisor.pgid) && supervisor.pgid >= 0
      && pgid !== supervisor.pgid : process.platform !== 'linux');
}

/** Two matching kernel observations, bounded from the first visible candidate.
 * Pin each candidate's first observed birth; PID reuse can never gain ownership.
 */
export function createWorkerIdentityCapture({ now = () => Number(process.hrtime.bigint()) / 1e6,
  timeoutMs = 250 } = {}) {
  let deadline = null;
  const births = new Map();
  const reused = new Set();
  let previous = null;
  let candidate = null;
  let candidateVisible = false;
  return {
    started: () => deadline !== null,
    expired: () => deadline !== null && now() >= deadline,
    observe(current) {
      if (!current || !Number.isSafeInteger(current.pid) || current.pid <= 0 || !current.startTicks) {
        candidateVisible = false;
        return null;
      }
      const birth = births.get(current.pid);
      if (!birth) births.set(current.pid, { ...current });
      else if (['uid', 'parentPid', 'host', 'bootId', 'startTicks'].some(key => birth[key] !== current[key])) reused.add(current.pid);
      // A fresh identity can open another window, but never clear birth pins.
      if (deadline === null || (now() >= deadline && (!candidateVisible || !sameWorkerIdentity(candidate, current)))) {
        deadline = now() + timeoutMs;
        previous = null;
      }
      candidate = { ...current };
      candidateVisible = true;
      if (reused.has(current.pid) || current.pid !== current.pgid || current.uid !== process.getuid?.()) {
        previous = null;
        return null;
      }
      if (now() >= deadline) return null;
      const stable = sameWorkerIdentity(previous, current);
      previous = { ...current };
      return stable ? current : null;
    },
  };
}

let workerTickRate;
/** Host-qualified conversion, not an assumed Linux HZ constant. */
export function qualifyWorkerCpuTickRate(probe = execFileSync) {
  if (process.platform !== 'linux') return null;
  if (probe === execFileSync && workerTickRate !== undefined) return workerTickRate;
  let rate = null;
  try {
    const getconf = ['/usr/bin/getconf', '/bin/getconf'].find(filename => existsSync(filename));
    if (!getconf) return null;
    const value = Number(String(probe(getconf, ['CLK_TCK'], { timeout: 1000, maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'] })).trim());
    if (Number.isSafeInteger(value) && value > 0 && value <= 1000000) rate = value;
  } catch { /* unavailable conversion stays null */ }
  if (probe === execFileSync) workerTickRate = rate;
  return rate;
}

export function sampleWorkerCpuTime(expected, actual, tickRate, previous = null) {
  if (!sameWorkerIdentity(expected, actual) || !Number.isFinite(tickRate) || tickRate <= 0
    || !Number.isSafeInteger(actual.cpuTicks) || actual.cpuTicks < 0) return { cpuTimeMs: null, deltaMs: null };
  const cpuTimeMs = actual.cpuTicks * 1000 / tickRate;
  const deltaMs = previous && sameWorkerIdentity(expected, previous) && Number.isSafeInteger(previous.cpuTicks)
    && actual.cpuTicks >= previous.cpuTicks ? (actual.cpuTicks - previous.cpuTicks) * 1000 / tickRate : null;
  return { cpuTimeMs, deltaMs };
}

/** A failed/partial process listing is unavailable, never proof of absence. */
export function sampleWorkerGroup(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || process.platform !== 'linux') return null;
  try {
    const members = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const identity = sampleWorkerIdentity(Number(entry));
      // A disappeared process is normal; an inaccessible live member is not.
      if (!identity) {
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
          if (Number(fields[2]) === pgid && fields[0] !== 'Z') return null;
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return null; }
      } else if (identity.pgid === pgid && identity.state !== 'Z') members.push(identity);
    }
    return members;
  } catch { return null; }
}

/** Read /proc/<pid>/cgroup verbatim, for comparing kernel-reported cgroup
 * containment against a systemd unit's own ControlGroup. Side-effect-free;
 * unreadable/absent is null, never a forged match. */
export function sampleProcessCgroup(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
    if (!raw) return null;
    // cgroup v2 (the unified hierarchy systemd --user units use): a single
    // "0::<path>" line. Normalize to the bare path so this compares equal to
    // systemd's own `ControlGroup` property, which omits the "0::" prefix.
    // Falls back to the raw multi-line content on cgroup v1/hybrid hosts.
    const unified = raw.split('\n').find(line => line.startsWith('0::'));
    return unified ? unified.slice(3) : raw;
  } catch { return null; }
}

/** Walk the real /proc ppid chain starting at `pid`, re-sampling each
 * ancestor directly from the kernel. Never trusts a worker-reported
 * parentPid value from a disk record -- each step re-reads /proc/<ppid>
 * itself. Returns null when the starting pid cannot be sampled (unknown
 * ancestry never satisfies a containment check); stops at pid 1 or
 * `maxDepth` ancestors. */
export function sampleProcessAncestry(pid, maxDepth = 32) {
  let current = sampleWorkerIdentity(pid);
  if (!current) return null;
  const chain = [current];
  let steps = 0;
  while (current.pid !== 1 && steps < maxDepth) {
    const next = sampleWorkerIdentity(current.parentPid);
    if (!next || next.pid === current.pid) break;
    chain.push(next);
    current = next;
    steps += 1;
  }
  return chain;
}

/** Sample only the children of a known native transport supervisor. */
export function sampleWorkerChildren(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/)
      .filter(Boolean).map(value => sampleWorkerIdentity(Number(value))).filter(Boolean);
  } catch { return null; }
}

/**
 * @typedef {Object} ProcessHealth
 * @property {number} pid - Process ID
 * @property {number} cpu - CPU usage percentage
 * @property {number} memory - Resident memory usage in MiB
 * @property {number} uptime - Process uptime in seconds
 * @property {string} status - Process status (running, zombie, sleeping)
 */

/**
 * @typedef {Object} HeartbeatRecord
 * @property {string} loopId - Loop identifier
 * @property {number} timestamp - Heartbeat timestamp
 * @property {number} iteration - Current iteration number
 * @property {string} status - Loop status
 */

export class ProcessMonitor extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.projectRoot - Project root directory
   * @param {number} [config.heartbeatIntervalMs=30000] - Heartbeat check interval
   * @param {number} [config.staleThresholdMs=60000] - Stale detection threshold
   */
  constructor(config) {
    super();
    this.projectRoot = config.projectRoot;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 30000; // 30 seconds
    this.staleThresholdMs = config.staleThresholdMs || 60000; // 1 minute

    this.heartbeatDir = join(this.projectRoot, '.aiwg', 'ralph', 'heartbeats');
    this.monitoredLoops = new Map(); // loopId -> { pid, lastCheck }
    this.heartbeatTimer = null;

    // Ensure heartbeat directory exists
    mkdirSync(this.heartbeatDir, { recursive: true });
  }

  /**
   * Start monitoring loop processes
   * @param {string[]} loopIds - Loop IDs to monitor
   */
  startMonitoring(loopIds) {
    // Initialize monitoring for each loop
    for (const loopId of loopIds) {
      const stateFile = join(
        this.projectRoot,
        '.aiwg',
        'ralph',
        'loops',
        loopId,
        'state.json'
      );

      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        this.monitoredLoops.set(loopId, {
          pid: state.currentPid,
          lastCheck: Date.now(),
        });
      }
    }

    // Start heartbeat monitoring
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(
        () => this.checkAllHeartbeats(),
        this.heartbeatIntervalMs
      );
    }
  }

  /**
   * Stop monitoring a specific loop
   * @param {string} loopId - Loop ID to stop monitoring
   */
  stopMonitoring(loopId) {
    this.monitoredLoops.delete(loopId);

    // Stop timer if no loops are monitored
    if (this.monitoredLoops.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Check if a process is still alive
   * @param {number} pid - Process ID
   * @returns {boolean}
   */
  isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      // Signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH = No such process
      if (error.code === 'ESRCH') {
        return false;
      }
      // EPERM = Process exists but no permission to signal
      if (error.code === 'EPERM') {
        return true;
      }
      // Other errors, assume dead
      return false;
    }
  }

  /**
   * Get process health metrics
   * @param {string} loopId - Loop ID
   * @returns {ProcessHealth|null}
   */
  getProcessHealth(loopId) {
    const monitoring = this.monitoredLoops.get(loopId);
    if (!monitoring || !monitoring.pid) {
      return null;
    }

    const pid = monitoring.pid;

    if (!this.isProcessAlive(pid)) {
      return {
        pid,
        cpu: 0,
        memory: 0,
        uptime: 0,
        status: 'dead',
      };
    }

    if (!boundedExecFileSync) {
      // #3062 B/C finding 12: surface *why* no metrics are available
      // (module header) instead of returning a bare `null` indistinguishable
      // from "process not monitored"/"ps produced nothing useful".
      return { pid, cpu: null, memory: null, uptime: null, status: 'unavailable', unavailableReason: processHealthUnavailableReason };
    }

    try {
      // Use ps command to get process stats
      // RSS is reported in KiB; unlike %mem it does not lose small readings
      // to percentage rounding or require an assumed host memory capacity.
      const output = boundedExecFileSync(
        'ps', ['-p', String(pid), '-o', '%cpu,rss,etime,stat', '--no-headers'],
        'quick',
        { encoding: 'utf8' }
      ).trim();

      if (!output) {
        return null;
      }

      const parts = output.split(/\s+/);
      if (parts.length !== 4 || !/^\d+(?:\.\d+)?$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        return null;
      }
      const cpu = Number(parts[0]);
      const rssKiB = Number(parts[1]);
      if (!Number.isFinite(cpu) || !Number.isSafeInteger(rssKiB)) return null;
      const etime = parts[2];
      const stat = parts[3];

      // Parse uptime (format: [[dd-]hh:]mm:ss or mm:ss)
      const uptime = this.parseUptime(etime);
      if (!Number.isFinite(uptime) || uptime < 0) return null;

      const memory = rssKiB / 1024;

      // Parse status
      const status = this.parseStatus(stat);

      return {
        pid,
        cpu,
        memory,
        uptime,
        status,
      };
    } catch (error) {
      // Process may have died between isAlive check and ps call
      return null;
    }
  }

  /**
   * Parse uptime from ps etime format
   * @param {string} etime - Elapsed time string
   * @returns {number} - Uptime in seconds
   */
  parseUptime(etime) {
    // Format: [[dd-]hh:]mm:ss
    let seconds = 0;

    // Handle days
    if (etime.includes('-')) {
      const [days, rest] = etime.split('-');
      seconds += parseInt(days, 10) * 86400;
      etime = rest;
    }

    const parts = etime.split(':').map(p => parseInt(p, 10));

    if (parts.length === 3) {
      // hh:mm:ss
      seconds += parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      // mm:ss
      seconds += parts[0] * 60 + parts[1];
    } else {
      // Just seconds
      seconds += parts[0];
    }

    return seconds;
  }

  /**
   * Parse process status from ps stat field
   * @param {string} stat - Status field from ps
   * @returns {string} - Human-readable status
   */
  parseStatus(stat) {
    const statusChar = stat.charAt(0);

    const statusMap = {
      R: 'running',
      S: 'sleeping',
      D: 'disk-wait',
      Z: 'zombie',
      T: 'stopped',
      t: 'tracing-stop',
      W: 'paging',
      X: 'dead',
      x: 'dead',
      K: 'wakekill',
      P: 'parked',
    };

    return statusMap[statusChar] || 'unknown';
  }

  /**
   * Record heartbeat for a loop
   * @param {string} loopId - Loop ID
   * @param {Object} data - Heartbeat data
   */
  recordHeartbeat(loopId, data = {}) {
    const heartbeat = {
      loopId,
      timestamp: Date.now(),
      iteration: data.iteration || 0,
      status: data.status || 'running',
    };

    const heartbeatFile = join(this.heartbeatDir, `${loopId}.json`);
    writeFileSync(heartbeatFile, JSON.stringify(heartbeat, null, 2));
  }

  /**
   * Get last heartbeat for a loop
   * @param {string} loopId - Loop ID
   * @returns {HeartbeatRecord|null}
   */
  getLastHeartbeat(loopId) {
    const heartbeatFile = join(this.heartbeatDir, `${loopId}.json`);

    if (!existsSync(heartbeatFile)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(heartbeatFile, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Check if a loop's heartbeat is stale
   * @param {string} loopId - Loop ID
   * @param {number} [thresholdMs] - Stale threshold in milliseconds
   * @returns {boolean}
   */
  isStale(loopId, thresholdMs = this.staleThresholdMs) {
    const heartbeat = this.getLastHeartbeat(loopId);

    if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)
      || !Number.isFinite(heartbeat.timestamp)) {
      // Missing or malformed records cannot establish freshness. Numeric
      // strings are invalid too: recordHeartbeat writes a numeric timestamp.
      return true;
    }

    const age = Date.now() - heartbeat.timestamp;
    return age > thresholdMs;
  }

  /**
   * Check all monitored loops for heartbeat staleness
   */
  checkAllHeartbeats() {
    for (const [loopId, monitoring] of this.monitoredLoops.entries()) {
      // Check if process is alive
      if (monitoring.pid && !this.isProcessAlive(monitoring.pid)) {
        this.emit('crash', {
          loopId,
          pid: monitoring.pid,
          reason: 'process_died',
        });
        continue;
      }

      // Check if heartbeat is stale
      if (this.isStale(loopId)) {
        this.emit('stale', {
          loopId,
          pid: monitoring.pid,
          lastHeartbeat: this.getLastHeartbeat(loopId),
        });
      }
    }
  }

  /**
   * Get all monitored loop IDs
   * @returns {string[]}
   */
  getMonitoredLoops() {
    return Array.from(this.monitoredLoops.keys());
  }

  /**
   * Stop all monitoring
   */
  stopAll() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.monitoredLoops.clear();
  }
}

export default ProcessMonitor;

const STATUS_LIMITS = Object.freeze({ directories: 256, recordBytes: 65536, files: 32, sampleMs: 5000 });
const HEALTH_STATES = new Set(['launching', 'started', 'active', 'quiet', 'stalled', 'hung', 'failed-to-start', 'completed', 'failed', 'cancelled', 'crashed']);
const STATUS_SIGNALS = new Set(['semantic-start', 'semantic-progress', 'steps', 'observer-continuity', 'cpu', 'worktree-content',
  'monotonic-clock', 'semantic-progress-history', 'process-identity', 'request-identity', 'enforced-deadline', 'confirmed-stop']);
const safeLabel = value => typeof value === 'string' && /^[\p{L}\p{N}_.:/@+~%\-]{1,256}$/u.test(value) ? value : null;
const statusError = code => Object.assign(new Error(code), { statusCode: code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const healthSeverity = state => ['hung', 'failed-to-start', 'failed', 'cancelled', 'crashed'].includes(state) ? 4
  : state === 'stalled' ? 3 : state === 'quiet' ? 2 : ['launching', 'started'].includes(state) ? 1 : 0;
const coverageSeverity = coverage => coverage === 'full' ? 0 : coverage === 'degraded' ? 1 : 2;

function statusObserverOwnership(ownerRecord, actual, bootId) {
  const expected = ownerRecord?.observer;
  return !ownerRecord ? 'unreserved' : safeLabel(ownerRecord.owner) && expected?.uid === process.getuid()
    && sameWorkerIdentity(expected, actual) && actual.bootId === bootId && !['Z', 'X', 'x'].includes(actual.state)
    ? 'active' : 'unavailable';
}

/** Pin every ancestor before use, including the selection root. Linux's fd
 * paths keep a concurrent rename from redirecting reads or scratch writes. */
async function openStatusDirectory(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')
    || Buffer.byteLength(filename) > 4096 || filename.split('/').length > 256
    || filename.split('/').some(part => part === '..' || part === '.')) throw statusError('UNSAFE_PATH');
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of filename.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const stat = await directory.stat();
    if (stat.uid !== process.getuid() || stat.mode & 0o077) throw statusError('NONPRIVATE_DIRECTORY');
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

async function openStatusChild(root, name) {
  const directory = await open(`/proc/self/fd/${root.fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await directory.stat();
  if (stat.uid !== process.getuid() || stat.mode & 0o077) { await directory.close(); throw statusError('NONPRIVATE_DIRECTORY'); }
  return directory;
}

async function statusRecord(directory, name, required = false) {
  let handle;
  try {
    handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) throw statusError('UNSAFE_RECORD');
    if (stat.size > STATUS_LIMITS.recordBytes) throw statusError('RECORD_TOO_LARGE');
    const bytes = Buffer.alloc(STATUS_LIMITS.recordBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > STATUS_LIMITS.recordBytes) throw statusError('RECORD_TOO_LARGE');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw statusError('MALFORMED_RECORD'); }
    if (!object(value)) throw statusError('MALFORMED_RECORD');
    return value;
  } catch (error) { if (!required && error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

async function boundedEntries(directory, max) {
  const listing = await opendir(`/proc/self/fd/${directory.fd}`);
  const entries = [];
  try {
    while (entries.length <= max) {
      const entry = await listing.read();
      if (!entry) return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), complete: true };
      entries.push(entry);
    }
    return { entries: entries.slice(0, max).sort((a, b) => a.name.localeCompare(b.name)), complete: false };
  } finally { await listing.close(); }
}

function validHealthHistory(health, launchTime, now) {
  if (!object(health) || !HEALTH_STATES.has(health.state) || !['semantic', 'process-only', 'unobserved'].includes(health.handshake)
    || !['full', 'degraded', 'unobserved'].includes(health.coverage)) return false;
  if (health.coverage === 'full' && health.lastObservedAt == null
    || health.handshake !== 'unobserved' && health.handshakeAt == null) return false;
  for (const key of ['lastObservedAt', 'lastActivityAt', 'lastProgressAt', 'handshakeAt', 'stalledAt']) {
    if (health[key] != null && (!Number.isFinite(Date.parse(health[key])) || Date.parse(health[key]) < launchTime || Date.parse(health[key]) > now)) return false;
  }
  return ['observerGeneration', 'transitionCount', 'maxCheckGapSeconds'].every(key => health[key] == null
    || Number.isFinite(health[key]) && health[key] >= 0 && health[key] <= 1000000)
    && (health.unavailableSignals == null || Array.isArray(health.unavailableSignals) && health.unavailableSignals.length <= 32
      && health.unavailableSignals.every(item => STATUS_SIGNALS.has(item)));
}

/** Pure projection shared with attached/bridge callers. It grants no process
 * control or acceptance authority; all disk evidence remains recorded evidence.
 * @returns {import('../../src/mission-protocol/worker-status.js').WorkerStatusRow} */
export function classifyWorkerStatus(records, facts = {}) {
  const { invocation, process: identity, health: healthRecord, exit, scratch } = records;
  const now = facts.now ?? Date.now();
  const id = safeLabel(invocation?.invocationId ?? identity?.invocationId);
  if (!id) throw statusError('INVOCATION_ID_MISSING');
  for (const record of [identity, healthRecord, exit]) {
    if (record && record.invocationId !== id) throw statusError('INVOCATION_MISMATCH');
  }
  const transport = invocation?.transport ?? (identity?.request ? 'mcp' : 'shell');
  if (!['shell', 'mcp', 'http'].includes(transport)) throw statusError('INVALID_TRANSPORT');
  const expected = identity?.worker;
  // A 'transport-reported-unverified' worker is a diagnostic guess, never
  // kernel-verified ownership (see session-launcher.mjs finish()). Treating
  // it as `expected` for live-identity comparison would let a forged or
  // merely unlucky worker record manufacture a mismatch against
  // `facts.actual` and downgrade an otherwise kernel-confirmed exit to
  // uncertain/IDENTITY_CHANGED. There is nothing reliable to compare
  // against, so suppress the signal entirely rather than risk a false
  // mismatch.
  const actual = identity?.identityObservation === 'transport-reported-unverified' ? null : facts.actual ?? null;
  const matched = transport !== 'mcp' && expected?.uid === process.getuid() && sameWorkerIdentity(expected, actual)
    && (facts.bootId == null || actual.bootId === facts.bootId);
  const running = matched ? !['Z', 'X', 'x'].includes(actual.state) : null;
  const requestBound = transport !== 'mcp' || !!safeLabel(identity?.request?.requestId);
  const boot = facts.bootId ?? actual?.bootId;
  const base = typeof identity?.monotonicStart === 'string' && /^\d{1,24}$/.test(identity.monotonicStart)
    ? Number(BigInt(identity.monotonicStart)) / 1e6 : NaN;
  const current = facts.monotonicNow ?? monotonicMs();
  const launchTime = Date.parse(identity?.launchTime);
  const clocksKnown = boot && [expected?.bootId, identity?.supervisor?.bootId].includes(boot)
    && Number.isFinite(base) && base <= current && Number.isFinite(launchTime) && launchTime <= now;
  const elapsedSeconds = clocksKnown ? (current - base) / 1000 : null;
  const timestampBound = clocksKnown ? Math.min(now, launchTime + current - base) : now;
  let effective = invocation?.health ?? null;
  if (effective) {
    const fields = ['startupSeconds', 'checkSeconds', 'quietSeconds', 'stallSeconds', 'diagnosticGraceSeconds', 'terminateGraceSeconds', 'hardTimeoutSeconds', 'maxSteps'];
    if (fields.some(key => !Number.isFinite(effective[key]) || effective[key] <= 0)
      || effective.quietSeconds >= effective.stallSeconds || effective.checkSeconds > effective.startupSeconds
      || effective.hardTimeoutSeconds > 86400 || !['native', 'external', 'observed', 'unavailable'].includes(effective.stepEnforcement)) throw statusError('INVALID_THRESHOLDS');
    const allowed = ['version', ...fields, 'stepEnforcement', 'scale', 'profileRef', 'runDir', 'origins', 'truncatedWindows'];
    if (!object(effective) || Object.keys(effective).some(key => !allowed.includes(key))) throw statusError('INVALID_THRESHOLDS');
    if (effective.version !== 1 || !Number.isFinite(effective.scale) || effective.scale < 1 || effective.scale > 6
      || !safeLabel(effective.profileRef) || !Number.isInteger(effective.maxSteps) || effective.maxSteps > 10000
      || effective.truncatedWindows && (!Array.isArray(effective.truncatedWindows)
        || effective.truncatedWindows.length > 3 || effective.truncatedWindows.some(window => !['startup', 'quiet', 'stall'].includes(window)))) throw statusError('INVALID_THRESHOLDS');
    if (invocation.selected?.profileRef && effective.profileRef !== invocation.selected.profileRef) throw statusError('PROFILE_MISMATCH');
    effective = { ...effective, profileRef: safeLabel(effective.profileRef), runDir: null };
    if (effective.origins && (!object(effective.origins) || Object.keys(effective.origins).some(key => !allowed.includes(key)) || Object.values(effective.origins).some(value =>
      !Array.isArray(value) || value.length > 8 || value.some(item => !safeLabel(item))))) throw statusError('INVALID_THRESHOLDS');
  }
  let history = healthRecord?.origin === 'observer' ? healthRecord.health : null;
  const observerOwnership = statusObserverOwnership(facts.ownerRecord, facts.actualObserver, boot);
  const scratchTrusted = scratch && observerOwnership === 'active' && scratch.owner === facts.ownerRecord.owner
    && scratch.invocationId === id && validHealthHistory(scratch.health, launchTime, timestampBound);
  const findings = scratch && !scratchTrusted ? ['OBSERVER_HISTORY_UNTRUSTED: ignored scratch without matching live observer ownership'] : [];
  // Scratch is never launch/exit authority and may not improve live health.
  let usingScratch = false;
  if (scratchTrusted && (!history || Date.parse(scratch.health.lastObservedAt) > Date.parse(history.lastObservedAt))) {
    history = scratch.health; usingScratch = true;
  }
  if (validHealthHistory(facts.previous?.health, launchTime, timestampBound)
    && (!history || Date.parse(facts.previous.health.lastObservedAt) > Date.parse(history.lastObservedAt))) history = facts.previous.health;
  const canUseExit = exit?.termination === 'confirmed' && running !== true && (!actual || matched) && requestBound;
  if (canUseExit && validHealthHistory(exit.health, launchTime, timestampBound)) history = exit.health;
  const historyValid = clocksKnown && validHealthHistory(history, launchTime, timestampBound);
  const endTime = Date.parse(exit?.endedAt);
  const endKnown = clocksKnown && Number.isFinite(endTime) && endTime >= launchTime && endTime <= timestampBound;
  let observationTime = current;
  const observer = createWorkerHealthObserver({ invocationId: id, transport,
    health: { coverage: historyValid ? history.coverage : 'unobserved',
      handshake: historyValid ? history.handshake : 'unobserved', progressEvidence: historyValid && history.handshake === 'semantic' ? ['recorded'] : [] },
    effectiveHealth: effective ?? undefined, startedAt: clocksKnown ? base : current,
    launchTime: clocksKnown ? identity.launchTime : new Date(now).toISOString(),
    now: () => observationTime, wallNow: () => now, initialSnapshot: historyValid ? { ...history,
      state: ['completed', 'failed', 'cancelled', 'crashed'].includes(history.state) ? 'started' : history.state } : undefined });
  if (historyValid && matched) observer.processStarted(actual);
  const prior = facts.previous;
  if (prior && matched) observer.sampleActivity({ running, cpu: prior.cpuTicks });
  observer.sampleActivity({ running, cpu: matched ? actual.cpuTicks : null });
  if (prior?.counters?.stdoutBytes !== null && facts.counters?.stdoutBytes > prior?.counters?.stdoutBytes
    || prior?.counters?.stderrBytes !== null && facts.counters?.stderrBytes > prior?.counters?.stderrBytes) observer.observe({ kind: 'activity' });
  let health = canUseExit && endKnown ? observer.snapshot() : observer.check();
  let termination = running === true ? 'running' : 'uncertain', exitCode = null, terminal = false;
  if (exit) {
    if (!(exit.exitCode === null || Number.isInteger(exit.exitCode) && exit.exitCode >= 0 && exit.exitCode <= 255)
      || !['confirmed', 'uncertain'].includes(exit.termination)) throw statusError('INVALID_EXIT');
    exitCode = exit.exitCode;
    // A reused or still-live PID cannot be hidden by a forged stop record.
    if (running === true || actual && !matched) {
      termination = 'uncertain'; observer.gap('IDENTITY_CHANGED');
      health = observer.snapshot(); health.reasonCode = 'IDENTITY_CHANGED';
    }
    if (running !== true && (!actual || matched) && requestBound && exit.termination === 'confirmed') {
      termination = 'confirmed'; terminal = true;
      if (endKnown) {
        // Report the wait owner's end time, not the later query time. A query
        // after a deadline cannot turn an earlier completion into a timeout.
        observationTime = base + endTime - launchTime;
        if (transport === 'mcp' && exit.health?.state === 'completed') observer.observe({ kind: 'terminal', success: true });
        health = observer.finish({ termination, exitCode, cancelled: exit.cancelled === true, timedOut: exit.timedOut === true,
          signal: exit.signal ?? null, finalValid: historyValid && exit.health?.state === 'completed', errorCode: exit.errorCode });
      } else { health.coverage = 'unobserved'; health.reasonCode = 'OBSERVER_GAP'; }
    }
  }
  health.termination = termination;
  if (!clocksKnown) {
    health.startupDeadlineAt = null; health.hardDeadlineAt = null;
    health.coverage = 'unobserved'; health.unavailableSignals.push('monotonic-clock');
  }
  if (!historyValid) health.unavailableSignals.push('semantic-progress-history');
  if (!requestBound) { health.coverage = 'degraded'; health.unavailableSignals.push('request-identity'); }
  if (expected?.pid && !matched) health.unavailableSignals.push('process-identity');
  if (facts.cpuTimeMs == null) health.unavailableSignals.push('cpu');
  let baseline;
  if (usingScratch) {
    baseline = classifyWorkerStatus({ ...records, scratch: null }, facts);
    if (baseline.terminal || healthSeverity(baseline.health.state) > healthSeverity(health.state)) health = { ...baseline.health };
    if (coverageSeverity(baseline.health.coverage) > coverageSeverity(health.coverage)) health.coverage = baseline.health.coverage;
    // Do not launder newer scratch progress/activity into the next watch tick.
    for (const key of ['lastProgressAt', 'lastActivityAt', 'handshake', 'handshakeAt']) health[key] = baseline.health[key];
    health.unavailableSignals.push(...baseline.health.unavailableSignals);
  }
  if (findings.length) {
    if (health.coverage === 'full') health.coverage = 'degraded';
    health.unavailableSignals.push('observer-continuity');
  }
  health.unavailableSignals = [...new Set(health.unavailableSignals)].slice(0, 32);
  const age = value => clocksKnown && value != null && Number.isFinite(Date.parse(value))
    ? Math.max(0, (current - base - (Date.parse(value) - launchTime)) / 1000) : null;
  const remainingSeconds = effective && elapsedSeconds !== null ? Math.max(0, effective.hardTimeoutSeconds - elapsedSeconds) : null;
  const action = health.reasonCode === 'HARD_DEADLINE' ? 'CHECK_DEADLINE'
    : ['failed', 'cancelled', 'crashed', 'failed-to-start', 'hung', 'stalled'].includes(health.state) ? 'DIAGNOSE_WORKER'
      : health.coverage !== 'full' || termination !== 'confirmed' && !matched && transport !== 'mcp' ? 'RESTORE_OBSERVATION' : 'NONE';
  const counters = facts.counters ?? { stdoutBytes: null, stderrBytes: null };
  return { invocationId: id, task: safeLabel(invocation?.taskId ?? invocation?.taskDigest),
    member: safeLabel(invocation?.selected?.member), transport,
    identity: { pid: matched ? actual.pid : null, pgid: matched ? actual.pgid : null,
      requestId: transport === 'mcp' ? safeLabel(identity?.request?.requestId) : null, source: matched ? 'kernel' : 'recorded' },
    health, thresholds: effective, elapsedSeconds, remainingSeconds,
    ages: { observationSeconds: baseline && health.lastObservedAt === baseline.health.lastObservedAt
      ? baseline.ages.observationSeconds : age(historyValid ? history.lastObservedAt : null),
      activitySeconds: age(health.lastActivityAt), progressSeconds: age(health.lastProgressAt) },
    counters: { ...counters, cpuTimeMs: facts.cpuTimeMs ?? null, exitCode,
      available: { stdout: counters.stdoutBytes !== null, stderr: counters.stderrBytes !== null, cpu: facts.cpuTimeMs != null, exit: exitCode !== null } },
    nextAction: action, terminal, termination, verification: null, evidence: 'recorded', observerOwnership, findings, error: null };
}

async function captureSizes(directory) {
  const sizes = {};
  for (const [key, names] of Object.entries({ stdoutBytes: ['stdout.events.jsonl', 'stdout.log'], stderrBytes: ['stderr.log'] })) {
    sizes[key] = null;
    for (const name of names) {
      let handle;
      try {
        handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) throw statusError('UNSAFE_CAPTURE');
        if (stat.size > 10485760) throw statusError('CAPTURE_TOO_LARGE');
        sizes[key] = stat.size; break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { await handle?.close(); }
    }
  }
  return sizes;
}

/** Readers never create a monitor, walk a worktree or execute a subprocess. */
export async function sampleWorkerStatus(options, memory = new Map()) {
  const now = options.now?.() ?? Date.now(), sampledAt = new Date(now).toISOString();
  const began = monotonicMs();
  const report = { version: 1, sampledAt, scope: 'direct-conductor', observerCoverage: 'unobserved',
    workers: [], breakers: [], nextCheckAt: null, complete: true, findings: [], exitCode: 0 };
  let root;
  try {
    root = await openStatusDirectory(options.runDir ?? options.runsRoot);
    const listing = options.runDir ? { entries: [{ name: null }], complete: true }
      : await boundedEntries(root, STATUS_LIMITS.directories);
    report.complete = listing.complete;
    if (!listing.complete) { report.findings.push('SELECTION_LIMIT: narrow --runs-root'); report.exitCode = 2; }
    const sampleTime = options.monotonicNow?.() ?? monotonicMs();
    const bootId = options.bootId ?? (() => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
    for (const entry of listing.entries) {
      if (monotonicMs() - began >= STATUS_LIMITS.sampleMs) {
        report.complete = false; report.findings.push('SAMPLE_BUDGET: narrow selection'); if (report.exitCode !== 1) report.exitCode = 2; break;
      }
      let directory;
      try {
        directory = entry.name === null ? root : await openStatusChild(root, entry.name);
        if (!(await boundedEntries(directory, STATUS_LIMITS.files)).complete) throw statusError('FILE_LIMIT');
        const records = { invocation: await statusRecord(directory, 'invocation.json'),
          process: await statusRecord(directory, 'process.json', true), health: await statusRecord(directory, 'health.json'),
          exit: await statusRecord(directory, 'exit.json'), scratch: await statusRecord(directory, 'last-observed.json') };
        const ownerRecord = await statusRecord(directory, '.status-observer');
        const expected = records.process.worker;
        // classifyWorkerStatus() also ignores an unverified worker for this
        // comparison; skip the resample too so this never samples an
        // unrelated process merely because a diagnostic record named its PID.
        const actual = records.process.identityObservation !== 'transport-reported-unverified'
          && records.invocation?.transport !== 'mcp' && !records.process.request && expected?.uid === process.getuid()
          ? (options.sampleIdentity ?? sampleWorkerIdentity)(expected.pid) : null;
        const key = records.process.invocationId;
        const counters = await captureSizes(directory);
        const ownerIdentity = ownerRecord?.observer;
        const actualObserver = ownerIdentity?.uid === process.getuid()
          ? (options.sampleIdentity ?? sampleWorkerIdentity)(ownerIdentity.pid) : null;
        const row = classifyWorkerStatus(records, { now, monotonicNow: sampleTime, bootId, actual, counters,
          previous: memory.get(key), ownerRecord, actualObserver });
        report.findings.push(...row.findings.map(finding => `${row.invocationId}: ${finding}`));
        if (row.observerOwnership === 'unavailable') report.findings.push('OBSERVER_OWNER_UNAVAILABLE: reconcile reservation before observing');
        memory.set(key, { cpuTicks: actual?.cpuTicks ?? null, counters, health: row.health });
        if (memory.size > STATUS_LIMITS.directories) memory.delete(memory.keys().next().value);
        report.workers.push(row);
        if (options.observation) {
          try { await options.observation.write(directory, row, sampledAt); }
          catch (error) {
            report.complete = false; report.exitCode = 1;
            const code = safeLabel(error.statusCode ?? error.code) ?? 'OBSERVATION_WRITE_FAILURE';
            row.findings.push(code); report.findings.push(`${row.invocationId}: ${code}`);
          }
        }
        if (monotonicMs() - began >= STATUS_LIMITS.sampleMs) {
          report.complete = false; report.findings.push('SAMPLE_OVERRUN: observation unavailable; narrow selection');
          row.health.coverage = 'degraded'; row.health.unavailableSignals.push('observer-continuity'); row.nextAction = 'RESTORE_OBSERVATION';
        }
        if (row.nextAction !== 'NONE') report.exitCode = report.exitCode === 1 ? 1 : 2;
      } catch (error) {
        report.complete = false; report.exitCode = 1;
        report.workers.push({ invocationId: null, task: null, member: null, transport: null,
          error: { code: safeLabel(error.statusCode ?? error.code) ?? 'READ_FAILURE' }, nextAction: 'REPAIR_RUN_METADATA', terminal: false });
      } finally { if (directory && directory !== root) await directory.close(); }
    }
    if (!listing.entries.length) report.findings.push('EMPTY_ROOT: no recorded workers; no-dir workers require conductor-context sampling');
    report.observerCoverage = report.workers.length && report.workers.every(row => row.health?.coverage === 'full') ? 'full'
      : report.workers.some(row => row.health?.coverage !== 'unobserved' && row.health) ? 'degraded' : 'unobserved';
    const checks = report.workers.filter(row => row.thresholds && !row.terminal).map(row => {
      const delays = [row.thresholds.checkSeconds, row.remainingSeconds,
        row.thresholds.startupSeconds - row.elapsedSeconds,
        row.thresholds.quietSeconds - row.ages.activitySeconds, row.thresholds.stallSeconds - row.ages.progressSeconds]
        .filter(value => Number.isFinite(value) && value > 0);
      return Math.min(...delays);
    });
    if (checks.length) report.nextCheckAt = new Date(now + Math.min(...checks) * 1000).toISOString();
    // Tier 0 has no shared breaker authority. Empty is explicit; never infer
    // provider-wide suspension or rewrite a managed lease from this query.
    return report;
  } catch (error) {
    report.complete = false; report.exitCode = 1;
    report.findings.push(safeLabel(error.statusCode ?? error.code) ?? 'READ_FAILURE'); return report;
  } finally { await root?.close(); }
}

/** Exclusive scratch owner; all temporary files are private owner scratch.
 * Existing launcher evidence, leases and worker files are never overwritten. */
export function createStatusObservationOwner() {
  const owner = randomUUID(), reservations = new Map();
  return {
    async write(directory, row, sampledAt) {
      const stat = await directory.stat(), key = `${stat.dev}:${stat.ino}`;
      if (!reservations.has(key)) {
        const lockPath = `/proc/self/fd/${directory.fd}/.status-observer`;
        let lock;
        try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw statusError('OBSERVER_BUSY'); throw error; }
        const pinned = await open(`/proc/self/fd/${directory.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
        reservations.set(key, { directory: pinned, lock, sequence: 0 });
        await lock.writeFile(JSON.stringify({ owner, observer: sampleWorkerIdentity(process.pid) }));
      }
      const reservation = reservations.get(key);
      const base = `/proc/self/fd/${reservation.directory.fd}`;
      const temporary = `${base}/.last-observed-${owner}`;
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let published = false;
      try {
        await file.writeFile(JSON.stringify({ version: 1, owner, sequence: ++reservation.sequence,
          invocationId: row.invocationId, sampledAt, health: row.health, counters: row.counters }));
        await file.sync();
        await file.close();
        await rename(temporary, `${base}/last-observed.json`); published = true;
      } finally {
        await file.close();
        if (!published) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
    async close() {
      for (const { directory, lock } of reservations.values()) {
        try {
          const ownerFile = await statusRecord(directory, '.status-observer');
          if (ownerFile?.owner === owner) await unlink(`/proc/self/fd/${directory.fd}/.status-observer`);
        } finally { await lock.close(); await directory.close(); }
      }
      reservations.clear();
    },
  };
}

export function formatWorkerStatus(report) {
  const label = value => value == null ? '?' : String(value);
  const seconds = value => value == null ? '?' : `${Math.round(value * 1000) / 1000}s`;
  return [`Workers (${report.scope}) coverage=${report.observerCoverage} complete=${report.complete} breakers=${report.breakers.length} (no shared Tier 0 breaker authority)`,
    'invocation | member | state | coverage | age | last progress | remaining | cause | next action',
    ...report.workers.map(row => row.error ? `? | ? | unreadable | ? | ? | ? | ? | ${row.error.code} | ${row.nextAction}`
      : `${row.invocationId} | ${label(row.member)} | ${row.health.state} | ${row.health.coverage} | ${seconds(row.elapsedSeconds)} | ${seconds(row.ages.progressSeconds)} | ${seconds(row.remainingSeconds)} | ${row.health.reasonCode} | ${row.nextAction}\n`
        + `  thresholds=${JSON.stringify(row.thresholds)} termination=${row.termination} verification=${label(row.verification)} observer-gap=${row.health.maxCheckGapSeconds}s`),
    ...report.findings, `next check=${label(report.nextCheckAt)}`].join('\n');
}

/** One bounded foreground loop. Timeout only stops watching, never the worker. */
export async function watchWorkerStatus(options, dependencies = {}) {
  const monotonic = dependencies.monotonicNow ?? monotonicMs;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const emit = dependencies.emit ?? (report => console.log(options.json ? JSON.stringify(report) : formatWorkerStatus(report)));
  const sample = dependencies.sample ?? sampleWorkerStatus;
  const started = monotonic(), end = started + (options.deadlineSeconds ?? 0) * 1000;
  if (options.watch && (!Number.isFinite(options.deadlineSeconds) || options.deadlineSeconds <= 0 || options.deadlineSeconds > 86400)) throw statusError('FINITE_WATCH_DEADLINE_REQUIRED');
  if (options.observe && !options.watch) throw statusError('OBSERVE_REQUIRES_WATCH');
  const maxSamples = options.watch ? Math.ceil(options.deadlineSeconds) + 1 : 1;
  let samples = 0;
  const memory = new Map(), observation = options.observe ? createStatusObservationOwner() : null;
  let report;
  try {
    do {
      report = await sample({ ...options, observation }, memory);
      samples++;
      report.watch = options.watch ? { remainingSeconds: Math.max(0, (end - monotonic()) / 1000),
        expired: monotonic() >= end } : null;
      const sampleLimit = options.watch && samples >= maxSamples && monotonic() < end;
      if (sampleLimit) {
        report.complete = false; (report.findings ??= []).push('WATCH_SAMPLE_LIMIT: sampling stopped');
        if (report.exitCode !== 1) report.exitCode = 2;
      }
      await emit(report);
      if (!options.watch || sampleLimit || report.exitCode === 1 || report.complete && report.workers.every(row => row.terminal) || monotonic() >= end) return report.exitCode;
      const checks = report.workers.filter(row => !row.terminal).map(row => row.thresholds?.checkSeconds * 1000)
        .filter(value => Number.isFinite(value) && value > 0);
      const resolvedCadence = checks.length ? Math.min(...checks) : 15000;
      const nextDelay = report.nextCheckAt ? Date.parse(report.nextCheckAt) - Date.parse(report.sampledAt) : resolvedCadence;
      const cadence = Math.max(1000, resolvedCadence, Number.isFinite(nextDelay) ? nextDelay : resolvedCadence);
      await sleep(Math.min(cadence, end - monotonic()));
    } while (true);
  } finally { await observation?.close(); }
}
