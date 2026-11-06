// Emit Codex 0.165 matcher groups in project hooks.json; retain safe TOML repair.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';
import { substituteEnvVars } from './shim.js';
import { loadHookSources } from './loader.js';
import { tomlString } from '../../mcp/toml-string.mjs';

// Verified with the installed 0.165.0 app-server hooks/list. Config keys use
// PascalCase; snake_case names (user_prompt_submit, pre_tool_use, etc.) are IDs
// in the runtime, not accepted config keys. See docs/hook-patterns.md.
const CODEX_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
  'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
]);

interface CommandHook {
  [key: string]: unknown;
  type: string;
  command: string;
  timeout?: number;
  _aiwg_managed?: boolean;
  _aiwg_id?: string;
}
interface HookGroup {
  [key: string]: unknown;
  hooks: CommandHook[];
}

// Codex runs hooks in the session cwd, which may be below the hooks.json root.
const PROMPT_DISCOVERY_LAUNCHER = [
  'const fs=require("node:fs"),path=require("node:path");',
  'for(let dir=process.cwd();;dir=path.dirname(dir)){',
  'const script=path.join(dir,".codex/hooks/aiwg-prompt-discovery.cjs");',
  'if(fs.existsSync(script)){require(script);break;}',
  'if(path.dirname(dir)===dir)break;',
  '}',
].join('');

