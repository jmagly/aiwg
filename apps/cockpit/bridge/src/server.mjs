#!/usr/bin/env node
// AIWG Cockpit Bridge.
// Reads instance inventory from an agentic-sandbox executor admin surface and
// serves a minimal screen. This is the first end-to-end data path:
//   executor (admin REST) -> Bridge (/api/inventory) -> screen.
// Real Bridge grows: registry/discover/index binding, per-instance A2A, pty I/O,
// per-launch token + OS-keychain (roctinam/aiwg#1595).
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rename, chmod, readdir, cp, rm, stat, appendFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname, resolve, sep, isAbsolute, parse } from 'node:path';
import { storeCockpitToken } from '../../shell-core/keychain.mjs';
import { assertActivityEvent } from './activity-contract.mjs';
import { createDesktopHttpHandler } from './desktop-http.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// Primary seam for roctinam/aiwg#1589: Cockpit talks to a real agentic-sandbox
// executor via this URL. Mock executors are accepted only by explicit automated
// test opt-in, never by default dev/operator launch.
const EXECUTOR_URL =
  process.env.AIWG_COCKPIT_EXECUTOR_URL ??
  process.env.EXECUTOR_URL ??
  'http://127.0.0.1:8122';
const ALLOW_MOCK_EXECUTOR = process.env.AIWG_COCKPIT_ALLOW_MOCK_EXECUTOR === '1';
const AUTOSTART_EXECUTOR = process.env.AIWG_COCKPIT_AUTOSTART_EXECUTOR !== '0';
const EXECUTOR_COMMAND = process.env.AIWG_COCKPIT_EXECUTOR_COMMAND ?? '';
const EXECUTOR_TOKEN_FILE = process.env.AIWG_COCKPIT_EXECUTOR_TOKEN_FILE ?? '';
const MCP_TOKEN_FILE = process.env.AIWG_COCKPIT_MCP_TOKEN_FILE ?? '';
const LOCAL_DOCKER_FALLBACK = process.env.AIWG_COCKPIT_LOCAL_DOCKER_FALLBACK === '1';
const REQUIRE_SANDBOX_MTLS = process.env.AIWG_COCKPIT_REQUIRE_SANDBOX_MTLS === '1';
const COCKPIT_A2A_PROTOCOL_POLICY = process.env.AIWG_COCKPIT_A2A_PROTOCOL_POLICY ?? '0.3';
const COCKPIT_A2A_PROTOCOL_FALLBACK = process.env.AIWG_COCKPIT_A2A_PROTOCOL_FALLBACK === '1';
export function localLibvirtFallbackAllowed(platform = process.platform, envValue = process.env.AIWG_COCKPIT_LOCAL_LIBVIRT_FALLBACK) {
  return platform === 'linux' || envValue === '1';
}
const RUNTIME_DIR = join(homedir(), '.aiwg', 'cockpit', 'runtime');
const auditDir = () => executorRequestContext.getStore()?.auditDir ?? (process.env.AIWG_COCKPIT_AUDIT_DIR || join(homedir(), '.aiwg', 'cockpit', 'audit'));
const auditLog = () => join(auditDir(), 'events.jsonl');
// The built React app (apps/cockpit/web/dist). Served when present; falls back to the
// legacy vanilla page so the Bridge works even before a web build.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json' };
// Discovery indexes more than the four executable provider artifacts. Keep the
// Bridge filter aligned with the complete corpus so Explore does not hide
// extension and documentation surfaces (#1592).
const CAPABILITY_TYPES = new Set([
  'skill', 'agent', 'command', 'rule', 'flow', 'behavior', 'hook', 'template',
  'tool', 'addon', 'framework', 'extension', 'plugin', 'provider', 'document',
]);
const mcSessionsDir = () => join(process.cwd(), '.aiwg', 'ralph-external', 'mc', 'sessions');
const executorRequestContext = new AsyncLocalStorage();
const localDockerFallbackEnabled = () => executorRequestContext.getStore()?.localDockerFallback ?? LOCAL_DOCKER_FALLBACK;
const localLibvirtFallbackEnabled = () => executorRequestContext.getStore()?.localLibvirtFallback ?? localLibvirtFallbackAllowed();

function executorAuthError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

async function resolveExecutorBearer(tokenFile) {
  if (!tokenFile) return '';
  const path = expandHome(String(tokenFile));
  let metadata;
  try {
    metadata = await stat(path);
  } catch (cause) {
    throw executorAuthError('executor_credential_unavailable', 'executor credential file is unavailable', cause);
  }
  if (!metadata.isFile()) {
    throw executorAuthError('executor_credential_invalid', 'executor credential path is not a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw executorAuthError('executor_credential_permissions', 'executor credential file must not be accessible by group or other users');
  }
  const token = String(await readFile(path, 'utf8')).trim();
  if (!token || /[\r\n]/.test(token)) {
    throw executorAuthError('executor_credential_invalid', 'executor credential file must contain exactly one non-empty bearer token');
  }
  return token;
}

function parseExecutorUrl(value) {
  let url;
  try { url = new URL(value); }
  catch (cause) { throw executorAuthError('executor_target_refused', 'executor URL must be absolute HTTP(S)', cause); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw executorAuthError('executor_target_refused', 'executor URL must use HTTP(S) without URL credentials');
  }
  return url;
}

function allowedExecutorTarget(target, executorUrl = executorRequestContext.getStore()?.executorOrigin ?? EXECUTOR_URL) {
  const url = parseExecutorUrl(target);
  // The operator-configured origin is the allowlist, including scheme and port.
  // AgentCards and request data cannot add destinations to it.
  const origin = parseExecutorUrl(executorUrl).origin;
  if (url.origin !== origin) {
    throw executorAuthError('executor_target_refused', 'outbound target is outside the configured executor origin');
  }
  return url;
}

async function executorFetch(target, init = {}, executorUrl = executorRequestContext.getStore()?.executorOrigin ?? EXECUTOR_URL) {
  const url = allowedExecutorTarget(target, executorUrl);
  const context = executorRequestContext.getStore();
  const headers = new Headers(init.headers);
  if (context && url.origin === context.executorOrigin && !headers.has('authorization')) {
    const token = await resolveExecutorBearer(context.executorTokenFile);
    if (token) headers.set('authorization', `Bearer ${token}`);
  }
  // Redirects could leave the allowlist or replay credentials to another target.
  return fetch(url, { ...init, headers, redirect: 'error' });
}

/** Serve a static file from the built web app, sandboxed to WEB_DIST. Returns true if served. */
async function serveDistFile(res, relPath) {
  const safe = join(WEB_DIST, relPath.replace(/^\/+/, ''));
  if (!safe.startsWith(WEB_DIST) || !existsSync(safe)) return false;
  // content-hashed assets are safe to cache forever
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(await readFile(safe));
  return true;
}
// First-party contribution manifests; AIWG-extension-sourced ones layer in via AIWG_COCKPIT_CONTRIB (#1591).
const CONTRIB_DIRS = [fileURLToPath(new URL('../../contrib', import.meta.url)), ...(process.env.AIWG_COCKPIT_CONTRIB ? [process.env.AIWG_COCKPIT_CONTRIB] : [])];

function constantTimeEqual(presented, expected) {
  if (presented.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(presented), Buffer.from(expected)); } catch { return false; }
}

/** Constant-time bearer-token check. URL query credentials are never accepted. */
function bearerAuthed(req, token) {
  const hdr = String(req.headers['authorization'] ?? '');
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  return constantTimeEqual(bearer, token);
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const split = part.indexOf('=');
      if (split < 0) return [part, ''];
      try { return [part.slice(0, split), decodeURIComponent(part.slice(split + 1))]; }
      catch { return [part.slice(0, split), '']; }
    }));
}

function isLocalHostName(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function validBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    const host = new URL(`http://${req.headers.host ?? 'localhost'}`);
    return o.protocol === host.protocol &&
      isLocalHostName(o.hostname) &&
      isLocalHostName(host.hostname) &&
      o.hostname === host.hostname &&
      o.port === host.port;
  } catch {
    return false;
  }
}

/** Desktop local-mode boundary. The listening socket anchors Host/port; client
 * forwarding headers never establish authority. Hosted mode needs its own
 * explicit HTTPS/proxy policy and is not enabled by this local validator. */
export function validDesktopBrowserOrigin(req, { allowSameOriginFetch = false } = {}) {
  try {
    const scheme = req.socket.encrypted ? 'https:' : 'http:';
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string') return false;
    const expected = new URL(`${scheme}//${hostHeader}`);
    const port = Number(expected.port || (scheme === 'https:' ? 443 : 80));
    if (!isLocalHostName(expected.hostname) || expected.host !== hostHeader || port !== req.socket.localPort) return false;
    const origin = req.headers.origin;
    if (origin === undefined) {
      // Browsers omit Origin on some same-origin GETs. Fetch Metadata supplies
      // the browser boundary in that case; WebSocket and mutations require it.
      return allowSameOriginFetch && ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] === 'same-origin';
    }
    return typeof origin === 'string' && origin === expected.origin;
  } catch {
    return false;
  }
}

function validCsrf(req, auth) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) return true;
  if (auth?.kind === 'bearer' && !req.headers.origin) return true;
  const csrf = String(req.headers['x-cockpit-csrf'] ?? '');
  return constantTimeEqual(csrf, auth?.csrf ?? '');
}

/** Persist the per-launch token for the desktop/VS Code shells to read (mode 600). */
async function writeRuntimeToken({ token, port, pid }) {
  await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const file = join(RUNTIME_DIR, 'bridge.json');
  const runtime = { token, port, pid, started_at: new Date().toISOString(), keychain_backed: false };
  const strict = process.env.AIWG_COCKPIT_KEYCHAIN_STRICT === '1';
  try {
    runtime.token_ref = await storeCockpitToken(token, `bridge-${pid}`);
    runtime.keychain_backed = true;
    if (strict) delete runtime.token;
  } catch (e) {
    runtime.keychain_error = String(e?.message ?? e);
    if (strict || process.env.AIWG_COCKPIT_REQUIRE_KEYCHAIN === '1') throw e;
  }
  await writeFile(file, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
// Repo-local aiwg bin: makes the registry binding work in dev + CI without a global install.
const REPO_BIN = fileURLToPath(new URL('../../../../bin/aiwg.mjs', import.meta.url));

// --- registry binding: the data-driven core shells out to the aiwg CLI (#1592) ---
function spawnCollect(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: process.cwd() }); // argv (no shell): args are not interpolated
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.once('error', reject);
    p.once('close', (code) => {
      if (code === 0) return resolve(out);
      const failure = new Error(err.trim() || `aiwg exit ${code}`);
      failure.exitCode = code;
      failure.stdout = out;
      reject(failure);
    });
  });
}
async function runAiwg(args) {
  const command = executorRequestContext.getStore()?.aiwgCommand;
  if (command) return command(Object.freeze([...args])); // errors never fall through to PATH
  try { return await spawnCollect('aiwg', args); }
  catch (e) { if (e && e.code === 'ENOENT') return spawnCollect(process.execPath, [REPO_BIN, ...args]); throw e; }
}

const MISSION_CONTROL_ID_RE = /^[a-zA-Z0-9._-]+$/;
async function controlMission({ action, sessionId, missionId, expectedUpdatedAt, requestId }) {
  if (!['pause', 'resume', 'cancel'].includes(action)) throw Object.assign(new Error('unsupported mission control action'), { status: 400 });
  if (!MISSION_CONTROL_ID_RE.test(sessionId) || (missionId && !MISSION_CONTROL_ID_RE.test(missionId))) {
    throw Object.assign(new Error('invalid Mission control identifier'), { status: 400 });
  }
  const args = ['mc', action, sessionId];
  if (action === 'cancel') {
    if (!missionId) throw Object.assign(new Error('mission id required'), { status: 400 });
    args.push(missionId);
  }
  if (expectedUpdatedAt) args.push('--expected-updated-at', String(expectedUpdatedAt));
  if (requestId) args.push('--request-id', String(requestId));
  await appendAudit('mission.control.requested', {
    action,
    session_id: sessionId,
    mission_id: missionId ?? null,
    expected_updated_at: expectedUpdatedAt ?? null,
    request_id: requestId ?? null,
  });
  try {
    await runAiwg(args);
  } catch (error) {
    const message = String(error?.message ?? error);
    const status = error?.exitCode === 3 || /mission_conflict/.test(message) ? 409 : 422;
    await appendAudit('mission.control.rejected', { action, session_id: sessionId, mission_id: missionId ?? null, request_id: requestId ?? null, status, reason: message });
    throw Object.assign(new Error(message), { status });
  }
  await appendAudit('mission.control.completed', { action, session_id: sessionId, mission_id: missionId ?? null, request_id: requestId ?? null });
  return { ok: true, action, session_id: sessionId, mission_id: missionId ?? null, request_id: requestId ?? null };
}

async function dispatchMission(body, upstreamUrl) {
  const sessionId = String(body?.session_id ?? '');
  const objective = String(body?.objective ?? '').trim();
  const completion = String(body?.completion ?? '').trim();
  const requestId = String(body?.request_id ?? randomBytes(16).toString('hex'));
  if (!MISSION_CONTROL_ID_RE.test(sessionId)) throw Object.assign(new Error('invalid Mission control session id'), { status: 400 });
  if (!objective || objective.length > 4096) throw Object.assign(new Error('objective is required and must be at most 4096 characters'), { status: 400 });
  if (completion.length > 4096) throw Object.assign(new Error('completion must be at most 4096 characters'), { status: 400 });
  if (!MISSION_CONTROL_ID_RE.test(requestId)) throw Object.assign(new Error('request_id must contain only letters, digits, dot, underscore, or hyphen'), { status: 400 });
  const args = ['mc', 'dispatch', sessionId, objective, '--request-id', requestId];
  if (completion) args.push('--completion', completion);
  if (body?.priority) args.push('--priority', String(body.priority));
  if (body?.expected_updated_at) args.push('--expected-updated-at', String(body.expected_updated_at));
  if (body?.max_iterations !== undefined) {
    const maxIterations = Number(body.max_iterations);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10_000) {
      throw Object.assign(new Error('max_iterations must be an integer from 1 to 10000'), { status: 400 });
    }
    args.push('--max-iterations', String(maxIterations));
  }
  await appendAudit('mission.dispatch.requested', { session_id: sessionId, request_id: requestId, objective_digest: `sha256:${createHash('sha256').update(objective).digest('hex')}` });
  try {
    await runAiwg(args);
    if (body?.run === true) {
      await runAiwg(['mc', 'run', sessionId, ...(body?.accept_cost === true ? ['--accept-cost'] : [])]);
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    const status = error?.exitCode === 3 || /mission_conflict/.test(message) ? 409 : 422;
    await appendAudit('mission.dispatch.rejected', { session_id: sessionId, request_id: requestId, status, reason: message });
    throw Object.assign(new Error(message), { status });
  }
  const missionId = `m-${createHash('sha256').update(requestId).digest('hex').slice(0, 16)}`;
  await appendAudit('mission.dispatch.completed', { session_id: sessionId, mission_id: missionId, request_id: requestId, run: body?.run === true });
  return { ok: true, session_id: sessionId, mission_id: missionId, request_id: requestId, projection: await getMissions(upstreamUrl) };
}
// --- user asset library (#1591/#1593): the operator's OWN copied/cloned/imported
// assets, on disk under ~/.aiwg/cockpit/library. AIWG install files are NEVER written
// (clone reads the catalog read-only, writes only into the library). ---
const LIBRARY_DIR = join(homedir(), '.aiwg', 'cockpit', 'library');
const currentLibraryDir = () => executorRequestContext.getStore()?.libraryDir ?? LIBRARY_DIR;
/** Resolve a name to a path INSIDE the library, or null if it would escape. */
function inLibrary(name) {
  const libraryDir = currentLibraryDir();
  const r = join(libraryDir, String(name).replace(/^[/\\]+/, ''));
  return r === libraryDir || r.startsWith(libraryDir + sep) ? r : null;
}
async function listLibrary() {
  const libraryDir = currentLibraryDir();
  let entries;
  try { entries = await readdir(libraryDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let meta = { name: e.name, kind: e.isDirectory() ? 'dir' : 'file', type: 'unknown', origin: 'imported' };
    if (e.isDirectory()) {
      try { meta = { ...meta, ...JSON.parse(await readFile(join(libraryDir, e.name, '.cockpit-origin.json'), 'utf8')), name: e.name, kind: 'dir' }; } catch { /* no manifest */ }
    }
    out.push(meta);
  }
  return out;
}
/** Clone a catalog asset (skill dir or single file) into the library — never the reverse. */
async function cloneToLibrary({ type, name, path }) {
  const libraryDir = currentLibraryDir();
  if (!type || !name || !path) throw new Error('type, name, path required');
  if (!existsSync(path)) throw new Error('source not found');
  await mkdir(libraryDir, { recursive: true, mode: 0o755 });
  const destName = String(name).replace(/[^a-z0-9._-]/gi, '-');
  const isDir = /SKILL\.(md|markdown)$/i.test(basename(path)) || (await stat(path)).isDirectory();
  const src = /SKILL\.(md|markdown)$/i.test(basename(path)) ? dirname(path) : path;
  if (isDir) {
    const dest = inLibrary(destName);
    if (!dest || existsSync(dest)) throw new Error(`already in library: ${destName}`);
    await cp(src, dest, { recursive: true });
    await writeFile(join(dest, '.cockpit-origin.json'), JSON.stringify({ name: destName, type, origin: 'aiwg-catalog', kind: 'dir', source_path: path, cloned_at: new Date().toISOString() }, null, 2), { mode: 0o644 });
    return { name: destName, type, kind: 'dir' };
  }
  const dest = inLibrary(destName + (extname(path) || '.md'));
  if (!dest || existsSync(dest)) throw new Error(`already in library: ${destName}`);
  await cp(src, dest);
  return { name: basename(dest), type, kind: 'file' };
}

/** The `aiwg show <type> <name>` slug for a discover result path. */
function deriveName(path) {
  const base = basename(path);
  if (/^SKILL\.(md|markdown)$/i.test(base)) return basename(dirname(path));
  return base.replace(/\.(md|markdown|ya?ml|json)$/i, '');
}

// /api/show resolution by PATH (#1643). `aiwg show <type> <name>` is ambiguous when
// two artifacts share a name (e.g. two `aiwg-steward` agents) — it exits non-zero on
// stderr, which the Bridge would otherwise surface as a 502. `discover` already returns
// the exact path, so the Bridge reads that corpus file directly: deterministic, no
// ambiguity. The path is constrained to the AIWG corpus root(s) to prevent traversal.
const SHOW_EXT_RE = /\.(md|markdown|ya?ml|json)$/i;
const CORPUS_ROOTS = [dirname(dirname(REPO_BIN)), process.env.AIWG_ROOT]
  .filter(Boolean)
  .map((r) => resolve(r));
/** Resolve a discover-provided path to an absolute corpus file, or null if it escapes. */
function resolveCorpusPath(p) {
  let abs;
  try { abs = resolve(String(p)); } catch { return null; }
  if (!SHOW_EXT_RE.test(abs)) return null;
  if (!(executorRequestContext.getStore()?.corpusRoots ?? CORPUS_ROOTS).some((root) => abs === root || abs.startsWith(root + sep))) return null;
  return abs;
}

// --- UI contribution model (#1591): declarative screens/actions/event-hooks ---
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Validate one contribution manifest. Throws with a precise message on bad shape. */
function validateContribution(m, where, { firstParty = false } = {}) {
  const fail = (msg) => { throw new Error(`${where}: ${msg}`); };
  if (!m || typeof m !== 'object') fail('manifest must be an object');
  if (!ID_RE.test(m.id || '')) fail('id must match [a-z0-9._-]{1,64}');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version)) fail('version must be semantic version syntax');
  const c = m.contributes || {};
  const actionIds = new Set();
  for (const a of c.actions || []) {
    if (!ID_RE.test(a.id || '')) fail(`action.id invalid: ${a.id}`);
    if (actionIds.has(a.id)) fail(`duplicate action.id: ${a.id}`);
    actionIds.add(a.id);
    if (typeof a.title !== 'string') fail(`action ${a.id}: title required`);
    // An action INJECTS a command into an agentic session — it does NOT run the CLI.
    if (!a.inject || typeof a.inject.command !== 'string') fail(`action ${a.id}: inject.command (string) required`);
    if (!/^\/[a-z0-9][a-z0-9._-]*(?:\s[^\r\n]*)?$/i.test(a.inject.command)) fail(`action ${a.id}: inject.command must be one slash command without newlines`);
    if (a.inject.target && !['focused', 'new'].includes(a.inject.target)) fail(`action ${a.id}: inject.target must be focused|new`);
  }
  for (const s of c.screens || []) {
    if (!ID_RE.test(s.id || '')) fail(`screen.id invalid: ${s.id}`);
    if (typeof s.title !== 'string') fail(`screen ${s.id}: title required`);
    if (typeof s.source !== 'string') fail(`screen ${s.id}: source required`);
    if (firstParty) {
      if (!s.source.startsWith('cockpit://')) fail(`screen ${s.id}: first-party source must use cockpit://`);
    } else if (!s.source.startsWith(`sandbox://${m.id}/`)) {
      fail(`screen ${s.id}: third-party source must use sandbox://${m.id}/`);
    }
  }
  for (const w of c.workflows || []) {
    if (!ID_RE.test(w.id || '')) fail(`workflow.id invalid: ${w.id}`);
    if (typeof w.title !== 'string') fail(`workflow ${w.id}: title required`);
    if (!Array.isArray(w.steps) || w.steps.length === 0) fail(`workflow ${w.id}: steps required`);
    for (const step of w.steps) {
      if (!step || typeof step !== 'object' || !ID_RE.test(step.action || '')) fail(`workflow ${w.id}: step.action invalid`);
      if (!actionIds.has(step.action)) fail(`workflow ${w.id}: unknown action ${step.action}`);
    }
  }
  for (const h of c.hooks || []) {
    if (typeof h.on !== 'string' || !ID_RE.test(h.action || '') || !actionIds.has(h.action)) fail(`hook invalid: on=${h.on}`);
  }
  return m;
}
/** Load + validate + merge all contribution manifests across the configured dirs. */
async function loadContributions() {
  const sources = [], actions = [], screens = [], hooks = [], workflows = [];
  const manifestIds = new Set();
  const itemIds = new Set();
  for (const [dirIndex, dir] of (executorRequestContext.getStore()?.contributionDirs ?? CONTRIB_DIRS).entries()) {
    const trustTier = dirIndex === 0 ? 'first-party' : 'sandboxed-third-party';
    let entries = [];
    try { entries = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'contribution.schema.json'); } catch { continue; }
    for (const file of entries) {
      const m = validateContribution(JSON.parse(await readFile(join(dir, file), 'utf8')), file, { firstParty: dirIndex === 0 });
      if (manifestIds.has(m.id)) throw new Error(`${file}: duplicate contribution id ${m.id}`);
      manifestIds.add(m.id);
      sources.push({ id: m.id, version: m.version, title: m.title ?? m.id, file, trust_tier: trustTier });
      for (const [kind, rows] of Object.entries({ actions: m.contributes?.actions || [], screens: m.contributes?.screens || [], hooks: m.contributes?.hooks || [], workflows: m.contributes?.workflows || [] })) {
        for (const row of rows) {
          const globalId = `${kind}:${row.id ?? `${row.on}:${row.action}`}`;
          if (itemIds.has(globalId)) throw new Error(`${file}: duplicate ${globalId}`);
          itemIds.add(globalId);
        }
      }
      for (const a of m.contributes?.actions || []) actions.push({ ...a, source: m.id, trust_tier: trustTier });
      for (const s of m.contributes?.screens || []) screens.push({ ...s, contribution: m.id, trust_tier: trustTier });
      for (const h of m.contributes?.hooks || []) hooks.push({ ...h, source: m.id, trust_tier: trustTier });
      for (const w of m.contributes?.workflows || []) workflows.push({ ...w, source: m.id, trust_tier: trustTier });
    }
  }
  return { sources, actions, screens, hooks, workflows };
}

