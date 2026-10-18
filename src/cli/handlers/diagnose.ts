/**
 * Diagnose Command Handler
 *
 * `aiwg diagnose` — produces a shareable support bundle for bug reports.
 *
 * Bundle contents:
 *   - manifest.json            environment fingerprint + collection timestamp
 *   - logs/aiwg-YYYY-MM-DD.jsonl  last 7 days of JSONL logs (or last 1000 lines, smaller)
 *   - config.json              sanitized copy of .aiwg/aiwg.config (if present)
 *   - git.txt                  `git log -10 --oneline` + branch + remote (if in a repo)
 *   - doctor.txt               output of `aiwg doctor` (best-effort)
 *
 * Sanitization (unless --include-secrets):
 *   - Strip environment variables matching *SECRET*, *TOKEN*, *PASS*, *KEY*
 *   - Replace any absolute path containing ~/.ssh with <redacted>
 *   - Remove API tokens from config.json (any field name ending in token/secret/key)
 *
 * Output modes:
 *   --tarball   (default) write aiwg-diagnose-YYYYMMDDHHMMSS.tar.gz in cwd
 *   --stdout    write a single-file JSON manifest to stdout (for pasting into issues)
 *
 * @implements #925
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { getVersionInfo } from '../../channel/manager.mjs';
import { getLoggerInfo } from '../log.js';
import { readAiwgConfig, getProjectDir } from '../../config/aiwg-config.js';
import { getLogger } from '../log.js';
import { spawnSync } from 'child_process';
import { boundedSpawnSync } from '../../process/bounded-child-process.mjs';
import { exitCodeForSpawnResult } from '../child-process-result.js';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import * as ui from '../ui.js';

const SECRET_ENV_PATTERNS = [/SECRET/i, /TOKEN/i, /PASS/i, /_KEY$/i, /API_KEY/i, /PRIVATE/i];
const SECRET_FIELD_PATTERNS = [/token/i, /secret/i, /key$/i, /password/i, /api[-_]?key/i];

export const diagnoseHandler: CommandHandler = {
  id: 'diagnose',
  name: 'Diagnose',
  description: 'Produce a shareable support bundle (logs + env + config) for bug reports',
  category: 'maintenance',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const stdoutMode = ctx.args.includes('--stdout');
    const includeSecrets = ctx.args.includes('--include-secrets');
    const cwd = getProjectDir(ctx, ctx.args);

    const log = getLogger('cli:diagnose');
    const span = log.span('diagnose', { stdoutMode, includeSecrets });
    const bundle = await collectBundle({ cwd, includeSecrets });
    // Config-driven from package.json (single source of truth) — never hardcode
    // the build origin in user-facing output.
    const { issuesUrl, homepage } = await getVersionInfo();
    span.end('bundle-collected', {
      logs: bundle.logs.length,
      has_config: bundle.config !== null,
      has_git: bundle.git !== null,
    });

    if (stdoutMode) {
      console.log(JSON.stringify(bundle, null, 2));
      return { exitCode: 0 };
    }

    // Tarball mode: write each file into a tmpdir, tar it up, clean up.
    const outName = `aiwg-diagnose-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.tar.gz`;
    const outPath = path.resolve(cwd, outName);

    const stage = mkdtempSync(path.join(os.tmpdir(), 'aiwg-diagnose-'));
    try {
      // manifest.json
      writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2) + '\n');
      // config.json
      if (bundle.config) writeFileSync(path.join(stage, 'config.json'), JSON.stringify(bundle.config, null, 2) + '\n');
      // git.txt
      if (bundle.git) writeFileSync(path.join(stage, 'git.txt'), bundle.git);
      // doctor.txt
      if (bundle.doctor) writeFileSync(path.join(stage, 'doctor.txt'), bundle.doctor);
      // env.txt (sanitized)
      writeFileSync(path.join(stage, 'env.txt'), bundle.manifest.env.map((kv) => `${kv[0]}=${kv[1]}`).join('\n') + '\n');
      // logs/*.jsonl
      if (bundle.logs.length > 0) {
        const logsDir = path.join(stage, 'logs');
        require('fs').mkdirSync(logsDir, { recursive: true });
        for (const f of bundle.logs) {
          writeFileSync(path.join(logsDir, f.name), f.content);
        }
      }

      // tar it up via system tar. We rely on GNU/BSD tar being present;
      // degrade gracefully if not.
      // Packaging a small local diagnostics bundle; quick tier (#3062).
      const tar = boundedSpawnSync('tar', ['-czf', outPath, '-C', stage, '.'], 'quick', { stdio: 'pipe' });
      if (tar.status !== 0) {
        // #3062 review item 7: already correctly treats a null status
        // (timeout/signal) as failure; surface the bounded helper's
        // diagnostic (e.g. the enriched timeout message) ahead of stderr.
        const detail = exitCodeForSpawnResult(tar).message ?? tar.stderr?.toString() ?? '(no stderr)';
        ui.error(`tar failed: ${detail}`);
        ui.info(`Bundle contents staged at: ${stage}`);
        ui.info(`You can tar it manually: tar -czf ${outName} -C ${stage} .`);
        return { exitCode: 1, error: new Error('tar failed') };
      }

      ui.success(`Diagnose bundle written to: ${outPath}`);
      const size = statSync(outPath).size;
      ui.dim(`  Size: ${(size / 1024).toFixed(1)} KB`);
      ui.dim(`  Attach to bug reports at ${issuesUrl || homepage}`);
      if (!includeSecrets) {
        ui.dim(`  Sanitized: env vars matching SECRET/TOKEN/PASS/KEY stripped, config secrets redacted`);
        ui.dim(`  (pass --include-secrets to skip sanitization, but please inspect the bundle first)`);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }

    return { exitCode: 0 };
  },
};

interface DiagnoseBundle {
  manifest: {
    collected_at: string;
    version: string;
    channel: string;
    packageRoot: string;
    git?: { sha: string; branch: string; path: string };
    node: string;
    platform: { os: string; arch: string; release: string };
    tty: { stdin: boolean; stdout: boolean; stderr: boolean };
    logger: { level: string; logFile: string | null; disabled: boolean };
    invocation_id: string;
    env: Array<[string, string]>;
    sanitized: boolean;
  };
  config: Record<string, unknown> | null;
  git: string | null;
  doctor: string | null;
  logs: Array<{ name: string; content: string }>;
}

async function collectBundle(opts: { cwd: string; includeSecrets: boolean }): Promise<DiagnoseBundle> {
  const versionInfo = await getVersionInfo();
  const loggerInfo = getLoggerInfo();

  // Sanitized env — strip secret-looking values unless opts.includeSecrets.
  const env: Array<[string, string]> = Object.entries(process.env)
    .filter(([k]) => k.startsWith('AIWG_') || k === 'NODE_ENV' || k === 'CI' || k === 'TERM' || k === 'LANG' || k === 'TZ' || k === 'PATH')
    .map(([k, v]) => {
      if (!opts.includeSecrets && SECRET_ENV_PATTERNS.some(r => r.test(k))) {
        return [k, '<redacted>'] as [string, string];
      }
      return [k, redactPath(v ?? '', opts.includeSecrets)] as [string, string];
    })
    .sort(([a], [b]) => a.localeCompare(b));

  // Project config — stripped of secret-looking fields.
  let config: Record<string, unknown> | null = null;
  try {
    const raw = await readAiwgConfig(opts.cwd);
    if (raw) {
      const asRecord = raw as unknown as Record<string, unknown>;
      config = opts.includeSecrets ? asRecord : redactSecretsInObject(asRecord);
    }
  } catch { /* ignore */ }

  // Git state — best-effort.
  const git = collectGitInfo(opts.cwd);

  // Doctor output — best-effort, spawn aiwg doctor locally.
  const doctor = collectDoctorOutput();

  // Logs — last 7 days of JSONL files, capped at 1 MB total.
  const logs = collectRecentLogs(loggerInfo.logFile, 7, 1_000_000, opts.includeSecrets);

  return {
    manifest: {
      collected_at: new Date().toISOString(),
      version: versionInfo.version,
      channel: versionInfo.devMode ? 'dev' : versionInfo.channel,
      packageRoot: versionInfo.packageRoot,
      ...(versionInfo.gitHash ? {
        git: {
          sha: versionInfo.gitHash,
          branch: versionInfo.gitBranch ?? '(unknown)',
          path: versionInfo.edgePath ?? versionInfo.packageRoot,
        },
      } : {}),
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
        logFile: loggerInfo.logFile,
        disabled: loggerInfo.disabled,
      },
      invocation_id: loggerInfo.provenance.invocation_id,
      env,
      sanitized: !opts.includeSecrets,
    },
    config,
    git,
    doctor,
    logs,
  };
}

