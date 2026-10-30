// Prepare provider deployment against immutable staged inputs.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import {
  deployEmulatedBehaviors,
  discoverAddons,
  filterAgentFiles,
  getFrameworksForMode,
  replaceBoundRulesBlock,
  resolveAiwgRoot,
} from './base.mjs';
import { writeContextFileSync, CONTEXT_STAGE_ENV, GENERATED_CONTEXT_NAMES, OPERATOR_CONTEXT_NAMES } from './context-write.mjs';
import { captureProviderPathDescriptors, logicalProviderOutputPath, restoreProviderPaths, setStagedProviderPath } from './provider-paths-staging.mjs';
import {
  collectDeploymentRuleSources,
  fileDigest,
  finishBindings,
  guardRulesInlineBudget,
  managed,
  prepareRuleDelivery,
  projectBoundFlowSkills,
  put,
  read,
  resolveDeployVersion,
  resolveProjectAiwgDir,
  startupFiles,
  trackTemporaryDirectory,
  userConfigFile,
  walk,
} from './rule-delivery-surface.mjs';
import { deploySelectedSurface } from './rule-deployment-commit.mjs';
import {
  captureAnchors,
  capturePreimage,
  inputPools,
  materializedPreimage,
  materializeInput,
  planSeal,
  releaseInputPool,
  snapshotPreimages,
  stagedCleanups,
  verifyInputPool,
} from './rule-deployment-state.mjs';
import { inlineStartup, projectRules } from './rule-projection.mjs';
const { captureDeploymentOutputs, recordDeploymentOutputs } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
import { retireInlineStartup } from './rule-startup.mjs';

/** Stage only provider/context output, never the user's source tree. On failure
 * no staged output (including skills and behaviors) reaches the prior deployment. */