function safeIndexGraph(value) {
  const graph = String(value ?? '').trim();
  if (!graph) return '';
  if (!ID_RE.test(graph)) throw new Error('graph must match [a-z0-9._-]{1,64}');
  return graph;
}

function safeIndexLimit(value, fallback = 20) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('limit must be an integer from 1 to 100');
  return n;
}

async function getIndexStatus() {
  return JSON.parse(await runAiwg(['index', 'status', '--json']));
}

async function queryIndex(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return { status: 400, body: { error: 'q_required' } };
  let limit;
  try { limit = safeIndexLimit(url.searchParams.get('limit'), 20); }
  catch (e) { return { status: 400, body: { error: 'invalid_limit', detail: String(e?.message ?? e) } }; }
  const args = ['index', 'query', q, '--json', '--backend', 'local', '--limit', String(limit)];
  try {
    const graph = safeIndexGraph(url.searchParams.get('graph'));
    if (graph) args.push('--graph', graph);
  } catch (e) { return { status: 400, body: { error: 'invalid_graph', detail: String(e?.message ?? e) } }; }
  for (const flag of ['type', 'phase', 'tags', 'path']) {
    const value = (url.searchParams.get(flag) || '').trim();
    if (value) args.push(`--${flag}`, value);
  }
  return { status: 200, body: JSON.parse(await runAiwg(args)) };
}

async function rebuildIndex(req) {
  const parsed = await readJsonBody(req);
  if (parsed.error) return { status: 400, body: { error: parsed.error } };
  const body = parsed.body || {};
  const args = ['index', 'build'];
  try {
    const graph = safeIndexGraph(body.graph);
    if (graph) args.push('--graph', graph);
  } catch (e) { return { status: 400, body: { error: 'invalid_graph', detail: String(e?.message ?? e) } }; }
  if (body.all === true) args.push('--all');
  if (body.force === true) args.push('--force');
  const requested = await appendAudit('index.rebuild.requested', { graph: body.graph ?? null, all: body.all === true, force: body.force === true });
  const output = await runAiwg(args);
  const status = await getIndexStatus();
  await appendAudit('index.rebuild.completed', { request_ts: requested.ts, graph: body.graph ?? null, all: body.all === true, force: body.force === true });
  return { status: 200, body: { ok: true, command: `aiwg ${args.join(' ')}`, output, status } };
}

export async function createUserIndexGraph(body, projectRoot = process.cwd()) {
  const name = safeIndexGraph(body?.name);
  if (!name || ['project', 'codebase', 'framework'].includes(name)) {
    throw new Error('name must be a non-built-in graph identifier');
  }
  const scanDirs = Array.isArray(body?.scanDirs) ? body.scanDirs.map((value) => String(value).trim()) : [];
  if (!scanDirs.length || scanDirs.some((value) => !value || value.startsWith('/') || value.split(/[\\/]+/).includes('..'))) {
    throw new Error('scanDirs must contain safe project-relative paths');
  }
  const extensions = Array.isArray(body?.extensions) && body.extensions.length
    ? body.extensions.map((value) => String(value).trim())
    : ['.md', '.yaml', '.json'];
  if (extensions.some((value) => !/^\.[a-z0-9]+$/i.test(value))) {
    throw new Error('extensions must use forms such as .md or .json');
  }
  const configDir = join(projectRoot, '.aiwg');
  const configPath = join(configDir, 'aiwg.config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  config.index = config.index && typeof config.index === 'object' ? config.index : {};
  config.index.graphs = config.index.graphs && typeof config.index.graphs === 'object' ? config.index.graphs : {};
  if (config.index.graphs[name]) throw new Error(`graph '${name}' already exists`);
  config.index.graphs[name] = {
    scanDirs,
    extensions,
    defaultBuild: body?.defaultBuild === true,
    shared: body?.shared === true,
  };
  const temporary = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  return { name, definition: config.index.graphs[name], config_path: configPath };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function redactErrorText(value) {
  return String(value ?? '')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (value) => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
      catch { return '[redacted URL]'; }
    })
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function bridgeErrorBody(err, code = err?.code ?? 'bridge_upstream_error') {
  console.error('[cockpit-bridge] request failed', {
    code: redactErrorText(code), message: redactErrorText(err?.message ?? err), stack: redactErrorText(err?.stack),
  });
  const validationMessages = {
    activity_invalid_request: 'Activity request must be an object.',
    activity_scope_required: 'Activity requires tenant_id, host_id, instance_id and agent_id.',
    activity_invalid_filter: 'Activity filters must use supported names and values; limit must be 1..1000.',
  };
  const message = validationMessages[code] ?? 'Bridge request failed.';
  const recovery = code === 'executor_trust_required' && [
    'Sandbox CA and bootstrap trust are ready.',
    'Refresh sandbox CA/bootstrap readiness, rotate stale trust material, then reload Cockpit.',
    'Plaintext local development mode only; enable sandbox mTLS before using remote or shared executors.',
    'Configure sandbox CA provider and client trust refs before connecting Cockpit.',
  ].includes(err?.recovery) ? err.recovery : undefined;
  return { error: code, message, ...(recovery ? { recovery } : {}) };
}

function upstreamErrorBody(status, body) {
  const generic = bridgeErrorBody(new Error(JSON.stringify(redactAuditValue(body))), 'bridge_upstream_error');
  // Preserve only locally defined projections needed for recovery/negotiation.
  const managed = managedDockerLaunchError(status, body);
  if (managed.body !== body) return managed.body;
  if (isA2AVersionNotSupported(status, body)) return { ...generic, code: 'version_not_supported' };
  return generic;
}

function redactAuditValue(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password|credential|api[_-]?key|authorization|csrf/i.test(k)) out[k] = '[redacted]';
      else out[k] = redactAuditValue(v);
    }
    return out;
  }
  if (typeof value === 'string' && /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9]|gh[pousr]_[a-z0-9])/i.test(value)) return '[redacted]';
  return value;
}

async function appendAudit(event, fields = {}) {
  const dir = auditDir();
  const log = auditLog();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = redactAuditValue({
    event,
    ts: new Date().toISOString(),
    actor: 'operator',
    surface: 'cockpit-bridge',
    ...fields,
  });
  await appendFile(log, JSON.stringify(entry) + '\n', { mode: 0o600 });
  await chmod(log, 0o600).catch(() => undefined);
  return entry;
}

async function readAudit({ limit = 50 } = {}) {
  try {
    const raw = await readFile(auditLog(), 'utf8');
    return raw.trim().split(/\n+/).filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { event: 'unparsed', line }; }
    });
  } catch {
    return [];
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    return { body: JSON.parse(rawBody) };
  } catch {
    return { error: 'invalid_json' };
  }
}

/** Forward a control-plane call to the executor admin surface, relaying status + body. */
async function proxy(res, method, target) {
  const r = await executorFetch(target, { method });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    const err = new Error(`executor ${r.status === 401 ? 'authentication' : 'authorization'} failed at ${new URL(target).pathname}`);
    err.code = r.status === 401 ? 'executor_unauthenticated' : 'executor_forbidden';
    err.upstreamStatus = r.status;
    throw err;
  }
  return json(res, r.status, r.ok ? body : upstreamErrorBody(r.status, body));
}

const SAFE_FALLBACK_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isAbortError(err) {
  return err?.name === 'AbortError' || /aborted|abort/i.test(String(err?.message ?? err));
}

function isConnectionRefusedError(err) {
  const text = [
    err?.code,
    err?.cause?.code,
    err?.message,
    err?.cause?.message,
  ].filter(Boolean).join(' ');
  return /ECONNREFUSED|connection refused/i.test(text);
}

function rethrowExecutorSecurityError(err) {
  if (
    [401, 403].includes(Number(err?.upstreamStatus)) ||
    String(err?.code ?? '').startsWith('executor_credential_') ||
    String(err?.code ?? '').startsWith('executor_trust_')
  ) throw err;
}

export async function fetchJsonFirst(candidates, { method = 'GET', headers, body: requestBodyOption, timeoutMs = 0, executorUrl = executorRequestContext.getStore()?.executorOrigin ?? EXECUTOR_URL } = {}) {
  const failures = [];
  let refused = 0;
  for (const candidate of candidates) {
    const target = typeof candidate === 'string' ? candidate : candidate.target;
    const requestMethod = typeof candidate === 'string' ? method : candidate.method ?? method;
    const requestHeaders = typeof candidate === 'string' ? headers : candidate.headers ?? headers;
    const requestBody = typeof candidate === 'string' ? requestBodyOption : candidate.body ?? requestBodyOption;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let r;
    try {
      r = await executorFetch(target, { method: requestMethod, headers: requestHeaders, body: requestBody, ...(controller ? { signal: controller.signal } : {}) }, executorUrl);
    } catch (err) {
      rethrowExecutorSecurityError(err);
      if (err?.code === 'executor_target_refused') {
        refused++;
        bridgeErrorBody(err);
        failures.push(`${target} -> refused`);
        continue; // No request was sent; a fixed fallback is safe even for POST.
      }
      const failure = isAbortError(err) && timeoutMs > 0
        ? `${target} -> timeout after ${timeoutMs}ms`
        : `${target} -> ${String(err?.message ?? err)}`;
      failures.push(failure);
      const safeToTryNext = SAFE_FALLBACK_METHODS.has(String(requestMethod).toUpperCase())
        || isConnectionRefusedError(err);
      if (!safeToTryNext) throw new Error(failures.join('; '));
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const responseBody = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) {
      const err = new Error(`executor ${r.status === 401 ? 'authentication' : 'authorization'} failed at ${new URL(target).pathname}`);
      err.code = r.status === 401 ? 'executor_unauthenticated' : 'executor_forbidden';
      err.upstreamStatus = r.status;
      throw err;
    }
    if (r.ok) return { target, status: r.status, body: responseBody };
    failures.push(`${target} -> ${r.status}`);
    if (r.status !== 404 && r.status !== 405) return { target, status: r.status, body: upstreamErrorBody(r.status, responseBody), failures };
  }
  if (refused && refused === candidates.length) throw executorAuthError('executor_target_refused', 'no allowed upstream candidates');
  throw new Error(failures.join('; ') || 'no upstream candidates');
}

function mockExecutorReason(body) {
  if (!body || typeof body !== 'object') return '';
  const value = body;
  if (value.mock === true) return 'health.mock=true';
  if (String(value.name ?? '').toLowerCase().includes('mock')) return `health.name=${value.name}`;
  if (Array.isArray(value.surfaces) && value.surfaces.includes('discovery') && value.surfaces.includes('admin')) {
    return 'legacy mock health surfaces';
  }
  return '';
}

async function assertRealExecutor(executorUrl, allowMockExecutor) {
  if (allowMockExecutor) return;
  let health;
  try {
    health = await fetchJsonFirst([`${executorUrl}/health`]);
  } catch {
    return;
  }
  const reason = mockExecutorReason(health.body);
  if (reason) {
    const err = new Error(`mock executor refused for dev/operator launch (${reason}); use a real agentic-sandbox executor or set AIWG_COCKPIT_ALLOW_MOCK_EXECUTOR=1 only inside automated tests`);
    err.code = 'mock_executor_refused';
    throw err;
  }
}

async function probeExecutor(executorUrl) {
  for (const path of ['/healthz/http', '/healthz', '/health']) {
    try {
      const r = await executorFetch(`${executorUrl}${path}`, { signal: AbortSignal.timeout(1_500) }, executorUrl);
      if (r.ok) return true;
    } catch {
      // Try the next health endpoint.
    }
  }
  return false;
}

async function getExecutorCapabilities(executorUrl) {
  const candidates = ['/healthz/deep', '/healthz', '/health'].map((path) => `${executorUrl}${path}`);
  try {
    const { target, body } = await fetchJsonFirst(candidates);
    const runtimeProviders = await fetchJsonFirst([
      `${executorUrl}/api/v2/admin/runtime/providers`,
      `${executorUrl}/api/v2/runtime/providers`,
      `${executorUrl}/admin/runtime/providers`,
      `${executorUrl}/runtime/providers`,
    ])
      .then((result) => result.body)
      .catch(() => undefined);
    return {
      status: 'ok',
      source: new URL(target).pathname,
      host_runtime_enabled: body.host_runtime_enabled === true || body.hostRuntimeEnabled === true,
      runtime_providers: runtimeProviders && Array.isArray(runtimeProviders.providers) ? runtimeProviders : undefined,
      raw_status: body.status ?? body.state ?? 'unknown',
      real_executor: !mockExecutorReason(body),
      implementation: body.implementation ?? body.service ?? body.name ?? 'agentic-sandbox',
      version: body.version ?? body.build?.version ?? null,
      commit: body.commit ?? body.build?.commit ?? body.git_commit ?? null,
      auth_required: body.auth_required ?? body.auth?.required ?? null,
    };
  } catch (err) {
    rethrowExecutorSecurityError(err);
    return {
      status: 'unreachable',
      source: null,
      host_runtime_enabled: false,
      error: bridgeErrorBody(err).message,
    };
  }
}

async function getMcpDiscovery(executorUrl) {
  try {
    const { target, body } = await fetchJsonFirst([
      `${executorUrl}/api/v2/admin/mcp/discovery`,
      `${executorUrl}/admin/mcp/discovery`,
    ]);
    return {
      source: executorUrl,
      discovery_path: new URL(target).pathname,
      fetched_at: new Date().toISOString(),
      ...normalizeMcpDiscovery(body, executorUrl),
    };
  } catch (err) {
    rethrowExecutorSecurityError(err);
    return normalizeMcpDiscovery({
      enabled: false,
      status: 'disabled',
      reason_code: 'mcp.discovery_unavailable',
      error: bridgeErrorBody(err).message,
    }, executorUrl);
  }
}

function normalizeMcpDiscovery(body, source) {
  const endpoint = body?.endpoint && typeof body.endpoint === 'object' ? body.endpoint : {};
  const auth = body?.auth && typeof body.auth === 'object' ? body.auth : {};
  return {
    source: source ?? body?.source,
    enabled: body?.enabled === true,
    status: body?.status ?? (body?.enabled === true ? 'enabled' : 'disabled'),
    reason_code: body?.reason_code ?? body?.reasonCode ?? null,
    error: body?.error,
    endpoint: {
      path: endpoint.path ?? '/mcp',
      methods: Array.isArray(endpoint.methods) ? endpoint.methods : ['POST'],
      transport: endpoint.transport ?? 'streamable-http',
      stateless: endpoint.stateless !== false,
      get_behavior: endpoint.get_behavior ?? endpoint.getBehavior ?? '405_method_not_allowed',
      mcp_session_id: endpoint.mcp_session_id ?? endpoint.mcpSessionId ?? false,
    },
    protocol: body?.protocol ?? { latest: '2025-11-25', supported: [] },
    auth: {
      scheme: auth.scheme ?? 'bearer',
      required: auth.required !== false,
      principal_config: auth.principal_config ?? auth.principalConfig ?? 'mcp-principals.toml',
      principals: Array.isArray(auth.principals) ? auth.principals.map((principal) => ({
        client_id: principal.client_id ?? principal.clientId ?? '',
        scopes: Array.isArray(principal.scopes) ? principal.scopes : [],
      })).filter((principal) => principal.client_id) : [],
      scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
    },
    capabilities: body?.capabilities ?? {},
    tools: Array.isArray(body?.tools) ? body.tools : [],
    resources: Array.isArray(body?.resources) ? body.resources : [],
    resource_templates: Array.isArray(body?.resource_templates)
      ? body.resource_templates
      : Array.isArray(body?.resourceTemplates) ? body.resourceTemplates : [],
    errors: Array.isArray(body?.errors) ? body.errors : [],
    notes: Array.isArray(body?.notes) ? body.notes : [],
  };
}

async function proxyMcpRequest(req, res, executorUrl, mcpTokenFile) {
  if (!mcpTokenFile) {
    await appendAudit('sandbox.mcp.proxy', {
      result: 'blocked',
      reason: 'mcp_token_file_unconfigured',
    });
    return json(res, 503, {
      error: 'mcp_token_file_unconfigured',
      message: 'Bridge MCP proxy requires AIWG_COCKPIT_MCP_TOKEN_FILE.',
    });
  }
  const parsed = await readJsonBody(req);
  if (parsed.error) return json(res, 400, { error: parsed.error });
  const body = parsed.body || {};
  const rpcMethod = typeof body.method === 'string' ? body.method : 'unknown';
  const target = `${executorUrl}/mcp`;
  let status = 502;
  try {
    const token = await resolveExecutorBearer(mcpTokenFile);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const protocolVersion = req.headers['mcp-protocol-version'];
    if (typeof protocolVersion === 'string' && protocolVersion.trim()) {
      headers['mcp-protocol-version'] = protocolVersion.trim();
    }
    const response = await executorFetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, executorUrl);
    status = response.status;
    const responseBody = await response.json().catch(() => ({}));
    await appendAudit('sandbox.mcp.proxy', {
      result: response.ok ? 'ok' : 'error',
      method: rpcMethod,
      status,
    });
    return json(res, status, response.ok ? responseBody : upstreamErrorBody(status, responseBody));
  } catch (err) {
    await appendAudit('sandbox.mcp.proxy', {
      result: 'error',
      method: rpcMethod,
      status,
      error: String(err?.code ?? err?.message ?? err),
    });
    throw err;
  }
}

function defaultExecutorCommand() {
  if (EXECUTOR_COMMAND) return EXECUTOR_COMMAND.split(/\s+/).filter(Boolean);
  const candidates = [
    '/home/roctinam/dev/agentic-sandbox/management/target/release/agentic-mgmt',
    '/home/roctinam/dev/agentic-sandbox/management/target/debug/agentic-mgmt',
    'agentic-mgmt',
  ];
  for (const c of candidates) {
    if (c === 'agentic-mgmt' || existsSync(c)) return [c];
  }
  return [];
}

export async function ensureExecutor(
  executorUrl,
  { command, probe = probeExecutor, autostart = AUTOSTART_EXECUTOR } = {},
) {
  if (!autostart || await probe(executorUrl)) return;
  const cmd = command ?? defaultExecutorCommand();
  if (!cmd.length) return;
  const child = spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!started) return;
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await probe(executorUrl)) return;
  }
}

async function proxyFirst(res, candidates, options) {
  try {
    const { status, body } = await fetchJsonFirst(candidates, options);
    return json(res, status, body);
  } catch (err) {
    if ([401, 403].includes(Number(err?.upstreamStatus))) {
      return json(res, Number(err.upstreamStatus), bridgeErrorBody(err));
    }
    rethrowExecutorSecurityError(err);
    const message = String(err?.message ?? err);
    const notFound = / -> 404(?:;|$)/.test(message);
    const methodNotAllowed = / -> 405(?:;|$)/.test(message);
    return json(res, notFound ? 404 : methodNotAllowed ? 405 : 502, bridgeErrorBody(err, notFound ? 'upstream_not_found' : methodNotAllowed ? 'upstream_method_not_allowed' : 'bridge_upstream_error'));
  }
}

