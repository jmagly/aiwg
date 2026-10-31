// Select and project deployment rules and measure startup context.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import {
  addManagedMarker,
  contentHash,
  extractFrameworkSlug,
  getFrameworksForMode,
  listMdFiles,
  replaceBoundRulesBlock,
  resolveAiwgRoot,
  ruleEnforcementLevel,
} from './base.mjs';
import { resolveDeliveryRuleBindings } from './rule-binding-targets.mjs';
import { inlineStartup, nativePathLoader, ruleDirectory } from './rule-projection.mjs';

export const { parseRuleFrontmatter, inferRuleActivation, readCoreBody, validateCoreSet, formatRuleFrontmatterError } = await importImpl(import.meta.url, 'rules/activation.mjs');
export const { resolveDeployVersion } = await importImpl(import.meta.url, 'providers/deploy-version.mjs');
export const { trackTemporaryDirectory } = await importImpl(import.meta.url, 'utils/temporary-directory.js');
export const { loadRulePinConfigs, installedRuleCapabilities, resolveRulePins } = await importImpl(import.meta.url, 'rules/pins.mjs');
export const { guardRulesInlineBudget } = await importImpl(import.meta.url, 'rules/inline-budget.mjs');
export const { userConfigFile } = await importImpl(import.meta.url, 'config/user-config-dir.mjs');
export const { resolveProjectAiwgDir } = await importImpl(import.meta.url, 'config/project-artifacts-runtime.mjs');
export { renderRuleKernelIndex } from './rule-presentation.mjs';
export const PREPARATION_HOOK = Symbol.for('aiwg.provider-preparation-hook.v1');

export function installRuleDeploymentPreparationHook(hook) {
  if (!hook || typeof hook.scratch !== 'string' || !hook.inputPool || typeof hook.accept !== 'function' || globalThis[PREPARATION_HOOK]) {
    throw new Error('Invalid or already active rule deployment preparation hook');
  }
  globalThis[PREPARATION_HOOK] = hook;
  return () => { if (globalThis[PREPARATION_HOOK] === hook) delete globalThis[PREPARATION_HOOK]; };
}

