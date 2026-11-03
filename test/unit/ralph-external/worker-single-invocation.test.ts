// Exercise one attached invocation and its strict final/capture contracts.
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishWorkerRecord } from '../../../tools/ralph-external/session-launcher.mjs';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { workerStdinDocument } from '../../../src/serve/worker-stdin-frame.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { FactoryDirectAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { PiDirectAdapter } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { GrokBuildAdapter } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { waitForCondition, advanceUntilSettled } from '../../helpers/worker-lifecycle.mjs';
import { reapedWorkerSpawn, waitForEmptyWorkerGroup } from '../../helpers/reaped-worker-spawn.mjs';

const roots: string[] = [];
const breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = (options: any = {}) => workerInvocationFixture(options, { roots, breakers });

describe('T-OG-15/20 one attached invocation without managed state', () => {
  it('projects semantic health from the adapter while consuming strict finals separately', async () => {
    const f = await fixture({ semanticHealth: true });
    const adapter = new CodexAdapter();
    (f.drivers.codex as any).createHealthObserver = (options: any) => adapter.createHealthObserver(options);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    (f.drivers.codex as any).extractFinal = () => claims;
    const events = [
      { type: 'thread.started', thread_id: 'synthetic-thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'synthetic-step', type: 'agent_message', text: 'synthetic' } }, { type: 'turn.completed' },
    ].map(item => JSON.stringify(item)).join('\n') + '\n';
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const launched = vi.fn(); const started = vi.fn(); f.launcher.on('launched', launched); f.launcher.on('started', started);
    const result = await f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, JSON.stringify(claims));
        child.stdout.end(events); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-health' };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result.health).toMatchObject({ handshake: 'semantic', state: 'completed', termination: 'confirmed', lastProgressAt: expect.any(String) });
    expect(result.healthEvidence.events.map((item: any) => item.kind)).toContain('progress');
    expect(launched).toHaveBeenCalledOnce(); expect(started).toHaveBeenCalledOnce();
    expect(started.mock.calls[0]).toEqual(launched.mock.calls[0]);
    expect(JSON.parse(await readFile(path.join(f.runDir, 'health.json'), 'utf8')).origin).toBe('observer');
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).health.state).toBe('completed');
  });

  // #2915 review 5 (finding 6, disabled-dispatch equivalence): a REGRESSION
  // introduced by the review-4 round -- `healthFinalValid` started reading
  // the strict final's own `status` field unconditionally, so a
  // schema-valid but `status: 'failed'` claim now changed baseline health
  // from `completed` to `failed-to-start`/`FINAL_INVALID` even with
  // recovery completely disabled (`scopedBreaker: null`). origin/main's
  // own behavior (a successful strict PARSE alone, regardless of the
  // claim's own `.status`, is sufficient for `finalValid`) must be
  // preserved byte-for-byte whenever recovery is not gated.
  it('with recovery disabled, a schema-valid but status:failed claim still reports baseline completed health, never failed-to-start/FINAL_INVALID (#2915 review 5 finding 6)', async () => {
    const f = await fixture();
    // A strict parser that DOES validate (no throw -- a schema-valid
    // claim) but whose own claimed `status` is 'failed'. Under review 4's
    // gated logic this would read `healthFinalValid = false`; disabled
    // dispatch must never apply that stricter check.
    (f.drivers.codex as any).parseWorkerFinal = async () => ({ status: 'failed', summary: 'worker claims failure despite a clean exit' });
    const claims = { version: 1, status: 'failed', summary: 'synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
    (f.drivers.codex as any).extractFinal = () => claims;
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483645;
    const result = await f.launch({
      // Explicit, unambiguous disabled-dispatch: no recovery breaker at all.
      scopedBreaker: null,
      launchIsolated: () => {
        queueMicrotask(() => {
          writeFileSync(f.final, JSON.stringify(claims));
          child.stdout.end('{}\n'); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
        });
        return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-disabled-health' };
      }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }),
    });
    expect(result.attemptOutcome).toBeUndefined(); // disabled dispatch: no new field at all
    expect(result.health.state).toBe('completed');
    expect(result.health.state).not.toBe('failed-to-start');
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).health.state).toBe('completed');
  });

  it('legacy extraction cannot erase duplicate final keys and authorize completed health', async () => {
    const f = await fixture({ stdoutOnly: true });
    const adapter = new CodexAdapter();
    (f.drivers.codex as any).parseWorkerFinal = (bytes: any, options: any) => adapter.parseWorkerFinal(bytes, options);
    const forged = '{"type":"result","result":{"version":1,"status":"failed","status":"completed","summary":"synthetic","claims":[],"artifacts":[],"checks":[],"limitations":[]}}\n';
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {}; child.pid = 2147483646;
    const result = await f.launch({ launchIsolated: () => {
      queueMicrotask(() => { child.stdout.end(forged); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-duplicate' };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result.exitCode).toBe(0);
    expect(result.health.state).not.toBe('completed');
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(forged);
  });

  // #2995: Factory (droid) keeps its final answer inside its own
  // `stream-json` stdout stream and writes no separate final-output file
  // (finalStat.size === 0, the realistic case for this profile). This
  // drives the SAME production hook (worker-installation.mjs ~l.733,
  // session-launcher.mjs ~l.459-480) through the real `FactoryDirectAdapter`
  // (round 2: `parseOutput` on this `-direct` subclass IS the strict
  // `parseDirectFinal` rule, not the legacy regex `FactoryAdapter` keeps —
  // the legacy regex fails closed on a realistic multi-event stream before
  // `parseWorkerFinal` is ever reached, which is why this stream below is a
  // REALISTIC multi-event one: assistant/tool_call/tool_result lines before
  // the terminal `result` line), with no hand-fed finalValid.
  function factoryStream(resultText: string) {
    return [
      { type: 'assistant', session_id: 'synthetic-session', text: 'synthetic reply' },
      { type: 'tool_call', session_id: 'synthetic-session', id: 'fixture-call-1', name: 'Read' },
      { type: 'tool_result', session_id: 'synthetic-session', tool_call_id: 'fixture-call-1' },
      { type: 'result', session_id: 'synthetic-session', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: resultText },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchFactoryStream(f: any, stream: string, unit: string) {
    const adapter = new FactoryDirectAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, ''); // no separate final file: finalStat.size === 0
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Factory stream reaches completed health through the real -direct adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchFactoryStream(f, factoryStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-factory');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).health.state).toBe('completed');
  });

  it('the same realistic Factory stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchFactoryStream(f, factoryStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-factory-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it('a realistic multi-event Factory stream with no terminal result (failed run) never reaches completed health', async () => {
    const f = await fixture();
    const stream = [
      { type: 'assistant', session_id: 'synthetic-session', text: 'synthetic reply' },
      { type: 'tool_call', session_id: 'synthetic-session', id: 'fixture-call-1', name: 'Read' },
      { type: 'error', session_id: 'synthetic-session', message: 'synthetic failure' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
    const result = await launchFactoryStream(f, stream, 'aiwg-worker-synthetic-factory-failed');
    expect(result.exitCode, JSON.stringify(result)).toBe(0); // exit zero is exactly the trap this guards against
    expect(result.health.state).not.toBe('completed');
  });

  // #2995 round 2: the same proof for Pi, whose legacy `parseOutput` is
  // settlement-only (no answer requirement) and whose `-direct` subclass
  // (`PiDirectAdapter`) requires a settled, non-empty answer instead.
  function piStream(resultText: string | null) {
    const events: unknown[] = [{ type: 'session', id: 'synthetic-session' }, { type: 'agent_start' }];
    if (resultText !== null) {
      events.push({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: resultText }] }] });
    } else {
      events.push({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'error' }] });
    }
    events.push({ type: 'agent_settled' });
    return events.map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchPiStream(f: any, stream: string, unit: string) {
    const adapter = new PiDirectAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, '');
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Pi stream reaches completed health through the real -direct adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchPiStream(f, piStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-pi');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
  });

  // #3489: exit/close notification can be observed before the final pipe
  // bytes are delivered as stream 'data' events (same class as #3488, which
  // waited for IPC drain as well as exit). This holds every byte back in a
  // paused userland buffer while the process-level events are observed, so
  // the terminal stream is delivered strictly AFTER exit+close are seen.
  // Health must still reach `completed`. On the old code finish() destroyed
  // the source streams before the buffered bytes were ever delivered, so
  // extraction saw a partial stream and an exit-0 run classified `failed`.
  // Nothing here resumes the stream by hand: only the launcher's own drain
  // may release it, which is why this fails deterministically on old code
  // instead of racing like the in-isolation flake.
  it('a Pi stream delivered after exit is observed still reaches completed health (#3489)', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const adapter = new PiDirectAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const result = await f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, '');
        child.stdout.pause();
        child.stdout.end(piStream(JSON.stringify(claims)));
        child.stderr.end();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-pi-late-drain' };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
  });

  it('the same realistic Pi stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchPiStream(f, piStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-pi-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it('a realistic multi-event Pi stream that fails to settle never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchPiStream(f, piStream(null), 'aiwg-worker-synthetic-pi-failed');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  // #2995 round 3: Grok Build's parseOutput was already the strict
  // ACP-derived direct rule (`parseDirectFinal`); this proves the newly
  // added `parseWorkerFinal` override is what lets a realistic multi-event
  // ACP stream (tool_call/tool_call_update/text, then the terminal `end`)
  // reach `completed`, through the real adapter and no hand-fed finalValid.
  function grokStream(resultText: string | null) {
    const events: unknown[] = [
      { type: 'tool_call', toolCallId: 'call_1', title: 'Read', kind: 'read', status: 'in_progress' },
      { type: 'tool_call_update', toolCallId: 'call_1', status: 'completed' },
    ];
    if (resultText !== null) events.push({ type: 'text', data: resultText });
    events.push({ type: 'end', stopReason: 'end_turn', sessionId: 'synthetic-session' });
    return events.map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  async function launchGrokStream(f: any, stream: string, unit: string) {
    const adapter = new GrokBuildAdapter();
    (f.drivers.codex as any).extractFinal = (text: string) => adapter.parseOutput(text);
    (f.drivers.codex as any).parseWorkerFinal = (output: any, options: any) => adapter.parseWorkerFinal(output, options);
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    return f.launch({ launchIsolated: () => {
      queueMicrotask(() => {
        writeFileSync(f.final, '');
        child.stdout.end(stream); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
  }

  it('a realistic multi-event Grok Build stream reaches completed health through the real adapter hook, with no hand-fed finalValid', async () => {
    const f = await fixture();
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const result = await launchGrokStream(f, grokStream(JSON.stringify(claims)), 'aiwg-worker-synthetic-grok');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health).toMatchObject({ state: 'completed', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8')))
      .toMatchObject({ source: 'adapter-extraction', terminalSuccess: true });
  });

  it('the same realistic Grok Build stream with a plain-text (non-claims) final never reaches completed health', async () => {
    const f = await fixture();
    const result = await launchGrokStream(f, grokStream('synthetic plain reply, not a claims document'), 'aiwg-worker-synthetic-grok-plain');
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.health.state).not.toBe('completed');
  });

  it.each(['closed', 'brief-text', 'brief-json'])('preserves exact argv, %s EOF, private metadata and captures', async stdin => {
    const f = await fixture({ stdin, waitForIdentity: true });
    const result = await f.launch();
    expect(result).toMatchObject({ exitCode: 0, signal: null, workerTermination: 'confirmed',
      termination: 'confirmed', descendants: 'none', captureCoverage: 'complete', isolation: 'degraded' });
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(record.argv).toEqual(f.plan.invocation!.argv!.slice(2));
    expect(record.cwd).toBe(f.cwd);
    // brief-json delivers the conductor-framed params document, never the raw brief (#2911).
    expect(record.stdin).toBe(stdin === 'closed' ? '' : stdin === 'brief-json'
      ? workerStdinDocument({ brief: f.prompt, model: f.plan.invocation!.selected.model, cwd: f.cwd }) : f.prompt);
    expect(record.envNames).toContain('AIWG_SYNTHETIC_ALLOWED');
    expect(record.envNames).not.toContain('AIWG_UNRELATED_SECRET');
    expect(record.argv).not.toContain('--dangerously-skip-permissions');
    expect((await lstat(f.runDir)).mode & 0o777).toBe(0o700);
    for (const filename of await readdir(f.runDir)) expect((await lstat(path.join(f.runDir, filename))).mode & 0o777).toBe(0o600);
    const metadata = await readFile(path.join(f.runDir, 'invocation.json'), 'utf8');
    expect(metadata).not.toContain(f.prompt);
    expect(metadata).not.toContain('secret-environment-value');
    expect(metadata).not.toContain('unrelated-value');
    const invocation = JSON.parse(metadata);
    expect(invocation.envNames).toEqual([...new Set([...f.plan.invocation!.envNames, 'AIWG_WORKER_INVOCATION_ID', 'AIWG_WORKER_WORKSPACE', 'AIWG_WORKER_GROUP'])]);
    expect(invocation.prompt.path).toBe(f.brief);
    expect(invocation.invocationDigest).toBe(qualificationDigest(f.plan.invocation));
    expect(invocation.planDigest).toBe(qualificationDigest(f.plan));
    const processRecord = JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8'));
    expect(processRecord.supervisor.pid).toBe(process.pid);
    expect(processRecord.worker.pid).not.toBe(process.pid);
    expect(processRecord.worker.pgid).toBe(processRecord.worker.pid);
    expect(processRecord.worker).toMatchObject({ uid: process.getuid!(), bootId: expect.any(String), startTicks: expect.any(String), parentPid: processRecord.nativeSupervisor.pid });
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(await readFile(f.plan.invocation!.stdoutPath!, 'utf8'));
    expect(JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8'))).toMatchObject({ invocationId: result.invocationId, candidate: true, verified: false });
    expect(await readdir(f.root)).not.toContain('.aiwg');
    await expect(lstat(path.join(f.root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
    // #2915 step 4: path-pair retry inference is deleted (retry is now
    // `options.retryOf`-declared only), so a same-launcher, same-runDir
    // call with no `retryOf` is unrelated work — never gated by
    // stop-before-retry. It reaches `launchOneWorker`'s own independent
    // fresh/empty runDir precondition directly, restoring this assertion to
    // its pre-#2915 (origin/main) form.
    await expect(f.launch()).rejects.toThrow(/fresh|empty/);
  });

  it('extracts stdout-only final separately while retaining the original event stream', async () => {
    const f = await fixture({ stdoutOnly: true });
    const result = await f.launch();
    expect(result.exitCode, await readFile(f.plan.invocation!.stderrPath!, 'utf8')).toBe(0);
    expect(result.errorCode).toBeNull();
    const final = JSON.parse(await readFile(f.final, 'utf8'));
    expect(final).toMatchObject({ invocationId: result.invocationId, source: 'adapter-extraction', verified: false });
    const stdout = await readFile(f.plan.invocation!.stdoutPath!, 'utf8');
    expect(JSON.parse(stdout).type).toBe('result');
    expect(stdout).not.toContain('adapter-extraction');
  });

  it('preserves a synthetic event stream and separates a digest-associated final candidate', async () => {
    const f = await fixture({ stdoutOnly: true });
    const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
    const events = `${JSON.stringify({ type: 'result', result: claims })}\n`;
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    const result = await f.launch({ launchIsolated: (options: any) => {
      queueMicrotask(() => {
        writeFileSync(path.join(f.runDir, 'worker-exit.json'), JSON.stringify({ invocationId: options.name, exitCode: 0, signal: null }), { mode: 0o600 });
        child.stdout.end(events); child.stderr.end('synthetic diagnostic\n'); child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic' };
    }, isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) });
    expect(result).toMatchObject({ exitCode: 0, termination: 'confirmed', descendants: 'none', errorCode: null, captureCoverage: 'complete' });
    expect(await readFile(f.plan.invocation!.stdoutPath!, 'utf8')).toBe(events);
    expect(await readFile(path.join(f.runDir, 'stdout.events.jsonl'), 'utf8')).toBe(events);
    expect(await readFile(path.join(f.runDir, 'stderr.log'), 'utf8')).toBe('synthetic diagnostic\n');
    expect(JSON.parse(await readFile(f.final, 'utf8'))).toMatchObject({ invocationId: result.invocationId, result: claims });
  });

  it.each(['missing-final', 'truncated-final', 'double-final', 'exit-zero-error'])('retains wait exit but rejects %s final evidence', async scenario => {
    const f = await fixture({ scenario, waitForIdentity: true });
    const result = await f.launch();
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    expect(result.termination).toBe('confirmed');
    const exit = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    expect(exit.errorCode).toBe('FINAL_OUTPUT_INVALID');
  });

  it('times out a worker after stdin EOF, records signal instead of a fake zero and clears timers', async () => {
    const f = await fixture({ scenario: 'hang', hardTimeoutSeconds: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const kill = vi.spyOn(process, 'kill');
    const observations: any[] = [];
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    let workerPid: number;
    const done = f.launch({ launchIsolated: (options: any) => {
      const outcome = reapedWorkerSpawn(options); workerPid = outcome.child.pid!; return outcome;
    }, publishRecord: async (runDir: string, name: string, value: any, inspect: any) => {
      await publishWorkerRecord(runDir, name, value, inspect);
      if (name === 'process.json') observations.push(value);
    } });
    await launched;
    // Prove the fixture consumed stdin EOF before advancing the deadline.
    // Freeze the execution clock while the real fixture starts under load.
    await waitForCondition(async () => { try { await lstat(f.recordPath); return true; } catch { return false; } });
    await vi.advanceTimersByTimeAsync(100);
    await waitForCondition(() => observations.some(value => value.ownership === 'owned-group'));
    // TERM can win before KILL is delivered; either signal needs a reaping barrier.
    const result = await advanceUntilSettled(done, { advance: vi.advanceTimersByTimeAsync,
      afterStep: async () => {
        if (kill.mock.calls.some(([pid, signal]) => pid === -workerPid && ['SIGTERM', 'SIGKILL'].includes(signal as string))) {
          await waitForEmptyWorkerGroup(workerPid);
        }
      } });
    expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true, exitCode: null, termination: 'confirmed' });
    expect(['SIGTERM', 'SIGKILL']).toContain(result.signal);
    const signals = kill.mock.calls.filter(call => call[1] !== 0);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(call => call[0] < 0 && call[0] !== -process.pid)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill.mock.calls.filter(call => call[1] !== 0)).toEqual(signals);
    expect(f.launcher.getPid()).toBeNull();
  });

  it('records ENOENT with unknown code and no child identity', async () => {
    const f = await fixture();
    const result = await f.launch({ launchIsolated: () => ({ mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }) });
    expect(result).toMatchObject({ exitCode: null, signal: null, errorCode: 'ENOENT', termination: 'confirmed' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')).worker).toBeNull();
  });

  it('BLOCKER regression (#2895): a worker-forged worker-exit.json cannot report a real failure as success', async () => {
    // The worker and the trusted transport share a UID with no filesystem
    // boundary between them. This worker reads invocation.json (already on
    // disk, same UID, readable) to learn the real invocationId, plants its
    // own worker-exit.json claiming exitCode:0, then really exits non-zero.
    const f = await fixture({ scenario: 'forge-exit', forgeRealExitCode: 7 });
    const result = await f.launch();
    // The forged record is readable back (same mechanism as before the fix)
    // but must only ever surface as an unauthenticated, informational hint.
    expect(result.workerReportedExit).toMatchObject({ exitCode: 0, signal: null, errorCode: null });
    // The forged claim of a clean exit must never become the reported
    // exitCode: 0 is exactly the value an attacker wants read back as
    // success, so it must never appear here.
    expect(result.exitCode).not.toBe(0);
    expect(typeof result.exitCode).toBe('number');
    // index.mjs's CLI mapping must likewise never fold this into exit 0.
    const cliExitCode = result.errorCode || result.timedOut ? 1
      : result.termination === 'confirmed' ? (result.exitCode === 0 ? 0 : 1)
      : 2;
    expect(cliExitCode).not.toBe(0);
  });

  it('MAJOR regression (#2895): a failing intermediate publish does not block the final exit.json', async () => {
    const f = await fixture();
    let processJsonAttempts = 0;
    const names: string[] = [];
    // The first process.json write happens before spawn and must still hard-
    // fail the launch if it fails (unchanged, covered elsewhere). The SECOND
    // one happens post-spawn, from observeIdentity()'s own recordProcess()
    // poll — a transient failure there is exactly the "intermediate publish"
    // case: under the pre-fix chaining, this single rejection would poison
    // the shared `publishing` chain and silently stop every later write,
    // including the final exit.json, from ever being attempted.
    const result = await f.launch({ publishRecord: async (runDir: string, name: string, value: unknown, inspect: any) => {
      names.push(name);
      if (name === 'process.json') {
        processJsonAttempts += 1;
        if (processJsonAttempts === 2) throw new Error('synthetic intermediate publish failure');
      }
      return publishWorkerRecord(runDir, name, value, inspect);
    } });
    expect(processJsonAttempts).toBeGreaterThanOrEqual(2);
    const exitRaw = await readFile(path.join(f.runDir, 'exit.json'), 'utf8');
    const exit = JSON.parse(exitRaw);
    expect(exit.invocationId).toBe(result.invocationId);
    expect(names).toContain('exit.json');
  });
});