function normalizedInstanceName(value, fallback = 'cockpit-fast-start') {
  const cleaned = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+$/g, '')
    .slice(0, 63);
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `a-${cleaned.replace(/^-+/, '')}`;
  return prefixed && prefixed.length >= 2 ? prefixed.slice(0, 63) : fallback;
}

function instanceVmName(instance, instanceId) {
  return instance?.launch_context?.name
    ?? instance?.launchContext?.name
    ?? instance?.name
    ?? instance?.id
    ?? instanceId;
}

function defaultAssetRef(instanceId, action) {
  return `${normalizedInstanceName(instanceId, 'cockpit-vm')}-${action}-${Date.now().toString(36)}`.slice(0, 96);
}

function upstreamBridgeError(err) {
  rethrowExecutorSecurityError(err);
  return { status: 502, body: bridgeErrorBody(err) };
}

async function providerFastStartAction(upstreamUrl, instanceId, action, body = {}) {
  let inventory;
  try { inventory = await getInventory(upstreamUrl); }
  catch (err) { rethrowExecutorSecurityError(err); inventory = { instances: [] }; }
  const inst = inventory.instances.find((i) => String(i.id) === String(instanceId));
  if (!inst) return { status: 404, body: { error: 'instance_not_found', instance_id: instanceId } };
  const runtime = String(inst.runtime_posture?.kind ?? inst.runtime ?? '').toLowerCase();
  if (!['vm', 'qemu', 'kvm'].includes(runtime)) {
    return { status: 422, body: { error: 'unsupported_runtime', message: 'fast-start actions are valid only for VM instances' } };
  }
  const provider = String(inst.provider ?? '').trim();
  if (!provider) return { status: 422, body: { error: 'provider_required', message: 'executor inventory did not report an effective VM provider' } };

  const vmName = instanceVmName(inst, instanceId);
  const rawAsset = body.asset_ref ?? body.assetRef ?? body.snapshot_id ?? body.snapshotId ?? body.checkpoint_id ?? body.checkpointId ?? body.pool;
  const assetRef = String(rawAsset ?? '').trim();
  const restoreMode = String(body.restore_mode ?? body.restoreMode ?? 'ondemand').trim() || 'ondemand';
  const childName = normalizedInstanceName(
    body.name ?? body.child_name ?? body.childName,
    `${normalizedInstanceName(vmName, 'cockpit-vm')}-${action === 'warm-pool' ? 'warm' : action}`,
  );

  if (action === 'snapshot' || action === 'checkpoint') {
    const newAssetRef = assetRef || defaultAssetRef(vmName, provider === 'libvirt' ? 'checkpoint' : 'snapshot');
    if (provider === 'cloud-hypervisor') {
      return fetchJsonFirst([{
        target: `${upstreamUrl}/api/v2/admin/cloud-hypervisor/snapshots`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vm: vmName,
          snapshot_id: newAssetRef,
          pre_enrollment: body.pre_enrollment ?? body.preEnrollment ?? true,
        }),
      }]).catch(upstreamBridgeError);
    }
    if (provider === 'libvirt') {
      return fetchJsonFirst([{
        target: `${upstreamUrl}/api/v2/admin/libvirt/checkpoints`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vm: vmName,
          checkpoint_id: newAssetRef,
          pre_enrollment: true,
        }),
      }]).catch(upstreamBridgeError);
    }
    return { status: 422, body: { error: 'unsupported_provider_action', provider, action } };
  }

  if (!assetRef) {
    return { status: 400, body: { error: 'asset_ref_required', message: 'restore, fork, and warm-pool actions require an opaque asset_ref' } };
  }
  const mode = action === 'warm-pool' ? 'warm_pool' : action;
  return fetchJsonFirst([{
    target: `${upstreamUrl}/api/v2/admin/instances`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: childName,
      runtime: 'qemu',
      provider,
      runtime_options: {
        kind: 'vm',
        provider,
        launch_strategy: {
          mode,
          prefer_fast_start: true,
          asset_ref: assetRef,
          ...(provider === 'cloud-hypervisor' ? { restore_mode: restoreMode } : {}),
        },
      },
    }),
  }]).catch(upstreamBridgeError);
}

async function destroyInstance(upstreamUrl, instanceId) {
  let inventory;
  try { inventory = await getInventory(upstreamUrl); }
  catch (err) { rethrowExecutorSecurityError(err); inventory = { instances: [] }; }
  const inst = inventory.instances.find((i) => String(i.id) === String(instanceId));
  const runtime = String(inst?.runtime ?? inst?.runtime_posture?.kind ?? '').toLowerCase();
  const dockerName = inst?.launch_context?.name;
  const candidates = [
    { target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/destroy`, method: 'POST' },
    { target: `${upstreamUrl}/admin/instances/${encodeURIComponent(instanceId)}/destroy`, method: 'POST' },
    { target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}`, method: 'DELETE' },
    { target: `${upstreamUrl}/admin/instances/${encodeURIComponent(instanceId)}`, method: 'DELETE' },
  ];
  try {
    const result = await fetchJsonFirst(candidates);
    if (result.status < 400) {
      if (localDockerFallbackEnabled() && ['docker', 'container'].includes(runtime) && dockerName) {
        try {
          await spawnCollect('docker', ['rm', '-f', dockerName]);
          return {
            ...result,
            body: {
              ...result.body,
              cockpit_reconcile: 'docker-cli-after-admin-v2-success',
              docker_name: dockerName,
            },
          };
        } catch {
          // If Docker already removed it, the admin result is still authoritative.
        }
      }
      return result;
    }
  } catch (err) {
    rethrowExecutorSecurityError(err);
    const message = String(err?.message ?? err);
    // A docker/container row with a resolvable name is still physically
    // removable even when admin-v2 has no instance record (404): fall through
    // to the `docker rm -f` cleanup below so the stopped container is actually
    // removed. Returning already_gone here would claim success while the
    // container persists and re-appears on the next inventory poll — the
    // "stale stopped Docker row can't be destroyed" failure.
    const dockerCleanable = ['docker', 'container'].includes(runtime) && dockerName;
    if (inst && !dockerCleanable && / -> 404(?:;|$)/.test(message)) {
      return {
        target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/destroy`,
        status: 200,
        body: {
          id: instanceId,
          destroyed: instanceId,
          state: 'destroyed',
          result: { state: 'destroyed' },
          already_gone: true,
          message: `Instance ${instanceId} was already removed; inventory refreshed.`,
        },
      };
    }
    // Current sandbox builds can list Docker rows in admin-v2 inventory while
    // lifecycle verbs return instance.not_found. Fall through to a dev cleanup.
  }

  if (!inst || !['docker', 'container'].includes(runtime) || !dockerName) {
    return {
      target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/destroy`,
      status: 404,
      body: { error: 'instance_not_destroyable', message: `No destroyable runtime record for ${instanceId}` },
    };
  }
  if (!localDockerFallbackEnabled()) {
    return {
      target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/destroy`,
      status: 409,
      body: {
        error: 'local_docker_fallback_disabled',
        message: 'Sandbox management did not accept this destroy request. Local docker rm fallback is disabled unless AIWG_COCKPIT_LOCAL_DOCKER_FALLBACK=1 is set for local development.',
        runtime,
        docker_name: dockerName,
      },
    };
  }

  let alreadyGone = false;
  try {
    await spawnCollect('docker', ['rm', '-f', dockerName]);
  } catch (err) {
    // `docker rm -f` errors only because the container is already gone (e.g.
    // removed out-of-band). That is success for a destroy request, not a failure.
    if (/No such container|is not running|not found/i.test(String(err?.message ?? err))) {
      alreadyGone = true;
    } else {
      throw err;
    }
  }
  return {
    target: `docker rm -f ${dockerName}`,
    status: 200,
    body: {
      id: instanceId,
      name: dockerName,
      runtime,
      state: 'destroyed',
      result: { state: 'destroyed' },
      already_gone: alreadyGone,
      message: alreadyGone ? `Container ${dockerName} was already removed; inventory refreshed.` : undefined,
      fallback: 'docker-cli-after-admin-v2-instance-not-found',
    },
  };
}

// #1778: VM-runtime counterpart of `docker exec <ctr> agent-reconnect`. Sandbox
// VM images bake qemu-guest-agent ("essential for virsh exec") and agent-rs
// handles SIGHUP as reconnect-in-place on every runtime, so delivering
// `pkill -HUP -x agent-client` through the libvirt guest-agent channel makes
// the agent re-register without touching the VM. Session survival is
// version-conditional: agentic-sandbox 2026.7.8+ agents preserve all sessions
// across reconnect; older agents preserve only detached-tmux sessions
// (agentic-sandbox#634).
async function signalVmAgentReconnect(domain) {
  const execRaw = await spawnCollect('virsh', ['qemu-agent-command', domain, JSON.stringify({
    execute: 'guest-exec',
    arguments: { path: '/bin/sh', arg: ['-c', 'pkill -HUP -x agent-client'], 'capture-output': true },
  })]);
  const pid = JSON.parse(String(execRaw))?.return?.pid;
  if (!Number.isInteger(pid)) throw new Error(`guest-exec returned no pid: ${String(execRaw).trim()}`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const statusRaw = await spawnCollect('virsh', ['qemu-agent-command', domain, JSON.stringify({
      execute: 'guest-exec-status',
      arguments: { pid },
    })]);
    const status = JSON.parse(String(statusRaw))?.return;
    if (status?.exited) return status.exitcode ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The signal command was handed to the guest; slow exec-status reporting is
  // not a delivery failure.
  return 0;
}

const VM_RUNTIME_KINDS = ['vm', 'qemu', 'kvm'];

async function reconnectInstance(upstreamUrl, instanceId) {
  let inventory;
  try { inventory = await getInventory(upstreamUrl); }
  catch (err) { rethrowExecutorSecurityError(err); inventory = { instances: [] }; }
  const inst = inventory.instances.find((i) => String(i.id) === String(instanceId));
  const runtime = String(inst?.runtime ?? inst?.runtime_posture?.kind ?? '').toLowerCase();
  const dockerName = inst?.launch_context?.name;
  const candidates = [
    { target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/reconnect`, method: 'POST' },
    { target: `${upstreamUrl}/admin/instances/${encodeURIComponent(instanceId)}/reconnect`, method: 'POST' },
    { target: `${upstreamUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/reconnect`, method: 'POST' },
  ];
  try {
    const result = await fetchJsonFirst(candidates, { timeoutMs: 5_000 });
    if (result.status < 400) return result;
  } catch (err) {
    rethrowExecutorSecurityError(err);
    // agentic-sandbox v2026.7.6 still exposes the container reconnect as an
    // in-image helper, not an HTTP endpoint. Fall through to the local-dev path.
  }

  if (['docker', 'container'].includes(runtime) && dockerName) {
    if (!localDockerFallbackEnabled()) {
      return {
        target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/reconnect`,
        status: 409,
        body: {
          error: 'local_docker_fallback_disabled',
          message: 'Sandbox management did not accept this reconnect request. Local docker exec fallback is disabled unless AIWG_COCKPIT_LOCAL_DOCKER_FALLBACK=1 is set for local development.',
          runtime,
          docker_name: dockerName,
        },
      };
    }
    try {
      const output = await spawnCollect('docker', ['exec', dockerName, 'agent-reconnect']);
      return {
        target: `docker exec ${dockerName} agent-reconnect`,
        status: 202,
        body: {
          id: instanceId,
          runtime,
          docker_name: dockerName,
          state: 'reconnecting',
          message: `Reconnect requested for ${dockerName}; inventory will refresh as the agent re-registers.`,
          output: String(output).trim(),
          fallback: 'docker-agent-reconnect',
        },
      };
    } catch (err) {
      return {
        target: `docker exec ${dockerName} agent-reconnect`,
        status: 502,
        body: {
          error: 'reconnect_failed',
          message: `Could not run agent-reconnect in ${dockerName}. Repull/rebuild the agent image if it predates agentic-sandbox v2026.7.5.`,
          detail: bridgeErrorBody(err, 'reconnect_failed').message,
        },
      };
    }
  }

  if (VM_RUNTIME_KINDS.includes(runtime)) {
    if (!localLibvirtFallbackEnabled()) {
      return {
        target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/reconnect`,
        status: 409,
        body: {
          error: 'local_libvirt_fallback_disabled',
          message: 'Sandbox management did not accept this reconnect request. Local virsh fallback is only automatic on Linux; set AIWG_COCKPIT_LOCAL_LIBVIRT_FALLBACK=1 for explicit local development on this host.',
          runtime,
          platform: process.platform,
          arch: process.arch,
        },
      };
    }
    // For VM instances the agent_id doubles as the libvirt domain name
    // (agentic-sandbox provision-vm.sh registers agent_id = $vm_name).
    const domain = dockerName ?? inst?.name ?? String(instanceId);
    const target = `virsh qemu-agent-command ${domain} guest-exec pkill -HUP -x agent-client`;
    try {
      const exitcode = await signalVmAgentReconnect(domain);
      if (exitcode === 0) {
        return {
          target,
          status: 202,
          body: {
            id: instanceId,
            runtime,
            vm_domain: domain,
            state: 'reconnecting',
            message: `Reconnect requested for VM ${domain}; inventory will refresh as the agent re-registers. Sessions survive reconnect on agentic-sandbox 2026.7.8+ agents; older agents preserve only detached tmux sessions (agentic-sandbox#634).`,
            fallback: 'virsh-guest-agent-sighup',
          },
        };
      }
      return {
        target,
        status: 502,
        body: {
          error: 'reconnect_failed',
          message: `No running agent-client process found inside VM ${domain}. Restart the agent service in the guest (systemctl restart agent-client) or reprovision the VM.`,
          exitcode,
        },
      };
    } catch (err) {
      return {
        target,
        status: 502,
        body: {
          error: 'reconnect_failed',
          message: `Could not signal agent-client in VM ${domain} via qemu-guest-agent. The bridge host needs virsh access to the libvirt domain and the guest-agent channel must be up (agentic-sandbox#633).`,
          detail: bridgeErrorBody(err, 'reconnect_failed').message,
        },
      };
    }
  }

  return {
    target: `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(instanceId)}/reconnect`,
    status: 409,
    body: {
      error: 'reconnect_unavailable',
      message: 'Reconnect is available for Docker/container instances (docker exec) and VM instances (qemu-guest-agent). For host-runtime agents, signal the agent directly: pkill -HUP -x agent-client.',
      runtime: runtime || 'unknown',
    },
  };
}

function asArrayFromEnvelope(body, keys) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key];
  }
  if (body.data && typeof body.data === 'object') {
    for (const key of keys) {
      if (Array.isArray(body.data[key])) return body.data[key];
    }
  }
  return [];
}

const AGENT_ID_CACHE_TTL_MS = Number(process.env.AIWG_COCKPIT_AGENT_CACHE_TTL_MS ?? 5_000);
const agentListCache = new Map();

async function getAgentList(executorUrl) {
  const cached = agentListCache.get(executorUrl);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.agents;
  const { body } = await fetchJsonFirst([`${executorUrl}/api/v1/agents`]);
  const agents = asArrayFromEnvelope(body, ['agents', 'items', 'data']);
  agentListCache.set(executorUrl, { agents, expiresAt: now + AGENT_ID_CACHE_TTL_MS });
  return agents;
}

