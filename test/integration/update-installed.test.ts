// Exercise update authority through the built public CLI under a temporary HOME.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const bin = path.resolve('bin/aiwg.mjs');
describe('update installed selection CLI', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-update-cli-'));
    mkdirSync(path.join(root, '.aiwg/frameworks'), { recursive: true });
    mkdirSync(path.join(root, 'home/.aiwg'), { recursive: true });
    writeFileSync(path.join(root, 'home/.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: path.resolve(import.meta.dirname, '../..'), devMode: true, checkOnStartup: false }));
    writeFileSync(path.join(root, '.aiwg/frameworks/registry.json'), JSON.stringify({
      frameworks: [{ id: 'sdlc-complete' }, { id: 'media-marketing-kit' }],
    }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function run(args: string[]) {
    const result = spawnSync(process.execPath, [bin, 'update', '--skip-check', ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), AIWG_CONFIG: path.join(root, 'home/.aiwg'), AIWG_RESOLVE_IMPL_FROM: 'dist',
        XDG_CONFIG_HOME: path.join(root, '.config'), XDG_DATA_HOME: path.join(root, '.local/share'),
        XDG_CACHE_HOME: path.join(root, '.cache'), NO_UPDATE_NOTIFIER: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }
  it('does not redeploy or rewrite an explicitly empty selection', () => {
    const config = JSON.stringify({ version: '1.0', providers: ['claude'], installed: {} });
    writeFileSync(path.join(root, '.aiwg/aiwg.config'), config);
    const output = run([]);
    expect(output).toContain('Skipped legacy registry frameworks: sdlc-complete, media-marketing-kit');
    expect(output).toContain('No installed frameworks to re-deploy');
    expect(readFileSync(path.join(root, '.aiwg/aiwg.config'), 'utf8')).toBe(config);
  });
  it('previews only config selections and the requested provider', () => {
    writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({ installed: { research: { deployedTo: { codex: {} } } } }));
    const output = run(['--dry-run', '--provider', 'codex']);
    expect(output).toContain('aiwg use research --provider codex');
    expect(output).toContain('Skipped legacy registry frameworks: sdlc-complete, media-marketing-kit');
    expect(output).not.toContain('aiwg use sdlc');
  });
  it('reports fallback and previews legacy aliases for an old project', () => {
    const output = run(['--dry-run']);
    expect(output).toContain('Legacy fallback');
    expect(output).toContain('aiwg use sdlc');
    expect(output).toContain('aiwg use marketing');
  });
  it('preserves the established plan when sources agree', () => {
    writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({ installed: { sdlc: { deployedTo: { codex: {} } }, marketing: { deployedTo: { codex: {} } } } }));
    const output = run(['--dry-run']);
    expect(output).toContain('aiwg use sdlc');
    expect(output).toContain('aiwg use marketing');
    expect(output).not.toContain('Skipped');
    expect(output).not.toContain('Legacy fallback');
  });
});
