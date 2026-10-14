// AIWG Cockpit — in-process integration + a11y coverage for CI.
// Exercises the Bridge control surface against the mock executor without shelling
// the aiwg CLI (registry endpoints are covered by the standalone bridge smoke), so
// this stays fast and deterministic in CI. Imports cockpit source directly (apps/
// cockpit is in the repo checkout though excluded from the published tarball).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createExecutor } from '../../apps/cockpit/mock-executor/src/server.mjs';
import { activityRequest, createBridge, createUserIndexGraph, missionSummary, normalizeManagedDockerPosture, resolveBridgePort, DEFAULT_BRIDGE_PORT, EXECUTOR_RESERVED_PORTS, ensureExecutor, fetchJsonFirst, isDirectExecution, validateActivityEnvelope } from '../../apps/cockpit/bridge/src/server.mjs';

it('normalizes canonical UHP Mission evidence without losing transport-native fields', () => {
  const projected = missionSummary({
    apiVersion: 'mission.aiwg.io/v1', kind: 'Mission',
    metadata: { id: 'resp_fixture' }, spec: { objective: 'Remote task', completionCriterion: 'done' },
    status: { state: 'incomplete', terminal: true, nativeState: 'incomplete', artifacts: [{ id: 'file_fixture', kind: 'uhp-file' }] },
    provenance: { sourceContract: 'uhp-2026-08-11', sourceVersion: '2026-08-11', transport: 'uhp' },
    extensions: { 'aiwg.source.uhp-2026-08-11': { endpointProfile: 'research', responseId: 'resp_fixture', sessionId: 'hsessfixture' } },
  });
  expect(projected).toMatchObject({ id: 'resp_fixture', status: 'incomplete', terminal: true, transport: 'uhp', protocol_version: '2026-08-11', endpoint_profile: 'research', response_id: 'resp_fixture', remote_session_id: 'hsessfixture', artifacts: [{ id: 'file_fixture' }] });
});

