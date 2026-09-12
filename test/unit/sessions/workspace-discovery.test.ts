import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionRepository,
  discoverWorkspaceHistories,
  importDiscoveryManifest,
  readDiscoveryManifest,
  writeDiscoveryManifest,
} from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace session discovery and batch import', () => {
  it('inventories only matching known roots, persists the exact manifest, and exposes export gaps', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: '2026-07-28T00:00:00.000Z',
    });
    expect(manifest.sources.map((source) => source.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.every((source) => source.locator.startsWith(fixture.providerHome)))
      .toBe(true);
    expect(manifest.providers.find((provider) => provider.provider === 'codex'))
      .toMatchObject({ status: 'checked', sourceCount: 1 });
    expect(manifest.providers.find((provider) => provider.provider === 'warp'))
      .toMatchObject({
        status: 'export-required',
        disposition: 'manual-export',
        reasonCode: 'EXPLICIT_EXPORT_REQUIRED',
      });
    expect(manifest.providers.find((provider) => provider.provider === 'generic'))
      .toMatchObject({ status: 'export-required' });

    const path = join(fixture.workspace, '.aiwg', 'sessions', 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).resolves.toEqual(manifest);
  });

  it('checks the account home when an isolated runtime HOME hides provider stores', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      operatorHome: fixture.providerHome,
      codexRoot: join(fixture.providerHome, '.codex', 'sessions'),
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(manifest.providers.filter((provider) => provider.status === 'checked')
      .map((provider) => provider.provider))
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
    expect(manifest.sources.map((source) => source.provider).sort())
      .toEqual(['claude', 'codex', 'cursor', 'factory']);
  });

  itWithSqlite('resumes only incomplete sources and reconciles partial coverage', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
      createdAt: new Date().toISOString(),
    });
    const repository = new SessionRepository(':memory:');
    try {
      const first = await importDiscoveryManifest({ manifest, repository });
      expect(first.totals).toMatchObject({
        discovered: 4,
        accepted: 4,
        rejected: 0,
        pending: 0,
      });
      expect(first.run.status).toBe('partial');
      expect(first.coverage).toMatchObject({
        status: 'partial',
        providers: { exportRequired: expect.arrayContaining(['warp', 'opencode']) },
        sources: { discovered: 4, accepted: 4 },
      });
      const second = await importDiscoveryManifest({ manifest, repository });
      expect(second.run.sources.every(
        (source) => source.status === 'previously-committed',
      )).toBe(true);
      expect(second.run.sources.every((source) => source.attempts === 1)).toBe(true);
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sources: 4,
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite('reports the observed 304-discovered/35-accepted case without claiming completeness', async () => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    try {
      const run = {
        schemaVersion: '1.0.0' as const,
        runId: 'run-304',
        manifestId: 'manifest-304',
        manifestCreatedAt: new Date().toISOString(),
        workspaceId: manifest.workspaceId,
        status: 'partial' as const,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        providers: manifest.providers,
        sources: Array.from({ length: 304 }, (_, index) => ({
          sourceId: `source-${index}`,
          provider: 'codex',
          status: index < 35 ? 'committed' as const : 'rejected' as const,
          attempts: 1,
          sessionsAccepted: index < 35 ? 1 : 0,
          eventsAccepted: index < 35 ? 2 : 0,
          errorCode: index < 35 ? null : 'MALFORMED_SOURCE',
          diagnostic: index < 35 ? null : `source=source-${index} code=MALFORMED_SOURCE`,
          updatedAt: new Date().toISOString(),
        })),
      };
      repository.saveBatchImportRun(run);
      expect(repository.getCoverage(manifest.workspaceId)).toMatchObject({
        schemaVersion: '1.0.0',
        status: 'partial',
        sources: {
          discovered: 304,
          accepted: 35,
          rejected: 269,
        },
        sessionsAccepted: 35,
        eventsAccepted: 70,
        rejectionCounts: { MALFORMED_SOURCE: 269 },
        coverageRatio: 35 / 304,
      });
    } finally {
      repository.close();
    }
  });

  itWithSqlite.each([
    'run-saved',
    'source-staged',
    'before-publication',
    'after-publication',
  ] as const)('resumes idempotently after failure at the %s boundary', async (boundary) => {
    const fixture = await providerFixture();
    const manifest = await discoverWorkspaceHistories({
      workspace: fixture.workspace,
      providerHome: fixture.providerHome,
    });
    const repository = new SessionRepository(':memory:');
    let injected = false;
    try {
      await expect(importDiscoveryManifest({
        manifest,
        repository,
        fault(candidate) {
          if (!injected && candidate === boundary) {
            injected = true;
            throw new Error(`injected:${boundary}`);
          }
        },
      })).rejects.toThrow(`injected:${boundary}`);
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(boundary === 'after-publication' ? 4 : 0);
      const interrupted = repository.getBatchImportRunForManifest(
        manifest.manifestId,
        manifest.workspaceId,
      );
      expect(interrupted?.status).toBe('interrupted');

      const resumed = await importDiscoveryManifest({ manifest, repository });
      expect(resumed.totals).toMatchObject({
        discovered: 4,
        rejected: 0,
        pending: 0,
      });
      expect(repository.listSessions({
        workspaceId: manifest.workspaceId,
        limit: 20,
      }).total).toBe(4);
      expect(repository.doctor()).toMatchObject({
        integrity: 'ok',
        indexIntegrity: 'ok',
        sessions: 4,
      });
    } finally {
      repository.close();
    }
  });
});

