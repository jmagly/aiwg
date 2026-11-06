// Exercise real POSIX ACL inheritance and atomic replacement for shared workspace writers.
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicConfigWrite } from '../../../src/config/worker-write.js';
import { writeConfigAtomic } from '../../../src/mcp/config-file.mjs';
import { saveLayerData } from '../../../src/mcp/config-layers.mjs';
import { pinContainedRoot, writeContainedFile } from '../../../src/utils/contained-filesystem.mjs';
import { groupSharedWorkspace, readAcl, workspacePermissionsAllowed } from '../../../src/utils/workspace-permissions.mjs';
import { createProviderTransformationReceipt, writeProviderTransformationReceipt } from '../../../src/providers/transformation-receipt.js';
import { writeJevCredentialFile } from '../../../src/decision/jev-credentials.js';
import { scanContextMemoryFirewall, writeReviewBaseline } from '../../../tools/security/context-memory-firewall.mjs';
import { inspectWorkspaceAclMasks } from '../../../tools/cli/doctor-workspace-permissions.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-shared-permissions-'));
  roots.push(root);
  return root;
}
function setAcl(root: string) {
  execFileSync('setfacl', ['-m', 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---', '--', root], { timeout: 5000 });
  if (!readAcl(root)?.includes('default:mask::rwx')) throw new Error('ACLs unsupported');
}

describe('workspace permission policy', () => {
  it.skipIf(process.platform === 'win32')('detects setgid without ACLs and rejects world-accessible roots and mismatched groups', async () => {
    const root = await fixture();
    await chmod(root, 0o2770);
    expect(groupSharedWorkspace(root)?.directory).toBe(root);
    const info = await stat(root);
    expect(workspacePermissionsAllowed({ mode: 0o660, gid: info.gid }, root)).toBe(true);
    expect(workspacePermissionsAllowed({ mode: 0o660, gid: info.gid + 1 }, root)).toBe(false);
    expect(workspacePermissionsAllowed({ mode: 0o664, gid: info.gid }, root)).toBe(false);
    await chmod(root, 0o2775);
    expect(groupSharedWorkspace(root)).toBeNull();
    await chmod(root, 0o700);
    expect(workspacePermissionsAllowed({ mode: 0o660, gid: info.gid }, root)).toBe(false);
  });

  it('retains private config creation and replacement outside a shared workspace', async () => {
    const root = await fixture();
    const config = join(root, '.aiwg', 'aiwg.config');
    await atomicConfigWrite(config, 'first');
    const mcp = join(root, '.aiwg', 'mcp.json');
    await writeConfigAtomic(mcp, '{}', { projectRoot: root, newFileMode: 0o600 });
    expect((await stat(mcp)).mode & 0o777).toBe(0o600);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    await chmod(config, 0o640);
    await atomicConfigWrite(config, 'second');
    expect((await stat(config)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('keeps inherited masks on config, baseline and receipt writes; credentials remain 0600', async context => {
    const root = await fixture();
    await chmod(root, 0o2770);
    try { setAcl(root); } catch { context.skip(); return; }
    const config = join(root, '.aiwg', 'aiwg.config');
    await atomicConfigWrite(config, 'first');
    const mcp = join(root, '.aiwg', 'mcp.json');
    await writeConfigAtomic(mcp, '{}', { projectRoot: root, newFileMode: 0o600 });
    await writeFile(join(root, 'WORKSPACE.md'), '# Reviewed context\n');
    const store = await pinContainedRoot(join(root, '.aiwg'), root);
    await writeContainedFile(store, 'artifact.json', '{}');
    const artifact = join(root, '.aiwg', 'artifact.json');
    const scan = await scanContextMemoryFirewall({ rootDir: root, packageRoot: root, providers: ['claude'], contentScan: false });
    const baseline = await writeReviewBaseline(scan, '.aiwg/context-memory-firewall-baseline.json');
    const receipt = await createProviderTransformationReceipt({ projectRoot: root, provider: 'codex', scope: 'project',
      source: { subject: 'fixture', sha256: 'a'.repeat(64), verification: 'verified' },
      transformer: { id: 'fixture', version: '1', providerAdapter: 'codex', providerAdapterVersion: '1' },
      outputPaths: ['WORKSPACE.md'] });
    const receiptPath = await writeProviderTransformationReceipt(root, receipt);
    for (const file of [config, mcp, artifact, baseline, receiptPath]) {
      expect(readAcl(file)).toMatch(/^mask::rw-$/m);
      // A named ACL different from the default must survive replacement too.
      execFileSync('setfacl', ['-m', 'u:65534:r--,m::rw-', '--', file], { timeout: 5000 });
    }
    await atomicConfigWrite(config, 'second');
    await writeContainedFile(store, 'artifact.json', '{"updated":true}');
    await writeConfigAtomic(mcp, '{"updated":true}', { projectRoot: root, newFileMode: 0o600 });
    await writeReviewBaseline(scan, '.aiwg/context-memory-firewall-baseline.json');
    await writeProviderTransformationReceipt(root, { ...receipt, transformer: { ...receipt.transformer, version: '2' } });
    for (const file of [config, mcp, artifact, baseline, receiptPath]) {
      expect(readAcl(file)).toMatch(/^user:65534:r--$/m);
      expect(readAcl(file)).toMatch(/^mask::rw-$/m);
      expect((await stat(file)).mode & 0o070).toBe(0o060);
    }
    const secret = await writeJevCredentialFile({ token: 'synthetic-only', region: 'us' }, { credentialPath: join(root, 'credentials', 'jev.json') });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect(readAcl(secret)).toMatch(/^mask::---$/m);
    const sensitiveRegistry = join(root, 'credentials', 'mcp-servers.json');
    await saveLayerData(sensitiveRegistry, { servers: { fixture: { name: 'fixture', transport: 'http', url: 'http://localhost',
      headers: { Authorization: 'Bearer synthetic-only' } } } }, 'servers');
    expect((await stat(sensitiveRegistry)).mode & 0o777).toBe(0o600);
    expect(await inspectWorkspaceAclMasks(join(root, '.aiwg'))).toEqual([]);
    const broken = join(root, '.aiwg', 'broken.json');
    await writeFile(broken, '{}', { mode: 0o600 });
    expect(await inspectWorkspaceAclMasks(join(root, '.aiwg'))).toEqual([
      expect.objectContaining({ path: broken, reason: 'acl-mask-collapsed', repair: expect.stringContaining('setfacl -m') }),
    ]);
  });

  it.skipIf(process.platform === 'win32')('detects a default ACL without setgid and handles an external artifact root', async context => {
    const root = await fixture();
    const artifacts = join(root, 'external-artifacts');
    await mkdir(artifacts);
    await chmod(artifacts, 0o770);
    expect(groupSharedWorkspace(artifacts)).toBeNull();
    try { setAcl(artifacts); } catch { context.skip(); return; }
    expect(groupSharedWorkspace(artifacts)?.directory).toBe(artifacts);
    await atomicConfigWrite(join(artifacts, 'config.json'), '{}');
    expect(readAcl(join(artifacts, 'config.json'))).toMatch(/^mask::rw-$/m);
  });
});