let mock, bridge, base, token;
const testMcSessionId = `mc-cockpit-test-${Date.now()}`;
const testMcSessionDir = join(process.cwd(), '.aiwg', 'ralph-external', 'mc', 'sessions', testMcSessionId);
const testAuditDir = join(process.cwd(), '.aiwg', 'tmp-cockpit-bridge-audit-test');
const f = (p, o = {}) => fetch(base + p, { ...o, headers: { ...(o.headers || {}), authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env.AIWG_COCKPIT_AUDIT_DIR = testAuditDir;
  await rm(testAuditDir, { recursive: true, force: true });
  mock = createExecutor();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  bridge = createBridge({
    executorUrl: `http://127.0.0.1:${mock.address().port}`,
    allowMockExecutor: true,
    aiwgCommand: async (args) => {
      if (args.join(' ') === 'index status --json') {
        return JSON.stringify({ summary: { total: 0 }, graphs: [] });
      }
      throw new Error(`unexpected aiwg command: ${args.join(' ')}`);
    },
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${bridge.address().port}`;
  token = bridge.cockpitToken;
  await mkdir(testMcSessionDir, { recursive: true });
  await writeFile(join(testMcSessionDir, 'session.json'), JSON.stringify({
    id: testMcSessionId,
    name: 'Cockpit bridge mission projection',
    state: 'active',
    maxMissions: 4,
    createdAt: '2026-07-04T12:00:00.000Z',
    updatedAt: '2026-07-04T12:05:00.000Z',
    missions: [{
      id: 'm-cockpit-projection',
      objective: 'Bridge Mission projection and unified event model',
      completion: 'Missions render from durable MC state',
      status: 'running',
      loop: 2,
      maxIterations: 5,
      priority: 'high',
      ralphLoopId: 'ralph-loop-1',
      graph: { schemaVersion: 'graph.flow.aiwg.io/v1', graphId: 'examples/cockpit', graphVersion: '1.0.0', runId: 'run-cockpit-1', checkpointId: 'cp-1' },
      graphNodes: [{ nodeId: 'screen', nodeRunId: 'run-cockpit-1:screen', state: 'retrying', runtimeBinding: 'a2a-sandbox', routeReason: 'transient failure', evidenceSummary: 'redacted sandbox receipt', retryCount: 1, costUsd: 0.02, tokens: 20 }],
    }],
  }, null, 2));
  await writeFile(join(testMcSessionDir, 'log.jsonl'), [
    JSON.stringify({ event: 'session_started', ts: '2026-07-04T12:00:00.000Z', name: 'Cockpit bridge mission projection' }),
    JSON.stringify({ event: 'mission_started', ts: '2026-07-04T12:05:00.000Z', missionId: 'm-cockpit-projection', loopId: 'ralph-loop-1' }),
  ].join('\n') + '\n');
});
afterAll(async () => {
  bridge?.close();
  mock?.close();
  await rm(testMcSessionDir, { recursive: true, force: true });
  await rm(testAuditDir, { recursive: true, force: true });
  delete process.env.AIWG_COCKPIT_AUDIT_DIR;
});

describe('cockpit Bridge — control surface', () => {
  it('requires exact activity scope and rejects restricted or cross-scope events', () => {
    const request = activityRequest({ tenant_id: 't', host_id: 'h', instance_id: 'i', agent_id: 'a', filter: { limit: 50 } });
    expect(request.headers).toMatchObject({ 'x-agentic-tenant-id': 't', 'x-agentic-host-id': 'h', 'x-agentic-instance-id': 'i', 'x-agentic-agent-id': 'a' });
    expect(() => activityRequest({ tenant_id: 't', host_id: 'h', instance_id: 'i' })).toThrow(/agent_id/);
    const base = {
      schema_version: 'activity.event/v1', event_id: '018f54b0-7c01-7000-8000-000000000001', event_name: 'process.started', plane: 'runtime',
      occurred_at: '2026-08-04T00:00:00Z', observed_at: '2026-08-04T00:00:00.001Z',
      source: { collector: 'runtime', layer: 'host', runtime: 'docker', trust: 'observed' },
      sensitivity: 'metadata', retention_class: 'security', integrity: { collector_sequence: 1 }, correlation: request.scope,
    };
    const completeness = { complete: true, label: 'complete', collector_count: 0, sequence_gap_count: 0, durable_loss_count: 0, restart_count: 0, dropped_event_count: 0, stale_collector_count: 0, unsupported_event_classes: [], maximum_clock_error_ms: 0 };
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', events: [{ ...base, payload: { command: 'metadata-id' } }], coverage: [], completeness }, request.scope, { includeEvents: true })).not.toThrow();
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', events: [{ ...base, correlation: { ...request.scope, agent_id: 'other' }, payload: {} }], coverage: [], completeness }, request.scope, { includeEvents: true })).toThrow(/scope mismatch/);
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', events: [{ ...base, payload: { terminal_content: 'nope' } }], coverage: [], completeness }, request.scope, { includeEvents: true })).toThrow(/restricted/);
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', events: [], coverage: [], completeness: { ...completeness, unsupported_event_classes: undefined } }, request.scope)).toThrow(/completeness summary/);
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', events: [], coverage: [{ collector_id: 'runtime', sequence_gaps: [], durable_loss_records: [], stale: false }], completeness: { ...completeness, collector_count: 1 } }, request.scope)).toThrow(/collector coverage/);
    expect(() => validateActivityEnvelope({ schema_version: 'activity.event/v1', additive_optional_field: { supported: true }, events: [{ ...base, payload: {} }], coverage: [], completeness }, request.scope, { includeEvents: true })).not.toThrow();
    expect(() => validateActivityEnvelope({ events: [], manifest: { batch_id: 'b', tenant_id: 't', collector_id: 'runtime', event_count: 0, merkle_root: 'bad', previous_root: null, key_id: 'k', signature: 's' } }, request.scope, { exportEnvelope: true })).toThrow(/valid manifest/);
  });

  it('preserves upstream authorization failures for every activity route', async () => {
    const upstream = http.createServer((req, res) => {
      const status = req.url.includes('/timeline') ? 401 : 403;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'forbidden' }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const localBridge = createBridge({ executorUrl: `http://127.0.0.1:${upstream.address().port}`, allowMockExecutor: true });
    await new Promise((resolve) => localBridge.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${localBridge.address().port}`;
    const body = JSON.stringify({ tenant_id: 't', host_id: 'h', instance_id: 'i', agent_id: 'a' });
    try {
      for (const [route, status] of [['coverage', 403], ['timeline', 401], ['export', 403]]) {
        const response = await fetch(`${localBase}/api/activity/${route}`, { method: 'POST', headers: { authorization: `Bearer ${localBridge.cockpitToken}`, 'content-type': 'application/json' }, body });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(expect.objectContaining({ error: status === 401 ? 'executor_unauthenticated' : 'executor_forbidden' }));
      }
    } finally {
      localBridge.close();
      upstream.close();
    }
  });

  it('projects managed Docker posture without exposing socket or bootstrap material', () => {
    expect(normalizeManagedDockerPosture({ transport: 'uds', control_uid: 240404, workload_uid: 10001, workload_boundary: 'separated', socket_path: '/secret.sock' }, 'docker')).toEqual(expect.objectContaining({ secure_default: true, control_identity_range_valid: true, workload_identity_separated: true }));
    expect(normalizeManagedDockerPosture({ transport: 'mtls-bootstrap', control_uid: 240405, workload_uid: 10001, workload_boundary: 'separated', bootstrap_token: 'secret' }, 'docker')).toEqual(expect.objectContaining({ secure_default: false, compatibility: true }));
    expect(normalizeManagedDockerPosture({ transport: 'uds' }, 'docker')).toEqual(expect.objectContaining({ secure_default: false, requires_recreation: true }));
    expect(normalizeManagedDockerPosture({ transport: 'uds', control_uid: 199999, workload_uid: 10001, workload_boundary: 'separated' }, 'docker')).toEqual(expect.objectContaining({ control_identity_range_valid: false }));
  });
  it('creates validated user-defined index graph configuration atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-cockpit-index-'));
    try {
      const created = await createUserIndexGraph({ name: 'references', scanDirs: ['docs/references'], extensions: ['.md'] }, root);
      expect(created).toMatchObject({ name: 'references', definition: { scanDirs: ['docs/references'], extensions: ['.md'] } });
      const config = JSON.parse(await readFile(join(root, '.aiwg', 'aiwg.config'), 'utf8'));
      expect(config.index.graphs.references.defaultBuild).toBe(false);
      await expect(createUserIndexGraph({ name: '../escape', scanDirs: ['docs'] }, root)).rejects.toThrow(/graph must match/);
      await expect(createUserIndexGraph({ name: 'bad-path', scanDirs: ['../outside'] }, root)).rejects.toThrow(/project-relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('gates /api with the per-launch token; /healthz is open', async () => {
    expect((await fetch(`${base}/api/inventory`)).status).toBe(401);
    expect((await fetch(`${base}/api/inventory?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await f('/api/inventory')).status).toBe(200);
  });

  it('exchanges a one-time bootstrap for an HttpOnly session and rejects replay', async () => {
    const issued = await f('/bootstrap/nonce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audience: 'browser' }),
    });
    expect(issued.status).toBe(201);
    const { nonce } = await issued.json();

    const exchange = await fetch(`${base}/bootstrap/session`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, audience: 'browser' }),
    });
    expect(exchange.status).toBe(201);
    const cookie = exchange.headers.get('set-cookie');
    expect(cookie).toMatch(/^cockpit_session=[^;]+; HttpOnly; Path=\/; SameSite=Strict/);
    expect(cookie).not.toContain(token);
    const { csrf } = await exchange.json();
    expect(csrf).toMatch(/^[A-Za-z0-9_-]+$/);

    const replay = await fetch(`${base}/bootstrap/session`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, audience: 'browser' }),
    });
    expect(replay.status).toBe(401);

    const cookieHeader = cookie.split(';', 1)[0];
    expect((await fetch(`${base}/api/inventory`, { headers: { cookie: cookieHeader, origin: base } })).status).toBe(200);
    const mutationPath = '/api/instances/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b/start';
    expect((await fetch(base + mutationPath, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: base },
    })).status).toBe(403);
    expect((await fetch(base + mutationPath, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: base, 'x-cockpit-csrf': csrf },
    })).status).toBe(200);

    const events = await fetch(`${base}/api/events`, { headers: { cookie: cookieHeader, origin: base } });
    expect(events.status).toBe(200);
    expect(events.url).not.toContain('token=');
    const reader = events.body.getReader();
    await reader.read();
    await reader.cancel();

    const sessions = await (await fetch(
      `${base}/api/sessions?instance=550e8400-e29b-41d4-a716-446655440000`,
      { headers: { cookie: cookieHeader, origin: base } },
    )).json();
    const attachUrl = sessions.sessions.find((entry) => entry.id === 'demo-shell')?.attach_url;
    expect(attachUrl).toMatch(/^ws:\/\/.*\/api\/pty\//);
    const socket = new WebSocket(attachUrl, ['pty-ws.v1'], { headers: { cookie: cookieHeader } });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.close();
  });

  it('rejects expired, wrong-audience, and cross-Bridge bootstrap attempts', async () => {
    const candidate = createBridge({
      executorUrl: `http://127.0.0.1:${mock.address().port}`,
      allowMockExecutor: true,
      bootstrapTtlMs: 1,
    });
    await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const candidateBase = `http://127.0.0.1:${candidate.address().port}`;
    try {
      const issue = async (audience = 'vscode') => {
        const response = await fetch(`${candidateBase}/bootstrap/nonce`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${candidate.cockpitToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ audience }),
        });
        return (await response.json()).nonce;
      };
      const wrongAudience = await issue();
      expect((await fetch(`${candidateBase}/bootstrap/session`, {
        method: 'POST',
        headers: { origin: candidateBase, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: wrongAudience, audience: 'tauri' }),
      })).status).toBe(401);

      const expired = await issue();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await fetch(`${candidateBase}/bootstrap/session`, {
        method: 'POST',
        headers: { origin: candidateBase, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: expired, audience: 'vscode' }),
      })).status).toBe(401);

      const foreign = bridge.issueBootstrapNonce('browser');
      expect((await fetch(`${candidateBase}/bootstrap/session`, {
        method: 'POST',
        headers: { origin: candidateBase, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: foreign, audience: 'browser' }),
      })).status).toBe(401);
    } finally {
      await new Promise((resolve) => candidate.close(resolve));
    }
  });

  it('rejects spoofed browser origins and requires CSRF on browser mutations', async () => {
    expect((await fetch(`${base}/api/inventory`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://example.test' },
    })).status).toBe(403);

    const id = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
    expect((await fetch(`${base}/api/instances/${id}/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: base },
    })).status).toBe(403);
    expect((await fetch(`${base}/api/instances/${id}/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: base, 'x-cockpit-csrf': token },
    })).status).toBe(200);
  });

  it('streams token-gated live refresh events', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const res = await f('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).toContain('event: cockpit.refresh');
  });

  it('serves inventory, running, and sessions with a ws attach_url', async () => {
    const inv = await (await f('/api/inventory')).json();
    expect(inv.count).toBe(4);
    expect(inv.source).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(inv.bootstrap_trust).toMatchObject({
      status: 'secure',
      mode: 'mtls',
      ca_provider_ref: 'local-ca://cockpit-mock',
      trust_bundle_ref: 'trust-bundle://cockpit-mock/current',
      missing_required_material: [],
    });
    expect(JSON.stringify(inv.bootstrap_trust)).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|secret-value|sk-|Bearer /i);
    expect(inv.instances.find((x) => x.runtime === 'host')?.runtime_posture).toMatchObject({ isolation: 'least' });
    expect(inv.instances.find((x) => x.runtime === 'wasm-edge')?.runtime_posture).toMatchObject({ isolation: 'opaque' });
    expect(inv.instances.find((x) => x.transport?.trust === 'compatibility')?.transport.evidence).not.toMatch(/secret-value|token/i);
    const run = await (await f('/api/running')).json();
    expect(run.count).toBeGreaterThanOrEqual(2);
    expect(run.running[0]).toHaveProperty('runtime_posture');
    expect(run.running[0]).toHaveProperty('transport');
    const s = await (await f('/api/sessions?instance=550e8400-e29b-41d4-a716-446655440000')).json();
    expect(s.sessions.find((x) => x.id === 'demo-shell')?.attach_url).toMatch(/^ws:\/\/.*\/api\/pty\/agents\/.*\/attach\/[A-Za-z0-9_-]+$/);
    expect(s.sessions.find((x) => x.id === 'demo-shell')).toMatchObject({ session_class: 'direct', session_backend: 'native', role_policy: 'observe-default' });
  });

  it('fails closed when Cockpit requires sandbox mTLS and CA readiness is missing', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', surfaces: ['admin'] }));
        return;
      }
      if (req.url === '/api/v2/admin/bootstrap/readiness') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'disabled',
          ca_provider: { configured: false },
          bootstrap: { token_store_configured: false },
        }));
        return;
      }
      if (req.url === '/admin/instances') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ instances: [] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const gated = createBridge({
      executorUrl: `http://127.0.0.1:${upstream.address().port}`,
      allowMockExecutor: true,
      requireSandboxMtls: true,
    });
    await new Promise((r) => gated.listen(0, '127.0.0.1', r));
    try {
      const root = `http://127.0.0.1:${gated.address().port}`;
      const res = await fetch(`${root}/api/inventory`, { headers: { authorization: `Bearer ${gated.cockpitToken}` } });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'executor_trust_required' });
      expect(body.message).toBe('Bridge request failed.');
      expect(body.recovery).toMatch(/Configure sandbox CA provider|Plaintext local development/);
    } finally {
      gated.close();
      upstream.close();
    }
  });

  it('proxies server-side PTY screen snapshots for background monitoring (#1742)', async () => {
    const screen = await (await f('/api/instances/550e8400-e29b-41d4-a716-446655440000/sessions/demo-shell/screen')).json();
    expect(screen).toMatchObject({
      instance_id: '550e8400-e29b-41d4-a716-446655440000',
      session_id: 'demo-shell',
      snapshot_format: 'text/plain',
    });
    expect(screen.text).toContain('aiwg discover');
    expect(screen.lines.some((line) => line.includes('flow-deploy-to-production'))).toBe(true);
  });

  it('creates sessions with sandbox-advertised direct or managed backend selection', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const created = await (await f(`/api/instances/${id}/sessions?mode=managed&backend=tmux`, { method: 'POST' })).json();
    expect(created.attach_url).toMatch(/^ws:\/\/.*\/api\/pty\/agents\/.*\/attach\/[A-Za-z0-9_-]+$/);
    expect(created.session_name).toMatch(/^cockpit-/);
    // Multi-session per instance: a second create is a NEW session (unique
    // per-request name), never a silent reuse of the first (#1749 follow-up to
    // the #1738 dedupe — dedupe now applies within one request's candidates only).
    const second = await (await f(`/api/instances/${id}/sessions?mode=managed&backend=tmux`, { method: 'POST' })).json();
    expect(second.id).not.toBe(created.id);
    expect(second.session_name).not.toBe(created.session_name);
    const s = await (await f(`/api/sessions?instance=${id}`)).json();
    expect(s.sessions.find((x) => x.id === created.id)).toMatchObject({ session_class: 'managed', session_backend: 'tmux' });
    expect(s.sessions.find((x) => x.id === second.id)).toBeTruthy();
  });

  it('does not fall through to another POST candidate after a timeout (#1738)', async () => {
    let secondHit = false;
    const upstream = http.createServer((req, res) => {
      if (req.url === '/slow' && req.method === 'POST') return;
      if (req.url === '/second' && req.method === 'POST') {
        secondHit = true;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    try {
      const root = `http://127.0.0.1:${upstream.address().port}`;
      await expect(fetchJsonFirst([
        { target: `${root}/slow`, method: 'POST' },
        { target: `${root}/second`, method: 'POST' },
      ], { timeoutMs: 5, executorUrl: root })).rejects.toThrow(/timeout after 5ms/);
      expect(secondHit).toBe(false);
    } finally {
      upstream.close();
    }
  });

  it('rejects VM launch before provisioning when no SSH public key is configured', async () => {
    const res = await f('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'qemu', name: 'vm-no-key', start: true, ssh_key: '/tmp/aiwg-missing-key.pub' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'ssh_public_key_not_found' });
    expect(body.message).toMatch(/SSH public key not found/);
  });

  it('reports the configured agentic-sandbox executor seam', async () => {
    const h = await (await f('/api/health')).json();
    expect(h).toMatchObject({ status: 'ok' });
    expect(h.executor_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(h).not.toHaveProperty('mock');
    // Desktop panel gate (#2547): off without both desktop adapters.
    expect(h.desktop).toEqual({ configured: false });
  });

  it('loads declarative contributions whose actions inject commands (no Bridge CLI run)', async () => {
    const c = await (await f('/api/contributions')).json();
    expect(c.sources.some((x) => x.id === 'aiwg-core')).toBe(true);
    const audit = c.actions.find((a) => a.id === 'audit-issues');
    expect(audit?.inject?.command).toMatch(/issue-audit/);
    expect(c.screens.find((s) => s.id === 'index-live')).toMatchObject({
      title: 'Live Index',
      source: 'cockpit://index/live',
      contribution: 'aiwg-core',
    });
    expect(c.workflows.find((w) => w.id === 'issue-resolution')?.steps.map((s) => s.action)).toEqual(['audit-issues', 'address-issues']);
    // the spawn-aiwg action-run endpoint is gone
    expect((await f('/api/actions/audit-issues/run', { method: 'POST' })).status).toBe(404);

    const intent = await f('/api/audit/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'action.inject.requested',
        detail: {
          action_id: audit.id,
          command: `${audit.inject.command} --token sk-test-secret`,
        },
      }),
    });
    expect(intent.status).toBe(201);
    const auditLog = await (await f('/api/audit?limit=5')).json();
    const event = auditLog.audit.find((x) => x.event === 'action.inject.requested');
    expect(event).toMatchObject({ actor: 'operator', surface: 'cockpit-bridge' });
    expect(JSON.stringify(event)).not.toContain('sk-test-secret');
  });

  it('rejects malformed capability search filters before shelling to aiwg discover', async () => {
    const missingQuery = await f('/api/capabilities');
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toMatchObject({ error: 'q_required' });

    const invalidType = await f('/api/capabilities?q=index&type=backend');
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({ error: 'invalid_type' });

    for (const limit of ['0', '-1', '2.5', '51', 'many']) {
      const invalidLimit = await f(`/api/capabilities?q=index&limit=${encodeURIComponent(limit)}`);
      expect(invalidLimit.status).toBe(400);
      expect(await invalidLimit.json()).toMatchObject({ error: 'invalid_limit' });
    }
  });

  it('surfaces live artifact-index status and validates index query input', async () => {
    const status = await f('/api/index/status');
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.summary).toHaveProperty('total');
    expect(Array.isArray(body.graphs)).toBe(true);

    const missingQuery = await f('/api/index/query');
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toMatchObject({ error: 'q_required' });

    const invalidLimit = await f('/api/index/query?q=mission&limit=101');
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toMatchObject({ error: 'invalid_limit' });
  });

  it('drives lifecycle, approvals (no flip), and cost', async () => {
    const id = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
    expect((await (await f(`/api/instances/${id}/start`, { method: 'POST' })).json()).state).toBe('running');
    expect((await (await f(`/api/instances/${id}/stop`, { method: 'POST' })).json()).state).toBe('stopped');
    const approvals = await (await f('/api/approvals?status=pending')).json();
    expect(approvals.derived).toBe('per-instance A2A input-required tasks');
    expect(approvals.approvals[0]).toMatchObject({ status: 'pending', task_id: expect.any(String), derived: 'a2a input-required task' });
    expect((await (await f(`/api/approvals/${encodeURIComponent(approvals.approvals[0].id)}?decision=approve`, { method: 'POST' })).json()).status.state).toBe('completed');
    expect((await f(`/api/approvals/${encodeURIComponent(approvals.approvals[0].id)}?decision=deny`, { method: 'POST' })).status).toBe(409);
    const auditLog = await (await f('/api/audit?limit=20')).json();
    expect(auditLog.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'approval.response.submitted', decision: 'approve', status: 200 }),
      expect.objectContaining({ event: 'approval.response.submitted', decision: 'deny', status: 409 }),
    ]));
    expect((await (await f('/api/cost')).json()).total.usd).toBeGreaterThan(0);
  });

  it('projects durable Mission Control state alongside live executor tasks and unified events', async () => {
    const missions = await (await f('/api/missions')).json();
    const mcSession = missions.sessions.find((s) => s.id === testMcSessionId);
    expect(mcSession).toMatchObject({
      name: 'Cockpit bridge mission projection',
      source: 'aiwg-mc',
      audit_count: 2,
    });
    expect(mcSession.missions[0]).toMatchObject({
      id: 'm-cockpit-projection',
      title: 'Bridge Mission projection and unified event model',
      status: 'running',
      ralph_loop_id: 'ralph-loop-1',
      source: 'aiwg-mc',
      graph: { graph_id: 'examples/cockpit', run_id: 'run-cockpit-1', checkpoint_id: 'cp-1' },
      graph_nodes: [expect.objectContaining({ node_id: 'screen', state: 'retrying', runtime_binding: 'a2a-sandbox', evidence_summary: 'redacted sandbox receipt' })],
    });
    expect(missions.sessions.some((s) => s.id === 'executor-live')).toBe(true);
    const fleetSession = missions.sessions.find((s) => s.parent_mission_id === 'mission-fleet-demo');
    expect(fleetSession).toMatchObject({
      id: 'fleet:mission-fleet-demo',
      source: 'agentic-sandbox-fleet',
      state: 'awaiting-approval',
      inventory_revision: 12,
    });
    expect(fleetSession.missions).toEqual(expect.arrayContaining([
      expect.objectContaining({ workload_kind: 'persistent-agent', target_id: 'target-1', runtime_session_id: 'session-agent-1', status: 'retained', terminal: false }),
      expect.objectContaining({ workload_kind: 'daemon', target_id: 'target-2', health: 'healthy', status: 'healthy', terminal: false }),
      expect.objectContaining({ workload_kind: 'one-shot-command', target_id: 'target-3', command_id: 'command-1', status: 'blocked', backpressure: { reason: 'approval', retryable: false }, terminal: false }),
    ]));

    const events = await (await f('/api/events/snapshot')).json();
    expect(events.source).toBe('cockpit.unified-event-model/v1');
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'mission.lifecycle', subject: 'm-cockpit-projection', state: 'running' }),
      expect.objectContaining({ type: 'task.lifecycle' }),
      expect.objectContaining({ type: 'inventory.instance' }),
      expect.objectContaining({ type: 'session.lifecycle', subject: 'demo-shell', state: 'available' }),
    ]));
  });
});

