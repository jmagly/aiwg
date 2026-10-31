// Carry use's requested frameworks through additive passes without recording an installation.
import { getFrameworksForMode, resolveAiwgRoot } from './providers/base.mjs';
import { importImpl } from '../_resolve-impl.mjs';

const { loadRulePinConfigs } = await importImpl(import.meta.url, 'rules/pins.mjs');

export function useRuleSelectionConfig(cfg, srcRoot) {
  if (!cfg.ruleSelectionMode || cfg.kernelOnly) return undefined;
  const root = resolveAiwgRoot(srcRoot) || srcRoot;
  const frameworks = getFrameworksForMode(root, cfg.ruleSelectionMode);
  if (!frameworks.length) return undefined;
  const { project } = loadRulePinConfigs(cfg.target);
  // Existing install metadata and operator pins win; provisional entries exist
  // only in this projector's config snapshot and are never written to disk.
  const installed = Object.fromEntries(frameworks.map(framework => [framework.id, { source: 'bundled' }]));
  return { ...project, installed: { ...installed, ...project.installed } };
}
