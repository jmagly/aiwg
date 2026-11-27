// Prepare the native project plugin and preserve superseded Antigravity MCP data.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { assertConfigDestination, assertConfigObject } from './config-file.mjs';

export function resolveAntigravityConfigPath(projectDir = '.', options = {}) {
  return options.scope === 'user'
    ? resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.gemini/config/mcp_config.json')
    : resolve(projectDir, '.agents/plugins/aiwg/mcp_config.json');
}

async function readObject(file, projectRoot) {
  await assertConfigDestination(file, projectRoot);
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    assertConfigObject(value, 'mcpServers');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Refusing to overwrite malformed MCP config ${file}: ${error.message}`);
  }
}

export async function prepareAntigravityConfig(provider, configPath, existing, location = {}) {
  const plan = { config: existing, writes: [], warnings: [] };
  if (!['antigravity', 'agy'].includes(provider) || location.scope === 'user') return plan;
  const projectRoot = resolve(location.projectDir || '.');
  if (resolve(configPath) !== resolveAntigravityConfigPath(projectRoot)) {
    throw new Error('Antigravity project MCP injection requires .agents/plugins/aiwg/mcp_config.json; the legacy config is migration input only.');
  }
  const manifestPath = resolve(dirname(configPath), 'plugin.json');
  const manifest = await readObject(manifestPath, projectRoot);
  if (!manifest) plan.writes.push({ file: manifestPath, content: '{"name":"aiwg"}\n', options: { projectRoot } });

  const legacyPath = resolve(projectRoot, '.agents/mcp_config.json');
  const legacy = await readObject(legacyPath, projectRoot);
  if (!legacy) return plan;
  plan.warnings.push('Antigravity: .agents/mcp_config.json is superseded by .agents/plugins/aiwg/mcp_config.json; the legacy file is retained unchanged. Restart agy to discover the plugin.');
  const legacyServers = Object.fromEntries(Object.entries(legacy.mcpServers || {}).map(([name, entry]) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.serverUrl && !entry.url) {
      const { serverUrl, ...rest } = entry;
      return [name, { ...rest, url: serverUrl }];
    }
    return [name, entry];
  }));
  const currentServers = existing.mcpServers || {};
  for (const name of Object.keys(legacyServers)) {
    if (Object.hasOwn(currentServers, name) && JSON.stringify(currentServers[name]) !== JSON.stringify(legacyServers[name])) {
      plan.warnings.push(`Antigravity: server ${name} differs in the legacy config; the plugin entry wins. The legacy entry remains in .agents/mcp_config.json for manual review.`);
    }
  }
  for (const key of Object.keys(legacy)) {
    if (key !== 'mcpServers' && Object.hasOwn(existing, key) && JSON.stringify(existing[key]) !== JSON.stringify(legacy[key])) {
      plan.warnings.push(`Antigravity: top-level ${key} differs in the legacy config; the plugin value wins and the legacy file is retained.`);
    }
  }
  plan.config = { ...legacy, ...existing, mcpServers: { ...legacyServers, ...currentServers } };
  return plan;
}
