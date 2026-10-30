/**
 * Claude Code aiwg-hooks installer (PUW-010 / #1111).
 *
 * When `aiwg use --provider claude` runs and the operator hasn't opted
 * out via `--no-hooks`, this module:
 *   1. Copies the aiwg-hooks addon's JS handler scripts to .claude/hooks/
 *   2. Reads existing .claude/settings.json (backing up first if no AIWG
 *      marker is present, per ADR-3 §5)
 *   3. Merges AIWG hook entries with `_aiwg_managed: true` tagging
 *   4. Writes settings.json atomically
 *
 * Schema: Claude Code requires `hooks` to be an object keyed by event
 * name, each value an array of matcher groups. See #107.
 *
 *   {
 *     "hooks": {
 *       "<EventName>": [
 *         { "matcher": "<optional regex>",
 *           "hooks": [{ "type": "command", "command": "..." }] }
 *       ]
 *     }
 *   }
 *
 * The merge preserves operator-authored entries. Legacy array-shaped
 * hook fields written by older AIWG builds are migrated to the object
 * shape on read. `aiwg refresh --restore-hooks` reads the most-recent
 * .bak.<timestamp> file and restores it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../providers/deployment-ownership.mjs';
import { mergeClaudeAttribution, undoClaudeAttribution } from './claude-attribution.js';

/**
 * Hook script → Claude Code hook event mapping.
 *
 * Per the script-source comments at agentic/code/addons/aiwg-hooks/hooks/.
 */
const HOOK_SCRIPTS: ReadonlyArray<{
  file: string;
  events: Readonly<Record<string, string | undefined>>;
}> = [
  { file: 'aiwg-permissions.cjs', events: { PermissionRequest: undefined } },
  { file: 'aiwg-session.cjs', events: { SessionStart: undefined } },
  {
    file: 'aiwg-trace.cjs',
    events: { SubagentStart: 'start', SubagentStop: 'stop' },
  },
];

