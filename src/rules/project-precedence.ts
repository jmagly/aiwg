// Validate ordering against canonical rule sources, including installed project-local bundles.
import fs from 'node:fs';
import path from 'node:path';
import { parseRuleFrontmatter } from './activation.mjs';
import { ruleFiles, rulePinState } from './pin-state.js';
import { loadRulePinConfigs, type PinConfig } from './pins.mjs';
import { validateRulePrecedenceConfig } from './precedence.mjs';
import { resolveFrameworkIndexRoot } from '../artifacts/framework-index-paths.js';
import { stableRecordId } from '../artifacts/browser-export.js';

export function validateProjectRulePrecedence(cwd: string, config: PinConfig, source: 'project' | 'user' = 'project', userConfigDir?: string): string[] {
  const overrides = config.rules?.precedence;
  const errors = validateRulePrecedenceConfig(overrides);
  if (errors.length || !overrides || !Object.keys(overrides).length) return errors;
  const root = resolveFrameworkIndexRoot(cwd);
  const configs = loadRulePinConfigs(cwd, source === 'project' ? config : undefined, userConfigDir);
  if (source === 'user') configs.user = config;
  const inventory = rulePinState(cwd, root, configs, true, false).inventory;
  const files = new Map(inventory.map(rule => [rule.path, [rule.id, rule.name]]));
  for (const kind of ['addons', 'frameworks', 'extensions']) {
    const base = path.join(root, 'agentic/code', kind);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) for (const file of ruleFiles(path.join(base, name, 'rules'))) {
      if (!files.has(file)) files.set(file, []);
    }
  }
  const candidates = [...files].filter(([file]) => !/\.core\.md$|\/(?:README|RULES-INDEX|RULES-ONDEMAND)\.md$/.test(file)).map(([file, aliases]) => {
    const parsed = parseRuleFrontmatter(fs.readFileSync(file, 'utf8'));
    const slug = path.basename(file, '.md');
    return { file, parsed, aliases: [...aliases, ...ruleOrderingAliases(file, root, cwd), String((parsed.data as Record<string, unknown>)?.name ?? slug)] };
  });
  const selected = new Map<string, string>();
  for (const id of Object.keys(overrides)) {
    const matches = candidates.filter(candidate => candidate.aliases.includes(id));
    if (matches.length !== 1) { errors.push(`rules.precedence.${id}: ${matches.length ? 'ambiguous' : 'unknown'} rule`); continue; }
    const { parsed, file } = matches[0];
    if (selected.has(file)) errors.push(`rules.precedence.${id}: duplicates override ${selected.get(file)} for the same rule`);
    selected.set(file, id);
    if (!parsed.valid) errors.push(`${file}: ${parsed.diagnostics.map(item => item.message).join('; ')}`);
    else if (!parsed.rule.overridable) errors.push(`Rule ${id} is non-overridable (rules.precedence)`);
  }
  return errors;
}

/** Source slugs and stable IDs share the same override identity in every read surface. */
export function ruleOrderingAliases(file: string, root: string, cwd = root): string[] {
  const paths = [file, path.relative(root, file), path.relative(cwd, file)];
  return [path.basename(file, '.md'), ...paths, ...paths.map(value => stableRecordId('aiwg.rule', value))];
}

/** Render operator ordering where agents already load project context. */
export function projectRulePrecedenceText(cwd: string): string {
  const configs = loadRulePinConfigs(cwd);
  const lines: string[] = [];
  for (const source of ['user', 'project'] as const) {
    const errors = validateProjectRulePrecedence(cwd, configs[source], source);
    if (errors.length) throw new Error(errors.join('\n'));
    for (const [id, override] of Object.entries(configs[source].rules?.precedence ?? {})) {
      lines.push(`- Rule ${id}: ${override.tier ? `precedence ${override.tier}; ` : ''}${override.project_context === undefined ? '' : `project context outranks rule: ${override.project_context}; `}source: ${source} rules.precedence.`);
    }
  }
  return lines.length ? `Configured rule ordering (project entries override user entries):\n${lines.join('\n')}` : '';
}
