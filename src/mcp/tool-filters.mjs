/**
 * MCP profile tool filters.
 *
 * A profile's providerOverrides hold toolDeny / toolAllow patterns of the form
 * `<server>__<tool>`, where <tool> may contain `*`. The `*` provider key applies
 * to every harness; a harness's own key adds to it.
 *
 * Each harness enforces tool filters differently, and some not at all:
 *
 *   claude-code  permissions.deny rules `mcp__<server>__<tool>` in
 *                .claude/settings.local.json (project) or ~/.claude/settings.json (user).
 *                toolAllow is refused: Claude has no restrict-only allowlist.
 *                https://code.claude.com/docs/en/permissions
 *   codex        per-server disabled_tools / enabled_tools, exact names; enabled = false
 *                for a whole-server deny. https://learn.chatgpt.com/docs/extend/mcp
 *   opencode     top-level tools map of `<server>_<tool>` globs; the last matching entry
 *                wins. https://opencode.ai/docs/mcp-servers
 *   factory      per-server disabledTools; disabled = true for a whole-server deny.
 *                https://docs.factory.com/cli/configuration/mcp
 *   windsurf     per-server disabledTools. https://docs.devin.ai/desktop/cascade/mcp
 *   antigravity  per-server disabledTools; disabled = true for a whole-server deny.
 *                https://antigravity.google/docs/mcp
 *
 * Cursor, Warp, OMP and Grok Build document no file-level tool filter.
 * Anything a harness cannot express is returned as a warning, never dropped silently.
 */

import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { assertConfigDestination, canonicalConfigPath, prepareConfigWrite, writeConfigTransaction } from './config-file.mjs';
import { resolve } from 'path';
import { homedir } from 'os';
import { normalizeRuntimeProviderId } from '../providers/provider-definitions.mjs';

const PER_SERVER_DISABLED_TOOLS = new Set(['factory', 'windsurf', 'antigravity']);
const SERVER_DISABLE_KEY = { factory: 'disabled', antigravity: 'disabled' };

function unique(values) {
  return [...new Set(values)];
}

/** Merge the `*` overrides with the harness's own. Keys are normalized, so `claude` and `claude-code` both apply. */
export function resolveToolFilters(profile, provider) {
  const target = normalizeRuntimeProviderId(provider) || provider;
  const deny = [];
  const allow = [];
  for (const [key, override] of Object.entries(profile?.providerOverrides || {})) {
    if (key !== '*' && (normalizeRuntimeProviderId(key) || key) !== target) continue;
    deny.push(...(override?.toolDeny || []));
    allow.push(...(override?.toolAllow || []));
  }
  return { deny: unique(deny), allow: unique(allow) };
}

export function hasToolFilters(filters) {
  return Boolean(filters && (filters.deny.length > 0 || filters.allow.length > 0));
}

/** Split `<server>__<tool>`; returns null when there is no server part. */
export function parseToolPattern(pattern) {
  const index = pattern.indexOf('__');
  if (index <= 0 || index + 2 >= pattern.length) return null;
  return { server: pattern.slice(0, index), tool: pattern.slice(index + 2) };
}

const isGlob = value => value.includes('*');

/**
 * Group patterns by injected server. Patterns for servers outside the injected
 * set do not apply; malformed patterns and glob server names are warnings.
 */
function groupByServer(patterns, serverNames, kind, warnings) {
  const groups = new Map();
  for (const pattern of patterns) {
    const parsed = parseToolPattern(pattern);
    if (!parsed || isGlob(parsed.server)) {
      warnings.push(`${kind} pattern "${pattern}" is not <server>__<tool> with a literal server name; not rendered.`);
      continue;
    }
    if (!serverNames.includes(parsed.server)) continue;
    if (!groups.has(parsed.server)) groups.set(parsed.server, []);
    groups.get(parsed.server).push(parsed.tool);
  }
  return groups;
}

/** Claude Code and opencode name a server's tools after the server with these characters replaced. */
const sanitize = value => value.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Compute what a harness should receive.
 *
 * Returns:
 *   serverFields      per-server fields to merge into each entry (JSON harnesses)
 *   tomlLines         per-server TOML lines to append to each [mcp_servers.<name>] table
 *   topLevel          fields to merge into the harness config root (opencode `tools`)
 *   claudePermissions permission rules for Claude Code's settings file
 *   warnings          filters the harness cannot express
 */
