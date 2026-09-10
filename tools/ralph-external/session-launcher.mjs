/**
 * Session Launcher for External Ralph Loop
 *
 * Handles spawning Claude Code CLI sessions with proper argument
 * construction and output capture.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 * @security docs/ralph-external-security.md
 *
 * SECURITY WARNING
 * ================
 * This module spawns Claude Code with --dangerously-skip-permissions which
 * BYPASSES ALL PERMISSION PROMPTS. The spawned session can:
 *
 * - Read ANY file the process user can read
 * - Write/modify ANY file the process user can write
 * - Execute ANY shell command
 * - Make network requests
 * - Install packages
 * - Modify system configuration
 *
 * This is required for headless/daemon operation but carries significant
 * security implications. Sessions run autonomously for extended periods
 * without human oversight.
 *
 * BEFORE USING:
 * - Read docs/ralph-external-security.md in full
 * - Understand all risks
 * - Set appropriate budget and iteration limits
 * - Ensure clean git state for rollback
 * - Have monitoring and abort procedures ready
 */

import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { homedir } from 'os';

/**
 * @typedef {Object} LaunchOptions
 * @property {string} prompt - The prompt to send
 * @property {string} sessionId - Session UUID for tracking
 * @property {string} [model='claude-sonnet-4-6'] - Pinned model variant (see #1450)
 * @property {number} [budget] - Budget per iteration in USD
 * @property {number} [maxTurns] - Maximum number of turns (requires Claude CLI support)
 * @property {boolean} [verbose=false] - Enable verbose output
 * @property {string} [systemPrompt] - System prompt to append
 * @property {Object} [mcpConfig] - MCP server configuration
 * @property {string} workingDir - Working directory for session
 * @property {string} stdoutPath - Path to capture stdout
 * @property {string} stderrPath - Path to capture stderr
 * @property {string} outputDir - Directory for session artifacts
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * @typedef {Object} SessionResult
 * @property {number} exitCode - Process exit code
 * @property {string} stdoutPath - Path to stdout log
 * @property {string} stderrPath - Path to stderr log
 * @property {string} [transcriptPath] - Path to session transcript (if available)
 * @property {string} [parsedEventsPath] - Path to parsed stream events (if available)
 * @property {number} duration - Duration in milliseconds
 * @property {boolean} timedOut - Whether session timed out
 * @property {string} stdoutBuffer - Last portion of stdout
 * @property {number} [toolCallCount] - Number of tool calls detected
 * @property {number} [errorCount] - Number of errors detected
 * @property {number} [totalTokens] - Total token usage detected from stream events
 * @property {number} [inputTokens] - Input token usage detected from stream events
 * @property {number} [outputTokens] - Output token usage detected from stream events
 * @property {number} [costUsd] - Cost detected from stream events
 */

/**
 * @typedef {Object} StreamEvent
 * @property {string} type - Event type (e.g., 'tool_call', 'completion', 'error')
 * @property {number} timestamp - Unix timestamp
 * @property {Object} data - Event data
 */

