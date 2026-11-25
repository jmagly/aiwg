// Exercise the offline catalog comparison independently of the guard's own inventory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectClaudeCatalogNames, checkClaudeCatalogNames, main } from '../../../tools/check-claude-catalog-names.mjs';
import { extractClaudeNames, readClaudeNameInventory, refreshClaudeNameInventory } from '../../../tools/agents/providers/claude-builtin-inventory.mjs';

const fixture = path.resolve('test/fixtures/providers/claude/builtin-names.json');
const catalog = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/providers/claude/catalog-names.json'), 'utf8'));
let root: string;
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function skill(name: string, extra = '', base = root) {
  write(path.join(base, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${extra}---\nFixture\n`);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-claude-catalog-'));
  for (const entry of catalog) {
    const extra = entry.aliases ? `aliases: ${JSON.stringify(entry.aliases)}\n` : '';
    if (entry.kind === 'skill') skill(entry.name, extra);
    else write(path.join(root, 'commands', `${entry.name}.md`), `---\nname: ${entry.name}\n---\nFixture\n`);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude catalog name check', () => {
  it('reports fixture collisions per category and accepts guarded blocking names', () => {
    const result = checkClaudeCatalogNames(collectClaudeCatalogNames(root), readClaudeNameInventory(fixture));
    expect(result.exitCode).toBe(0);
    expect(result.collisions.bundledSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'run', kind: 'skill', handling: 'renamed to aiwg-run' }),
      expect.objectContaining({ name: 'schedule', handling: 'renamed to aiwg-schedule' }),
      expect.objectContaining({ name: 'run', kind: 'command', handling: 'rejected' }),
    ]));
    expect(result.collisions.reservedFolders).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'steward', handling: 'renamed to aiwg-steward-routing' }),
      expect.objectContaining({ name: 'babysit', handling: 'rejected' }),
    ]));
    expect(result.collisions.unshadowableCommands).toEqual([expect.objectContaining({ name: 'help', handling: 'rejected' })]);
    expect(result.collisions.unverifiedLocalCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'config', handling: 'reported' }),
      expect.objectContaining({ name: 'skills', handling: 'reported' }),
    ]));
  });

  it.each(['bundledSkills', 'unshadowableCommands', 'reservedFolders'])('fails for an unguarded %s name', category => {
    skill('new-native');
    const inventory = readClaudeNameInventory(fixture);
    inventory[category].push('new-native');
    const result = checkClaudeCatalogNames(collectClaudeCatalogNames(root), inventory);
    expect(result.exitCode).toBe(1);
    expect(result.collisions[category]).toContainEqual(expect.objectContaining({ name: 'new-native', handling: 'UNHANDLED' }));
  });

  it('detects collisions introduced by the guard alias and command metadata', () => {
    const inventory = readClaudeNameInventory(fixture);
    inventory.bundledSkills.push('aiwg-run', 'new-command');
    write(path.join(root, 'commands/safe.md'), '---\nname: new-command\n---\nFixture\n');
    const result = checkClaudeCatalogNames(collectClaudeCatalogNames(root), inventory);
    expect(result.exitCode).toBe(1);
    for (const name of ['aiwg-run', 'new-command']) {
      expect(result.collisions.bundledSkills).toContainEqual(expect.objectContaining({ name, handling: 'UNHANDLED' }));
    }
  });

  it('checks explicit-install addons and excludes non-Claude skills and dev-only addons', () => {
    skill('run-elsewhere', 'platforms: [codex]\n');
    const addons = path.join(root, 'agentic/code/addons');
    for (const [name, manifest] of [['explicit', { explicitInstall: true }], ['dev', { devOnly: true }]] as const) {
      const base = path.join(addons, name);
      write(path.join(base, 'manifest.json'), JSON.stringify(manifest));
      skill(name, '', base);
    }
    const names = collectClaudeCatalogNames(root).map(entry => path.basename(entry.source));
    expect(names).toContain('explicit');
    expect(names).not.toContain('dev');
    expect(names).not.toContain('run-elsewhere');
  });

  it('runs the CLI entrypoint offline and returns nonzero when the fixture advances beyond the guard', () => {
    const binary = path.join(root, 'bin/claude');
    write(binary, '#!/bin/sh\nexit 99\n');
    fs.chmodSync(binary, 0o755);
    vi.stubEnv('PATH', path.dirname(binary));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = (file: string) => main(['--root', root, '--fixture', file]);
    expect(run(fixture)).toBe(0);
    expect(output).toHaveBeenCalledWith('unverifiedLocalCommands: 2 collision(s)');
    const inventory = readClaudeNameInventory(fixture);
    inventory.bundledSkills.push('safe');
    const next = path.join(root, 'next.json');
    write(next, JSON.stringify(inventory));
    expect(run(next)).toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('skill safe: UNHANDLED'));
  });

  it('extracts synthetic installed-bundle declarations without executing a CLI', () => {
    const bundle = 'function Q(e){let{skillRoot:r,getPromptForCommand:n}=make(e),o={type:"prompt"}};' +
      'Q({name:"new-bundled",description:"Fixture"});var x={type:"local-jsx",name:"new-local"};';
    expect(extractClaudeNames(bundle)).toEqual({ local: ['new-local'], bundled: ['new-bundled'] });
    const binary = path.join(root, 'fake-bundle');
    write(binary, bundle);
    const next = path.join(root, 'next.json');
    fs.copyFileSync(fixture, next);
    const refreshed = refreshClaudeNameInventory(next, binary);
    expect(refreshed.bundledSkills).toContain('new-bundled');
    expect(refreshed.unverifiedLocalCommands).toContain('new-local');
    expect(refreshed.unshadowableCommands).toEqual(readClaudeNameInventory(fixture).unshadowableCommands);
    expect(refreshed.reservedFolders).toEqual(['steward', 'babysit']);
    expect(refreshed.sources.at(-1)).toMatch(/Offline bundle scan sha256:[a-f0-9]{64}/);
    write(binary, 'changed format');
    const previous = fs.readFileSync(next);
    expect(() => refreshClaudeNameInventory(next, binary)).toThrow(/Unsupported Claude bundle format/);
    expect(fs.readFileSync(next)).toEqual(previous);
  });

  it('rejects a malformed fixture instead of silently dropping a category', () => {
    const next = path.join(root, 'invalid.json');
    write(next, '{"bundledSkills":[]}');
    expect(() => readClaudeNameInventory(next)).toThrow(/Invalid Claude name inventory category/);
  });
});
