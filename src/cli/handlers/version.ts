/**
 * Version Command Handler
 *
 * Displays version and channel information for the AIWG installation.
 * Supports --verbose / --json for full environment fingerprint (Phase 4.5 #925).
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @source @src/cli/router.ts
 * @issue #33, #925
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { getVersionInfo } from '../../channel/manager.mjs';
import { getLoggerInfo } from '../log.js';
import * as ui from '../ui.js';
import { maybePrintCommunityFooter } from '../../community/footer.js';
import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Version command handler
 */
export const versionHandler: CommandHandler = {
  id: 'version',
  name: 'Version',
  description: 'Show version and channel info (--verbose for full env fingerprint, --json for machine-readable)',
  category: 'maintenance',
  aliases: ['-version', '--version'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const verbose = ctx.args.includes('--verbose') || ctx.args.includes('-v') || ctx.args.includes('-vv') || ctx.args.includes('-vvv');
    const json = ctx.args.includes('--json');
    await displayVersion({ verbose, json });
    return { exitCode: 0 };
  },
};

interface VersionFingerprint {
  version: string;
  launcherVersion: string;
  runtimeVersion: string;
  runtimePath: string;
  channel: string;
  packageRoot: string;
  git?: { sha: string; branch: string; path: string };
  node: string;
  platform: { os: string; arch: string; release: string };
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
  locale?: string;
  timezone?: string;
  logger: {
    level: string;
    disabled: boolean;
    logFile: string | null;
    recordsToday?: number;
    logFileSize?: number;
  };
  invocation_id: string;
  installation: Awaited<ReturnType<typeof getVersionInfo>>['installation'];
  /**
   * Set when the canonical installation declares a different root than the one
   * actually executing. `version` above is always the running binary's (#2529).
   */
  drift?: { canonicalRoot: string; canonicalVersion: string | null; actualRoot: string };
}

/**
 * Print the installation-drift notice when the canonical declaration and the
 * running binary disagree. Keeps `aiwg version` honest about which one it is
 * describing, and names the command that explains the rest (#2529).
 */
function printDrift(fp: VersionFingerprint): void {
  if (fp.drift) {
    const method = fp.installation?.identity?.method ?? 'unrecorded';
    const declared = fp.drift.canonicalVersion ? ` (${fp.drift.canonicalVersion})` : '';
    ui.dim(`    ! canonical install declares ${method} at ${fp.drift.canonicalRoot}${declared} — run \`aiwg installation show\``);
    return;
  }
  // Same root, different method (a source checkout recorded as npm, or the
  // reverse) is drift too; `version` is the first recovery command an operator
  // reaches for, so it must say so instead of looking aligned (#2559).
  const state = fp.installation?.state;
  if (state && state !== 'aligned' && state !== 'unrecorded') {
    const reasons = Array.isArray(fp.installation?.drift) ? fp.installation.drift : [];
    ui.dim(`    ! installation identity ${state}: ${reasons.join('; ') || 'see aiwg installation show'} — run \`aiwg installation show\``);
  }
}