interface HookEntry {
  type: string;
  command: string;
  _aiwg_managed?: boolean;
  _aiwg_id?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksField = Record<string, HookGroup[]>;

interface ClaudeSettings {
  [key: string]: unknown;
  hooks?: HooksField | LegacyHookMatcher[];
}

/** Legacy shape written by AIWG before #107: array of `{matcher, hooks}` */
interface LegacyHookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

export interface InstallOptions {
  /** Project root absolute path (where .claude/ lives) */
  projectPath: string;
  /** Framework root (where agentic/code/addons/aiwg-hooks/ lives) */
  frameworkRoot: string;
  /** Don't write files; describe what would happen */
  dryRun?: boolean;
  /** Install hook scripts and registrations (default true). */
  hooks?: boolean;
  /** Fill unset attribution keys (default true). */
  attribution?: boolean;
  /** Force overwrite even when settings.json has no AIWG marker (with backup) */
  force?: boolean;
  /** Verbose logging */
  verbose?: boolean;
}

export interface InstallResult {
  installedScripts: string[];
  settingsPath: string;
  backupPath?: string;
  registeredEvents: string[];
  warnings: string[];
  /** True when the installer migrated a legacy array-shaped `hooks` field */
  migratedFromLegacy?: boolean;
}

/**
 * Migrate a legacy array-shaped `hooks` field to the object form Claude
 * Code expects. Returns the normalized object.
 */
function migrateLegacyHooks(legacy: LegacyHookMatcher[]): HooksField {
  const out: HooksField = {};
  for (const m of legacy) {
    if (!m || typeof m.matcher !== 'string' || !Array.isArray(m.hooks)) continue;
    if (!out[m.matcher]) out[m.matcher] = [];
    out[m.matcher].push({ hooks: m.hooks });
  }
  return out;
}

/**
 * Normalize the hooks field to the object form, migrating legacy arrays.
 * Returns `[hooks, didMigrate]`.
 */
function normalizeHooks(
  raw: HooksField | LegacyHookMatcher[] | undefined,
): [HooksField, boolean] {
  if (Array.isArray(raw)) return [migrateLegacyHooks(raw), true];
  if (raw && typeof raw === 'object') return [raw, false];
  return [{}, false];
}

/**
 * Detect whether the existing settings carries the AIWG signature — either a hook
 * entry tagged `_aiwg_managed: true`, or the top-level `aiwg` stamp written when
 * AIWG creates the file itself (tools/agents/providers/claude.mjs). Without the
 * latter, a greenfield deploy backs up the settings.json it created seconds
 * earlier and reports it as protected operator content (#2542). Accepts both the
 * current object form and the legacy array form.
 */
function hasAiwgMarker(settings: ClaudeSettings): boolean {
  const stamp = (settings as { aiwg?: unknown }).aiwg;
  if (stamp && typeof stamp === 'object') return true;

  const hooksField = settings.hooks;
  if (!hooksField) return false;

  const groups: HookGroup[] = Array.isArray(hooksField)
    ? hooksField.map((m) => ({ hooks: m.hooks }))
    : Object.values(hooksField).flat();

  return groups.some(
    (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h && h._aiwg_managed === true),
  );
}

/**
 * Atomic write via tmpfile+rename so partial state never persists.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Install AIWG hooks for Claude Code.
 *
 * Returns null if the addon source isn't present (e.g., aiwg-hooks not
 * installed). Otherwise returns an InstallResult describing what was
 * written.
 */
export async function installAiwgHooks(opts: InstallOptions): Promise<InstallResult | null> {
  const ownershipRoots = [path.join(opts.projectPath, '.claude')];
  const ownershipBefore = opts.dryRun ? undefined : captureDeploymentOutputs(ownershipRoots);
  const sourceHooksDir = path.join(
    opts.frameworkRoot,
    'agentic',
    'code',
    'addons',
    'aiwg-hooks',
    'hooks',
  );

  let sourceFiles: string[];
  try {
    sourceFiles = opts.hooks === false ? [] : await fs.readdir(sourceHooksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const result: InstallResult = {
    installedScripts: [],
    settingsPath: path.join(opts.projectPath, '.claude', 'settings.json'),
    registeredEvents: [],
    warnings: [],
  };

  // 1. Copy hook scripts to .claude/hooks/
  const claudeHooksDir = path.join(opts.projectPath, '.claude', 'hooks');
  if (!opts.dryRun && opts.hooks !== false) {
    await fs.mkdir(claudeHooksDir, { recursive: true });
  }

  for (const { file } of opts.hooks === false ? [] : HOOK_SCRIPTS) {
    if (!sourceFiles.includes(file)) {
      result.warnings.push(`hook script not found in addon source: ${file}`);
      continue;
    }
    const src = path.join(sourceHooksDir, file);
    const dst = path.join(claudeHooksDir, file);
    if (opts.dryRun) {
      result.installedScripts.push(`${dst} (dry-run)`);
      continue;
    }
    await fs.copyFile(src, dst);
    try {
      await fs.chmod(dst, 0o755);
    } catch {
      // Non-POSIX
    }
    result.installedScripts.push(dst);
  }

  // 2. Read existing settings.json
  let settings: ClaudeSettings = {};
  try {
    const raw = await fs.readFile(result.settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // 3. Backup if existing settings.json has no AIWG marker
  if (!opts.dryRun) {
    try {
      const exists = await fs
        .access(result.settingsPath)
        .then(() => true)
        .catch(() => false);
      if (exists && !hasAiwgMarker(settings)) {
        const backup = `${result.settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await fs.copyFile(result.settingsPath, backup);
        result.backupPath = backup;
        result.warnings.push(`Backed up operator-authored settings.json to ${backup}`);
      }
    } catch (err) {
      throw new Error(`Backup failed; settings.json was not changed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  if (opts.attribution !== false) mergeClaudeAttribution(settings, result.warnings);

  if (opts.hooks !== false) {
    // 4. Normalize (migrate legacy array shape → object shape) and merge
    const [hooksObj, migrated] = normalizeHooks(settings.hooks);
    if (migrated) {
      result.migratedFromLegacy = true;
      result.warnings.push(
        'Migrated legacy array-shaped hooks field to object form (#107).',
      );
    }
    settings.hooks = hooksObj;

    for (const { file, events } of HOOK_SCRIPTS) {
      if (!sourceFiles.includes(file)) continue;
      // Claude Code parses hook commands as shell command strings. Keep the
      // embedded script path POSIX-style on every host: native Windows
      // backslashes are interpreted as escapes and collapse into a nonexistent
      // path such as `.claudehooksaiwg-session.cjs` (#133).
      const script = path.posix.join('.claude', 'hooks', file);
      const hookId = file.replace(/\.(cjs|js)$/, '');

      for (const [event, argument] of Object.entries(events)) {
        const command = `node ${script}${argument ? ` ${argument}` : ''}`;
        if (!hooksObj[event]) hooksObj[event] = [];
        const groups = hooksObj[event];

        // Find any existing AIWG-managed entry for this hookId and refresh
        // its `command` to the current script path/extension. Required for
        // users upgrading from pre-`.cjs` installs where the registered
        // command still references `aiwg-{session,trace,permissions}.js` —
        // those files no longer exist on disk after refresh, causing
        // `MODULE_NOT_FOUND` at `node:internal/modules/cjs/loader` on every
        // hook invocation. (Fixes regression report on Claude Code 2.1.157.)
        // Match by `_aiwg_id` first, then by the script path. An entry invoking an
        // AIWG-owned hook script without the managed tag is AIWG residue from an
        // earlier install; appending a managed entry beside it registers the hook
        // twice and runs it twice per event. Adopt it instead. (#2543)
        let updated = false;
        for (const group of groups) {
          if (!Array.isArray(group.hooks)) continue;
          for (const h of group.hooks) {
            const sameId = h._aiwg_id === hookId;
            const sameScript = typeof h.command === 'string' && h.command.includes(script);
            if (!sameId && !sameScript) continue;
            const adopting = !sameId && sameScript;
            if (h.command !== command || h.type !== 'command' || h._aiwg_managed !== true || h._aiwg_id !== hookId) {
              h.type = 'command';
              h.command = command;
              h._aiwg_managed = true;
              h._aiwg_id = hookId;
              result.warnings.push(
                adopting
                  ? `Adopted pre-existing untagged ${event} → ${hookId} entry instead of registering a duplicate`
                  : `Refreshed stale ${event} → ${hookId} command path`,
              );
            }
            updated = true;
          }
        }
        if (updated) continue;

        groups.push({
          hooks: [
            {
              type: 'command',
              command,
              _aiwg_managed: true,
              _aiwg_id: hookId,
            },
          ],
        });
        result.registeredEvents.push(`${event} → ${hookId}`);
      }
    }
  }

  // 5. Atomic write
  if (!opts.dryRun) {
    await fs.mkdir(path.dirname(result.settingsPath), { recursive: true });
    await atomicWrite(result.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  if (ownershipBefore) recordDeploymentOutputs(ownershipBefore, ownershipRoots, { frameworkSlug: 'aiwg-hooks', writtenFiles: [...result.installedScripts, result.settingsPath] });
  return result;
}

/**
 * Restore the most-recent settings.json backup (per ADR-3 §5 rollback).
 *
 * Reads `.claude/settings.json.bak.<RFC3339>` files and restores the
 * lexicographically-latest one (timestamp ordering). Returns the path
 * restored or null if no backup exists.
 */
export async function restoreSettingsBackup(projectPath: string): Promise<string | null> {
  const claudeDir = path.join(projectPath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  let entries: string[];
  try {
    entries = await fs.readdir(claudeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const backups = entries
    .filter((e) => e.startsWith('settings.json.bak.'))
    .sort();
  if (backups.length === 0) {
    await removeClaudeAttribution(projectPath);
    return null;
  }
  const latest = backups[backups.length - 1];
  const src = path.join(claudeDir, latest);
  const restored = JSON.parse(await fs.readFile(src, 'utf8'));
  const currentRaw = await fs.readFile(settingsPath, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  // Attribution rollback is ownership-based; keep later operator edits.
  if (currentRaw !== null) {
    let current;
    try { current = JSON.parse(currentRaw); }
    catch { /* A corrupt current file must still be recoverable from backup. */ }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      undoClaudeAttribution(current);
      if ('attribution' in current) restored.attribution = current.attribution;
      else delete restored.attribution;
    }
  }
  if (restored.aiwg) delete restored.aiwg.attributionKeys;
  await atomicWrite(settingsPath, JSON.stringify(restored, null, 2) + '\n');
  return src;
}

/** Remove only unchanged attribution defaults owned by AIWG. */
export async function removeClaudeAttribution(projectPath: string, dryRun = false): Promise<void> {
  const file = path.join(projectPath, '.claude', 'settings.json');
  let settings;
  try { settings = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  if (undoClaudeAttribution(settings) && !dryRun) {
    await atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
  }
}