describe('cockpit Bridge — A2A 1.0 normalized projections', () => {
  let v1Mock, v1Bridge, v1Base, v1Token;
  beforeAll(async () => {
    v1Mock = createExecutor({ protocolMode: 'dual' });
    await new Promise((resolve) => v1Mock.listen(0, '127.0.0.1', resolve));
    v1Bridge = createBridge({
      executorUrl: `http://127.0.0.1:${v1Mock.address().port}`,
      allowMockExecutor: true,
      a2aProtocolPolicy: '1.0',
    });
    await new Promise((resolve) => v1Bridge.listen(0, '127.0.0.1', resolve));
    v1Base = `http://127.0.0.1:${v1Bridge.address().port}`;
    v1Token = v1Bridge.cockpitToken;
  });
  afterAll(() => { v1Bridge?.close(); v1Mock?.close(); });
  const v1Fetch = (path, options = {}) => fetch(v1Base + path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${v1Token}` },
  });

  it('normalizes 1.0 task enums for inventory, running, cancel, and HITL views', async () => {
    const inventory = await (await v1Fetch('/api/inventory')).json();
    expect(inventory.instances[0].a2a_protocol.selected_version).toBe('1.0');

    const running = await (await v1Fetch('/api/running')).json();
    expect(running.running[0]).toMatchObject({ state: 'working', task_id: expect.any(String) });
    const victim = running.running[0];
    const canceledResponse = await v1Fetch(
      `/api/tasks/${encodeURIComponent(victim.instance_id)}/${encodeURIComponent(victim.task_id)}/cancel`,
      { method: 'POST' }
    );
    const canceled = await canceledResponse.json();
    expect(canceledResponse.status, JSON.stringify(canceled)).toBe(200);
    expect(canceled).toHaveProperty('status');
    expect(canceled.status.state).toBe('canceled');

    const approvals = await (await v1Fetch('/api/approvals?status=pending')).json();
    expect(approvals.approvals[0]).toMatchObject({ status: 'pending', task_id: expect.any(String) });
    const approved = await (await v1Fetch(
      `/api/approvals/${encodeURIComponent(approvals.approvals[0].id)}?decision=approve`,
      { method: 'POST' }
    )).json();
    expect(approved.status.state).toBe('completed');
  });
});

describe('cockpit Bridge — mock executor guard', () => {
  let guardedMock, guardedBridge, guardedBase, guardedToken;
  beforeAll(async () => {
    guardedMock = createExecutor();
    await new Promise((r) => guardedMock.listen(0, '127.0.0.1', r));
    guardedBridge = createBridge({ executorUrl: `http://127.0.0.1:${guardedMock.address().port}` });
    await new Promise((r) => guardedBridge.listen(0, '127.0.0.1', r));
    guardedBase = `http://127.0.0.1:${guardedBridge.address().port}`;
    guardedToken = guardedBridge.cockpitToken;
  });
  afterAll(() => { guardedBridge?.close(); guardedMock?.close(); });

  it('refuses mock-like executors unless an automated harness opts in', async () => {
    const res = await fetch(`${guardedBase}/api/inventory`, {
      headers: { authorization: `Bearer ${guardedToken}` },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'mock_executor_refused' });
  });
});

