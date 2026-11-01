// Audit actual tarball bytes, not the source manifest alone.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, inject, it } from 'vitest';
import { packFlue } from '../helpers/flue-package.mjs';
import { validateFlueSkill } from '../../tools/agents/providers/flue-validation.mjs';
let scratch: string;
afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
it('ships the canonical copy-mode helpers with the base CLI', () => {
  const base = inject('basePackageManifest');
  expect(base.files.map(file => file.path).filter(file => file.startsWith('packages/')).sort()).toEqual([
    'packages/flue/remote-specialist.d.ts', 'packages/flue/remote-specialist.js',
  ]);
});

it('packs every typed export with exactly the declared peers and no third-party implementation', () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-pack-'));
  const { tarball, info, skills } = packFlue(scratch);
  const unpacked = path.join(scratch, 'unpacked'); fs.mkdirSync(unpacked);
  expect(spawnSync('tar', ['-xzf', tarball, '-C', unpacked], { timeout: 60_000 }).status).toBe(0);
  const directory = path.join(unpacked, 'package');
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  expect(pkg.peerDependencies).toEqual({ '@flue/runtime': '2.3.x', '@modelcontextprotocol/client': '2.0.0', valibot: '^1.1.0' });
  for (const key of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'devDependencies']) expect(pkg[key]).toBeUndefined();
  expect(info.files.map((file: any) => file.path).join('\n')).not.toMatch(/(?:^|\/)node_modules\/|(?:vite|lightningcss|caniuse-lite)\//);
  expect(Object.keys(pkg.exports).filter(name => name.endsWith('/SKILL.md'))).toHaveLength(skills);
  for (const [name, entry] of Object.entries(pkg.exports) as [string, any][]) {
    expect(entry.types, name).toBeTruthy();
    for (const target of Object.values(entry) as string[]) expect(fs.statSync(path.join(directory, target)).isFile(), target).toBe(true);
    if (name.endsWith('/SKILL.md')) validateFlueSkill(fs.readFileSync(path.join(directory, entry.default), 'utf8'), path.join(directory, entry.default));
  }
  // Every executable module must originate in AIWG source or its tool template.
  expect(fs.readFileSync(path.join(directory, 'tools.js'), 'utf8')).not.toMatch(/node:|process\./);
  const allowed = new Set(['tools.js', 'specialists.js', 'specialist-binding.js', 'remote-specialist.js', 'node.js']);
  expect(info.files.filter((file: any) => /\.(?:m?js|cjs)$/.test(file.path) && !file.path.startsWith('skills/')).every((file: any) => allowed.has(file.path))).toBe(true);
  for (const name of ['tools.js', 'specialist-binding.js', 'remote-specialist.js']) expect(fs.readFileSync(path.join(directory, name), 'utf8')).toBe(fs.readFileSync(path.resolve('packages/flue', name), 'utf8'));
  for (const name of allowed) expect(fs.readFileSync(path.join(directory, name), 'utf8')).not.toMatch(/node_modules\/|__commonJS|__toESM|vite\/dist|lightningcss/);
  console.log(`Flue tarball: ${info.size} packed bytes; ${info.unpackedSize} unpacked bytes; ${skills} skills`);
}, 120_000);
