// Read retained unit exit state and its kernel-backed recursive task count.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSystemdClientEnv, resolveSystemdClient } from './systemd-client.mjs';

function emptyCgroup(fields, readCgroup) {
  if (fields.TasksCurrent === '0') return true;
  if (/^[1-9][0-9]*$/.test(fields.TasksCurrent ?? '')) return false;
  if (!['inactive', 'failed'].includes(fields.ActiveState)) return false;
  // A loaded inactive unit can have released its cgroup entirely.
  if (fields.LoadState === 'loaded' && fields.ControlGroup === '') return true;
  // systemd garbage-collects a unit that exited successfully once it is inactive and its cgroup is
  // released; the same not-found/inactive/MainPID=0 shape parseShellUnitStatus accepts (#4158).
  if (fields.LoadState === 'not-found' && fields.MainPID === '0' && (fields.ControlGroup ?? '') === '') return true;
  const group = fields.ControlGroup;
  if (!group?.startsWith('/') || group === '/' || group.split('/').includes('..')) return false;
  try { return /^populated 0$/m.test(readCgroup(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8')); }
  catch (error) { return error.code === 'ENOENT'; }
}

/**
 * Read retained service state after launch/exit without reaping or mutation.
 * `memoryMax` is bytes. Query failures throw rather than reporting success.
 */
export function getWorkerIsolationStatus(unit, { spawn = spawnSync, timeoutMs = 10000, readCgroup = readFileSync } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const shown = spawn(resolveSystemdClient('systemctl'), ['--user', 'show', unit, '-p', 'ActiveState',
    '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainCode', '-p', 'MainPID', '-p', 'MemoryMax', '-p', 'TasksCurrent', '-p', 'ControlGroup', '-p', 'LoadState'], { encoding: 'utf8', timeout: timeoutMs, env: buildSystemdClientEnv({ envNames: [] }) });
  if (shown.error || shown.status !== 0) {
    throw new Error(`worker status unavailable: ${shown.error?.message ?? String(shown.stderr ?? '').trim()}`);
  }
  const fields = Object.fromEntries(String(shown.stdout ?? '').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.ActiveState || !fields.Result || !fields.MemoryMax) {
    throw new Error('worker status unavailable: missing systemd properties');
  }
  return {
    active: ['inactive', 'failed'].includes(fields.ActiveState) ? false
      : ['active', 'activating', 'deactivating', 'reloading'].includes(fields.ActiveState) ? true : null,
    ...(emptyCgroup(fields, readCgroup) ? { cgroupEmpty: true } : {}),
    result: fields.Result,
    ...(fields.ExecMainStatus ? { execMainStatus: Number(fields.ExecMainStatus) } : {}),
    memoryMax: fields.MemoryMax === 'infinity' ? Infinity : Number(fields.MemoryMax),
    ...(fields.MainPID ? { mainPid: Number(fields.MainPID) } : {}),
    ...(fields.ExecMainCode ? { execMainCode: Number(fields.ExecMainCode) } : {}),
  };
}

/**
 * Read the kernel-reported `ControlGroup` systemd placed this unit's
 * processes under. This is the containment authority for `systemd-unit`
 * mode worker identity (#2895 round 2, MAJOR a): a candidate pid is only
 * trustworthy if its own `/proc/<pid>/cgroup` matches this value, never
 * because a worker-writable record merely names a pid that happens to
 * resample successfully. Returns null (never a forged match) when the
 * property is unavailable.
 */
export function readUnitControlGroup(unit, { spawn = spawnSync } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) return null;
  try {
    const shown = spawn(resolveSystemdClient('systemctl'), ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8', timeout: 10000, env: buildSystemdClientEnv({ envNames: [] }) });
    if (shown.error || shown.status !== 0) return null;
    const value = String(shown.stdout ?? '').trim();
    return value || null;
  } catch { return null; }
}
