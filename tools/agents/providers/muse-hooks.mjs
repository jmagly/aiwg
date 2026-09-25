/**
 * Muse Code project hooks (.muse/hooks.json) + optional MCP settings profile
 * (#228).
 *
 * Hooks
 * -----
 * Target: `<repo>/.muse/hooks.json` for AIWG-managed lifecycle bindings.
 * Muse validates the file at session startup: a malformed project hook file
 * contributes no handlers and warns, so this module fails closed — an
 * unparseable hooks.json aborts the merge with zero writes, never a rewrite.
 *
 * Managed-entry tracking uses a sidecar (`.muse/.aiwg-hooks.json`) rather
 * than in-band markers: Muse skips matcher groups that carry unexpected
 * keys, and drops unsupported handler fields, so tagging entries inside
 * hooks.json would either break the group or be silently discarded. Only
 * groups recorded in the sidecar (or byte-identical to the current
 * canonical set) are ever replaced or pruned; operator groups are preserved
 * logically across merges. The merged file is rewritten with canonical
 * 2-space formatting (the peer Factory convention); operator entries keep
 * their content, never their original whitespace.
 *
 * **Hooks run outside the agent sandbox.** Muse executes hook commands as
 * plain shell processes on the operator's machine. Project hooks additionally
 * run only after the operator trusts the project folder. Every managed hook
 * below ships with a stated reason and a removal path.
 *
 * MCP
 * ---
 * Optional profile behind an explicit flag only: `deployMuseMcp` is a no-op
 * unless `opts.mcp === true`. It enriches the *user* settings file
 * (`$XDG_CONFIG_HOME/muse/settings.json`, default `~/.config/muse/settings.json`)
 * `mcp_servers` block additively: unknown keys are preserved, an existing
 * `schema_version` is never downgraded (bootstrapped to `1` only when AIWG
 * creates the file or repairs a key-less one — a missing schema_version makes
 * every `muse` command fail with "malformed settings file"), and a timestamped
 * backup is written before any mutation. Only the `aiwg` server key is ever
 * touched; an operator-owned `aiwg` key that AIWG did not record is left
 * alone with a warning, never clobbered.
 *
 * The profiled server is AIWG's own MCP surface (`aiwg mcp serve`) over
 * stdio, registered with `"mode": "optional"` — a failing *required* server
 * aborts the whole Muse run, and optional enrichment must never do that.
 * Servers inherit the operator's process environment; pass `MUSE_SESSION_ID`
 * through at runtime instead of hardcoding a session id into `env`.
 *
 * This module is intentionally dependency-free (node builtins +
 * muse-paths.mjs only) so provider-policy-style import graphs never pull it
 * in transitively.
 *
 * @issue #228
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMuseXdgSkillsDir, museXdgSkillsDirRemediation } from './muse-paths.mjs';

// ---------------------------------------------------------------------------
// Shared JSON helpers
// ---------------------------------------------------------------------------

/**
 * Strip JSON comments (JSONC) before parsing. Comments are *read* tolerance
 * only: merged files are written back as canonical JSON. The scanner tracks
 * string literals so `//` in a URL or `/*` in a glob matcher is preserved.
 */
function stripJsonComments(jsonc) {
  const text = String(jsonc);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Parse a JSON/JSONC document, failing closed with a coded error.
 */
function parseJsonc(raw, filePath, code) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    const error = new Error(
      `Refusing to merge ${filePath}: not valid JSON (${err.message}). ` +
        'Fix or remove the file, then re-run. Nothing was written.',
    );
    error.code = code;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error(
      `Refusing to merge ${filePath}: top-level JSON must be an object. Nothing was written.`,
    );
    error.code = code;
    throw error;
  }
  return parsed;
}

/**
 * Atomic write via tmpfile+rename so partial state never persists
 * (mirrors src/extensions/claude-hooks-installer.ts).
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Canonical serialization: 2-space JSON with trailing newline. */
function canonicalJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Minimal unified diff (LCS on lines) for dry-run previews.
 */