describe('cockpit Bridge — protected executor identity', () => {
  const authDir = join(process.cwd(), '.aiwg', 'tmp-cockpit-executor-auth-test');
  const adminTokenFile = join(authDir, 'admin.token');
  const operatorTokenFile = join(authDir, 'operator.token');
  const wrongTokenFile = join(authDir, 'wrong.token');
  const invalidTokenFile = join(authDir, 'invalid.token');
  const missingTokenFile = join(authDir, 'missing.token');
  const looseTokenFile = join(authDir, 'loose.token');
  let upstream, protectedBridge, protectedBase, protectedToken;
  let attachAuthorization = '';
  let expectedAdminToken = 'synthetic-admin-v1';

  beforeAll(async () => {
    await rm(authDir, { recursive: true, force: true });
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    await writeFile(adminTokenFile, `${expectedAdminToken}\n`, { mode: 0o600 });
    await writeFile(operatorTokenFile, 'synthetic-operator\n', { mode: 0o600 });
    await writeFile(wrongTokenFile, 'synthetic-wrong\n', { mode: 0o600 });
    await writeFile(invalidTokenFile, 'synthetic-one\nsynthetic-two\n', { mode: 0o600 });
    await writeFile(looseTokenFile, 'synthetic-loose\n', { mode: 0o644 });
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/health') return send(200, { status: 'ok', name: 'protected-executor' });
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!bearer || ![expectedAdminToken, 'synthetic-operator'].includes(bearer)) {
        return send(401, { error: 'missing_or_invalid_operator_token' });
      }
      if (bearer === 'synthetic-operator' && url.pathname.includes('/admin/')) {
        return send(403, { error: 'admin_role_required' });
      }
      if (url.pathname === '/admin/instances') {
        return send(200, { instances: [{ id: 'protected-host', runtime: 'host', state: 'running', agent_ready: true }] });
      }
      if (url.pathname === '/api/v1/agents') {
        return send(200, { agents: [{ id: 'protected-agent', instance_id: 'protected-host', status: 'Ready' }] });
      }
      if (url.pathname === '/agents/protected-host/sessions' || url.pathname === '/api/v1/agents/protected-agent/sessions') {
        return send(200, { sessions: [{
          id: 'protected-session',
          instance_id: 'protected-host',
          attach_url: `ws://localhost:${upstream.address().port}/agents/protected-host/sessions/protected-session/attach`,
        }] });
      }
      return send(404, { error: 'not_found' });
    });
    upstream.on('upgrade', (req, socket) => {
      attachAuthorization = String(req.headers.authorization ?? '');
      if (attachAuthorization !== `Bearer ${expectedAdminToken}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        'Sec-WebSocket-Protocol: pty-ws.v1',
        '',
        '',
      ].join('\r\n'));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    protectedBridge = createBridge({
      executorUrl: `http://127.0.0.1:${upstream.address().port}`,
      executorTokenFile: adminTokenFile,
    });
    await new Promise((resolve) => protectedBridge.listen(0, '127.0.0.1', resolve));
    protectedBase = `http://127.0.0.1:${protectedBridge.address().port}`;
    protectedToken = protectedBridge.cockpitToken;
  });

  afterAll(async () => {
    protectedBridge?.close();
    upstream?.close();
    await rm(authDir, { recursive: true, force: true });
  });

  const protectedFetch = (path, options = {}) => fetch(protectedBase + path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${protectedToken}` },
  });

  it('keeps the executor bearer in the Bridge and proxies a loopback alias to its configured PTY origin', async () => {
    const inventory = await protectedFetch('/api/inventory');
    expect(inventory.status).toBe(200);
    expect(await inventory.json()).toMatchObject({ count: 1, instances: [expect.objectContaining({ id: 'protected-host' })] });

    const sessions = await (await protectedFetch('/api/sessions?instance=protected-host')).json();
    expect(sessions.sessions[0].attach_url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${protectedBridge.address().port}/api/pty/agents/`));
    expect(sessions.sessions[0].attach_url).not.toContain(expectedAdminToken);

    const cockpitProtocol = `cockpit.${Buffer.from(protectedToken).toString('base64url')}`;
    const ws = new WebSocket(sessions.sessions[0].attach_url, ['pty-ws.v1', cockpitProtocol]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('protected PTY proxy did not open')), 3_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('protected PTY proxy failed')); }, { once: true });
    });
    expect(attachAuthorization).toBe(`Bearer ${expectedAdminToken}`);
    ws.close();
  });

  it('reloads a rotated file token without restarting the Bridge', async () => {
    expectedAdminToken = 'synthetic-admin-v2';
    await writeFile(adminTokenFile, `${expectedAdminToken}\n`, { mode: 0o600 });
    const inventory = await protectedFetch('/api/inventory');
    expect(inventory.status).toBe(200);
  });

  it('preserves upstream 401/403 and rejects an over-broad credential file', async () => {
    const cases = [
      { file: wrongTokenFile, status: 401, error: 'executor_unauthenticated' },
      { file: operatorTokenFile, status: 403, error: 'executor_forbidden' },
      { file: missingTokenFile, status: 502, error: 'executor_credential_unavailable' },
      { file: invalidTokenFile, status: 502, error: 'executor_credential_invalid' },
      { file: looseTokenFile, status: 502, error: 'executor_credential_permissions' },
    ];
    for (const testCase of cases) {
      const candidate = createBridge({
        executorUrl: `http://127.0.0.1:${upstream.address().port}`,
        executorTokenFile: testCase.file,
      });
      await new Promise((resolve) => candidate.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${candidate.address().port}/api/inventory`, {
          headers: { authorization: `Bearer ${candidate.cockpitToken}` },
        });
        expect(response.status).toBe(testCase.status);
        const body = await response.json();
        expect(body.error).toBe(testCase.error);
        expect(JSON.stringify(body)).not.toContain('synthetic-');
        expect(JSON.stringify(body)).not.toContain(testCase.file);
      } finally {
        candidate.close();
      }
    }
  });
});

describe('cockpit Bridge — real sandbox v2 admin compatibility', () => {
  let upstream, compatBridge, compatBase, compatToken;
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/admin/instances') return send(404, { error: 'legacy_admin_absent' });
      if (url.pathname === '/api/v2/admin/instances') {
        return send(200, {
          data: {
            instances: [{
              instanceId: 'v2-host-1',
              runtime: { kind: 'host' },
              loadout: 'host-tools',
              status: 'running',
              tenantId: 'default',
              launchContext: { cwd: '/work', selectedTier: 'host' },
              hostDaemon: { status: 'degraded', detail: 'reachable with warnings' },
              security: { transport: { mode: 'mtls-local-ca', source: 'v2 admin', evidence: 'peer cert fingerprint' } },
            }, {
              instanceId: 'ghost-vm-1',
              runtime: { kind: 'qemu' },
              loadout: 'vm-tools',
              status: 'running',
              tenantId: 'default',
              launchContext: { selectedTier: 'vm' },
            }, {
              instanceId: 'ready-qemu-1',
              runtime: { kind: 'qemu' },
              loadout: 'vm-tools',
              status: 'running',
              tenantId: 'default',
              launchContext: { selectedTier: 'vm' },
            }, {
              instanceId: 'v2-container-1',
              runtime: { kind: 'container' },
              loadout: 'agentic-dev',
              status: 'running',
              tenantId: 'default',
              cwd: '/srv/container-home',
              launchContext: { selectedTier: 'container' },
            }],
          },
        });
      }
      if (url.pathname === '/admin/running') return send(404, { error: 'legacy_running_absent' });
      if (url.pathname === '/api/v2/admin/running') {
        return send(200, { tasks: [{ instanceId: 'v2-host-1', taskId: 'task-1', status: 'working', tenantId: 'default' }] });
      }
      if (url.pathname === '/admin/instances/v2-host-1/start' || url.pathname === '/admin/instances/v2-host-1/stop') {
        return send(404, { error: 'legacy_lifecycle_absent' });
      }
      if (url.pathname === '/api/v2/admin/instances/v2-host-1/start' && req.method === 'POST') {
        return send(200, { instanceId: 'v2-host-1', status: 'running' });
      }
      if (url.pathname === '/api/v2/admin/instances/v2-host-1/stop' && req.method === 'POST') {
        return send(200, { instanceId: 'v2-host-1', status: 'stopped' });
      }
      if (url.pathname === '/admin/instances/v2-host-1' && req.method === 'DELETE') {
        return send(404, { error: 'legacy_delete_absent' });
      }
      if (url.pathname === '/api/v2/admin/instances/v2-host-1' && req.method === 'DELETE') {
        return send(200, { destroyed: 'v2-host-1' });
      }
      if (url.pathname === '/api/v1/agents') {
        return send(200, { agents: [
          { id: 'agent-v2-host-1', instance_id: 'v2-host-1', status: 'Ready' },
          { id: 'agent-ready-qemu-1', instance_id: 'ready-qemu-1', status: 'Ready' },
          { id: 'agent-v2-container-1', instance_id: 'v2-container-1', status: 'Ready' },
        ] });
      }
      if (url.pathname === '/agents/v2-host-1/sessions') return send(404, { error: 'legacy_sessions_absent' });
      if (url.pathname === '/agents/v2-host-1/v1/sessions') return send(404, { error: 'preformal_sessions_absent' });
      if (url.pathname === '/api/v1/agents/v2-host-1/sessions') return send(404, { error: 'instance_id_is_not_session_agent_id' });
      if (url.pathname === '/api/v1/agents/agent-v2-host-1/sessions' && req.method === 'GET') {
        // Executor can list the same session twice (double-registered in its
        // registry); the Bridge must dedup so the picker shows it once.
        // No pty_ws_url here on purpose, so attach_url goes through the Bridge's
        // fallback construction — which must key the path by the instance id
        // (v2-host-1), NOT the resolved agent name (agent-v2-host-1) the
        // executor's pty-ws route would reject (#1671).
        // v2 SessionEntry shape (v2026.7.2): membership/liveness objects. The Bridge
        // consumes these directly — no flat-field translation (#1745).
        const one = {
          session_id: 'sess-v2',
          session_name: 'terminal-v2',
          session_backend: 'tmux',
          session_class: 'managed',
          role_policy: 'observe-default',
          membership: { controllers: ['ctrl-1'], observers: ['obs-1', 'obs-2'], attachment_count: 3 },
          liveness: { agent_connected: true, has_screen: true, replay_newest_seq: 2, max_client_lag: 0 },
        };
        return send(200, { items: [one, { ...one }] });
      }
      if (url.pathname === '/api/v1/agents/agent-v2-host-1/sessions/sess-v2/screen' && req.method === 'GET') {
        return send(200, { seq: 3, text: 'v2 session line\nNeed input? [y/N]\n', snapshot_format: 'text/plain' });
      }
      // A2A task surface the Bridge derives the running board + approval inbox from (#1639).
      if (url.pathname === '/agents/agent-v2-host-1/tasks' || url.pathname === '/api/v1/agents/agent-v2-host-1/tasks') {
        return send(200, { tasks: [
          { id: 'task-1', status: { state: 'working' }, metadata: { tenant_id: 'default' } },
          { id: 'hitl-1', status: { state: 'input-required', message: 'Allow deploy?' }, metadata: { tenant_id: 'default', hitl_prompt: { prompt: 'Allow deploy?', risk: 'high' } } },
        ] });
      }
      if (url.pathname === '/api/v1/agents/agent-v2-host-1/tasks/hitl-1:respond' && req.method === 'POST') {
        return send(200, { id: 'hitl-1', status: { state: 'completed' }, metadata: { hitl_response: { decision: 'approve' } } });
      }
      if (url.pathname === '/api/v1/agents/agent-v2-host-1/sessions' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const body = raw ? JSON.parse(raw) : {};
          send(201, { session_id: 'sess-created-v1', requested: body, pty_ws_url: 'wss://{host}/agents/v2-host-1/sessions/sess-created-v1/attach' });
        });
        return;
      }
      if (url.pathname === '/api/v1/agents/agent-v2-container-1/sessions' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const body = raw ? JSON.parse(raw) : {};
          send(201, { session_id: 'sess-created-container-v1', requested: body, pty_ws_url: 'wss://{host}/agents/v2-container-1/sessions/sess-created-container-v1/attach' });
        });
        return;
      }
      return send(404, { error: 'not_found', path: url.pathname });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    compatBridge = createBridge({ executorUrl: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => compatBridge.listen(0, '127.0.0.1', r));
    compatBase = `http://127.0.0.1:${compatBridge.address().port}`;
    compatToken = compatBridge.cockpitToken;
  });
  afterAll(() => { compatBridge?.close(); upstream?.close(); });

  const cf = (p, o = {}) => fetch(compatBase + p, { ...o, headers: { ...(o.headers || {}), authorization: `Bearer ${compatToken}` } });

  it('falls back to /api/v2/admin/instances and normalizes v2-shaped fields', async () => {
    const inv = await (await cf('/api/inventory')).json();
    expect(inv.admin_path).toBe('/api/v2/admin/instances');
    expect(inv.instances[0]).toMatchObject({
      id: 'v2-host-1',
      runtime: 'host',
      state: 'running',
      tenant: 'default',
      runtime_posture: { isolation: 'least' },
      transport: { trust: 'secure' },
      host_daemon: { status: 'degraded' },
    });
    expect(inv.instances[0].session_backends[0]).toMatchObject({ mode: 'managed', backend: 'tmux', available: true, drive: true });
    expect(inv.instances.find((x) => x.id === 'ready-qemu-1')).toMatchObject({
      runtime: 'qemu',
      runtime_posture: { kind: 'vm', isolation: 'strong' },
      agent_ready: true,
      session_backends: [expect.objectContaining({ mode: 'managed', backend: 'tmux', available: true, drive: true })],
    });

    const running = await (await cf('/api/running')).json();
    expect(running.running[0]).toMatchObject({ instance_id: 'v2-host-1', task_id: 'task-1', state: 'working' });
    expect(running.running[0].runtime_posture).toMatchObject({ isolation: 'least' });

    const approvals = await (await cf('/api/approvals?status=pending')).json();
    expect(approvals).toMatchObject({ derived: 'per-instance A2A input-required tasks' });
    expect(approvals.approvals[0]).toMatchObject({ instance_id: 'v2-host-1', task_id: 'hitl-1', prompt: 'Allow deploy?', risk: 'high' });
    const approved = await (await cf(`/api/approvals/${encodeURIComponent(approvals.approvals[0].id)}?decision=approve`, { method: 'POST' })).json();
    expect(approved).toMatchObject({ id: 'hitl-1', status: { state: 'completed' } });

    const sessions = await (await cf('/api/sessions?instance=v2-host-1')).json();
    // Executor returned sess-v2 twice; the Bridge dedups to a single row.
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]).toMatchObject({ id: 'sess-v2', instance_id: 'v2-host-1' });
    // #1745: the v2 membership/liveness objects pass through the Bridge untouched —
    // no flat-field translation — so the UI reads real controller/observer counts.
    expect(sessions.sessions[0].membership).toEqual({ controllers: ['ctrl-1'], observers: ['obs-1', 'obs-2'], attachment_count: 3 });
    expect(sessions.sessions[0].session_backend).toBe('tmux');
    expect(sessions.sessions[0].session_class).toBe('managed');
    // #1671: the fallback-built attach_url keys the agent segment by the instance
    // id, never the resolved agent name (agent-v2-host-1), which the route rejects.
    expect(sessions.sessions[0].attach_url).toMatch(/^ws:\/\/127\.0\.0\.1:.*\/api\/pty\/agents\/v2-host-1\/sessions\/sess-v2\/attach\/[A-Za-z0-9_-]+$/);
    expect(sessions.sessions[0].attach_url).not.toContain('agent-v2-host-1');

    const screen = await (await cf('/api/instances/v2-host-1/sessions/sess-v2/screen')).json();
    expect(screen).toMatchObject({ instance_id: 'v2-host-1', session_id: 'sess-v2', seq: 3 });
    expect(screen.text).toContain('Need input?');
    expect(screen.source).toContain('/api/v1/agents/agent-v2-host-1/sessions/sess-v2/screen');
  });

  it('creates sessions through the formal agentic-sandbox v1 session API', async () => {
    const created = await (await cf('/api/instances/v2-host-1/sessions', { method: 'POST' })).json();
    expect(created).toMatchObject({
      id: 'sess-created-v1',
      requested: { session_backend: 'tmux', session_class: 'managed', command: 'bash', working_dir: '/work' },
    });
    // Deterministic prefix + per-request nonce (multi-session per instance).
    expect(created.requested.session_name).toMatch(/^cockpit-v2-host-1-managed-tmux-[0-9a-f]{6}$/);
    expect(created.attach_url).toMatch(/^ws:\/\/127\.0\.0\.1:.*\/api\/pty\/agents\/v2-host-1\/sessions\/sess-created-v1\/attach\/[A-Za-z0-9_-]+$/);
  });

  it('starts non-root container sessions in the executor-reported target cwd', async () => {
    const created = await (await cf('/api/instances/v2-container-1/sessions', { method: 'POST' })).json();
    expect(created).toMatchObject({
      id: 'sess-created-container-v1',
      requested: {
        session_backend: 'tmux',
        session_class: 'managed',
        command: '/bin/bash',
        working_dir: '/srv/container-home',
      },
    });
    expect(created.requested.args).toEqual([
      '-lc',
      "cd '/srv/container-home' && exec /bin/bash -l",
    ]);
  });

  it('caches agent-list resolution across session polls (#1747)', async () => {
    let agentListCalls = 0;
    const cacheUpstream = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/health') return send(200, { status: 'ok' });
      if (url.pathname === '/api/v1/agents') {
        agentListCalls += 1;
        return send(200, { agents: [{ id: 'cache-agent', instance_id: 'cache-inst', status: 'Ready' }] });
      }
      if (url.pathname === '/agents/cache-inst/sessions') return send(404, { error: 'instance_id_is_not_session_agent_id' });
      if (url.pathname === '/agents/cache-inst/v1/sessions') return send(404, { error: 'instance_id_is_not_session_agent_id' });
      if (url.pathname === '/api/v1/agents/cache-inst/sessions') return send(404, { error: 'instance_id_is_not_session_agent_id' });
      if (url.pathname === '/api/v1/agents/cache-agent/sessions') {
        return send(200, { sessions: [{ id: 'cached-sess', instance_id: 'cache-inst', pty_ws_url: 'wss://{host}/agents/cache-inst/sessions/cached-sess/attach' }] });
      }
      return send(404, { error: 'not_found', path: url.pathname });
    });
    let cacheBridge;
    try {
      await new Promise((r) => cacheUpstream.listen(0, '127.0.0.1', r));
      cacheBridge = createBridge({ executorUrl: `http://127.0.0.1:${cacheUpstream.address().port}` });
      await new Promise((r) => cacheBridge.listen(0, '127.0.0.1', r));
      const cacheBase = `http://127.0.0.1:${cacheBridge.address().port}`;
      const cacheFetch = (p) => fetch(cacheBase + p, { headers: { authorization: `Bearer ${cacheBridge.cockpitToken}` } });

      expect((await (await cacheFetch('/api/sessions?instance=cache-inst')).json()).sessions[0]).toMatchObject({ id: 'cached-sess' });
      expect((await (await cacheFetch('/api/sessions?instance=cache-inst')).json()).sessions[0]).toMatchObject({ id: 'cached-sess' });
      expect(agentListCalls).toBe(1);
    } finally {
      cacheBridge?.close();
      cacheUpstream.close();
    }
  });

  it('falls back to v2 lifecycle routes for start, stop, and destroy', async () => {
    expect(await (await cf('/api/instances/v2-host-1/start', { method: 'POST' })).json()).toMatchObject({ status: 'running' });
    expect(await (await cf('/api/instances/v2-host-1/stop', { method: 'POST' })).json()).toMatchObject({ status: 'stopped' });
    expect(await (await cf('/api/instances/v2-host-1', { method: 'DELETE' })).json()).toMatchObject({ destroyed: 'v2-host-1' });
  });

  it('treats destroy 404 for an inventory-visible stale instance as already gone', async () => {
    const res = await cf('/api/instances/ghost-vm-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      destroyed: 'ghost-vm-1',
      already_gone: true,
      result: { state: 'destroyed' },
    });
  });
});

