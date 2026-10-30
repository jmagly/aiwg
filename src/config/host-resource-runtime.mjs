// Linux host measurements shared by dispatch preflight and resource reports.
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { WORKER_INVOCATION_MARKER } from './worker-invocation-marker.mjs';
const BYTES_PER_GB = 1024 ** 3;

/**
 * Parse MemAvailable (kB) from /proc/meminfo text. Returns GiB or undefined
 * when the field is absent/unparsable. Pure: tests feed synthetic fixtures.
 */
function parseMemAvailableGb(meminfoText) {
  if (typeof meminfoText !== 'string') return undefined;
  const match = meminfoText.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) return undefined;
  const gib = Number(match[1]) / 1024 / 1024;
  return Number.isFinite(gib) ? gib : undefined;
}

/**
 * Parse memory pressure from /proc/pressure/memory text. Returns
 * `{ avg10, avg60, avg300 }` from the `some` line, or null when no `some`
 * line parses. Pure: tests feed synthetic fixtures.
 */
function parseMemoryPsi(pressureText) {
  if (typeof pressureText !== 'string') return null;
  for (const line of pressureText.split('\n')) {
    if (!line.startsWith('some')) continue;
    const values = {};
    for (const part of line.split(/\s+/)) {
      const [key, raw] = part.split('=');
      if ((key === 'avg10' || key === 'avg60' || key === 'avg300') && raw !== undefined) {
        const value = Number(raw);
        if (Number.isFinite(value)) values[key] = value;
      }
    }
    if (values.avg10 !== undefined && values.avg60 !== undefined && values.avg300 !== undefined) return values;
    return null;
  }
  return null;
}

/**
 * Parse /proc/loadavg text. Returns `{ load1, load5, load15 }` or null.
 * Pure: tests feed synthetic fixtures.
 */
function parseLoadAverages(loadavgText) {
  if (typeof loadavgText !== 'string') return null;
  const parts = loadavgText.trim().split(/\s+/);
  const loads = parts.slice(0, 3).map(Number);
  if (loads.length !== 3 || loads.some(value => !Number.isFinite(value))) return null;
  return { load1: loads[0], load5: loads[1], load15: loads[2] };
}

/** List active current-user launcher units, retaining identity for deduplication. */
function listWorkerUnits({ spawn = spawnSync } = {}) {
  try {
    const result = spawn('systemctl', ['--user', 'list-units', '--type=service',
      '--state=running,activating', '--no-legend', '--plain', 'aiwg-worker-*'],
    { encoding: 'utf8', timeout: 1000 });
    if (result.error || result.status !== 0) return undefined;
    return [...new Set(String(result.stdout ?? '').split('\n')
      .map(line => /^(aiwg-worker-[^\s]+\.service)\s/.exec(line.trim())?.[1]).filter(Boolean))];
  } catch { return undefined; }
}

function countWorkerUnits(options) {
  return listWorkerUnits(options)?.length;
}

/** Count owned invocations once; CLI comm counts are informational only. */
function countWorkerProcesses({
  readDir = readdirSync,
  readText = path => readFileSync(path, 'utf8'),
  uid = process.getuid?.(),
  groupNames = [],
  listWorkerUnits: readUnitList,
  countWorkerUnits: readUnitCount,
} = {}) {
  if (process.platform !== 'linux' || uid === undefined) return undefined;
  let units, unitNames;
  try {
    const listed = readUnitList ? readUnitList() : readUnitCount ? readUnitCount() : listWorkerUnits();
    if (Array.isArray(listed)) unitNames = new Set(listed);
    const counted = unitNames ? unitNames.size : listed;
    if (Number.isInteger(counted) && counted >= 0) units = counted;
  } catch { /* Owned-process scanning remains available. */ }
  const source = units === undefined ? 'owned-process-fallback' : 'systemd-units-and-marked-processes';
  // Reuse existing identities; UUID-only IDs carry no group evidence.
  const identify = value => new Set(groupNames.filter(name => value === name || value.startsWith(`${name}-`)));
  const unitGroups = new Map([...(unitNames ?? [])].map(unit =>
    [unit, identify(unit.slice('aiwg-worker-'.length, -'.service'.length))]));
  let entries, procUnavailable = false;
  try { entries = readDir('/proc'); }
  catch {
    if (units === undefined) return undefined;
    entries = []; procUnavailable = true;
  }
  const hostCliProcesses = { codex: 0, muse: 0 };
  const invocations = new Set(), unitInvocations = new Set();
  const invocationGroups = new Map();
  const merge = (target, evidence) => { for (const name of evidence) target.add(name); };
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readText(`/proc/${entry}/status`);
      const owner = status.match(/^Uid:\s+(\d+)/m);
      if (!owner || Number(owner[1]) !== uid) continue;
      const optional = field => {
        try { return readText(`/proc/${entry}/${field}`); } catch { return ''; }
      };
      const comm = optional('comm').trim();
      if (comm === 'codex') hostCliProcesses.codex += 1;
      if (comm === 'muse-bin' || comm === 'muse') hostCliProcesses.muse += 1;
      const marker = optional('environ').split('\0').find(field => field.startsWith(`${WORKER_INVOCATION_MARKER}=`));
      const invocation = marker?.slice(WORKER_INVOCATION_MARKER.length + 1);
      if (!invocation) continue;
      invocations.add(invocation);
      if (!invocationGroups.has(invocation)) invocationGroups.set(invocation, identify(invocation));
      const cgroupUnits = optional('cgroup').match(/aiwg-worker-[^/\s]+\.service(?=\/|\s|$)/g) ?? [];
      if (cgroupUnits.some(unit => unitNames ? unitNames.has(unit) : units > 0)) unitInvocations.add(invocation);
      for (const unit of cgroupUnits.filter(unit => unitGroups.has(unit))) {
        merge(unitGroups.get(unit), invocationGroups.get(invocation));
      }
    } catch { /* Processes may exit during the scan. */ }
  }
  const byGroup = {};
  for (const evidence of [...unitGroups.values(), ...[...invocationGroups]
    .filter(([id]) => !unitInvocations.has(id)).map(([, evidence]) => evidence)]) {
    if (evidence.size === 1) {
      const [name] = evidence;
      byGroup[name] = (byGroup[name] ?? 0) + 1;
    }
  }
  return { ...(groupNames.length ? { byGroup } : {}), total: (units ?? 0) + [...invocations].filter(id => !unitInvocations.has(id)).length,
    ...(procUnavailable ? {} : { hostCliProcesses }), units, source };
}

