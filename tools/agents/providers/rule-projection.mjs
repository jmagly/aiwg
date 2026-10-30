/** Project activation-selected contracts into each harness's rules surface. */
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { importImpl } from '../../_resolve-impl.mjs';
import { addManagedMarker, contentHash, stripTriggersFromContent } from './base.mjs';
import { projectOnDemandReferences, renderRuleKernelIndex } from './rule-presentation.mjs';
import { projectStartup } from './rule-startup.mjs';
import { writeContextFileSync } from './context-write.mjs';
export { inlineStartup } from './rule-startup.mjs';
const { parseRuleFrontmatter } = await importImpl(import.meta.url, 'rules/activation.mjs');
const { renderCoreStartup } = await importImpl(import.meta.url, 'rules/core-startup.mjs');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
export const nativeRuleLoader = name => ['claude', 'cursor', 'grok-build', 'windsurf', 'opencode'].includes(name);
export const nativePathLoader = name => ['claude', 'cursor', 'windsurf'].includes(name);
export function ruleDirectory(opts, provider) {
  // Muse has no declared rules path; use its existing .muse harness convention.
  const dir = provider.paths.rules || (provider.name === 'grok-build' ? '.grok/rules' : `.${provider.name}/rules`);
  return path.isAbsolute(dir) ? dir : path.join(opts.target, dir);
}
const ruleName = (rule, provider) => rule.behavior
  ? `${['grok-build', 'windsurf'].includes(provider.name) ? 'behavior-' : 'behaviors/'}${path.basename(path.dirname(rule.file))}`
  : path.basename(rule.file, '.md');
function nativeContent(provider, rule, content, opts) {
  if (provider.name === 'cursor') return provider.transformRule(rule.file, content, opts);
  if (provider.name === 'windsurf') {
    const parsed = parseRuleFrontmatter(content);
    const data = { ...parsed.data, trigger: rule.activation === 'paths' ? 'glob' : 'always_on' };
    if (rule.activation === 'paths') data.glob = rule.paths.join(',');
    return `---\n${stringify(data)}---\n${parsed.body}`;
  }
  return content;
}
function registerOpenCode(opts, provider, rulesDir) {
  if (provider.name !== 'opencode') return;
  const file = path.join(opts.target, 'opencode.json');
  const config = JSON.parse(read(file) || '{}');
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
    (config.instructions !== undefined && !Array.isArray(config.instructions))) {
    throw new Error('OpenCode rule delivery requires an object with an instructions array in opencode.json');
  }
  const glob = `${path.relative(opts.target, rulesDir).replaceAll('\\', '/')}/*.md`;
  config.instructions = [...new Set([...(config.instructions || []), 'AGENTS.md', 'AIWG.md', glob])];
  writeContextFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
