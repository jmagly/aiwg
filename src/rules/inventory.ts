import { resolveRulePrecedence } from './precedence.mjs';
import { ruleOrderingAliases } from './project-precedence.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadRelations } from '../artifacts/relations.js';
import { parseRuleFrontmatter, inferRuleActivation } from './activation.mjs';
import { capabilityId, loadRulePinConfigs, resolveRulePins } from './pins.mjs';
import { ruleFiles, rulePinState } from './pin-state.js';
import { readUserRegistry } from '../config/user-registry.js';

export type InventoryScope = 'workspace' | 'user' | 'installation' | 'catalog';
export interface InventoryOptions {
  scope: InventoryScope;
  capability?: string[];
  activation?: string[];
  enforcement?: string[];
  provider?: string;
  bodies?: boolean;
}

function includedByAll(root: string, cap: string): boolean {
  for (const kind of ['frameworks', 'addons', 'extensions']) {
    const dir = path.join(root, 'agentic/code', kind, cap);
    if (!fs.existsSync(dir) || cap === 'aiwg-dev') continue;
    const file = path.join(dir, 'manifest.json');
    const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return !manifest.devOnly && !manifest.explicitInstall;
  }
  return false;
}

/** Read source metadata only. Catalog membership is availability, not applicability. */
export async function ruleInventory(cwd: string, root: string, options: InventoryOptions) {
  const configs = loadRulePinConfigs(cwd);
  const selected = options.scope === 'user' ? { project: {}, user: configs.user } : configs;
  const state = rulePinState(cwd, root, selected, true, false);
  const relations = loadRelations(cwd, cwd, false) ?? loadRelations(root, cwd, false);
  const userRegistry = await readUserRegistry();
  const inventory = [...state.inventory];
  if (options.scope === 'catalog') {
    const known = new Set(inventory.map(rule => rule.path));
    for (const kind of ['frameworks', 'addons', 'extensions', 'plugins']) {
      const base = path.join(root, 'agentic/code', kind);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const file of ruleFiles(path.join(base, entry.name, 'rules'))) {
          if (known.has(file)) continue;
          const content = fs.readFileSync(file, 'utf8');
          const parsed = parseRuleFrontmatter(content);
          if (!parsed.valid) throw new Error(`${file}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
          const data = parsed.data as Record<string, unknown>;
          const enforcement = String(data.enforcement ?? content.match(/^\*\*Enforcement Level\*\*:\s*([A-Za-z]+)/m)?.[1] ?? '').toLowerCase() || null;
          inventory.push({ id: file, path: file, name: String(data.name || path.basename(file, '.md')), capability: entry.name,
            activation: parsed.rule.tagged ? parsed.rule.activation : inferRuleActivation(enforcement), enforcement });
          known.add(file);
        }
      }
    }
  }
  const warnings = [...state.warnings];
  if (!relations) warnings.push('Relationship index unavailable; resolved bindings and indexed missing-source checks are unknown.');
  if (options.provider) warnings.push('Provider filter uses recorded capability deployments; missing records do not prove non-delivery.');
  for (const capability of state.installed) if (!state.inventory.some(rule => capabilityId(rule.capability) === capability)) {
    warnings.push(`No rule sources found for installed capability '${capability}'; it may have no rules or its source may be unavailable.`);
  }
  if (relations) for (const item of Object.values(relations.index.rules)) {
    if (item.type !== 'rule' || !state.installed.includes(capabilityId(item.capability) ?? '')) continue;
    const file = path.resolve(root, item.path);
    if (!fs.existsSync(file)) {
      const message = `Installed indexed rule is missing: ${file}`;
      if (options.bodies) throw new Error(message);
      warnings.push(message);
    }
  }
  const source = new Map(inventory.map(rule => {
    const content = fs.readFileSync(rule.path, 'utf8');
    const parsed = parseRuleFrontmatter(content);
    if (!parsed.valid) throw new Error(`${rule.path}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
    const data = parsed.data as Record<string, unknown>;
    const enforcement = String(data.enforcement ?? content.match(/^\*\*Enforcement Level\*\*:\s*([A-Za-z]+)/m)?.[1] ?? '').toLowerCase() || null;
    const activation = parsed.rule.tagged ? parsed.rule.activation : inferRuleActivation(enforcement);
    if (enforcement !== rule.enforcement) warnings.push(`Stale enforcement metadata for ${rule.path}; canonical source used`);
    if (activation !== rule.activation) warnings.push(`Stale activation metadata for ${rule.path}; canonical source used`);
    return [rule.path, { content, parsed, enforcement, activation }] as const;
  }));
  // Resolve pins against source metadata, not potentially stale relation tiers.
  const canonicalRules = inventory.map(rule => ({ ...rule, enforcement: source.get(rule.path)!.enforcement, activation: source.get(rule.path)!.activation }));
  const canonicalPins = resolveRulePins({ rules: canonicalRules, configs: selected, installed: state.installed });
  const pins = new Map(canonicalPins.rules.map(rule => [rule.path, rule]));
  const rules = inventory.flatMap(rule => {
    const cap = capabilityId(rule.capability) ?? '';
    if (options.capability && !options.capability.some(value => capabilityId(value) === cap)) return [];
    const pin = pins.get(rule.path);
    const { content, parsed, enforcement, activation: canonical } = source.get(rule.path)!;
    if (options.enforcement && !options.enforcement.includes(enforcement ?? '')) return [];
    const effective = pin?.activation ?? canonical;
    if (options.activation && !options.activation.includes(effective)) return [];
    const relation = relations && Object.entries(relations.index.rules).find(([, item]) => path.resolve(root, item.path) === rule.path);
    const stableId = relation?.[0] ?? null;
    const installed = state.installed.includes(cap);
    const layers = [
      { source: 'user-registry', entries: userRegistry.installed },
      { source: 'user-config', entries: configs.user.installed ?? {} },
      ...(options.scope === 'user' ? [] : [{ source: 'workspace-config', entries: configs.project.installed ?? {} }]),
    ];
    const hasBulkMembership = includedByAll(root, cap);
    const configuredBy = layers.filter(layer => layer.entries[cap] || (hasBulkMembership && layer.entries.all)).map(layer => layer.source);
    const entries = layers.flatMap(layer => [layer.entries[cap], ...(hasBulkMembership ? [layer.entries.all] : [])]) as Array<{ deployedTo?: Record<string, unknown> } | undefined>;
    const configuredProviders = [...new Set(entries.flatMap(entry => Object.keys(entry?.deployedTo ?? {})))].sort();
    if (options.provider && !configuredProviders.includes(options.provider)) return [];
    return [{ id: stableId, name: rule.name, capability: cap, source: rule.path, summary: parsed.rule.summary ?? null,
      configured: installed, configured_by: configuredBy, applicable: installed ? 'conditional' : 'not-configured',
      canonical_activation: canonical, effective_activation: installed ? effective : null,
      ...resolveRulePrecedence({ ...parsed.rule, name: rule.name, id: stableId ?? undefined }, selected, ruleOrderingAliases(rule.path, root, cwd)),
      enforcement, pin_reasons: pin?.matches ?? [],
      bindings: relation ? relation[1].targets : null, binding_evidence: relation ? 'relationship-index' : 'unknown', bound_to: parsed.rule.bound_to, paths: parsed.rule.paths ?? [],
      fetch_command: stableId ? `aiwg show rule ${stableId} --body` : null,
      configured_providers: configuredProviders, delivery_evidence: configuredProviders.length ? 'capability deployment recorded; per-rule delivery unverified' : 'none', delivery: 'unknown', session_loaded: 'unknown',
      ...(options.bodies ? { content } : {}) }];
  }).sort((a, b) => a.capability.localeCompare(b.capability) || a.source.localeCompare(b.source));
  return { scope: options.scope, scope_description: options.scope === 'workspace' ? 'current repository/workspace and user configuration' :
    options.scope === 'user' ? 'user configuration and user installation registry' : options.scope === 'installation' ? 'configured installed capabilities' : 'available installation catalog; configured flags are contextual',
    rules, warnings };
}
