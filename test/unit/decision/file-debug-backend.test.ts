import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { DecisionDebugSidecar } from '../../../src/decision/telemetry/debug-sidecar.js';
import { FileDebugSidecarBackend } from '../../../src/decision/telemetry/file-debug-backend.js';

const lifecycle = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['case-worker'], retentionMs: 100,
    export: 'denied', deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'] });

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'decision-debug-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function sidecar(root: string, clock: () => number) {
  const backend = new FileDebugSidecarBackend(root);
  const authorize = vi.fn(async (scope: string) => scope === 'case-7');
  const capture = new DecisionDebugSidecar({ explicitlyAuthorized: true,
    encryption: { enabled: true, keyReference: 'logical-key' },
    accessAudit: { enabled: true, sinkReference: 'audit-store' },
    classification: 'restricted', ttlMs: 100, deletionEnabled: true,
  }, backend, async () => new Uint8Array(32).fill(7), authorize, lifecycle(), clock);
  return { backend, capture, authorize };
}

describe('durable encrypted debug sidecar', () => {
  it('writes private ciphertext and audit only; expires restored records before disclosure', async () => withRoot(async root => {
    let now = 1_000;
    const first = sidecar(root, () => now);
    const canary = 'synthetic-private-debug-body-canary';
    const id = await first.capture.capture('case-7', Buffer.from(canary));
    const names = await readdir(root);
    expect(names).toContain('audit.jsonl');
    expect(names).toContain(`${id}.json`);
    for (const name of names) {
      expect((await stat(join(root, name))).mode & 0o077).toBe(0);
      expect((await readFile(join(root, name), 'utf8'))).not.toContain(canary);
    }
    expect((await stat(root)).mode & 0o077).toBe(0);
    const restored = sidecar(root, () => now);
    expect(Buffer.from((await restored.capture.read('case-7', id))!).toString()).toBe(canary);
    now = 1_100;
    expect(await sidecar(root, () => now).capture.read('case-7', id)).toBeNull();
    expect((await readdir(root))).not.toContain(`${id}.json`);
    expect((await readFile(join(root, 'audit.jsonl'), 'utf8'))).not.toContain(canary);
  }));

  it('sweeps expired records after restart, denies adjacent scope and path traversal', async () => withRoot(async root => {
    let now = 1_000;
    const first = sidecar(root, () => now);
    const id = await first.capture.capture('case-7', Buffer.from('private-fixture'));
    await expect(first.capture.read('other', id)).rejects.toThrow(/denied/);
    await expect(first.backend.get('../audit.jsonl')).rejects.toThrow(/reference invalid/);
    now = 1_100;
    expect(await sidecar(root, () => now).capture.sweepExpired('case-7')).toBe(1);
    expect((await readdir(root))).not.toContain(`${id}.json`);
  }));

  it('refuses a pre-existing non-private storage directory', async () => withRoot(async root => {
    const external = join(root, 'public');
    await mkdir(external, { mode: 0o755 });
    await expect(new FileDebugSidecarBackend(external).audit({ operation: 'capture',
      id: '11111111-1111-1111-1111-111111111111', scope: 'case-7' })).rejects.toThrow(/private directory/);
    expect(await readdir(external)).toEqual([]);
  }));

  it('rejects corrupted stored ciphertext without echoing contents', async () => withRoot(async root => {
    const { capture } = sidecar(root, () => 1_000);
    const id = await capture.capture('case-7', Buffer.from('synthetic-private-debug-canary'));
    await writeFile(join(root, `${id}.json`), '{"wrong":"synthetic-private-debug-canary"}');
    await expect(capture.read('case-7', id)).rejects.toThrow('Debug sidecar storage failed');
  }));
});
