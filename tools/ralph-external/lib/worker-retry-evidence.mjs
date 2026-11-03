// Authenticate predecessor records and optionally recheck owned descendant absence.
import { dirname, join, resolve } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { boundedPrivateRead, withWorkerPath } from './worker-inputs.mjs';
import { resolveRetryReference } from './worker-launch-cli.mjs';
import { realBeneath, stableTaskChainDigest, assertStopBeforeRetry, publishWorkerRecord, UNBOUND_RETRY_EVIDENCE_CODE } from '../session-launcher.mjs';
import { recheckWorkerTermination } from './worker-termination.mjs';

async function matchesLegacyTask(record, plan) {
  // Non-recovery launches retained a digest of the request including output paths.
  // Reconstruct only those paths; all task fields and the brief content stay bound.
  if (![record.prompt?.path, record.cwd, record.paths?.final].every(value => typeof value === 'string')
    || record.prompt?.digest !== plan.invocation?.briefDigest) return false;
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  return record.taskDigest === qualificationDigest({ ...plan.request,
    brief: record.prompt.path, workdir: record.cwd, final_output: record.paths.final });
}

async function matchesTaskIdentity(record, plan) {
  if (!record.prompt?.digest || !record.selected?.group || !await sameWorkspace(record.cwd, plan.request.workdir)) return false;
  const oldPlan = { ...plan, request: { ...plan.request, group: record.selected.group },
    invocation: { briefDigest: record.prompt.digest } };
  const digest = await stableTaskChainDigest(oldPlan.request, oldPlan.invocation.briefDigest);
  return (record.taskBindingDigest ?? record.taskDigest) === digest || await matchesLegacyTask(record, oldPlan);
}

export async function verifyRetryPredecessor(retryOf, { newInvocationPath, inspect, workerWritableRoots, checkDescendants = false, onVerified } = {}) {
  const fail = (reason) => {
    const error = new Error(`Retry predecessor evidence refused: ${reason}`);
    error.code = UNBOUND_RETRY_EVIDENCE_CODE;
    throw error;
  };
  if (!retryOf || typeof retryOf.invocationId !== 'string' || !retryOf.invocationId
    || typeof retryOf.runDir !== 'string' || !retryOf.runDir) {
    fail('retryOf requires both a non-empty invocationId and runDir');
  }
  const { invocationId: prevId, runDir: prevRunDir } = retryOf;
  // #2915 review 4 (finding 4): the minimal directory-authority repair —
  // reject a predecessor location inside any worker-writable root, exactly
  // like `launchOneWorker` already refuses for a NEW run directory. This
  // closes the easiest forgery (planting a complete, well-formed fake
  // predecessor inside the worktree the worker itself can write to) but is
  // explicitly NOT a defense against an unconfined malicious same-UID
  // worker in general: such a worker can still write anywhere this
  // conductor process can (e.g. directly under a configured capture root,
  // if that root is not itself outside every worker-writable path, or by
  // racing a legitimate predecessor's own directory before this check
  // runs). A real guarantee needs an enforced filesystem/process boundary
  // protecting conductor-owned metadata, or a different execution
  // identity — same-UID alone never provides it.
  if (Array.isArray(workerWritableRoots)) {
    for (const root of workerWritableRoots) {
      if (await realBeneath(root, prevRunDir)) fail('predecessor location is inside a worker-writable root');
    }
  }
  if (!await inspect(prevRunDir, 'directory')) fail('predecessor run directory is missing');
  const dirStat = await lstat(prevRunDir);
  if (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)) fail('predecessor run directory is not privately owned');
  let ownerBytes, invocationBytes, exitBytes;
  try {
    // #2915 review 4 (finding 4): `rejectInsecureMode: true` — an insecure
    // mode on predecessor metadata REFUSES the retry instead of silently
    // chmod-repairing it and proceeding (the former behaviour the review
    // found: "the probe's 0666 files were accepted and changed to 0600").
    ownerBytes = await boundedPrivateRead(join(prevRunDir, '.launch-owner'), 256, inspect, true, true);
    invocationBytes = await boundedPrivateRead(join(prevRunDir, 'invocation.json'), 1048576, inspect, true, true);
    exitBytes = await boundedPrivateRead(join(prevRunDir, 'exit.json'), 1048576, inspect, true, true);
  } catch (error) { fail(`predecessor metadata is missing, insecurely-moded, or not a bounded, privately-owned, unaliased regular file (${error.message})`); }
  if (ownerBytes.toString('utf8') !== prevId) fail('.launch-owner does not match retryOf.invocationId');
  let invocationRecord, exitRecord;
  try {
    invocationRecord = JSON.parse(invocationBytes.toString('utf8'));
    exitRecord = JSON.parse(exitBytes.toString('utf8'));
  } catch { fail('predecessor metadata is not valid JSON'); }
  if (invocationRecord?.invocationId !== prevId || invocationRecord?.origin !== 'launcher') {
    fail('invocation.json identity does not match retryOf (or is not launcher-written)');
  }
  if (exitRecord?.invocationId !== prevId) fail('exit.json identity does not match retryOf');
  let bindingDigest, correction;
  if (newInvocationPath !== undefined) {
    // #2915 review 4 (finding 4): the SAME stable task-chain identity
    // `launchOneWorker` publishes — role/task/group plus the brief CONTENT
    // digest, never `final_output`/`brief`/`workdir` PATHS, which legitimately
    // differ between a confirmed predecessor and this fresh attempt.
    let newTaskDigest, newPlan;
    try {
      const newPlanBytes = await boundedPrivateRead(newInvocationPath, 1048576, inspect);
      newPlan = JSON.parse(newPlanBytes.toString('utf8'));
      newTaskDigest = await stableTaskChainDigest(newPlan.request, newPlan.invocation?.briefDigest ?? null);
    } catch { fail('new attempt plan is missing or invalid; cannot bind the retry to a task'); }
    bindingDigest = newTaskDigest;
    if ((invocationRecord.taskBindingDigest ?? invocationRecord.taskDigest) !== newTaskDigest && !await matchesLegacyTask(invocationRecord, newPlan)) {
      if (retryOf.correction !== true) fail('predecessor task does not match the new attempt (task-chain binding); use --retry-correction for an explicit brief/group correction');
      if (!await matchesTaskIdentity(invocationRecord, newPlan)) {
        fail('correction must retain the predecessor role, task and workspace (task-chain binding)');
      }
      const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
      correction = {
        oldBriefDigest: invocationRecord.prompt.digest, newBriefDigest: newPlan.invocation.briefDigest,
        oldGroupDigest: qualificationDigest(invocationRecord.selected.group), newGroupDigest: qualificationDigest(newPlan.request.group),
      };
    }
  }
  if (exitRecord.termination !== 'confirmed') {
    let evidence = null;
    if (checkDescendants) {
      try {
        const processRecord = JSON.parse((await boundedPrivateRead(join(prevRunDir, 'process.json'), 65536, inspect, true, true)).toString('utf8'));
        evidence = await recheckWorkerTermination({ processRecord, exitRecord });
      } catch (error) { evidence = { confirmed: false, missing: `readable, private launcher process.json (${error.message})` }; }
      if (evidence.confirmed) {
        exitRecord = { ...exitRecord, termination: 'confirmed', descendants: 'none',
          ...(exitRecord.health ? { health: { ...exitRecord.health, termination: 'confirmed' } } : {}) };
        await publishWorkerRecord(prevRunDir, 'exit.json', exitRecord, inspect);
      }
    }
    if (exitRecord.termination !== 'confirmed') {
      assertStopBeforeRetry(exitRecord, { expectedInvocationId: prevId, runDir: prevRunDir, missing: evidence?.missing });
    }
  }
  assertStopBeforeRetry(exitRecord, { expectedInvocationId: prevId });
  onVerified?.({ previousAttemptId: prevId, taskDigest: invocationRecord.taskDigest,
    taskBindingDigest: bindingDigest, ...(correction ? { retryCorrection: correction } : {}) });
  return exitRecord;
}

