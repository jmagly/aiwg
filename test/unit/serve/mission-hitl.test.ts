// Regression #2310: missionId to A2A task/prompt response correlation.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ExecutorRegistry } from '../../../src/serve/executor-registry.js';
import { respondToA2AMission } from '../../../src/serve/mission-hitl.js';
import { A2A_HITL_PROMPT_V1, DEFAULT_REQUIRED_EXTENSIONS } from '../../../src/a2a/client.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTask, decodeTask } from '../../../src/a2a/codecs.js';

const testState = mkdtempSync(join(tmpdir(), 'aiwg-mission-hitl-'));
beforeAll(() => vi.stubEnv('AIWG_EXECUTOR_IDENTITY_STORE', join(testState, 'identities.json')));
afterAll(() => { vi.unstubAllEnvs(); rmSync(testState, { recursive: true, force: true }); });

const promptId = 'ad0eac57-f070-4464-855a-46b60455704b';
const otherId = 'f2724988-cfa5-4f75-9799-bac165ef92b9';
function setup() {
  const registry = new ExecutorRegistry();
  const registration = registry.register({ executor_id: 'ad0eac57-f070-4464-855a-46b60455704a', name: 'fixture', version: '1.0.0', spec_version: '1.0.0',
    transport_endpoints: { rest: 'http://fixture.test', ws: 'ws://fixture.test' }, capabilities: ['hitl'] });
  expect(registration).not.toHaveProperty('error');
  const mission = registry.assignMission('mission', 'ad0eac57-f070-4464-855a-46b60455704a');
  mission.a2a = { instanceId: 'instance', taskId: 'task', contextId: 'context', protocolVersion: '0.3', acceptedPrompts: new Set() };
  const prompt: Record<string, unknown> = { prompt_id: promptId, prompt: 'Approve?',
    response_schema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'], additionalProperties: false } };
  const task = { id: 'task', contextId: 'context', status: { state: 'input-required', message: {
    messageId: 'prompt-message', role: 'agent', parts: [{ kind: 'text', text: 'Approve?' }], metadata: { [A2A_HITL_PROMPT_V1]: prompt },
  } } };
  const sent: any[] = [];
  let fail = false;
  const fetcher = async (input: any, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const extensions = new Headers(init.headers).get('a2a-extensions')?.split(',').map(value => value.trim()) ?? [];
      if (![...DEFAULT_REQUIRED_EXTENSIONS, A2A_HITL_PROMPT_V1].every(extension => extensions.includes(extension))) {
        return new Response(JSON.stringify({ code: 'extension.required_not_activated' }), { status: 400 });
      }
      sent.push({ url: String(input), body: JSON.parse(String(init.body)), extensions });
      if (fail) throw new Error('fixture network failure');
    }
    return new Response(JSON.stringify(task), { headers: { 'content-type': 'application/json' } });
  };
  return { registry, mission, prompt, task, sent, fetcher, setFail: (value: boolean) => { fail = value; } };
}