async function resolveSessionAgentId(executorUrl, instanceId) {
  try {
    const agents = await getAgentList(executorUrl);
    const agent = agents.find((a) => String(a.instance_id ?? a.instanceId ?? '') === String(instanceId));
    return agent?.id ?? agent?.agent_id ?? agent?.agentId ?? instanceId;
  } catch (err) {
    rethrowExecutorSecurityError(err);
    return instanceId;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultSshPublicKey() {
  const candidates = [
    join(homedir(), '.ssh', 'agentic_ed25519.pub'),
    join(homedir(), '.ssh', 'vm_ed25519.pub'),
    join(homedir(), '.ssh', 'id_ed25519.pub'),
    join(homedir(), '.ssh', 'id_rsa.pub'),
    join(homedir(), '.ssh', 'id_ecdsa.pub'),
  ];
  return candidates.find((path) => existsSync(path)) ?? '';
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function normalizeRuntimePosture(kind) {
  const runtime = String(kind || 'unknown').toLowerCase();
  if (runtime === 'host') return {
    kind: runtime,
    isolation: 'least',
    label: 'Host / full host access',
    warning: 'Least isolated tier: this agent runs with direct host access.',
  };
  if (runtime === 'container' || runtime === 'docker') return {
    kind: runtime,
    isolation: 'shared-kernel',
    label: 'Container / shared kernel',
    warning: 'Container isolation shares the host kernel.',
  };
  if (runtime === 'vm' || runtime === 'qemu' || runtime === 'kvm') return { kind: 'vm', isolation: 'strong', label: 'VM / hardware boundary' };
  if (runtime === 'unknown') return { kind: runtime, isolation: 'unknown', label: 'Unknown runtime', warning: 'Runtime metadata was not reported by the sandbox.' };
  return {
    kind: runtime,
    isolation: 'opaque',
    label: `${runtime} / opaque runtime`,
    warning: 'Future or unrecognized runtime kind; Cockpit is rendering it conservatively.',
  };
}

function normalizeHostDaemon(status, runtime) {
  const raw = status && typeof status === 'object' ? status : {};
  const value = String(raw.status ?? (runtime === 'host' ? 'unknown' : 'unavailable')).toLowerCase();
  const allowed = new Set(['detected', 'available', 'unavailable', 'permission_denied', 'degraded', 'stopped', 'unknown']);
  return {
    status: allowed.has(value) ? value : 'unknown',
    detail: raw.detail ?? (runtime === 'host' ? 'Host daemon status was not reported.' : 'Not applicable for this runtime tier.'),
    operator_command: raw.operator_command,
  };
}

function normalizeTransport(posture) {
  const raw = typeof posture === 'string' ? { mode: posture } : (posture && typeof posture === 'object' ? posture : {});
  const mode = String(raw.mode ?? 'unknown');
  const trust = String(raw.trust ?? raw.transport_posture ?? raw.posture ?? '').toLowerCase();
  const normalizedTrust = ['secure', 'local', 'compatibility', 'degraded', 'unknown'].includes(trust) ? trust : (
    /mtls|local-ca|client-cert/i.test(mode) ? 'secure' :
    /shared-secret|tofu|legacy/i.test(mode) ? 'compatibility' :
    /loopback|uds|vsock/i.test(mode) ? 'local' :
    'unknown'
  );
  const labels = {
    secure: 'Secure transport',
    local: 'Local transport',
    compatibility: 'Legacy compatibility',
    degraded: 'Degraded transport',
    unknown: 'Unknown transport',
  };
  return {
    mode,
    trust: normalizedTrust,
    label: labels[normalizedTrust],
    source: raw.source ?? 'agentic-sandbox metadata',
    evidence: raw.evidence,
    stale: Boolean(raw.stale),
  };
}

function safeRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref) return undefined;
  if (/-----BEGIN|PRIVATE KEY|TOKEN|SECRET|PASSWORD|[\r\n]/i.test(ref)) return '[redacted]';
  return ref.slice(0, 160);
}

function normalizeBootstrapTrustReadiness(body, executorUrl, { available = true } = {}) {
  const ca = body?.ca_provider && typeof body.ca_provider === 'object' ? body.ca_provider : {};
  const bootstrap = body?.bootstrap && typeof body.bootstrap === 'object' ? body.bootstrap : {};
  const status = String(body?.status ?? (available ? 'unknown' : 'disabled')).toLowerCase();
  const normalizedStatus = ['secure', 'degraded', 'disabled'].includes(status)
    ? status
    : (ca.configured === true || ca.available === true ? 'degraded' : 'disabled');
  const trustFresh = ca.trust_bundle_fresh ?? ca.trustBundleFresh ?? ca.fresh;
  const tokenStoreConfigured = bootstrap.token_store_configured ?? bootstrap.tokenStoreConfigured;
  const caConfigured = ca.configured ?? ca.available;
  const missing = [];
  if (caConfigured === false) missing.push('ca_provider');
  if (tokenStoreConfigured === false) missing.push('bootstrap_token_store');
  if (trustFresh === false) missing.push('fresh_trust_bundle');
  const plaintextDev = new URL(executorUrl).protocol === 'http:' && isLocalHostName(new URL(executorUrl).hostname);
  const recovery = normalizedStatus === 'secure'
    ? 'Sandbox CA and bootstrap trust are ready.'
    : normalizedStatus === 'degraded'
      ? 'Refresh sandbox CA/bootstrap readiness, rotate stale trust material, then reload Cockpit.'
      : plaintextDev
        ? 'Plaintext local development mode only; enable sandbox mTLS before using remote or shared executors.'
        : 'Configure sandbox CA provider and client trust refs before connecting Cockpit.';
  return {
    status: normalizedStatus,
    mode: normalizedStatus === 'secure' ? 'mtls' : (plaintextDev ? 'plaintext-dev' : 'disabled'),
    label: normalizedStatus === 'secure'
      ? 'Sandbox mTLS ready'
      : normalizedStatus === 'degraded'
        ? 'Sandbox trust degraded'
        : (plaintextDev ? 'Plaintext dev mode' : 'Sandbox trust disabled'),
    source: body?.source ?? '/api/v2/admin/bootstrap/readiness',
    ca_provider_ref: safeRef(ca.provider_ref ?? ca.providerRef ?? ca.provider ?? ca.id ?? ca.name),
    trust_bundle_ref: safeRef(ca.trust_bundle_ref ?? ca.trustBundleRef ?? ca.bundle_ref ?? ca.bundleRef),
    client_identity_ref: safeRef(ca.client_identity_ref ?? ca.clientIdentityRef ?? ca.identity_ref ?? ca.identityRef),
    rotation_state: safeRef(ca.rotation_state ?? ca.rotationState ?? ca.state),
    expires_at: safeRef(ca.expires_at ?? ca.expiresAt ?? ca.not_after ?? ca.notAfter),
    trust_bundle_fresh: trustFresh === undefined ? undefined : Boolean(trustFresh),
    token_store_configured: tokenStoreConfigured === undefined ? undefined : Boolean(tokenStoreConfigured),
    missing_required_material: missing,
    recovery,
  };
}

function assertRequiredBootstrapTrust(posture) {
  if (posture.status === 'secure' && posture.missing_required_material.length === 0) return;
  const err = executorAuthError(
    'executor_trust_required',
    `sandbox mTLS is required but bootstrap trust is ${posture.status}: ${posture.recovery}`,
  );
  err.upstreamStatus = 503;
  err.recovery = posture.recovery;
  throw err;
}

async function getBootstrapTrustPosture(executorUrl, { requireSandboxMtls = false } = {}) {
  try {
    const { target, body } = await fetchJsonFirst([
      `${executorUrl}/api/v2/admin/bootstrap/readiness`,
      `${executorUrl}/admin/bootstrap/readiness`,
    ]);
    const posture = normalizeBootstrapTrustReadiness({ ...body, source: new URL(target).pathname }, executorUrl);
    if (requireSandboxMtls) assertRequiredBootstrapTrust(posture);
    return posture;
  } catch (err) {
    rethrowExecutorSecurityError(err);
    const posture = normalizeBootstrapTrustReadiness({
      status: 'disabled',
      source: '/api/v2/admin/bootstrap/readiness',
      ca_provider: { configured: false },
      bootstrap: { token_store_configured: false },
    }, executorUrl, { available: false });
    if (requireSandboxMtls) assertRequiredBootstrapTrust(posture);
    return posture;
  }
}

function normalizeStoragePosture(posture) {
  const raw = posture && typeof posture === 'object' ? posture : {};
  return {
    persistent: Boolean(raw.persistent ?? raw.persists ?? raw.persistence === 'persistent'),
    delete_on_destroy: Boolean(raw.delete_on_destroy ?? raw.deleteOnDestroy),
    scope: raw.scope ?? raw.storage_scope ?? raw.storageScope,
    reason: raw.reason ?? raw.detail,
  };
}

function normalizeLifecycle(lifecycle) {
  const raw = lifecycle && typeof lifecycle === 'object' ? lifecycle : {};
  return {
    destroy: raw.destroy ?? raw.delete ?? raw.remove,
    reconnect: raw.reconnect,
    start: raw.start,
    stop: raw.stop,
  };
}

function normalizeSessionBackends(backends, runtimeKind, state = 'unknown', agentReady = false) {
  const list = Array.isArray(backends) ? backends : [];
  if (!list.length && runtimeKind === 'host') {
    return [{
      mode: 'managed',
      backend: 'tmux',
      observe: true,
      drive: true,
      replay: false,
      keyframe: false,
      available: agentReady,
      reason: agentReady
        ? 'agentic-sandbox v1 host session API default'
        : 'host runtime is provisioned but the host agent has not registered; PTY sessions are not ready',
    }];
  }
  if (!list.length && ['docker', 'container', 'vm', 'qemu', 'kvm'].includes(runtimeKind) && String(state).toLowerCase() === 'running') {
    return [{
      mode: 'managed',
      backend: 'tmux',
      observe: true,
      drive: true,
      replay: true,
      keyframe: true,
      available: agentReady,
      reason: agentReady ? 'agentic-sandbox v1 managed session API' : 'container is running but the agent has not registered; PTY sessions are not ready',
    }];
  }
  if (!list.length) return [{ mode: 'direct', backend: 'native', observe: true, drive: false, replay: false, keyframe: false, available: false, reason: 'sandbox did not advertise session-host capabilities' }];
  return list.map((b) => ({
    mode: b.mode === 'managed' ? 'managed' : 'direct',
    backend: String(b.backend || (b.mode === 'managed' ? 'tmux' : 'native')),
    replay: Boolean(b.replay),
    keyframe: Boolean(b.keyframe),
    drive: Boolean(b.drive),
    observe: b.observe !== false,
    available: b.available !== false,
    reason: b.reason,
  }));
}

function normalizeInstance(executorUrl, i) {
  const runtimeValue = i.runtime_kind ?? i.runtime?.kind ?? i.runtime ?? i.runtime_tier ?? i.isolation?.runtime ?? 'unknown';
  const runtime = String(runtimeValue);
  const runtimePosture = normalizeRuntimePosture(runtime);
  const id = i.instance_id ?? i.instanceId ?? i.agent_instance_id ?? i.id;
  const loadout = i.loadout ?? i.launch_context?.loadout ?? i.launchContext?.loadout ?? i.runtime_extension?.loadout ?? i.runtimeExtension?.loadout ?? 'unknown';
  const agentReady = Boolean(i.agent_ready ?? i.agentReady ?? i.registered_agent_id ?? i.registeredAgentId);
  return {
    id,
    runtime,
    provider: i.provider ?? i.runtime_provider ?? i.runtimeProvider ?? i.runtime?.provider,
    capabilities: Array.isArray(i.capabilities) ? i.capabilities : i.runtime?.capabilities,
    capability_constraints: i.capability_constraints ?? i.capabilityConstraints ?? i.runtime?.capability_constraints ?? i.runtime?.capabilityConstraints,
    gpu: i.gpu ?? i.gpu_posture ?? i.gpuPosture ?? i.runtime?.gpu,
    loadout,
    state: i.state ?? i.status ?? 'unknown',
    tenant: i.tenant_id ?? i.tenant ?? i.tenantId ?? 'default',
    card_url: i.card_url ?? i.cardUrl ?? `${executorUrl}/agents/${encodeURIComponent(id)}/.well-known/agent-card.json`,
    a2a_protocol: i.a2a_protocol ?? i.a2aProtocol,
    runtime_posture: runtimePosture,
    host_daemon: normalizeHostDaemon(i.host_daemon ?? i.hostDaemon, runtimePosture.kind),
    transport: normalizeTransport(
      typeof i.transport === 'string' || typeof i.transport_posture === 'string'
        ? { mode: i.transport, trust: i.transport_posture, source: 'agentic-sandbox admin-v2' }
        : i.transport ?? i.transport_posture ?? i.security_posture ?? i.security?.transport,
    ),
    managed_docker_posture: normalizeManagedDockerPosture(i, runtimePosture.kind),
    launch_context: {
      cwd: i.launch_context?.cwd ?? i.launchContext?.cwd ?? i.cwd,
      loadout,
      runtime_kind: i.launch_context?.runtime_kind ?? i.launchContext?.runtimeKind ?? runtime,
      host: i.launch_context?.host ?? i.launchContext?.host ?? i.host_metadata?.hostname ?? i.hostMetadata?.hostname,
      selected_tier: i.launch_context?.selected_tier ?? i.launchContext?.selectedTier ?? i.operator_selected_tier ?? i.operatorSelectedTier ?? runtime,
      name: i.name ?? i.launch_context?.name ?? i.launchContext?.name,
      image_ref: i.image_ref ?? i.imageRef ?? i.runtime_extension?.image_ref ?? i.runtimeExtension?.imageRef,
      source: i.runtime_extension ? 'agent-card runtime extension' : i.launch_context?.source ?? i.launchContext?.source,
    },
    storage: normalizeStoragePosture(i.storage ?? i.storage_posture ?? i.storagePosture ?? i.lifecycle?.storage),
    lifecycle: normalizeLifecycle(i.lifecycle ?? i.lifecycle_support ?? i.lifecycleSupport),
    agent_ready: agentReady,
    registered_agent_id: i.registered_agent_id ?? i.registeredAgentId,
    session_backends: normalizeSessionBackends(i.session_backends ?? i.sessionBackends ?? i.session_host?.backends ?? i.sessionHost?.backends ?? i.capabilities?.session_backends ?? i.capabilities?.sessionBackends, runtimePosture.kind, i.state ?? i.status, agentReady),
  };
}

const MANAGED_DOCKER_CONTROL_UID_MIN = 200_000;
const MANAGED_DOCKER_CONTROL_UID_MAX = 799_999;
const MANAGED_DOCKER_WORKLOAD_UID = 10_001;

/** Project only executor-attested, client-safe managed-Docker identity evidence. */
export function normalizeManagedDockerPosture(i, runtimeKind) {
  if (!['docker', 'container'].includes(String(runtimeKind).toLowerCase())) return undefined;
  const source = i.managed_docker_posture ?? i.managedDockerPosture ?? i.security_posture ?? i.securityPosture ?? i;
  const rawTransport = source.transport_mode ?? source.transportMode
    ?? (typeof source.transport === 'string' ? source.transport : source.transport?.mode)
    ?? (typeof i.transport === 'string' ? i.transport : i.transport?.mode)
    ?? 'unknown';
  const transportMode = String(rawTransport).toLowerCase();
  const rawControlUid = source.control_uid ?? source.controlUid;
  const controlUid = Number.isInteger(Number(rawControlUid)) ? Number(rawControlUid) : undefined;
  const rawWorkloadUid = source.workload_uid ?? source.workloadUid;
  const workloadUid = Number.isInteger(Number(rawWorkloadUid)) ? Number(rawWorkloadUid) : undefined;
  const boundary = String(source.workload_boundary ?? source.workloadBoundary ?? source.boundary ?? 'unknown').toLowerCase();
  const reportedFallback = String(source.fallback_reason_code ?? source.fallbackReasonCode ?? source.fallback_reason ?? source.fallbackReason ?? '').toLowerCase();
  const fallbackReason = transportMode === 'mtls-bootstrap' || reportedFallback === 'docker_desktop_peer_uid_unavailable'
    ? 'Docker Desktop UDS bridge does not preserve peer UID'
    : reportedFallback === 'identity_resolver_unavailable'
      ? 'Managed UDS identity resolver unavailable'
      : ['operator-configured', 'explicit', 'mtls'].includes(transportMode)
        ? 'Operator-configured compatibility transport'
        : undefined;
  const controlIdentityPresent = controlUid !== undefined;
  const controlIdentityRangeValid = controlIdentityPresent
    && controlUid >= MANAGED_DOCKER_CONTROL_UID_MIN
    && controlUid <= MANAGED_DOCKER_CONTROL_UID_MAX;
  const workloadIdentitySeparated = boundary === 'separated' && workloadUid === MANAGED_DOCKER_WORKLOAD_UID;
  const secureDefault = transportMode === 'uds' && controlIdentityRangeValid && workloadIdentitySeparated;
  const compatibility = transportMode !== 'uds';
  const requiresRecreation = !controlIdentityPresent || !workloadUid || boundary === 'unknown';
  return {
    transport_mode: transportMode,
    control_identity_present: controlIdentityPresent,
    control_identity_range_valid: controlIdentityRangeValid,
    workload_uid: workloadUid,
    workload_identity_separated: workloadIdentitySeparated,
    boundary,
    secure_default: secureDefault,
    compatibility,
    fallback_reason: fallbackReason ? String(fallbackReason).slice(0, 300) : undefined,
    requires_recreation: requiresRecreation,
    source: 'agentic-sandbox',
  };
}

const ACTIVITY_SCOPE_HEADERS = {
  tenant_id: 'x-agentic-tenant-id', host_id: 'x-agentic-host-id',
  instance_id: 'x-agentic-instance-id', agent_id: 'x-agentic-agent-id',
};
const ACTIVITY_FILTERS = new Set(['event_name', 'collector', 'trust', 'plane', 'outcome', 'session_id', 'mission_id', 'task_id', 'tool_call_id', 'command_id', 'process_id', 'trace_id', 'since', 'until', 'limit']);

export function activityRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('activity request must be an object'), { code: 'activity_invalid_request' });
  const headers = { 'accept': 'application/json' };
  const scope = {};
  for (const [key, header] of Object.entries(ACTIVITY_SCOPE_HEADERS)) {
    const value = String(input[key] ?? '').trim();
    if (!value || value.length > 255 || /[\r\n]/.test(value)) throw Object.assign(new Error(`missing or invalid ${key}`), { code: 'activity_scope_required' });
    headers[header] = value;
    scope[key] = value;
  }
  const filter = {};
  for (const [key, value] of Object.entries(input.filter ?? {})) {
    if (!ACTIVITY_FILTERS.has(key)) throw Object.assign(new Error(`unsupported activity filter: ${key}`), { code: 'activity_invalid_filter' });
    if (key === 'limit') {
      if (!Number.isInteger(value) || value < 1 || value > 1000) throw Object.assign(new Error('activity limit must be 1..1000'), { code: 'activity_invalid_filter' });
      filter[key] = value;
    } else if (typeof value === 'string' && value.trim() && value.length <= 255 && !/[\r\n]/.test(value)) filter[key] = value.trim();
    else throw Object.assign(new Error(`invalid activity filter: ${key}`), { code: 'activity_invalid_filter' });
  }
  return { headers, scope, filter };
}

export function validateActivityEnvelope(body, expectedScope, { includeEvents = false, exportEnvelope = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('malformed activity envelope'), { code: 'activity_malformed_envelope' });
  if (!exportEnvelope && body.schema_version !== 'activity.event/v1') throw Object.assign(new Error('unsupported activity schema'), { code: 'activity_malformed_envelope' });
  const events = Array.isArray(body.events) ? body.events : [];
  if (includeEvents && !Array.isArray(body.events)) throw Object.assign(new Error('activity envelope has no events array'), { code: 'activity_malformed_envelope' });
  if (!exportEnvelope && (!Array.isArray(body.coverage) || !body.completeness || typeof body.completeness.complete !== 'boolean')) {
    throw Object.assign(new Error('activity envelope has invalid coverage'), { code: 'activity_malformed_envelope' });
  }
  const nonnegativeInteger = (value) => Number.isInteger(value) && value >= 0;
  const nonnegativeFinite = (value) => Number.isFinite(value) && value >= 0;
  const validCompleteness = (value) => value
    && typeof value.label === 'string'
    && nonnegativeInteger(value.collector_count)
    && nonnegativeInteger(value.sequence_gap_count)
    && nonnegativeInteger(value.durable_loss_count)
    && nonnegativeInteger(value.restart_count)
    && nonnegativeInteger(value.dropped_event_count)
    && nonnegativeInteger(value.stale_collector_count)
    && Array.isArray(value.unsupported_event_classes)
    && value.unsupported_event_classes.every((item) => typeof item === 'string')
    && nonnegativeFinite(value.maximum_clock_error_ms);
  if (!exportEnvelope && !validCompleteness(body.completeness)) {
    throw Object.assign(new Error('activity envelope has malformed completeness summary'), { code: 'activity_malformed_envelope' });
  }
  if (!exportEnvelope && body.coverage.some((entry) => !entry || typeof entry.collector_id !== 'string' || !Array.isArray(entry.sequence_gaps) || !Array.isArray(entry.durable_loss_records) || !nonnegativeInteger(entry.restart_count) || !nonnegativeInteger(entry.dropped_event_count) || typeof entry.stale !== 'boolean' || !Array.isArray(entry.unsupported_event_classes) || !entry.unsupported_event_classes.every((item) => typeof item === 'string') || !nonnegativeFinite(entry.maximum_clock_error_ms))) {
    throw Object.assign(new Error('activity envelope has malformed collector coverage'), { code: 'activity_malformed_envelope' });
  }
  for (const event of events) {
    assertActivityEvent(event, expectedScope);
  }
  const manifest = body.manifest;
  if (exportEnvelope && (!manifest
    || typeof manifest.batch_id !== 'string' || !manifest.batch_id
    || manifest.tenant_id !== expectedScope.tenant_id
    || typeof manifest.collector_id !== 'string' || !manifest.collector_id
    || !Number.isInteger(manifest.event_count) || manifest.event_count < 0
    || !/^[0-9a-f]{64}$/.test(manifest.merkle_root ?? '')
    || typeof manifest.key_id !== 'string' || !manifest.key_id
    || typeof manifest.signature !== 'string' || !manifest.signature
    || (manifest.previous_root !== null && manifest.previous_root !== undefined && !/^[0-9a-f]{64}$/.test(manifest.previous_root)))) {
    throw Object.assign(new Error('signed activity export has no valid manifest'), { code: 'activity_malformed_export' });
  }
  return body;
}

async function activityProxy(executorUrl, kind, input) {
  const request = activityRequest(input);
  const isExport = kind === 'export';
  const query = new URLSearchParams(Object.entries(request.filter).map(([key, value]) => [key, String(value)]));
  const target = `${executorUrl}/api/v2/activity/${kind}${!isExport && query.size ? `?${query}` : ''}`;
  const result = await fetchJsonFirst([{ target, method: isExport ? 'POST' : 'GET', headers: { ...request.headers, ...(isExport ? { 'content-type': 'application/json' } : {}) }, body: isExport ? JSON.stringify(request.filter) : undefined }]);
  if (!result.status.toString().startsWith('2')) return result;
  return { ...result, body: validateActivityEnvelope(result.body, request.scope, { includeEvents: kind === 'timeline' || isExport, exportEnvelope: isExport }) };
}

function managedDockerLaunchError(status, body) {
  const detail = String(body?.message ?? body?.error?.message ?? body?.error ?? body?.failure?.message ?? '');
  if (/refuses startup profiles that materialize raw credential refs/i.test(detail)) return {
    status: status >= 400 ? status : 422,
    body: {
      error: 'managed_docker_raw_credentials_rejected',
      message: 'Managed Docker does not accept startup profiles with raw credential references.',
      recovery: 'Use the sandbox credential proxy or select a VM runtime. Cockpit will not downgrade the transport automatically.',
    },
  };
  return { status, body };
}

function defaultSessionLaunch(instance) {
  const runtime = String(instance?.runtime_posture?.kind ?? instance?.runtime ?? '').toLowerCase();
  if (runtime === 'host') {
    // Honor the executor-reported cwd — it is valid on the target host, including
    // remote worker hosts whose filesystem does not mirror the Bridge machine.
    // Fall back to the operator home only when the executor reports no cwd;
    // hardcoding homedir() would resolve the Bridge's local home and break
    // sessions on any host runtime that is not the Bridge machine itself.
    return {
      command: 'bash',
      args: ['-l'],
      working_dir: instance?.launch_context?.cwd ?? homedir(),
    };
  }
  if (runtime === 'container' || runtime === 'docker' || runtime === 'vm' || runtime === 'qemu' || runtime === 'kvm') {
    // Prefer the executor-reported target-local cwd. Current agentic-sandbox
    // container and VM contracts report `/home/agent`; retain that value as a
    // compatibility fallback for older inventory responses. `/root` is not
    // readable by the mandatory uid 10001 container identity.
    const home = instance?.launch_context?.cwd ?? '/home/agent';
    return {
      command: '/bin/bash',
      args: ['-lc', `cd ${shellSingleQuote(home)} && exec /bin/bash -l`],
      working_dir: home,
    };
  }
  return {
    command: 'bash',
    args: ['-l'],
  };
}

