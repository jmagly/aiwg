// Share the seven behavioral assertions between workerd and the manual deployed check.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { prepareCloudflare } from './flue-cloudflare.mjs';
import type { launchHttp } from '../fixtures/mcp/http-service.mjs';

type Part = { type: string; toolName?: string; state?: string; text?: string; output?: unknown };
type Snapshot = { conversationId: string; messages: { id: string; role: string; parts: Part[] }[];
  settlements: { submissionId: string; outcome: string; error?: unknown }[] };
export type CloudflareContext = {
  app: Awaited<ReturnType<typeof prepareCloudflare>>;
  service: Awaited<ReturnType<typeof launchHttp>>;
  origin: string; artifact: string; buildLog: string; buildMs: number;
  restart: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  failureDetails: (snapshot: Snapshot) => string | Promise<string>;
  record?: (name: string, status: string, durationMs: number, error?: unknown) => void;
  redact?: (value: string) => string;
};
export function registerCloudflareCases(state: CloudflareContext) {
  const lifecycleTimeout = 300_000;
  let review: Snapshot, receipt: { submissionId: string; uid: string };
  function test(name: string, body: () => unknown, timeout?: number) {
    state.record?.(name, 'pending', 0);
    it(name, async () => {
      const started = performance.now();
      try {
        await body();
        state.record?.(name, 'pass', Math.round(performance.now() - started));
      } catch (error) {
        state.record?.(name, 'fail', Math.round(performance.now() - started), error);
        if (state.redact) throw new Error(state.redact(String(error)));
        throw error;
      }
    }, timeout);
  }
  const request = (id: string, suffix = '', init?: RequestInit) => fetch(`${state.origin}/agents/assistant/${id}${suffix}`, {
    ...init, signal: AbortSignal.timeout(15_000),
  });
  async function send(id: string, body: string) {
    const response = await request(id, '', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'user', body }) });
    expect(response.status, await response.clone().text()).toBe(202);
    return response.json();
  }
  async function history(id: string): Promise<Snapshot> {
    const response = await request(id);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  async function settled(id: string, submissionId: string, outcome: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const snapshot = await history(id);
      const settlement = snapshot.settlements.find(item => item.submissionId === submissionId);
      if (settlement) {
        expect(settlement.outcome, JSON.stringify(snapshot) + '\n' + state.app.logs()).toBe(outcome);
        return snapshot;
      }
      await delay(100);
    }
    throw new Error(`Submission ${submissionId} did not settle:\n${JSON.stringify(await history(id))}\n${state.app.logs()}`);
  }
  const parts = (snapshot: Snapshot) => snapshot.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts);

  test('builds the Cloudflare example without database or stdio modules', () => {
    expect(state.buildLog).toContain('built in');
    expect(fs.existsSync(path.join(state.app.project, 'dist'))).toBe(true);
    expect(fs.existsSync(path.join(state.app.project, 'src/db.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(state.app.project, 'src/aiwg/tools.ts'), 'utf8')).toContain("from '@aiwg/flue/tools'");
    expect(fs.existsSync(path.join(state.app.project, '.agents/skills'))).toBe(false);
    console.info(`Cloudflare build: ${state.buildMs}ms`);
  });

  test('imports, lists and activates the packaged SDLC skill in the runtime', async () => {
    receipt = await send('review', 'Review the change; remember review-state-3127.');
    review = await settled('review', receipt.submissionId, 'completed');
    const activated = parts(review).find(part => part.toolName === 'activate_skill');
    expect(activated?.state).toBe('output-available');
    expect(JSON.stringify(activated?.output)).toContain('SDLC Framework');
    expect(parts(review).filter(part => part.type === 'text').map(part => part.text).join('')).toBe('PASS Cloudflare review review-state-3127');
  }, lifecycleTimeout);

  test('runs the packaged Code Reviewer specialist with remote capabilities', () => {
    const task = parts(review).find(part => part.toolName === 'task');
    expect(task?.state).toBe('output-available');
    expect(JSON.stringify(task?.output)).toContain('Code Reviewer: use a + b.');
    expect(parts(review).some(part => ['bash', 'read', 'write', 'edit'].includes(part.toolName || ''))).toBe(false);
  });

  test('discovers, shows governing rules and writes only in the D9 bound project', () => {
    const remote = parts(review).filter(part => part.toolName?.startsWith('mcp__aiwg__'));
    expect(remote.map(part => part.toolName)).toEqual(['mcp__aiwg__discover', 'mcp__aiwg__skill-show', 'mcp__aiwg__artifact-write']);
    expect(remote.every(part => part.state === 'output-available')).toBe(true);
    expect(JSON.stringify(remote[0].output)).toContain('sdlc-quickref');
    expect(JSON.stringify(remote[1].output)).toContain('sdlc-orchestration');
    expect(JSON.stringify(remote[2].output)).toContain(state.artifact);
    expect(fs.readFileSync(state.artifact, 'utf8')).toBe('Code Reviewer: use a + b.\n');
    for (const name of ['reviews/cloudflare.md', '.aiwg/reviews/cloudflare.md', '.flue-state']) {
      expect(fs.existsSync(path.join(state.app.project, name)), name).toBe(false);
    }
  });

  test('restarts the runtime and resumes the same Durable Object session with prior state', async () => {
    const prior = await history('review');
    await state.restart();
    expect(await history('review')).toEqual(prior);
    const resumed = await send('review', 'resume-state');
    expect(resumed.uid).toBe(receipt.uid);
    const snapshot = await settled('review', resumed.submissionId, 'completed');
    expect(snapshot.messages.slice(0, prior.messages.length)).toEqual(prior.messages);
    expect(parts(snapshot).filter(part => part.type === 'text').at(-1)?.text).toBe('PASS resumed review-state-3127');
    expect(fs.readFileSync(state.artifact, 'utf8')).toBe('Code Reviewer: use a + b.\n');
  }, lifecycleTimeout);

  test('aborts while a remote tool is running and durably records cancellation', async () => {
    const admission = await send('abort', '__abort__');
    const marker = path.join(state.service.project, 'cli-started');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await delay(50);
    expect(fs.existsSync(marker), state.app.logs()).toBe(true);
    const response = await request('abort', '/abort', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ aborted: true });
    await settled('abort', admission.submissionId, 'aborted');
    const cancelled = path.join(state.service.project, 'cli-cancelled');
    const cancellationDeadline = Date.now() + 5000;
    while (!fs.existsSync(cancelled) && Date.now() < cancellationDeadline) await delay(50);
    expect(fs.existsSync(cancelled), 'D9 must cancel its in-flight CLI child').toBe(true);
    await state.restart();
    expect((await history('abort')).settlements.find(item => item.submissionId === admission.submissionId)?.outcome).toBe('aborted');
  }, lifecycleTimeout);

  test('fails clearly with a wrong token and leaves the artifact untouched', async () => {
    const before = fs.readFileSync(state.artifact);
    await state.setToken('synthetic-wrong-token');
    const admission = await send('wrong-token', 'Review this change.');
    const snapshot = await settled('wrong-token', admission.submissionId, 'failed');
    expect(JSON.stringify(snapshot)).toMatch(/failed/i);
    expect(await state.failureDetails(snapshot)).toMatch(/401|unauthorized/i);
    expect(fs.readFileSync(state.artifact)).toEqual(before);
  }, lifecycleTimeout);
}
