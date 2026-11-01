// Release-slow local workerd qualification of the shipped package-mode example.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';
import { prepareCloudflare } from '../helpers/flue-cloudflare.mjs';

const example = path.resolve(import.meta.dirname, '../../examples/flue-cloudflare');
const dependencyProject = process.env.AIWG_FLUE_CF_DEPENDENCIES || example;
const dependencies = path.resolve(dependencyProject, 'node_modules');
// Allow startup (60s), settlement (90s), HTTP waits and cancellation on hosted runners.
const lifecycleTimeout = 300_000;
type Part = { type: string; toolName?: string; state?: string; text?: string; output?: unknown };
type Snapshot = { conversationId: string; messages: { id: string; role: string; parts: Part[] }[];
  settlements: { submissionId: string; outcome: string; error?: unknown }[] };
let app: Awaited<ReturnType<typeof prepareCloudflare>>;
let service: Awaited<ReturnType<typeof launchHttp>>;
let origin: string, artifact: string, buildLog: string, buildMs: number;
let review: Snapshot, receipt: { submissionId: string; uid: string };
const request = (id: string, suffix = '', init?: RequestInit) => fetch(`${origin}/agents/assistant/${id}${suffix}`, {
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
      expect(settlement.outcome, JSON.stringify(snapshot) + '\n' + app.logs()).toBe(outcome);
      return snapshot;
    }
    await delay(100);
  }
  throw new Error(`Submission ${submissionId} did not settle:\n${JSON.stringify(await history(id))}\n${app.logs()}`);
}
const parts = (snapshot: Snapshot) => snapshot.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts);
function vars(token: string) {
  // Only generated tokens enter the temp project's ignored local binding file.
  fs.writeFileSync(path.join(app.project, '.dev.vars'), [
    `AIWG_MCP_URL=${JSON.stringify(service.url)}`, `AIWG_MCP_TOKEN=${JSON.stringify(token)}`,
    'FLUE_MODEL="aiwg-cf-test/scripted"', `AIWG_EXPECTED_ARTIFACT=${JSON.stringify(artifact)}`, '',
  ].join('\n'), { mode: 0o600 });
}