function collectFingerprint(versionInfo: Awaited<ReturnType<typeof getVersionInfo>>): VersionFingerprint {
  const loggerInfo = getLoggerInfo();
  const fp: VersionFingerprint = {
    version: versionInfo.version,
    launcherVersion: versionInfo.launcherVersion ?? versionInfo.version,
    runtimeVersion: versionInfo.runtimeVersion ?? versionInfo.version,
    runtimePath: versionInfo.runtimePath ?? versionInfo.packageRoot,
    channel: versionInfo.devMode ? 'dev' : versionInfo.channel,
    packageRoot: versionInfo.packageRoot,
    node: process.version,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: loggerInfo.provenance.os_release,
    },
    tty: {
      stdin: !!process.stdin.isTTY,
      stdout: !!process.stdout.isTTY,
      stderr: !!process.stderr.isTTY,
    },
    logger: {
      level: loggerInfo.level,
      disabled: loggerInfo.disabled,
      logFile: loggerInfo.logFile,
    },
    invocation_id: loggerInfo.provenance.invocation_id,
    installation: versionInfo.installation,
  };

  if (versionInfo.gitHash) {
    fp.git = {
      sha: versionInfo.gitHash,
      branch: versionInfo.gitBranch ?? '(unknown)',
      path: versionInfo.edgePath ?? versionInfo.packageRoot,
    };
  }

  // `version` is the first thing anyone runs to answer "what am I on". If the
  // canonical install declares a different root than the one executing, say so
  // here rather than letting drift persist while every check looks correct.
  const canonicalRoot = fp.installation?.identity?.root;
  const actualRoot = fp.installation?.actualRoot;
  if (canonicalRoot && actualRoot && path.resolve(canonicalRoot) !== path.resolve(actualRoot)) {
    let canonicalVersion: string | null = null;
    try {
      const pkg = JSON.parse(readFileSync(path.join(canonicalRoot, 'package.json'), 'utf8')) as { version?: string };
      canonicalVersion = pkg.version ?? null;
    } catch {
      // Canonical root may not exist or be readable; report the drift regardless.
    }
    fp.drift = { canonicalRoot, canonicalVersion, actualRoot };
  }

  // Locale / timezone are useful for timezone-dependent bug reports.
  try {
    fp.locale = Intl.DateTimeFormat().resolvedOptions().locale;
    fp.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { /* ignore */ }

  // Log file stats — "you've written N records today, file is X MB".
  if (loggerInfo.logFile && existsSync(loggerInfo.logFile)) {
    try {
      fp.logger.logFileSize = statSync(loggerInfo.logFile).size;
      // Cheap line count via readdirSync of the log directory — not the line
      // count itself (avoids reading the whole file).
      const dir = path.dirname(loggerInfo.logFile);
      const today = new Date().toISOString().slice(0, 10);
      const file = readdirSync(dir).find(f => f === `aiwg-${today}.jsonl`);
      if (file) {
        // Defer actual line count to aiwg diagnose; here we just signal presence.
        fp.logger.recordsToday = undefined;
      }
    } catch { /* ignore */ }
  }

  return fp;
}

async function displayVersion(opts: { verbose: boolean; json: boolean }): Promise<void> {
  const info = await getVersionInfo();
  const fp = collectFingerprint(info);

  if (opts.json) {
    console.log(JSON.stringify(fp, null, 2));
    return;
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('aiwg')}  ${ui.bold(fp.version)}  ${ui.channelLabel(fp.channel)}`);
  if (info.devMode || fp.launcherVersion !== fp.runtimeVersion) {
    ui.dim(`    launcher: ${fp.launcherVersion}`);
    ui.dim(`    runtime: ${fp.runtimeVersion}`);
    ui.dim(`    runtime path: ${fp.runtimePath}`);
  }

  if (!opts.verbose) {
    if (fp.git) ui.dim(`    git: ${fp.git.sha} (${fp.git.branch})`);
    // Always the root that actually executed — not the declared edge checkout,
    // which is what made drift invisible here (#2529).
    ui.dim(`    path: ${fp.packageRoot}`);
    printDrift(fp);
    maybePrintCommunityFooter();
    ui.blank();
    return;
  }

  // --verbose: the full environment fingerprint.
  if (fp.git) {
    ui.dim(`    git:       ${fp.git.sha} (${fp.git.branch})`);
    if (fp.git.path !== fp.packageRoot) ui.dim(`    edge:      ${fp.git.path}`);
  }
  ui.dim(`    path:      ${fp.packageRoot}`);
  ui.dim(`    channel:   ${fp.channel}`);
  ui.dim(`    install:   ${fp.installation?.identity?.method ?? 'unrecorded'} (${fp.installation?.state ?? 'unknown'})`);
  ui.dim(`    canonical: ${fp.installation?.identity?.root ?? '(unrecorded)'}`);
  ui.dim(`    actual:    ${fp.installation?.actualRoot ?? fp.packageRoot}`);
  ui.dim(`    node:      ${fp.node}`);
  ui.dim(`    platform:  ${fp.platform.os} ${fp.platform.arch} (${fp.platform.release})`);
  ui.dim(`    tty:       stdin=${fp.tty.stdin} stdout=${fp.tty.stdout} stderr=${fp.tty.stderr}`);
  if (fp.locale) ui.dim(`    locale:    ${fp.locale} (TZ=${fp.timezone})`);
  const logDesc = fp.logger.disabled
    ? '(disabled via AIWG_LOG_DISABLE)'
    : fp.logger.logFile
      ? `${fp.logger.logFile}${fp.logger.logFileSize !== undefined ? ` (${(fp.logger.logFileSize / 1024).toFixed(1)} KB)` : ''}`
      : '(stderr only)';
  ui.dim(`    log:       ${logDesc}`);
  ui.dim(`    level:     ${fp.logger.level}`);
  ui.dim(`    invocation:${fp.invocation_id}`);
  maybePrintCommunityFooter();
  ui.blank();
}
