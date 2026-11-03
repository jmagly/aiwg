// Retain kernel birth identity when an exited child has already lost its executable link.
import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';

export function sampleWorkerProcIdentity(pid, { procRoot = '/proc', platform = process.platform,
  host = hostname(), fs = { readFileSync, readlinkSync } } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const parse = text => text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    const fields = parse(fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8'));
    const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`${procRoot}/${pid}/status`, 'utf8'))?.[1]);
    const bootId = fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
    if (!Number.isSafeInteger(uid) || !bootId || !/^\d+$/.test(fields[19] ?? '')) return null;
    let executable;
    try { executable = fs.readlinkSync(`${procRoot}/${pid}/exe`); }
    catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) return null;
      // exit_mm removes /exe before wait() reaps the child. Its readable
      // stat/status still prove birth, ownership and group, but grant no
      // executable claim. Re-read stat to reject disappearance/PID reuse
      // and any live process (including a transient exec failure).
      const exited = parse(fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8'));
      if (exited[0] !== 'Z' || [1, 2, 3, 19].some(index => exited[index] !== fields[index])) return null;
      executable = null;
    }
    return { pid, pgid: Number(fields[2]), uid, parentPid: Number(fields[1]), sessionId: Number(fields[3]),
      host, bootId, startTicks: fields[19], executable, state: executable === null ? 'Z' : fields[0],
      cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]) };
  } catch { return null; }
}
