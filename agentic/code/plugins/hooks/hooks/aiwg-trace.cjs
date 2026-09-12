#!/usr/bin/env node
/**
 * AIWG Trace Hook
 *
 * Captures multi-agent workflow execution traces for observability.
 *
 * Research Foundation:
 * - REF-001: BP-6 - Observability requirements
 * - REF-002: Archetype 4 - Recovery needs execution history
 *
 * Hook Events:
 * - SubagentStart: Log agent spawn with metadata
 * - SubagentStop: Capture transcript path, duration, outcome
 * - ToolCall: Track tool invocations (optional, verbose)
 *
 * Usage:
 * Add to .claude/settings.local.json:
 * {
 *   "hooks": {
 *     "SubagentStart": ["node", "/path/to/aiwg-trace.cjs", "start"],
 *     "SubagentStop": ["node", "/path/to/aiwg-trace.cjs", "stop"]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolve the project's AIWG artifact root.
 *
 * Traces are payload, not control plane, so they belong under the configured
 * artifact root rather than the repository-local `.aiwg`. Hardcoding
 * `.aiwg/traces` wrote payload into the control plane on every subagent stop,
 * which on a split-root workspace re-dirtied it continuously — a reconciled
 * corpus regressed to `duplicated-divergent-payload` the next time an agent ran.
 *
 * Mirrors `resolveProjectAiwgDir()` in src/config/project-artifacts-runtime.mjs.
 * Duplicated deliberately: this hook is deployed standalone as CommonJS into
 * `.claude/hooks/` and cannot import the package's ESM resolver.
 */
function resolveArtifactRoot(projectDir) {
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return expandArtifactPath(value, projectDir);
    }
  }
  try {
    const pointer = path.resolve(projectDir, '.aiwg-location');
    if (fs.existsSync(pointer)) {
      for (const rawLine of fs.readFileSync(pointer, 'utf-8').split(/\r?\n/)) {
        let line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice('export '.length).trim();
        const assignment = line.match(/^AIWG_ARTIFACTS_PATH\s*=\s*(.+)$/);
        if (assignment) line = assignment[1].trim();
        if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
          line = line.slice(1, -1);
        }
        if (line.length > 0) return expandArtifactPath(line, projectDir);
        break;
      }
    }
  } catch {
    // Unreadable pointer falls back to the repository-local default below.
  }
  return path.resolve(projectDir, '.aiwg');
}

function expandArtifactPath(value, projectDir) {
  const trimmed = value.trim();
  const home = require('os').homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return path.resolve(home, trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(projectDir, trimmed);
}

// Configuration. AIWG_TRACE_DIR remains the explicit per-call override.
const TRACE_DIR = process.env.AIWG_TRACE_DIR
  || path.join(resolveArtifactRoot(process.cwd()), 'traces');
const TRACE_FILE = process.env.AIWG_TRACE_FILE || 'current-trace.jsonl';
const VERBOSE = process.env.AIWG_TRACE_VERBOSE === 'true';

// Ensure trace directory exists
function ensureTraceDir() {
  const tracePath = path.resolve(TRACE_DIR);
  if (!fs.existsSync(tracePath)) {
    fs.mkdirSync(tracePath, { recursive: true });
  }
  return tracePath;
}

// Append trace event
function appendTrace(event) {
  const tracePath = ensureTraceDir();
  const traceFile = path.join(tracePath, TRACE_FILE);

  const entry = {
    timestamp: new Date().toISOString(),
    ...event
  };

  fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n');

  if (VERBOSE) {
    console.error(`[AIWG-TRACE] ${event.type}: ${event.agent_id || event.subagent_type || 'unknown'}`);
  }
}

// Parse hook input from stdin
async function parseInput() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    // Handle case where no stdin
    setTimeout(() => resolve({}), 100);
  });
}

// Handle SubagentStart
async function handleStart(input) {
  appendTrace({
    type: 'agent_start',
    agent_id: input.agent_id,
    subagent_type: input.subagent_type,
    parent_id: input.parent_id,
    model: input.model,
    tools: input.tools,
    workflow_id: process.env.AIWG_WORKFLOW_ID
  });
}

// Handle SubagentStop
async function handleStop(input) {
  appendTrace({
    type: 'agent_stop',
    agent_id: input.agent_id,
    subagent_type: input.subagent_type,
    transcript_path: input.agent_transcript_path,
    duration_ms: input.duration_ms,
    outcome: input.outcome, // success, error, timeout
    error: input.error,
    workflow_id: process.env.AIWG_WORKFLOW_ID
  });

  // Copy transcript to traces directory if available
  if (input.agent_transcript_path && fs.existsSync(input.agent_transcript_path)) {
    const tracePath = ensureTraceDir();
    const transcriptDest = path.join(tracePath, 'transcripts', `${input.agent_id}.json`);

    const transcriptDir = path.dirname(transcriptDest);
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    fs.copyFileSync(input.agent_transcript_path, transcriptDest);
  }
}

// Handle ToolCall (optional verbose mode)
async function handleTool(input) {
  if (!VERBOSE) return;

  appendTrace({
    type: 'tool_call',
    agent_id: input.agent_id,
    tool: input.tool,
    parameters: input.parameters,
    workflow_id: process.env.AIWG_WORKFLOW_ID
  });
}

// Main
async function main() {
  const command = process.argv[2];
  const input = await parseInput();

  switch (command) {
    case 'start':
      await handleStart(input);
      break;
    case 'stop':
      await handleStop(input);
      break;
    case 'tool':
      await handleTool(input);
      break;
    default:
      console.error('Usage: aiwg-trace.cjs <start|stop|tool>');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('[AIWG-TRACE] Error:', err.message);
  process.exit(1);
});
