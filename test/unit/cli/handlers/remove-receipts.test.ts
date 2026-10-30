// Receipt removal safeguards exercised through the public handler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as skillOwner from '../../../../src/providers/skill-ownership.mjs';
import * as configOwner from '../../../../src/config/aiwg-config.js';
import { removeHandler } from '../../../../src/cli/handlers/subcommands.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../../src/providers/deployment-ownership.mjs';
import { planDeploymentRemoval } from '../../../../src/providers/deployment-removal.js';
import { applyRemovalTransaction } from '../../../../src/providers/removal-transaction.js';

const owner = 'sdlc-complete';
let root: string;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const write = (name: string, value: unknown) => {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
};
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function receipt(dir: string, managed: Record<string, any>) { write(`${dir}/.aiwg-manifest.json`, { managed }); }
function record(kind: string, owners = [owner]) { return { hash: hash('deployed'), kind, owners }; }
const config = () => ({ version: '1', providers: ['claude'], scripts: {}, installed: {
  sdlc: { version: '1', source: 'bundled', installedAt: '2026-01-01T00:00:00Z', deployedTo: {
    claude: { agents: 2, commands: 1, rules: 1, skills: 1 } } },
  marketing: { version: '1', source: 'bundled', installedAt: '2026-01-01T00:00:00Z', deployedTo: {
    claude: { agents: 1, commands: 0, rules: 0, skills: 0 } } },
} });
const run = (args: string[] = []) => removeHandler.execute({ cwd: root, frameworkRoot: root, rawArgs: [], args: ['sdlc', ...args] });
function snapshot(dir = root): Record<string, any> {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file, 'utf8')];
  }));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-remove-receipts-'));
  write('.aiwg/aiwg.config', config());
  for (const [dir, kind, name] of [['agents', 'agent', 'one.md'], ['agents', 'agent', 'two.md'],
    ['commands', 'command', 'one.md'], ['rules', 'rule', 'one.md'], ['skills/demo', 'skill', 'SKILL.md']]) {
    write(`.claude/${dir}/${name}`, 'deployed');
    const sidecar = `.claude/${dir}/.aiwg-manifest.json`;
    const managed = fs.existsSync(path.join(root, sidecar)) ? read(sidecar).managed : {};
    receipt(`.claude/${dir}`, { ...managed, [name]: record(kind) });
  }
  write('.claude/agents/marketing.md', 'deployed');
  const managed = read('.claude/agents/.aiwg-manifest.json').managed;
  receipt('.claude/agents', { ...managed, 'marketing.md': record('agent', ['media-marketing-kit']) });
  write('.claude/agents/operator.md', 'operator');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('receipt-backed framework file removal (#3769)', () => {
  it('previews exactly the owned files and matching installed counts without writing', async () => {
    const before = snapshot();
    const result = await run(['--dry-run']);
    expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('Receipt inventory: 2 agents, 1 commands, 1 rules, 1 skills; 5 owned file record(s)');
    expect(result.message).toContain('aiwg.config deployedTo: 2 agents, 1 commands, 1 rules, 1 skills');
    const removed = result.message!.split('\n').filter(line => line.includes('Would remove ') && !line.includes('.aiwg-manifest')).map(line => line.trim().split(' — ')[0]);
    expect(removed).toEqual([
      'Would remove .claude/agents/one.md', 'Would remove .claude/agents/two.md',
      'Would remove .claude/commands/one.md', 'Would remove .claude/rules/one.md', 'Would remove .claude/skills/demo/SKILL.md',
      'Would remove 5 unchanged recorded file(s); operator files preserved.',
    ]);
    expect(snapshot()).toEqual(before);
  });
  it('reports the same foreign preservation lines in preview and real removal', async () => {
    const preview = await run(['--dry-run']);
    const result = await run();
    const foreign = (message: string) => message.split('\n').filter(line => line.includes(' — foreign'))
      .map(line => line.trim().replace(/^(Would preserve|Preserve) /, ''));
    expect(foreign(preview.message!)).toContain('.claude/agents/marketing.md — foreign ownership receipt; owned by another bundle');
    expect(foreign(result.message!)).toEqual(foreign(preview.message!));
  });
  it('accounts for a released legacy skill sidecar without a stray preservation report', async () => {
    receipt('.claude/skills/demo', { 'SKILL.md': { hash: hash('deployed'), frameworkSlug: owner } });
    const plan = planDeploymentRemoval(root, 'claude', owner);
    const file = path.join(root, '.claude/skills/demo/.aiwg-manifest.json');
    expect(plan.decisions.filter(item => item.path === file)).toEqual([
      expect.objectContaining({ action: 'remove', reason: 'ownership metadata released' }),
    ]);
    await applyRemovalTransaction(plan.writes);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('accounts for a recognized legacy sidecar even when its release emits no actions', () => {
    receipt('.claude/skills/demo', { 'SKILL.md': { hash: hash('deployed'), frameworkSlug: owner } });
    vi.spyOn(skillOwner, 'releaseSkillOwnership').mockReturnValueOnce(null);
    const plan = planDeploymentRemoval(root, 'claude', owner);
    const file = path.join(root, '.claude/skills/demo/.aiwg-manifest.json');
    expect(plan.decisions.some(item => item.path === file && item.reason.includes('unrecorded operator file'))).toBe(false);
  });
  it('removes every owned kind and retains marketing and operator bytes', async () => {
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    for (const file of ['agents/one.md', 'agents/two.md', 'commands/one.md', 'rules/one.md', 'skills/demo/SKILL.md']) expect(fs.existsSync(path.join(root, '.claude', file))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.claude/agents/marketing.md'), 'utf8')).toBe('deployed');
    expect(fs.readFileSync(path.join(root, '.claude/agents/operator.md'), 'utf8')).toBe('operator');
    expect(read('.claude/agents/.aiwg-manifest.json').managed).toEqual({ 'marketing.md': record('agent', ['media-marketing-kit']) });
    expect(read('.aiwg/aiwg.config').installed.sdlc).toBeUndefined();
    expect(read('.aiwg/aiwg.config').installed.marketing).toEqual(config().installed.marketing);
  });
  it.each(['agents/one.md', 'commands/one.md', 'rules/one.md', 'skills/demo/SKILL.md'])('preserves and reports edited %s, retaining its receipt and accurate config', async name => {
    write(`.claude/${name}`, 'operator edit');
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain(`Preserve .claude/${name} — modified or unverifiable managed file`);
    expect(fs.readFileSync(path.join(root, '.claude', name), 'utf8')).toBe('operator edit');
    expect(read(`.claude/${path.dirname(name)}/.aiwg-manifest.json`).managed[path.basename(name)].owners).toEqual([owner]);
    const counts = read('.aiwg/aiwg.config').installed.sdlc.deployedTo.claude;
    expect(Object.values(counts).reduce((a: any, b: any) => a + b, 0)).toBe(1);
  });
  it('releases only this owner of a shared file and permits the last owner to remove it later', async () => {
    const managed = read('.claude/agents/.aiwg-manifest.json').managed;
    managed['one.md'] = { ...record('agent', [owner, 'media-marketing-kit']), frameworkSlug: owner };
    receipt('.claude/agents', managed);
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('shared with another framework');
    expect(fs.existsSync(path.join(root, '.claude/agents/one.md'))).toBe(true);
    expect(read('.claude/agents/.aiwg-manifest.json').managed['one.md']).toMatchObject({ owners: ['media-marketing-kit'], frameworkSlug: 'media-marketing-kit' });
    const second = await removeHandler.execute({ cwd: root, frameworkRoot: root, rawArgs: [], args: ['marketing'] });
    expect(second.exitCode, second.message).toBe(0);
    expect(fs.existsSync(path.join(root, '.claude/agents/one.md'))).toBe(false);
  });
  it('keeps all legacy files without receipts and retains unverifiable deployment counts', async () => {
    for (const dir of ['agents', 'commands', 'rules', 'skills/demo']) fs.unlinkSync(path.join(root, '.claude', dir, '.aiwg-manifest.json'));
    const before = snapshot();
    const preview = await run(['--dry-run']); expect(preview.message).toContain('unverifiable: no ownership receipt');
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('Deployment record retained');
    expect(read('.aiwg/aiwg.config').installed.sdlc).toEqual(config().installed.sdlc);
    expect(snapshot()).toEqual(before);
  });
  it('preserves receipt path escapes, symlinks, and unrecorded files even with --force', async () => {
    write('outside.md', 'deployed');
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(root, '.claude/agents/link.md'));
    const managed = read('.claude/agents/.aiwg-manifest.json').managed;
    receipt('.claude/agents', { ...managed, '../../outside.md': record('agent'), 'link.md': record('agent') });
    const result = await run(['--force']); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('unsafe receipt path'); expect(result.message).toContain('symlink preserved');
    expect(fs.readFileSync(path.join(root, 'outside.md'), 'utf8')).toBe('deployed');
    expect(fs.lstatSync(path.join(root, '.claude/agents/link.md')).isSymbolicLink()).toBe(true);
  });
  it('reports operator settings edits and retains only unresolved keys across repeated removals', async () => {
    write('.claude/settings.json', { theme: 'operator' });
    const before = captureDeploymentOutputs([path.join(root, '.claude')]);
    write('.claude/settings.json', { theme: 'operator', aiwg: { mode: 'sdlc', enabled: true } });
    recordDeploymentOutputs(before, [path.join(root, '.claude')], { frameworkSlug: owner });
    write('.claude/settings.json', { theme: 'operator', aiwg: { mode: 'custom', enabled: true } });
    const result = await run();
    expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('settings.json#/aiwg/mode — operator-edited settings value preserved');
    expect(read('.claude/settings.json')).toEqual({ theme: 'operator', aiwg: { mode: 'custom' } });
    expect(Object.keys(read('.claude/.aiwg-manifest.json').managed['settings.json'].settings)).toEqual(['/aiwg/mode']);
    expect(read('.aiwg/aiwg.config').installed.sdlc.deployedTo.claude).toEqual({ agents: 0, commands: 0, skills: 0, rules: 0 });
    const second = await run(); expect(second.message).toContain('operator-edited settings value preserved');
    write('.claude/settings.json', { theme: 'operator', aiwg: { mode: 'sdlc' } });
    const third = await run(); expect(third.exitCode, third.message).toBe(0);
    expect(read('.claude/settings.json')).toEqual({ theme: 'operator' });
    expect(read('.aiwg/aiwg.config').installed.sdlc).toBeUndefined();
  });
  it('keeps unverifiable settings while removing a verified hook script', async () => {
    write('.claude/settings.json', 'deployed'); write('.claude/hooks/check.sh', 'deployed');
    receipt('.claude', { 'settings.json': record('settings'), 'hooks/check.sh': record('hook') });
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('settings contributions missing or conflicting; unverifiable');
    expect(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe('deployed');
    expect(fs.existsSync(path.join(root, '.claude/hooks/check.sh'))).toBe(false);
    expect(read('.claude/.aiwg-manifest.json').managed['hooks/check.sh']).toBeUndefined();
    expect(read('.claude/.aiwg-manifest.json').managed['settings.json'].owners).toEqual([owner]);
    expect(read('.aiwg/aiwg.config').installed.sdlc.deployedTo.claude).toEqual({ agents: 0, commands: 0, skills: 0, rules: 0 });
  });
  it('preserves operator context in a bridge even when its post-deploy whole-file digest matches', async () => {
    const content = 'Operator notes.\n<!-- AIWG managed hook -->\n';
    write('CLAUDE.md', content);
    write('.aiwg/.aiwg-manifest.json', { scope: 'project', managed: {
      'CLAUDE.md': { ...record('generated'), hash: hash(content) },
    } });
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('context bridge preserved; pre-deploy operator content unverifiable');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(content);
    expect(read('.aiwg/.aiwg-manifest.json').managed['CLAUDE.md'].owners).toEqual([owner]);
  });
  it.each(['delete', 'receipt', 'config'])('rolls back files, receipts and config after a partial %s failure', async failure => {
    const before = snapshot(); let injected = false;
    if (failure === 'delete') {
      const original = fs.unlinkSync;
      vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
        if (String(file).endsWith('/two.md') && !injected) { injected = true; throw new Error('injected deletion failure'); }
        return original(file);
      });
    } else if (failure === 'config') {
      const original = configOwner.writeAiwgConfig;
      vi.spyOn(configOwner, 'writeAiwgConfig').mockImplementationOnce(async (...args) => {
        await original(...args); injected = true; throw new Error('injected config failure after replacement');
      });
    } else {
      const original = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args: any[]) => {
        if (String(file) === path.join(root, failure === 'receipt' ? '.claude/agents/.aiwg-manifest.json' : '.aiwg/aiwg.config') && !injected) {
          injected = true; throw new Error('injected metadata failure');
        }
        return (original as any)(file, ...args);
      });
    }
    const result = await run(); expect(injected).toBe(true); expect(result.exitCode).toBe(1);
    expect(result.message).toContain('All changes rolled back');
    expect(snapshot()).toEqual(before);
    const journal = result.message!.split('record: ')[1];
    const recovery = JSON.parse(fs.readFileSync(journal, 'utf8'));
    expect(recovery.status).toBe('rolled-back'); expect(recovery.entries.length).toBeGreaterThan(5);
    for (const entry of recovery.entries) if (entry.backup !== null) {
      expect(fs.readFileSync(path.join(path.dirname(journal), entry.backup))).toEqual(fs.readFileSync(entry.path));
    }
    fs.rmSync(path.dirname(journal), { recursive: true, force: true });
  });
  it('preserves legacy counts when only another framework has receipts', async () => {
    for (const dir of ['agents', 'commands', 'rules', 'skills/demo']) fs.unlinkSync(path.join(root, '.claude', dir, '.aiwg-manifest.json'));
    receipt('.claude/agents', { 'marketing.md': record('agent', ['media-marketing-kit']) });
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(read('.aiwg/aiwg.config').installed.sdlc.deployedTo.claude).toEqual(config().installed.sdlc.deployedTo.claude);
    expect(fs.readFileSync(path.join(root, '.claude/agents/one.md'), 'utf8')).toBe('deployed');
  });
  it('retains the unverifiable remainder of a mixed legacy deployment', async () => {
    const managed = read('.claude/agents/.aiwg-manifest.json').managed;
    delete managed['two.md']; receipt('.claude/agents', managed);
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain('Retained 1 unverifiable historical artifact count(s)');
    expect(fs.existsSync(path.join(root, '.claude/agents/one.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.claude/agents/two.md'), 'utf8')).toBe('deployed');
    expect(read('.aiwg/aiwg.config').installed.sdlc.deployedTo.claude).toEqual({ agents: 1, commands: 0, skills: 0, rules: 0 });
  });
  it('honors foreign owners and conflicting digests in overlapping sidecars', async () => {
    receipt('.claude', { 'agents/one.md': record('agent', ['media-marketing-kit']),
      'agents/two.md': { ...record('agent'), hash: hash('a different preimage') } });
    const result = await run(); expect(result.exitCode, result.message).toBe(0);
    expect(fs.readFileSync(path.join(root, '.claude/agents/one.md'), 'utf8')).toBe('deployed');
    expect(fs.readFileSync(path.join(root, '.claude/agents/two.md'), 'utf8')).toBe('deployed');
    expect(result.message).toContain('conflicting receipt digests');
    expect(read('.claude/.aiwg-manifest.json').managed['agents/one.md'].owners).toEqual(['media-marketing-kit']);
  });
  it('refuses a parent directory replaced with a symlink after planning', async () => {
    const plan = planDeploymentRemoval(root, 'claude', owner);
    fs.renameSync(path.join(root, '.claude/agents'), path.join(root, 'backing'));
    fs.symlinkSync(path.join(root, 'backing'), path.join(root, '.claude/agents'));
    await expect(applyRemovalTransaction(plan.writes)).rejects.toThrow('Symlink changed during removal planning');
    expect(fs.readFileSync(path.join(root, 'backing/one.md'), 'utf8')).toBe('deployed');
  });
  it('rechecks the digest immediately before deletion and preserves an intervening edit', async () => {
    const original = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      const result = original(file);
      if (String(file) === path.join(root, '.claude/agents/one.md')) write('.claude/agents/two.md', 'edited during removal');
      return result;
    });
    const result = await run(); expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Changed during removal planning');
    expect(fs.readFileSync(path.join(root, '.claude/agents/one.md'), 'utf8')).toBe('deployed');
    expect(fs.readFileSync(path.join(root, '.claude/agents/two.md'), 'utf8')).toBe('edited during removal');
    expect(read('.aiwg/aiwg.config').installed.sdlc).toEqual(config().installed.sdlc);
    fs.rmSync(path.dirname(result.message!.split('record: ')[1]), { recursive: true, force: true });
  });
  it('refuses a changed preimage between planning and execution', async () => {
    const plan = planDeploymentRemoval(root, 'claude', owner);
    write('.claude/agents/one.md', 'changed after planning');
    await expect(applyRemovalTransaction(plan.writes)).rejects.toThrow('Changed during removal planning');
    expect(fs.readFileSync(path.join(root, '.claude/agents/two.md'), 'utf8')).toBe('deployed');
  });
});