// Deterministic prefix + per-request nonce. The name is IDENTICAL across this
// request's fallback candidates (so a timed-out-but-created session is
// recoverable by name, and the executor's 409-by-name guard dedupes candidate
// retries) but UNIQUE across requests — operators can hold multiple concurrent
// sessions per (instance, mode, backend). A fully canonical name here silently
// reused the first session on every subsequent "New session" click.
function sessionNameFor(instanceId, { mode = 'managed', backend = 'tmux' } = {}) {
  const slug = (value) => String(value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'default';
  return `cockpit-${slug(instanceId)}-${slug(mode)}-${slug(backend)}-${randomBytes(3).toString('hex')}`;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runtimeExtensionFromCard(card) {
  const extensions = card?.capabilities?.extensions;
  if (!Array.isArray(extensions)) return null;
  const ext = extensions.find((e) => String(e?.uri ?? '').includes('/extensions/runtime/'));
  return ext?.params && typeof ext.params === 'object' ? ext.params : null;
}

function cockpitA2ASettings() {
  const context = executorRequestContext.getStore();
  return {
    policy: context?.a2aProtocolPolicy ?? COCKPIT_A2A_PROTOCOL_POLICY,
    allowFallback: context?.allowA2AProtocolFallback ?? COCKPIT_A2A_PROTOCOL_FALLBACK,
  };
}

/** Normalize and select the ordered AgentCard interface Cockpit will use. */
export function selectCockpitA2AInterface(card, policy = '0.3') {
  if (!['0.3', '1.0', 'auto'].includes(policy)) {
    throw new Error(`invalid Cockpit A2A protocol policy: ${policy}`);
  }
  const normalizeVersion = (value) => {
    const match = /^(0\.3|1\.0)(?:\.\d+)?$/.exec(String(value ?? '').trim());
    return match?.[1] ?? null;
  };
  const topVersion = normalizeVersion(card?.protocolVersion);
  const interfaces = [];
  for (const [preference, entry] of (Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : []).entries()) {
    const version = normalizeVersion(entry?.protocolVersion) ?? topVersion;
    const binding = entry?.protocolBinding ?? entry?.transport;
    if (!version || !binding || typeof entry?.url !== 'string') continue;
    interfaces.push({
      url: entry.url.replace(/\/+$/, ''),
      protocol_version: version,
      protocol_binding: String(binding),
      preference,
    });
  }
  if (topVersion === '0.3' && typeof card?.url === 'string' && !interfaces.some((entry) => entry.protocol_version === '0.3')) {
    interfaces.push({
      url: card.url.replace(/\/+$/, ''),
      protocol_version: '0.3',
      protocol_binding: String(card.preferredTransport ?? 'REST'),
      preference: interfaces.length,
    });
  }
  const versions = policy === 'auto' ? ['1.0', '0.3'] : [policy];
  for (const version of versions) {
    const selected = interfaces
      .filter((entry) => entry.protocol_version === version)
      .sort((a, b) => a.preference - b.preference)[0];
    if (selected) return { policy, ...selected };
  }
  throw new Error(`AgentCard has no interface compatible with Cockpit A2A policy ${policy}`);
}

async function discoverCockpitA2AInterface(executorUrl, instanceId) {
  const { body: card } = await fetchJsonFirst([
    `${executorUrl}/agents/${encodeURIComponent(instanceId)}/.well-known/agent-card.json`,
  ]);
  return { card, selected: allowedCockpitA2AInterface(executorUrl, instanceId, selectCockpitA2AInterface(card, cockpitA2ASettings().policy)) };
}

function allowedCockpitA2AInterface(executorUrl, instanceId, selected) {
  const target = allowedExecutorTarget(selected.url, executorUrl);
  const paths = [`/agents/${encodeURIComponent(instanceId)}`, `/api/v1/agents/${encodeURIComponent(instanceId)}`];
  if (!paths.includes(target.pathname.replace(/\/+$/, '')) || target.search || target.hash) {
    throw executorAuthError('executor_target_refused', 'AgentCard interface is outside the requested agent endpoint');
  }
  // Reconstruct from trusted configuration and the validated agent path.
  return { ...selected, url: `${parseExecutorUrl(executorUrl).origin}${target.pathname.replace(/\/+$/, '')}` };
}

function cockpitA2AHeaders(version, mutating = false) {
  const mediaType = version === '1.0' ? 'application/a2a+json' : 'application/json';
  return {
    accept: mediaType,
    ...(mutating ? { 'content-type': mediaType } : {}),
    ...(version === '1.0' ? { 'a2a-version': '1.0' } : {}),
  };
}

function isA2AVersionNotSupported(status, body) {
  const type = String(body?.type ?? '').toLowerCase();
  const code = String(body?.code ?? body?.error?.code ?? '').toLowerCase();
  return status === 400 && (
    type.includes('version-not-supported') ||
    ['versionnotsupportederror', 'version_not_supported', 'a2a.version_not_supported', '-32009'].includes(code)
  );
}

async function negotiatedCockpitA2ARequest(executorUrl, instanceId, candidatesFor) {
  const settings = cockpitA2ASettings();
  let card;
  let selected;
  try {
    ({ card, selected } = await discoverCockpitA2AInterface(executorUrl, instanceId));
  } catch (error) {
    rethrowExecutorSecurityError(error);
    if (error?.code === 'executor_target_refused') bridgeErrorBody(error);
    // Pre-AgentCard executors remain supported only under the explicit legacy
    // policy. Auto and 1.0 must negotiate from advertised interfaces.
    if (settings.policy !== '0.3') throw error;
    selected = {
      policy: '0.3',
      url: `${executorUrl}/agents/${encodeURIComponent(instanceId)}`,
      protocol_version: '0.3',
      protocol_binding: 'REST',
      preference: 0,
    };
  }
  let result = await fetchJsonFirst(candidatesFor(selected));
  let active = selected;
  let fallbackReason;
  if (
    selected.protocol_version === '1.0' &&
    settings.policy === 'auto' &&
    settings.allowFallback &&
    isA2AVersionNotSupported(result.status, result.body)
  ) {
    active = allowedCockpitA2AInterface(executorUrl, instanceId, selectCockpitA2AInterface(card, '0.3'));
    fallbackReason = `${result.body?.type ?? result.body?.code ?? 'VersionNotSupportedError'}`;
    result = await fetchJsonFirst(candidatesFor(active));
  }
  return { ...result, selected: active, fallbackReason };
}

async function enrichInstanceFromAgentCard(executorUrl, instance) {
  const id = instance.instance_id ?? instance.instanceId ?? instance.id;
  if (!id) return instance;
  try {
    const { body } = await fetchJsonFirst([
      `${executorUrl}/agents/${encodeURIComponent(id)}/.well-known/agent-card.json`,
    ]);
    const runtimeExtension = runtimeExtensionFromCard(body);
    const selected = selectCockpitA2AInterface(body, cockpitA2ASettings().policy);
    return {
      ...instance,
      a2a_protocol: {
        policy: selected.policy,
        selected_version: selected.protocol_version,
        protocol_binding: selected.protocol_binding,
        interface_url: selected.url,
      },
      ...(runtimeExtension ? {
        runtime_extension: runtimeExtension,
        loadout: instance.loadout ?? runtimeExtension.loadout,
        image_ref: instance.image_ref ?? runtimeExtension.image_ref,
      } : {}),
    };
  } catch (err) {
    rethrowExecutorSecurityError(err);
    return instance;
  }
}

async function getRegisteredAgents(executorUrl) {
  try {
    return await getAgentList(executorUrl);
  } catch (err) {
    rethrowExecutorSecurityError(err);
    return [];
  }
}

function enrichInstanceFromAgentRegistry(instance, agents) {
  const id = instance.instance_id ?? instance.instanceId ?? instance.id;
  const agent = agents.find((a) => String(a.instance_id ?? a.instanceId ?? '') === String(id));
  if (!agent) return { ...instance, agent_ready: false };
  return {
    ...instance,
    agent_ready: true,
    registered_agent_id: agent.id ?? agent.agent_id ?? agent.agentId,
  };
}

function normalizeAgentInstance(executorUrl, agent) {
  const id = agent.instance_id ?? agent.instanceId ?? agent.id ?? agent.agent_id ?? agent.agentId;
  return normalizeInstance(executorUrl, {
    id,
    instance_id: id,
    runtime: 'host',
    loadout: agent.loadout ?? 'host-tools',
    state: 'running',
    tenant: agent.tenant_id ?? agent.tenantId ?? 'default',
    transport: {
      mode: agent.transport?.mode ?? 'mtls-agent-registration',
      trust: agent.transport?.trust ?? 'secure',
      source: 'agent registry fallback',
      evidence: agent.peer_identity ?? agent.spiffe_id ?? agent.spiffeId,
    },
    host_daemon: {
      status: 'available',
      detail: `Registered host agent ${agent.id ?? agent.agent_id ?? agent.agentId ?? id}`,
    },
    launch_context: {
      loadout: agent.loadout ?? 'host-tools',
      runtime_kind: 'host',
      host: agent.hostname,
      selected_tier: 'host',
    },
    session_backends: agent.session_backends ?? agent.sessionBackends ?? [
      { mode: 'managed', backend: 'tmux', observe: true, drive: true, replay: false, keyframe: false, available: true, reason: 'agent registry fallback' },
    ],
  });
}

async function getAgentBackedHostInventory(executorUrl, degradedDetail) {
  const { target, body } = await fetchJsonFirst([`${executorUrl}/api/v1/agents`]);
  const agents = asArrayFromEnvelope(body, ['agents', 'items', 'data']);
  const instances = agents
    .filter((agent) => agent.instance_id || agent.instanceId || agent.id || agent.agent_id || agent.agentId)
    .map((agent) => normalizeAgentInstance(executorUrl, agent));
  return {
    source: executorUrl,
    admin_path: new URL(target).pathname,
    fetched_at: new Date().toISOString(),
    count: instances.length,
    degraded_admin_inventory: degradedDetail,
    instances,
  };
}

/** Normalize the executor's admin inventory into the Bridge's UI shape. */
async function getInventory(executorUrl, { requireSandboxMtls = false } = {}) {
  const bootstrapTrust = await getBootstrapTrustPosture(executorUrl, { requireSandboxMtls });
  const { target, status, body } = await fetchJsonFirst([
    `${executorUrl}/admin/instances`,
    `${executorUrl}/api/v2/admin/instances`,
  ]);
  const instances = asArrayFromEnvelope(body, ['instances', 'items', 'data']);
  if (status >= 400 || !instances.length) {
    const detail = status >= 400 ? `${new URL(target).pathname} returned ${status}` : `${new URL(target).pathname} returned no instances`;
    try {
      const fallback = await getAgentBackedHostInventory(executorUrl, detail);
      if (fallback.instances.length) return fallback;
    } catch {
      // Preserve the admin inventory result when no agent-backed fallback is available.
    }
    if (status >= 400) {
      return {
        source: executorUrl,
        admin_path: new URL(target).pathname,
        fetched_at: new Date().toISOString(),
        count: 0,
        degraded_admin_inventory: detail,
        admin_error: body,
        bootstrap_trust: bootstrapTrust,
        instances: [],
      };
    }
  }
  const agents = await getRegisteredAgents(executorUrl);
  const enriched = await Promise.all(instances.map((i) => enrichInstanceFromAgentCard(executorUrl, i)));
  const normalized = enriched
    .map((i) => enrichInstanceFromAgentRegistry(i, agents))
    .map((i) => normalizeInstance(executorUrl, i));
  return {
    source: executorUrl,
    admin_path: new URL(target).pathname,
    fetched_at: new Date().toISOString(),
    count: normalized.length,
    bootstrap_trust: bootstrapTrust,
    degraded_providers: body?.degraded_providers,
    instances: normalized,
  };
}

// --- task derivation (#1639) -------------------------------------------------
// The real agentic-sandbox v2 admin surface has NO /running or /approvals route.
// The running board and the approval inbox are derived from the real A2A task
// surface (`/agents/{agentId}/tasks`) per instance — not from the mock's invented
// /admin/running. A2A task lifecycle states: submitted/working/input-required are
// active; completed/canceled/failed/rejected are terminal.
const ACTIVE_TASK_STATES = new Set(['submitted', 'working', 'input-required', 'in_progress', 'running']);
const V1_TASK_STATES = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_AUTH_REQUIRED: 'auth-required',
};
const normalizeTaskState = (value) => V1_TASK_STATES[value] ?? value ?? 'unknown';
const taskState = (t) => normalizeTaskState(t.status?.state ?? t.state ?? (typeof t.status === 'string' ? t.status : 'unknown'));
const taskIdOf = (t) => t.id ?? t.task_id ?? t.taskId;
const taskTenantOf = (t) => t.metadata?.tenant_id ?? t.metadata?.tenantId ?? t.tenant ?? t.tenant_id ?? t.tenantId ?? 'default';

function normalizeCockpitA2ATask(task) {
  if (!task || typeof task !== 'object' || !task.id || !task.status || typeof task.status !== 'object') return task;
  return { ...task, status: { ...task.status, state: normalizeTaskState(task.status.state) } };
}

function normalizeCockpitA2ATaskResponse(body) {
  const candidate = body?.task && typeof body.task === 'object' ? body.task : body;
  return normalizeCockpitA2ATask(candidate);
}

/** Active tasks for one instance via the A2A task surface (#1639). The session
 *  agent id (not the instance id) keys the agent routes on real executors. */
async function listInstanceTasks(executorUrl, instanceId) {
  const agentId = await resolveSessionAgentId(executorUrl, instanceId);
  const settings = cockpitA2ASettings();
  try {
    const result = await negotiatedCockpitA2ARequest(executorUrl, agentId, (selected) => {
      const headers = cockpitA2AHeaders(selected.protocol_version);
      return selected.protocol_version === '1.0'
        ? [{ target: `${selected.url}/tasks`, headers }]
        : [
            { target: `${selected.url}/v1/tasks`, headers },
            { target: `${selected.url}/tasks`, headers },
          ];
    });
    if (result.status >= 400) {
      throw new Error(`A2A ${result.selected.protocol_version} task list failed with HTTP ${result.status}`);
    }
    return asArrayFromEnvelope(result.body, ['tasks', 'items', 'data']).map(normalizeCockpitA2ATask);
  } catch (error) {
    rethrowExecutorSecurityError(error);
    if (settings.policy !== '0.3') throw error;
    const candidates = unique([instanceId, agentId]).flatMap((id) => [
      `${executorUrl}/agents/${encodeURIComponent(id)}/tasks`,
      `${executorUrl}/api/v1/agents/${encodeURIComponent(id)}/tasks`,
    ]);
    const { body } = await fetchJsonFirst(candidates);
    return asArrayFromEnvelope(body, ['tasks', 'items', 'data']).map(normalizeCockpitA2ATask);
  }
}

/** Running board derived from active A2A tasks across running instances (#1639).
 *  An instance with no reachable task surface contributes nothing rather than
 *  failing the whole board (so a real executor stays usable). */
// Loadout catalog passthrough (#1641). The real executor exposes GET /api/v1/loadouts
// (and v2 /loadouts); the mock mirrors it under /admin/loadouts. Normalized to a flat
// {id,label,description,runtimes} list so the start-session picker can offer the full set
// (vs. only echoing the instance's own loadout field).
async function getLoadouts(executorUrl) {
  const { target, body } = await fetchJsonFirst([
    `${executorUrl}/api/v1/loadouts`,
    `${executorUrl}/api/v2/loadouts`,
    `${executorUrl}/loadouts`,
    `${executorUrl}/admin/loadouts`,
  ]);
  const raw = asArrayFromEnvelope(body, ['loadouts', 'items', 'data']);
  const loadouts = raw.map((l) => {
    if (typeof l === 'string') return { id: l, label: l };
    const id = l.id ?? l.name ?? l.loadout ?? l.slug;
    return {
      id,
      label: l.label ?? l.display_name ?? l.displayName ?? id,
      description: l.description ?? l.summary,
      runtimes: l.runtimes ?? l.runtime_kinds ?? l.supported_runtimes,
      runtime_options: l.runtime_options ?? l.runtimeOptions,
      compatibility: l.compatibility,
    };
  }).filter((l) => l.id);
  return { source: executorUrl, loadouts_path: new URL(target).pathname, count: loadouts.length, loadouts };
}

async function getRunning(executorUrl) {
  const instances = (await getInventory(executorUrl)).instances;
  const running = [];
  await Promise.all(
    instances.filter((i) => i.state === 'running').map(async (inst) => {
      let tasks;
      try { tasks = await listInstanceTasks(executorUrl, inst.id); } catch (err) { rethrowExecutorSecurityError(err); return; }
      for (const t of tasks) {
        const state = taskState(t);
        if (!ACTIVE_TASK_STATES.has(state)) continue;
        running.push({
          instance_id: inst.id,
          task_id: taskIdOf(t),
          state,
          tenant: taskTenantOf(t),
          runtime_posture: inst.runtime_posture,
          transport: inst.transport,
        });
      }
    }),
  );
  return {
    source: executorUrl,
    fetched_at: new Date().toISOString(),
    count: running.length,
    running,
    derived: 'per-instance A2A tasks',
  };
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => p?.text ?? p?.content ?? p?.value ?? '')
    .filter((p) => typeof p === 'string' && p.trim())
    .join('\n');
}

function approvalPromptFromTask(task) {
  const meta = task.metadata ?? {};
  const status = typeof task.status === 'object' ? task.status : {};
  const prompt = [
    meta.hitl_prompt?.prompt,
    meta.hitlPrompt?.prompt,
    meta.approval?.prompt,
    meta.prompt,
    status.message,
    status.prompt,
    textFromParts(task.artifacts?.flatMap((a) => a.parts ?? [])),
    textFromParts(task.history?.at?.(-1)?.parts),
  ].find((v) => typeof v === 'string' && v.trim());
  return String(prompt || 'Human input required');
}

function approvalFromTask(instance, task) {
  const state = taskState(task);
  const meta = task.metadata ?? {};
  const hasHitlPrompt = meta.hitl_prompt || meta.hitlPrompt || meta.approval || meta['hitl-prompt/v1'];
  if (state !== 'input-required' && !hasHitlPrompt) return null;
  const taskId = taskIdOf(task);
  if (!taskId) return null;
  return {
    id: `${instance.id}::${taskId}`,
    instance_id: instance.id,
    task_id: taskId,
    prompt: approvalPromptFromTask(task),
    risk: meta.risk ?? meta.approval?.risk ?? meta.hitl_prompt?.risk ?? 'unknown',
    created_at: task.created_at ?? task.createdAt ?? task.status?.timestamp ?? task.metadata?.created_at,
    status: state === 'input-required' ? 'pending' : state,
    tenant: taskTenantOf(task),
    derived: 'a2a input-required task',
  };
}

/**
 * Pending HITL approvals (the unified approval inbox) derived from real A2A
 * `input-required` / `hitl-prompt/v1` task surfaces. The real agentic-sandbox
 * v2 admin router has no approvals queue, so this deliberately does not probe
 * `/admin/approvals`.
 */
async function getApprovals(executorUrl, status) {
  const instances = (await getInventory(executorUrl)).instances;
  const approvals = [];
  await Promise.all(
    instances.filter((i) => i.state === 'running').map(async (inst) => {
      let tasks;
      try { tasks = await listInstanceTasks(executorUrl, inst.id); } catch (err) { rethrowExecutorSecurityError(err); return; }
      for (const t of tasks) {
        const approval = approvalFromTask(inst, t);
        if (!approval) continue;
        if (status && status !== 'all' && approval.status !== status) continue;
        approvals.push(approval);
      }
    }),
  );
  return {
    source: executorUrl,
    fetched_at: new Date().toISOString(),
    approvals,
    derived: 'per-instance A2A input-required tasks',
  };
}

const TERMINAL_MISSION_STATES = new Set(['done', 'completed', 'complete', 'failed', 'incomplete', 'aborted', 'canceled', 'cancelled', 'rejected']);

function normalizeMissionStatus(status) {
  const value = String(status ?? 'unknown').toLowerCase();
  if (value === 'done' || value === 'complete') return 'completed';
  if (value === 'cancelled' || value === 'canceled') return 'aborted';
  if (['queued', 'running', 'paused', 'completed', 'failed', 'aborted', 'input-required', 'awaiting-approval', 'unknown'].includes(value)) return value;
  return value;
}

function assertNoWorkerMissionBinding(value) {
  const seen = new Set();
  const seenRecords = new Set();
  function extensions(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || seen.has(item)) return;
    seen.add(item);
    if (Object.hasOwn(item, 'aiwg.worker-dispatch')) {
      throw Object.assign(new Error('OG_CONTRACT_UNSUPPORTED: Cockpit projection does not advertise worker contract support.'), { code: 'OG_CONTRACT_UNSUPPORTED' });
    }
    for (const [key, child] of Object.entries(item)) if (key.startsWith('aiwg.source.')) {
      extensions(child);
      record(child);
    }
  }
  function record(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || seenRecords.has(item)) return;
    seenRecords.add(item);
    // Every mission-v1 carrier, plus native protocol metadata/artifacts.
    extensions(item.extensions);
    extensions(item.metadata);
    if (Array.isArray(item.status?.artifacts)) item.status.artifacts.forEach(record);
    if (Array.isArray(item.artifacts)) item.artifacts.forEach(record);
  }
  record(value);
}

export function missionSummary(mission) {
  assertNoWorkerMissionBinding(mission);
  const canonical = mission?.apiVersion === 'mission.aiwg.io/v1' && mission?.kind === 'Mission';
  const canonicalStatus = canonical ? mission.status ?? {} : {};
  const canonicalMetadata = canonical ? mission.metadata ?? {} : {};
  const canonicalSpec = canonical ? mission.spec ?? {} : {};
  const canonicalProvenance = canonical ? mission.provenance ?? {} : {};
  const uhp = canonical ? mission.extensions?.['aiwg.source.uhp-2026-08-11'] ?? {} : {};
  const status = normalizeMissionStatus(canonical ? canonicalStatus.state : mission.status);
  return {
    id: String(canonicalMetadata.id ?? mission.id ?? mission.mission_id ?? mission.missionId ?? ''),
    title: canonicalSpec.objective ?? mission.objective ?? mission.goal ?? mission.task ?? mission.title ?? 'Untitled mission',
    completion: canonicalSpec.completionCriterion ?? mission.completion ?? mission.completionCriterion ?? mission.completion_criterion,
    status,
    loop: mission.loop ?? mission.iteration ?? mission.currentIteration ?? 0,
    max_iterations: mission.maxIterations ?? mission.max_iterations ?? mission.maxIterations ?? 0,
    priority: mission.priority ?? 'normal',
    mode: mission.mode ?? 'direct',
    target_agent: mission.targetAgent ?? mission.target_agent,
    ralph_loop_id: mission.ralphLoopId ?? mission.ralph_loop_id,
    ralph_pid: mission.ralphPid ?? mission.ralph_pid,
    started_at: canonicalMetadata.createdAt ?? mission.startedAt ?? mission.started_at,
    completed_at: canonicalStatus.terminal ? canonicalMetadata.updatedAt : mission.completedAt ?? mission.completed_at,
    error: canonicalStatus.error?.message ?? mission.error,
    terminal: canonical ? canonicalStatus.terminal === true : TERMINAL_MISSION_STATES.has(status),
    ...(canonical ? {
      canonical_version: mission.apiVersion,
      native_state: canonicalStatus.nativeState,
      transport: canonicalProvenance.transport,
      protocol_version: canonicalProvenance.sourceVersion,
      endpoint_profile: uhp.endpointProfile,
      response_id: uhp.responseId,
      remote_session_id: uhp.sessionId,
      artifacts: canonicalStatus.artifacts,
    } : {}),
    ...(graphMissionProjection(mission) ?? {}),
  };
}