export function planToolFilters(provider, serverNames, filters) {
  const target = normalizeRuntimeProviderId(provider) || provider;
  const plan = { serverFields: {}, tomlLines: {}, topLevel: {}, claudePermissions: null, warnings: [] };
  if (target === 'claude-code' && filters?.allow.length) {
    throw new Error(`claude-code: refusing toolAllow patterns ${filters.allow.map(pattern => JSON.stringify(pattern)).join(', ')}: `
      + 'Claude Code has no restrict-only allowlist. permissions.allow pre-approves tools; deny rules cannot express all except, '
      + 'and allow rules cannot carve exceptions out of deny rules. Use toolDeny instead.');
  }
  if (!hasToolFilters(filters)) return plan;
  const deny = groupByServer(filters.deny, serverNames, 'toolDeny', plan.warnings);
  const allow = groupByServer(filters.allow, serverNames, 'toolAllow', plan.warnings);
  if (deny.size === 0 && allow.size === 0) return plan;

  if (target === 'claude-code') {
    const rule = (server, tool) => (tool === '*' ? `mcp__${sanitize(server)}` : `mcp__${sanitize(server)}__${tool}`);
    const denyRules = [...deny].flatMap(([server, tools]) => tools.map(tool => rule(server, tool)));
    plan.claudePermissions = { deny: unique(denyRules), allow: [] };
    return plan;
  }

  if (target === 'opencode') {
    const tools = {};
    for (const server of allow.keys()) tools[`${sanitize(server)}_*`] = false;
    for (const [server, list] of deny) {
      for (const tool of list) {
        const key = `${sanitize(server)}_${tool}`;
        delete tools[key];
        tools[key] = false;
      }
    }
    // Specific allows follow denies under last-match-wins. An identical deny key wins.
    for (const [server, list] of allow) {
      for (const tool of list) {
        if (deny.get(server)?.includes(tool)) continue;
        const key = `${sanitize(server)}_${tool}`;
        delete tools[key];
        tools[key] = true;
      }
    }
    plan.topLevel.tools = tools;
    return plan;
  }

  if (target === 'codex') {
    if (allow.size) {
      const unrestricted = serverNames.filter(name => !allow.has(name) && !deny.get(name)?.includes('*'));
      if (unrestricted.length) {
        plan.warnings.push(`codex: toolAllow is per-server; servers without an allowlist remain unrestricted by toolAllow: ${unrestricted.join(', ')}. Add toolAllow patterns or toolDeny <server>__* for them.`);
      }
    }
    for (const name of serverNames) {
      const lines = [];
      const denied = deny.get(name) || [];
      const allowed = allow.get(name) || [];
      if (denied.includes('*')) {
        plan.tomlLines[name] = ['enabled = false'];
        continue;
      }
      const exact = (list, kind) => list.filter(tool => {
        if (!isGlob(tool)) return true;
        plan.warnings.push(`codex: ${kind} "${name}__${tool}" is a glob; Codex matches tool names exactly, so it is not rendered.`);
        return false;
      });
      const enabled = allowed.includes('*') ? [] : exact(allowed, 'toolAllow');
      const disabled = exact(denied, 'toolDeny');
      if (enabled.length > 0) lines.push(`enabled_tools = [${enabled.map(tool => JSON.stringify(tool)).join(', ')}]`);
      if (disabled.length > 0) lines.push(`disabled_tools = [${disabled.map(tool => JSON.stringify(tool)).join(', ')}]`);
      if (lines.length > 0) plan.tomlLines[name] = lines;
    }
    return plan;
  }

  if (PER_SERVER_DISABLED_TOOLS.has(target)) {
    for (const [server, list] of deny) {
      if (list.includes('*')) {
        const key = SERVER_DISABLE_KEY[target];
        if (key) plan.serverFields[server] = { [key]: true };
        else plan.warnings.push(`${target}: toolDeny "${server}__*" disables a whole server, which ${target} has no documented file key for; not rendered.`);
        continue;
      }
      const exact = list.filter(tool => {
        if (!isGlob(tool)) return true;
        plan.warnings.push(`${target}: toolDeny "${server}__${tool}" is a glob; disabledTools takes exact names, so it is not rendered.`);
        return false;
      });
      if (exact.length > 0) plan.serverFields[server] = { disabledTools: exact };
    }
    for (const server of allow.keys()) {
      plan.warnings.push(`${target}: toolAllow for "${server}" is not rendered; ${target} has no tool allowlist.`);
    }
    return plan;
  }

  plan.warnings.push(`${target}: tool filters are not rendered; ${target} documents no per-tool filter in its MCP config.`);
  return plan;
}

