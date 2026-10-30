// Settings recovery safeguards use real receipt recording and the removal transaction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';
import { planDeploymentRemoval } from '../../../src/providers/deployment-removal.js';
import { parseSettings } from '../../../src/providers/settings-document.mjs';
import { applyRemovalTransaction } from '../../../src/providers/removal-transaction.js';

let root: string;
const sdlc = 'sdlc-complete', marketing = 'media-marketing-kit';
const operator = { matcher: 'operator', hooks: [{ type: 'command', command: 'operator' }] };
const hook = (framework: string) => ({ hooks: [{ type: 'command', command: framework, _aiwg_managed: true }] });
const settingsPath = () => path.join(root, '.claude/settings.json');
function write(value: unknown, name = '.claude/settings.json') {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const read = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
function deploy(owner: string, value: unknown, name = '.claude/settings.json') {
  const before = captureDeploymentOutputs([path.join(root, '.claude')]);
  write(value, name);
  recordDeploymentOutputs(before, [path.join(root, '.claude')], { frameworkSlug: owner, writtenFiles: [path.join(root, name)] });
}
async function remove(owner: string) {
  const plan = planDeploymentRemoval(root, 'claude', owner);
  await applyRemovalTransaction(plan.writes);
  return plan;
}
const receipt = () => JSON.parse(fs.readFileSync(path.join(root, '.claude/.aiwg-manifest.json'), 'utf8')).managed['settings.json'];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-settings-removal-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('settings contribution recovery (#3769 item 3)', () => {
  it.each([[marketing, sdlc], [sdlc, marketing]])('restores stacked modes and framework hooks in removal order %s then %s', async (first, second) => {
    const original = '{\n\t"aiwg": { "mode": "operator" }, "hooks": {"SessionStart": []}, "theme": "operator"\n}\n';
    write(original);
    deploy(sdlc, { aiwg: { mode: 'sdlc' }, hooks: { SessionStart: [hook('sdlc')] }, theme: 'operator' });
    deploy(marketing, { aiwg: { mode: 'marketing' }, hooks: { SessionStart: [hook('sdlc'), hook('marketing')] }, theme: 'operator' });
    const snapshot = fs.readFileSync(settingsPath());
    const preview = planDeploymentRemoval(root, 'claude', first);
    expect(preview.decisions.some(item => item.pointer === '/aiwg/mode')).toBe(true);
    expect(fs.readFileSync(settingsPath())).toEqual(snapshot);
    await remove(first);
    expect(read().aiwg.mode).toBe(second === sdlc ? 'sdlc' : 'marketing');
    expect(read().hooks.SessionStart).toEqual(second === sdlc ? [hook('sdlc')] : [hook('marketing')]);
    await remove(second);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(root, '.claude/.aiwg-manifest.json'))).toBe(false);
  });
  it('retains a shared scalar owner when another owner later writes a different value', async () => {
    const original = '{ "aiwg": { "mode": "operator" } }\n';
    write(original); deploy(sdlc, { aiwg: { mode: 'shared' } });
    deploy(marketing, { aiwg: { mode: 'shared' } });
    deploy(sdlc, { aiwg: { mode: 'sdlc-updated' } });
    await remove(sdlc); expect(read().aiwg.mode).toBe('shared');
    await remove(marketing); expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(original);
  });
  it('keeps identical shared hook arrays until the last framework is removed', async () => {
    write({ hooks: { SessionStart: [operator] } });
    const deployed = { hooks: { SessionStart: [operator, hook('shared')] } };
    deploy(sdlc, deployed); deploy(marketing, deployed);
    await remove(sdlc); expect(read()).toEqual(deployed);
    await remove(marketing); expect(read()).toEqual({ hooks: { SessionStart: [operator] } });
  });
  it('preserves operator edits and records partial progress so retry converges', async () => {
    write({ hooks: { SessionStart: [operator] } });
    deploy(sdlc, { aiwg: { mode: 'sdlc', enabled: true }, hooks: { SessionStart: [operator, hook('sdlc')] } });
    const deployed = read();
    write({ ...deployed, aiwg: { ...deployed.aiwg, mode: 'custom' }, extra: 'operator' });
    const plan = await remove(sdlc);
    expect(read()).toEqual({ aiwg: { mode: 'custom' }, hooks: { SessionStart: [operator] }, extra: 'operator' });
    expect(plan.decisions).toContainEqual(expect.objectContaining({ pointer: '/aiwg/mode', action: 'preserve', reason: 'operator-edited settings value preserved' }));
    expect(Object.keys(receipt().settings)).toEqual(['/aiwg/mode']);
    const bytes = fs.readFileSync(settingsPath());
    await remove(sdlc); expect(fs.readFileSync(settingsPath())).toEqual(bytes);
    write({ ...read(), aiwg: { mode: 'sdlc' } });
    await remove(sdlc);
    expect(read()).toEqual({ hooks: { SessionStart: [operator] }, extra: 'operator' });
  });
  it('preserves and reports operator-added hooks across both framework removals', async () => {
    write({ hooks: { SessionStart: [operator] } });
    deploy(sdlc, { hooks: { SessionStart: [operator, hook('sdlc')] } });
    deploy(marketing, { hooks: { SessionStart: [operator, hook('sdlc'), hook('marketing')] } });
    const added = hook('operator-added');
    write({ hooks: { SessionStart: [...read().hooks.SessionStart, added] } });
    const first = await remove(marketing);
    expect(first.decisions.some(item => item.reason.includes('operator-edited array entries preserved'))).toBe(true);
    expect(read().hooks.SessionStart).toEqual([operator, hook('sdlc'), added]);
    await remove(sdlc);
    expect(read().hooks.SessionStart).toEqual([operator, added]);
  });
  it('keeps edited hook entries and retries only the unresolved contribution', async () => {
    write({ hooks: { SessionStart: [operator] } });
    deploy(sdlc, { hooks: { SessionStart: [operator, hook('one'), hook('two')] } });
    write({ hooks: { SessionStart: [operator, hook('edited'), hook('two')] } });
    const plan = await remove(sdlc);
    expect(plan.decisions.some(item => item.action === 'preserve' && item.reason.includes('operator-edited hook'))).toBe(true);
    expect(read().hooks.SessionStart).toEqual([operator, hook('edited')]);
    expect(receipt().settings['/hooks/SessionStart'].contributions.map((item: any) => item.value)).toEqual([hook('one')]);
    write({ hooks: { SessionStart: [operator, hook('one')] } });
    await remove(sdlc); expect(read()).toEqual({ hooks: { SessionStart: [operator] } });
  });
  it('restores replaced array entries and parent shapes from verified preimages', async () => {
    const original = '{ "hooks": null, "permissions": ["operator"] }\n';
    write(original);
    deploy(sdlc, { hooks: { SessionStart: [hook('sdlc')] }, permissions: ['aiwg'] });
    await remove(sdlc);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(original);
  });
  it.each([false, true])('recovers a formatting-only deploy while preserving later operator edits: %s', async edited => {
    const original = '{  "theme": "operator"  }\n';
    write(original); deploy(sdlc, { theme: 'operator' });
    expect(receipt().owners).toEqual([sdlc]);
    expect(receipt().settings).toEqual({});
    if (edited) write({ theme: 'custom' });
    const plan = await remove(sdlc);
    if (edited) {
      expect(read()).toEqual({ theme: 'custom' });
      expect(plan.decisions.some(item => item.action === 'preserve' && item.reason.includes('settings bytes preserved'))).toBe(true);
      expect(receipt().owners).toEqual([sdlc]);
    } else expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(original);
  });
  it('keeps an operator deletion of an unrelated setting when pruning its parent', async () => {
    write({ aiwg: { operator: 'original' } });
    deploy(sdlc, { aiwg: { operator: 'original', mode: 'sdlc' } });
    write({ aiwg: { mode: 'sdlc' } });
    await remove(sdlc); expect(read()).toEqual({ aiwg: {} });
  });
  it('recovers legacy leaf receipts while keeping unverifiable parent containers', async () => {
    write({ aiwg: {} }); deploy(sdlc, { aiwg: { mode: 'sdlc' } });
    const manifestFile = path.join(root, '.claude/.aiwg-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    delete manifest.managed['settings.json'].settingsPreimage;
    write(manifest, '.claude/.aiwg-manifest.json');
    await remove(sdlc); expect(read()).toEqual({ aiwg: {} });
  });
  it('preserves invalid settings and unverifiable or conflicting receipts', async () => {
    deploy(sdlc, { aiwg: { mode: 'sdlc' } });
    write('invalid JSON');
    let plan = planDeploymentRemoval(root, 'claude', sdlc);
    expect(plan.decisions.some(item => item.reason.includes('invalid settings'))).toBe(true);
    expect(plan.writes.some(item => item.path === settingsPath())).toBe(false);
    write({ aiwg: { mode: 'sdlc' } });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude/.aiwg-manifest.json'), 'utf8'));
    manifest.managed['settings.json'].settings['/aiwg/mode'].previous = { unverifiable: true };
    write(manifest, '.claude/.aiwg-manifest.json');
    plan = planDeploymentRemoval(root, 'claude', sdlc);
    expect(plan.decisions.some(item => item.reason.includes('unverifiable settings'))).toBe(true);
    write({ scope: 'project', managed: { '.claude/settings.json': manifest.managed['settings.json'] } }, '.aiwg/.aiwg-manifest.json');
    plan = planDeploymentRemoval(root, 'claude', sdlc);
    expect(plan.decisions.some(item => item.reason.includes('conflicting'))).toBe(true);
    expect(plan.writes.some(item => item.path === settingsPath())).toBe(false);
  });
  it('rolls back deleted files, settings, and receipts when a settings write fails after truncation', async () => {
    write({ theme: 'operator' });
    const before = captureDeploymentOutputs([path.join(root, '.claude')]);
    write('agent', '.claude/agents/demo.md');
    write({ theme: 'operator', aiwg: { mode: 'sdlc' } });
    recordDeploymentOutputs(before, [path.join(root, '.claude')], { frameworkSlug: sdlc });
    const snapshot = captureDeploymentOutputs([path.join(root, '.claude')]);
    const plan = planDeploymentRemoval(root, 'claude', sdlc);
    // Apply file deletions before settings to prove the shared rollback boundary.
    plan.writes.sort((a, b) => Number(a.path === settingsPath()) - Number(b.path === settingsPath()));
    const originalWrite = fs.writeFileSync;
    let injected = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file) === settingsPath() && !injected) {
        injected = true; originalWrite(file, 'truncated'); throw new Error('settings restore fault');
      }
      return originalWrite(file, data, options);
    });
    let message = '';
    try { await applyRemovalTransaction(plan.writes); } catch (error) { message = String(error); }
    expect(injected).toBe(true); expect(message).toContain('All changes rolled back');
    expect(captureDeploymentOutputs([path.join(root, '.claude')])).toEqual(snapshot);
    const journal = message.match(/Recovery preimages and record: (.*)$/)![1];
    fs.rmSync(path.dirname(journal), { recursive: true, force: true });
  });
  it.each([undefined, '{}\n', '{ "hooks": {}, "aiwg": {} }\n', '// original comment\n{ "theme": "operator" }\n'])('restores original bytes or absence: %s', async original => {
    if (original !== undefined) write(original);
    const value = original?.includes('theme') ? { theme: 'operator' } : original?.includes('hooks') ? { hooks: {}, aiwg: {} } : {};
    deploy(sdlc, { ...value, aiwg: { mode: 'sdlc' }, hooks: { SessionStart: [hook('sdlc')] } });
    await remove(sdlc);
    if (original === undefined) expect(fs.existsSync(settingsPath())).toBe(false);
    else expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(original);
  });
  it.each([['config.toml', 'theme = "operator"\n', 'theme = "operator"\n[hooks]\nmode = "aiwg"\n', 'theme = "custom"\n[hooks]\nmode = "aiwg"\n'],
    ['settings.yaml', '# retained comment\ntheme: operator\n', '# retained comment\ntheme: operator\nhooks:\n  mode: aiwg\n', '# retained comment\ntheme: custom\nhooks:\n  mode: aiwg\n']])('preserves operator values while rendering native edits in %s', async (name, original, deployed, edited) => {
    write(original, `.claude/${name}`); deploy(sdlc, deployed, `.claude/${name}`);
    write(edited, `.claude/${name}`); await remove(sdlc);
    const bytes = fs.readFileSync(path.join(root, '.claude', name));
    expect(parseSettings(name, bytes)).toEqual({ theme: 'custom' });
    if (name.endsWith('.yaml')) expect(bytes.toString()).toContain('# retained comment');
  });
  it.each(['config.toml', 'settings.yaml'])('uses semantic rendering after a comment-only operator edit in %s', async name => {
    const original = name.endsWith('.yaml') ? '# original\ntheme: operator\n' : '# original\ntheme = "operator"\n';
    const deployed = original + (name.endsWith('.yaml') ? 'hooks:\n  mode: aiwg\n' : '[hooks]\nmode = "aiwg"\n');
    write(original, `.claude/${name}`); deploy(sdlc, deployed, `.claude/${name}`);
    write(deployed.replace('# original', '# operator comment edit'), `.claude/${name}`);
    await remove(sdlc);
    const bytes = fs.readFileSync(path.join(root, '.claude', name));
    expect(parseSettings(name, bytes)).toEqual({ theme: 'operator' });
    expect(bytes.toString()).not.toBe(original);
    expect(bytes.toString()).not.toContain('# original');
    if (name.endsWith('.yaml')) expect(bytes.toString()).toContain('# operator comment edit');
  });
  it.each([['config.toml', '# original\ntheme = "operator"\n', 'theme = "operator"\n[hooks]\nmode = "aiwg"\n'],
    ['settings.yaml', '# original\ntheme: operator\n', 'theme: operator\nhooks:\n  mode: aiwg\n']])('recovers native settings bytes for %s', async (name, original, deployed) => {
    write(original, `.claude/${name}`); deploy(sdlc, deployed, `.claude/${name}`);
    await remove(sdlc); expect(fs.readFileSync(path.join(root, '.claude', name), 'utf8')).toBe(original);
  });
});
