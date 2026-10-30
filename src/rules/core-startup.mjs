/** Share compact core rendering between provider deployment and fresh regeneration. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../cli/find-package-root.js';
import { parseRuleFrontmatter, readCoreBody, validateCoreSet, CORE_RULES_START, CORE_RULES_END } from './activation.mjs';

export function renderCoreStartup(rules) {
  const cores = [...new Map(rules.filter(rule => rule.coreBody !== undefined).map(rule => [rule.name, rule])).values()];
  const errors = validateCoreSet(cores.map(rule => ({ name: rule.name, text: rule.coreBody })));
  if (errors.length) throw new Error(errors.join('; '));
  return cores.length ? `${CORE_RULES_START}\n## Core rules\n\n${cores.map(rule => rule.coreBody).join('\n\n')}\n${CORE_RULES_END}\n` : '';
}

export function ensureCoreStartup(content) {
  // Deployment has already selected and validated the project's core set.
  if (content.includes('<!-- AIWG:rule-core:start -->')) return content;
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!root) throw new Error('AIWG package unavailable; run aiwg use before regenerating context.');
  const dir = path.join(root, 'agentic/code/addons/aiwg-utils/rules');
  if (!fs.existsSync(dir)) throw new Error('Core rule sources unavailable; run aiwg use before regenerating context.');
  const rules = fs.readdirSync(dir).filter(name => name.endsWith('.md') && !name.endsWith('.core.md')).flatMap(name => {
    const file = path.join(dir, name);
    const parsed = parseRuleFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!parsed.valid) throw new Error(`Invalid core rule source ${file}; run aiwg use after repairing it.`);
    return parsed.rule.activation === 'core' ? [{ name: parsed.data.name || path.basename(file, '.md'), coreBody: readCoreBody(file) }] : [];
  });
  const block = renderCoreStartup(rules);
  if (!block) throw new Error('No core rule sources found; run aiwg use before regenerating context.');
  return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}