export async function prepareRuleDeployment(original, provider, deploy) {
  const budgetEnv = { ...process.env };
  const ruleDir = path.isAbsolute(provider.paths.rules || '') ? provider.paths.rules : path.join(original.target, provider.paths.rules || `.${provider.name}/rules`);
  const manifestFile = path.join(ruleDir, '.aiwg-manifest.json');
  const previousText = fs.existsSync(manifestFile) ? read(manifestFile) : '';
  const previous = previousText ? JSON.parse(previousText) : {};
  const corpusRoot = resolveAiwgRoot(original.srcRoot) || original.srcRoot;
  if (!original.deployVersion || /unknown/i.test(original.deployVersion)) {
    original = { ...original, deployVersion: resolveDeployVersion(corpusRoot, original.deployVersion) };
  }
  const sourceTree = fs.existsSync(path.join(corpusRoot, 'agentic', 'code'))
    ? path.join(corpusRoot, 'agentic', 'code') : original.srcRoot;
  const pool = original.inputPool && inputPools.get(original.inputPool);
  if (original.inputPool && (!pool || pool.closed || pool.corpusRoot !== path.resolve(corpusRoot) || pool.sourceTree !== path.resolve(sourceTree))) throw new Error('Invalid or closed rule deployment input pool');
  if (pool) verifyInputPool(pool);
  let projectConfig = original.config;
  if (!projectConfig) {
    try { projectConfig = JSON.parse(read(path.join(original.target, '.aiwg', 'aiwg.config')) || '{}'); } catch { projectConfig = {}; }
  }
  const artifactRoot = resolveProjectAiwgDir(original.target);
  const userIndexRoot = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aiwg', 'index');
  const projectGraphFiles = ['.index/metadata.json', '.index/project/metadata.json'].map(name => path.join(artifactRoot, name));
  const userGraphFiles = ['user'].map(name => path.join(userIndexRoot, name, 'metadata.json'));
  const localSources = Object.values(projectConfig.installed || {}).filter(entry => entry?.localPath)
    .map(entry => path.resolve(original.target, entry.localPath));
  const selectedRules = collectDeploymentRuleSources({ ...original, previousRuleSources: previous.ruleSources || [] });
  const initialPreimages = [...(pool ? pool.preimages : snapshotPreimages([sourceTree, path.join(corpusRoot, 'prebuilt', 'framework-relations'), path.join(corpusRoot, 'package.json'), path.join(corpusRoot, 'schemas')])), ...snapshotPreimages([path.join(corpusRoot, '.aiwg', '.index'),
    manifestFile, path.join(original.target, '.aiwg', 'aiwg.config'), path.join(original.target, '.aiwg', 'AIWG.md'), path.join(original.target, '.aiwg', 'skills'), path.join(original.target, '.aiwg-location'), ...projectGraphFiles, ...userGraphFiles, ...localSources,
    ...(path.resolve(original.srcRoot) === path.resolve(corpusRoot) ? [] : [original.srcRoot]), ...(original.additionalSources || []), ...selectedRules, ...selectedRules.map(file => path.dirname(file)),
    userConfigFile('aiwg.config'), process.env.AIWG_USER_REGISTRY_PATH || userConfigFile('installed.json'),
    ...(original.ruleSources || []), ...(previous.ruleSources || []), ...(original.bindingEntries || []).map(entry => entry.path)])];
  let manifestState = initialPreimages.find(item => item.path === path.resolve(manifestFile)).state;
  if (manifestState.kind === 'symlink') manifestState = manifestState.resolved;
  const manifestDigest = previousText ? createHash('sha256').update(previousText).digest('hex') : null;
  if ((manifestState.kind === 'missing' ? null : manifestState.digest) !== manifestDigest) throw new Error('Rule manifest changed while preparing snapshot');
  const transferable = Boolean(original.ruleDeploymentScratch);
  const temp = transferable ? path.resolve(original.ruleDeploymentScratch) : fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-deploy-'));
  if (transferable) {
    const stat = fs.lstatSync(temp);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(temp).length) throw new Error('Invalid rule deployment scratch directory');
  }
  const removeStage = transferable
    ? () => fs.rmSync(temp, { recursive: true, force: true })
    : trackTemporaryDirectory(temp);
  if (pool) pool.refs++;
  const removeTemp = () => { removeStage(); if (pool) releaseInputPool(pool); };
  const lease = randomUUID();
  stagedCleanups.set(lease, { temp, cleanup: removeTemp, detach: () => { if (pool) releaseInputPool(pool); }, pool, seal: null, transferable });
  const priorContextStage = process.env[CONTEXT_STAGE_ENV];
  const contextStageLog = path.join(temp, 'context-writes.jsonl');
  fs.writeFileSync(contextStageLog, '');
  process.env[CONTEXT_STAGE_ENV] = contextStageLog;
  const mappings = [];
  const preimages = [...initialPreimages];
  let retained = false;
  const originals = captureProviderPathDescriptors(provider);
  const logicalTarget = original.target;
  const priorAiwgRoot = process.env.AIWG_ROOT;
  const priorRegistry = process.env.AIWG_USER_REGISTRY_PATH;
  const priorArtifacts = process.env.AIWG_ARTIFACTS_PATH;
  const priorXdgData = process.env.XDG_DATA_HOME;
  try {
    const snapshotRoot = pool ? pool.snapshotRoot : path.join(temp, 'input');
    const treeRelative = path.relative(corpusRoot, sourceTree);
    const isCorpusTree = treeRelative === path.join('agentic', 'code');
    const snapshotTree = isCorpusTree ? path.join(snapshotRoot, 'agentic', 'code') : snapshotRoot;
    if (!pool) { fs.mkdirSync(path.dirname(snapshotTree), { recursive: true }); materializeInput(sourceTree, snapshotTree); }
    const expectedTree = initialPreimages.find(item => item.path === path.resolve(sourceTree));
    if (!pool && JSON.stringify(capturePreimage(snapshotTree)) !== JSON.stringify(materializedPreimage(expectedTree.state))) throw new Error('Source changed while preparing immutable snapshot');
    if (isCorpusTree && !pool) {
      for (const rel of ['package.json', 'prebuilt', 'schemas']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) materializeInput(from, to);
        const expected = initialPreimages.find(item => item.path === path.resolve(from));
        if (expected && JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Package input changed while preparing snapshot: ${from}`);
      }
      // The projector helpers execute installed code but receive the snapshot as data.
      for (const rel of ['tools', 'dist', 'node_modules', 'src']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) fs.symlinkSync(from, to, 'dir');
      }
    }
    // Keep standalone fixture/bundle snapshots from inheriting the installed
    // package's unrelated prebuilt relations through module-root fallback.
    process.env.AIWG_ROOT = snapshotRoot;
    const frozenConfigDir = path.join(temp, 'config');
    fs.mkdirSync(frozenConfigDir);
    const frozenFile = (from, name, expected) => {
      const to = path.join(frozenConfigDir, name);
      if (fs.existsSync(from)) { fs.copyFileSync(from, to); fs.chmodSync(to, fs.statSync(from).mode & 0o7777); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`Configuration changed while preparing snapshot: ${from}`);
      return to;
    };
    const projectFile = path.join(logicalTarget, '.aiwg', 'aiwg.config');
    const projectFileState = initialPreimages.find(item => item.path === path.resolve(projectFile))?.state;
    const userFile = userConfigFile('aiwg.config');
    const registryFile = priorRegistry || userConfigFile('installed.json');
    const projectSnapshot = frozenFile(projectFile, 'project.json', projectFileState);
    const userSnapshot = frozenFile(userFile, 'user.json', initialPreimages.find(item => item.path === path.resolve(userFile))?.state);
    const registrySnapshot = frozenFile(registryFile, 'registry.json', initialPreimages.find(item => item.path === path.resolve(registryFile))?.state);
    const readConfig = file => fs.existsSync(file) ? JSON.parse(read(file)) : {};
    const effectiveConfig = structuredClone(original.config || readConfig(projectSnapshot));
    const pinConfigs = structuredClone(original.pinConfigs || { project: effectiveConfig, user: readConfig(userSnapshot) });
    const frozenLocal = Object.values(pinConfigs.project.installed || {}).filter(entry => entry?.localPath)
      .map(entry => path.resolve(logicalTarget, entry.localPath));
    if (JSON.stringify([...new Set(frozenLocal)].sort()) !== JSON.stringify([...new Set(localSources)].sort())) throw new Error('Project-local configuration changed while preparing snapshot');
    const sourceMappings = [{ from: path.resolve(sourceTree), to: snapshotTree }];
    for (const [index, from] of [...new Set(localSources)].entries()) {
      const to = path.join(temp, 'local-input', String(index));
      const expected = initialPreimages.find(item => item.path === from)?.state;
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); materializeInput(from, to); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`Project-local input changed while preparing snapshot: ${from}`);
      sourceMappings.push({ from, to });
    }
    const externalInputs = [...new Set([...(path.resolve(original.srcRoot) === path.resolve(corpusRoot) ? [] : [original.srcRoot]), ...(original.additionalSources || []), ...(original.ruleSources || []), ...(previous.ruleSources || []),
      ...(original.bindingEntries || []).map(entry => entry.path)].map(file => path.resolve(file)))];
    for (const [index, from] of externalInputs.entries()) {
      if (sourceMappings.some(item => from === item.from || from.startsWith(`${item.from}${path.sep}`))) continue;
      const to = path.join(temp, 'external-input', String(index), path.basename(from));
      const expected = initialPreimages.find(item => item.path === from)?.state;
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); materializeInput(from, to); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`External input changed while preparing snapshot: ${from}`);
      sourceMappings.push({ from, to });
    }
    for (const entry of Object.values(pinConfigs.project.installed || {})) {
      if (!entry?.localPath) continue;
      const from = path.resolve(logicalTarget, entry.localPath);
      entry.localPath = sourceMappings.find(mapping => mapping.from === from).to;
    }
    process.env.AIWG_USER_REGISTRY_PATH = registrySnapshot;
    let stagedProjectRoot;
    const mapSource = file => {
      let absolute = path.resolve(file);
      if (stagedProjectRoot && absolute.startsWith(`${stagedProjectRoot}${path.sep}`)) {
        const logical = path.join(logicalTarget, path.relative(stagedProjectRoot, absolute));
        if (sourceMappings.some(item => logical === item.from || logical.startsWith(`${item.from}${path.sep}`)) || !fs.existsSync(absolute)) absolute = logical;
      }
      const mapping = [...sourceMappings].sort((a, b) => b.from.length - a.from.length)
        .find(item => absolute === item.from || absolute.startsWith(`${item.from}${path.sep}`));
      if (mapping) return path.join(mapping.to, path.relative(mapping.from, absolute));
      if (isCorpusTree && absolute === path.resolve(corpusRoot)) return snapshotRoot;
      return file;
    };
    const logicalInputPath = file => {
      let result = file;
      for (const mapping of [...sourceMappings].sort((a, b) => b.to.length - a.to.length)) result = result.split(mapping.to).join(mapping.from);
      return result.split(snapshotRoot).join(corpusRoot);
    };
    original = { ...original, config: effectiveConfig, srcRoot: mapSource(original.srcRoot), pinConfigs, mapInputPath: mapSource, logicalInputPath,
      ...(original.additionalSources ? { additionalSources: original.additionalSources.map(mapSource) } : {}),
      ...(original.ruleSources ? { ruleSources: original.ruleSources.map(mapSource) } : {}),
      ...(original.bindingEntries ? { bindingEntries: original.bindingEntries.map(entry => ({ ...entry, path: mapSource(entry.path) })) } : {}) };
    const target = path.resolve(original.target);
    const stage = path.join(temp, 'project');
    stagedProjectRoot = stage;
    fs.mkdirSync(stage);
    const mount = (from, to) => {
      if (mappings.some(mapping => mapping.from === from)) return;
      const mountPreimage = snapshotPreimages([from])[0];
      preimages.push(mountPreimage);
      if (fs.existsSync(from)) materializeInput(from, to);
      const before = new Map(walk(to).map(file => [path.relative(to, file), fileDigest(file)]));
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(mountPreimage.state))) throw new Error(`Deployment input changed while preparing snapshot: ${from}`);
      mappings.push({ from, to, before });
    };
    // Mount directories independently so only provider-owned surfaces are promoted.
    const relativeRoots = Object.values(provider.paths).filter(dir => dir && !path.isAbsolute(dir))
      .map(dir => dir.split(/[\\/]/)[0]).filter(dir => dir && dir !== '.' && !path.extname(dir));
    for (const dir of new Set([`.${provider.name}`, '.agents', '.aiwg/skills', ...relativeRoots])) mount(path.join(target, dir), path.join(stage, dir));
    fs.mkdirSync(path.join(stage, '.aiwg'), { recursive: true });
    if (fs.existsSync(projectSnapshot)) materializeInput(projectSnapshot, path.join(stage, '.aiwg', 'aiwg.config'));
    const rootNames = ['opencode.json', ...GENERATED_CONTEXT_NAMES, ...OPERATOR_CONTEXT_NAMES, '.aiwg/frameworks/registry.json'];
    if (provider.name === 'windsurf') rootNames.push('.windsurfrules');
    for (const framework of getFrameworksForMode(original.srcRoot, original.mode)) {
      for (const entry of framework.manifest?.memory?.creates || []) {
        if (typeof entry?.path !== 'string' || !entry.path.startsWith('.aiwg/') || !path.extname(entry.path)) continue;
        const safe = path.normalize(entry.path);
        if (!safe.startsWith(`.aiwg${path.sep}`)) throw new Error(`Invalid framework workspace path: ${entry.path}`);
        if (!rootNames.includes(safe)) rootNames.push(safe);
      }
    }
    for (const name of [...rootNames]) {
      const sidecar = path.join(path.dirname(name) === '.' ? '.aiwg' : path.dirname(name), '.aiwg-manifest.json');
      if (!rootNames.includes(sidecar)) rootNames.push(sidecar);
    }
    preimages.push(...snapshotPreimages(rootNames.map(name => path.join(target, name))));
    for (const name of rootNames) {
      const from = path.join(target, name), to = path.join(stage, name);
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); fs.chmodSync(to, fs.statSync(from).mode & 0o7777); }
      const expected = preimages.find(item => item.path === path.resolve(from));
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Deployment input changed while preparing snapshot: ${from}`);
    }
    const home = path.join(temp, 'home');
    for (const [key, dir] of Object.entries(provider.paths)) {
      if (!path.isAbsolute(dir)) continue;
      const to = path.join(temp, 'native', key);
      mount(dir, to);
      setStagedProviderPath(provider, key, to);
    }
    let kernel = provider.kernelSkillsPath;
    if (kernel && path.isAbsolute(kernel)) {
      const to = path.join(temp, 'native', 'kernel-skills');
      mount(kernel, to);
      kernel = to;
    }
    // Codex's legacy prompt helper is home-global. Give it an isolated home and
    // promote only its output after validation.
    if (provider.name === 'codex' && (original.deployCommands || original.commandsOnly)) mount(path.join(os.homedir(), '.codex', 'prompts'), path.join(home, '.codex', 'prompts'));
    let hermesLegacySkills;
    let legacyCodexSkills;
    if (provider.name === 'hermes') {
      const source = path.join(path.dirname(provider.kernelSkillsPath), '.aiwg', 'skills');
      hermesLegacySkills = path.join(temp, 'hermes-legacy-skills');
      mount(source, hermesLegacySkills);
    }
    if (provider.name === 'codex' && (original.deploySkills || original.skillsOnly)) {
      legacyCodexSkills = path.join(temp, 'codex-legacy-skills');
      mount(path.join(os.homedir(), '.codex', 'skills'), legacyCodexSkills);
    }
    // Existing receipts carry logical source paths. Projectors operate against
    // the immutable snapshot, so translate those paths before stale cleanup;
    // promotion normalizes them back to their logical paths.
    for (const { to } of mappings) {
      for (const file of walk(to).filter(name => path.basename(name) === '.aiwg-manifest.json')) {
        let receipt; try { receipt = JSON.parse(read(file)); } catch { continue; }
        let changed = false;
        const remap = value => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (['skillSource', 'flowSource', 'sourcePath'].includes(key) && typeof child === 'string' && path.isAbsolute(child)) {
              const mapped = mapSource(child); if (mapped !== child) { value[key] = mapped; changed = true; }
            }
            else remap(child);
          }
        };
        remap(receipt); if (changed) fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
      }
    }
    let activeWorkspace;
    if (provider.resolveOpenClawWorkspace) {
      const from = provider.resolveOpenClawWorkspace();
      activeWorkspace = path.join(temp, 'active-workspace');
      mount(from, activeWorkspace);
    }
    // Graph discovery must read the same immutable inputs as projection, including
    // relocated project indexes and shared user indexes.
    const graphRoot = path.join(temp, 'graph-artifacts');
    const xdgRoot = path.join(temp, 'xdg-data');
    const copyGraph = (from, to) => {
      const expected = initialPreimages.find(item => item.path === path.resolve(from)).state;
      materializeInput(from, to);
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected))) throw new Error(`Graph input changed while preparing snapshot: ${from}`);
    };
    for (const from of projectGraphFiles) copyGraph(from, path.join(graphRoot, path.relative(artifactRoot, from)));
    for (const from of userGraphFiles) copyGraph(from, path.join(xdgRoot, 'aiwg', 'index', path.relative(userIndexRoot, from)));
    // Non-index graph targets remain logical until selected, then are copied
    // individually by the discovered-input loop below.
    if (path.resolve(artifactRoot) !== path.resolve(target, '.aiwg')) sourceMappings.push({ from: path.resolve(target, '.aiwg'), to: artifactRoot });
    process.env.AIWG_ARTIFACTS_PATH = graphRoot;
    process.env.XDG_DATA_HOME = xdgRoot;
    const delivery = await prepareRuleDelivery({ ...original, target: stage, sharedProjectGraph: path.resolve(artifactRoot) !== path.resolve(target, '.aiwg'), previousRuleSources: (previous.ruleSources || []).map(mapSource) });
    // Provider writes belong to the staged project control plane, not the
    // read-only graph snapshot used for binding discovery.
    process.env.AIWG_ARTIFACTS_PATH = path.join(stage, '.aiwg');
    // Discovery can select absolute user/project sources not known at entry.
    // Bind the exact copied bytes before any projector consumes them.
    const remappedBindings = new Map();
    for (const entry of delivery.targets) {
      const source = path.resolve(entry.source);
      const alreadyFrozen = source.startsWith(`${temp}${path.sep}`);
      if (!alreadyFrozen) {
        const state = capturePreimage(source);
        const to = path.join(temp, 'discovered-input', String(sourceMappings.length), path.basename(source));
        materializeInput(source, to);
        if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(state))) throw new Error(`Discovered input changed while preparing snapshot: ${source}`);
        preimages.push({ path: source, state });
        sourceMappings.push({ from: source, to });
        entry.source = to;
      }
      const rules = delivery.bindings.get(source);
      if (rules) remappedBindings.set(entry.source, rules);
    }
    delivery.bindings = remappedBindings;
    preimages.push(...snapshotPreimages([...delivery.rules.map(rule => rule.file), ...delivery.targets.map(entry => entry.source), path.join(target, '.aiwg', 'aiwg.config')]));
    const opts = { ...original, writeReceipt: writeContextFileSync, writtenFiles: [], target: stage, dryRun: false, ruleDelivery: delivery, logicalOutputPath: file => logicalProviderOutputPath(file, stage, target, mappings),
      kernelSkillsPath: kernel, deploymentHome: home, activeWorkspace, hermesLegacySkills, legacyCodexSkills, staging: true };
    const ownershipRoots = [stage, ...mappings.map(mapping => mapping.to)];
    const ownershipBefore = captureDeploymentOutputs(ownershipRoots);
    if (!opts.deferRuleProjection && (opts.kernelOnly || opts.deployRules || opts.rulesOnly ||
      (!opts.skillsOnly && !opts.commandsOnly && (inlineStartup[provider.name] || ['hermes', 'warp'].includes(provider.name))))) retireInlineStartup(opts, provider);
    await deploySelectedSurface(opts, provider, deploy);
    if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly && opts.deployBehaviors !== false) {
      deployEmulatedBehaviors(delivery.rules.filter(rule => rule.behavior).map(rule => path.dirname(rule.file)), provider.name, stage, opts);
    }
    const selectedRoots = [original.srcRoot, ...(original.additionalSources || []), ...getFrameworksForMode(original.srcRoot, original.mode).map(framework => framework.path), ...discoverAddons(original.srcRoot).map(addon => addon.path)];
    const selected = entry => selectedRoots.some(root => /^(agents|skills|commands|flows|workflows)[/\\]/.test(path.relative(root, entry.source)));
    opts.definitionRoutes = [];
    if (provider.name === 'hermes' && !opts.kernelOnly && !opts.skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
      const agents = delivery.targets.filter(target => target.type === 'agent' && selected(target));
      const selectedAgents = new Set(filterAgentFiles(agents.map(target => target.source), opts));
      for (const target of agents.filter(target => selectedAgents.has(target.source))) {
        const source = target.source;
        put(path.join(stage, '.hermes', 'agents', path.basename(source)), managed(replaceBoundRulesBlock(read(source), delivery.bindings.get(source)), opts));
        opts.definitionRoutes.push(`${target.name}: .hermes/agents/${path.basename(source)}`);
      }
    }
    projectBoundFlowSkills(opts, provider, selected);
    if (['warp', 'windsurf'].includes(provider.name)) {
      for (const file of walk(path.join(stage, `.${provider.name}`, 'commands'))) {
        if (/\.md$/.test(file)) opts.definitionRoutes.push(`${path.basename(file, '.md')}: .${provider.name}/commands/${path.basename(file)}`);
      }
      for (const entry of delivery.targets.filter(entry => entry.type === 'agent' && selected(entry))) {
        const dest = path.join(stage, `.${provider.name}`, 'agents', path.basename(entry.source));
        if (fs.existsSync(dest)) opts.definitionRoutes.push(`${entry.name}: .${provider.name}/agents/${path.basename(entry.source)}`);
      }
    }
    if (!opts.deferRuleProjection) {
      if (opts.kernelOnly || opts.deployRules || opts.rulesOnly || (!opts.skillsOnly && !opts.commandsOnly && (inlineStartup[provider.name] || ['hermes', 'warp'].includes(provider.name)))) projectRules(opts, provider);
      finishBindings(opts, provider);
    }
    // Normalize all generated path wrappers before counting or promoting bytes.
    const normalize = content => {
      for (const mapping of [...mappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      for (const mapping of [...sourceMappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      return content.split(snapshotRoot).join(corpusRoot).split(stage).join(target);
    };
    const projected = startupFiles(opts, provider).map(file => ({ path: normalize(file.path), content: normalize(file.content) }));
    const config = effectiveConfig;
    const guarded = guardRulesInlineBudget({ provider: provider.name, files: projected, config, env: budgetEnv,
      reportOnly: delivery.pins.length ? original.allowOverBudget === true : original.reportOnly !== false && !original.strict && !budgetEnv.CI });
    guarded.report.pins = delivery.pins.map(rule => ({ id: rule.id, name: rule.name, matches: rule.matches, canonical_activation: rule.canonical_activation, bytes: Buffer.byteLength(rule.body || '') }));
    const pinDetails = delivery.pins.map(rule => `${rule.name}: ${Buffer.byteLength(rule.body || '')} body bytes via ${JSON.stringify(rule.matches)}`).join('; ');
    const budgetFailure = message => new Error(`${provider.name}: ${message}; ${guarded.report.selected_bytes} startup bytes. Pins: ${pinDetails || '(none)'}.${delivery.pins.length ? ' Use --allow-over-budget to retain every pinned body.' : ''}`);
    for (const diagnostic of guarded.diagnostics) console.warn(diagnostic.message);
    if (!guarded.passed) throw budgetFailure(guarded.diagnostics.map(d => d.message).join('\n'));
    const agents = normalize(read(path.join(stage, 'AGENTS.md')));
    if (provider.name === 'codex' && Buffer.byteLength(agents) >= 32_768 && !(delivery.pins.length && original.allowOverBudget)) throw budgetFailure(`Codex AGENTS.md (${Buffer.byteLength(agents)} bytes) exceeds its 32 KB hard cap`);
    if (provider.name === 'hermes') {
      for (const name of ['AGENTS.md', '.hermes.md']) {
        const content = normalize(read(path.join(stage, name)));
        if (!(delivery.pins.length && original.allowOverBudget)) {
          try { provider.assertContextBudget(content, name, delivery.rules); }
          catch (error) { throw budgetFailure(error.message); }
        }
        if (content.length > 15_000) console.warn(`Hermes ${name} above 15000 character soft limit (${content.length})`);
      }
    }
    // Absolute provider roots can nest (Hermes standard skills live beneath
    // its kernel root). A more specific mount owns that subtree exclusively;
    // the parent's older snapshot must not resurrect pruned files/directories.
    const delegated = (from, rel) => mappings.some(mapping => mapping.from !== from
      && mapping.from.startsWith(`${from}${path.sep}`)
      && (path.join(from, rel) === mapping.from || path.join(from, rel).startsWith(`${mapping.from}${path.sep}`)));
    if (original.contextFiles === false) {
      // Keep context inputs in the snapshot for validation, but exclude them
      // from both dry-run output and promotion (including unchanged rewrites).
      for (let i = rootNames.length - 1; i >= 0; i--) {
        if ([...GENERATED_CONTEXT_NAMES, ...OPERATOR_CONTEXT_NAMES].includes(rootNames[i])) rootNames.splice(i, 1);
      }
    }
    if (pool) verifyInputPool(pool);
    if (original.previewReport) return { report: guarded.report, noop: true };
    if (original.dryRun) {
      // A validated plan must describe the operator's final paths, rather than
      // exposing only the temporary paths used to assemble that plan.
      for (const { from, to, before } of mappings) {
        const after = new Set(walk(to).map(file => path.relative(to, file)).filter(rel => !delegated(from, rel)));
        for (const rel of after) {
          const file = path.join(to, rel);
          if (before.get(rel) !== fileDigest(file)) console.log(`[dry-run] Would write ${normalize(file)}`);
        }
        for (const rel of before.keys()) if (!delegated(from, rel) && !after.has(rel)) console.log(`[dry-run] Would remove ${path.join(from, rel)}`);
      }
      for (const name of rootNames) {
        const file = path.join(stage, name);
        if (fs.existsSync(file) && normalize(read(file)) !== read(path.join(target, name))) console.log(`[dry-run] Would write ${path.join(target, name)}`);
      }
      console.log(`[dry-run] Planned ${provider.name} deployment: ${guarded.report.selected_bytes} startup bytes; no output promoted.`);
      return { report: guarded.report, noop: true };
    }
    recordDeploymentOutputs(ownershipBefore, ownershipRoots, opts);
    const workspaceDirs = [];
    const collectDirs = (dir, rel = '') => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = path.join(rel, entry.name); workspaceDirs.push(name);
        collectDirs(path.join(dir, entry.name), name);
      }
    };
    collectDirs(path.join(stage, '.aiwg'), '.aiwg');
    const contextWrites = [...new Set(fs.readFileSync(contextStageLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))];
    const plan = { version: 1, lease, temp, target, stage, contextWrites, rootNames, workspaceDirs, preimages, poolSeal: pool?.inventorySeal || null,
      anchors: captureAnchors([target, ...mappings.map(mapping => mapping.from), ...workspaceDirs.map(dir => path.join(target, dir))]),
      snapshotRoot, corpusRoot, sourceMappings, staged: snapshotPreimages([stage, ...mappings.map(mapping => mapping.to)]), report: guarded.report,
      mappings: mappings.map(({ from, to, before }) => ({ from, to, before: [...before] })) };
    stagedCleanups.get(lease).seal = planSeal(plan);
    retained = true;
    return plan;
  } finally {
    if (priorContextStage === undefined) delete process.env[CONTEXT_STAGE_ENV]; else process.env[CONTEXT_STAGE_ENV] = priorContextStage;
    restoreProviderPaths(provider, originals);
    if (priorAiwgRoot === undefined) delete process.env.AIWG_ROOT; else process.env.AIWG_ROOT = priorAiwgRoot;
    if (priorRegistry === undefined) delete process.env.AIWG_USER_REGISTRY_PATH; else process.env.AIWG_USER_REGISTRY_PATH = priorRegistry;
    if (priorArtifacts === undefined) delete process.env.AIWG_ARTIFACTS_PATH; else process.env.AIWG_ARTIFACTS_PATH = priorArtifacts;
    if (priorXdgData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = priorXdgData;
    if (!retained) { stagedCleanups.delete(lease); removeTemp(); }
  }
}
