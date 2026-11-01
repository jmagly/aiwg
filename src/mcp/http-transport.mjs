// Dedicated authenticated Streamable HTTP listener; one SDK server per session.
import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.mjs';
import { resolveProjectAiwgDir } from './helpers.mjs';
import { pinContainedRoot } from '../utils/contained-filesystem.mjs';
import { remoteToolPolicy } from './http-tools.mjs';
import { parseHttpOptions, boundedInteger, tokenSource, hostPolicy } from './http-options.mjs';

const BODY_LIMIT = 1024 * 1024;

function reply(response, status, message) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

async function readBody(request, response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      // Close this connection after the response, rather than drain an unlimited body.
      response.setHeader('Connection', 'close');
      reply(response, 413, 'Request body exceeds 1 MiB');
      return undefined;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { reply(response, 400, 'Invalid JSON'); }
}

export async function startHttpServer(options) {
  const host = options.host === '[::1]' ? '::1' : options.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !options.allowRemoteBind) {
    throw new Error('A non-loopback --host requires --allow-remote-bind');
  }
  const port = boundedInteger(options.port ?? 3100, '--port', 0, 65535);
  const maxSessions = boundedInteger(options.maxSessions ?? 8, '--max-sessions', 1, 65535);
  if (!options.projectDir) throw new Error('HTTP requires --project <dir>');
  const projectDir = await fs.realpath(options.projectDir);
  const projectIdentity = await fs.stat(projectDir);
  if (!projectIdentity.isDirectory()) throw new Error('--project must be a directory');
  const authenticate = await tokenSource(options);
  const permittedHost = hostPolicy(host, options.allowedHosts);
  const artifactStore = await pinContainedRoot(await resolveProjectAiwgDir(projectDir), projectDir);
  if (artifactStore.error) throw new Error('Project artifact root is unavailable');
  const policies = new WeakMap();
  const sessions = new Map();
  const entries = new Set(); // Includes pending initializes, so concurrent admission is bounded.
  const idleMs = options.idleTimeoutMs ?? 300_000;
  let closing = false;
  let stopPromise;
  const buildServer = async () => {
    const policy = remoteToolPolicy(projectDir, options.tools);
    const mcp = await createServer({ projectDir, artifactStore, toolsets: options.toolsets ?? '', configureTool: policy.configureTool });
    try { policy.validate(); } catch (error) { await mcp.close(); throw error; }
    policies.set(mcp, policy);
    return mcp;
  };
  // Validate tool selection and registration before binding the listener.
  let warmServer = await buildServer();
  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (policies.get(entry.mcp)?.busy()) touch(entry);
      else void dispose(entry);
    }, idleMs);
    entry.timer.unref();
  }
  async function dispose(entry) {
    if (entry.disposing) return entry.disposing;
    sessions.delete(entry.transport?.sessionId);
    clearTimeout(entry.timer);
    entry.disposing = (async () => {
      try {
        await entry.ready?.catch(() => {});
        await entry.mcp?.close();
        await policies.get(entry.mcp)?.drain();
      }
      finally { entries.delete(entry); }
    })();
    return entry.disposing;
  }
  async function newSession(token) {
    const entry = { token };
    entries.add(entry);
    try {
      entry.mcp = warmServer;
      warmServer = undefined;
      entry.ready = entry.mcp ? Promise.resolve(entry.mcp) : buildServer();
      entry.mcp = await entry.ready;
      if (closing) throw new Error('Listener is draining');
      entry.transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { sessions.set(id, entry); touch(entry); },
        onsessionclosed: () => { void dispose(entry); },
      });
      await entry.mcp.connect(entry.transport);
      const sdkClose = entry.transport.onclose;
      entry.transport.onclose = () => {
        sdkClose?.();
        sessions.delete(entry.transport?.sessionId);
        clearTimeout(entry.timer);
        entries.delete(entry);
      };
      return entry;
    } catch (error) {
      entries.delete(entry);
      await entry.mcp?.close();
      throw error;
    }
  }
  const listener = http.createServer(async (request, response) => {
    let created;
    try {
      if (closing) return reply(response, 503, 'Listener is draining');
      const token = await authenticate(request.headers.authorization);
      if (!token) return reply(response, 401, 'Unauthorized');
      if (!permittedHost(request.headers)) return reply(response, 403, 'Host or Origin is not allowed');
      if (request.url !== '/mcp') return reply(response, 404, 'Not found');
      if (!['POST', 'GET', 'DELETE'].includes(request.method)) return reply(response, 405, 'Method not allowed');
      const identity = await fs.stat(projectDir);
      if (await fs.realpath(projectDir) !== projectDir || identity.dev !== projectIdentity.dev || identity.ino !== projectIdentity.ino) {
        return reply(response, 503, 'Pinned project changed; restart the listener');
      }
      const id = request.headers['mcp-session-id'];
      let entry = id && sessions.get(id);
      if (id && (!entry || !timingSafeEqual(entry.token, token) || entry.disposing)) {
        return reply(response, 404, 'Unknown session; initialize again');
      }
      if (Number(request.headers['content-length']) > BODY_LIMIT) {
        response.setHeader('Connection', 'close');
        return reply(response, 413, 'Request body exceeds 1 MiB');
      }
      if (request.method !== 'POST' && (request.headers['transfer-encoding'] || Number(request.headers['content-length']) > 0)) {
        response.setHeader('Connection', 'close');
        return reply(response, 400, 'Only POST requests may carry a body');
      }
      const body = request.method === 'POST' ? await readBody(request, response) : undefined;
      if (response.writableEnded || response.destroyed) return;
      if (closing) return reply(response, 503, 'Listener is draining');
      if (entry?.disposing) return reply(response, 404, 'Unknown session; initialize again');
      if (entry && isInitializeRequest(body)) return reply(response, 404, 'Session ID cannot be reused for initialization');
      if (!entry) {
        if (request.method !== 'POST' || !isInitializeRequest(body)) return reply(response, 400, 'Initialize a new session first');
        if (entries.size >= maxSessions) return reply(response, 503, 'Maximum sessions reached');
        entry = created = await newSession(token);
      }
      touch(entry);
      await entry.transport.handleRequest(request, response, body);
      if (created && !entry.transport.sessionId) await dispose(entry);
    } catch {
      if (created) await dispose(created);
      reply(response, 500, 'MCP transport failed'); // Never log credentials, inputs or SDK errors containing them.
    }
  });
  listener.requestTimeout = 30_000;
  listener.headersTimeout = 10_000;
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, host, resolve);
    });
  } catch (error) { await warmServer?.close(); throw error; }
  if (!loopback) console.error('WARNING: remote MCP bind enabled; use a trusted TLS proxy and firewall.');
  const closed = new Promise(resolve => listener.once('close', resolve));
  function close() {
    stopPromise ??= (async () => {
      closing = true;
      listener.close();
      await Promise.allSettled([...entries].map(dispose));
      await warmServer?.close();
      listener.closeAllConnections();
      await closed;
    })();
    return stopPromise;
  }
  return { listener, close, closed, projectDir, sessionCount: () => entries.size };
}

export async function serveHttp(args) {
  const service = await startHttpServer(parseHttpOptions(args));
  const address = service.listener.address();
  console.error(`AIWG MCP HTTP listening on ${address.address}:${address.port}/mcp`);
  const stop = () => { void service.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await service.closed; }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await service.close();
  }
}