function shellArgument(value: string, expandEnvironment = true): string {
  // Preserve environment references, but never evaluate argument substitutions.
  const escaped = value.replace(/[\\"`$]/g, '\\$&');
  const argument = expandEnvironment
    ? escaped.replace(/\\\$(\{[A-Z_][A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*)/g, '$$$1') : escaped;
  return `"${argument}"`;
}

function commandHook(source: HookSource, literalArgs = false): CommandHook {
  const command = substituteEnvVars(source.command, 'codex');
  const args = (source.args || []).map(a => shellArgument(substituteEnvVars(a, 'codex'), !literalArgs));
  return {
    type: 'command', command: [command, ...args].join(' '),
    ...(source.timeout === undefined ? {} : { timeout: source.timeout }),
    _aiwg_managed: true, _aiwg_id: source.id,
  };
}

/** TOML uses the same matcher groups and command string as hooks.json. */
export function renderCodexHookToml(source: HookSource): string {
  const lines: string[] = [];
  const hook = commandHook(source);
  for (const event of source.events) {
    if (!CODEX_EVENTS.has(event)) continue;
    lines.push(`[[hooks.${event}]]`);
    lines.push(`# AIWG-managed hook: ${`${source.id} — ${source.description}`.replace(/[\x00-\x1f\x7f]/g, ' ')}`);
    if (source.safetyCritical) lines.push('# safety-critical: cannot be auto-removed without --allow-unsafe-shadow');
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlString(hook.command)}`);
    if (hook.timeout !== undefined) lines.push(`timeout = ${hook.timeout}`);
    lines.push('_aiwg_managed = true', `_aiwg_id = ${tomlString(source.id)}`, '');
  }
  return lines.join('\n');
}

const SPILLOVER_START = '# >>> AIWG-managed hooks (do not edit between markers)';
const SPILLOVER_END = '# <<< AIWG-managed hooks';

function markerIndex(text: string, marker: string, from = 0): number {
  for (let index = text.indexOf(marker, from); index !== -1; index = text.indexOf(marker, index + marker.length)) {
    const end = index + marker.length;
    if ((index === 0 || text[index - 1] === '\n')
      && (end === text.length || /^\r?\n/.test(text.slice(end, end + 2)))) return index;
  }
  return -1;
}

/** Replace only managed content, rescuing user tables inside a misplaced end. */
export function injectHookBlock(existingToml: string, hookBlock: string): string {
  const startIdx = markerIndex(existingToml, SPILLOVER_START);
  const endIdx = markerIndex(existingToml, SPILLOVER_END, startIdx);
  const section = `${SPILLOVER_START}\n${hookBlock.trimEnd()}\n${SPILLOVER_END}`;
  if (startIdx === -1 || endIdx === -1) {
    return existingToml + (existingToml ? (existingToml.endsWith('\n') ? '\n' : '\n\n') : '') + section + '\n';
  }
  const bodyStart = startIdx + SPILLOVER_START.length;
  const body = existingToml.slice(bodyStart, endIdx);
  const tables = body.matchAll(/^[ \t]*\[{1,2}([^\]\r\n]+)\]{1,2}[^\r\n]*/gm);
  let rescued = '';
  for (const table of tables) {
    const name = table[1].trim();
    if (name === 'hooks' || name.startsWith('hooks.')) continue;
    // Comments immediately preceding the first user table belong to the user.
    let boundary = table.index!;
    while (boundary > 0) {
      const previous = body.lastIndexOf('\n', boundary - 2) + 1;
      if (!/^[ \t]*(?:#[^\r\n]*)?\r?\n$/.test(body.slice(previous, boundary))) break;
      boundary = previous;
    }
    rescued = '\n' + body.slice(boundary);
    break;
  }
  return existingToml.slice(0, startIdx) + section + rescued
    + existingToml.slice(endIdx + SPILLOVER_END.length);
}

/** Translate one source, merging by ID without replacing other managed hooks. */
export async function translateForCodex(source: HookSource, options: TranslateOptions): Promise<TranslateResult> {
  const result: TranslateResult = { provider: 'codex', emittedPaths: [], warnings: [], skipped: false };
  if (source.degradeOn?.includes('codex')) {
    return { ...result, skipped: true, skipReason: 'degrade-on declared codex' };
  }
  const events = source.events.filter(event => CODEX_EVENTS.has(event));
  if (!events.length) return { ...result, skipped: true, skipReason: 'no Codex-mapped events' };
  const directory = path.join(options.projectPath, '.codex');
  const configPath = path.join(directory, 'hooks.json');
  const promptHook = source.id === 'aiwg-prompt-discovery';
  const scriptPath = path.join(directory, 'hooks', 'aiwg-prompt-discovery.cjs');
  if (options.dryRun) {
    result.emittedPaths = [configPath, ...(promptHook ? [scriptPath] : [])].map(p => p + ' (dry-run)');
    return result;
  }
  for (const target of [directory, configPath, ...(promptHook ? [path.dirname(scriptPath), scriptPath] : [])]) {
    try {
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlinked Codex hook target: ${target}`);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  let existing = '';
  try { existing = await fs.readFile(configPath, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const doc = existing ? JSON.parse(existing) : {};
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
    || (doc.hooks !== undefined && (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))) {
    throw new Error(`Invalid Codex hooks object in ${configPath}`);
  }
  const hooks: Record<string, HookGroup[]> = doc.hooks ?? {};
  let managed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) {
      throw new Error(`Invalid Codex matcher groups for ${event}`);
    }
    hooks[event] = groups.flatMap(group => {
      managed ||= group.hooks.some(h => h._aiwg_managed === true);
      const kept = group.hooks.filter(h => !(h._aiwg_managed === true && h._aiwg_id === source.id));
      return kept.length === group.hooks.length ? [group] : kept.length ? [{ ...group, hooks: kept }] : [];
    });
  }
  if (promptHook) {
    if (!source.args?.[0]) throw new Error('Prompt discovery source is missing its shared script');
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.copyFile(source.args[0], scriptPath);
    source = { ...source, args: ['-e', PROMPT_DISCOVERY_LAUNCHER] };
  }
  for (const event of events) (hooks[event] ??= []).push({ hooks: [commandHook(source, promptHook)] });
  doc.hooks = hooks;
  await fs.mkdir(directory, { recursive: true });
  if (existing && !managed) {
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupPath, existing, 'utf8');
    result.warnings.push(`Backed up pre-existing config to ${backupPath}`);
  }
  const temporary = `${configPath}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, configPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  result.emittedPaths = [configPath, ...(promptHook ? [scriptPath] : [])];
  return result;
}

/** Default Codex prompt hook deployment reuses the canonical bridge source. */
export async function installCodexPromptDiscovery(options: TranslateOptions & { frameworkRoot: string }): Promise<TranslateResult> {
  const { sources, errors } = await loadHookSources(options.frameworkRoot);
  if (errors.length) throw new Error(errors.join('\n'));
  const source = sources.find(s => s.id === 'aiwg-prompt-discovery');
  if (!source) throw new Error('Missing canonical aiwg-prompt-discovery source');
  return translateForCodex(source, options);
}
