/** Bounded execution observations, separate from worker claims and final parsing. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const MAX_EVENTS = 64;
const MAX_KEYS = 512;
// Bounded replay horizon beyond the short dedup FIFO. Only exact replay of
// evicted identities counts as churn; fresh identities reset the streak.
export const PROGRESS_CHURN_LIMITS = Object.freeze({ historyKeys: 4096, repeatedEvictedKeys: 32 });
const DEFAULTS = { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300,
  diagnosticGraceSeconds: 60, terminateGraceSeconds: 5, hardTimeoutSeconds: 1800, maxSteps: 100, stepEnforcement: 'unavailable' };
const reasons = new Set(['OK', 'AWAITING_HANDSHAKE', 'PROCESS_ONLY', 'ACCEPTED', 'PROGRESS', 'QUIET', 'NO_PROGRESS',
  'STARTUP_DEADLINE', 'HARD_DEADLINE', 'STEP_LIMIT', 'AUTH', 'RATE_LIMIT', 'NETWORK', 'MODEL', 'TRUST', 'STDIN_WAIT',
  'SANDBOX', 'NOT_FOUND', 'RESOURCE', 'PROVIDER_ERROR', 'CRASH', 'EXIT_ERROR', 'FINAL_INVALID', 'CANCELLED',
  'DISCONNECTED', 'OBSERVER_GAP', 'CAPTURE_WRITE', 'OUTPUT_LIMIT', 'MALFORMED_FRAME', 'SOURCE_GAP', 'IDENTITY_CHANGED']);
const reason = value => reasons.has(value) ? value : 'PROVIDER_ERROR';
const field = (event, key) => key.split('.').reduce((node, part) => node?.[part], event);

/** Missing vendor identities stay unavailable; an observed mismatch never crosses runs. */
export function healthEventMatchesBinding(event, binding, fields = ['invocationId', 'requestId', 'sessionId', 'runId']) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const keys = { session_id: 'sessionId', thread_id: 'sessionId', sessionID: 'sessionId', id: 'sessionId',
    'stream.id': 'sessionId', 'payload.run_id': 'runId', run_id: 'runId', request_id: 'requestId' };
  return fields.every(key => {
    const actual = field(event, key);
    const expected = binding[keys[key] ?? key];
    if (actual !== undefined && expected != null && actual !== expected) {
      binding.onIdentityConflict?.();
      return false;
    }
    return true;
  });
}

