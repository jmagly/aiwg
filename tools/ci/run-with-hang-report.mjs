#!/usr/bin/env node
/**
 * Run a command with a wall-clock bound that reports *why* it hung.
 *
 * Motivation (#2521): the full test suite silently stopped producing output and
 * held its runner for ~3h. Vitest has its own exit guard, but it is armed only
 * once the run completes — a worker thread wedged in a synchronous child-process
 * call never completes the run, so the guard never fires and the job dies at the
 * job-level `timeout-minutes` with no attribution at all.
 *
 * This wrapper bounds the command *below* the job timeout and, on a hang,
 * captures the process tree before tearing anything down — so the next
 * occurrence names the child process the run is blocked on instead of leaving
 * only a timestamp.
 *
 * Usage:
 *   node tools/ci/run-with-hang-report.mjs --timeout 12m -- npm test -- --run
 *
 * Options:
 *   --timeout <dur>  Wall-clock bound. Accepts `90s`, `12m`, `1h`, or bare ms.
 *   --grace <dur>    Wait after SIGTERM before SIGKILL (default 30s).
 *
 * Exit code is the command's own, or 124 when the bound was hit (matching
 * coreutils `timeout`).
 */

import { importImpl } from '../_resolve-impl.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

const TIMEOUT_EXIT_CODE = 124;

/** Parse `90s` / `12m` / `1h` / bare milliseconds into milliseconds. */
export function parseDuration(raw) {
  const match = String(raw ?? '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error(`Invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  return Math.round(value * scale);
}

export function parseArgs(argv) {
  let timeoutMs = parseDuration('12m');
  let graceMs = parseDuration('30s');
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--') { i++; break; }
    if (argv[i] === '--timeout') { timeoutMs = parseDuration(argv[++i]); continue; }
    if (argv[i] === '--grace') { graceMs = parseDuration(argv[++i]); continue; }
    throw new Error(`Unknown option: ${argv[i]} (did you forget -- before the command?)`);
  }
  const command = argv.slice(i);
  if (command.length === 0) throw new Error('No command given. Usage: --timeout 12m -- <command...>');
  return { timeoutMs, graceMs, command };
}

/** Parse one `ps -eo pid,ppid,etime,stat,rss,args` line. */
export function parsePsLine(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    etime: match[3],
    stat: match[4],
    rss: Number(match[5]),
    args: match[6],
  };
}

/**
 * Render the process subtree rooted at `rootPid`, plus any process outside it
 * whose command looks like ours (a detached or orphaned child is exactly the
 * kind of thing that wedges a run, and it will not be in our subtree).
 */
export function renderProcessReport(procs, rootPid, { interesting = /\b(node|npm|npx|vitest|aiwg|git)\b/ } = {}) {
  const byParent = new Map();
  for (const proc of procs) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }

  const lines = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    if (seen.has(pid) || depth > 12) return;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      lines.push(`${'  '.repeat(depth)}${child.pid} [${child.stat} ${child.etime}] ${child.args.slice(0, 160)}`);
      walk(child.pid, depth + 1);
    }
  };

  const root = procs.find((proc) => proc.pid === rootPid);
  if (root) lines.push(`${root.pid} [${root.stat} ${root.etime}] ${root.args.slice(0, 160)}`);
  // Walk before marking the root seen — marking first makes walk() return
  // immediately and report a childless root no matter how many children exist.
  walk(rootPid, 1);
  if (root) seen.add(root.pid);

  const strays = procs.filter((proc) => !seen.has(proc.pid) && interesting.test(proc.args));
  return { tree: lines, strays };
}

/**
 * Capture whatever the platform can tell us about what is still running.
 * Best-effort by design: a diagnostic that throws is worse than a partial one.
 */
