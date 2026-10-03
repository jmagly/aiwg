/**
 * MCP profile tool filters.
 *
 * A profile's providerOverrides hold toolDeny / toolAllow patterns of the form
 * `<server>__<tool>`, where <tool> may contain `*`. The `*` provider key applies
 * to every harness; a harness's own key adds to it.
 *
 * Each harness enforces tool filters differently, and some not at all:
 *
 *   claude-code  permissions.deny / permissions.allow rules `mcp__<server>__<tool>` in
 *                .claude/settings.local.json (project) or ~/.claude/settings.json (user).
 *                allow is pre-approval, not an allowlist.
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

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
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
  if (!hasToolFilters(filters)) return plan;
  const deny = groupByServer(filters.deny, serverNames, 'toolDeny', plan.warnings);
  const allow = groupByServer(filters.allow, serverNames, 'toolAllow', plan.warnings);
  if (deny.size === 0 && allow.size === 0) return plan;

  if (target === 'claude-code') {
    const rule = (server, tool) => (tool === '*' ? `mcp__${sanitize(server)}` : `mcp__${sanitize(server)}__${tool}`);
    const denyRules = [...deny].flatMap(([server, tools]) => tools.map(tool => rule(server, tool)));
    const allowRules = [...allow].flatMap(([server, tools]) => tools.map(tool => rule(server, tool)));
    plan.claudePermissions = { deny: unique(denyRules), allow: unique(allowRules) };
    if (allowRules.length > 0) {
      plan.warnings.push('claude-code: toolAllow renders as permissions.allow, which pre-approves those tools; '
        + 'Claude Code has no MCP tool allowlist, so tools outside it stay available behind a permission prompt.');
    }
    return plan;
  }

  if (target === 'opencode') {
    const tools = {};
    for (const [server, list] of allow) {
      tools[`${sanitize(server)}_*`] = false;
      for (const tool of list) tools[`${sanitize(server)}_${tool}`] = true;
    }
    for (const [server, list] of deny) {
      for (const tool of list) tools[`${sanitize(server)}_${tool}`] = false;
    }
    plan.topLevel.tools = tools;
    return plan;
  }

  if (target === 'codex') {
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
    if (servers[name]) servers[name] = { ...servers[name], ...fields };
  }
  if (plan.topLevel.tools) {
    config.tools = { ...(config.tools || {}), ...plan.topLevel.tools };
  }
  return config;
}

export function claudeSettingsPath(projectDir = '.', scope = 'project') {
  if (scope === 'user') return resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude/settings.json');
  return resolve(projectDir, '.claude/settings.local.json');
}

/** Add permission rules to a Claude Code settings file, keeping every existing key and rule. */
export async function mergeClaudePermissions(settingsPath, permissions, { dryRun = false } = {}) {
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Refusing to overwrite malformed Claude Code settings ${settingsPath}: invalid JSON`);
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`Claude Code settings ${settingsPath} must contain an object`);
  }
  const current = existing.permissions || {};
  const next = { ...current };
  for (const key of ['deny', 'allow']) {
    if (permissions[key].length === 0) continue;
    next[key] = unique([...(current[key] || []), ...permissions[key]]);
  }
  const merged = { ...existing, permissions: next };
  if (!dryRun) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }
  return merged;
}