/** Heuristic diagnoses are never terminal proof; arbitrary stdout prose is ignored. */
export function classifyWorkerHealthFailure(value, { source = {}, provider = '' } = {}) {
  const typed = value && typeof value === 'object' && !Array.isArray(value);
  if (source.kind !== 'stderr' && !typed) return null;
  const text = (typed ? JSON.stringify(value) : String(value)).slice(0, 8192);
  let code = null;
  if (/\b(?:ENOENT|EACCES)\b|command not found|no such executable/i.test(text)) code = 'NOT_FOUND';
  else if (/\b(?:EPERM|EROFS)\b|read-only file system|operation not permitted/i.test(text)) code = 'SANDBOX';
  else if (/\b429\b|rate.limit|quota.exceeded/i.test(text)) code = 'RATE_LIMIT';
  else if (/\b(?:401|403)\b|authentication (?:failed|expired)|unauthorized|invalid api key|login required/i.test(text)) code = 'AUTH';
  else if (/model[_ -](?:not[_ -]found|unavailable)|unknown model|invalid (?:model|effort)/i.test(text)) code = 'MODEL';
  else if (/Reading additional input from stdin|waiting for stdin|stdin.wait/i.test(text)) code = 'STDIN_WAIT';
  else if (/trust (?:this )?(?:workspace|directory)|approval required|workspace (?:is )?untrusted/i.test(text)) code = 'TRUST';
  else if (/\b(?:ENOSPC|ENOMEM|OOM)\b|out of memory|disk full/i.test(text)) code = 'RESOURCE';
  else if (/\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b|TLS (?:error|failed)|\b50[234]\b/i.test(text)) code = 'NETWORK';
  else if (typed) code = 'PROVIDER_ERROR';
  if (!code) return null;
  const retry = /retry.after["\s:=]+(\d+(?:\.\d+)?)/i.exec(text);
  return { kind: 'error', reasonCode: code, provider,
    ...(retry ? { retryAfterSeconds: Math.min(86400, Number(retry[1])) } : {}) };
}

export function observeProviderHealthEvent(provider, event, source, binding) {
  if (!healthEventMatchesBinding(event, binding)) return null;
  if (provider === 'hermes') {
    // Only an explicitly located, session-filtered log is qualified. Plain -z
    // stdout/usage and agent.log growth cannot establish semantic progress.
    if (source.kind !== 'session-log' || !binding.sessionId || event.session_id !== binding.sessionId) return null;
    if (event.marker === 'turn_started') return { kind: 'accepted' };
    if (event.marker === 'tool_completed' && typeof event.tool_call_id === 'string') return { kind: 'progress', key: event.tool_call_id };
    if (event.marker === 'turn_completed') return { kind: 'terminal', success: true };
  } else if (provider === 'antigravity') {
    if (event.event === 'init') return { kind: 'setup', sessionId: event.session_id };
    if (event.event === 'step_update' && event.step_update?.state === 'DONE' && Number.isSafeInteger(event.step_update.step_index)) return { kind: 'progress', key: `step:${event.step_update.step_index}` };
    if (event.event === 'result') return { kind: 'terminal', success: event.result?.status === 'SUCCESS' };
    if (event.event === 'error') return classifyWorkerHealthFailure(event, { source, provider });
  } else if (provider === 'grok-build') {
    // streaming-json is ACP NDJSON, not the Messages API stream. Missing
    // identities stay unknown; a generic tool id is not a session binding.
    if (source?.kind !== 'stdout') return null;
    if (event.type === 'error') return { ...classifyWorkerHealthFailure({ type: 'error', message: event.message }, { source, provider }), fatal: true };
    if (event.type === 'tool_call' || event.type === 'tool_call_update') {
      if (event.status === 'failed') return { ...classifyWorkerHealthFailure({ type: 'error', message: `tool call ${event.toolCallId ?? 'unknown'} failed` }, { source, provider }), fatal: true };
      return typeof event.toolCallId === 'string' && event.toolCallId
        ? { kind: 'progress', key: event.toolCallId } : { kind: 'activity' };
    }
    if (['text', 'thought', 'usage', 'plan', 'available_commands'].includes(event.type)) return { kind: 'activity' };
    if (event.type === 'end') return { kind: 'terminal', success: event.stopReason === 'end_turn', key: event.stopReason ?? 'end' };
  } else if (provider === 'local-http' || provider === 'ollama') {
    if (typeof event.response === 'string' && event.done !== true) return { kind: 'activity' };
    if (event.done === true) return { kind: 'terminal', success: !event.error };
    if (event.error) return { ...classifyWorkerHealthFailure(event, { source, provider }), fatal: true };
  } else if (provider === 'copilot') {
    // CONSERVATIVE GUARD ONLY (roctinam/aiwg#2901 round 1): Copilot's own
    // JSONL event vocabulary is not documented in --help (see
    // copilot-adapter.mjs module doc) and is never invented here. This
    // branch defends only against the synthetic "error-shaped JSON at exit
    // 0" shape — `type: "error"` or a top-level non-null `error` field — so
    // it can never be mistaken for a completed/OK final. Mirrors
    // copilot-adapter.mjs's parseOutput guard.
    if (event.type === 'error' || (event.error !== undefined && event.error !== null)) {
      return { ...classifyWorkerHealthFailure(event, { source, provider }), fatal: true };
    }
  }
  return null;
}

/** Parser/locator strings are identifiers only. No dynamic import/eval from profiles. */
export function createWorkerHealthObserver(options = {}) {
  const profile = options.profile?.health ?? options.health ?? {};
  const windows = { ...DEFAULTS, ...options.effectiveHealth };
  const now = options.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
  const wallNow = options.wallNow ?? Date.now;
  const started = options.startedAt ?? now();
  const epoch = options.launchTime === undefined ? wallNow() : Date.parse(options.launchTime);
  const utc = value => value === null ? null : new Date(epoch + value - started).toISOString();
  const hardDeadline = started + windows.hardTimeoutSeconds * 1000;
  const startupDeadline = started + windows.startupSeconds * 1000;
  const binding = { invocationId: options.invocationId ?? 'unbound', requestId: options.requestId ?? options.invocationId,
    sessionId: options.sessionId ?? null, runId: options.runId ?? null };
  const normalize = options.normalizeEvent ?? ((event, source) => observeProviderHealthEvent(options.provider, event, source, binding));
  const buffers = new Map();
  const keys = new Set();
  const progressHistory = new Set();
  const replayedKeys = new Set();
  const events = [];
  const gaps = [];
  let sequence = 0, generation = 0, steps = null, total = 0, lastCheck = started, maxGap = 0;
  let observed = null, activity = null, progress = null, heartbeat = null, handshakeAt = null, stalledAt = null;
  let state = 'launching', handshake = 'unobserved', confidence = 'unobserved', reasonCode = 'AWAITING_HANDSHAKE';
  let termination = 'running', transitionCount = 0, live = null, disconnected = false, finalized = false;
  let terminal = null, fatalFailure = false, cpuTimeMs = null, contentDigest = options.contentDigest ?? null;
  const unavailable = new Set(profile.handshake === 'semantic' ? [] : ['semantic-start']);
  if (!profile.progressEvidence?.length) unavailable.add('semantic-progress');
  unavailable.add('steps');
  const transition = (next, code, certainty = 'observed') => {
    if (state !== next) { transitionCount = Math.min(1000000, transitionCount + 1); state = next; }
    reasonCode = reason(code); confidence = certainty;
  };
  const sourceOf = source => ({ kind: source?.kind ?? 'stdout', id: source?.id ?? source?.kind ?? 'stdout',
    generation: source?.generation ?? 0, offset: source?.offset ?? 0 });
  const gap = (code = 'OBSERVER_GAP', source = {}) => {
    generation++;
    gaps.push({ sequence: ++sequence, reasonCode: reason(code), source: digest(sourceOf(source).id) });
    if (gaps.length > 32) gaps.shift();
    unavailable.add('observer-continuity');
  };
  const observe = (event, suppliedSource = {}) => {
    if (finalized || !event || typeof event !== 'object') return;
    const source = sourceOf(suppliedSource);
    if (suppliedSource.invocationId != null && suppliedSource.invocationId !== binding.invocationId) return;
    if (!['setup', 'accepted', 'progress', 'activity', 'terminal', 'error', 'heartbeat'].includes(event.kind)) return;
    if (['setup', 'accepted'].includes(event.kind)) {
      // Stdout identities provide intra-run correlation only, never authority
      // over a process or filesystem. The first binding wins, atomically;
      // conflicting later setup is an anomaly and cannot rebind either field.
      if (['sessionId', 'runId'].some(key => event[key] != null && binding[key] != null && binding[key] !== event[key])) {
        gap('IDENTITY_CHANGED', source);
        return;
      }
      for (const key of ['sessionId', 'runId']) {
        if (event[key] != null && source.kind === 'stdout' && binding[key] == null) binding[key] = event[key];
      }
    }
    const time = now();
    observed = time;
    if (time >= hardDeadline) { reasonCode = 'HARD_DEADLINE'; return; }
    if (fatalFailure && event.kind !== 'error' && event.kind !== 'heartbeat') return;
    const rawKey = event.key ?? event.identity;
    const keyDigest = typeof rawKey === 'string' && rawKey.length <= 4096 ? digest(rawKey) : null;
    if (event.kind === 'progress') {
      if (!keyDigest) return;
      const qualified = handshakeAt !== null && (profile.progressEvidence?.length || source.kind === 'worktree');
      if (qualified) activity = time;
      if (source.kind !== 'worktree' && qualified) {
        if (unavailable.has('progress-key-churn')) return;
        const replay = progressHistory.has(keyDigest);
        if (!replay) replayedKeys.clear();
        else if (!keys.has(keyDigest)) replayedKeys.add(keyDigest);
        // Refresh history on replay so a cycling set within this explicit
        // horizon cannot become novel by evicting its oldest identities.
        progressHistory.delete(keyDigest);
        if (progressHistory.size >= PROGRESS_CHURN_LIMITS.historyKeys) progressHistory.delete(progressHistory.values().next().value);
        progressHistory.add(keyDigest);
        if (replayedKeys.size >= PROGRESS_CHURN_LIMITS.repeatedEvictedKeys) {
          unavailable.add('semantic-progress');
          unavailable.add('progress-key-churn');
        }
        if (replay) {
          if (!keys.has(keyDigest)) {
            if (keys.size >= MAX_KEYS) keys.delete(keys.values().next().value);
            keys.add(keyDigest);
          }
          return;
        }
      }
      if (keys.has(keyDigest)) return;
      // Bound dedup memory without dropping new progress after saturation.
      // Set insertion order makes this a FIFO window of recent identities.
      if (keys.size >= MAX_KEYS) keys.delete(keys.values().next().value);
      keys.add(keyDigest);
    }
    events.push({ sequence: ++sequence, kind: event.kind, source: digest(source.id), generation: source.generation,
      offset: source.offset, keyDigest });
    if (events.length > MAX_EVENTS) events.shift();
    if (event.kind === 'heartbeat') heartbeat = time;
    else if (event.kind === 'accepted') {
      if (handshakeAt === null && profile.handshake === 'semantic') {
        if (time >= startupDeadline) transition('failed-to-start', 'STARTUP_DEADLINE', 'suspected');
        else { handshakeAt = time; handshake = 'semantic'; live = true; transition('started', 'ACCEPTED'); }
      }
    } else if (event.kind === 'progress') {
      // Completed steps do not retroactively invent accepted-start evidence.
      if (handshakeAt !== null && (profile.progressEvidence?.length || source.kind === 'worktree')) {
        progress = time; activity = time;
        // Tool/item completion establishes progress, not a model-turn count.
        if (event.step === true && windows.stepEnforcement !== 'unavailable') { steps = (steps ?? 0) + 1; unavailable.delete('steps'); }
        stalledAt = null; transition('active', 'PROGRESS');
      }
    } else if (event.kind === 'activity') activity = time;
    else if (event.kind === 'error') {
      if (event.fatal === true) fatalFailure = true;
      terminal = event.fatal === true ? false : terminal;
      reasonCode = reason(event.reasonCode);
      if (handshakeAt === null) transition('failed-to-start', reasonCode, 'suspected');
    } else if (event.kind === 'terminal') {
      if (event.success !== true) fatalFailure = true;
      terminal = event.success === true && !fatalFailure;
      if (event.success !== true) reasonCode = reason(event.reasonCode);
    }
  };
  // Adapter binding filters report conflicts even when they reject a raw
  // setup frame before normalization reaches observe(). No raw ID is exported.
  binding.onIdentityConflict = () => gap('IDENTITY_CHANGED');
  // Read-only status resumes qualified clocks, never replays output as fresh
  // progress. The caller validates the invocation, boot and timestamp bounds.
  if (options.initialSnapshot) {
    const initial = options.initialSnapshot;
    const clock = value => value == null ? null : started + Date.parse(value) - epoch;
    observed = clock(initial.lastObservedAt); activity = clock(initial.lastActivityAt);
    progress = clock(initial.lastProgressAt); handshakeAt = clock(initial.handshakeAt);
    stalledAt = clock(initial.stalledAt);
    handshake = initial.handshake ?? 'unobserved';
    state = initial.state ?? 'launching'; reasonCode = reason(initial.reasonCode);
    generation = initial.observerGeneration ?? 0; transitionCount = initial.transitionCount ?? 0;
    maxGap = initial.maxCheckGapSeconds ?? 0;
    for (const signal of initial.unavailableSignals ?? []) unavailable.add(signal);
    if (observed !== null) lastCheck = observed;
  }
  const feed = (bytes, suppliedSource = {}) => {
    if (finalized) return;
    const source = sourceOf(suppliedSource);
    if (suppliedSource.offset === undefined) source.offset = buffers.get(source.id)?.nextOffset ?? 0;
    const input = Buffer.from(bytes);
    total += input.length;
    const maxBytes = Math.min(options.maxOutputBytes ?? 10485760, 10485760);
    if (total > maxBytes) { gap('OUTPUT_LIMIT', source); return; }
    if (source.kind !== 'session-log') { activity = now(); observed = activity; }
    const previous = buffers.get(source.id);
    if (previous && (previous.generation !== source.generation || source.offset < previous.nextOffset)) {
      gap('SOURCE_GAP', source); buffers.delete(source.id);
    }
    if (!buffers.has(source.id) && buffers.size >= 8) { gap('SOURCE_GAP', source); return; }
    let cursor = buffers.get(source.id);
    if (!cursor) { cursor = { bytes: Buffer.alloc(0), generation: source.generation, nextOffset: source.offset, discarding: false }; buffers.set(source.id, cursor); }
    if (source.offset > cursor.nextOffset) { gap('SOURCE_GAP', source); cursor.bytes = Buffer.alloc(0); }
    cursor.nextOffset = source.offset + input.length;
    // stderr diagnostics are line framed regardless of stdout framing.
    const framing = profile.outputFraming ?? 'opaque';
    if (source.kind !== 'stderr' && source.kind !== 'session-log' && !['jsonl', 'http-stream'].includes(framing)) return;
    const maxFrame = Math.min(options.maxFrameBytes ?? 65536, 1048576);
    for (let start = 0; start < input.length;) {
      const newline = input.indexOf(10, start);
      const end = newline < 0 ? input.length : newline;
      const piece = input.subarray(start, end);
      if (!cursor.discarding && cursor.bytes.length + piece.length > maxFrame) {
        cursor.bytes = Buffer.alloc(0); cursor.discarding = true; gap('OUTPUT_LIMIT', source);
      }
      if (!cursor.discarding) cursor.bytes = Buffer.concat([cursor.bytes, piece]);
      if (newline >= 0) {
        if (!cursor.discarding && cursor.bytes.length) {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(cursor.bytes);
            if (source.kind === 'stderr') observe(classifyWorkerHealthFailure(text, { source, provider: options.provider }), source);
            else {
              const event = JSON.parse(text);
              const normalized = normalize(event, source, binding);
              for (const item of Array.isArray(normalized) ? normalized : [normalized]) observe(item, { ...source, offset: source.offset + newline });
            }
          } catch { gap('MALFORMED_FRAME', source); }
        }
        cursor.bytes = Buffer.alloc(0); cursor.discarding = false;
      }
      start = end + 1;
    }
  };
  const check = (time = now()) => {
    if (time < lastCheck) { gap('OBSERVER_GAP'); time = lastCheck; }
    const elapsed = time - lastCheck;
    maxGap = Math.max(maxGap, elapsed / 1000);
    if (elapsed > windows.checkSeconds * 1000) gap('OBSERVER_GAP');
    lastCheck = time; observed = time;
    if (finalized) return snapshot();
    if (time >= hardDeadline) { reasonCode = 'HARD_DEADLINE'; return snapshot(); }
    if (fatalFailure) return snapshot();
    if (handshakeAt === null) {
      if (time >= startupDeadline) transition('failed-to-start', reasonCode === 'AWAITING_HANDSHAKE' ? 'STARTUP_DEADLINE' : reasonCode, 'suspected');
    } else {
      const noProgress = time - (progress ?? handshakeAt);
      if (noProgress >= windows.stallSeconds * 1000) {
        stalledAt ??= (progress ?? handshakeAt) + windows.stallSeconds * 1000;
        if (time - stalledAt >= windows.diagnosticGraceSeconds * 1000 && live === true && !disconnected) transition('hung', 'NO_PROGRESS');
        else transition('stalled', disconnected ? 'DISCONNECTED' : 'NO_PROGRESS', unavailable.has('semantic-progress') || disconnected ? 'suspected' : 'observed');
      } else if (time - (activity ?? handshakeAt) >= windows.quietSeconds * 1000) transition('quiet', 'QUIET', 'suspected');
      else if (progress !== null) transition('active', 'PROGRESS');
    }
    if (windows.stepEnforcement !== 'unavailable' && steps !== null && steps >= windows.maxSteps) reasonCode = 'STEP_LIMIT';
    return snapshot();
  };
  const snapshot = () => ({ version: 1, state,
    coverage: profile.coverage === 'unobserved' ? 'unobserved' : profile.coverage === 'full' && !gaps.length && !unavailable.has('progress-key-churn') ? 'full' : 'degraded',
    handshake, lastObservedAt: utc(observed), lastActivityAt: utc(activity), lastProgressAt: utc(progress), reasonCode,
    termination, transitionCount, restartCount: 0, unavailableSignals: [...unavailable].slice(0, 32), transitionRefs: [],
    observerGeneration: generation, startupDeadlineAt: utc(startupDeadline), hardDeadlineAt: utc(hardDeadline),
    maxCheckGapSeconds: maxGap, confidence, handshakeAt: utc(handshakeAt), stalledAt: utc(stalledAt) });
  return {
    feed, observe, gap, check, snapshot,
    shouldStop() { return fatalFailure; },
    processStarted(identity) {
      if (options.transport === 'mcp') return; // shared server process is not this request
      if (!identity || !Number.isSafeInteger(identity.pid) || !identity.startTicks || !identity.executable) return;
      live = true; observed = now();
      if (profile.handshake === 'process-only' && handshakeAt === null) {
        if (now() >= startupDeadline) transition('failed-to-start', 'STARTUP_DEADLINE', 'suspected');
        else { handshakeAt = now(); handshake = 'process-only'; transition('started', 'PROCESS_ONLY'); }
      }
    },
    sampleActivity({ running = null, cpu = null, content = null } = {}) {
      if (finalized) return;
      observed = now(); live = running;
      if (options.transport !== 'mcp' && cpu !== null && Number.isFinite(cpu) && cpu >= 0) {
        if (cpuTimeMs !== null && cpu > cpuTimeMs) activity = now();
        cpuTimeMs = cpu;
      } else unavailable.add('cpu');
      if (content !== null) {
        if (contentDigest !== null && contentDigest !== content) observe({ kind: 'progress', key: `content:${sequence}:${content}` }, { kind: 'worktree', id: 'owned-worktree' });
        contentDigest = content;
      } else unavailable.add('worktree-content');
    },
    disconnect() { disconnected = true; live = null; termination = 'uncertain'; gap('DISCONNECTED'); reasonCode = 'DISCONNECTED'; },
    finish(result = {}) {
      if (finalized) return snapshot();
      for (const [id, cursor] of buffers) if (cursor.bytes.length || cursor.discarding) gap('MALFORMED_FRAME', { id });
      finalized = true; observed = now(); termination = result.termination ?? 'uncertain';
      if (termination !== 'confirmed' || disconnected) {
        termination = 'uncertain';
        if (result.signal || result.exitCode != null && result.exitCode !== 0) transition(handshakeAt === null ? 'failed-to-start' : 'crashed', 'CRASH');
      } else if (result.cancelled || result.timedOut || now() >= hardDeadline) transition(result.cancelled ? 'cancelled' : 'failed', result.cancelled ? 'CANCELLED' : reason(result.stopReason ?? 'HARD_DEADLINE'));
      else if (state === 'failed-to-start') transition('failed', reasonCode);
      else if (fatalFailure) transition('failed', reasonCode);
      else if (!result.errorCode && result.finalValid && result.exitCode === 0 && terminal !== false) transition('completed', 'OK');
      else if (!result.errorCode && result.finalValid && options.transport === 'mcp' && result.exitCode === null && terminal === true) transition('completed', 'OK');
      else transition(handshakeAt === null ? 'failed-to-start' : 'failed', result.errorCode ? reason(result.errorCode) : result.exitCode !== 0 ? 'EXIT_ERROR' : 'FINAL_INVALID');
      return snapshot();
    },
    nextDelayMs() {
      const time = now();
      const pending = [time + windows.checkSeconds * 1000, hardDeadline];
      if (handshakeAt === null && state !== 'failed-to-start') pending.push(startupDeadline);
      if (handshakeAt !== null) {
        const quiet = (activity ?? handshakeAt) + windows.quietSeconds * 1000;
        const stall = (progress ?? handshakeAt) + windows.stallSeconds * 1000;
        if (quiet > time) pending.push(quiet);
        if (stall > time) pending.push(stall);
        if (stalledAt !== null && stalledAt + windows.diagnosticGraceSeconds * 1000 > time) pending.push(stalledAt + windows.diagnosticGraceSeconds * 1000);
      }
      return Math.max(1, Math.min(...pending) - time);
    },
    evidence() { return { invocationId: binding.invocationId, sequence, observerGeneration: generation,
      lastWorkerHeartbeatAt: utc(heartbeat), cpuTimeMs, steps: windows.stepEnforcement === 'unavailable' ? null : steps,
      gaps: gaps.map(item => ({ ...item })), events: events.map(item => ({ ...item })) }; },
  };
}

