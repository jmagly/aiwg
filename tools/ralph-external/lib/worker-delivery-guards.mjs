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
const emptyPatterns = new Set(['', '.', '^', '$', '.*']);
const searchValueOptions = new Set(['-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context',
  '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--include', '--exclude', '--exclude-dir']);

function searchPatterns(args) {
  const patterns = [];
  const operands = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (options && (arg === '-f' || arg === '--file' || /^-f.|^--file=/.test(arg))) return null;
    if (options && (arg === '-e' || arg === '--regexp')) { patterns.push(args[++i]); continue; }
    if (options && arg.startsWith('--regexp=')) { patterns.push(arg.slice(9)); continue; }
    if (options && /^-[^-]*e/.test(arg)) { patterns.push(arg.slice(arg.indexOf('e') + 1) || args[++i]); continue; }
    if (options && searchValueOptions.has(arg)) { i++; continue; }
    if (options && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  return patterns.length ? patterns : operands.slice(0, 1);
}

function knownEmptyCheck(command, args) {
  if (command === 'grep' || command === 'rg') {
    const patterns = searchPatterns(args);
    return patterns?.length > 0 && patterns.every(pattern => typeof pattern === 'string' && emptyPatterns.has(pattern));
  }
  if (/^(?:py|python(?:\d+(?:\.\d+)*)?)$/.test(command)) {
    return args.some((arg, i) => arg === '-mjson.tool' || arg === '-m' && args[i + 1] === 'json.tool');
  }
  if (command === 'node' || command === 'nodejs') {
    for (const arg of args) {
      // After the script operand or --, these spellings are script arguments.
      if (arg === '--' || arg === '-' || !arg.startsWith('-')) return false;
      if (arg === '-c' || arg === '--check') return true;
    }
    return false;
  }
  if (command === 'jq') {
    const filter = args.find(arg => !arg.startsWith('-'));
    const exitStatus = args.some(arg => arg === '--exit-status' || /^-[^-]*e/.test(arg));
    return filter === 'empty' || filter === '.' && !exitStatus;
  }
  return command === 'wc'; // A direct wc invocation prints counts without comparing them.
}
// This is a narrow argv heuristic, not proof that a check asserts correctness.
// Probe binaries with only path/flag operands cannot qualify. Other checks
// must mention the artifact, its basename, or a containing directory in args.
export function isContentFreeCheck(check, artifactPath) {
  const args = check.args ?? [];
  let command = check.command;
  try { command = realpathSync(command); } catch { /* The verifier refuses unavailable binaries. */ }
  if ([basename(check.command), basename(command)].some(name => knownEmptyCheck(name, args))) return true;
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
    for (const check of checks) {
      if (/[\s;&|<>$`"'(){}\\*?]/.test(check.command)) {
        refuse('CHECK_COMMAND_NOT_EXECUTABLE', 'command must be a single executable path; put arguments (including the artifact path) in args');
      }
    }
    if (!checks.some(check => !isContentFreeCheck(check, pinned.realPath))) {
      refuse('CHECKS_CONTENT_FREE', 'publication requires at least one check beyond known content-free probes, referencing the artifact path, basename, or containing directory in args');
    }
  };
  // Refuse before probing isolation, then repeat on the verifier's exact pin.
  const pinned = pinArtifact(resolveWorktreeRoot(worktreeRoot), artifactPath);
  try { guard(pinned, digestArtifactFd(pinned)); }
  finally { closeSync(pinned.fd); }
  return guard;
}