async function sameWorkspace(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try { return await realpath(left) === await realpath(right); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Existing capture siblings are the durable inventory, including captures from
// older launchers. Brief and group changes cannot hide an open task predecessor.
async function assertNoOpenPredecessor({ runDir, captureRoot, saved, inspect, retryOf, workerWritableRoots }) {
  const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
  const roots = new Set([dirname(runDir), ...(captureRoot ? [captureRoot] : []), ...(retryOf ? [dirname(retryOf.runDir)] : [])]);
  for (const root of roots) {
    if (!await inspect(root, 'directory')) continue;
    const entries = await withWorkerPath(root, target => readdir(target, { withFileTypes: true }));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const previousDir = join(root, entry.name);
      if (resolve(previousDir) === resolve(runDir)) continue;
      const filename = join(previousDir, 'invocation.json');
      if (!await inspect(filename, 'file')) continue;
      const record = JSON.parse((await boundedPrivateRead(filename, 1048576, inspect, true, true)).toString('utf8'));
      if (record.origin !== 'launcher' || ((record.taskBindingDigest ?? record.taskDigest) !== taskDigest
        && !await matchesTaskIdentity(record, saved))) continue;
      try {
        // Reuse the authenticated owned-stop loader, including missing exits.
        await verifyRetryPredecessor({ invocationId: record.invocationId, runDir: previousDir }, { inspect, workerWritableRoots });
      } catch (cause) {
        const error = new Error(`Worker launch refused: open predecessor ${record.invocationId} at ${previousDir}; termination is not confirmed. Retry with --retry-of-run-dir and owned-stop proof.`, { cause });
        error.code = 'OPEN_TASK_PREDECESSOR';
        error.previousAttemptId = record.invocationId;
        error.runDir = previousDir;
        throw error;
      }
    }
  }
}

export async function prepareWorkerRetry(options, { saved, inspect, workerWritableRoots }) {
  let evidence = null;
  const retryOf = options.retryOf === undefined ? undefined : await resolveRetryReference(options.retryOf, { inspect });
  if (retryOf !== undefined) {
    await verifyRetryPredecessor(retryOf, { newInvocationPath: options.invocationPath, inspect, workerWritableRoots,
      checkDescendants: options.checkDescendants, onVerified: value => { evidence = value; } });
  }
  await assertNoOpenPredecessor({ ...options, saved, inspect, retryOf, workerWritableRoots });
  return evidence;
}

export function workerRetryRecordFields(evidence) {
  return { ...(evidence ? { taskBindingDigest: evidence.taskBindingDigest,
    ...(evidence.retryCorrection ? { retryCorrection: evidence.retryCorrection } : {}) } : {}) };
}