export class SessionLauncher extends EventEmitter {
  constructor() {
    super();
    this.currentProcess = null;
    this.startTime = null;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Build Claude CLI arguments
   * @param {LaunchOptions} options
   * @returns {string[]}
   */
  buildArgs(options) {
    const args = [
      // SECURITY: This flag bypasses ALL permission prompts
      // Required for headless operation but enables:
      // - Unrestricted file read/write
      // - Arbitrary command execution
      // - Network access without confirmation
      // See docs/ralph-external-security.md
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--session-id', options.sessionId,
    ];

    // Verbose mode
    if (options.verbose) {
      args.push('--verbose');
    }

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // Budget control
    if (options.budget) {
      args.push('--max-budget-usd', String(options.budget));
    }

    // Max turns control (if supported by Claude CLI)
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // MCP configuration
    if (options.mcpConfig) {
      const configJson = typeof options.mcpConfig === 'string'
        ? options.mcpConfig
        : JSON.stringify(options.mcpConfig);
      args.push('--mcp-config', configJson);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // The prompt itself
    args.push(options.prompt);

    return args;
  }

  /**
   * Launch a Claude Code session
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  async launch(options) {
    const sessionResult = await this._launchSession(options);

    // Post-session artifact capture
    await this._captureSessionArtifacts(options, sessionResult);

    return sessionResult;
  }

  /**
   * Internal method to launch session and capture basic output
   * @private
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  _launchSession(options) {
    return new Promise((resolve, reject) => {
      // Ensure output directories exist
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      if (options.outputDir) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      // Use adapter for args if available, otherwise use legacy buildArgs
      const args = this.providerAdapter
        ? this.providerAdapter.buildSessionArgs({
            prompt: options.prompt,
            // AIWG's tracking UUID is not an OMP native session to resume.
            sessionId: this.providerAdapter.getName() === 'omp' ? options.resumeSession : options.sessionId,
            model: options.model,
            budget: options.budget,
            maxTurns: options.maxTurns,
            verbose: options.verbose,
            systemPrompt: options.systemPrompt,
            mcpConfig: options.mcpConfig,
            thinking: options.thinking,
            tools: options.tools,
          })
        : this.buildArgs(options);
      this.startTime = Date.now();

      // Create write streams for output capture
      const stdoutStream = createWriteStream(options.stdoutPath);
      const stderrStream = createWriteStream(options.stderrPath);

      // Buffer for last portion of stdout (for quick analysis)
      let stdoutBuffer = '';
      const isOmp = this.providerAdapter?.getName() === 'omp';
      let ompOutput = '';
      const ompTextDecoder = new StringDecoder('utf8');
      let ompInvalid = false;
      const maxBufferSize = 100000; // 100KB

      // Spawn process using provider adapter or legacy Claude defaults
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const envOverrides = this.providerAdapter ? this.providerAdapter.getEnvOverrides() : { CI: 'true' };

      const abortInput = this.providerAdapter?.getAbortInput?.();
      this.currentProcess = spawn(binary, args, {
        cwd: options.workingDir,
        detached: isOmp && process.platform !== 'win32',
        stdio: [abortInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...envOverrides,
        },
      });

      const child = this.currentProcess;
      const terminate = (signal) => { try { if (isOmp && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };

      // Capture stdout
      child.stdout.on('data', (chunk) => {
        if (isOmp && !ompInvalid) {
          ompOutput += ompTextDecoder.write(chunk);
          if (Buffer.byteLength(ompOutput) > 64 * 1024 * 1024) { ompInvalid = true; ompOutput = ''; terminate('SIGKILL'); }
        }
        stdoutStream.write(chunk);
        stdoutBuffer += chunk.toString();
        // Keep buffer size manageable
        if (stdoutBuffer.length > maxBufferSize) {
          stdoutBuffer = stdoutBuffer.slice(-maxBufferSize);
        }
        this.emit('stdout', chunk);
      });

      // Capture stderr
      child.stderr.on('data', (chunk) => {
        stderrStream.write(chunk);
        this.emit('stderr', chunk);
      });

      // Handle timeout
      let timeoutId = null;
      let timedOut = false;

      if (options.timeoutMs) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          this.emit('timeout');
          if (abortInput && child.stdin?.writable) child.stdin.write(abortInput);
          const terminateDelay = abortInput ? 2000 : 0;
          setTimeout(() => terminate('SIGTERM'), terminateDelay);
          // Force kill after bounded graceful-abort and termination windows.
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              terminate('SIGKILL');
            }
          }, terminateDelay + 5000);
        }, options.timeoutMs);
      }

      // Handle process completion
      child.on('close', (code) => {
        if (isOmp) terminate('SIGKILL');
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams
        stdoutStream.end();
        stderrStream.end();

        const result = {
          exitCode: isOmp && (ompInvalid || !this.providerAdapter.parseOutput(ompOutput, { exitCode: code ?? 1 })?.success) ? (code || 1) : (code ?? 1),
          stdoutPath: options.stdoutPath,
          stderrPath: options.stderrPath,
          duration,
          timedOut,
          stdoutBuffer,
        };

        this.emit('complete', result);
        resolve(result);
      });

      // Handle process errors
      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams
        stdoutStream.end();
        stderrStream.end();

        this.emit('error', err);
        reject(err);
      });

      this.emit('started', { pid: child.pid, args });
    });
  }

  /**
   * Capture session artifacts after completion
   * @private
   * @param {LaunchOptions} options
   * @param {SessionResult} result
   */
  async _captureSessionArtifacts(options, result) {
    if (!options.outputDir) {
      return; // No output directory specified
    }

    try {
      // Copy session transcript if available
      const transcriptPath = await this.copySessionTranscript(
        options.sessionId,
        options.workingDir,
        options.outputDir
      );
      if (transcriptPath) {
        result.transcriptPath = transcriptPath;
      }

      // Parse stream events from stdout
      const { path: eventsPath, stats } = await this.parseStreamEvents(
        options.stdoutPath,
        options.outputDir
      );
      if (eventsPath) {
        result.parsedEventsPath = eventsPath;
        result.toolCallCount = stats.toolCallCount;
        result.errorCount = stats.errorCount;
        result.inputTokens = stats.inputTokens;
        result.outputTokens = stats.outputTokens;
        result.totalTokens = stats.totalTokens;
        result.costUsd = stats.costUsd;
        // Whether the provider actually reported token/cost usage this session.
        // Distinguishes "observed 0" from "cannot observe" so token/spend
        // ceilings aren't silently inert on providers that emit no usage (#1766).
        result.tokenUsageObserved = stats.tokenFieldSeen;
        result.costObserved = stats.costFieldSeen;
      }
    } catch (err) {
      // Log but don't fail the session
      this.emit('artifact-error', err);
    }
  }

  /**
   * Copy session transcript from Claude's project directory
   *
   * Claude stores session transcripts at:
   * ~/.claude/projects/{encoded-path}/{session-id}.jsonl
   *
   * Path encoding: Replace `/` with `-`, prepend `-`
   * Example: /foo/bar → -foo-bar
   *
   * @param {string} sessionId - Session UUID
   * @param {string} workingDir - Working directory path
   * @param {string} outputDir - Destination directory
   * @returns {Promise<string|null>} Path to copied transcript or null if not found
   */
  async copySessionTranscript(sessionId, workingDir, outputDir) {
    try {
      // Use adapter for transcript path if available
      let sourcePath;
      if (this.providerAdapter) {
        sourcePath = this.providerAdapter.getTranscriptPath(sessionId, workingDir);
        if (!sourcePath) {
          // Provider doesn't support transcripts
          this.emit('transcript-not-found', { reason: 'Provider does not support transcripts' });
          return null;
        }
      } else {
        // Legacy Claude-specific path
        const encodedPath = workingDir.replace(/\//g, '-');
        sourcePath = join(
          homedir(),
          '.claude',
          'projects',
          encodedPath,
          `${sessionId}.jsonl`
        );
      }

      // Check if transcript exists
      if (!existsSync(sourcePath)) {
        this.emit('transcript-not-found', { sourcePath });
        return null;
      }

      // Copy to output directory
      const destPath = join(outputDir, 'session-transcript.jsonl');
      copyFileSync(sourcePath, destPath);

      this.emit('transcript-copied', { sourcePath, destPath });
      return destPath;
    } catch (err) {
      this.emit('transcript-error', err);
      return null;
    }
  }

  /**
   * Parse stream-json events from stdout capture
   *
   * Extracts structured events from Claude's stream-json output format.
   * Tracks tool calls, completions, and errors.
   *
   * @param {string} stdoutPath - Path to stdout capture file
   * @param {string} outputDir - Directory to save parsed events
   * @returns {Promise<{path: string|null, stats: Object}>} Parsed events path and statistics
   */
  async parseStreamEvents(stdoutPath, outputDir) {
    const stats = {
      toolCallCount: 0,
      errorCount: 0,
      completionCount: 0,
      totalEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      usageEvents: 0,
      tokenFieldSeen: false,
      costFieldSeen: false,
    };

    try {
      // Read stdout file
      const content = readFileSync(stdoutPath, 'utf-8');

      // Parse stream-json events (each line is a JSON object)
      const events = [];
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Categorize event
          const eventType = this._categorizeStreamEvent(event);

          const structuredEvent = {
            type: eventType,
            timestamp: Date.now(), // Could extract from event if available
            data: event,
          };

          events.push(structuredEvent);
          stats.totalEvents++;

          // Update stats
          if (eventType === 'tool_call') {
            stats.toolCallCount++;
          } else if (eventType === 'error') {
            stats.errorCount++;
          } else if (eventType === 'completion') {
            stats.completionCount++;
          }

          const usage = this._extractUsageStats(event);
          if (usage.hasTokenField) {
            stats.tokenFieldSeen = true;
          }
          if (usage.hasCostField) {
            stats.costFieldSeen = true;
          }
          if (usage.hasUsage) {
            stats.inputTokens += usage.inputTokens;
            stats.outputTokens += usage.outputTokens;
            stats.cacheCreationInputTokens += usage.cacheCreationInputTokens;
            stats.cacheReadInputTokens += usage.cacheReadInputTokens;
            stats.totalTokens += usage.totalTokens;
            stats.costUsd += usage.costUsd;
            stats.usageEvents++;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }

      // Save parsed events
      const eventsPath = join(outputDir, 'parsed-events.json');
      const eventsData = {
        stats,
        events,
        parsedAt: new Date().toISOString(),
      };

      mkdirSync(dirname(eventsPath), { recursive: true });
      const fs = await import('fs/promises');
      await fs.writeFile(eventsPath, JSON.stringify(eventsData, null, 2));

      this.emit('events-parsed', { eventsPath, stats });
      return { path: eventsPath, stats };
    } catch (err) {
      this.emit('parse-error', err);
      return { path: null, stats };
    }
  }

  /**
   * Categorize a stream-json event
   * @private
   * @param {Object} event - Raw event object
   * @returns {string} Event type
   */
  _categorizeStreamEvent(event) {
    // Check for tool-related events first (before checking type field)
    // This handles events like { type: 'tool_use', name: 'read_file' }
    if (event.type === 'tool_use' || event.tool || event.tool_use || event.name?.includes('tool')) {
      return 'tool_call';
    }

    // Check for error events
    // Note: message can be a string or object, so check type before calling includes
    if (event.type === 'error' || event.error || (typeof event.message === 'string' && event.message.includes('error'))) {
      return 'error';
    }

    // Check for other common type fields
    if (event.type) {
      return event.type;
    }

    // Heuristic categorization based on content
    if (event.stop_reason || event.content?.some?.(c => c.type === 'text')) {
      return 'completion';
    }

    if (event.delta || event.content_block_delta) {
      return 'content_delta';
    }

    if (event.message_start || event.content_block_start) {
      return 'start';
    }

    if (event.message_stop || event.content_block_stop) {
      return 'stop';
    }

    return 'unknown';
  }

  /**
   * Get current process PID
   * @returns {number|null}
   */
  getPid() {
    return this.currentProcess?.pid || null;
  }

  /**
   * Check if a process is running
   * @returns {boolean}
   */
  isRunning() {
    return this.currentProcess !== null && !this.currentProcess.killed;
  }

  /**
   * Kill current process
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = 'SIGTERM') {
    if (this.currentProcess && !this.currentProcess.killed) {
      if (this.providerAdapter?.getName() === 'omp' && process.platform !== 'win32') {
        const child = this.currentProcess;
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, 500);
        timer.unref();
      } else this.currentProcess.kill(signal);
    }
  }

  /**
   * Get elapsed time since start
   * @returns {number|null}
   */
  getElapsed() {
    return this.startTime ? Date.now() - this.startTime : null;
  }

  /**
   * Extract token/cost usage from provider stream events.
   *
   * Providers differ here: Claude stream-json commonly reports usage on message
   * or result events, while other providers may use camelCase or aggregate cost
   * fields. This method intentionally reads only numeric fields and returns a
   * zero-usage result when the event has no observable accounting data.
   *
   * @private
   * @param {Object} event - Raw event object
   * @returns {Object} Usage counters
   */
  _extractUsageStats(event) {
    // Usage can live at event.usage (result events) OR event.message.usage
    // (assistant events). Reading only the former lost all usage on timed-out
    // sessions, whose terminal result event never arrives (#1766).
    const usage =
      (event?.usage && typeof event.usage === 'object' && event.usage) ||
      (event?.message?.usage && typeof event.message.usage === 'object' && event.message.usage) ||
      {};
    const numberFrom = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return undefined;
    };
    let hasTokenField = false;
    const tokenFrom = (...values) => {
      const value = numberFrom(...values);
      if (value !== undefined) hasTokenField = true;
      return value;
    };

    const inputTokens = tokenFrom(
      usage.input_tokens,
      usage.inputTokens,
      event.input_tokens,
      event.inputTokens
    ) ?? 0;
    const outputTokens = tokenFrom(
      usage.output_tokens,
      usage.outputTokens,
      event.output_tokens,
      event.outputTokens
    ) ?? 0;
    const cacheCreationInputTokens = tokenFrom(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
      event.cache_creation_input_tokens,
      event.cacheCreationInputTokens
    ) ?? 0;
    const cacheReadInputTokens = tokenFrom(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      event.cache_read_input_tokens,
      event.cacheReadInputTokens
    ) ?? 0;
    const explicitTotal = tokenFrom(
      usage.total_tokens,
      usage.totalTokens,
      event.total_tokens,
      event.totalTokens
    );
    const totalTokens = explicitTotal ??
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const costCandidates = [
      event.cost_usd,
      event.total_cost_usd,
      event.costUsd,
      event.totalCostUsd,
      usage.cost_usd,
      usage.costUsd,
    ];
    const hasCostField = costCandidates.some(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
    const costUsd = numberFrom(...costCandidates) ?? 0;

    return {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens,
      costUsd,
      hasCostField,
      hasTokenField,
      hasUsage: hasTokenField || hasCostField,
    };
  }
}

/**
 * Check if Claude CLI is available
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get Claude CLI version
 * @returns {Promise<string|null>}
 */
export async function getClaudeVersion() {
  return new Promise((resolve) => {
    let output = '';

    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

export default SessionLauncher;
