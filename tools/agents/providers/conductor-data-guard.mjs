// Compile the existing project data policy into project-local provider refusals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importImpl, resolveImpl } from '../../_resolve-impl.mjs';

const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

// Avoid the full model-config load for ordinary deploys, including slim CLI installs
// without framework defaults. Declared guards use the same validated loader as paths.
function declaresGuardPolicy(targetDir, provider) {
  const userDir = process.env.AIWG_CONFIG || path.join(os.homedir(), '.config/aiwg');
  return [path.join(targetDir, 'models.json'), path.join(userDir, 'models.json'), path.join(targetDir, '.aiwg/aiwg.config')]
    .some(file => { try {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('localOnlyPaths')) return true;
      if (provider !== 'claude' || !source.includes('denyConductorWorkerExecution')) return false;
      const value = JSON.parse(source)?.defaults?.workerSelection?.guards?.denyConductorWorkerExecution;
      return value !== undefined && value !== false;
    } catch (error) { return error instanceof SyntaxError; } });
}

// Turn off a previously deployed opt-in check without removing retained read rules.
function disableExecutionCheck(targetDir, provider, opts) {
  if (provider !== 'claude' || opts.dryRun) return;
  const root = path.resolve(targetDir), hookPath = path.join(root, '.claude/hooks/aiwg-local-only.mjs');
  if (!fs.existsSync(hookPath)) return;
  const source = fs.readFileSync(hookPath, 'utf8');
  const start = source.lastIndexOf(`\nrunConductorDataHook(${JSON.stringify(root)}, `);
  if (start >= 0 && source.endsWith(', true);\n')) {
    fs.writeFileSync(hookPath, source.slice(0, -', true);\n'.length) + ', false);\n');
  }
}

export async function deployConductorDataGuard(targetDir, provider, opts = {}) {
  if (!declaresGuardPolicy(targetDir, provider)) {
    disableExecutionCheck(targetDir, provider, opts);
    return [];
  }
  // Always resolve policy through the existing loader, including inherited restrictions.
  const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const guard = await importImpl(import.meta.url, 'models/conductor-data-policy.mjs');
  const config = await readAiwgConfig(targetDir);
  const models = await new ConfigLoader(targetDir).load(config?.parallelism);
  const executionGuard = provider === 'claude' && models.defaults.workerSelection?.guards?.denyConductorWorkerExecution === true;
  const paths = guard.collectLocalOnlyPaths(models.defaults.workerSelection, config?.parallelism);
  if (!paths.length && !executionGuard) {
    disableExecutionCheck(targetDir, provider, opts);
    return paths;
  }
  if (opts.dryRun) return paths;
  const root = path.resolve(targetDir);
  if (provider === 'claude') {
    const settingsPath = path.join(root, '.claude/settings.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const hookPath = path.join(root, '.claude/hooks/aiwg-local-only.mjs');
    const hookSource = fs.readFileSync(resolveImpl(import.meta.url, 'models/conductor-data-policy.mjs'), 'utf8');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `${hookSource}\nrunConductorDataHook(${JSON.stringify(root)}, ${JSON.stringify(paths)}, ${JSON.stringify(executionGuard)});\n`);
    settings.permissions ??= {};
    settings.permissions.deny = [...new Set([...(settings.permissions.deny ?? []), ...paths.flatMap(file => [
      `Read(//${path.join(root, file).slice(1)})`, `Read(//${path.join(root, file).slice(1)}/**)`,
    ])])];
    settings.hooks ??= {};
    const command = `node ${quote(hookPath)}`;
    const entries = settings.hooks.PreToolUse ?? [];
    settings.hooks.PreToolUse = [...entries.filter(entry => !entry.hooks?.some(hook => hook.command === command)),
      { matcher: '.*', hooks: [{ type: 'command', command }] }];
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } else if (provider === 'codex') {
    const rulesPath = path.join(root, '.codex/rules/aiwg-local-only.rules');
    const lines = ['# AIWG local-only inputs: explicit command prefixes only; not filesystem isolation.'];
    for (const file of paths) for (const spelling of [file, `./${file}`, path.join(root, file)]) {
      for (const command of ['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'grep', 'rg']) {
        lines.push(`prefix_rule(pattern = ${JSON.stringify([command, spelling])}, decision = "forbidden")`);
      }
    }
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, lines.join('\n') + '\n');
  }
  console.log(`Conductor guard (${provider}): ${paths.join(', ')}${executionGuard ? '; worker execution checks enabled' : ''}; shell coverage is limited.`);
  return paths;
}