function graphMissionProjection(mission) {
  const graph = mission.graph ?? mission.graph_metadata;
  if (!graph || typeof graph !== 'object' || !graph.graphId || !graph.runId) return null;
  const nodes = Array.isArray(mission.graphNodes ?? mission.graph_nodes)
    ? (mission.graphNodes ?? mission.graph_nodes).map((node) => ({
      node_id: node.nodeId ?? node.node_id,
      node_run_id: node.nodeRunId ?? node.node_run_id,
      state: node.state ?? node.nodeState ?? 'unknown',
      runtime_binding: node.runtimeBinding ?? node.runtime_binding ?? 'unknown',
      route_reason: node.routeReason ?? node.route_reason,
      evidence_summary: node.evidenceSummary ?? node.evidence_summary,
      hitl_status: node.hitlStatus ?? node.hitl_status,
      cost_usd: Number(node.costUsd ?? node.cost_usd ?? 0),
      tokens: Number(node.tokens ?? 0),
      duration_ms: Number(node.durationMs ?? node.duration_ms ?? 0),
      retry_count: Number(node.retryCount ?? node.retry_count ?? 0),
      budget_remaining: node.budgetRemaining ?? node.budget_remaining,
      checkpoint_id: node.checkpointId ?? node.checkpoint_id,
      replay_of_node_run_id: node.replayOfNodeRunId ?? node.replay_of_node_run_id,
      artifacts: Array.isArray(node.artifacts) ? node.artifacts : [],
    })) : [];
  return {
    graph: {
      schema_version: graph.schemaVersion ?? graph.schema_version ?? 'graph.flow.aiwg.io/v1',
      graph_id: graph.graphId,
      graph_version: graph.graphVersion,
      run_id: graph.runId,
      replay_of_run_id: graph.replayOfRunId ?? graph.replay_of_run_id,
      checkpoint_id: graph.checkpointId ?? graph.checkpoint_id,
    },
    graph_nodes: nodes,
  };
}

async function readMcAudit(sessionId) {
  const logPath = join(mcSessionsDir(), sessionId, 'log.jsonl');
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw.trim().split(/\n+/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { event: 'unparsed', line }; }
    });
  } catch {
    return [];
  }
}

async function readMcSessions() {
  let entries = [];
  const sessionsDir = mcSessionsDir();
  try { entries = await readdir(sessionsDir, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(sessionsDir, entry.name, 'session.json'), 'utf8');
      const session = JSON.parse(raw);
      const audit = await readMcAudit(entry.name);
      sessions.push({
        id: String(session.id ?? entry.name),
        name: session.name ?? entry.name,
        state: session.state ?? 'unknown',
        source: 'aiwg-mc',
        created_at: session.createdAt ?? session.created_at,
        updated_at: session.updatedAt ?? session.updated_at,
        max_missions: session.maxMissions ?? session.max_missions,
        audit_count: audit.length,
        audit_tail: audit.slice(-8),
        missions: (session.missions ?? []).map((m) => ({ ...missionSummary(m), session_id: session.id ?? entry.name, source: 'aiwg-mc' })),
      });
    } catch {
      // Ignore malformed or half-written sessions; the next refresh will retry.
    }
  }
  sessions.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  return sessions;
}

async function taskMissionSession(executorUrl) {
  const running = await getRunning(executorUrl).catch(() => ({ running: [] }));
  const approvals = await getApprovals(executorUrl, 'pending').catch(() => ({ approvals: [] }));
  const taskMissions = [
    ...(running.running ?? []).map((t) => ({
      id: `${t.instance_id}::${t.task_id}`,
      session_id: 'executor-live',
      source: 'executor-task',
      title: `Task ${t.task_id}`,
      status: normalizeMissionStatus(t.state),
      instance_id: t.instance_id,
      task_id: t.task_id,
      tenant: t.tenant,
      runtime_posture: t.runtime_posture,
      transport: t.transport,
      terminal: false,
    })),
    ...(approvals.approvals ?? []).map((a) => ({
      id: a.id,
      session_id: 'executor-live',
      source: 'hitl-approval',
      title: a.prompt,
      status: 'awaiting-approval',
      instance_id: a.instance_id,
      task_id: a.task_id,
      tenant: a.tenant,
      risk: a.risk,
      terminal: false,
    })),
  ];
  if (!taskMissions.length) return null;
  return {
    id: 'executor-live',
    name: 'Executor live tasks',
    state: 'active',
    source: 'agentic-sandbox',
    updated_at: new Date().toISOString(),
    audit_count: 0,
    audit_tail: [],
    missions: taskMissions,
  };
}

async function getMissions(executorUrl) {
  const sessions = await readMcSessions();
  const [live, fleetSessions] = await Promise.all([
    taskMissionSession(executorUrl),
    fleetMissionSessions(executorUrl),
  ]);
  if (live) sessions.unshift(live);
  sessions.unshift(...fleetSessions);
  const missions = sessions.flatMap((s) => s.missions);
  return {
    source: 'aiwg-mc + agentic-sandbox',
    fetched_at: new Date().toISOString(),
    count: missions.length,
    sessions,
    missions,
  };
}

const FLEET_TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed-out']);

function fleetParentState(records) {
  const states = records.map((record) => record.status?.observed_state ?? 'unknown');
  if (states.some((state) => state === 'operator-review-required' || state === 'unknown')) return 'operator-review-required';
  if (records.some((record) => record.status?.backpressure?.reason === 'approval')) return 'awaiting-approval';
  if (states.some((state) => state === 'failed' || state === 'timed-out')) return 'failed';
  if (states.length > 0 && states.every((state) => FLEET_TERMINAL_STATES.has(state))) return 'completed';
  return 'active';
}

export function fleetMissionProjection(record, sessionId) {
  assertNoWorkerMissionBinding(record);
  const lineage = record.lineage ?? {};
  const status = record.status ?? {};
  const artifacts = Array.isArray(status.artifacts) ? status.artifacts : [];
  return {
    id: lineage.child_id,
    session_id: sessionId,
    source: 'agentic-sandbox-fleet',
    title: `${record.kind ?? 'workload'} ${lineage.child_id ?? 'unknown'}`,
    status: status.observed_state ?? 'unknown',
    terminal: FLEET_TERMINAL_STATES.has(status.observed_state),
    parent_mission_id: lineage.mission_id,
    workload_kind: record.kind,
    desired_state: record.spec?.desired_state,
    target_id: lineage.target_id,
    executor_id: lineage.executor_id,
    runtime_id: lineage.runtime_id,
    instance_id: lineage.runtime_id,
    runtime_session_id: lineage.session_id,
    task_id: lineage.task_id,
    command_id: lineage.command_id,
    dispatch_id: lineage.dispatch_id,
    revision: status.revision,
    last_seen: status.last_seen,
    health: status.health,
    backpressure: status.backpressure,
    artifacts,
    exit_classification: status.exit_classification,
    error: status.error_code,
    schedule: record.spec?.schedule,
    ...(graphMissionProjection({
      graph_metadata: record.lineage?.graph_metadata ?? record.metadata?.['aiwg.flow.graph'],
      graph_nodes: record.status?.graph_nodes,
    }) ?? {}),
  };
}

async function fleetMissionSessions(executorUrl) {
  let response;
  try {
    response = await fetchJsonFirst([`${executorUrl}/api/v2/fleet/workloads`]);
  } catch (err) {
    rethrowExecutorSecurityError(err);
    if (/\s->\s(?:404|405)(?:;|$)/.test(String(err?.message ?? err))) return [];
    throw err;
  }
  if (response.status === 404 || response.status === 405) return [];
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Agentic Sandbox fleet inventory failed with HTTP ${response.status}`);
  }
  const snapshot = response.body?.inventory ?? response.body;
  if (
    snapshot?.document_type !== 'inventory'
    || snapshot?.api_version !== 'agentic-orchestration/v1'
    || !Array.isArray(snapshot?.records)
  ) {
    throw new Error('Agentic Sandbox returned an invalid fleet inventory envelope');
  }
  const records = snapshot.records;
  const groups = new Map();
  const childIds = new Set();
  for (const record of records) {
    const missionId = record?.lineage?.mission_id;
    const childId = record?.lineage?.child_id;
    if (!missionId || !childId || !record?.kind || !record?.status?.observed_state) {
      throw new Error('Agentic Sandbox fleet inventory contains an invalid workload record');
    }
    if (childIds.has(childId)) throw new Error(`Agentic Sandbox fleet inventory repeats child '${childId}'`);
    childIds.add(childId);
    const group = groups.get(missionId) ?? [];
    group.push(record);
    groups.set(missionId, group);
  }
  return [...groups.entries()].map(([missionId, missionRecords]) => {
    const sessionId = `fleet:${missionId}`;
    const lastSeen = missionRecords.map((record) => record.status?.last_seen).filter(Boolean).sort().at(-1);
    return {
      id: sessionId,
      parent_mission_id: missionId,
      name: `Fleet mission ${missionId}`,
      state: fleetParentState(missionRecords),
      source: 'agentic-sandbox-fleet',
      updated_at: lastSeen ?? snapshot.generated_at,
      inventory_revision: snapshot.inventory_revision,
      audit_count: 0,
      audit_tail: [],
      missions: missionRecords.map((record) => fleetMissionProjection(record, sessionId)),
    };
  });
}

async function getSessionEventRows(executorUrl, instances) {
  const rows = [];
  await Promise.all((instances ?? []).map(async (inst) => {
    let sessions;
    try { sessions = (await getSessions(executorUrl, inst.id)).sessions; } catch (err) { rethrowExecutorSecurityError(err); return; }
    for (const session of sessions) {
      rows.push({
        id: session.id,
        instance_id: inst.id,
        agent_id: session.agent_id,
        state: session.state ?? session.status ?? session.session_state ?? 'available',
        role_policy: session.role_policy,
        session_backend: session.session_backend,
        session_class: session.session_class,
      });
    }
  }));
  return rows;
}

async function getEventSnapshot(executorUrl) {
  const inventory = await getInventory(executorUrl).catch(() => ({ instances: [] }));
  const [running, approvals, missions, sessions] = await Promise.all([
    getRunning(executorUrl).catch(() => ({ running: [] })),
    getApprovals(executorUrl, 'pending').catch(() => ({ approvals: [] })),
    getMissions(executorUrl).catch(() => ({ missions: [] })),
    getSessionEventRows(executorUrl, inventory.instances).catch(() => []),
  ]);
  const ts = new Date().toISOString();
  const events = [];
  for (const inst of inventory.instances ?? []) {
    events.push({ id: `instance:${inst.id}`, type: 'inventory.instance', source: 'agentic-sandbox', subject: inst.id, state: inst.state, ts, ref: { instance_id: inst.id } });
  }
  for (const task of running.running ?? []) {
    events.push({ id: `task:${task.instance_id}:${task.task_id}`, type: 'task.lifecycle', source: 'a2a', subject: task.task_id, state: task.state, ts, ref: { instance_id: task.instance_id, task_id: task.task_id } });
  }
  for (const approval of approvals.approvals ?? []) {
    events.push({ id: `approval:${approval.id}`, type: 'hitl.approval', source: 'a2a', subject: approval.task_id ?? approval.id, state: approval.status, severity: approval.risk, ts, ref: { instance_id: approval.instance_id, approval_id: approval.id } });
  }
  for (const session of sessions ?? []) {
    events.push({ id: `session:${session.instance_id}:${session.id}`, type: 'session.lifecycle', source: 'pty-session', subject: session.id, state: session.state, ts, ref: { instance_id: session.instance_id, session_id: session.id, agent_id: session.agent_id, session_backend: session.session_backend, session_class: session.session_class, role_policy: session.role_policy } });
  }
  for (const mission of missions.missions ?? []) {
    events.push({ id: `mission:${mission.id}`, type: 'mission.lifecycle', source: mission.source ?? 'aiwg-mc', subject: mission.id, state: mission.status, ts, ref: { session_id: mission.session_id, mission_id: mission.id, ralph_loop_id: mission.ralph_loop_id } });
  }
  return { source: 'cockpit.unified-event-model/v1', fetched_at: ts, count: events.length, events };
}

async function respondApproval(executorUrl, approvalId, decision) {
  if (!['approve', 'deny'].includes(decision)) return { status: 400, body: { error: 'decision must be approve|deny' } };
  const [instanceId, taskId] = String(approvalId).split('::');
  if (!instanceId || !taskId) return { status: 400, body: { error: 'invalid_approval_id' } };
  const agentId = await resolveSessionAgentId(executorUrl, instanceId);
  try {
    const result = await negotiatedCockpitA2ARequest(executorUrl, agentId, (selected) => {
      const message = {
        messageId: `cockpit-hitl-${Date.now()}`,
        role: selected.protocol_version === '1.0' ? 'ROLE_USER' : 'user',
        taskId,
        contextId: taskId,
        parts: [selected.protocol_version === '1.0'
          ? { text: decision }
          : { kind: 'text', text: decision }],
        metadata: { hitl_response: { decision }, approval_decision: decision },
      };
      if (selected.protocol_version === '1.0') {
        return [{
          target: `${selected.url}/message:send`,
          method: 'POST',
          headers: cockpitA2AHeaders('1.0', true),
          body: JSON.stringify({ message }),
        }];
      }
      const response = JSON.stringify({ decision, response: message });
      return [
        {
          target: `${selected.url}/v1/tasks/${encodeURIComponent(taskId)}:respond`,
          method: 'POST',
          headers: cockpitA2AHeaders('0.3', true),
          body: response,
        },
        {
          target: `${selected.url}/tasks/${encodeURIComponent(taskId)}:respond`,
          method: 'POST',
          headers: cockpitA2AHeaders('0.3', true),
          body: response,
        },
        {
          target: `${executorUrl}/api/v1/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}:respond`,
          method: 'POST',
          headers: cockpitA2AHeaders('0.3', true),
          body: response,
        },
        {
          target: `${selected.url}/v1/messages:send`,
          method: 'POST',
          headers: cockpitA2AHeaders('0.3', true),
          body: JSON.stringify({ message }),
        },
      ];
    });
    return { status: result.status, body: normalizeCockpitA2ATaskResponse(result.body) };
  } catch (e) {
    rethrowExecutorSecurityError(e);
    return { status: 409, body: bridgeErrorBody(e, 'approval_response_failed') };
  }
}

/** Sessions for one instance. Executor attach targets are normalized here and
 * replaced with Bridge-owned proxy URLs at the request boundary. */
async function getSessions(executorUrl, instanceId) {
  const sessionAgentId = await resolveSessionAgentId(executorUrl, instanceId);
  const agentIds = unique([instanceId, sessionAgentId]);
  const { body } = await fetchJsonFirst(agentIds.flatMap((agentId) => [
    `${executorUrl}/agents/${encodeURIComponent(agentId)}/sessions`,
    `${executorUrl}/agents/${encodeURIComponent(agentId)}/v1/sessions`,
    `${executorUrl}/api/v1/agents/${encodeURIComponent(agentId)}/sessions`,
  ]));
  const sessions = asArrayFromEnvelope(body, ['sessions', 'items', 'data']);
  return normalizeSessionRows({ sessions, executorUrl, instanceId, sessionAgentId });
}

function normalizeScreenSnapshot(body, { instanceId, sessionId, source }) {
  const text = String(body?.text ?? body?.snapshot ?? body?.screen ?? body?.content ?? '');
  const rawLines = Array.isArray(body?.lines) ? body.lines : text.replace(/\r/g, '\n').split('\n');
  return {
    instance_id: instanceId,
    session_id: sessionId,
    text,
    lines: rawLines.map((line) => String(line)).filter(Boolean).slice(-80),
    seq: body?.seq ?? body?.sequence ?? body?.anchor_sequence ?? body?.anchorSequence ?? null,
    fetched_at: new Date().toISOString(),
    source,
    snapshot_format: body?.snapshot_format ?? body?.snapshotFormat ?? body?.format ?? 'text/plain',
  };
}

async function getSessionScreen(executorUrl, instanceId, sessionId) {
  const sessionAgentId = await resolveSessionAgentId(executorUrl, instanceId);
  const agentIds = unique([sessionAgentId, instanceId]);
  const paths = agentIds.flatMap((agentId) => {
    const encodedAgent = encodeURIComponent(agentId);
    const encodedSession = encodeURIComponent(sessionId);
    return [
      `${executorUrl}/api/v1/agents/${encodedAgent}/sessions/${encodedSession}/screen`,
      `${executorUrl}/api/v1/agents/${encodedAgent}/sessions/${encodedSession}/screen-state`,
      `${executorUrl}/agents/${encodedAgent}/sessions/${encodedSession}/screen`,
      `${executorUrl}/agents/${encodedAgent}/sessions/${encodedSession}/screen-state`,
    ];
  });
  try {
    const { body, target, status } = await fetchJsonFirst(paths);
    if (status >= 400) return { status, body };
    return { status, body: normalizeScreenSnapshot(body, { instanceId, sessionId, source: target }) };
  } catch (e) {
    rethrowExecutorSecurityError(e);
    return {
      status: 404,
      body: {
        ...bridgeErrorBody(e, 'session_screen_unavailable'),
        instance_id: instanceId,
        session_id: sessionId,
      },
    };
  }
}

export function normalizeSessionRows({ sessions, executorUrl, instanceId, sessionAgentId = instanceId }) {
  const wsBase = executorUrl.replace(/^http/i, 'ws');
  const normalizeAttachUrl = (s, sessionId) => {
    const explicit = s.attach_url ?? s.attachUrl;
    if (explicit) return explicit;
    const ptyUrl = s.pty_ws_url ?? s.ptyWsUrl;
    if (ptyUrl) {
      try {
        const u = new URL(String(ptyUrl).replace('{host}', new URL(executorUrl).host));
        u.protocol = new URL(executorUrl).protocol === 'https:' ? 'wss:' : 'ws:';
        return u.toString();
      } catch { /* fall through to legacy shape */ }
    }
    // Fallback URL construction (session entry carried no attach_url/pty_ws_url).
    // The executor's pty-ws route keys the agent segment by the INSTANCE id, not
    // the registered agent name — resolveSessionAgentId returns the name for some
    // agents (e.g. VMs after a Bridge restart), which the route won't accept and
    // the data-plane socket never connects (#1671). Use the instance id here; the
    // agent name is only needed for the session-list FETCH, not the attach path.
    return `${wsBase}/agents/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/attach`;
  };
  const sessionAliases = (entry, sessionId) => {
    const aliases = [`session:${sessionId}`];
    const commandId = entry.command_id ?? entry.commandId;
    if (commandId) aliases.push(`command:${commandId}`);
    return aliases;
  };
  const fallbackScore = (entry) => {
    const sessionId = String(entry.id ?? entry.session_id ?? entry.sessionId ?? '');
    const commandId = String(entry.command_id ?? entry.commandId ?? '');
    const id = String(entry.id ?? '');
    const name = String(entry.session_name ?? entry.sessionName ?? '');
    const command = String(entry.command ?? '').trim();
    let score = 0;
    if (id && commandId && id === commandId) score += 2;
    if (name && (name === sessionId || name === commandId)) score += 2;
    if (/^\/?bin\/bash\s+-l$/.test(command)) score += 1;
    if (entry.has_screen === false || entry.hasScreen === false) score += 1;
    return score;
  };
  const namedScore = (entry) => {
    const name = String(entry.session_name ?? entry.sessionName ?? '');
    let score = name ? 1 : 0;
    if (/^terminal-[a-z0-9-]+$/i.test(name)) score += 2;
    if (entry.has_screen === true || entry.hasScreen === true) score += 1;
    return score;
  };
  const shouldReplace = (existing, candidate) => {
    const existingFallback = fallbackScore(existing);
    const candidateFallback = fallbackScore(candidate);
    if (existingFallback !== candidateFallback) return candidateFallback < existingFallback;
    const existingNamed = namedScore(existing);
    const candidateNamed = namedScore(candidate);
    if (existingNamed !== candidateNamed) return candidateNamed > existingNamed;
    return false;
  };
  const mergeGroups = (target, source) => {
    if (target === source) return target;
    for (const alias of source.aliases) {
      target.aliases.add(alias);
      groupsByAlias.set(alias, target);
    }
    source.merged = true;
    if (!target.value || (source.value && shouldReplace(target.value, source.value))) target.value = source.value;
    return target;
  };
  // Dedup by every stable alias we see. Docker/host fallback rows can share a
  // command id with the Cockpit-created session; QEMU fallback rows can instead
  // share only the formal session id while carrying a different command id. Keep
  // the named/screen-backed session row so the UI exposes the working attach URL.
  const groups = [];
  const groupsByAlias = new Map();
  for (const s of sessions) {
    const sessionId = s.id ?? s.session_id ?? s.sessionId;
    if (!sessionId) continue;
    const normalized = {
      ...s,
      id: sessionId,
      instance_id: s.instance_id ?? s.instanceId ?? instanceId,
      agent_id: s.agent_id ?? s.agentId ?? sessionAgentId,
      role_policy: s.role_policy ?? s.rolePolicy ?? (s.default_role === 'observer' ? 'observe-default' : s.default_role) ?? 'observe-default',
      attach_url: normalizeAttachUrl(s, sessionId),
    };
    const aliases = sessionAliases(s, sessionId);
    let group = aliases.map((alias) => groupsByAlias.get(alias)).find(Boolean);
    if (!group) {
      group = { aliases: new Set(), value: null, merged: false };
      groups.push(group);
    }
    for (const alias of aliases) {
      const other = groupsByAlias.get(alias);
      if (other && other !== group) group = mergeGroups(group, other);
      group.aliases.add(alias);
      groupsByAlias.set(alias, group);
    }
    if (!group.value || shouldReplace(group.value, normalized)) group.value = normalized;
  }
  return { instance_id: instanceId, sessions: groups.filter((group) => !group.merged && group.value).map((group) => group.value) };
}

async function endSession(executorUrl, instanceId, sessionId) {
  const sessionAgentId = await resolveSessionAgentId(executorUrl, instanceId);
  let sessions = [];
  try {
    sessions = (await getSessions(executorUrl, instanceId)).sessions;
  } catch (err) {
    rethrowExecutorSecurityError(err);
    // Fall back to using the supplied id directly; older executors may not list
    // before delete, and delete should remain useful during recovery cleanup.
  }
  const targetSession = sessions.find((s) => String(s.id) === String(sessionId)
    || String(s.session_id ?? s.sessionId ?? '') === String(sessionId)
    || String(s.session_name ?? s.sessionName ?? '') === String(sessionId));
  const sessionName = targetSession?.session_name ?? targetSession?.sessionName ?? sessionId;
  const { status, body } = await fetchJsonFirst(unique([sessionAgentId, instanceId]).map((agentId) => ({
    target: `${executorUrl}/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionName)}`,
    method: 'DELETE',
  })));
  return {
    status,
    body: {
      ...body,
      id: sessionId,
      session_name: sessionName,
      instance_id: instanceId,
      agent_id: sessionAgentId,
      ended: status >= 200 && status < 300,
    },
  };
}

async function findReusableSession(executorUrl, instanceId, sessionName) {
  const sessions = (await getSessions(executorUrl, instanceId)).sessions;
  return sessions.find((s) => String(s.session_name ?? s.sessionName ?? '') === String(sessionName));
}

function sessionResponseFromRow(row) {
  return {
    ...row,
    id: row.id ?? row.session_id ?? row.sessionId,
    attach_url: row.attach_url ?? row.attachUrl,
    reused: true,
  };
}

function websocketCockpitToken(req) {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const encoded = protocols.find((value) => value.startsWith('cockpit.'))?.slice('cockpit.'.length) ?? '';
  try { return Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return ''; }
}

function websocketAuthed(req, expected) {
  const presented = websocketCockpitToken(req);
  if (presented.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(presented), Buffer.from(expected)); } catch { return false; }
}

function writeUpgradeHead(socket, response) {
  socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? 'Switching Protocols'}\r\n`);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
  }
  socket.write('\r\n');
}

