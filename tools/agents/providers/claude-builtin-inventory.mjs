// Read Claude's installed bundle offline; refresh observations without downgrading reviewed categories.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const CLAUDE_NAME_CATEGORIES = ['bundledSkills', 'unshadowableCommands', 'reservedFolders', 'unverifiedLocalCommands'];

export function readClaudeNameInventory(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const category of CLAUDE_NAME_CATEGORIES) {
    if (!Array.isArray(data[category]) || !data[category].every(name =>
      typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name))) {
      throw new Error(`Invalid Claude name inventory category: ${category}`);
    }
  }
  return data;
}

export function findClaudeBinary() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, 'claude');
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* next PATH entry */ }
  }
  throw new Error('No installed claude binary found on PATH');
}

export function extractClaudeNames(source) {
  const local = new Set();
  // Claude 2.1.x emits these literal command headers in either property order.
  for (const pattern of [
    /\btype:"local(?:-jsx)?",name:"([a-z0-9-]+)"/g,
    /\bname:"([a-z0-9-]+)",type:"local(?:-jsx)?"/g,
  ]) for (const match of source.matchAll(pattern)) local.add(match[1]);
  const bundled = new Set();
  // Find the bundled-skill registrar by its skillRoot/getPromptForCommand contract,
  // rather than pinning the minifier's function identifier across releases.
  const registrars = source.matchAll(/function ([\w$]+)\(\w+\)\{let\{skillRoot:[^{}]{1,200}getPromptForCommand:/g);
  for (const match of registrars) {
    const escaped = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const calls = new RegExp(`\\b${escaped}\\(\\{name:"([a-z0-9-]+)"`, 'g');
    for (const call of source.matchAll(calls)) bundled.add(call[1]);
  }
  if (!local.size || !bundled.size) {
    throw new Error('Unsupported Claude bundle format: no local commands or bundled skills found; fixture unchanged');
  }
  return { local: [...local], bundled: [...bundled] };
}

export function refreshClaudeNameInventory(file, binary) {
  const previous = readClaudeNameInventory(file);
  const bytes = fs.readFileSync(fs.realpathSync(binary));
  const observed = extractClaudeNames(bytes.toString('utf8'));
  const bundledSkills = [...new Set([...previous.bundledSkills, ...observed.bundled])].sort();
  const reviewed = new Set([...bundledSkills, ...previous.unshadowableCommands, ...previous.reservedFolders]);
  const updated = { ...previous,
    version: `installed bundle ${path.basename(fs.realpathSync(binary))}`,
    sources: [...previous.sources, `Offline bundle scan sha256:${createHash('sha256').update(bytes).digest('hex')}; local command additions require live behaviour verification`],
    bundledSkills,
    unverifiedLocalCommands: [...new Set([...previous.unverifiedLocalCommands, ...observed.local])]
      .filter(name => !reviewed.has(name)).sort(),
  };
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