describe('cockpit Bridge — executor without running/approvals admin surface (#1638)', () => {
  // The real agentic-sandbox v2 admin router exposes instances/lifecycle but no
  // /running and no /approvals route. The Bridge derives running/approvals from
  // A2A tasks; when no task surface is available it returns empty 200s so Home
  // binds inventory and stays usable.
  let upstream, b, ubase, utoken;
  let fleetMode = 'missing';
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/v2/admin/instances') {
        return send(200, { data: { instances: [{
          instanceId: 'host-only-1', runtime: { kind: 'host' }, loadout: 'host-tools',
          status: 'running', tenantId: 'default', launchContext: { selectedTier: 'host' },
        }] } });
      }
      if (url.pathname === '/api/v1/agents') return send(200, { agents: [] });
      if (url.pathname === '/api/v2/fleet/workloads' && fleetMode === 'error') {
        return send(500, { error: 'fleet_unavailable' });
      }
      if (url.pathname === '/api/v2/fleet/workloads' && fleetMode === 'malformed') {
        return send(200, { document_type: 'inventory', api_version: 'wrong/v1', records: [] });
      }
      // No task surface on this executor — everything else 404s.
      return send(404, { error: 'not_found', path: url.pathname });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    b = createBridge({ executorUrl: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => b.listen(0, '127.0.0.1', r));
    ubase = `http://127.0.0.1:${b.address().port}`;
    utoken = b.cockpitToken;
  });
  afterAll(() => { b?.close(); upstream?.close(); });

  const uf = (p) => fetch(ubase + p, { headers: { authorization: `Bearer ${utoken}` } });

  it('binds inventory while deriving empty running + approvals from absent task surfaces', async () => {
    const inv = await uf('/api/inventory');
    expect(inv.status).toBe(200);
    expect((await inv.json()).count).toBe(1);

    const running = await uf('/api/running');
    expect(running.status).toBe(200);
    expect(await running.json()).toMatchObject({ count: 0, running: [] });

    const approvals = await uf('/api/approvals?status=pending');
    expect(approvals.status).toBe(200);
    expect(await approvals.json()).toMatchObject({ approvals: [] });
  });

  it('keeps older no-fleet executors compatible but fails closed on fleet faults', async () => {
    fleetMode = 'missing';
    expect((await uf('/api/missions')).status).toBe(200);

    fleetMode = 'error';
    const failed = await uf('/api/missions');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'bridge_upstream_error' });

    fleetMode = 'malformed';
    const malformed = await uf('/api/missions');
    expect(malformed.status).toBe(502);
    expect((await malformed.json()).message).toBe('Bridge request failed.');
    fleetMode = 'missing';
  });
});