function defaultCountWorkers(options) {
  return countWorkerProcesses(options)?.total;
}

/**
 * Sample live host signals. All inputs are injectable so tests use synthetic
 * meminfo/pressure/loadavg fixtures instead of the real /proc:
 * `{ readText, coreCount, countWorkers }`. Non-Linux hosts report
 * `{ supported: false }`; the gate turns that into an explicit diagnostic
 * (MVP qualifies Linux per NFR-OG-008) rather than an implicit pass.
 */
/**
 * Convert one statfs result to GiB. Non-finite or negative samples are
 * rejected (fail closed): a NaN/Infinity/-1 reading must never become a
 * passing number downstream.
 */
function toFreeDiskGb(disk) {
  const gb = (Number(disk?.bavail) * Number(disk?.bsize)) / BYTES_PER_GB;
  return Number.isFinite(gb) && gb >= 0 ? gb : undefined;
}

/**
 * Sample free disk on the caller-supplied filesystem(s): `readers.paths`
 * names the actual evidence root and worktree, and the gate takes the
 * minimum across them. Any unreadable, non-finite or negative sample — or
 * no supplied filesystem at all — yields undefined so the gate fails closed
 * instead of admitting on the conductor's process-cwd filesystem.
 * `readers.statfs` (zero-arg) and `readers.statfsPath` (per-path) stay as
 * injectable test seams; there is no process.cwd() fallback.
 */
