#!/usr/bin/env node
/**
 * AIWG Runtime Info Script
 *
 * Detects the current runtime environment (provider, platform, tools).
 * Called by `aiwg sync` to gather environment context before syncing.
 *
 * @issue #685
 */

import os from 'os';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

// Markers a current Claude Code session actually sets (CLI and Desktop Code
// tab); mirrors the `claude` provider's `detection.env` in
// src/providers/provider-definitions.ts (#2623, #2627, #3054). Kept here as
// the no-build-output fallback for isClaudeCodeSession() below.
const CLAUDE_CODE_ENV_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DESKTOP_APP_VERSION'];

/**
 * Whether the current session is Claude Code, resolved through the same
 * shared `resolveActiveProvider` path `runtime-info` (the TS handler) and
 * `steward capabilities` use, so none of them disagree (#2623, #2627,
 * #3054). `detectProcess: false` keeps this an environment-only check,
 * matching the ad-hoc check this replaced; process-tree detection already
 * runs separately below via detectProviderFromProcessTree().
 */
export async function isClaudeCodeSession() {
  try {
    const { resolveActiveProvider, isSessionProviderResolution } = await importImpl(import.meta.url, 'cli/provider-resolution.js');
    const resolution = await resolveActiveProvider({ cwd: process.cwd(), detectProcess: false });
    // Project configuration or a deployed provider directory is not a session signal.
    return resolution.provider === 'claude' && isSessionProviderResolution(resolution);
  } catch {
    // No build output to resolve the shared path through (e.g. running from
    // a source checkout without `npm run build`): fall back to the same
    // markers directly instead of crashing.
    return CLAUDE_CODE_ENV_MARKERS.some((key) => process.env[key] !== undefined);
  }
}

export function detectProviderFromProcessTree(pid = process.pid) {
  let current = pid;
  const seen = new Set();
  for (let depth = 0; depth < 12 && current > 1 && !seen.has(current); depth += 1) {
    seen.add(current);
    try {
      const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      const ppid = Number(fields[1]);
      const cmdline = readFileSync(`/proc/${current}/cmdline`, 'utf8').replace(/\0/g, ' ').toLowerCase();
      if (cmdline.includes('@openai/codex') || /(?:^|[\/\s])codex(?:$|[\s\/])/.test(cmdline)) return 'codex';
      if (cmdline.includes('claude-code') || /(?:^|[\/\s])claude(?:$|[\s\/])/.test(cmdline)) return 'claude';
      current = Number.isFinite(ppid) ? ppid : 0;
    } catch {
      return null;
    }
  }
  return null;
}

export async function detectProvider() {
  const explicit = process.env.AIWG_PROVIDER || process.env.CLAUDECODE_PROVIDER;
  if (explicit === 'openai') return 'codex';
  if (explicit === 'claude-code') return 'claude';
  if (explicit) return explicit;
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return 'codex';
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_VERSION) return 'cursor';
  if (process.env.WINDSURF_VERSION) return 'devin';
  if (process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL) return 'warp';
  if (process.env.COPILOT_AGENT || process.env.GITHUB_COPILOT_TOKEN) return 'copilot';
  if (process.env.FACTORY_AGENT_ID) return 'factory';
  if (process.env.OPENCODE_VERSION) return 'opencode';
  if (process.env.OPENCLAW_VERSION) return 'openclaw';
  if (await isClaudeCodeSession()) return 'claude';
  return detectProviderFromProcessTree() || 'unknown';
}
function getNodeVersion() {
  return process.version;
}

function getNpmVersion() {
  try {
    return boundedExecSync('npm --version', 'quick', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');

  const info = {
    provider: await detectProvider(),
    platform: os.platform(),
    arch: os.arch(),
    node: getNodeVersion(),
    npm: getNpmVersion(),
    cwd: process.cwd(),
  };

  if (json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`  Provider: ${info.provider}`);
    console.log(`  Platform: ${info.platform}/${info.arch}`);
    console.log(`  Node:     ${info.node}`);
    console.log(`  npm:      ${info.npm}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
