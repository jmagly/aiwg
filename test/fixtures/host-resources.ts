// Synthetic Linux resource readers; no live /proc or subprocesses in unit tests.
import { readLiveHostResources } from '../../src/config/host-resource-runtime.mjs';
export function hostResourceReaders(overrides: Record<string, string> = {}) {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 33554432 kB\n',
    '/proc/loadavg': '1.0 0.5 0.2 1/100 42\n',
    '/proc/pressure/memory': 'some avg10=2.00 avg60=1.00 avg300=0.00 total=1\n',
    ...overrides,
  };
  return { workspace: '/synthetic', readText: (path: string) => files[path], coreCount: () => 8, countWorkers: () => 1,
    statfs: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
}
export const healthyHostResources = () => readLiveHostResources(hostResourceReaders());

export function idleHostResourceReaders() {
  return { ...hostResourceReaders(), countWorkers: () => 0,
    statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
}

export interface SyntheticWorkerProcess {
  uid?: number; comm?: string; invocation?: string; unit?: string; workspace?: string; group?: string;
}
export function ownedWorkerReaders(units: string[] | undefined, processes: SyntheticWorkerProcess[]) {
  return { ...hostResourceReaders(), countWorkers: undefined, uid: 1000,
    listWorkerUnits: () => units,
    readDir: () => ['self', ...processes.map((_, index) => String(index + 1))],
    readText: (filename: string) => {
      const [, , pid, field] = filename.split('/');
      const record = processes[Number(pid) - 1];
      if (!record) return hostResourceReaders().readText(filename);
      if (field === 'status') return `Uid: ${record.uid ?? 1000}\n`;
      if (field === 'comm') return record.comm ?? 'codex';
      if (field === 'environ') return record.invocation ? `AIWG_WORKER_INVOCATION_ID=${record.invocation}\0`
        + (record.workspace ? `AIWG_WORKER_WORKSPACE=${record.workspace}\0` : '')
        + (record.group ? `AIWG_WORKER_GROUP=${record.group}\0` : '') : '';
      if (field === 'cgroup') return `0::/user.slice/${record.unit ?? 'session.scope'}\n`;
      throw new Error('unexpected fixture read');
    } };
}
