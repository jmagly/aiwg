// Render packaged Codex agents with the same final bindings and marker as deploy.
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { addManagedMarker, injectBoundRules, listMdFiles } from './base.mjs';
import { transformAgent } from './codex.mjs';
import { projectCodexAgentBindings } from './bound-rules-pointer.mjs';
import { resolveDeliveryRuleBindings } from './rule-binding-targets.mjs';
const { parseRuleFrontmatter } = await importImpl(import.meta.url, 'rules/activation.mjs');
const { collectRuleBindingEntries } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
const { resolveDeployVersion } = await importImpl(import.meta.url, 'providers/deploy-version.mjs');

export function packagedRuleSources(root) {
  const code = path.join(root, 'agentic/code');
  const roots = [code];
  for (const kind of ['frameworks', 'addons', 'extensions', 'plugins']) {
    const dir = path.join(code, kind);
    if (fs.existsSync(dir)) roots.push(...fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name)));
  }
  return roots.flatMap(dir => {
    const behaviors = path.join(dir, 'behaviors');
    return [...listMdFiles(path.join(dir, 'rules')).filter(file => !/^RULES-(INDEX|ONDEMAND)\.md$/.test(path.basename(file))), ...(fs.existsSync(behaviors)
      ? fs.readdirSync(behaviors, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name === 'BEHAVIOR.md')
        .map(entry => path.join(entry.parentPath, entry.name)) : [])];
  });
}

export async function createPackagedCodexRenderer(root, { target = root, ruleSources = packagedRuleSources(root) } = {}) {
  const rules = ruleSources.flatMap(file => {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseRuleFrontmatter(content);
    if (!parsed.valid) throw new Error(`Invalid rule frontmatter: ${file}`);
    if (!parsed.rule?.tagged || !parsed.rule.bound_to.agents.length) return [];
    return [{ ...parsed.rule, file, content, body: parsed.body,
      name: path.basename(file) === 'BEHAVIOR.md' ? `behavior/${path.basename(path.dirname(file))}` : parsed.data.name || path.basename(file, '.md'),
      bound_to: { agents: parsed.rule.bound_to.agents, skills: [], flows: [] } }];
  });
  const bindingEntries = rules.length ? await collectRuleBindingEntries(root, 'agentic/code') : [];
  const delivery = await resolveDeliveryRuleBindings({ srcRoot: root, target, bindingEntries }, rules,
    { project: {}, user: {} }, root, null);
  const deployVersion = resolveDeployVersion(root, undefined, () => {});
  return (source, content = fs.readFileSync(source, 'utf8'), opts = {}) => {
    const transformed = transformAgent(source, injectBoundRules(content, source, { ruleDelivery: delivery }), opts);
    const targets = delivery.targets.filter(entry => entry.source === path.resolve(source));
    return projectCodexAgentBindings(addManagedMarker(transformed, deployVersion, 'bundled', 'line-comment'), targets);
  };
}