/** Merge the per-server fields and top-level fields of a plan into a JSON harness config. */
export function applyJsonToolFilterPlan(config, serversKey, plan) {
  const servers = config[serversKey] || {};
  for (const [name, fields] of Object.entries(plan.serverFields)) {
    if (servers[name]) {
      const previous = servers[name];
      if (Object.hasOwn(previous, 'disabledTools') && !Array.isArray(previous.disabledTools)) {
        throw new Error(`Refusing tool filters for server "${name}": existing disabledTools must be an array`);
      }
      servers[name] = { ...previous, ...fields };
      if (fields.disabledTools && Array.isArray(previous.disabledTools)) {
        servers[name].disabledTools = unique([...previous.disabledTools, ...fields.disabledTools]);
      }
    }
  }
  if (plan.topLevel.tools) {
    const tools = { ...(config.tools || {}) };
    // opencode uses last-match-wins, including when an existing wildcard conflicts.
    for (const key of Object.keys(plan.topLevel.tools)) delete tools[key];
    config.tools = { ...tools, ...plan.topLevel.tools };
  }
  return config;
}

export function claudeSettingsPath(projectDir = '.', scope = 'project') {
  if (scope === 'user') return resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude/settings.json');
  return resolve(projectDir, '.claude/settings.local.json');
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function validateSettings(settings, settingsPath) {
  if (!isObject(settings)) throw new Error(`Claude Code settings ${settingsPath} must contain an object`);
  if (Object.hasOwn(settings, 'permissions')) {
    if (!isObject(settings.permissions)) {
      throw new Error(`Claude Code settings ${settingsPath}: permissions must be an object`);
    }
    for (const key of ['allow', 'deny', 'ask', 'additionalDirectories']) {
      if (Object.hasOwn(settings.permissions, key)
        && (!Array.isArray(settings.permissions[key]) || settings.permissions[key].some(rule => typeof rule !== 'string'))) {
        throw new Error(`Claude Code settings ${settingsPath}: permissions.${key} must be an array of strings`);
      }
    }
  }
}

/** Validate destinations and settings before any MCP writes; keep ownership outside Claude's schema. */
export async function prepareClaudePermissions(settingsPath, permissions, {
  userScope = false, projectRoot, managedDir, sidecar = false, mcpPath,
} = {}) {
  if (permissions.allow?.length) {
    throw new Error(`Claude Code: refusing permissions.allow ${permissions.allow.map(rule => JSON.stringify(rule)).join(', ')}: no restrict-only allowlist; use permissions.deny instead.`);
  }
  settingsPath = resolve(settingsPath);
  if (mcpPath && settingsPath === resolve(mcpPath)) {
    throw new Error(`Refusing Claude Code settings sidecar ${settingsPath}: collides with MCP config`);
  }
  const info = await assertConfigDestination(settingsPath, projectRoot);
  if (mcpPath && info) {
    const mcpInfo = await assertConfigDestination(mcpPath, projectRoot);
    if (mcpInfo && info.dev === mcpInfo.dev && info.ino === mcpInfo.ino) {
      throw new Error(`Refusing Claude Code settings sidecar ${settingsPath}: collides with MCP config`);
    }
  }
  let content;
  let existing = {};
  if (info) {
    content = await readFile(settingsPath, 'utf-8');
    try {
      existing = JSON.parse(content);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Refusing to overwrite malformed Claude Code settings ${settingsPath}: invalid JSON`);
      }
      throw error;
    }
  }
  validateSettings(existing, settingsPath);

  const canonicalPath = await canonicalConfigPath(settingsPath);
  const recordPath = managedDir ? resolve(managedDir, 'claude-tool-permissions', `${digest(canonicalPath)}.json`) : null;
  let record = null;
  if (recordPath && await assertConfigDestination(recordPath, managedDir)) {
    try {
      record = JSON.parse(await readFile(recordPath, 'utf-8'));
      if (!isObject(record) || record.settingsPath !== canonicalPath || !Array.isArray(record.denyAdded)
        || record.denyAdded.some(rule => typeof rule !== 'string')
        || (record.denyDigest !== undefined && (typeof record.denyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.denyDigest)))
        || (record.denyPreserved !== undefined && (!Array.isArray(record.denyPreserved)
          || record.denyPreserved.some(rule => typeof rule !== 'string' || !record.denyAdded.includes(rule))))) {
        throw new Error('unsupported ownership record shape');
      }
    } catch (error) {
      throw new Error(`Invalid Claude permission ownership record ${recordPath}: ${error.message}. Delete ${recordPath} to reset ownership; existing deny rules will be treated as user-owned.`);
    }
  }
  if (sidecar && info && (!record?.sidecar || record.contentDigest !== digest(content))) {
    throw new Error(`Refusing implicit Claude Code settings sidecar ${settingsPath}: existing file was not created by AIWG or was changed. Choose another --out path.`);
  }
  if (sidecar && !recordPath) throw new Error('Claude settings sidecars require an ownership record directory');

  const desired = unique(permissions.deny);
  const current = existing.permissions || {};
  const deny = [...(current.deny || [])];
  const owned = [];
  const preserved = [];
  const warnings = [];
  const unchangedDeny = record?.denyDigest === digest(JSON.stringify(deny));
  for (const rule of record?.denyAdded || []) {
    const index = deny.indexOf(rule);
    if (index < 0) continue;
    if (!unchangedDeny || record.denyPreserved?.includes(rule)) {
      owned.push(rule);
      preserved.push(rule);
    } else if (desired.includes(rule)) owned.push(rule);
    else deny.splice(index, 1); // Remove only our occurrence; preserve user-added duplicates.
  }
  for (const rule of desired) {
    if (deny.includes(rule)) continue; // A pre-existing user rule never becomes AIWG-owned.
    deny.push(rule);
    owned.push(rule);
  }
  const retained = preserved.filter(rule => !desired.includes(rule));
  if (retained.length) {
    warnings.push(`Claude Code settings ${settingsPath}: preserving previously tracked deny rules because permissions.deny changed or ownership is uncertain: ${unique(retained).join(', ')}. Remove these rules manually from permissions.deny in ${settingsPath} if no longer wanted.`);
  }
  const active = Boolean(record || desired.length || sidecar);
  const merged = active ? { ...existing, permissions: { ...current, deny } } : existing;
  const nextContent = JSON.stringify(merged, null, 2) + '\n';
  const writes = active ? [{
    file: settingsPath, content: nextContent,
    options: { userScope: userScope || sidecar, projectRoot, newFileMode: 0o600 },
  }] : [];
  if (active && recordPath) {
    writes.push({
      file: recordPath,
      content: JSON.stringify({
        settingsPath: canonicalPath, denyAdded: owned, denyPreserved: unique(preserved),
        denyDigest: digest(JSON.stringify(deny)), sidecar,
        ...(sidecar ? { contentDigest: digest(nextContent) } : {}),
      }, null, 2) + '\n',
      options: { userScope: true, projectRoot: managedDir },
    });
  }
  for (const { file, options } of writes) await prepareConfigWrite(file, options);
  return {
    merged, active, warnings, writes,
    async commit() { await writeConfigTransaction(writes); },
  };
}

/** Merge deny rules after validation, optionally tracking ownership for profile switching. */
export async function mergeClaudePermissions(settingsPath, permissions, { dryRun = false, ...options } = {}) {
  const prepared = await prepareClaudePermissions(settingsPath, permissions, options);
  if (!dryRun) {
    await prepared.commit();
    for (const warning of prepared.warnings) console.warn(`WARNING ${warning}`);
  }
  return prepared.merged;
}