function sampleFreeDiskGb(readers) {
  if (Array.isArray(readers.paths)) {
    if (readers.paths.length === 0) return undefined;
    const statOne = typeof readers.statfsPath === 'function' ? readers.statfsPath : (path) => statfsSync(path);
    let minimum;
    for (const path of readers.paths) {
      let sample;
      try {
        sample = toFreeDiskGb(statOne(path));
      } catch {
        return undefined;
      }
      if (sample === undefined) return undefined;
      minimum = minimum === undefined ? sample : Math.min(minimum, sample);
    }
    return minimum;
  }
  if (typeof readers.statfs === 'function') {
    try {
      return toFreeDiskGb(readers.statfs());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readLiveHostResources(readers = {}) {
  // Capture the start of collection, so slow readers cannot make old values newer.
  const collectedAt = new Date((readers.now ?? Date.now)()).toISOString();
  const readText = readers.readText ?? (path => readFileSync(path, 'utf8'));
  const coreCount = readers.coreCount ?? (() => os.cpus().length);
  const countWorkers = readers.countWorkers ?? (() => countWorkerProcesses(readers));
  // 08 disk-pressure admission: free disk sampled through the same injectable
  // resolver path as every other live signal, so tests feed synthetic values.
  // Callers supply the evidence/worktree filesystems via `readers.paths`
  // (threaded through `checkWorkerDispatch({ paths })`); without them free
  // disk is unknown and the gate fails closed.
  if (process.platform !== 'linux' && readers.readText === undefined) {
    return { collectedAt, supported: false, reason: `live dispatch signals require Linux /proc (this host: ${process.platform})` };
  }
  const readOptional = (path) => {
    try {
      return readText(path);
    } catch {
      return undefined;
    }
  };
  const cores = coreCount();
  const load = parseLoadAverages(readOptional('/proc/loadavg') ?? '');
  const psi = parseMemoryPsi(readOptional('/proc/pressure/memory') ?? '');
  let workers;
  try {
    workers = countWorkers();
  } catch {
    workers = undefined;
  }
  return {
    collectedAt,
    supported: true,
    availMemGb: parseMemAvailableGb(readOptional('/proc/meminfo') ?? ''),
    load1: load?.load1,
    cores: Number.isFinite(cores) && cores > 0 ? cores : undefined,
    loadRatio: load && cores ? load.load1 / cores : undefined,
    memPsiAvg10: psi?.avg10,
    memPsiAvg60: psi?.avg60,
    memPsiAvg300: psi?.avg300,
    workers: typeof workers === 'object' ? workers?.total : workers,
    ...(typeof workers === 'object' ? { hostCliProcesses: workers?.hostCliProcesses, workerUnits: workers?.units,
      workerCountingSource: workers?.source, workerGroups: workers?.byGroup } : {}),
    freeDiskGb: sampleFreeDiskGb(readers),
  };
}

/**
 * Evaluate sampled live signals against thresholds. Every breach becomes a
 * BLOCK failure naming its signal. Unknown-but-required signals (threshold
 * configured, signal undetectable) fail closed with reason 'not detectable'.
 */
function evaluateDispatchGate(live, thresholds) {
  const failures = [];
  if (!live || live.supported === false) {
    return {
      ok: false,
      failures: [{ signal: 'platform', reason: live?.reason ?? 'live host signals unavailable' }],
      thresholds,
    };
  }
  const breach = (signal, actual, threshold, reason) => failures.push({ signal, actual, threshold, reason });
  if (!Number.isFinite(live.availMemGb)) breach('avail-mem', undefined, thresholds.min_avail_mem_gb, 'MemAvailable not detectable on this host');
  else if (live.availMemGb < thresholds.min_avail_mem_gb) {
    breach('avail-mem', live.availMemGb, thresholds.min_avail_mem_gb, `available ${live.availMemGb.toFixed(1)}GB < ${thresholds.min_avail_mem_gb}GB`);
  }
  if (!Number.isFinite(live.loadRatio)) breach('load', undefined, thresholds.max_load_ratio, 'load average not detectable on this host');
  else if (live.loadRatio > thresholds.max_load_ratio) {
    breach('load', live.loadRatio, thresholds.max_load_ratio, `load ratio ${live.loadRatio.toFixed(2)} > ${thresholds.max_load_ratio}`);
  }
  if (!Number.isFinite(live.memPsiAvg10)) breach('mem-psi-avg10', undefined, thresholds.max_mem_psi_avg10, '/proc/pressure/memory not detectable on this host');
  else if (live.memPsiAvg10 > thresholds.max_mem_psi_avg10) {
    breach('mem-psi-avg10', live.memPsiAvg10, thresholds.max_mem_psi_avg10, `memory PSI avg10 ${live.memPsiAvg10} > ${thresholds.max_mem_psi_avg10}`);
  }
  if (!Number.isFinite(live.memPsiAvg60)) breach('mem-psi-avg60', undefined, thresholds.max_mem_psi_avg60, '/proc/pressure/memory not detectable on this host');
  else if (live.memPsiAvg60 > thresholds.max_mem_psi_avg60) {
    breach('mem-psi-avg60', live.memPsiAvg60, thresholds.max_mem_psi_avg60, `memory PSI avg60 ${live.memPsiAvg60} > ${thresholds.max_mem_psi_avg60}`);
  }
  if (thresholds.max_workers !== undefined) {
    if (!Number.isFinite(live.workers)) breach('workers', undefined, thresholds.max_workers, 'worker count not detectable on this host');
    else if (live.workers >= thresholds.max_workers) {
      breach('workers', live.workers, thresholds.max_workers, `${live.workers} running workers >= ${thresholds.max_workers}`);
    }
  }
  // 08 disk-pressure admission: unknown-but-required free disk fails closed,
  // like every other required signal; under-threshold free disk blocks.
  // Pre-sampled NaN/Infinity/negative readings are rejected here too, so a
  // forged or broken sample can never satisfy the gate.
  if (thresholds.min_free_disk_gb !== undefined && thresholds.min_free_disk_gb > 0) {
    const disk = live.freeDiskGb;
    if (disk === undefined || !Number.isFinite(disk) || disk < 0) {
      breach('free-disk', undefined, thresholds.min_free_disk_gb, 'free disk not detectable on this host');
    } else if (disk < thresholds.min_free_disk_gb) {
      breach('free-disk', disk, thresholds.min_free_disk_gb, `free ${disk.toFixed(1)}GB < ${thresholds.min_free_disk_gb}GB`);
    }
  }
  return { ok: failures.length === 0, failures, thresholds };
}


export { parseMemAvailableGb, parseMemoryPsi, parseLoadAverages, listWorkerUnits, countWorkerUnits, countWorkerProcesses, defaultCountWorkers, readLiveHostResources, evaluateDispatchGate };