async function providerFixture(): Promise<{ root: string; workspace: string; providerHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-session-discovery-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const providerHome = join(root, 'home');
  await mkdir(workspace, { recursive: true });
  const key = workspace.replace(/\\/g, '/').replace(/[/:]+/g, '-');
  const cursorKey = workspace.replace(/\\/g, '/').replace(/^\/+/, '').replace(/[/:]+/g, '-');

  const claude = join(providerHome, '.claude', 'projects', key, 'claude.jsonl');
  const factory = join(providerHome, '.factory', 'sessions', key, 'factory.jsonl');
  const cursor = join(
    providerHome,
    '.cursor',
    'projects',
    cursorKey,
    'agent-transcripts',
    'cursor-session',
    'cursor-session.jsonl',
  );
  const codex = join(providerHome, '.codex', 'sessions', '2026', '07', 'rollout.jsonl');
  const unrelatedCodex = join(
    providerHome,
    '.codex',
    'sessions',
    '2026',
    '07',
    'unrelated.jsonl',
  );
  await Promise.all([claude, factory, cursor, codex, unrelatedCodex].map(
    (path) => mkdir(resolve(path, '..'), { recursive: true }),
  ));
  await writeFile(claude, [
    JSON.stringify({
      type: 'user',
      uuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Claude request.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'claude-assistant',
      parentUuid: 'claude-user',
      sessionId: 'claude-session',
      timestamp: '2026-07-27T10:00:01.000Z',
      message: { role: 'assistant', content: 'Synthetic Claude response.' },
    }),
  ].join('\n') + '\n');
  await writeFile(factory, [
    JSON.stringify({
      type: 'session_start',
      id: 'factory-session',
      version: 2,
      cwd: workspace,
    }),
    JSON.stringify({
      type: 'message',
      id: 'factory-message',
      timestamp: '2026-07-27T11:00:00.000Z',
      message: { role: 'user', content: 'Synthetic Factory request.' },
    }),
  ].join('\n') + '\n');
  await writeFile(cursor, [
    JSON.stringify({
      role: 'user',
      timestamp: '2026-07-27T12:00:00.000Z',
      message: { content: 'Synthetic Cursor request.' },
    }),
    JSON.stringify({
      type: 'turn_ended',
      status: 'success',
      timestamp: '2026-07-27T12:00:01.000Z',
    }),
  ].join('\n') + '\n');
  await writeFile(codex, [
    JSON.stringify({
      timestamp: '2026-07-27T13:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: workspace },
    }),
    JSON.stringify({
      timestamp: '2026-07-27T13:00:01.000Z',
      type: 'response_item',
      payload: {
        id: 'codex-message',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic Codex request.' }],
      },
    }),
  ].join('\n') + '\n');
  await writeFile(unrelatedCodex, JSON.stringify({
    timestamp: '2026-07-27T14:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'unrelated-session', cwd: join(root, 'other-workspace') },
  }) + '\n');
  return { root, workspace, providerHome };
}