export function isRuleDeploymentPreparationActive() {
  return Boolean(globalThis[PREPARATION_HOOK]);
}

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  });
}
// Keep only digests in the transaction snapshot. Artifact stores and binary skill
// resources can be much larger than the provider output being changed.
export function fileDigest(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
// Empty directories are part of workspace and skill-resource scaffolds too.
export function promoteDirectories(source, destination, skip = () => false, prefix = '') {
  const entries = fs.readdirSync(source, { withFileTypes: true });
  if (!entries.length && !fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory() && !skip(rel)) {
      promoteDirectories(path.join(source, entry.name), path.join(destination, entry.name), skip, rel);
    }
  }
}
export const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
export const structural = file => /^(RULES-INDEX|RULES-ONDEMAND)\.(md|mdc)$/.test(path.basename(file));
/** Collect selected source contracts, before any tier filter or projection. */
export function collectDeploymentRuleSources(opts) {
  if (opts.ruleSources) {
    // Pin-only callers enumerate rule files separately from behavior contracts.
    // Retain earlier behaviors only while their owning bundle is still selected.
    const selected = new Set(collectDeploymentRuleSources({ ...opts, ruleSources: undefined }));
    const behaviors = (opts.previousRuleSources || []).filter(file => path.basename(file) === 'BEHAVIOR.md' && selected.has(file));
    return [...new Set([...opts.ruleSources, ...behaviors])];
  }
  const corpus = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  const bundles = [];
  const frameworks = getFrameworksForMode(corpus, 'all');
  for (const kind of ['frameworks', 'addons', 'extensions', 'plugins']) {
    const dir = path.join(corpus, 'agentic', 'code', kind);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(dir, entry.name);
      const manifest = JSON.parse(read(path.join(root, 'manifest.json')) || '{}');
      bundles.push({ root, manifest, id: manifest.id || manifest.framework || entry.name,
        aliases: [entry.name, ...(manifest.modeAliases || []), ...(manifest.aliases || []),
          ...(kind === 'frameworks' ? frameworks.find(framework => framework.path === root)?.aliases || [] : [])] });
    }
  }
  const configs = opts.pinConfigs || loadRulePinConfigs(opts.target, opts.config);
  // Project installation is authoritative. User-wide discoverability is not a
  // project install, and a previous projection must never reselect retired rules.
  const installed = configs.project.installed || {};
  const names = Array.isArray(installed) ? installed : Object.keys(installed);
  const selected = new Set();
  const select = name => {
    const id = name.replace(/^(framework|addon|extension|plugin):/, '');
    const bundle = bundles.find(b => b.id === id || b.aliases.includes(id));
    if (!bundle || selected.has(bundle)) return;
    selected.add(bundle);
    const required = Array.isArray(bundle.manifest.dependencies) ? bundle.manifest.dependencies : bundle.manifest.dependencies?.required || [];
    for (const dep of Array.isArray(required) ? required : Object.keys(required)) select(dep);
  };
  for (const bundle of bundles.filter(b => b.manifest.core && b.manifest.autoInstall)) select(bundle.id);
  for (const name of names.filter(name => name !== 'all')) select(name);
  const invoked = bundles.find(bundle => path.resolve(bundle.root) === path.resolve(opts.srcRoot));
  if (invoked && !opts.kernelOnly) select(invoked.id);
  // Include the invocation being installed before its config entry is saved.
  if (!opts.kernelOnly) for (const framework of getFrameworksForMode(opts.srcRoot, opts.mode === 'all' && names.length ? 'general' : opts.mode)) select(framework.id);
  const roots = [...(!invoked || !opts.kernelOnly ? [opts.srcRoot] : []), ...(opts.additionalSources || []), ...[...selected].map(bundle => bundle.root)];
  for (const entry of Object.values(installed)) if (entry?.localPath) roots.push(path.resolve(opts.target, entry.localPath));
  const files = roots.flatMap(root => listMdFiles(path.join(root, 'rules'))).filter(file => !structural(file));
  const behaviors = roots.flatMap(root => walk(path.join(root, 'behaviors')).filter(file => path.basename(file) === 'BEHAVIOR.md'));
  return [...new Set([...files, ...behaviors])];
}

