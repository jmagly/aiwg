/**
 * Conductor-side stdin framing for resolved worker invocations (#2911).
 *
 * `stdin: 'brief-json'` means the worker reads one JSON params document on
 * stdin, built by the conductor from the brief file and closed at EOF. The
 * brief stays the source of truth and is never copied into argv, so prompt
 * text cannot surface in /proc/<pid>/cmdline, unit properties or argv logs.
 * The document is the OpenHuman agent.chat params shape (`message`,
 * `model_override`, `cwd`; tinyhumansai/openhuman@216ea32
 * crates/openhuman-core/src/agent/schemas.rs:97-105), consumed by
 * `call --params-stdin`, which reads stdin to EOF (core/cli.rs:445-468).
 *
 * Shared by the #2887 shell renderer (as a pipeline stage) and the attached
 * one-shot launcher (written to the child's stdin pipe).
 */
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const WORKER_STDIN_FRAME_MAX_BRIEF_BYTES = 262144;
export const WORKER_STDIN_FRAME_MAX_BYTES = 1048576;

/** @returns {string} the exact JSON document delivered on stdin. */
export function workerStdinDocument({ brief, model, cwd }) {
  const text = Buffer.isBuffer(brief) ? new TextDecoder('utf-8', { fatal: true }).decode(brief) : brief;
  if (typeof text !== 'string') throw new Error('brief-json framing requires brief text');
  if (typeof model !== 'string' || !model || model.includes('\0')) throw new Error('brief-json framing requires an explicit model');
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw new Error('brief-json framing requires an absolute workspace');
  return JSON.stringify({ message: text, model_override: model, cwd });
}

/** Stdin bytes for a resolved invocation: null (closed), the raw brief, or the framed document. */
export function workerStdinBytes(invocation, brief, adapter) {
  if (invocation.stdin === 'closed') return null;
  if (invocation.stdin === 'brief-text') return Buffer.isBuffer(brief) ? brief : Buffer.from(brief);
  if (invocation.stdin === 'brief-json') {
    return Buffer.from(workerStdinDocument({ brief, model: invocation.selected?.model, cwd: invocation.cwd }));
  }
  if (invocation.stdin === 'adapter-frame') {
    if (typeof adapter?.buildWorkerStdinFrame !== 'function') throw new Error('Installed adapter stdin framer is required');
    if (Buffer.byteLength(brief) > WORKER_STDIN_FRAME_MAX_BRIEF_BYTES) throw new Error('Brief exceeds the framing bound');
    const frame = adapter.buildWorkerStdinFrame(brief, invocation);
    if (typeof frame !== 'string' && !(frame instanceof Uint8Array)) throw new Error('Adapter stdin frame must be bytes or text');
    if (Buffer.byteLength(frame) === 0) throw new Error('Adapter stdin frame must not be empty');
    if (Buffer.byteLength(frame) > WORKER_STDIN_FRAME_MAX_BYTES) throw new Error('Adapter stdin frame exceeds byte bound');
    return Buffer.from(frame);
  }
  throw new Error(`Unsupported worker stdin mode: ${invocation.stdin}`);
}

async function readBounded(filename) {
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > WORKER_STDIN_FRAME_MAX_BRIEF_BYTES) throw new Error('Brief must be a bounded regular file');
    const bytes = Buffer.alloc(WORKER_STDIN_FRAME_MAX_BRIEF_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > WORKER_STDIN_FRAME_MAX_BRIEF_BYTES) throw new Error('Brief exceeds the framing bound');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

/** Bound host authority only; workspace is an execution scope, never a config source. */
export async function recordedWorkerStdinBytes({ filename, workspace, cli, adapterId, scopeDigest, briefDigest,
  storePath, storeDigest, policy, model }) {
  if (!filename?.startsWith('/') || !storePath?.startsWith('/')
    || !/^sha256:[a-f0-9]{64}$/.test(storeDigest ?? '')) throw new Error('Invalid adapter stdin framing request');
  const { loadRecordedWorkerInstallations } = await import('../models/worker-installation.mjs');
  const { loadProviderModelCapabilities } = await import('../models/provider-policy.js');
  const { drivers } = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(),
    cwd: workspace, policy, cli, storePath, storeDigest });
  const driver = drivers[cli];
  if (!driver || driver.qualification.adapterId !== adapterId
    || driver.qualification.adapter.invocation.stdin !== 'adapter-frame'
    || driver.qualification.installation?.evidence?.scopeDigest !== scopeDigest) throw new Error('Adapter stdin binding changed');
  const brief = await readBounded(filename);
  if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== briefDigest) throw new Error('Adapter stdin brief changed');
  return workerStdinBytes({ stdin: 'adapter-frame', selected: { model } }, brief, driver);
}

// Pipeline stage: `worker-stdin-frame.mjs BRIEF_PATH MODEL CWD`. Only the
// brief path, never its content, appears on this command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [briefPath, model, cwd] = process.argv.slice(2);
  try {
    if (briefPath === '--adapter-frame') {
      const [filename, workspace, cli, adapterId, scopeDigest, briefDigest, storePath, storeDigest, policyJson, selectedModel] = process.argv.slice(3);
      if (process.argv.length !== 13) throw new Error('Invalid adapter stdin framing request');
      // Reuse the recorded-installation loader; no module path or code supplied
      // by a brief is ever imported. The conductor binds store bytes and policy;
      // never resolve configuration from the worker-writable workspace.
      process.stdout.write(await recordedWorkerStdinBytes({ filename, workspace, cli, adapterId, scopeDigest, briefDigest,
        storePath, storeDigest, policy: JSON.parse(policyJson) ?? undefined, model: selectedModel }));
    } else {
      if (process.argv.length !== 5 || !briefPath?.startsWith('/')) throw new Error('usage: worker-stdin-frame.mjs BRIEF_PATH MODEL CWD');
      process.stdout.write(workerStdinDocument({ brief: await readBounded(briefPath), model, cwd }));
    }
  } catch (error) {
    process.stderr.write(`worker-stdin-frame: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
