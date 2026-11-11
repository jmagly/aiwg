/**
 * Script Runner
 *
 * Utility for running framework scripts from handlers.
 * Script execution utility for CLI handlers.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @source @src/cli/router.ts
 * @issue #33
 */

import { signalChild } from '../../process/signal-child.mjs';
import { spawn, type StdioOptions } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { writeSync } from 'node:fs';
import { HandlerResult, ScriptRunner, ScriptRunnerOptions } from './types.js';
import { providerDeploymentLockEnvironment } from '../../providers/deployment-lock.js';

// Embedded deployers use process-wide console/environment APIs. Serialize the
// complete invocation (including import), and restore them even after failure.
let deploymentQueue: Promise<unknown> = Promise.resolve();

function reportDeploymentWarnings(message: string, sink = console): void {
  for (const line of message.split(/\r?\n/)) {
    if (line.startsWith('Flue (experimental):')) sink.warn(line);
    else if (/^Removing .+ \((?:critical )?rule retired because /.test(line)) process.stderr.write(`${line}\n`);
  }
}

/**
 * Default script runner implementation
 *
 * Embeds repeatable agent deployment passes; runs other scripts in a child.
 */
export class DefaultScriptRunner implements ScriptRunner {
  constructor(private frameworkRoot: string) {}

  /**
   * Run a Node.js script from the framework
   *
   * @param scriptPath - Relative path to script from framework root
   * @param args - Arguments to pass to script
   * @param options - Execution options
   */
  async run(
    scriptPath: string,
    args: string[] = [],
    options: ScriptRunnerOptions = {}
  ): Promise<HandlerResult> {
    const fullPath = path.join(this.frameworkRoot, scriptPath);

    if (scriptPath === 'tools/agents/deploy-agents.mjs'
      && process.env.AIWG_DEPLOY_SUBPROCESS !== '1'
      && options.env?.AIWG_DEPLOY_SUBPROCESS !== '1'
      && !options.timeout
      && (!options.cwd || path.resolve(options.cwd) === process.cwd())
      // Other environment overrides can affect module initialization. Keep
      // those callers isolated; AIWG_ROOT is resolved afresh by each pass.
      && Object.keys(options.env ?? {}).every(key => key === 'AIWG_ROOT')) {
      const invocation = deploymentQueue.then(() => this.runDeployment(fullPath, args, options));
      deploymentQueue = invocation.catch(() => {});
      return invocation;
    }

    return new Promise((resolve) => {
      // When capture mode is enabled, stdout/stderr are piped so that
      // quiet-mode callers can suppress output. When not
      // capturing, stdio: 'inherit' lets subprocess output flow directly to
      // the terminal (verbose mode).
      const stdio: StdioOptions = options.capture
        ? ['pipe', options.stdoutFd ?? 'pipe', 'pipe']
        : 'inherit';
      const environment = { ...process.env, ...providerDeploymentLockEnvironment(), ...options.env };
      for (const name of options.omitEnv ?? []) delete environment[name];
      const child = spawn('node', [fullPath, ...args], {
        stdio,
        cwd: options.cwd || process.cwd(),
        env: environment,
      });

      // Always drain captured pipes, even after the diagnostic cap is reached.
      // stdout is not part of HandlerResult; discard it. Retain only the first
      // 1 MiB of stderr for failure messages, discarding any excess.
      child.stdout?.resume();
      const stderrLimit = 1024 * 1024;
      const capturedStderr: Buffer[] = [];
      let capturedStderrBytes = 0;
      if (options.capture && child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const retained = data.subarray(0, stderrLimit - capturedStderrBytes);
          if (retained.length > 0) {
            capturedStderr.push(Buffer.from(retained));
            capturedStderrBytes += retained.length;
          }
        });
      }

      const timeout = options.timeout;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let killEscalationId: ReturnType<typeof setTimeout> | undefined;
      // Hard deadline for a well-behaved child to respond to SIGTERM before we
      // escalate to SIGKILL. Prevents a stuck child from outliving the CLI and
      // masking a timeout as a hang. Overridable via AIWG_SIGKILL_DEADLINE_MS.
      const killDeadlineMs = (() => {
        const raw = process.env['AIWG_SIGKILL_DEADLINE_MS'];
        const n = raw ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 10_000;
      })();

      if (timeout) {
        timeoutId = setTimeout(() => {
          // Request graceful termination first, then escalate if the child
          // does not exit within the deadline. Both kill() calls are wrapped
          // because they can throw ESRCH on an already-exited child.
          try { signalChild(child, 'SIGTERM'); } catch { /* already exited */ }
          killEscalationId = setTimeout(() => {
            try { signalChild(child, 'SIGKILL'); } catch { /* already exited */ }
          }, killDeadlineMs);
          killEscalationId.unref?.();
          resolve({
            exitCode: 124,
            message: `Script timed out after ${timeout}ms`,
            error: new Error(`Timeout after ${timeout}ms (child sent SIGTERM, SIGKILL after ${killDeadlineMs}ms)`),
          });
        }, timeout);
      }

      child.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (killEscalationId) clearTimeout(killEscalationId);
        // On failure in capture mode, surface the captured stderr. Every
        // failure carries a message so callers never print an empty ERROR.
        if (options.capture && code !== 0) {
          const stderr = Buffer.concat(capturedStderr).toString().trim();
          resolve({
            exitCode: code ?? 1,
            message: stderr || `Script exited with code ${code ?? 1}: ${path.basename(fullPath)}`,
          });
        } else {
          if (options.capture && code === 0 && scriptPath === 'tools/agents/deploy-agents.mjs') {
            reportDeploymentWarnings(Buffer.concat(capturedStderr).toString());
          }
          resolve({
            exitCode: code ?? 0,
          });
        }
      });

      child.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (killEscalationId) clearTimeout(killEscalationId);
        resolve({
          exitCode: 1,
          message: `Script error: ${err.message}`,
          error: err,
        });
      });
    });
  }

  private async runDeployment(
    fullPath: string, args: string[], options: ScriptRunnerOptions,
  ): Promise<HandlerResult> {
    const previousConsole = globalThis.console;
    const previousRoot = process.env.AIWG_ROOT;
    const omitted = new Map((options.omitEnv ?? []).map(name => [name, process.env[name]]));
    const stderrLimit = 1024 * 1024;
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    try {
      for (const name of omitted.keys()) delete process.env[name];
      if (options.env?.AIWG_ROOT !== undefined) process.env.AIWG_ROOT = options.env.AIWG_ROOT;
      if (options.capture) {
        const stdout = new Writable({ write(chunk, _encoding, done) {
          try {
            if (options.stdoutFd !== undefined) writeSync(options.stdoutFd, chunk);
            done();
          } catch (error) { done(error as Error); }
        } });
        const stderr = new Writable({ write(chunk, _encoding, done) {
          const retained = (chunk as Buffer).subarray(0, stderrLimit - diagnosticBytes);
          if (retained.length) { diagnostics.push(Buffer.from(retained)); diagnosticBytes += retained.length; }
          done();
        } });
        globalThis.console = new Console({ stdout, stderr });
      }
      // Runtime loading follows the provider preparation coordinator precedent;
      // the runner still supports arbitrary scripts via its subprocess path.
      const deployer = await import(pathToFileURL(fullPath).href) as {
        main(args: string[], internal: { capture: boolean }): Promise<number | void>;
      };
      const exitCode = (await deployer.main(args, { capture: options.capture === true })) ?? 0;
      const message = Buffer.concat(diagnostics).toString().trim()
        || (exitCode ? `Deployment script exited with code ${exitCode}: ${path.basename(fullPath)}` : '');
      if (exitCode === 0 && options.capture) reportDeploymentWarnings(message, previousConsole);
      return exitCode || message ? { exitCode, message } : { exitCode };
    } catch (error) {
      const message = Buffer.concat(diagnostics).toString().trim()
        || (error instanceof Error ? error.message : String(error));
      return { exitCode: 1, message };
    } finally {
      globalThis.console = previousConsole;
      for (const [name, value] of omitted) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (previousRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = previousRoot;
    }
  }
}

/**
 * Create a script runner for the given framework root
 */
export function createScriptRunner(frameworkRoot: string): ScriptRunner {
  return new DefaultScriptRunner(frameworkRoot);
}