async function proxyExecutorWebsocket({ req, socket, head, target, executorTokenFile, executorUrl }) {
  const token = await resolveExecutorBearer(executorTokenFile);
  const requestedProtocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith('cockpit.'));
  const headers = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    host: target.host,
    'sec-websocket-key': req.headers['sec-websocket-key'],
    'sec-websocket-version': req.headers['sec-websocket-version'],
    ...(req.headers['sec-websocket-extensions'] ? { 'sec-websocket-extensions': req.headers['sec-websocket-extensions'] } : {}),
    ...(requestedProtocols.length ? { 'sec-websocket-protocol': requestedProtocols.join(', ') } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const transport = target.protocol === 'wss:' ? https : http;
  const requestTarget = new URL(target);
  requestTarget.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const upstreamRequest = transport.request(allowedExecutorTarget(requestTarget, executorUrl), { method: 'GET', headers });
  upstreamRequest.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    writeUpgradeHead(socket, response);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    const closeBoth = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    socket.on('error', closeBoth);
    upstreamSocket.on('error', closeBoth);
  });
  upstreamRequest.on('response', (response) => {
    socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Upstream Error'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    response.resume();
  });
  upstreamRequest.on('error', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  upstreamRequest.end();
}

function embeddingDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute directory path`);
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) throw new TypeError(`${label} must not be a filesystem root`);
  return normalized;
}

function embeddingDirectories(value, defaults, label) {
  if (value === undefined) return Object.freeze([...defaults]);
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  return Object.freeze(value.map((entry) => embeddingDirectory(entry, label)));
}

export function createBridge({
  executorUrl = EXECUTOR_URL,
  allowMockExecutor = ALLOW_MOCK_EXECUTOR,
  token,
  executorTokenFile = EXECUTOR_TOKEN_FILE,
  requireSandboxMtls = REQUIRE_SANDBOX_MTLS,
  bootstrapTtlMs = 60_000,
  sessionTtlMs = 12 * 60 * 60 * 1000,
  a2aProtocolPolicy = COCKPIT_A2A_PROTOCOL_POLICY,
  allowA2AProtocolFallback = COCKPIT_A2A_PROTOCOL_FALLBACK,
  // Explicit embedding seams are per-instance; omitted options retain operator defaults.
  libraryDir,
  auditDir: requestedAuditDir,
  mcpTokenFile = MCP_TOKEN_FILE,
  localDockerFallback = LOCAL_DOCKER_FALLBACK,
  localLibvirtFallback,
  aiwgCommand,
  corpusRoots,
  contributionDirs,
  // Trusted embedding seam; no default verifier and no operator-token fallback.
  desktopIdentity,
  desktopBackend,
} = {}) {
  if (desktopIdentity !== undefined && (!desktopIdentity ||
      ['bind', 'status', 'authorize', 'withDelegation', 'logout', 'onInvalidate'].some((method) => typeof desktopIdentity[method] !== 'function'))) {
    throw new TypeError('desktopIdentity must implement authoritative desktop identity operations');
  }
  if (desktopBackend !== undefined && (!desktopBackend || typeof desktopBackend.request !== 'function')) throw new TypeError('desktopBackend must implement desktop requests');
  if (typeof mcpTokenFile !== 'string') throw new TypeError('mcpTokenFile must be a string');
  if (typeof localDockerFallback !== 'boolean' || (localLibvirtFallback !== undefined && typeof localLibvirtFallback !== 'boolean')) {
    throw new TypeError('local fallback options must be booleans');
  }
  if (aiwgCommand !== undefined && typeof aiwgCommand !== 'function') {
    throw new TypeError('aiwgCommand must be a function');
  }
  const instanceLibraryDir = libraryDir === undefined ? LIBRARY_DIR : embeddingDirectory(libraryDir, 'libraryDir');
  // Undefined preserves the historical per-request environment default.
  const instanceAuditDir = requestedAuditDir === undefined
    ? undefined
    : embeddingDirectory(requestedAuditDir, 'auditDir');
  const instanceCorpusRoots = embeddingDirectories(corpusRoots, CORPUS_ROOTS, 'corpusRoots');
  const instanceContributionDirs = embeddingDirectories(contributionDirs, CONTRIB_DIRS, 'contributionDirs');

  if (!['0.3', '1.0', 'auto'].includes(a2aProtocolPolicy)) {
    throw new Error(`AIWG_COCKPIT_A2A_PROTOCOL_POLICY must be 0.3, 1.0, or auto (received '${a2aProtocolPolicy}')`);
  }
  const upstreamUrl = executorUrl;
  const executorAddress = parseExecutorUrl(upstreamUrl);
  const TOKEN = token ?? randomBytes(24).toString('hex');
  const bootstrapNonces = new Map();
  const browserSessions = new Map();
  const digest = (value) => createHash('sha256').update(String(value)).digest('base64url');
  const issueBootstrapNonce = (audience = 'browser') => {
    if (!['browser', 'tauri', 'vscode'].includes(audience)) {
      throw executorAuthError('invalid_bootstrap_audience', 'bootstrap audience must be browser, tauri, or vscode');
    }
    const nonce = randomBytes(24).toString('base64url');
    bootstrapNonces.set(digest(nonce), { audience, expiresAt: Date.now() + bootstrapTtlMs });
    return nonce;
  };
  const consumeBootstrapNonce = (nonce, audience) => {
    const key = digest(nonce);
    const pending = bootstrapNonces.get(key);
    bootstrapNonces.delete(key);
    return Boolean(
      pending &&
      pending.expiresAt >= Date.now() &&
      pending.audience === audience &&
      ['browser', 'tauri', 'vscode'].includes(audience),
    );
  };
  const sessionAuth = (req) => {
    const id = cookies(req).cockpit_session ?? '';
    const sessionId = digest(id);
    const session = browserSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      browserSessions.delete(sessionId);
      desktopIdentity?.logout(sessionId);
      return null;
    }
    return { kind: 'session', csrf: session.csrf, sessionId, desktopAudience: `cockpit:${sessionId}` };
  };
  const requestAuth = (req) => bearerAuthed(req, TOKEN)
    ? { kind: 'bearer', csrf: TOKEN }
    : sessionAuth(req);
  const executorOrigin = executorAddress.origin;
  const requestContext = Object.freeze({
    executorOrigin, executorTokenFile, a2aProtocolPolicy, allowA2AProtocolFallback,
    libraryDir: instanceLibraryDir, auditDir: instanceAuditDir,
    mcpTokenFile, localDockerFallback, localLibvirtFallback, aiwgCommand,
    corpusRoots: instanceCorpusRoots, contributionDirs: instanceContributionDirs,
  });
  const attachTargets = new Map();
  const issueAttachUrl = (req, value) => {
    const target = new URL(String(value));
    const protocol = executorAddress.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = (url) => url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
    const sameHost = target.hostname === executorAddress.hostname ||
      (isLocalHostName(target.hostname) && isLocalHostName(executorAddress.hostname));
    if (target.protocol !== protocol || !sameHost || port(target) !== port(executorAddress) ||
        target.username || target.password || !/^\/agents\/[^/]+\/sessions\/[^/]+\/attach$/.test(target.pathname)) {
      throw executorAuthError('executor_attach_target_refused', 'executor returned an attach URL outside the allowed PTY endpoint');
    }
    target.host = executorAddress.host;
    const id = randomBytes(18).toString('base64url');
    attachTargets.set(id, target);
    if (attachTargets.size > 1024) attachTargets.delete(attachTargets.keys().next().value);
    const wsProtocol = req.socket.encrypted ? 'wss:' : 'ws:';
    return `${wsProtocol}//${req.headers.host}/api/pty${target.pathname}/${id}`;
  };
  const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      // unauthenticated liveness probe (no /api/ prefix) — for the shell to wait on
      if (url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/bootstrap/nonce' && req.method === 'POST') {
        if (!validBrowserOrigin(req) || !bearerAuthed(req, TOKEN)) {
          return json(res, 401, { error: 'unauthorized' });
        }
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        try {
          const payload = JSON.stringify({
            nonce: issueBootstrapNonce(String(parsed.body.audience ?? 'browser')),
            expires_in_ms: bootstrapTtlMs,
          });
          res.writeHead(201, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
          });
          return res.end(payload);
        } catch (err) {
          return json(res, 400, { error: err.code ?? 'invalid_bootstrap_audience' });
        }
      }
      if (url.pathname === '/bootstrap/session' && req.method === 'POST') {
        if (!validBrowserOrigin(req)) return json(res, 403, { error: 'forbidden_origin' });
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const nonce = String(parsed.body.nonce ?? '');
        const audience = String(parsed.body.audience ?? '');
        if (!nonce || !consumeBootstrapNonce(nonce, audience)) {
          return json(res, 401, { error: 'bootstrap_invalid_or_expired' });
        }
        const id = randomBytes(32).toString('base64url');
        const csrf = randomBytes(24).toString('base64url');
        browserSessions.set(digest(id), { csrf, audience, expiresAt: Date.now() + sessionTtlMs });
        res.writeHead(201, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': `cockpit_session=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`,
        });
        return res.end(JSON.stringify({ csrf, expires_in_ms: sessionTtlMs }));
      }
      if (url.pathname === '/bootstrap/session' && req.method === 'GET') {
        const auth = sessionAuth(req);
        if (!auth) return json(res, 401, { error: 'unauthorized' });
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, { csrf: auth.csrf });
      }
      if (url.pathname === '/bootstrap/session' && req.method === 'DELETE') {
        const auth = sessionAuth(req);
        if (!auth) return json(res, 401, { error: 'unauthorized' });
        if (!validDesktopBrowserOrigin(req)) return json(res, 403, { error: 'forbidden_origin' });
        if (!validCsrf(req, auth)) return json(res, 403, { error: 'csrf_required' });
        // Remove local authority first so pending binds cannot resurrect it.
        browserSessions.delete(auth.sessionId);
        desktopIdentity?.logout(auth.sessionId);
        res.writeHead(204, {
          'cache-control': 'no-store',
          'set-cookie': 'cockpit_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
        });
        return res.end();
      }
      if (url.pathname === '/api/desktop-identity') {
        const auth = sessionAuth(req); // A native/operator bearer is insufficient.
        if (!auth) return json(res, 401, { error: 'unauthorized' });
        if (!validDesktopBrowserOrigin(req, { allowSameOriginFetch: true })) return json(res, 403, { error: 'forbidden_origin' });
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        res.setHeader('cache-control', 'no-store');
        if (!desktopIdentity) return json(res, 200, { state: 'unsupported', reason: 'desktop_identity_not_configured' });
        try {
          const identity = await desktopIdentity.status(auth.sessionId);
          if (sessionAuth(req)?.sessionId !== auth.sessionId) return json(res, 401, { error: 'unauthorized' });
          return json(res, 200, identity);
        } catch (err) {
          // Never forward issuer response bodies, delegation, or diagnostics.
          return json(res, err?.code === 'identity_unavailable' ? 503 : 403, {
            error: err?.code === 'identity_unavailable' ? 'desktop_identity_unavailable' : 'desktop_identity_denied',
          });
        }
      }
      if (await desktopHttp.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/') && !validBrowserOrigin(req)) {
        return json(res, 403, { error: 'forbidden_origin' });
      }
      // Gate the control surface with either an explicit bearer for non-browser
      // clients or the HttpOnly session established by a one-time bootstrap.
      const auth = url.pathname.startsWith('/api/') ? requestAuth(req) : null;
      if (url.pathname.startsWith('/api/') && !auth) {
        return json(res, 401, { error: 'unauthorized', detail: 'missing or invalid cockpit token' });
      }
      if (url.pathname.startsWith('/api/') && !validCsrf(req, auth)) {
        return json(res, 403, { error: 'csrf_required' });
      }
      if (url.pathname.startsWith('/api/')) {
        try {
          await assertRealExecutor(upstreamUrl, allowMockExecutor);
          if (requireSandboxMtls) {
            await getBootstrapTrustPosture(upstreamUrl, { requireSandboxMtls: true });
          }
        } catch (err) {
          return json(res, Number(err?.upstreamStatus) || 502, bridgeErrorBody(err, err.code ?? 'executor_refused'));
        }
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const emit = (reason = 'heartbeat') => {
          res.write(`event: cockpit.refresh\n`);
          res.write(`data: ${JSON.stringify({ reason, ts: new Date().toISOString() })}\n\n`);
        };
        emit('connected');
        const timer = setInterval(() => emit(), 5_000);
        req.on('close', () => clearInterval(timer));
        return;
      }
      if (url.pathname === '/api/inventory') return json(res, 200, await getInventory(upstreamUrl, { requireSandboxMtls }));
      if (url.pathname === '/api/executor/capabilities') return json(res, 200, await getExecutorCapabilities(upstreamUrl));
      if (url.pathname === '/api/bootstrap/readiness' && req.method === 'GET') {
        return json(res, 200, await getBootstrapTrustPosture(upstreamUrl, { requireSandboxMtls }));
      }
      if (url.pathname === '/api/mcp/discovery' && req.method === 'GET') return json(res, 200, await getMcpDiscovery(upstreamUrl));
      if (url.pathname === '/api/mcp' && req.method === 'POST') return await proxyMcpRequest(req, res, upstreamUrl, mcpTokenFile);
      if (url.pathname === '/api/running') return json(res, 200, await getRunning(upstreamUrl));
      if (url.pathname === '/api/missions' && req.method === 'GET') return json(res, 200, await getMissions(upstreamUrl));
      if (url.pathname === '/api/missions' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        return json(res, 201, await dispatchMission(parsed.body, upstreamUrl));
      }
      if (url.pathname === '/api/events/snapshot') return json(res, 200, await getEventSnapshot(upstreamUrl));
      if (url.pathname === '/api/activity/coverage' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        try {
          const result = await activityProxy(upstreamUrl, 'coverage', parsed.body);
          await appendAudit('activity.coverage.queried', { scope: activityRequest(parsed.body).scope, complete: result.body?.completeness?.complete === true });
          return json(res, result.status, result.body);
        } catch (error) {
          return json(res, Number(error?.upstreamStatus) || (String(error?.code).startsWith('activity_') ? 400 : 502), bridgeErrorBody(error, error?.code ?? 'activity_upstream_error'));
        }
      }
      if (url.pathname === '/api/activity/timeline' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        try {
          const result = await activityProxy(upstreamUrl, 'timeline', parsed.body);
          if (result.status < 200 || result.status >= 300) return json(res, result.status, result.body);
          await appendAudit('activity.timeline.queried', { scope: activityRequest(parsed.body).scope, event_count: result.body.events.length, complete: result.body.completeness.complete });
          return json(res, result.status, result.body);
        } catch (error) {
          return json(res, Number(error?.upstreamStatus) || (String(error?.code).startsWith('activity_') ? 400 : 502), bridgeErrorBody(error, error?.code ?? 'activity_upstream_error'));
        }
      }
      if (url.pathname === '/api/activity/export' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        try {
          const result = await activityProxy(upstreamUrl, 'export', parsed.body);
          if (result.status === 503) return json(res, 503, { error: 'activity_export_unavailable', message: 'The sandbox signing key is unavailable.' });
          if (result.status < 200 || result.status >= 300) return json(res, result.status, result.body);
          await appendAudit('activity.export.completed', { scope: activityRequest(parsed.body).scope, key_id: result.body.manifest.key_id, merkle_root: result.body.manifest.merkle_root, event_count: result.body.manifest.event_count });
          res.setHeader('content-disposition', 'attachment; filename="activity-export.json"');
          res.setHeader('cache-control', 'no-store');
          return json(res, result.status, result.body);
        } catch (error) {
          return json(res, Number(error?.upstreamStatus) || (String(error?.code).startsWith('activity_') ? 400 : 502), bridgeErrorBody(error, error?.code ?? 'activity_upstream_error'));
        }
      }
      if (url.pathname === '/api/loadouts') return json(res, 200, await getLoadouts(upstreamUrl));
      if (url.pathname === '/api/index/status' && req.method === 'GET') return json(res, 200, await getIndexStatus());
      if (url.pathname === '/api/index/query' && req.method === 'GET') {
        const result = await queryIndex(url);
        return json(res, result.status, result.body);
      }
      if (url.pathname === '/api/index/rebuild' && req.method === 'POST') {
        const result = await rebuildIndex(req);
        return json(res, result.status, result.body);
      }
      if (url.pathname === '/api/index/graphs' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const requested = await appendAudit('index.graph.create.requested', { graph: parsed.body?.name ?? null });
        try {
          const graph = await createUserIndexGraph(parsed.body);
          await appendAudit('index.graph.create.completed', { request_ts: requested.ts, graph: graph.name });
          return json(res, 201, { ok: true, graph });
        } catch (error) {
          await appendAudit('index.graph.create.rejected', { request_ts: requested.ts, reason: String(error?.message ?? error) });
          return json(res, 400, bridgeErrorBody(error, 'invalid_graph_definition'));
        }
      }
      if (url.pathname === '/api/audit' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
        return json(res, 200, { source: 'cockpit-bridge-audit/v1', audit: await readAudit({ limit }) });
      }
      if (url.pathname === '/api/audit/intent' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const body = parsed.body || {};
        const event = typeof body.event === 'string' && body.event.trim() ? body.event.trim() : 'operator.intent';
        const entry = await appendAudit(event, { detail: body.detail ?? body });
        return json(res, 201, entry);
      }
      let m;
      if (url.pathname === '/api/instances' && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const payload = parsed.body;
        if (payload.runtime === 'qemu') {
          const sshKey = expandHome(String(payload.ssh_key ?? payload.sshKey ?? '').trim()) || defaultSshPublicKey();
          if (!sshKey) {
            return json(res, 400, {
              error: 'ssh_public_key_required',
              message: 'VM / QEMU launch requires an SSH public key path on the executor host.',
              detail: 'Create ~/.ssh/agentic_ed25519.pub or pass ssh_key in the launch request.',
            });
          }
          if (!existsSync(sshKey)) {
            return json(res, 400, {
              error: 'ssh_public_key_not_found',
              message: `SSH public key not found at ${sshKey}`,
              detail: 'Choose an existing public key path on the executor host.',
            });
          }
          payload.ssh_key = sshKey;
        }
        const requestBody = JSON.stringify(payload);
        const before = await appendAudit('instance.launch.requested', {
          runtime: payload.runtime,
          name: payload.name,
          loadout: payload.loadout,
          start: payload.start,
        });
        const result = await fetchJsonFirst([
          {
            target: `${upstreamUrl}/api/v2/admin/instances`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: requestBody,
          },
        ]).catch((err) => ({ status: 502, body: bridgeErrorBody(err) }));
        const projected = managedDockerLaunchError(result.status, result.body);
        await appendAudit('instance.launch.result', { request_ts: before.ts, status: projected.status, result: projected.body });
        return json(res, projected.status, projected.body);
      }
      if ((m = url.pathname.match(/^\/api\/operations\/([^/]+)$/)) && req.method === 'GET') {
        return await proxyFirst(res, [
          `${upstreamUrl}/api/v2/admin/operations/${encodeURIComponent(m[1])}`,
        ]);
      }
      if (url.pathname === '/api/sessions') {
        const inst = url.searchParams.get('instance');
        if (!inst) return json(res, 400, { error: 'instance_required' });
        const result = await getSessions(upstreamUrl, inst);
        result.sessions = result.sessions.map((session) => ({
          ...session,
          attach_url: issueAttachUrl(req, session.attach_url),
        }));
        return json(res, 200, result);
      }
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)$/)) && req.method === 'DELETE') {
        const { status, body } = await endSession(upstreamUrl, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        return json(res, status, body);
      }
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/screen$/)) && req.method === 'GET') {
        const { status, body } = await getSessionScreen(upstreamUrl, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        return json(res, status, body);
      }
      // registry-bound, data-driven core — live, no app restart (#1592)
      if (url.pathname === '/api/capabilities') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json(res, 400, { error: 'q_required' });
        const rawLimit = url.searchParams.get('limit') ?? '8';
        const limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          return json(res, 400, { error: 'invalid_limit', detail: 'limit must be an integer from 1 to 50' });
        }
        const args = ['discover', q, '--json', '--limit', String(limit)];
        const type = url.searchParams.get('type');
        if (type && type !== 'all') {
          const types = type.split(',').map((t) => t.trim()).filter(Boolean);
          if (!types.length || types.some((t) => !CAPABILITY_TYPES.has(t))) {
            return json(res, 400, { error: 'invalid_type', detail: `type must be all or a comma list of: ${[...CAPABILITY_TYPES].join(', ')}` });
          }
          args.push('--type', types.join(','));
        }
        const data = JSON.parse(await runAiwg(args));
        data.results = (data.results || []).map((r) => ({
          ...r,
          name: r.name || (r.path ? deriveName(r.path) : ''),
        }));
        return json(res, 200, data);
      }
      if (url.pathname === '/api/show') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        const wantPath = url.searchParams.get('path');
        // Preferred path: resolve by the discovered file path. Deterministic even when a
        // name is shared by two artifacts (#1643). discover always returns this path.
        if (wantPath) {
          const resolved = resolveCorpusPath(wantPath);
          if (!resolved) return json(res, 400, { error: 'path_outside_corpus' });
          try {
            const body = await readFile(resolved, 'utf8');
            return json(res, 200, { type, name: name ?? deriveName(resolved), path: resolved, body });
          } catch (e) {
            return json(res, 404, bridgeErrorBody(e, 'artifact_not_found'));
          }
        }
        // Fallback: resolve by name via the CLI. Map ambiguity/not-found to 4xx — an
        // ambiguous name is operator-correctable input, never a Bridge 502.
        if (!type || !name) return json(res, 400, { error: 'type_name_or_path_required' });
        try {
          return json(res, 200, { type, name, body: await runAiwg(['show', type, name]) });
        } catch (e) {
          const detail = String(e?.message ?? e);
          const ambiguous = /ambiguous/i.test(detail);
          return json(res, ambiguous ? 409 : 404, bridgeErrorBody(e, ambiguous ? 'ambiguous_artifact' : 'artifact_not_found'));
        }
      }
      // user asset library — browse / clone-from-catalog / delete. AIWG install files
      // are never written; deletes are sandboxed to ~/.aiwg/cockpit/library.
      if (url.pathname === '/api/library' && req.method === 'GET') return json(res, 200, { library: await listLibrary() });
      if (url.pathname === '/api/library/clone' && req.method === 'POST') {
        try {
          return json(res, 201, await cloneToLibrary({
            type: url.searchParams.get('type'), name: url.searchParams.get('name'), path: url.searchParams.get('path'),
          }));
        } catch (e) { return json(res, 400, bridgeErrorBody(e, 'clone_failed')); }
      }
      {
        const lm = url.pathname.match(/^\/api\/library\/(.+)$/);
        if (lm && req.method === 'DELETE') {
          const libraryDir = currentLibraryDir();
          const target = inLibrary(decodeURIComponent(lm[1]));
          if (!target || target === libraryDir || !existsSync(target)) return json(res, 404, { error: 'not_in_library' });
          await rm(target, { recursive: true, force: true });
          return json(res, 200, { removed: decodeURIComponent(lm[1]) });
        }
      }

      // contribution model — declarative UI extension (#1591). Actions INJECT a command
      // into an agentic session (client-side, over the pty WS); the Bridge does NOT run
      // them. See adr-cockpit-session-control-not-cli-runner.md.
      if (url.pathname === '/api/contributions') return json(res, 200, await loadContributions());
      // --- start a session (the onboarding primary verb): create + issue attach_url ---
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/sessions$/)) && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const qs = new URLSearchParams();
        const mode = url.searchParams.get('mode'), backend = url.searchParams.get('backend'), loadout = url.searchParams.get('loadout');
        if (mode) qs.set('mode', mode);
        if (backend) qs.set('backend', backend);
        if (loadout) qs.set('loadout', loadout);
        const sessionAgentId = await resolveSessionAgentId(upstreamUrl, id);
        const sessionName = sessionNameFor(id, { mode: mode || 'managed', backend: backend || 'tmux' });
        let sessionLaunch = defaultSessionLaunch();
        try {
          const inventory = await getInventory(upstreamUrl);
          sessionLaunch = defaultSessionLaunch(inventory.instances.find((inst) => inst.id === id));
        } catch {
          // Session creation can still proceed without an explicit cwd; the
          // executor/agent will fall back to its own process cwd.
        }
        // No pre-create reuse lookup: every create request gets its own uniquely
        // named session (multi-session per instance is supported). Recovery by
        // name below still catches a create that timed out after succeeding.
        const sessionBody = JSON.stringify({
          session_name: sessionName,
          session_backend: backend || 'tmux',
          session_class: mode || 'managed',
          command: sessionLaunch.command,
          args: sessionLaunch.args,
          ...(sessionLaunch.working_dir ? { working_dir: sessionLaunch.working_dir } : {}),
        });
        const candidates = unique([sessionAgentId, id]).flatMap((agentId) => [
          {
            target: `${upstreamUrl}/api/v1/agents/${encodeURIComponent(agentId)}/sessions`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: sessionBody,
          },
          {
            target: `${upstreamUrl}/agents/${encodeURIComponent(agentId)}/sessions?${qs.toString()}`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: sessionBody,
          },
        ]);
        let sessionCreate;
        try {
          sessionCreate = await fetchJsonFirst(candidates, { timeoutMs: 8000 });
        } catch (err) {
          try {
            const reusable = await findReusableSession(upstreamUrl, id, sessionName);
            if (reusable) return json(res, 200, sessionResponseFromRow(reusable));
          } catch {
            // Preserve the original create failure; reuse is a recovery path only.
          }
          return json(res, 409, {
            ...bridgeErrorBody(err, 'agent_not_registered'),
            message: 'The instance is visible in inventory, but its agent has not registered yet; PTY sessions are not ready.',
          });
        }
        const { status, body } = sessionCreate;
        if (status < 200 || status >= 300) {
          try {
            const reusable = await findReusableSession(upstreamUrl, id, sessionName);
            if (reusable) return json(res, 200, sessionResponseFromRow(reusable));
          } catch {
            // Return the upstream non-2xx response when no reusable session is visible.
          }
          return json(res, status, body);
        }
        const wsBase = upstreamUrl.replace(/^http/i, 'ws');
        const sessionId = body.id ?? body.session_id ?? body.sessionId;
        if (status >= 200 && status < 300 && !sessionId && !body.attach_url && !body.attachUrl && !body.pty_ws_url && !body.ptyWsUrl) {
          return json(res, 502, bridgeErrorBody(new Error(JSON.stringify(body)), 'session_create_missing_id'));
        }
        let attachUrl = body.attach_url ?? body.attachUrl;
        if (!attachUrl && (body.pty_ws_url ?? body.ptyWsUrl)) {
          try {
            const u = new URL(String(body.pty_ws_url ?? body.ptyWsUrl).replace('{host}', new URL(upstreamUrl).host));
            u.protocol = new URL(upstreamUrl).protocol === 'https:' ? 'wss:' : 'ws:';
            attachUrl = u.toString();
          } catch { /* fall through to legacy shape */ }
        }
        // Same as the list path (#1671): the attach segment must be the instance
        // id the executor's pty-ws route accepts, not the resolved agent name.
        await appendAudit('session.start.requested', { instance_id: id, mode: mode || 'managed', backend: backend || 'tmux', loadout, status, session_id: sessionId, session_name: sessionName });
        const executorAttachUrl = attachUrl ?? `${wsBase}/agents/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/attach`;
        return json(res, status, {
          ...body,
          id: sessionId,
          session_name: body.session_name ?? body.sessionName ?? sessionName,
          attach_url: issueAttachUrl(req, executorAttachUrl),
        });
      }

      // --- management surface (UC-012): lifecycle + task cancel ---
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/(snapshot|checkpoint|restore|fork|warm-pool)$/)) && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const instanceId = decodeURIComponent(m[1]);
        const action = m[2];
        const body = parsed.body || {};
        const before = await appendAudit('instance.fast_start.requested', {
          instance_id: instanceId,
          action,
          asset_ref: body.asset_ref ?? body.assetRef ?? body.snapshot_id ?? body.snapshotId ?? body.checkpoint_id ?? body.checkpointId ?? body.pool,
          name: body.name ?? body.child_name ?? body.childName,
        });
        const result = await providerFastStartAction(upstreamUrl, instanceId, action, body);
        await appendAudit('instance.fast_start.accepted', {
          request_ts: before.ts,
          instance_id: instanceId,
          action,
          status: result.status,
          operation_id: result.body?.id ?? result.body?.operation?.id,
          result: result.body,
        });
        return json(res, result.status, result.body);
      }
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/(start|stop)$/)) && req.method === 'POST') {
        const result = await fetchJsonFirst([
          `${upstreamUrl}/admin/instances/${encodeURIComponent(m[1])}/${m[2]}`,
          `${upstreamUrl}/api/v2/admin/instances/${encodeURIComponent(m[1])}/${m[2]}`,
        ], { method: 'POST' }).catch((err) => ({ status: 502, body: bridgeErrorBody(err) }));
        await appendAudit('instance.lifecycle.requested', { instance_id: decodeURIComponent(m[1]), action: m[2], status: result.status, result: result.body });
        return json(res, result.status, result.body);
      }
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)\/reconnect$/)) && req.method === 'POST') {
        const { status, body } = await reconnectInstance(upstreamUrl, decodeURIComponent(m[1]));
        await appendAudit('instance.reconnect.requested', { instance_id: decodeURIComponent(m[1]), status, result: body });
        return json(res, status, body);
      }
      if ((m = url.pathname.match(/^\/api\/instances\/([^/]+)$/)) && req.method === 'DELETE') {
        const { status, body } = await destroyInstance(upstreamUrl, decodeURIComponent(m[1]));
        await appendAudit('instance.destroy.requested', { instance_id: decodeURIComponent(m[1]), status, result: body });
        return json(res, status, body);
      }
      if ((m = url.pathname.match(/^\/api\/missions\/([^/]+)\/(pause|resume)$/)) && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const result = await controlMission({
          action: m[2],
          sessionId: decodeURIComponent(m[1]),
          expectedUpdatedAt: parsed.body?.expected_updated_at,
          requestId: parsed.body?.request_id,
        });
        return json(res, 200, { ...result, projection: await getMissions(upstreamUrl) });
      }
      if ((m = url.pathname.match(/^\/api\/missions\/([^/]+)\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        const result = await controlMission({
          action: 'cancel',
          sessionId: decodeURIComponent(m[1]),
          missionId: decodeURIComponent(m[2]),
          expectedUpdatedAt: parsed.body?.expected_updated_at,
          requestId: parsed.body?.request_id,
        });
        return json(res, 200, { ...result, projection: await getMissions(upstreamUrl) });
      }
      if ((m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const instanceId = decodeURIComponent(m[1]);
        const taskId = decodeURIComponent(m[2]);
        await appendAudit('task.cancel.requested', { instance_id: instanceId, task_id: taskId });
        const agentId = await resolveSessionAgentId(upstreamUrl, instanceId);
        const result = await negotiatedCockpitA2ARequest(upstreamUrl, agentId, (selected) => {
          const request = (target) => ({
            target,
            method: 'POST',
            headers: cockpitA2AHeaders(selected.protocol_version, true),
            body: '{}',
          });
          return selected.protocol_version === '1.0'
            ? [request(`${selected.url}/tasks/${encodeURIComponent(taskId)}:cancel`)]
            : [
                request(`${selected.url}/v1/tasks/${encodeURIComponent(taskId)}/cancel`),
                request(`${selected.url}/tasks/${encodeURIComponent(taskId)}/cancel`),
                request(`${upstreamUrl}/api/v1/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/cancel`),
              ];
        });
        await appendAudit('task.cancel.protocol', {
          instance_id: instanceId,
          task_id: taskId,
          selected_version: result.selected.protocol_version,
          protocol_binding: result.selected.protocol_binding,
          ...(result.fallbackReason ? { fallback_reason: result.fallbackReason } : {}),
        });
        return json(res, result.status, normalizeCockpitA2ATaskResponse(result.body));
      }

      // --- approval inbox (UC-009) + cost (UC-010) ---
      if (url.pathname === '/api/approvals' && req.method === 'GET')
        return json(res, 200, await getApprovals(upstreamUrl, url.searchParams.get('status') || 'pending'));
      if ((m = url.pathname.match(/^\/api\/approvals\/([^/]+)$/)) && req.method === 'POST') {
        const approvalId = decodeURIComponent(m[1]);
        const decision = url.searchParams.get('decision') || '';
        const { status, body } = await respondApproval(upstreamUrl, approvalId, decision);
        await appendAudit('approval.response.submitted', { approval_id: approvalId, decision, status, result: body });
        return json(res, status, body);
      }
      if (url.pathname === '/api/cost' && req.method === 'GET')
        return await proxy(res, 'GET', `${upstreamUrl}/admin/cost`);

      if (url.pathname === '/api/health') return json(res, 200, {
        status: 'ok',
        executor_url: upstreamUrl,
        mock_executor_allowed: allowMockExecutor,
        executor_auth_configured: Boolean(executorTokenFile),
        a2a_protocol: {
          policy: a2aProtocolPolicy,
          fallback_enabled: Boolean(allowA2AProtocolFallback),
        },
        executor: await getExecutorCapabilities(upstreamUrl),
        // Runtime feature gate for the desktop panel (#2547): the browser shows
        // desktop controls only when both the identity verifier and the
        // dedicated desktop backend are configured on this Bridge.
        desktop: { configured: Boolean(desktopIdentity && desktopBackend) },
      });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const distIndex = join(WEB_DIST, 'index.html');
        const src = existsSync(distIndex) ? distIndex : join(__dir, 'public', 'index.html');
        const raw = await readFile(src, 'utf8');
        // The app exchanges a one-time nonce from the URL fragment for an
        // HttpOnly session. No reusable credential is injected into HTML.
        const html = raw;
        // Never cache the shell or bootstrap-bearing navigation.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host} wss://${req.headers.host}; frame-ancestors 'self' vscode-webview: tauri:`,
          'referrer-policy': 'no-referrer',
        });
        return res.end(html);
      }
      // static assets from the built web app (e.g. /assets/*.js, *.css)
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
        if (await serveDistFile(res, url.pathname)) return;
      }
      json(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      const status = Number(err?.status) || Number(err?.upstreamStatus) || 502;
      json(res, status, bridgeErrorBody(err));
    }
  };
  const server = http.createServer((req, res) => executorRequestContext.run(
    requestContext,
    () => handleRequest(req, res),
  ));
  server.on('upgrade', (req, socket, head) => executorRequestContext.run(
    requestContext,
    async () => {
      try {
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const match = url.pathname.match(/^\/api\/pty\/agents\/[^/]+\/sessions\/[^/]+\/attach\/([^/]+)$/);
        if (!match || !validBrowserOrigin(req)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        if (!websocketAuthed(req, TOKEN) && !sessionAuth(req)) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return;
        }
        const target = attachTargets.get(match[1]);
        if (!target || url.pathname !== `/api/pty${target.pathname}/${match[1]}`) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          return;
        }
        await proxyExecutorWebsocket({ req, socket, head, target, executorTokenFile, executorUrl: upstreamUrl });
      } catch {
        if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    },
  ));
  server.cockpitToken = TOKEN; // exposed for shells/tests
  const desktopHttp = createDesktopHttpHandler({ identity: desktopIdentity, backend: desktopBackend,
    getAuth: sessionAuth, validOrigin: validDesktopBrowserOrigin, validCsrf, json });
  server.issueBootstrapNonce = issueBootstrapNonce;
  // Called by a trusted organizational login adapter after code/device-flow
  // completion. No public request route accepts raw identity binding fields.
  server.bindDesktopIdentity = async (req, { workspaceId, evidence }) => {
    const auth = sessionAuth(req);
    if (!auth || !desktopIdentity) throw executorAuthError('desktop_identity_denied', 'desktop identity unavailable');
    const result = await desktopIdentity.bind({
      browserSessionId: auth.sessionId, audience: auth.desktopAudience, workspaceId, evidence,
    });
    if (!sessionAuth(req)) {
      desktopIdentity.logout(auth.sessionId);
      throw executorAuthError('desktop_identity_denied', 'desktop identity unavailable');
    }
    return result;
  };
  const expireDesktopSessions = desktopIdentity ? setInterval(() => {
    for (const [id, session] of browserSessions) {
      if (session.expiresAt <= Date.now()) {
        browserSessions.delete(id);
        desktopIdentity.logout(id);
      }
    }
  }, 1000) : null;
  expireDesktopSessions?.unref();
  server.once('close', () => {
    desktopHttp.close();
    if (expireDesktopSessions) clearInterval(expireDesktopSessions);
    for (const id of browserSessions.keys()) desktopIdentity?.logout(id);
    browserSessions.clear();
    bootstrapNonces.clear();
  });
  return server;
}