describe('cockpit mock — admin-surface contract guard (#1636)', () => {
  // The mock is automated-test-only (the Bridge refuses it without
  // AIWG_COCKPIT_ALLOW_MOCK_EXECUTOR=1 — see "mock executor guard" above). It
  // implements the legacy /admin/* surface. The real agentic-sandbox exposes
  // /api/v2/admin/* and has NO running/approvals/cost admin routes — those three
  // legacy routes are the KNOWN, tracked divergence the Bridge consumes for
  // automated coverage until real-surface derivation lands (#1639). This guard
  // pins the divergence so a NEW invented mock admin route fails CI instead of
  // silently widening the mock↔real gap.
  const KNOWN_LEGACY_DIVERGENCE = ['/admin/running', '/admin/approvals', '/admin/cost'];
  // Admin capabilities that must NOT exist on the mock — neither the real v2
  // surface nor the documented legacy-compat set includes these. Adding any one
  // to the mock is new divergence and must be a conscious change to this guard.
  const FORBIDDEN_INVENTED = ['/admin/missions', '/admin/quota', '/admin/sessions', '/admin/events', '/api/v2/admin/running', '/api/v2/admin/approvals'];
  let m, mbase;
  beforeAll(async () => {
    m = createExecutor();
    await new Promise((r) => m.listen(0, '127.0.0.1', r));
    mbase = `http://127.0.0.1:${m.address().port}`;
  });
  afterAll(() => { m?.close(); });
  const g = (p) => fetch(mbase + p);

  it('serves exactly the known legacy-divergent admin routes', async () => {
    for (const p of KNOWN_LEGACY_DIVERGENCE) {
      expect((await g(p)).status, `${p} should be served by the mock`).toBe(200);
    }
  });

  it('does not invent admin routes beyond the documented divergence', async () => {
    for (const p of FORBIDDEN_INVENTED) {
      expect((await g(p)).status, `${p} must NOT exist on the mock (new mock↔real divergence)`).toBe(404);
    }
  });

  it('serves the real A2A agent surface the Bridge derives from (v2-aligned)', async () => {
    const inst = '550e8400-e29b-41d4-a716-446655440000';
    expect((await g(`/agents/${inst}/sessions`)).status).toBe(200);
    expect((await g(`/agents/${inst}/v1/tasks`)).status).toBe(200);
    expect((await g(`/agents/${inst}/.well-known/agent-card.json`)).status).toBe(200);
  });
});