export function unifiedDiff(beforeText, afterText, label) {
  const a = String(beforeText).split('\n');
  const b = String(afterText).split('\n');
  const n = a.length;
  const m = b.length;
  // LCS table (files here are small; clarity over Hirschberg).
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [`--- ${label} (current)`, `+++ ${label} (planned)`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Hooks: managed set definition
// ---------------------------------------------------------------------------

/** Project hooks file and its AIWG sidecar, relative to the target repo. */
export const MUSE_HOOKS_REL = path.join('.muse', 'hooks.json');
export const MUSE_HOOKS_SIDECAR_REL = path.join('.muse', '.aiwg-hooks.json');

/** Muse lifecycle events known at the time of writing (docs: dev.meta.ai muse-code/extending). */
export const MUSE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreLLMCall',
  'PostLLMCall',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'SessionEnd',
];

/**
 * The AIWG-managed hook set. Each entry carries a stated reason (why this
 * hook runs on the operator's machine, outside the agent sandbox) and a
 * removal path (how the operator takes it back out).
 *
 * SessionEnd is intentionally *not* installed yet: Muse documents SessionEnd
 * as observational-only (its output cannot block termination or inject
 * context), and AIWG has no session-catalog note command to invoke — wiring
 * a hook to a command that does not exist would fail every session end.
 * When a real catalog-note command lands, it slots in here with its own
 * reason + removal path.
 */
export const AIWG_MANAGED_HOOKS = [
  {
    id: 'aiwg-session-start',
    event: 'SessionStart',
    // Muse matcher groups take ONLY `hooks` + optional `matcher`; no
    // in-band AIWG tags (they would break the group).
    group: {
      matcher: '*',
      hooks: [{ type: 'command', command: 'aiwg refresh --dry-run --quiet', timeout: 60 }],
    },
    reason:
      'Session-start context refresh. Runs a read-only `aiwg refresh --dry-run` so the ' +
      'session begins from current AIWG framework state. Dry-run by construction: ' +
      'it reports drift and never mutates the repo.',
    removal:
      'Delete this matcher group from `.muse/hooks.json` (the one whose command is ' +
      '`aiwg refresh --dry-run --quiet`), or run `aiwg use --provider muse --no-hooks` ' +
      'to stop AIWG managing hooks for this project.',
  },
];

/** Canonical group payloads keyed by hook id, for merge/prune identity. */
function managedGroupsById() {
  const out = new Map();
  for (const hook of AIWG_MANAGED_HOOKS) out.set(hook.id, { event: hook.event, group: hook.group });
  return out;
}

/**
 * Stable identity for a matcher group: the event, the matcher, and the full
 * (whitespace-normalized) first hook command.
 *
 * Full-payload equality cannot survive an operator hand-edit, and Muse
 * forbids in-band AIWG tags on matcher groups (unexpected keys break the
 * group). The identity key survives benign drift (timeouts, hook type) so a
 * drifted managed group is repaired rather than duplicated. The whole command
 * is part of the key so an operator's own `aiwg ...` hook with a different
 * command is never claimed as managed: it stays operator-owned, and AIWG
 * installs its canonical group alongside it.
 */
function groupIdentity(event, group) {
  const matcher = (group && group.matcher) || '';
  const first = group && Array.isArray(group.hooks) && group.hooks[0];
  const command = String((first && first.command) || '').trim().split(/\s+/).join(' ');
  return `${event}\n${matcher}\n${command}`;
}

/**
 * Identity keys AIWG manages: the current set plus anything recorded in the
 * sidecar (covers retired hooks whose payload AIWG wrote on an older deploy).
 */
function managedIdentities(byId, recorded) {
  const ids = new Map(); // identity key -> hook id
  for (const [id, { event, group }] of byId) ids.set(groupIdentity(event, group), id);
  for (const entry of recorded.values()) {
    if (entry && entry.event && entry.group) {
      const key = groupIdentity(entry.event, entry.group);
      if (!ids.has(key)) ids.set(key, entry.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Hooks: merge + deploy + prune
// ---------------------------------------------------------------------------

/**
 * Refuse to write through a symlinked `.muse` directory: a cloned repo could
 * point it anywhere on disk.
 */
function assertMuseDirNotSymlink(museDir) {
  let stat;
  try {
    stat = fs.lstatSync(museDir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    const error = new Error(
      `Refusing to write Muse hooks: ${museDir} is a symlink. Replace it with a real directory, then re-run. Nothing was written.`,
    );
    error.code = 'MUSE_HOOKS_SYMLINK';
    throw error;
  }
}

/**
 * The merged document is written as canonical JSON, which drops comments and
 * operator formatting. Keep a timestamped copy whenever that would lose bytes.
 */
function backupIfHandEdited(filePath, doc, raw, existed) {
  if (!existed || raw === canonicalJson(doc)) return null;
  const backupPath = `${filePath}.aiwg-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function readHooksDoc(hooksPath) {
  if (!fs.existsSync(hooksPath)) return { doc: { hooks: {} }, raw: null, existed: false };
  const raw = fs.readFileSync(hooksPath, 'utf8');
  const doc = parseJsonc(raw, hooksPath, 'MUSE_HOOKS_UNPARSEABLE');
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks))) {
    const error = new Error(
      `Refusing to merge ${hooksPath}: "hooks" must be an object keyed by event name. Nothing was written.`,
    );
    error.code = 'MUSE_HOOKS_BAD_SHAPE';
    throw error;
  }
  for (const [event, groups] of Object.entries(doc.hooks || {})) {
    if (!Array.isArray(groups)) {
      const error = new Error(
        `Refusing to merge ${hooksPath}: hooks["${event}"] must be an array of matcher groups. Nothing was written.`,
      );
      error.code = 'MUSE_HOOKS_BAD_SHAPE';
      throw error;
    }
  }
  return { doc, raw, existed: true };
}

function readHooksSidecar(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return { version: 1, hooks: [] };
  const raw = fs.readFileSync(sidecarPath, 'utf8');
  const parsed = parseJsonc(raw, sidecarPath, 'MUSE_HOOKS_SIDECAR_UNPARSEABLE');
  if (!Array.isArray(parsed.hooks)) {
    const error = new Error(
      `Refusing to merge hooks: sidecar ${sidecarPath} is corrupt (hooks is not an array). Nothing was written.`,
    );
    error.code = 'MUSE_HOOKS_SIDECAR_UNPARSEABLE';
    throw error;
  }
  return parsed;
}

/**
 * Compute the merged hooks document. Returns `{ doc, changed, plan }`
 * where `plan` lists human-readable merge steps for dry-run output.
 *
 * Operator groups (anything not recorded as AIWG-managed and not
 * byte-identical to the canonical set) are preserved untouched. Managed
 * groups are replaced with the canonical payload, repairing drift.
 */
export function mergeManagedHooks(existingDoc, sidecar) {
  const byId = managedGroupsById();
  const recorded = new Map();
  for (const entry of sidecar.hooks || []) {
    if (entry && typeof entry.id === 'string') recorded.set(entry.id, entry);
  }
  const identities = managedIdentities(byId, recorded);

  // A group is AIWG-managed when its identity matches the current set or a
  // sidecar-recorded payload. Returns the hook id or null.
  const isManagedGroup = (event, group) => identities.get(groupIdentity(event, group)) || null;

  const plan = [];
  const merged = { hooks: {} };
  const existingHooks = (existingDoc && existingDoc.hooks) || {};

  // Preserve original event order; managed events are refreshed in place.
  const desiredEvents = new Set([...AIWG_MANAGED_HOOKS.map((h) => h.event)]);
  const eventOrder = [...Object.keys(existingHooks)];
  for (const event of desiredEvents) {
    if (!eventOrder.includes(event)) eventOrder.push(event);
  }

  for (const event of eventOrder) {
    const groups = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
    const operatorGroups = [];
    const seenManagedIds = new Set();
    for (const group of groups) {
      const managedId = isManagedGroup(event, group);
      if (managedId) {
        seenManagedIds.add(managedId);
      } else {
        operatorGroups.push(group);
      }
    }
    const desiredHere = AIWG_MANAGED_HOOKS.filter((h) => h.event === event);
    const nextGroups = [...operatorGroups];
    for (const hook of desiredHere) {
      nextGroups.push(hook.group);
      if (!seenManagedIds.has(hook.id)) {
        plan.push(`add ${hook.event} hook "${hook.id}": ${hook.group.hooks[0].command}`);
      } else if (!groups.some((g) => deepEqual(g, hook.group))) {
        plan.push(`repair ${hook.event} hook "${hook.id}" (drifted from canonical)`);
      }
    }
    // Drop previously-managed groups for hooks no longer in the set.
    for (const group of groups) {
      const managedId = isManagedGroup(event, group);
      if (managedId && !byId.has(managedId)) {
        plan.push(`prune retired managed hook "${managedId}"`);
      }
    }
    if (nextGroups.length > 0 || event in existingHooks) {
      merged.hooks[event] = nextGroups;
    }
  }

  const changed = !deepEqual({ hooks: existingHooks }, merged);
  if (plan.length === 0 && changed) plan.push('normalize hooks document');
  return { doc: merged, changed, plan };
}

function buildHooksSidecar() {
  return {
    version: 1,
    hooks: AIWG_MANAGED_HOOKS.map((h) => ({ id: h.id, event: h.event, group: h.group })),
  };
}

/**
 * Deploy the AIWG-managed hook set into `<target>/.muse/hooks.json`.
 *
 * Additive merge: operator entries are preserved; only recorded AIWG entries
 * are replaced/pruned. Fail closed on unparseable input (zero writes).
 * Dry-run prints the planned diff and performs zero writes.
 */
export function deployMuseHooks(targetDir, opts = {}) {
  const { dryRun = false, quiet = false } = opts;
  const hooksPath = path.join(targetDir, MUSE_HOOKS_REL);
  const sidecarPath = path.join(targetDir, MUSE_HOOKS_SIDECAR_REL);

  const { doc: existingDoc, raw: existingRaw, existed } = readHooksDoc(hooksPath);
  const sidecar = readHooksSidecar(sidecarPath);
  const { doc: merged, changed, plan } = mergeManagedHooks(existingDoc, sidecar);

  const beforeText = existed ? existingRaw : '(no .muse/hooks.json — will be created)';
  const afterText = canonicalJson(merged);
  const log = quiet ? () => {} : (msg) => console.log(msg);

  if (dryRun) {
    log(`[dry-run] Muse hooks: ${hooksPath}`);
    if (!changed) {
      log('[dry-run] hooks.json already carries the canonical AIWG-managed set; no changes.');
    } else {
      for (const step of plan) log(`[dry-run]   ${step}`);
      log(unifiedDiff(beforeText, afterText, hooksPath));
    }
    log('[dry-run] zero writes performed.');
    return { hooksPath, changed, plan, wrote: false };
  }

  if (!changed) {
    log(`Muse hooks: ${hooksPath} already current; nothing to do.`);
    return { hooksPath, changed: false, plan: [], wrote: false };
  }

  assertMuseDirNotSymlink(path.dirname(hooksPath));
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const backupPath = backupIfHandEdited(hooksPath, existingDoc, existingRaw, existed);
  atomicWrite(hooksPath, afterText);
  atomicWrite(sidecarPath, canonicalJson(buildHooksSidecar()));
  log(`Muse hooks: merged ${plan.length} managed change(s) into ${hooksPath}`);
  if (backupPath) log(`  backup (comments/formatting not preserved): ${backupPath}`);
  for (const step of plan) log(`  ${step}`);
  log('  Operator hook entries preserved; managed entries tracked in .muse/.aiwg-hooks.json.');
  return { hooksPath, changed: true, plan, wrote: true };
}

/**
 * Removal path: drop every AIWG-managed group recorded in the sidecar and
 * delete the sidecar. Operator entries are never touched.
 */
export function pruneMuseHooks(targetDir, opts = {}) {
  const { dryRun = false, quiet = false } = opts;
  const hooksPath = path.join(targetDir, MUSE_HOOKS_REL);
  const sidecarPath = path.join(targetDir, MUSE_HOOKS_SIDECAR_REL);
  const log = quiet ? () => {} : (msg) => console.log(msg);

  if (!fs.existsSync(hooksPath)) {
    log(`Muse hooks: no ${hooksPath}; nothing to prune.`);
    return { hooksPath, pruned: false, wrote: false };
  }
  const { doc: existingDoc, raw: existingRaw } = readHooksDoc(hooksPath);
  const sidecar = readHooksSidecar(sidecarPath);
  const recorded = new Map();
  for (const entry of sidecar.hooks || []) {
    if (entry && typeof entry.id === 'string') recorded.set(entry.id, entry);
  }
  const identities = managedIdentities(managedGroupsById(), recorded);

  const merged = { hooks: {} };
  let pruned = 0;
  for (const [event, groups] of Object.entries(existingDoc.hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : []).filter((group) => {
      const managed = identities.has(groupIdentity(event, group));
      if (managed) pruned++;
      return !managed;
    });
    if (kept.length > 0 || event in (existingDoc.hooks || {})) merged.hooks[event] = kept;
  }

  if (dryRun) {
    log(`[dry-run] Muse hooks prune: ${hooksPath}`);
    log(`[dry-run]   would remove ${pruned} managed group(s); operator entries untouched.`);
    if (pruned > 0) log(unifiedDiff(existingRaw, canonicalJson(merged), hooksPath));
    log('[dry-run] zero writes performed.');
    return { hooksPath, pruned, wrote: false };
  }

  if (pruned === 0) {
    log(`Muse hooks: no AIWG-managed groups found in ${hooksPath}; nothing to prune.`);
    return { hooksPath, pruned: 0, wrote: false };
  }
  assertMuseDirNotSymlink(path.dirname(hooksPath));
  const backupPath = backupIfHandEdited(hooksPath, existingDoc, existingRaw, true);
  atomicWrite(hooksPath, canonicalJson(merged));
  if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
  if (backupPath) log(`  backup (comments/formatting not preserved): ${backupPath}`);
  log(`Muse hooks: pruned ${pruned} AIWG-managed group(s) from ${hooksPath}; sidecar removed.`);
  return { hooksPath, pruned, wrote: true };
}

// ---------------------------------------------------------------------------
// MCP: optional settings profile
// ---------------------------------------------------------------------------

/** User settings path, resolved fail-closed from XDG metadata. */
export function assertMuseUserSettingsPath(env = process.env, userHome = os.homedir()) {
  const skillsDir = resolveMuseXdgSkillsDir(env, userHome);
  if (!skillsDir) {
    const err = new Error(museXdgSkillsDirRemediation(env, userHome));
    err.code = 'MUSE_XDG_UNSET';
    throw err;
  }
  // <xdg>/muse/skills -> <xdg>/muse/settings.json (never ~/.muse).
  return path.join(path.dirname(skillsDir), 'settings.json');
}

export const MUSE_MCP_SIDECAR_NAME = '.aiwg-mcp.json';

/**
 * The optional MCP profile: AIWG's own MCP surface over stdio.
 * `"mode": "optional"` is load-bearing — a failing *required* server aborts
 * the whole Muse run, and optional enrichment must never do that.
 */
export function aiwgMcpServerProfile() {
  return {
    transport: 'stdio',
    command: 'aiwg',
    args: ['mcp', 'serve'],
    env: {},
    enabled: true,
    mode: 'optional',
  };
}

function readSettingsDoc(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { doc: {}, raw: null, existed: false };
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const doc = parseJsonc(raw, settingsPath, 'MUSE_SETTINGS_UNPARSEABLE');
  return { doc, raw, existed: true };
}

function readMcpSidecar(configDir) {
  const sidecarPath = path.join(configDir, MUSE_MCP_SIDECAR_NAME);
  if (!fs.existsSync(sidecarPath)) return { servers: [], path: sidecarPath };
  const parsed = parseJsonc(
    fs.readFileSync(sidecarPath, 'utf8'),
    sidecarPath,
    'MUSE_MCP_SIDECAR_UNPARSEABLE',
  );
  return { servers: Array.isArray(parsed.servers) ? parsed.servers : [], path: sidecarPath };
}

/**
 * Compute the merged settings document for the optional MCP profile.
 * Additive: unknown keys preserved; only `mcp_servers.aiwg` (when AIWG owns
 * it) and `schema_version` (bootstrap/repair only) are touched.
 *
 * @param {object} existingDoc parsed settings document
 * @param {object} opts `{ managed }` — true when the caller has established
 *   the `aiwg` key is AIWG-recorded (sidecar), absent, or already canonical.
 *   Fail closed otherwise: an operator-owned key is never overwritten here.
 */
export function mergeMcpProfile(existingDoc, opts = {}) {
  const { managed = false } = opts;
  const plan = [];
  const warnings = [];
  const merged = { ...existingDoc };
  const desired = aiwgMcpServerProfile();

  if (merged.schema_version === undefined) {
    merged.schema_version = 1;
    plan.push('set schema_version: 1 (required by Muse; file had none)');
  } else if (merged.schema_version !== 1) {
    warnings.push(
      `existing schema_version is ${JSON.stringify(merged.schema_version)} (not 1); ` +
        'leaving it untouched and merging additively.',
    );
  }

  const rawServers = merged.mcp_servers;
  if (rawServers !== undefined && (typeof rawServers !== 'object' || rawServers === null || Array.isArray(rawServers))) {
    const error = new Error(
      'Refusing to merge MCP profile: "mcp_servers" must be an object keyed by server name. Nothing was written.',
    );
    error.code = 'MUSE_MCP_BAD_SHAPE';
    throw error;
  }
  const servers = { ...(rawServers || {}) };

  const existing = servers.aiwg;
  if (existing === undefined) {
    servers.aiwg = desired;
    plan.push('add mcp_servers.aiwg: stdio `aiwg mcp serve` (mode: optional)');
  } else if (deepEqual(existing, desired)) {
    plan.push('mcp_servers.aiwg already carries the canonical AIWG profile');
  } else if (managed) {
    servers.aiwg = desired;
    plan.push('refresh mcp_servers.aiwg to the canonical AIWG profile (drifted since last deploy)');
  } else {
    const error = new Error(
      'Refusing to merge MCP profile: mcp_servers.aiwg is operator-owned (not recorded as AIWG-managed). Nothing was written.',
    );
    error.code = 'MUSE_MCP_NOT_MANAGED';
    throw error;
  }

  merged.mcp_servers = servers;
  const changed = !deepEqual(existingDoc, merged);
  return { doc: merged, changed, plan, warnings };
}

/**
 * Enrich user settings with the optional AIWG MCP profile.
 *
 * Explicit opt-in only: no-op unless `opts.mcp === true`. Additive merge
 * preserving unknown keys, timestamped backup before writing, atomic write,
 * dry-run diff with zero writes, fail closed on unparseable settings.
 */
export function deployMuseMcp(opts = {}) {
  const { dryRun = false, quiet = false, mcp = false, env = process.env, userHome = os.homedir() } = opts;
  const log = quiet ? () => {} : (msg) => console.log(msg);

  if (mcp !== true) {
    log('Muse MCP: profile not requested (pass --mcp to opt in); settings untouched.');
    return { settingsPath: null, changed: false, wrote: false, skipped: true };
  }

  const settingsPath = assertMuseUserSettingsPath(env, userHome);
  const configDir = path.dirname(settingsPath);
  const { doc: existingDoc, raw: existingRaw, existed } = readSettingsDoc(settingsPath);
  const sidecar = readMcpSidecar(configDir);
  const profile = aiwgMcpServerProfile();

  const existingServer = existingDoc.mcp_servers && existingDoc.mcp_servers.aiwg;
  const managedByAiwg = sidecar.servers.includes('aiwg');

  // Operator-owned `aiwg` server key that AIWG did not record: never clobber.
  if (existingServer !== undefined && !managedByAiwg && !deepEqual(existingServer, profile)) {
    const warning =
      `Muse MCP: settings already define an operator-owned mcp_servers.aiwg entry; ` +
      `leaving it untouched (not recorded as AIWG-managed). Rename or remove it to let AIWG manage the key.`;
    log(`Warning: ${warning}`);
    return { settingsPath, changed: false, wrote: false, skipped: true, warnings: [warning] };
  }

  const { doc: merged, changed, plan, warnings } = mergeMcpProfile(existingDoc, {
    managed: managedByAiwg || existingServer === undefined || deepEqual(existingServer, profile),
  });
  for (const w of warnings) log(`Warning: Muse MCP: ${w}`);

  const beforeText = existed ? existingRaw : '(no settings.json — will be created)';
  const afterText = canonicalJson(merged);

  if (!changed) {
    log(`Muse MCP: ${settingsPath} already carries the AIWG profile; nothing to do.`);
    return { settingsPath, changed: false, wrote: false, warnings };
  }

  if (dryRun) {
    log(`[dry-run] Muse MCP profile: ${settingsPath}`);
    for (const step of plan) log(`[dry-run]   ${step}`);
    if (existed) log(`[dry-run]   would back up to ${settingsPath}.aiwg-backup-<timestamp>`);
    log(unifiedDiff(beforeText, afterText, settingsPath));
    log('[dry-run] zero writes performed.');
    return { settingsPath, changed: true, plan, wrote: false, warnings };
  }

  fs.mkdirSync(configDir, { recursive: true });
  let backupPath = null;
  if (existed) {
    backupPath = `${settingsPath}.aiwg-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(settingsPath, backupPath);
  }
  atomicWrite(settingsPath, afterText);
  atomicWrite(sidecar.path, canonicalJson({ version: 1, servers: ['aiwg'] }));

  log(`Muse MCP: merged AIWG stdio profile into ${settingsPath}`);
  for (const step of plan) log(`  ${step}`);
  if (backupPath) log(`  backup: ${backupPath}`);
  log('  Unknown settings keys preserved; only mcp_servers.aiwg (+ schema_version bootstrap) touched.');
  return { settingsPath, changed: true, plan, wrote: true, backupPath, warnings };
}

/**
 * Removal path: drop the AIWG-managed `aiwg` server key (only when recorded
 * in the sidecar) and delete the sidecar. Operator servers are never touched.
 */
export function pruneMuseMcp(opts = {}) {
  const { dryRun = false, quiet = false, env = process.env, userHome = os.homedir() } = opts;
  const log = quiet ? () => {} : (msg) => console.log(msg);
  const settingsPath = assertMuseUserSettingsPath(env, userHome);
  const configDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsPath)) {
    log(`Muse MCP: no ${settingsPath}; nothing to prune.`);
    return { settingsPath, pruned: false, wrote: false };
  }
  const { doc: existingDoc, raw: existingRaw } = readSettingsDoc(settingsPath);
  const sidecar = readMcpSidecar(configDir);
  const servers = existingDoc.mcp_servers;
  const prunable = servers && typeof servers === 'object' && sidecar.servers.includes('aiwg') && servers.aiwg !== undefined;

  if (!prunable) {
    log(`Muse MCP: no AIWG-managed server key in ${settingsPath}; nothing to prune.`);
    return { settingsPath, pruned: false, wrote: false };
  }

  const merged = { ...existingDoc, mcp_servers: { ...servers } };
  delete merged.mcp_servers.aiwg;

  if (dryRun) {
    log(`[dry-run] Muse MCP prune: ${settingsPath}`);
    log('[dry-run]   would remove mcp_servers.aiwg; other servers untouched.');
    log(unifiedDiff(existingRaw, canonicalJson(merged), settingsPath));
    log('[dry-run] zero writes performed.');
    return { settingsPath, pruned: true, wrote: false };
  }

  const backupPath = `${settingsPath}.aiwg-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settingsPath, backupPath);
  atomicWrite(settingsPath, canonicalJson(merged));
  if (fs.existsSync(sidecar.path)) fs.unlinkSync(sidecar.path);
  log(`Muse MCP: removed mcp_servers.aiwg from ${settingsPath} (backup: ${backupPath}).`);
  return { settingsPath, pruned: true, wrote: true, backupPath };
}

export default {
  MUSE_HOOKS_REL,
  MUSE_HOOKS_SIDECAR_REL,
  MUSE_HOOK_EVENTS,
  AIWG_MANAGED_HOOKS,
  MUSE_MCP_SIDECAR_NAME,
  unifiedDiff,
  mergeManagedHooks,
  deployMuseHooks,
  pruneMuseHooks,
  assertMuseUserSettingsPath,
  aiwgMcpServerProfile,
  mergeMcpProfile,
  deployMuseMcp,
  pruneMuseMcp,
};
