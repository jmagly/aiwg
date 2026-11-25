// Refresh fixtures must never discover executable providers inherited from the host.
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { writeExecutable } from '../../helpers/write-executable.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('ignores an unrelated provider on the ambient PATH during public refresh', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'aiwg-ambient-provider-'));
  roots.push(host);
  const marker = path.join(host, 'invoked');
  await writeExecutable(path.join(host, 'opencode'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'unexpected discovery');
console.log(process.argv.includes('--version') ? '1.0.0' : 'synthetic/unrelated');
`);
  for (const command of ['cat', 'chmod']) await symlink(`/usr/bin/${command}`, path.join(host, command));
  vi.stubEnv('PATH', host);
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  const refreshed = await f.run(['models', 'refresh', '--provider', 'codex', '--json']);
  expect(refreshed.code, refreshed.stdout + refreshed.stderr).toBe(0);
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