function redactPath(v: string, includeSecrets: boolean): string {
  if (includeSecrets) return v;
  // Hide paths under ~/.ssh (common leak source for token files).
  return v.replace(new RegExp(path.join(os.homedir(), '\\.ssh', '[^:\\s]*'), 'g'), '<redacted>');
}

function redactSecretsInObject(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return obj as Record<string, unknown>;
  const out: Record<string, unknown> = Array.isArray(obj) ? ([] as unknown as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD_PATTERNS.some(r => r.test(k))) {
      (out as Record<string, unknown>)[k] = '<redacted>';
    } else if (typeof v === 'object' && v !== null) {
      (out as Record<string, unknown>)[k] = redactSecretsInObject(v);
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function collectGitInfo(cwd: string): string | null {
  try {
    const branch = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', timeout: 5000, killSignal: 'SIGKILL' });
    const log = spawnSync('git', ['-C', cwd, 'log', '-10', '--oneline'], { stdio: 'pipe', timeout: 5000, killSignal: 'SIGKILL' });
    const remote = spawnSync('git', ['-C', cwd, 'remote', '-v'], { stdio: 'pipe', timeout: 5000, killSignal: 'SIGKILL' });
    if (branch.status !== 0) return null;
    return [
      `branch: ${branch.stdout.toString().trim()}`,
      '',
      'recent commits:',
      log.stdout.toString().trim(),
      '',
      'remotes:',
      remote.stdout.toString().trim(),
    ].join('\n');
  } catch {
    return null;
  }
}

function collectDoctorOutput(): string | null {
  try {
    const r = spawnSync(process.execPath, [process.argv[1]!, 'doctor'], {
      stdio: 'pipe',
      timeout: 30_000,
      env: { ...process.env, AIWG_LOG_DISABLE: '1', NO_COLOR: '1' },
      killSignal: 'SIGKILL',
    });
    const out = r.stdout?.toString() ?? '';
    const err = r.stderr?.toString() ?? '';
    return (out + (err ? '\n\n-- stderr --\n' + err : '')).trim();
  } catch {
    return null;
  }
}

function collectRecentLogs(
  logFile: string | null,
  days: number,
  maxBytes: number,
  includeSecrets: boolean,
): Array<{ name: string; content: string }> {
  if (!logFile) return [];
  const dir = path.dirname(logFile);
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir)
      .filter(f => /^aiwg-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }

  const out: Array<{ name: string; content: string }> = [];
  let total = 0;
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const s = statSync(full);
      if (s.mtimeMs < cutoff) break;
      let content = readFileSync(full, 'utf-8');
      if (!includeSecrets) content = redactLogContent(content);
      // Cap per-file size so a runaway log doesn't dominate the bundle.
      if (total + content.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining > 0) {
          // Take the last `remaining` bytes — most recent records.
          content = content.slice(-remaining);
          out.push({ name, content });
        }
        break;
      }
      out.push({ name, content });
      total += content.length;
    } catch { /* ignore per-file errors */ }
  }
  return out;
}

function redactLogContent(content: string): string {
  // Line-by-line JSONL redaction. Parse each line, redact secret fields,
  // re-emit. Fall back to raw on parse failure.
  return content
    .split('\n')
    .map(line => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        return JSON.stringify(redactSecretsInObject(obj));
      } catch {
        return line;
      }
    })
    .join('\n');
}