function captureDiagnostics(rootPid) {
  const result = spawnSync('ps', ['-eo', 'pid,ppid,etime,stat,rss,args'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.status !== 0 || !result.stdout) {
    console.error(`[hang-report] process listing unavailable (${result.error?.message ?? `exit ${result.status}`})`);
    return;
  }
  const procs = result.stdout.split('\n').slice(1).map(parsePsLine).filter(Boolean);
  const { tree, strays } = renderProcessReport(procs, rootPid);

  console.error('\n[hang-report] live descendants of the test run:');
  console.error(tree.length > 0 ? tree.join('\n') : '  (none — the run had no live children)');

  if (strays.length > 0) {
    console.error('\n[hang-report] related processes outside the subtree (detached or orphaned):');
    for (const proc of strays.slice(0, 40)) {
      console.error(`  ${proc.pid} (ppid ${proc.ppid}) [${proc.stat} ${proc.etime}] ${proc.args.slice(0, 160)}`);
    }
  }
}

export async function run({ timeoutMs, graceMs, command }) {
  // A fatal runtime crash cannot run reporter hooks. Keep the last snapshot
  // outside the child, including when npm sits between us and vitest (#3073).
  let stateDir;
  try {
    stateDir = mkdtempSync(path.join(tmpdir(), 'aiwg-hang-report-'));
  } catch (error) {
    console.error(`[hang-report] cannot prepare in-flight snapshot: ${error.message}`);
  }
  const stateFile = stateDir ? path.join(stateDir, 'in-flight.txt') : '';
  // Own process group: a wedged run's damage is usually in a *grandchild* that
  // inherited stdio, and signalling only the direct child leaves it alive
  // holding the pipe. `detached` gives us a group to signal as a unit.
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, AIWG_HANG_REPORT_STATE_FILE: stateFile },
  });

  /** Signal the whole group, falling back to the child if the group is gone. */
  const signalGroup = (signal) => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    try { process.kill(-child.pid, signal); }
    catch { try { signalChild(child, signal); } catch { /* already gone */ } }
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`\n[hang-report] command exceeded ${timeoutMs}ms without exiting — capturing diagnostics before teardown (#2521)`);
    // Capture first: SIGTERM may reap the very children that explain the hang.
    captureDiagnostics(child.pid);
    console.error('\n[hang-report] sending SIGTERM to the process group');
    signalGroup('SIGTERM');
    setTimeout(() => {
      console.error('[hang-report] still alive after grace period — sending SIGKILL');
      signalGroup('SIGKILL');
    }, graceMs).unref();
  }, timeoutMs);

  // Detaching also detaches the terminal's Ctrl-C, so forward it explicitly.
  const forward = (signal) => () => signalGroup(signal);
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  let exitSignal;
  const code = await new Promise((resolve) => {
    child.once('error', (err) => {
      console.error(`[hang-report] failed to start command: ${err.message}`);
      resolve(1);
    });
    child.once('exit', (exitCode, signal) => {
      exitSignal = signal;
      resolve(exitCode ?? (signal ? 128 : 1));
    });
  });
  clearTimeout(timer);
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);

  if (!timedOut && (exitSignal || code >= 128)) {
    console.error(`\n[hang-report] command exited abnormally (${exitSignal ?? `exit ${code}`}) — last reported test files in flight (#3073):`);
    try {
      const snapshot = readFileSync(stateFile, 'utf8');
      console.error(snapshot || '  (none — all reported modules finished)');
    } catch {
      console.error('  (unavailable — no readable reporter snapshot)');
    }
  }
  if (stateDir) {
    try { rmSync(stateDir, { recursive: true, force: true }); }
    catch (error) { console.error(`[hang-report] snapshot cleanup failed: ${error.message}`); }
  }

  if (timedOut) {
    console.error(`[hang-report] treating as failure (exit ${TIMEOUT_EXIT_CODE})`);
    return TIMEOUT_EXIT_CODE;
  }
  return code;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('run-with-hang-report.mjs');
if (invokedDirectly) {
  try {
    process.exitCode = await run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`[hang-report] ${err.message}`);
    process.exitCode = 2;
  }
}