/** Same-file edits matter. Export only a digest of bounded, owned content. */
export async function sampleOwnedWorktreeContent(root, { files, maxFiles = 128, maxBytes = 1048576 } = {}) {
  let candidates = files;
  try {
    if (!candidates) {
      const status = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { timeout: 1000, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '0' }, killSignal: 'SIGKILL' });
      candidates = [];
      const records = status.split('\0');
      for (let i = 0; i < records.length; i++) {
        if (!records[i]) continue;
        if (records[i][0] === 'R' || records[i][1] === 'R' || records[i][0] === 'C') return null;
        candidates.push(records[i].slice(3));
      }
    }
    if (!Array.isArray(candidates) || candidates.length > maxFiles) return null;
    const hash = createHash('sha256');
    let total = 0;
    for (const name of [...new Set(candidates)].sort()) {
      if (typeof name !== 'string' || path.isAbsolute(name) || name.split('/').some(part => part === '..' || !part)
        || name.includes('\0')) return null;
      if (name.split('/').some(part => ['.git', 'node_modules', '.cache', '__pycache__', '.aiwg'].includes(part)) || /\.(?:log|jsonl)$/.test(name)) continue;
      if (!path.isAbsolute(root) || root.includes('\0') || root.split('/').includes('..')) return null;
      let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let handle;
      try {
        for (const component of root.split('/').filter(Boolean)) {
          const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await directory.close(); directory = next;
        }
        const parts = name.split('/');
        const leaf = parts.pop();
        for (const component of parts) {
          const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await directory.close(); directory = next;
        }
        handle = await open(`/proc/self/fd/${directory.fd}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size + total > maxBytes) return null;
        const buffer = Buffer.alloc(maxBytes - total + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        total += length;
        if (total > maxBytes) return null;
        hash.update(name); hash.update('\0'); hash.update(bytes); hash.update('\0');
      } catch (error) { if (error.code !== 'ENOENT') return null; hash.update(name); hash.update(':deleted\0'); }
      finally { await handle?.close(); await directory.close(); }
    }
    return `sha256:${hash.digest('hex')}`;
  } catch { return null; }
}