describe('cockpit Bridge — port defaults off the executor range (#1634)', () => {
  it('recognizes an npm-style symlink as direct binary execution', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'aiwg-cockpit-bin-'));
    const targetUrl = new URL('../../apps/cockpit/bridge/src/server.mjs', import.meta.url);
    const link = join(temp, 'aiwg-cockpit');
    try {
      await symlink(fileURLToPath(targetUrl), link);
      expect(isDirectExecution(targetUrl.href, link)).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('continues without crashing when an optional executor binary is not installed', async () => {
    await expect(ensureExecutor('http://127.0.0.1:1', {
      command: ['/definitely/not/an/installed/agentic-mgmt'],
      probe: async () => false,
    })).resolves.toBeUndefined();
  });

  it('defaults to an off-range port and never into the agentic-sandbox 8120-8122 range', () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(8140);
    expect(EXECUTOR_RESERVED_PORTS).toEqual([8120, 8121, 8122]);
    expect(resolveBridgePort({})).toBe(DEFAULT_BRIDGE_PORT);
    expect(EXECUTOR_RESERVED_PORTS).not.toContain(resolveBridgePort({}));
  });

  it('honours an explicit PORT', () => {
    expect(resolveBridgePort({ PORT: '8155' })).toBe(8155);
    expect(resolveBridgePort({ AIWG_COCKPIT_BRIDGE_PORT: '8160' })).toBe(8160);
  });

  it('refuses to start on a reserved executor port instead of silently squatting', () => {
    for (const p of EXECUTOR_RESERVED_PORTS) {
      expect(() => resolveBridgePort({ PORT: String(p) })).toThrow(/collides with the agentic-sandbox/);
    }
  });

  it('rejects an invalid PORT', () => {
    expect(() => resolveBridgePort({ PORT: 'nope' })).toThrow(/Invalid Bridge port/);
    expect(() => resolveBridgePort({ PORT: '70000' })).toThrow(/Invalid Bridge port/);
  });
});

