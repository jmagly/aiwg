// Compare deployable catalog names with a separately reviewed Claude namespace fixture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { collectFrameworkArtifacts } from './agents/providers/base-framework-discovery.mjs';
import { discoverAddons } from './agents/providers/base-addon-discovery.mjs';
import { listMdFiles, listSkillDirs } from './agents/providers/base-files.mjs';
import { parseFrontmatter } from './agents/providers/base-frontmatter.mjs';
import { skillMatchesProvider } from './agents/providers/base-models-platforms.mjs';
import { resolveClaudeSkillName, validateClaudeCommands } from './agents/providers/claude-skill-names.mjs';
import { CLAUDE_NAME_CATEGORIES, readClaudeNameInventory, refreshClaudeNameInventory, findClaudeBinary } from './agents/providers/claude-builtin-inventory.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = path.join(ROOT, 'test/fixtures/providers/claude/builtin-names.json');

export function collectClaudeCatalogNames(root) {
  const artifacts = collectFrameworkArtifacts(root, 'all', { includeAgents: false, includeRules: false });
  // Explicit-install addons are deployable too; dev-only addons remain excluded.
  for (const component of [root, ...discoverAddons(root, { includeExplicit: true }).map(addon => addon.path)]) {
    artifacts.skills.push(...listSkillDirs(path.join(component, 'skills')));
    artifacts.commands.push(...listMdFiles(path.join(component, 'commands')));
  }
  return [
    ...[...new Set(artifacts.skills)].map(dir => ({ kind: 'skill', source: dir, file: path.join(dir, 'SKILL.md') })),
    ...[...new Set(artifacts.commands)].map(file => ({ kind: 'command', source: file, file })),
  ].filter(entry => entry.kind !== 'skill' || skillMatchesProvider(fs.readFileSync(entry.file, 'utf8'), 'claude'));
}

export function checkClaudeCatalogNames(entries, inventory) {
  const collisions = Object.fromEntries(CLAUDE_NAME_CATEGORIES.map(category => [category, []]));
  for (const entry of entries) {
    const data = yaml.load(parseFrontmatter(fs.readFileSync(entry.file, 'utf8')).frontmatter || '') || {};
    const folder = path.basename(entry.source, entry.kind === 'command' ? path.extname(entry.source) : undefined);
    let deployed = folder;
    let rejected = false;
    try {
      if (entry.kind === 'skill') deployed = resolveClaudeSkillName(entry.source);
      else validateClaudeCommands([entry.file]);
    } catch (error) {
      if (!error.message.startsWith('Claude Code built-in /')) throw error;
      rejected = true;
    }
    const sourceNames = new Set([folder.toLowerCase(), String(data.name || '').toLowerCase()]);
    const deployedNames = new Set([deployed.toLowerCase()]);
    // Skills rewrite native name only when renamed or originally blocking.
    if (deployed === folder && !rejected) deployedNames.add(String(data.name || '').toLowerCase());
    for (const category of CLAUDE_NAME_CATEGORIES) {
      const blocking = category !== 'unverifiedLocalCommands';
      for (const name of inventory[category]) {
        if (!sourceNames.has(name) && !deployedNames.has(name)) continue;
        const handling = rejected ? 'rejected' : !blocking ? 'reported' : deployedNames.has(name) ? 'UNHANDLED' : `renamed to ${deployed}`;
        collisions[category].push({ name, kind: entry.kind, source: entry.source, handling });
      }
    }
  }
  return { collisions, exitCode: Object.values(collisions).flat().some(item => item.handling === 'UNHANDLED') ? 1 : 0 };
}

export function main(args = process.argv.slice(2)) {
  let root = ROOT, fixture = FIXTURE, binary;
  let refresh = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--refresh-from-claude') refresh = true;
    else if (['--root', '--fixture', '--claude-binary'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--root') root = path.resolve(value);
      if (flag === '--fixture') fixture = path.resolve(value);
      if (flag === '--claude-binary') binary = path.resolve(value);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (binary && !refresh) throw new Error('--claude-binary requires --refresh-from-claude');
  const inventory = refresh ? refreshClaudeNameInventory(fixture, binary || findClaudeBinary()) : readClaudeNameInventory(fixture);
  const entries = collectClaudeCatalogNames(root);
  if (!entries.length) throw new Error(`No deployable catalog names found at ${root}`);
  const result = checkClaudeCatalogNames(entries, inventory);
  console.log(`Claude name check (${inventory.version}): ${entries.length} catalog entries`);
  for (const category of CLAUDE_NAME_CATEGORIES) {
    console.log(`${category}: ${result.collisions[category].length} collision(s)`);
    for (const item of result.collisions[category]) console.log(`  ${item.kind} ${item.name}: ${item.handling} (${path.relative(root, item.source)})`);
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