export async function prepareRuleDelivery(opts) {
  const rules = collectDeploymentRuleSources(opts).map(file => {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseRuleFrontmatter(content);
    if (!parsed.valid) throw new Error(formatRuleFrontmatterError(opts.logicalInputPath ? opts.logicalInputPath(file) : file, parsed.data, parsed.diagnostics));
    const behavior = path.basename(file) === 'BEHAVIOR.md';
    const rule = { ...parsed.rule, file, content, body: parsed.body, behavior,
      name: behavior ? `behavior/${path.basename(path.dirname(file))}` : parsed.data.name || path.basename(file, '.md') };
    if (!rule.tagged) rule.activation = inferRuleActivation();
    // Core rules (#3450) carry a compact body beside the full rule; the full text is never inlined.
    if (rule.activation === 'core') rule.coreBody = readCoreBody(file);
    for (const diagnostic of parsed.diagnostics) {
      console.warn(`${opts.logicalInputPath ? opts.logicalInputPath(file) : file}: ${diagnostic.code}: ${diagnostic.code === 'missing-activation' ? `Missing activation; inferred ${rule.activation} delivery (migration fallback); add explicit activation frontmatter.` : diagnostic.message}`);
    }
    return rule;
  });
  const coreErrors = validateCoreSet([...new Map(rules.filter(rule => rule.coreBody !== undefined).map(rule => [rule.name, { name: rule.name, text: rule.coreBody }])).values()]);
  if (coreErrors.length) throw new Error(coreErrors.join('; '));
  const configs = opts.pinConfigs || loadRulePinConfigs(opts.target, opts.config);
  const installed = installedRuleCapabilities(configs);
  const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  const { loadRelations, selectPrebuiltRelations } = await importImpl(import.meta.url, 'artifacts/relations.js');
  const packageRelations = selectPrebuiltRelations(root, opts.target).reader;
  const relations = packageRelations || loadRelations(opts.target) || loadRelations(root, opts.target);
  const ruleIdsByPath = new Map(Object.entries(relations?.index.rules || {}).map(([id, rule]) => [rule.path, id]));
  const pinRules = rules.map(rule => {
    const owner = rule.file.replaceAll('\\', '/').match(/(?:frameworks|addons|extensions|plugins)\/([^/]+)\//)?.[1];
    const local = Object.entries(configs.project.installed || {}).find(([, entry]) => entry.localPath && rule.file.startsWith(path.resolve(opts.target, entry.localPath) + path.sep))?.[0];
    const indexedPath = path.relative(root, rule.file);
    return { ...rule, id: ruleIdsByPath.get(indexedPath) || rule.file, path: rule.file, indexedPath,
      capability: local || owner || opts.capability, enforcement: ruleEnforcementLevel(rule.content) };
  });
  const pinned = resolveRulePins({ rules: pinRules, configs, installed, relations });
  for (const warning of pinned.warnings) console.warn(warning);
  const pinsByFile = new Map(pinned.rules.map(rule => [rule.file, rule]));
  for (const rule of rules) {
    const pin = pinsByFile.get(rule.file);
    // A core rule is already delivered in full; a pin must not re-promote it to a kernel body.
    if (!pin || rule.activation === 'core') continue;
    rule.canonicalActivation = rule.activation;
    rule.pinMatches = pin.matches;
    rule.pinned = true;
    rule.activation = 'kernel';
    // All pins use native kernel projection, including legacy untagged rules.
    rule.tagged = true;
  }
  const { bindings, targets } = await resolveDeliveryRuleBindings(opts, rules, configs, root, packageRelations);
  return { rules, bindings, targets, pins: pinned.rules, pinWarnings: pinned.warnings };
}

export const managed = (content, opts) => addManagedMarker(content, opts.deployVersion, opts.deploySource || 'bundled');
export function put(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

/** External helpers also project skills/flows. Inject into their body, never descriptions. */
export function finishBindings(opts, provider) {
  const putOwned = (file, content) => { put(file, content); opts.writtenFiles?.push(file); };
  const corpus = opts.srcRoot && (resolveAiwgRoot(opts.srcRoot) || opts.srcRoot);
  const frameworks = corpus ? getFrameworksForMode(corpus, 'all') : [];
  const knownFrameworks = new Set(frameworks.map(framework => framework.id));
  const installed = Object.keys(opts.config?.installed || opts.pinConfigs?.project?.installed || {});
  const invoked = opts.srcRoot ? getFrameworksForMode(opts.srcRoot,
    opts.mode === 'all' && installed.length ? 'general' : opts.mode) : [];
  const selectedFrameworks = new Set([
    ...invoked,
    ...installed.filter(name => name !== 'all').flatMap(name => corpus ? getFrameworksForMode(corpus, name) : []),
    ...frameworks.filter(framework => [opts.srcRoot, ...(opts.additionalSources || [])].filter(Boolean)
      .some(source => path.resolve(framework.path) === path.resolve(source)) || (framework.manifest.core && framework.manifest.autoInstall)),
  ].map(framework => framework.id));
  // Selected dependency rules also identify frameworks reached through addons.
  for (const rule of opts.ruleDelivery.rules || []) {
    const owner = rule.file && extractFrameworkSlug(rule.file);
    if (knownFrameworks.has(owner)) selectedFrameworks.add(owner);
  }
  const roots = [opts.target, opts.deploymentHome,
    ...[opts.kernelSkillsPath, opts.activeWorkspace, ...Object.values(provider.paths)].filter(p => p && path.isAbsolute(p))];
  const files = [...new Set(roots.flatMap(walk))];
  const indexRel = provider.name === 'copilot' ? '.github/RULES-BOUND.md' : provider.name === 'flue' ? '.agents/.aiwg/RULES-BOUND.md' : `.${provider.name}/RULES-BOUND.md`;
  const indexFile = path.join(opts.target, indexRel);
  const anchor = target => `${target.type}-${target.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const sections = new Map();
  const targetsBySource = new Map();
  for (const target of opts.ruleDelivery.targets) {
    targetsBySource.set(target.source, [...(targetsBySource.get(target.source) || []), target]);
  }
  for (const file of files.filter(file => /\.(md|toml)$/.test(file))) {
    if (path.basename(file) !== 'SKILL.md' && !/(?:[/\\](?:skills?|agents?|droids|commands?|prompts|modes?)[/\\])/.test(file)) continue;
    if (/[/\\]rules[/\\]/.test(file) || /[/\\]\.aiwg[/\\](?!skills[/\\])/.test(file.replace(opts.target, ''))) continue;
    let content = read(file);
    if (!/aiwg:managed/.test(content) && !fs.existsSync(path.join(path.dirname(file), '.aiwg-managed')) && !fs.existsSync(path.join(path.dirname(file), '.aiwg-manifest.json'))) continue;
    const skill = path.basename(file) === 'SKILL.md';
    const name = skill ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.(md|toml)$/, '');
    const sidecarPath = path.join(skill ? path.dirname(file) : path.dirname(file), '.aiwg-manifest.json');
    const sidecar = fs.existsSync(sidecarPath) ? JSON.parse(read(sidecarPath)) : null;
    // Wrapper source identity is ownership metadata. Preserve the legacy
    // flow-only name lookup instead of selecting new skill binding targets.
    const wrapper = !skill && sidecar?.managed?.[path.basename(file)]?.kind === 'skill-command';
    const wrapperOwner = sidecar?.managed?.[path.basename(file)]?.frameworkSlug
      || extractFrameworkSlug(sidecar?.managed?.[path.basename(file)]?.sourcePath || '');
    // Shared command surfaces can contain a framework's late wrappers before
    // that framework is selected. Do not activate its bindings on redeploy.
    if (wrapper && knownFrameworks.has(wrapperOwner) && !selectedFrameworks.has(wrapperOwner)) continue;
    const source = wrapper ? undefined : sidecar?.skillSource ? path.join(sidecar.skillSource, 'SKILL.md') : sidecar?.managed?.[path.basename(file)]?.sourcePath;
    const flowSource = opts.flowSkillSources?.get(file);
    const targets = [...(flowSource ? targetsBySource.get(flowSource) || [] : []),
      ...(source ? targetsBySource.get(path.resolve(source)) || [] : opts.ruleDelivery.targets.filter(target =>
        (skill ? target.type !== 'agent' : /[/\\](?:agents?|droids|modes?)[/\\]/.test(file) ? target.type === 'agent' : target.type === 'flow') &&
        [target.name, path.basename(target.source, '.md'), path.basename(path.dirname(target.source))].includes(name)))];
    const rules = targets.flatMap(target => opts.ruleDelivery.bindings.get(target.source) || []);
    if (!rules.length && !content.includes('<!-- AIWG:bound-rules:start -->')) continue;
    const pointer = body => {
      const clean = replaceBoundRulesBlock(body, []);
      if (!rules.length) return clean;
      const identities = [...new Map(targets.map(target => [`${target.type} ${target.name}`, target])).values()];
      for (const target of identities) {
        const bound = opts.ruleDelivery.bindings.get(target.source) || [];
        const unique = [...new Map(bound.map(rule => [rule.name, rule])).values()].sort((a, b) => a.name.localeCompare(b.name));
        if (unique.length) sections.set(anchor(target), `## ${anchor(target)}\n\n` + unique.map(rule =>
          `- ${rule.name} — ${rule.summary} Fetch and follow: \`aiwg show rule ${rule.name} --body\`.`).join('\n'));
      }
      // Skills must carry exact fetch commands themselves: a section pointer
      // alone loses the invocation contract in clean installs (#3473).
      const fetch = skill ? [...new Map(rules.map(rule => [rule.name, rule])).values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(rule => `${rule.summary}\nFetch and follow before governed work: \`aiwg show rule ${rule.name} --body\`.`).join('\n') : '';
      return `${clean}${clean.endsWith('\n') ? '' : '\n'}\n<!-- AIWG:bound-rules:start -->\nRead and follow before governed work: ${identities.map(target =>
        `\`${indexRel}#${anchor(target)}\``).join('; ')}.\n${fetch ? fetch + '\n' : ''}<!-- AIWG:bound-rules:end -->\n`;
    };
    if (file.endsWith('.toml')) content = content.replace(/^developer_instructions = (".*")$/m, (_, value) => `developer_instructions = ${JSON.stringify(pointer(JSON.parse(value)))}`);
    else content = pointer(content);
    putOwned(file, content);
    // Keep deployment hashes honest after projection by external helpers.
    if (sidecar?.managed?.[path.basename(file)]) {
      sidecar.managed[path.basename(file)].hash = `sha256:${contentHash(content)}`;
      putOwned(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    }
  }
  if (sections.size) putOwned(indexFile, managed('# Bound rules\n\nFetch and follow every full rule in the invoked artifact’s section before governed work.\n\n' +
    [...sections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, section]) => section).join('\n\n') + '\n', opts));
  else if (/aiwg:managed/.test(read(indexFile))) fs.rmSync(indexFile);

}

/** Bindings annotate the selected deployment; they do not select standard skills
 * (ADR lines 102–108). Flow projections follow the same opt-in and tier routing. */
export function projectBoundFlowSkills(opts, provider, selected) {
  if (provider.name === 'flue') return; // This app target deploys kernel skills only (#3121).
  opts.flowSkillSources = new Map();
  if (opts.rulesOnly || opts.commandsOnly || !(opts.deploySkills || opts.skillsOnly)) return;
  const kernel = path.isAbsolute(provider.kernelSkillsPath || '') ? opts.kernelSkillsPath
    : path.join(opts.target, provider.kernelSkillsPath || `.${provider.name}/skills`);
  // Codex's opt-in standard tier shares the native skills directory.
  const standard = provider.name === 'codex' ? kernel : path.isAbsolute(provider.paths.skills)
    ? provider.paths.skills : path.join(opts.target, provider.paths.skills);
  const flows = opts.ruleDelivery.targets.filter(entry => entry.type === 'flow' && selected(entry));
  const sources = new Set(flows.map(entry => entry.source));
  for (const root of new Set([kernel, standard])) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, 'SKILL.md');
      const content = read(file);
      const receiptFile = path.join(dir, '.aiwg-manifest.json');
      const receipt = fs.existsSync(receiptFile) ? JSON.parse(read(receiptFile)) : null;
      // Recognize the old projector's exact generated wrapper as well as new
      // receipts. Ordinary deployed skills and operator files are preserved.
      const legacy = !receipt?.skillSource && !receipt?.flowSource && /aiwg:managed/.test(content)
        && content.includes(`description: Invoke ${entry.name}.\n`)
        && content.includes('```yaml\n') && content.includes('<!-- AIWG:bound-rules:start -->');
      const stale = receipt?.flowSource && (opts.copyStandardSkills !== true
        || !sources.has(receipt.flowSource) || root !== standard);
      if (!legacy && !stale) continue;
      fs.rmSync(file, { force: true });
      if (receipt?.flowSource) {
        fs.rmSync(receiptFile, { force: true });
        fs.rmSync(path.join(dir, '.aiwg-managed'), { force: true });
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    }
  }
  if (opts.copyStandardSkills !== true) return;
  for (const entry of flows) {
    const name = entry.name || path.basename(entry.source).replace(/\.(md|ya?ml)$/, '');
    const dir = path.join(standard, name);
    const file = path.join(dir, 'SKILL.md');
    const receiptFile = path.join(dir, '.aiwg-manifest.json');
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(read(receiptFile)) : null;
    // A selected authored skill may already represent this flow. Keep its body;
    // finishBindings adds both artifact identities' contracts after projection.
    if (!fs.existsSync(file) || receipt?.flowSource === entry.source) {
      const body = read(entry.source);
      const markdown = entry.source.endsWith('.md') ? body : `---\nname: ${name}\nnamespace: aiwg\ndescription: Invoke ${name}.\n---\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
      const projected = provider.transformSkillMd ? provider.transformSkillMd(markdown, opts) : markdown;
      const content = managed(replaceBoundRulesBlock(projected, opts.ruleDelivery.bindings.get(entry.source)), opts);
      put(file, content);
      put(path.join(dir, '.aiwg-managed'), 'true\n');
      put(receiptFile, `${JSON.stringify({ flowSource: entry.source,
        managed: { 'SKILL.md': { sourcePath: entry.source, hash: `sha256:${contentHash(content)}` } } }, null, 2)}\n`);
    }
    opts.flowSkillSources.set(file, entry.source);
    if (['warp', 'hermes'].includes(provider.name)) opts.definitionRoutes.push(`${name}: ${file}`);
  }
}

/** Count rule sections, excluding aggregated agent/command definitions and project prose. */
export function warpRuleContent(content) {
  const blocks = [...content.matchAll(/<!-- AIWG:(rule-(?:startup|core|hook-[\w-]+)):start -->[\s\S]*?<!-- AIWG:\1:end -->/g)].map(match => match[0]);
  // Remove managed blocks first so their internal headings cannot be counted twice.
  const remaining = content.replace(/<!-- AIWG:(rule-(?:startup|core|hook-[\w-]+)):start -->[\s\S]*?<!-- AIWG:\1:end -->/g, '');
  const sections = [...remaining.matchAll(/^## (?:AIWG Rules|On-Demand Rules)\r?\n[\s\S]*?(?=^## |(?![\s\S]))/gm)].map(match => match[0]);
  return [...sections, ...blocks].join('\n');
}

export function startupFiles(opts, provider) {
  const bridgeNames = { claude: ['CLAUDE.md'], cursor: ['AGENTS.md'], codex: ['AGENTS.md'], hermes: ['AGENTS.md', '.hermes.md'], pi: ['AGENTS.md'], warp: ['WARP.md'], openclaw: [] };
  const paths = ['AIWG.md', 'WORKSPACE.md', ...(bridgeNames[provider.name] || ['AGENTS.md']), inlineStartup[provider.name]].filter(Boolean).map(name => path.join(opts.target, name));
  if (opts.activeWorkspace) paths.push(path.join(opts.activeWorkspace, 'AGENTS.md'));
  {
    // Hook-reached files count too: moving a body must not hide its budget cost.
    const dir = ruleDirectory(opts, provider);
    paths.push(...walk(dir).filter(file => /\.(md|mdc)$/.test(file)));
  }
  return [...new Set(paths)].filter(file => fs.existsSync(file)).map(file => {
    let content = read(file);
    if (nativePathLoader(provider.name)) {
      const parsed = parseRuleFrontmatter(content);
      if (parsed.data?.paths || parsed.data?.globs) content = content.slice(0, content.length - parsed.body.length);
    }
    // Count managed rule sections while preserving historical accounting for
    // operator aggregates; discrete hook-reached rule files are counted above.
    if ((provider.name === 'warp' && path.basename(file) === 'WARP.md')
      || (provider.name === 'windsurf' && file === path.join(opts.target, 'AGENTS.md'))) content = warpRuleContent(content);
    return { path: file, content };
  });
}