describe('cockpit Bridge — OS-keychain strict runtime token mode (#1595)', () => {
  it('refuses to launch with a plaintext runtime token when strict mode cannot store to keychain', async () => {
    const home = join(process.cwd(), '.aiwg', 'tmp-cockpit-strict-test');
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    const bridgePath = fileURLToPath(new URL('../../apps/cockpit/bridge/src/server.mjs', import.meta.url));
    const port = 23000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [bridgePath], {
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        AIWG_COCKPIT_EXECUTOR_URL: 'http://127.0.0.1:1',
        AIWG_COCKPIT_AUTOSTART_EXECUTOR: '0',
        AIWG_COCKPIT_KEYCHAIN_STRICT: '1',
        AIWG_COCKPIT_KEYCHAIN_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve('timeout');
      }, 5000);
      child.once('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    await rm(home, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(stderr).toMatch(/failed to persist runtime token/i);
    expect(stderr).toMatch(/keychain/i);
  });
});

describe('cockpit web — app shell served', () => {
  let html;
  beforeAll(async () => { html = await (await fetch(base + '/')).text(); });

  it('declares a document language', () => expect(html).toMatch(/<html lang="en"/));
  it('renders the Cockpit title', () => expect(html).toMatch(/AIWG.?Cockpit/i));
  it('does not inject reusable credential material', () => {
    expect(html).not.toContain(token);
    expect(html).not.toContain('__COCKPIT_TOKEN__');
  });
  it('references + serves the built bundle outside comments when a React build is present', async () => {
    // strip comments first: a module script trapped in a comment must not count.
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    if (/assets\//.test(html)) {
      const m = live.match(/<script[^>]+type="module"[^>]+src="([^"]*assets\/[^"]+\.js)"/);
      expect(m, 'module bundle must be referenced outside comments').toBeTruthy();
      expect((await fetch(base + m[1].replace(/^\.\//, '/'))).status).toBe(200);
    }
    // a11y of the *rendered* UI is asserted by the React-render tests in T6 (jsdom).
  });
});