export function projectRules(opts, provider) {
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); opts.writtenFiles?.push(file);
  };
  const nativePaths = nativePathLoader(provider.name);
  const rules = projectOnDemandReferences(opts.ruleDelivery.rules, nativePaths);
  const rulesDir = ruleDirectory(opts, provider);
  const tagged = rules.filter(rule => rule.tagged);
  const extension = provider.name === 'cursor' ? '.mdc' : '.md';
  const managed = content => addManagedMarker(content, opts.deployVersion, opts.deploySource || 'bundled');
  const writeRule = (rule, content) => put(path.join(rulesDir, `${ruleName(rule, provider)}${extension}`), managed(content));
  for (const file of walk(rulesDir)) {
    if (/\.(md|mdc)$/.test(file) && /aiwg:managed/.test(read(file))) fs.rmSync(file);
  }
  const cores = [...new Map(tagged.filter(rule => rule.activation === 'core').map(rule => [rule.name, rule])).values()];
  if (['claude', 'cursor'].includes(provider.name)) {
    for (const rule of cores) {
      const dest = path.join(rulesDir, `core-${path.basename(rule.file, '.md')}${extension}`);
      if (fs.existsSync(dest) && !/aiwg:managed/.test(read(dest)) && !opts.force) {
        console.warn(`Unmanaged core rule left in place: ${dest}. Re-run with --force to replace it.`);
        continue;
      }
      put(dest, managed(provider.name === 'cursor' ? `---\nalwaysApply: true\n---\n${rule.coreBody}\n` : `${rule.coreBody}\n`));
    }
  }
  for (const rule of tagged) {
    if (rule.activation !== 'kernel' && !(nativePaths && rule.activation === 'paths')) continue;
    let content = stripTriggersFromContent(rule.content);
    if (rule.pinned) {
      const parsed = parseRuleFrontmatter(content);
      const data = { ...parsed.data, activation: 'kernel' };
      delete data.paths; delete data.bound_to;
      content = `---\n${stringify(data)}---\n${parsed.body}`;
    }
    writeRule(rule, nativeContent(provider, rule, content, opts));
  }
  for (const rule of rules.filter(rule => !rule.tagged && !rule.behavior)) {
    const source = opts.logicalInputPath ? opts.logicalInputPath(rule.file) : rule.file;
    if (/(?:^|\/)agentic\/code\//.test(source.replaceAll('\\', '/'))) continue;
    writeRule(rule, nativeContent(provider, rule, stripTriggersFromContent(rule.content), opts));
  }
  const routes = [...new Set(opts.definitionRoutes || [])];
  const routing = routes.length ? `## Invoked artifact definitions\n\nRead the complete definition before invoking its artifact:\n${routes.map(route => `- ${route}`).join('\n')}` : '';
  const localKernels = !nativeRuleLoader(provider.name);
  const index = [renderRuleKernelIndex(rules, nativePaths, true, localKernels ? rule => `${ruleName(rule, provider)}${extension}` : undefined), routing].filter(Boolean).join('\n\n');
  const indexFile = path.join(rulesDir, `RULES-INDEX${extension}`);
  if (index) put(indexFile, managed(nativeContent(provider, { activation: 'kernel', file: indexFile }, index, opts)));
  const legacyDemand = rules.filter(rule => !rule.tagged && !rule.behavior && rule.activation === 'on-demand');
  if (legacyDemand.length) put(path.join(rulesDir, `RULES-ONDEMAND${extension}`), managed([
    '# On-demand rules', '', 'These rules require explicit activation metadata. Fetch the applicable full rule before governed work.', '',
    ...legacyDemand.map(rule => `- \`${rule.name}\` — \`aiwg show rule ${rule.name} --body\``), '',
  ].join('\n')));
  const coreSection = renderCoreStartup(cores);
  // Even an all-core install needs a real entry point rather than a dangling hook.
  if (!index && (!['claude', 'cursor'].includes(provider.name) || tagged.length)) put(indexFile, managed(nativeContent(provider, { activation: 'kernel', file: indexFile }, '# Rule kernel index\n\nNo kernel or path rules selected.\n', opts)));
  const startups = projectStartup(opts, provider, coreSection, indexFile);
  registerOpenCode(opts, provider, rulesDir);
  fs.rmSync(path.join(rulesDir, '.aiwg-rules-budget.json'), { force: true });
  const manifestPath = path.join(rulesDir, '.aiwg-manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(read(manifestPath)) : { managed: {} };
  manifest.ruleSources = rules.map(rule => rule.file);
  const logical = opts.logicalOutputPath || (file => file);
  const relative = file => path.relative(logical(opts.target), logical(file)).replaceAll('\\', '/');
  manifest.delivery = { projectFromRules: path.relative(logical(rulesDir), logical(opts.target)),
    rules: relative(rulesDir), entryPoint: relative(indexFile), startupFiles: startups.map(relative),
    loader: nativeRuleLoader(provider.name) ? 'native' : 'prose-hook' };
  manifest.managed ||= {};
  for (const file of walk(rulesDir).filter(file => /\.(md|mdc)$/.test(file) && /aiwg:managed/.test(read(file)))) {
    const name = path.relative(rulesDir, file);
    manifest.managed[name] = { ...manifest.managed[name], hash: `sha256:${contentHash(read(file))}` };
  }
  for (const name of Object.keys(manifest.managed)) if (!fs.existsSync(path.join(rulesDir, name))) delete manifest.managed[name];
  put(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