describe('mission A2A approval routing', () => {
  it('binds the reply to the owning instance/task/context and rejects duplicates without another send', async () => {
    const s = setup();
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: false }, { fetch: s.fetcher })).status).toBe(200);
    expect(s.sent[0].extensions).toEqual(expect.arrayContaining([...DEFAULT_REQUIRED_EXTENSIONS, A2A_HITL_PROMPT_V1]));
    expect(s.sent[0].url).toBe('http://fixture.test/agents/instance/v1/messages:send');
    expect(s.sent[0].body.message).toMatchObject({ taskId: 'task', contextId: 'context', metadata: { hitl_response_for: { prompt_id: promptId, payload: { approve: false } } } });
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: s.fetcher })).status).toBe(409);
    expect(s.sent).toHaveLength(1);
    expect(JSON.stringify(s.mission.recentEvents)).not.toContain('"approve"');
  });

  it.each([
    ['wrong prompt', (s: ReturnType<typeof setup>) => { s.prompt.prompt_id = otherId; }, 409],
    ['wrong task', (s: ReturnType<typeof setup>) => { s.task.id = 'foreign'; }, 409],
    ['wrong context', (s: ReturnType<typeof setup>) => { s.task.contextId = 'foreign'; }, 409],
    ['stale task', (s: ReturnType<typeof setup>) => { s.task.status.state = 'completed'; }, 409],
    ['expired', (s: ReturnType<typeof setup>) => { s.prompt.deadline = '2000-01-01T00:00:00Z'; }, 410],
    ['restricted', (s: ReturnType<typeof setup>) => { s.prompt.allowed_responders = ['specific:owner']; }, 403],
    ['unknown schema', (s: ReturnType<typeof setup>) => { s.prompt.response_schema = { type: 'object', mystery: true }; }, 422],
    ['async schema', (s: ReturnType<typeof setup>) => { s.prompt.response_schema = { type: 'object', $async: true }; }, 422],
    ['invalid payload', (s: ReturnType<typeof setup>) => { s.prompt.response_schema = { type: 'object', required: ['missing'], properties: { missing: { type: 'boolean' } } }; }, 422],
  ])('rejects %s before sending', async (_label, change, status) => {
    const s = setup(); change(s);
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: s.fetcher })).status).toBe(status);
    expect(s.sent).toHaveLength(0);
  });


  it('uses the task-specific negotiated 1.0 interface and wire format', async () => {
    const s = setup();
    s.mission.a2a!.protocolVersion = '1.0';
    s.mission.a2a!.selectedInterface = { url: 'http://negotiated.test/a2a', protocolVersion: '1.0', protocolBinding: 'REST', preference: 0 };
    const requests: any[] = [];
    const fetcher = async (input: any, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const task = encodeTask('1.0', decodeTask('0.3', s.task));
      return new Response(JSON.stringify(init?.method === 'POST' ? { task } : task), { headers: { 'content-type': 'application/a2a+json' } });
    };
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: fetcher })).status).toBe(200);
    expect(requests.map(request => request.url)).toEqual(['http://negotiated.test/a2a/tasks/task', 'http://negotiated.test/a2a/message:send']);
    expect(JSON.parse(requests[1].init.body).message.parts[0]).toEqual({ data: { approve: true } });
  });

  it('does not answer a mission aborted while its prompt was being fetched', async () => {
    const s = setup();
    const fetcher = async (...args: Parameters<typeof s.fetcher>) => {
      s.registry.transitionMission('mission', 'aborted');
      return s.fetcher(...args);
    };
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: fetcher })).status).toBe(409);
    expect(s.sent).toHaveLength(0);
  });

  it('retries a failed send with the same message ID and rejects a changed retry payload', async () => {
    const s = setup(); s.setFail(true);
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: s.fetcher })).status).toBe(502);
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: false }, { fetch: s.fetcher })).status).toBe(409);
    s.setFail(false);
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: s.fetcher })).status).toBe(200);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[0].body).toEqual(s.sent[1].body);
  });

  it('serializes an overlapping reply while another mission can answer independently', async () => {
    const s = setup();
    const other = s.registry.assignMission('other', 'ad0eac57-f070-4464-855a-46b60455704a');
    other.a2a = { ...s.mission.a2a!, taskId: 'other-task', contextId: 'other-context', acceptedPrompts: new Set() };
    const otherFetcher = async (...args: Parameters<typeof s.fetcher>) => {
      const response = await s.fetcher(...args);
      const task = await response.json();
      return new Response(JSON.stringify({ ...task, id: 'other-task', contextId: 'other-context' }), { headers: { 'content-type': 'application/json' } });
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: async (...args) => { await gate; return s.fetcher(...args); } });
    expect((await respondToA2AMission(s.registry, 'mission', promptId, { approve: true }, { fetch: s.fetcher })).status).toBe(409);
    expect((await respondToA2AMission(s.registry, 'other', promptId, { approve: false }, { fetch: otherFetcher })).status).toBe(200);
    release(); expect((await pending).status).toBe(200);
  });
});
