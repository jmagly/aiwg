// Detect managed hook registration/script drift and outdated rule headers without writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { lt, valid } from 'semver';
import { managedClaudeHooks } from '../../extensions/claude-hooks-installer.js';
import { AIWG_MANAGED_HOOKS } from '../../extensions/muse-managed-hooks.js';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { loadHookSources } from '../../smiths/hook-bridge/loader.js';
import { parseJson } from '../../mcp/json-document.mjs';
import { getProviderArtifactPathStrings } from '../../providers/provider-definitions.js';
import * as ui from '../ui.js';

export interface StaleManagedDeployment {
  name: string;
  file: string;
  reason: 'missing' | 'outdated' | 'unreadable' | 'operator-edited';
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; _aiwg_id?: string; _aiwg_managed?: boolean }>;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const doc = parseJson(await fs.readFile(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Expected an object');
    return doc as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function groups(doc: Record<string, unknown>, event: string): HookGroup[] {
  const hooks = doc.hooks as Record<string, unknown> | undefined;
  return Array.isArray(hooks?.[event]) ? hooks[event] as HookGroup[] : [];
}

async function staleHooks(projectRoot: string, frameworkRoot: string, provider: string): Promise<StaleManagedDeployment[]> {
  if (provider !== 'claude' && provider !== 'muse') return [];
  const file = provider === 'claude' ? '.claude/settings.json' : '.muse/hooks.json';
  let doc;
  try { doc = await readJson(path.join(projectRoot, file)); }
  catch { return [{ name: `${provider} managed hooks`, file, reason: 'unreadable' }]; }

  const stale: StaleManagedDeployment[] = [];
  if (provider === 'claude') {
    const source = path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks');
    let sourceFiles: string[];
    try { sourceFiles = await fs.readdir(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    for (const hook of managedClaudeHooks(sourceFiles)) {
      const candidates = groups(doc, hook.event).flatMap(group =>
        Array.isArray(group?.hooks) ? group.hooks : [])
        .filter(entry => entry && (entry._aiwg_id === hook.hookId ||
          (typeof entry.command === 'string' && entry.command.includes(hook.script))));
      const current = candidates.some(entry =>
        entry.type === 'command' && entry.command === hook.command &&
        entry._aiwg_managed === true && entry._aiwg_id === hook.hookId);
      if (!current) stale.push({ name: `${hook.event} → ${hook.hookId}`, file, reason: candidates.length ? 'outdated' : 'missing' });
    }
  } else {
    // Muse cannot carry in-band ids. Its sidecar supplies identity for older commands.
    let recorded: Array<{ id?: string; event?: string; group?: HookGroup }> = [];
    try {
      const sidecar = await readJson(path.join(projectRoot, '.muse/.aiwg-hooks.json'));
      if (Array.isArray(sidecar.hooks)) recorded = sidecar.hooks;
    } catch { /* The live document still proves canonical registrations without a sidecar. */ }
    for (const hook of AIWG_MANAGED_HOOKS) {
      const deployed = groups(doc, hook.event);
      if (deployed.some(group => isDeepStrictEqual(group, hook.group))) continue;
      const previous = recorded.find(entry => entry?.id === hook.id);
      const exists = deployed.some(group => isDeepStrictEqual(group, previous?.group) ||
        group?.hooks?.some(entry => entry?.command === hook.group.hooks[0].command));
      stale.push({ name: `${hook.event} → ${hook.id}`, file, reason: exists ? 'outdated' : 'missing' });
    }
  }
  return stale;
}

async function staleRules(projectRoot: string, provider: string, version: string): Promise<StaleManagedDeployment[]> {
  const directory = getProviderArtifactPathStrings(provider)?.rules;
  if (!directory || path.isAbsolute(directory) || directory.startsWith('~')) return [];
  const stale: StaleManagedDeployment[] = [];
  async function visit(relative: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    await Promise.all(entries.map(async entry => {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) return visit(file);
      if (!entry.isFile() || !/\.(md|mdc)$/.test(entry.name)) return;
      const content = await fs.readFile(path.join(projectRoot, file), 'utf8');
      const marker = /^(?:#|<!--)\s*aiwg:managed\s+v([^\s>]+)([^\r\n]*)/m.exec(content);
      if (!marker || /\bproject-local\b/.test(marker[2])) return;
      const older = valid(marker[1]) && valid(version) ? lt(marker[1], version) : marker[1] !== version;
      if (older) stale.push({ name: `${file} (v${marker[1]} → v${version})`, file, reason: 'outdated' });
    }));
  }
  await visit(directory);
  return stale;
}

async function staleHookScripts(projectRoot: string, frameworkRoot: string, provider: string): Promise<StaleManagedDeployment[]> {
  const source = path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks');
  const scripts = new Map<string, string>();
  if (provider === 'claude') {
    let files: string[];
    try { files = await fs.readdir(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    for (const hook of managedClaudeHooks(files)) scripts.set(hook.script, path.join(source, path.basename(hook.script)));
  } else if (provider === 'muse') {
    scripts.set('.muse/hooks/aiwg-prompt-discovery.cjs', path.join(source, 'aiwg-prompt-discovery.cjs'));
  } else if (provider === 'codex') {
    // Match installCodexPromptDiscovery: resolve packaged canonical arguments,
    // not the portable launcher command emitted into hooks.json.
    const { sources, errors } = await loadHookSources(frameworkRoot);
    if (errors.length) throw new Error(errors.join('\n'));
    const hook = sources.find(entry => entry.id === 'aiwg-prompt-discovery');
    if (hook?.args?.[0]) scripts.set('.codex/hooks/aiwg-prompt-discovery.cjs', hook.args[0]);
  }
  const stale: StaleManagedDeployment[] = [];
  for (const [file, sourceFile] of scripts) {
    // Each provider currently copies these bytes verbatim; registrations may
    // transform commands independently (notably Codex's portable launcher).
    const reason = await managedHookScriptState(projectRoot, file, await fs.readFile(sourceFile));
    if (reason) stale.push({ name: file, file, reason });
  }
  return stale;
}

export async function checkManagedDeployment(options: {
  projectRoot: string; frameworkRoot: string; provider: string; quiet: boolean;
}): Promise<StaleManagedDeployment[]> {
  const { projectRoot, frameworkRoot, provider, quiet } = options;
  const pkg = await readJson(path.join(frameworkRoot, 'package.json'));
  const [hooks, scripts, rules] = await Promise.all([
    staleHooks(projectRoot, frameworkRoot, provider),
    staleHookScripts(projectRoot, frameworkRoot, provider),
    typeof pkg.version === 'string' ? staleRules(projectRoot, provider, pkg.version) : [],
  ]);
  const stale = [...hooks, ...scripts, ...rules].sort((a, b) => a.name.localeCompare(b.name));
  if (stale.length && !quiet) {
    for (const item of stale) ui.warn(`Stale deployment: ${item.reason} ${item.name} — ${item.file}${item.reason === 'operator-edited' ? ' (kept; review operator edits before redeploying)' : ''}`);
    ui.warn(`Fix this deployment: aiwg use all --provider ${provider}`);
  }
  return stale;
}