describe('Flue Cloudflare local emulation', () => {
  beforeAll(async () => {
    expect(fs.existsSync(dependencies), 'Provision with npm ci --prefix examples/flue-cloudflare, or set AIWG_FLUE_CF_DEPENDENCIES to a locked Flue 2.3.0 project').toBe(true);
    for (const [name, version] of Object.entries({ '@flue/cli': '2.3.0', '@flue/runtime': '2.3.0', '@flue/vite': '2.3.0',
      '@cloudflare/vite-plugin': '1.65.0', wrangler: '4.152.0', vite: '8.3.5', hono: '4.13.13', workerd: '1.20261019.1' })) {
      expect(JSON.parse(fs.readFileSync(path.join(dependencies, name, 'package.json'), 'utf8')).version, name).toBe(version);
    }
    app = await prepareCloudflare(dependencyProject);
    service = await launchHttp();
    artifact = path.join(service.project, '.aiwg/reviews/cloudflare.md');
    vars(service.token);
    await app.run(process.execPath, [path.join(import.meta.dirname, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions',
      'src/app.ts', 'src/aiwg/specialists.ts', 'src/aiwg/skills.ts', 'flue.config.ts', 'vite.config.ts'], 60_000);
    const started = performance.now();
    buildLog = await app.run(process.execPath, [path.join(app.project, 'node_modules/vite/bin/vite.js'), 'build'], 60_000);
    buildMs = Math.round(performance.now() - started);
    origin = await app.start();
  }, 600_000);
  afterAll(async () => { await app?.close(); await service?.close(); }, 30_000);

  it('builds the Cloudflare example without database or stdio modules', () => {
    expect(buildLog).toContain('built in');
    expect(fs.existsSync(path.join(app.project, 'dist'))).toBe(true);
    expect(fs.existsSync(path.join(app.project, 'src/db.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(app.project, 'src/aiwg/tools.ts'), 'utf8')).toContain("from '@aiwg/flue/tools'");
    expect(fs.existsSync(path.join(app.project, '.agents/skills'))).toBe(false);
    console.info(`Cloudflare build: ${buildMs}ms`);
  });

  it('imports, lists and activates the packaged SDLC skill in workerd', async () => {
    receipt = await send('review', 'Review the change; remember review-state-3127.');
    review = await settled('review', receipt.submissionId, 'completed');
    const activated = parts(review).find(part => part.toolName === 'activate_skill');
    expect(activated?.state).toBe('output-available');
    expect(JSON.stringify(activated?.output)).toContain('SDLC Framework');
    expect(parts(review).filter(part => part.type === 'text').map(part => part.text).join('')).toBe('PASS Cloudflare review review-state-3127');
  }, lifecycleTimeout);

  it('runs the packaged Code Reviewer specialist with remote capabilities', () => {
    const task = parts(review).find(part => part.toolName === 'task');
    expect(task?.state).toBe('output-available');
    expect(JSON.stringify(task?.output)).toContain('Code Reviewer: use a + b.');
    expect(parts(review).some(part => ['bash', 'read', 'write', 'edit'].includes(part.toolName || ''))).toBe(false);
  });

  it('discovers, shows governing rules and writes only in the D9 bound project', () => {
    const remote = parts(review).filter(part => part.toolName?.startsWith('mcp__aiwg__'));
    expect(remote.map(part => part.toolName)).toEqual(['mcp__aiwg__discover', 'mcp__aiwg__skill-show', 'mcp__aiwg__artifact-write']);
    expect(remote.every(part => part.state === 'output-available')).toBe(true);
    expect(JSON.stringify(remote[0].output)).toContain('sdlc-quickref');
    expect(JSON.stringify(remote[1].output)).toContain('sdlc-orchestration');
    expect(JSON.stringify(remote[2].output)).toContain(artifact);
    expect(fs.readFileSync(artifact, 'utf8')).toBe('Code Reviewer: use a + b.\n');
    for (const name of ['reviews/cloudflare.md', '.aiwg/reviews/cloudflare.md', '.flue-state']) {
      expect(fs.existsSync(path.join(app.project, name)), name).toBe(false);
    }
  });

  it('restarts workerd and resumes the same Durable Object session with prior state', async () => {
    const prior = await history('review');
    await app.stop();
    origin = await app.start();
    expect(await history('review')).toEqual(prior);
    const resumed = await send('review', 'resume-state');
    expect(resumed.uid).toBe(receipt.uid);
    const snapshot = await settled('review', resumed.submissionId, 'completed');
    expect(snapshot.messages.slice(0, prior.messages.length)).toEqual(prior.messages);
    expect(parts(snapshot).filter(part => part.type === 'text').at(-1)?.text).toBe('PASS resumed review-state-3127');
    expect(fs.readFileSync(artifact, 'utf8')).toBe('Code Reviewer: use a + b.\n');
  }, lifecycleTimeout);

  it('aborts while a remote tool is running and durably records cancellation', async () => {
    const admission = await send('abort', '__abort__');
    const marker = path.join(service.project, 'cli-started');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await delay(50);
    expect(fs.existsSync(marker), app.logs()).toBe(true);
    const response = await request('abort', '/abort', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ aborted: true });
    await settled('abort', admission.submissionId, 'aborted');
    const cancelled = path.join(service.project, 'cli-cancelled');
    const cancellationDeadline = Date.now() + 5000;
    while (!fs.existsSync(cancelled) && Date.now() < cancellationDeadline) await delay(50);
    expect(fs.existsSync(cancelled), 'D9 must cancel its in-flight CLI child').toBe(true);
    await app.stop();
    origin = await app.start();
    expect((await history('abort')).settlements.find(item => item.submissionId === admission.submissionId)?.outcome).toBe('aborted');
  }, lifecycleTimeout);

  it('fails clearly with a wrong token and leaves the artifact untouched', async () => {
    const before = fs.readFileSync(artifact);
    await app.stop();
    vars('synthetic-wrong-token');
    origin = await app.start();
    const admission = await send('wrong-token', 'Review this change.');
    const snapshot = await settled('wrong-token', admission.submissionId, 'failed');
    expect(JSON.stringify(snapshot)).toMatch(/failed/i);
    expect(app.logs()).toMatch(/401|unauthorized/i);
    expect(fs.readFileSync(artifact)).toEqual(before);
  }, lifecycleTimeout);
});
