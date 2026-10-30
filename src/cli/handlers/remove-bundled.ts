// Remove bundled provider files and reconcile their existing config atomically.
import fs from 'node:fs';
import path from 'node:path';
import { writeAiwgConfig, type AiwgConfig, type DeployedArtifactCounts } from '../../config/aiwg-config.js';
import { resolveProjectAiwgDir } from '../../config/project-artifacts.js';
import { removeClaudeAttribution } from '../../extensions/claude-hooks-installer.js';
import { planDeploymentRemoval, type RemovalDecision } from '../../providers/deployment-removal.js';
import { applyRemovalTransaction, type RemovalWrite } from '../../providers/removal-transaction.js';
import type { HandlerResult } from './types.js';

function counts(decisions: RemovalDecision[]): DeployedArtifactCounts {
  const result = { agents: 0, commands: 0, skills: 0, rules: 0 };
  for (const item of decisions) {
    if (!item.owned) continue;
    if (item.kind === 'agent') result.agents++;
    if (item.kind === 'command' || item.kind === 'skill-command') result.commands++;
    if (item.kind === 'rule') result.rules++;
    if (path.basename(item.path) === 'SKILL.md') result.skills++;
  }
  return result;
}
const summary = (value: DeployedArtifactCounts) => `${value.agents} agents, ${value.commands} commands, ${value.rules} rules, ${value.skills} skills`;

export async function removeBundledDeployment(project: string, id: string, owner: string, config: AiwgConfig,
  providers: string[], opts: { dryRun: boolean; keepRegistry: boolean }): Promise<HandlerResult> {
  const entry = config.installed[id];
  const configBefore = JSON.stringify(config);
  let writeConfig = false;
  const lines: string[] = [], writes = new Map<string, RemovalWrite>();
  let removed = 0, modern = false;
  try {
    for (const provider of providers) {
      const plan = planDeploymentRemoval(project, provider, owner, providers.length === Object.keys(entry.deployedTo).length);
      modern ||= !plan.legacy;
      lines.push(`  Provider ${provider}:`);
      lines.push(`    Receipt inventory: ${summary(counts(plan.decisions))}; ${plan.recorded.length} owned file record(s).`);
      lines.push(`    aiwg.config deployedTo: ${summary(entry.deployedTo[provider])}.`);
      const inventory = counts(plan.decisions);
      if (Object.entries(inventory).some(([kind, value]) => value !== entry.deployedTo[provider][kind as keyof DeployedArtifactCounts])) {
        lines.push('    Count discrepancy: deployedTo is a historical provider snapshot; receipts alone determine ownership and deletions.');
      }
      for (const item of plan.decisions) {
        if (!opts.dryRun && !item.owned && item.reason.startsWith('foreign')) continue;
        const verb = opts.dryRun ? `Would ${item.action}` : item.action === 'remove' ? 'Remove' : item.action === 'release' ? 'Release' : 'Preserve';
        lines.push(`    ${verb} ${path.relative(project, item.path)} — ${item.reason}`);
        if (item.action === 'remove' && item.owned) removed++;
      }
      for (const write of plan.writes) {
        const previous = writes.get(write.path);
        if (previous && !previous.after?.equals(write.after || Buffer.alloc(0)) && (previous.after || write.after)) {
          throw new Error(`Conflicting receipt writes for ${write.path}; no files removed`);
        }
        writes.set(write.path, write);
      }
      if (!opts.keepRegistry) {
        const retained = plan.decisions.filter(item => item.owned && !item.legacy && item.action === 'preserve');
        const unknown = plan.recorded.length === 0 && Object.values(entry.deployedTo[provider]).some(value => typeof value === 'number' && value > 0);
        if (unknown) lines.push('    Deployment record retained: legacy outputs are unverifiable.');
        else {
          const residual = counts(retained);
          let unverifiable = 0;
          for (const kind of Object.keys(residual) as Array<keyof DeployedArtifactCounts>) {
            const gap = Math.max(0, entry.deployedTo[provider][kind] - inventory[kind]);
            residual[kind] += gap; unverifiable += gap;
          }
          if (retained.length || unverifiable) {
            entry.deployedTo[provider] = residual;
            if (unverifiable) lines.push(`    Retained ${unverifiable} unverifiable historical artifact count(s); no ownership inferred.`);
            lines.push(`    Partial removal: ${retained.length} owned file record(s) retained; deployedTo counts reconciled.`);
          } else delete entry.deployedTo[provider];
        }
      }
    }
    if (opts.keepRegistry) lines.push('  Registry preserved (--keep-registry).');
    else {
      if (!Object.keys(entry.deployedTo).length) delete config.installed[id];
      writeConfig = JSON.stringify(config) !== configBefore;
      const configPath = path.join(project, '.aiwg/aiwg.config');
      if (writeConfig) writes.set(configPath, { path: configPath, before: fs.readFileSync(configPath), after: Buffer.from(`${JSON.stringify(config, null, 2)}\n`), commit: true });
      const mirror = path.join(resolveProjectAiwgDir(project), 'aiwg.config');
      if (writeConfig && mirror !== configPath && fs.existsSync(path.dirname(mirror))) writes.set(mirror, { path: mirror,
        before: fs.existsSync(mirror) ? fs.readFileSync(mirror) : null, after: Buffer.from(`${JSON.stringify(config, null, 2)}\n`), commit: true });
      lines.push(writeConfig ? `  ${opts.dryRun ? 'Would update' : 'Update'} .aiwg/aiwg.config to match the remaining receipts.`
        : '  Deployment records unchanged; .aiwg/aiwg.config preserved.');
    }
    if (!opts.dryRun) {
      const legacyAttribution = !modern && !opts.keepRegistry && providers.includes('claude') && !Object.values(config.installed).some(item => item.deployedTo.claude);
      const settings = path.join(project, '.claude/settings.json');
      if (legacyAttribution && fs.existsSync(settings)) writes.set(settings, { path: settings,
        before: fs.readFileSync(settings), after: fs.readFileSync(settings), commit: true });
      await applyRemovalTransaction([...writes.values()], async () => {
        if (writeConfig) await writeAiwgConfig(project, config);
        // Preserve existing attribution-only cleanup for legacy installations.
        if (legacyAttribution) await removeClaudeAttribution(project);
      });
      const directories = new Set<string>();
      for (const write of writes.values()) {
        if (write.after !== null) continue;
        let dir = path.dirname(write.path);
        while (dir !== project && dir.startsWith(`${project}${path.sep}`)) { directories.add(dir); dir = path.dirname(dir); }
      }
      for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
        try { fs.rmdirSync(dir); } catch { /* Nonempty directories preserve operator files and remaining receipts. */ }
      }
    }
    lines.push(`${opts.dryRun ? 'Would remove' : 'Removed'} ${removed} unchanged recorded file(s); operator files preserved.`);
    return { exitCode: 0, message: lines.join('\n') };
  } catch (error) {
    return { exitCode: 1, message: `Framework removal failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
