// Read only native model/effort settings; never load authentication stores or probe providers.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { load as loadYaml } from 'js-yaml';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

export async function readWrapperSettings(provider, projectDir, scope = 'agent') {
  const home = (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  let files = [];
  if (provider === 'claude') files = [path.join(home, '.claude/settings.json'),
    path.join(projectDir, '.claude/settings.json'), path.join(projectDir, '.claude/settings.local.json')];
  if (provider === 'codex') files = [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    path.join(projectDir, '.codex/config.toml')];
  if (provider === 'hermes') files = [path.join(process.env.HERMES_HOME || path.join(home, '.hermes'), 'config.yaml')];
  if (provider === 'muse') files = [path.join(configHome, 'muse/settings.json')];
  let settings = {};
  for (const file of files) {
    let content;
    try { content = await readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('native model settings unreadable');
    }
    try {
      const parsed = file.endsWith('.toml') ? getStaticTOMLValue(parseTOML(content))
        : file.endsWith('.yaml') ? loadYaml(content) : JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings');
      settings = { ...settings, ...parsed, env: { ...settings.env, ...parsed.env } };
    } catch { throw new Error('native model settings malformed'); }
  }
  const string = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  if (provider === 'claude') {
    if (scope === 'skill') return { inheritedModel: string(settings.model) };
    const env = { ...process.env, ...settings.env };
    return { inheritedModel: string(env.CLAUDE_CODE_SUBAGENT_MODEL) ?? string(settings.model),
      inheritedEffort: string(settings.effortLevel) ?? string(settings.effort),
      forceInheritedModel: Boolean(string(env.CLAUDE_CODE_SUBAGENT_MODEL)) && env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1' };
  }
  if (provider === 'codex') settings = { ...settings, ...settings.profiles?.[settings.profile] };
  if (provider === 'hermes') return {
    inheritedModel: string(settings.delegation?.model) ?? string(settings.model?.default) ?? string(settings.model),
    inheritedEffort: string(settings.delegation?.effort),
  };
  return { inheritedModel: string(settings.model),
    inheritedEffort: string(settings.model_reasoning_effort) ?? string(settings.effort) };
}
