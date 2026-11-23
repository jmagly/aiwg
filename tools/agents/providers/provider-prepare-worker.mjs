#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { main as deployProvider, parseArgs } from '../deploy-agents.mjs';
import { retainPreparationChannel } from './provider-prepare-channel.mjs';
import {
  importRuleDeploymentInputPool,
  disposeRuleDeploymentInputPool,
  installRuleDeploymentPreparationHook,
} from './rule-delivery.mjs';

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validRequest(request) {
  return exactKeys(request, ['version', 'type', 'capability', 'jobId', 'order', 'attempt', 'provider', 'target', 'args', 'scratch', 'inputPool']) &&
    request.version === 1 && request.type === 'prepare' && /^[a-f0-9]{64}$/.test(request.capability) &&
    typeof request.jobId === 'string' && Number.isSafeInteger(request.order) && request.order >= 0 &&
    (request.attempt === 0 || request.attempt === 1) && typeof request.provider === 'string' && request.provider &&
    typeof request.target === 'string' && path.isAbsolute(request.target) && typeof request.scratch === 'string' && path.isAbsolute(request.scratch) &&
    Array.isArray(request.args) && request.args.every(value => typeof value === 'string');
}

function publish(message) {
  return new Promise(resolve => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
}

// Importing provider helpers must not consume the caller's IPC messages.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) process.once('message', async request => {
  retainPreparationChannel();
  if (!validRequest(request)) {
    await publish({ version: 1, type: 'error', capability: request?.capability || '', jobId: request?.jobId || '', error: { message: 'Invalid provider preparation request' } });
    try { process.disconnect(); } catch {}
    return;
  }
  let pool;
  let clearHook = () => {};
  let response;
  try {
    const stat = fs.lstatSync(request.scratch);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(request.scratch).length) throw new Error('Invalid provider preparation scratch directory');
    const parsed = parseArgs(request.args);
    if (parsed.provider !== request.provider || path.resolve(parsed.target) !== path.resolve(request.target)) {
      throw new Error('Provider preparation request does not match its deployment arguments');
    }
    pool = importRuleDeploymentInputPool(request.inputPool);
    let detached;
    clearHook = installRuleDeploymentPreparationHook({
      scratch: request.scratch,
      inputPool: pool,
      accept: plan => {
        if (detached) throw new Error('Provider attempted more than one transactional preparation');
        detached = plan;
      },
    });
    await deployProvider(request.args);
    if (!detached) throw new Error('Provider did not produce a transactional preparation plan');
    if (detached.target !== path.resolve(request.target)) throw new Error('Provider preparation target mismatch');
    const body = Buffer.from(JSON.stringify(detached));
    const planPath = path.join(request.scratch, 'plan.json');
    const fd = fs.openSync(planPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    response = {
      version: 1,
      type: 'prepared',
      capability: request.capability,
      jobId: request.jobId,
      plan: { path: planPath, size: body.length, sha256: createHash('sha256').update(body).digest('hex') },
    };
  } catch (error) {
    response = { version: 1, type: 'error', capability: request.capability, jobId: request.jobId,
      error: { message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearHook();
    if (pool) disposeRuleDeploymentInputPool(pool);
  }
  await publish(response);
  try { process.disconnect(); } catch {}
});
