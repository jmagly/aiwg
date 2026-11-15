// Refuse unsafe publication requests before protected checks execute.
import { closeSync, fstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { boundedPrivateRead } from './worker-inputs.mjs';
import { parseStrictWorkerJson } from './strict-worker-json.mjs';
import { digestArtifactFd, pinArtifact, resolveWorktreeRoot } from './trusted-verification.mjs';

export class WorkerDeliveryRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
const refuse = (code, message) => { throw new WorkerDeliveryRefusal(code, message); };

export function requireDeliveryArtifact(artifactPath, finalPath) {
  if (!artifactPath) refuse('ARTIFACT_REQUIRED', 'publication requires explicit artifact_path / --artifact');
  if (finalPath && realpathSync(artifactPath) === realpathSync(finalPath)) {
    refuse('ARTIFACT_REQUIRED', 'artifact_path / --artifact must name a deliverable, never the worker final / handoff wrapper');
  }
}

export async function readDeliveryExit(runDir, inspect) {
  try {
    const exit = JSON.parse((await boundedPrivateRead(join(runDir, 'exit.json'), 1048576, inspect, true, true)).toString('utf8'));
    if (typeof exit?.endedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(exit.endedAt)
      || !Number.isFinite(Date.parse(exit.endedAt))) {
      throw new Error('exit.json requires an ISO endedAt');
    }
    return exit;
  } catch (error) {
    refuse('EXIT_EVIDENCE_MISSING', `publication requires readable launcher exit.json with endedAt (${error.message})`);
  }
}

const probes = new Set(['test', '[', 'stat', 'ls', 'true', 'file', 'wc']);
// This is a narrow argv heuristic, not proof that a check asserts correctness.
// Probe binaries with only path/flag operands cannot qualify. Other checks
// must mention the artifact, its basename, or a containing directory in args.
export function isContentFreeCheck(check, artifactPath) {
  const args = check.args ?? [];
  let command = check.command;
  try { command = realpathSync(command); } catch { /* The verifier refuses unavailable binaries. */ }
  const pathOrFlag = arg => arg.startsWith('-') || isAbsolute(arg) || arg === basename(artifactPath) || !/[;&|<>$`"'(){}]/.test(arg);
  if ((probes.has(basename(check.command)) || probes.has(basename(command))) && args.every(pathOrFlag)) return true;
  const references = [artifactPath, basename(artifactPath)];
  for (let directory = dirname(artifactPath); directory !== dirname(directory); directory = dirname(directory)) references.push(directory);
  return !args.some(arg => references.some(ref => arg.includes(ref)));
}

async function claimedArtifacts(finalPath, inspect) {
  if (!finalPath) return [];
  const bytes = await boundedPrivateRead(finalPath, 1048576, inspect);
  let final;
  try { final = parseStrictWorkerJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 64); }
  catch (error) {
    // Unstructured handoff text is supported; ambiguous JSON claims are not.
    if (error.code === 'SYNTAX') return [];
    throw error;
  }
  return [final?.artifacts, final?.result?.artifacts].flatMap(value => Array.isArray(value) ? value : []);
}

export async function prepareWorkerDeliveryGuard({ worktreeRoot, artifactPath, finalPath, checks, exit, inspect }) {
  const claims = await claimedArtifacts(finalPath, inspect);
  // Run on the verifier's own pinned descriptor and digest, leaving no gap
  // between request validation and the bytes the checks will accept.
  const guard = (pinned, digest) => {
    const cutoff = Date.parse(exit.endedAt) + 2000;
    if (pinned.stat.ctimeMs > cutoff || pinned.stat.mtimeMs > cutoff) {
      refuse('ARTIFACT_CHANGED_AFTER_EXIT', 'artifact ctime or mtime is later than launcher endedAt (2 s clock slack)');
    }
    const matching = claims.filter(claim => {
      if (typeof claim?.path !== 'string' || typeof claim.digest !== 'string') return false;
      const path = resolve(worktreeRoot, claim.path);
      if (path === resolve(artifactPath)) return true;
      try { return realpathSync(path) === pinned.realPath; } catch { return false; }
    });
    if (matching.some(claim => claim.digest !== digest)) {
      refuse('ARTIFACT_CHANGED_AFTER_EXIT', 'artifact digest does not match the worker final claim');
    }
    const after = fstatSync(pinned.fd);
    if (after.ctimeMs !== pinned.stat.ctimeMs || after.mtimeMs !== pinned.stat.mtimeMs || after.size !== pinned.stat.size) {
      refuse('ARTIFACT_CHANGED_AFTER_EXIT', 'artifact changed while checking exit evidence');
    }
    if (!checks.some(check => !isContentFreeCheck(check, pinned.realPath))) {
      refuse('CHECKS_CONTENT_FREE', 'publication requires a content check referencing the artifact path, basename, or containing directory');
    }
  };
  // Refuse before probing isolation, then repeat on the verifier's exact pin.
  const pinned = pinArtifact(resolveWorktreeRoot(worktreeRoot), artifactPath);
  try { guard(pinned, digestArtifactFd(pinned)); }
  finally { closeSync(pinned.fd); }
  return guard;
}
