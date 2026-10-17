import { mkdtemp } from '../helpers/temp-dir.js';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeDispatch } from '../../src/serve/dispatch-router.js';
import { UhpClient, UHP_VERSION, projectUhpResponseToCanonicalMission, type UhpEndpointProfile } from '../../src/uhp/index.js';
import type { ExecutorRegistration } from '../../src/serve/executor-registry.js';
import { FakeUhpServer } from '../helpers/uhp-fake-server.js';

const profile: UhpEndpointProfile = {
  endpoint: 'https://uhp.fixture', version: UHP_VERSION,
  credential: { source: 'env', name: 'UHP_FIXTURE_REFERENCE' }, experimental: true,
};

function client(server: FakeUhpServer) {
  return new UhpClient('fixture', profile, server.fetch as typeof fetch, async () => 'fixture-value');
}

describe('deterministic UHP fake server qualification', () => {
  it('covers discovery, catalogues, idempotent replay, continuation, cancellation, and canonical evidence', async () => {
    const server = new FakeUhpServer();
    const uhp = client(server);
    expect((await uhp.discover()).default_version).toBe(UHP_VERSION);
    expect((await uhp.listHarnesses())[0]?.id).toBe('chrn_fixture');
    expect(await uhp.listModels()).toMatchObject({ data: [{ id: 'fixture-model' }] });
    const first = await uhp.createResponse({ input: 'task', metadata: { harness_id: 'chrn_fixture' } });
    const replay = await uhp.createResponse({ input: 'task', metadata: { harness_id: 'chrn_fixture' } });
    expect(replay.id).toBe(first.id);
    expect((await uhp.continueResponse(first.id, { input: 'continue' })).metadata.harness_id).toBe('chrn_fixture');
    expect((await uhp.cancelResponse(first.id)).status).toBe('cancelled');
    expect(projectUhpResponseToCanonicalMission('fixture', first, { input: 'task' }).value.provenance.transport).toBe('uhp');
  });

  it('delivers SSE progressively and diagnoses sequence faults and disconnects', async () => {
    const events = [];
    for await (const event of client(new FakeUhpServer()).streamResponse({ input: 'stream' })) events.push(event.type);
    expect(events).toEqual(['response.created', 'response.completed']);
    const consume = async (server: FakeUhpServer) => { for await (const _event of client(server).streamResponse({ input: 'stream' })) { /* consume */ } };
    await expect(consume(new FakeUhpServer({ sequenceFault: true }))).rejects.toMatchObject({ code: 'event_sequence_gap' });
    await expect(consume(new FakeUhpServer({ disconnect: true }))).rejects.toMatchObject({ code: 'missing_terminal_event', options: { remoteState: 'unknown' } });
  });

  it('surfaces session_busy and contains hostile artifact names inside the approved directory', async () => {
    await expect(client(new FakeUhpServer({ sessionBusy: true })).createResponse({ input: 'busy' })).rejects.toMatchObject({ code: 'session_busy' });
    const directory = await mkdtemp(path.join(tmpdir(), 'aiwg-uhp-artifacts-'));
    const downloaded = await client(new FakeUhpServer({ hostileArtifact: true })).downloadArtifact('cntr_fixture', 'file_fixture', directory, '..%252foutside.txt');
    expect(path.dirname(downloaded.path)).toBe(directory);
    expect(await readFile(downloaded.path, 'utf8')).toBe('hostile fixture');
  });
});

describe('A2A/UHP routing isolation', () => {
  it('never crosses protocol endpoints implicitly', async () => {
    const uhpServer = new FakeUhpServer();
    await client(uhpServer).createResponse({ input: 'uhp-only' });
    expect(uhpServer.requests.every(request => new URL(request.url).pathname.startsWith('/v1/'))).toBe(true);
    const a2aCalls: string[] = [];
    const executor: ExecutorRegistration = {
      executorId: 'exec-a2a', name: 'fixture', version: '1', specVersion: '1',
      transportEndpoints: { rest: 'https://a2a.fixture', ws: 'wss://a2a.fixture/ws' },
      capabilities: [], token: 'fixture', connected: true, registeredAt: new Date(0).toISOString(), currentMissions: new Set(),
    };
    await routeDispatch(executor, { mission_id: 'mission-a2a', objective: 'a2a-only', completion: 'done', long_running: false }, {
      fetch: async input => { a2aCalls.push(String(input)); return new Response(JSON.stringify({ id: 'task-a2a', status: { state: 'submitted' } }), { status: 202, headers: { 'Content-Type': 'application/json' } }); },
    });
    expect(a2aCalls).toEqual(['https://a2a.fixture/agents/exec-a2a/v1/messages:send']);
    expect(uhpServer.requests.some(request => request.url.includes('a2a.fixture'))).toBe(false);
  });
});
