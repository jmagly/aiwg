// Exercise ownership boundaries and the preservation handoff without a full corpus.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ensureDevinMcpConfig } from '../../../tools/agents/providers/devin-context.mjs';
import { migrateLegacyWindsurfContent } from '../../../tools/agents/providers/devin-migration.mjs';
import { preserveDeploymentOutputs } from '../../../src/providers/deployment-preservation.mjs';
import { captureDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';

const roots: string[] = [];
const archiveFile = (root: string) => path.join(root, '.devin/.aiwg/legacy-windsurf/originals.json.gz');
const archive = (root: string) => JSON.parse(gunzipSync(fs.readFileSync(archiveFile(root))).toString('utf8'));
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-devin-retire-')); roots.push(root);
  const write = (name: string, bytes: string) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const managed = write('.windsurf/skills/custom/SKILL.md', '<!-- aiwg:managed v1 bundled -->\nEdited content.\n');
  write('.windsurf/skills/custom/.aiwg-managed', 'aiwg\n');
  write('.windsurf/skills/custom/operator.txt', 'operator addition');
  write('.windsurf/rules/operator.md', '# Local');
  write('.windsurf/RULES-BOUND.md', 'Bound policy');
  write('.windsurf/.aiwg-manifest.json', JSON.stringify({ managed: { 'RULES-BOUND.md': { hash: 'old', owners: ['all'] } } }));
  fs.symlinkSync(managed, path.join(root, '.windsurf/operator-link'));
  return { root, write, managed };
}

describe('legacy Devin migration', () => {
  it('retires only owned bytes, archives edits, and tells both preservation passes', () => {
    const { root, managed } = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = captureDeploymentOutputs([root]);
    const opts = { target: root, provider: 'devin', copyMode: true, replacedSkillCopies: new Set<string>(),
      logicalOutputPath: (file: string) => file.replace(root, '/logical-project') };
    migrateLegacyWindsurfContent(root, opts);
    preserveDeploymentOutputs(before, [root], opts);
    expect(fs.existsSync(managed)).toBe(false);
    expect(opts.replacedSkillCopies.has('/logical-project/.windsurf/skills/custom/SKILL.md')).toBe(true);
    expect(Buffer.from(archive(root)['skills/custom/SKILL.md'].bytes, 'base64').toString()).toContain('Edited content.');
    expect(fs.readFileSync(path.join(root, '.windsurf/skills/custom/operator.txt'), 'utf8')).toBe('operator addition');
    expect(fs.lstatSync(path.join(root, '.windsurf/operator-link')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, '.windsurf/RULES-BOUND.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.windsurf/.aiwg-manifest.json'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Migrated'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Preserved 3 operator file(s)'));
  });
  it('merges project MCP settings and refuses to replace malformed operator JSON', () => {
    const { root, write } = setup();
    const config = write('.devin/mcp_config.json', JSON.stringify({ preference: true, mcpServers: { operator: { command: 'local-fixture' } } }));
    ensureDevinMcpConfig(root, {});
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toMatchObject({ preference: true,
      mcpServers: { operator: { command: 'local-fixture' }, aiwg: { command: 'aiwg' } } });
    fs.writeFileSync(config, '{malformed operator JSON');
    expect(() => ensureDevinMcpConfig(root, {})).toThrow();
    expect(fs.readFileSync(config, 'utf8')).toBe('{malformed operator JSON');
  });
  it('retires receipt-owned symlinks while retaining their targets and recovery links', () => {
    const { root, write } = setup();
    const target = write('external/retained.txt', 'External payload');
    const link = path.join(root, '.windsurf/owned-link');
    fs.symlinkSync(target, link);
    write('.windsurf/.aiwg-manifest.json', JSON.stringify({ managed: { 'owned-link': {} } }));
    migrateLegacyWindsurfContent(root);
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe('External payload');
    expect(archive(root)['owned-link'].link).toBe(target);
  });
  it('previews without changing the legacy tree or creating an archive', () => {
    const { root, managed } = setup();
    migrateLegacyWindsurfContent(root, { dryRun: true });
    expect(fs.existsSync(managed)).toBe(true);
    expect(fs.existsSync(path.join(root, '.devin'))).toBe(false);
  });
  it('retains unmanaged top-level content and distinct archive collisions', () => {
    const { root, managed } = setup();
    fs.mkdirSync(path.dirname(archiveFile(root)), { recursive: true });
    fs.writeFileSync(archiveFile(root), gzipSync(JSON.stringify({ 'skills/custom/SKILL.md': { bytes: Buffer.from('Earlier recovery bytes.').toString('base64'), mode: 0o644 } })));
    migrateLegacyWindsurfContent(root);
    const saved = archive(root);
    expect(Buffer.from(saved['skills/custom/SKILL.md'].bytes, 'base64').toString()).toBe('Earlier recovery bytes.');
    expect(Object.keys(saved).some(name => /^skills\/custom\/SKILL\.md\.[a-f0-9]{64}$/.test(name))).toBe(true);
    expect(fs.existsSync(managed)).toBe(false);
  });
});
