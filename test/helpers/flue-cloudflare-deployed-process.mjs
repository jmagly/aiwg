// Bound subprocess lifetimes and scrub secrets before exposing any captured diagnostics.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function requireDeployedOptIn(env = process.env) {
  const missing = ['AIWG_FLUE_CF_DEPLOY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
    .filter(key => key === 'AIWG_FLUE_CF_DEPLOY' ? env[key] !== '1' : !env[key]?.trim());
  if (missing.length) throw new Error(`Refusing deployed Cloudflare check: explicitly set AIWG_FLUE_CF_DEPLOY=1, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Missing/invalid: ${missing.join(', ')}. This paid check is manual only.`);
}
export default function deployedGate() { requireDeployedOptIn(); }
export const workerName = () => `aiwg-flue-check-${randomBytes(12).toString('hex')}`;
export function tunnelUrl(output) {
  return /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/|\x1b]|$)/i.exec(output)?.[0];
}
export function createRedactor(secrets = []) {
  const values = new Set();
  function add(secret) {
    if (!secret) return;
    for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) values.add(value);
  }
  secrets.forEach(add);
  const redact = value => {
    let result = String(value);
    for (const secret of [...values].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result.replace(/(Bearer\s+)[^\s"'\\]+/gi, '$1[REDACTED]');
  };
  redact.add = add;
  return redact;
}
export function processRunner({ cwd, env, redact = String }) {
  const children = new Map();
  function start(command, args) {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let output = '', failure;
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.stdin.on('error', () => {}); // EPIPE is diagnosed by the command's exit status.
    const closed = new Promise(resolve => {
      child.once('error', error => { failure = error; });
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
    });
    children.set(child, closed);
    function kill(signal) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    async function stop() {
      if (!children.has(child)) return;
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    return { child, closed, stop, output: () => redact(output), failed: () => failure || child.exitCode !== null || child.signalCode !== null };
  }
  async function run(command, args, { input = '', timeout = 120_000 } = {}) {
    const task = start(command, args);
    task.child.stdin.end(input);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void task.stop(); }, timeout);
    try {
      const { code, signal } = await task.closed;
      if (code !== 0 || signal || timedOut) throw new Error(redact(`${command} ${args.join(' ')} failed (${timedOut ? 'timeout' : code ?? signal}):\n${task.output()}`));
      return task.output();
    } finally { clearTimeout(timer); }
  }
  return { start, run, async stopAll() {
    for (const child of children.keys()) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.all(children.values());
  } };
}
export async function startTunnel(runner, executable, url, timeout = 30_000, settle = 1_000) {
  // Present the loopback Host to the D9 listener so its DNS-rebinding guard stays unchanged.
  const origin = new URL(url);
  const task = runner.start(executable, ['tunnel', '--url', origin.origin, '--http-host-header', origin.host]);
  task.child.stdin.end();
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      if (task.failed()) throw new Error(`cloudflared exited before tunnel readiness:\n${task.output()}`);
      const origin = tunnelUrl(task.output());
      if (origin) {
        // cloudflared can print its URL and then exit; ready means still running after a settle window.
        await delay(settle);
        if (task.failed()) throw new Error(`cloudflared exited before tunnel readiness:\n${task.output()}`);
        return { ...task, url: `${origin}/mcp` };
      }
      await delay(25);
    }
    throw new Error(`cloudflared tunnel URL timeout (${timeout}ms):\n${task.output()}`);
  } catch (error) { await task.stop(); throw error; }
}
// Split `wrangler tail --format json` output (pretty-printed objects) into whole events.
export function tailObjects(output) {
  const objects = [];
  let index = 0;
  while ((index = output.indexOf('{', index)) >= 0) {
    let depth = 0, end = -1, quoted = false, escaped = false;
    for (let i = index; i < output.length; i++) {
      const char = output[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    const raw = output.slice(index, end + 1);
    try { objects.push({ raw, event: JSON.parse(raw) }); } catch { /* Not a tail event object. */ }
    index = end + 1;
  }
  return objects;
}
// The version that served each request.
export function tailEvents(output) {
  return tailObjects(output).map(({ event }) => ({ version: event?.scriptVersion?.id, url: event?.event?.request?.url }))
    .filter(event => typeof event.url === 'string');
}