// The agentic-sandbox canonical dev runner (`management/dev.sh`) binds
// 8120 (gRPC) / 8121 (WS) / 8122 (HTTP). The Bridge must NOT default into that
// range or it squats on the executor's own ports (#1634). Default off-range and
// refuse to silently start on a reserved port.
export const EXECUTOR_RESERVED_PORTS = [8120, 8121, 8122];
export const DEFAULT_BRIDGE_PORT = 8140;

/**
 * npm exposes package binaries through symlinks. Node preserves that symlink
 * in process.argv[1] while import.meta.url names the real module, so comparing
 * the two strings makes an installed `aiwg-cockpit` silently skip startup.
 */
export function isDirectExecution(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(metaUrl) === resolve(argv1);
  }
}

/** Resolve the Bridge listen port from the environment with a sane, off-range
 *  default. Throws on an invalid port or a collision with the executor range. */
export function resolveBridgePort(env = process.env) {
  const raw = env.PORT ?? env.AIWG_COCKPIT_BRIDGE_PORT;
  const port = raw === undefined || raw === '' ? DEFAULT_BRIDGE_PORT : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Bridge port: ${JSON.stringify(raw)} (set PORT to a number 1-65535).`);
  }
  if (EXECUTOR_RESERVED_PORTS.includes(port)) {
    throw new Error(
      `Bridge port ${port} collides with the agentic-sandbox canonical range ` +
      `(${EXECUTOR_RESERVED_PORTS.join('/')} = gRPC/WS/HTTP). The executor needs that ` +
      `range — pick another port (default ${DEFAULT_BRIDGE_PORT}).`,
    );
  }
  return port;
}

if (isDirectExecution()) {
  const port = resolveBridgePort();
  await ensureExecutor(EXECUTOR_URL);
  const server = createBridge();
  server.listen(port, '127.0.0.1', async () => {
    try {
      const file = await writeRuntimeToken({ token: server.cockpitToken, port, pid: process.pid });
      const browserNonce = server.issueBootstrapNonce('browser');
      console.log(`[cockpit-bridge] http://127.0.0.1:${port}  (executor ${EXECUTOR_URL})`);
      console.log(`  runtime handshake ${file} (mode 600)`);
      console.log(`  browser bootstrap http://127.0.0.1:${port}/#bootstrap=${browserNonce}&audience=browser (one-time, 60s)`);
    } catch (err) {
      console.error(`[cockpit-bridge] failed to persist runtime token: ${String(err?.message ?? err)}`);
      server.close(() => process.exit(1));
    }
  });
}
