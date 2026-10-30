import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error provider tool module has no TypeScript declaration
import { deployFiles, updateSidecarManifest } from '../../../tools/agents/providers/base.mjs';
import { ContextWriteJournal, writeContextFileSync } from '../../../src/smiths/context-pipeline/context-file-safety.js';
import { recordManagedCommands } from '../../../src/plugin/command-ownership.js';
import { collectOwnedDirectory } from '../../../src/providers/transformation-receipt-outputs.js';
import { mirrorArtifactDir } from '../../../src/cli/user-scope-mirror.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';

let root: string;
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const write = (name: string, value: unknown) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const receipt = (dir = '') => JSON.parse(fs.readFileSync(path.join(root, dir, '.aiwg-manifest.json'), 'utf8'));
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-ownership-')); });
afterEach(() => { fs.rmSync(root, { force: true, recursive: true }); });
const record = (before: Map<string, Buffer>, mode = 'sdlc') => recordDeploymentOutputs(before, [root], { mode });

describe('deploy-wide sidecar ownership', () => {
  it.each([false, true])('reports unresolved ownership without claiming outputs (onlyDeclared=%s)', onlyDeclared => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = captureDeploymentOutputs([root]);
    write('agents/new.md', 'new');
    if (onlyDeclared) write('agents/.aiwg-manifest.json', { managed: { 'new.md': { hash: digest('new') } } });
    recordDeploymentOutputs(before, [root], { onlyDeclared });
    expect(warning).toHaveBeenCalledWith(`Ownership not recorded for ${path.join(root, 'agents/new.md')}: no framework owner resolved.`);
    if (onlyDeclared) expect(receipt('agents').managed['new.md'].owners).toBeUndefined();
    else expect(fs.existsSync(path.join(root, 'agents/.aiwg-manifest.json'))).toBe(false);
  });

  it('uses a declared source owner for settings when invocation ownership is unresolved', () => {
    const before = captureDeploymentOutputs([root]);
    write('settings.json', { aiwg: { enabled: true } });
    write('.aiwg-manifest.json', { managed: { 'settings.json': {
      hash: digest(JSON.stringify({ aiwg: { enabled: true } })), frameworkSlug: 'custom-bundle',
    } } });
    recordDeploymentOutputs(before, [root]);
    expect(receipt().managed['settings.json'].settings['/aiwg/enabled'].owners).toEqual(['custom-bundle']);
  });

  it('records every newly written output with its exact digest, including binary assets', () => {
    const before = captureDeploymentOutputs([root]);
    for (const name of ['agents/one.md', 'commands/run.md', 'rules/core.md', 'hooks/run.cjs', 'skills/demo/SKILL.md', 'AGENTS.md']) write(name, name);
    fs.writeFileSync(path.join(root, 'skills/demo/image.bin'), Buffer.from([0, 255, 128]));
    record(before);
    for (const name of ['agents/one.md', 'commands/run.md', 'rules/core.md', 'hooks/run.cjs', 'skills/demo/SKILL.md', 'AGENTS.md', 'skills/demo/image.bin']) {
      expect(receipt(path.dirname(name)).managed[path.basename(name)]).toMatchObject({
        hash: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}`,
        owners: ['sdlc-complete'],
      });
    }
  });

  it('uses durable identity for generated rule indexes across redeploys', () => {
    let before = captureDeploymentOutputs([root]); write('rules/RULES-INDEX.md', 'index');
    write('rules/.aiwg-manifest.json', { managed: { 'RULES-INDEX.md': { hash: digest('index'), sourcePath: path.join(root, 'assembly-one/RULES-INDEX.md') } } }); record(before);
    const original = receipt('rules');
    before = captureDeploymentOutputs([root]);
    write('rules/.aiwg-manifest.json', { managed: { 'RULES-INDEX.md': { hash: digest('index'), sourcePath: path.join(root, 'assembly-two/RULES-INDEX.md') } } }); record(before);
    expect(receipt('rules')).toEqual(original);
    expect(receipt('rules').managed['RULES-INDEX.md'].sourcePath).toBeUndefined();
  });

  it('renders the same final context on first deployment and redeployment', async () => {
    const { generate } = await import('../../../src/smiths/context-pipeline/generator.js');
    const options = { provider: 'claude' as const, projectPath: root, sections: [], detectExistingFiles: true };
    await generate(options);
    const first = fs.readFileSync(path.join(root, 'AIWG.md'), 'utf8');
    await generate(options);
    expect(fs.readFileSync(path.join(root, 'AIWG.md'), 'utf8')).toBe(first);
  });

  it('refreshes final context digests and rolls receipts back with the context', () => {
    const before = captureDeploymentOutputs([root]); write('AIWG.md', 'initial');
    recordDeploymentOutputs(before, [root], { target: root, mode: 'sdlc' });
    const original = receipt('.aiwg');
    const journal = new ContextWriteJournal();
    try {
      writeContextFileSync(path.join(root, 'AIWG.md'), 'bound');
      recordDeploymentOutputs(captureDeploymentOutputs([root]), [root], { target: root, mode: 'marketing', writtenFiles: [path.join(root, 'AIWG.md')], writeReceipt: writeContextFileSync });
      writeContextFileSync(path.join(root, 'AIWG.md'), 'final');
      expect(receipt('.aiwg').managed['AIWG.md']).toMatchObject({ hash: digest('final'), owners: ['media-marketing-kit', 'sdlc-complete'] });
      expect(journal.rollback().conflicts).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'AIWG.md'), 'utf8')).toBe('initial');
      expect(receipt('.aiwg')).toEqual(original);
    } finally { journal.dispose(); }
  });

  it.each(['directory', 'file'])('never follows a context receipt %s symlink', kind => {
    write('AIWG.md', 'initial');
    const metadata = { scope: 'project', managed: { 'AIWG.md': { hash: digest('initial'), owners: ['sdlc-complete'] } } };
    write('outside/.aiwg-manifest.json', metadata);
    if (kind === 'directory') fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.aiwg'));
    else {
      fs.mkdirSync(path.join(root, '.aiwg'));
      fs.symlinkSync(path.join(root, 'outside/.aiwg-manifest.json'), path.join(root, '.aiwg/.aiwg-manifest.json'));
    }
    writeContextFileSync(path.join(root, 'AIWG.md'), 'final');
    expect(receipt('outside')).toEqual(metadata);
  });

  it('does not refresh unrecorded or operator-edited context ownership', () => {
    writeContextFileSync(path.join(root, 'AIWG.md'), 'unrecorded');
    expect(fs.existsSync(path.join(root, '.aiwg/.aiwg-manifest.json'))).toBe(false);
    const before = captureDeploymentOutputs([root]); write('AIWG.md', 'owned');
    recordDeploymentOutputs(before, [root], { target: root, mode: 'sdlc' });
    const original = receipt('.aiwg'); write('AIWG.md', 'operator edit');
    writeContextFileSync(path.join(root, 'AIWG.md'), 'merged final');
    expect(receipt('.aiwg')).toEqual(original);
  });

  it('records the source extension owner instead of the generic all mode', () => {
    const before = captureDeploymentOutputs([root]); write('agents/extension.md', 'extension');
    recordDeploymentOutputs(before, [root], { mode: 'all', srcRoot: path.join(root, 'agentic/code/extensions/sys') });
    expect(receipt('agents').managed['extension.md'].owners).toEqual(['sys']);
  });

  it('keeps wrapper source identity before subsequent binding and recording', async () => {
    write('skills/demo/SKILL.md', 'skill');
    write('skills/demo/.aiwg-manifest.json', { managed: { 'SKILL.md': { hash: digest('skill'), frameworkSlug: 'aiwg-utils', owners: ['aiwg-utils'] } } });
    write('commands/demo.md', 'wrapper');
    await recordManagedCommands(path.join(root, 'commands'), [{ filename: 'demo.md', content: 'wrapper', sourcePath: path.join(root, 'skills/demo/SKILL.md') }], '1', 'bundled');
    let before = captureDeploymentOutputs([root]);
    recordDeploymentOutputs(before, [root], { mode: 'sdlc', writtenFiles: [path.join(root, 'commands/demo.md')] });
    const first = receipt('commands');
    before = captureDeploymentOutputs([root]);
    recordDeploymentOutputs(before, [root], { mode: 'marketing', writtenFiles: [path.join(root, 'commands/demo.md')] });
    expect(receipt('commands')).toEqual(first);
    expect(first.managed['demo.md'].owners).toEqual(['aiwg-utils']);
  });

  it('records root files in project-scoped sidecars without adding root dotfiles', async () => {
    const before = captureDeploymentOutputs([root]); write('AGENTS.md', 'context'); write('opencode.json', { aiwg: true });
    recordDeploymentOutputs(before, [root], { target: root, mode: 'sdlc' });
    expect(fs.existsSync(path.join(root, '.aiwg-manifest.json'))).toBe(false);
    expect(receipt('.aiwg')).toMatchObject({ scope: 'project', managed: { 'AGENTS.md': { hash: digest('context'), owners: ['sdlc-complete'] } } });
    const first = receipt('.aiwg');
    recordDeploymentOutputs(captureDeploymentOutputs([root]), [root], { target: root, mode: 'sdlc', writtenFiles: [path.join(root, 'AGENTS.md')] });
    expect(receipt('.aiwg')).toEqual(first);
    const outputs = new Set<string>();
    await collectOwnedDirectory(path.join(root, '.aiwg'), [], outputs, root);
    expect(outputs.has(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(outputs.has(path.join(root, 'opencode.json'))).toBe(true);
    const unchanged = captureDeploymentOutputs([root]);
    write('.aiwg/.aiwg-manifest.json', { ...first, managed: { ...first.managed, '../escape.md': { hash: digest('escape') } } });
    recordDeploymentOutputs(unchanged, [root], { target: root, mode: 'marketing' });
    expect(receipt('.aiwg').managed['../escape.md'].owners).toBeUndefined();
  });

  it('keeps both owners of identical emitted files and is idempotent', () => {
    let before = captureDeploymentOutputs([root]);
    write('agents/shared.md', 'shared');
    write('agents/.aiwg-manifest.json', { managed: { 'shared.md': { hash: digest('shared') } } });
    record(before);
    before = captureDeploymentOutputs([root]);
    // Existing writer emits its own receipt even when it skips identical bytes.
    write('agents/.aiwg-manifest.json', { managed: { 'shared.md': { hash: digest('shared') } } });
    record(before, 'marketing');
    expect(receipt('agents').managed['shared.md'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
    const previous = fs.readFileSync(path.join(root, 'agents/.aiwg-manifest.json'), 'utf8');
    before = captureDeploymentOutputs([root]);
    record(before, 'marketing');
    expect(fs.readFileSync(path.join(root, 'agents/.aiwg-manifest.json'), 'utf8')).toBe(previous);
  });

  it('preserves source identity when a legacy writer emits only an unchanged hash', () => {
    let before = captureDeploymentOutputs([root]); write('agents/one.md', 'one');
    write('agents/.aiwg-manifest.json', { managed: { 'one.md': { hash: digest('one'), frameworkSlug: 'sdlc-complete', sourcePath: path.join(root, 'source/one.md') } } }); record(before);
    const original = receipt('agents');
    before = captureDeploymentOutputs([root]);
    write('agents/.aiwg-manifest.json', { managed: { 'one.md': { hash: digest('one') } } }); record(before);
    expect(receipt('agents')).toEqual(original);
  });

  it('records generated skill resources in the existing skill-root receipt', () => {
    let before = captureDeploymentOutputs([root]); write('skills/demo/SKILL.md', 'skill'); record(before);
    before = captureDeploymentOutputs([root]); write('skills/demo/agents/openai.yaml', 'name: demo'); record(before);
    expect(receipt('skills/demo').managed['agents/openai.yaml']).toMatchObject({ hash: digest('name: demo'), owners: ['sdlc-complete'] });
    expect(fs.existsSync(path.join(root, 'skills/demo/agents/.aiwg-manifest.json'))).toBe(false);
  });

  it('preserves shared-writer source identity before the rule binder reads its receipt', () => {
    const source = path.join(root, 'agentic/code/frameworks/sdlc-complete/agents/one.md');
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'one');
    const destination = path.join(root, 'deployed'); fs.mkdirSync(destination);
    deployFiles([source], destination, { deployVersion: '1' });
    const first = receipt('deployed').managed['one.md'];
    updateSidecarManifest(destination, [{ filename: 'one.md', hash: first.hash.slice(7) }], { version: '1' });
    expect(receipt('deployed').managed['one.md']).toEqual(first);
    expect(first).toMatchObject({ sourcePath: source, frameworkSlug: 'sdlc-complete', owners: ['sdlc-complete'] });
  });

  it('records logical framework identity when the writer consumes a frozen source path', () => {
    const frozen = path.join(root, 'frozen/one.md'); write('frozen/one.md', 'one');
    const logical = path.join(root, 'agentic/code/frameworks/sdlc-complete/agents/one.md');
    fs.mkdirSync(path.join(root, 'deployed'));
    deployFiles([frozen], path.join(root, 'deployed'), { deployVersion: '1', logicalInputPath: () => logical });
    expect(receipt('deployed').managed['one.md']).toMatchObject({ frameworkSlug: 'sdlc-complete', owners: ['sdlc-complete'] });
  });

  it('does not add a shared writer for an edited file skipped by its desired hash', () => {
    const first = path.join(root, 'agentic/code/frameworks/sdlc-complete/agents/one.md');
    const second = path.join(root, 'agentic/code/frameworks/media-marketing-kit/agents/one.md');
    for (const source of [first, second]) { fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'one'); }
    const destination = path.join(root, 'deployed'); fs.mkdirSync(destination); deployFiles([first], destination, { deployVersion: '1' });
    const original = receipt('deployed'); fs.writeFileSync(path.join(destination, 'one.md'), 'operator edit');
    deployFiles([second], destination, { deployVersion: '1' });
    expect(receipt('deployed')).toEqual(original);
    expect(fs.readFileSync(path.join(destination, 'one.md'), 'utf8')).toBe('operator edit');
  });

  it('retains recorded owners when another framework replaces the file content', () => {
    let before = captureDeploymentOutputs([root]); write('agents/shared.md', 'first'); record(before);
    before = captureDeploymentOutputs([root]); write('agents/shared.md', 'second'); record(before, 'marketing');
    expect(receipt('agents').managed['shared.md'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
    expect(receipt('agents').managed['shared.md'].hash).toBe(digest('second'));
  });

  it('records settings leaves, overwritten preimages and only new array contributions', () => {
    write('settings.json', { theme: 'operator', mode: 'old', hooks: { PreToolUse: [{ hooks: ['operator'] }] } });
    const before = captureDeploymentOutputs([root]);
    write('settings.json', { theme: 'operator', mode: 'sdlc', attribution: { commit: 'AIWG' }, hooks: { PreToolUse: [{ hooks: ['operator'] }, { hooks: ['aiwg'] }] } });
    record(before);
    const settings = receipt().managed['settings.json'].settings;
    expect(settings['/theme']).toBeUndefined();
    expect(settings['/mode']).toMatchObject({ hash: digest('"sdlc"'), value: 'sdlc', previous: { present: true, value: 'old' } });
    expect(settings['/attribution/commit']).toMatchObject({ previous: { present: false }, owners: ['sdlc-complete'] });
    expect(settings['/hooks/PreToolUse'].contributions).toEqual([{ hash: digest('{"hooks":["aiwg"]}'), value: { hooks: ['aiwg'] }, owners: ['sdlc-complete'] }]);
  });

  it('retains recorded resources omitted by a legacy receipt writer on redeploy', () => {
    let before = captureDeploymentOutputs([root]); write('skills/demo/SKILL.md', 'skill');
    write('skills/demo/.aiwg-managed', 'aiwg'); record(before);
    const original = receipt('skills/demo');
    before = captureDeploymentOutputs([root]);
    write('skills/demo/.aiwg-manifest.json', { managed: { 'SKILL.md': { hash: digest('skill') } } });
    record(before);
    expect(receipt('skills/demo')).toEqual(original);
  });

  it('preserves the first settings preimage across redeploys', () => {
    write('settings.json', { mode: 'operator' });
    let before = captureDeploymentOutputs([root]); write('settings.json', { mode: 'sdlc' }); record(before);
    before = captureDeploymentOutputs([root]); write('settings.json', { mode: 'marketing' }); record(before, 'marketing');
    const setting = receipt().managed['settings.json'].settings['/mode'];
    expect(setting.previous).toEqual({ present: true, value: 'operator' });
    expect(setting.contributions.map((entry: any) => [entry.value, entry.owners])).toEqual([['sdlc', ['sdlc-complete']], ['marketing', ['media-marketing-kit']]]);
  });

  it('distinguishes an operator-deleted key from a previously owned null value', () => {
    write('settings.json', { mode: 'operator' });
    let before = captureDeploymentOutputs([root]); write('settings.json', { mode: null }); record(before);
    write('settings.json', {});
    before = captureDeploymentOutputs([root]); write('settings.json', { mode: 'marketing' }); record(before, 'marketing');
    const setting = receipt().managed['settings.json'].settings['/mode'];
    expect(setting.previous).toEqual({ present: false });
    expect(setting.owners).toEqual(['media-marketing-kit']);
  });

  it('retains both owners of a generated aggregate when another framework contributes', () => {
    let before = captureDeploymentOutputs([root]); write('AGENTS.md', 'sdlc'); record(before);
    before = captureDeploymentOutputs([root]); write('AGENTS.md', 'sdlc and marketing'); record(before, 'marketing');
    expect(receipt().managed['AGENTS.md'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
    expect(receipt().managed['AGENTS.md'].hash).toBe(digest('sdlc and marketing'));
  });

  it('retains both framework owners when a generated rule index changes', () => {
    let before = captureDeploymentOutputs([root]); write('rules/RULES-INDEX.md', 'sdlc index'); record(before);
    before = captureDeploymentOutputs([root]); write('rules/RULES-INDEX.md', 'sdlc and marketing index');
    write('rules/.aiwg-manifest.json', { managed: { 'RULES-INDEX.md': { hash: digest('sdlc and marketing index') } } }); record(before, 'marketing');
    expect(receipt('rules').managed['RULES-INDEX.md'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
  });

  it.each([['config.toml', 'theme = "operator"\n', 'theme = "operator"\n[hooks]\nmode = "aiwg"\n'],
    ['settings.yaml', 'theme: operator\n', 'theme: operator\nhooks:\n  mode: aiwg\n']])('records settings keys in %s', (name, old, next) => {
    write(name, old); const before = captureDeploymentOutputs([root]); write(name, next); record(before);
    expect(receipt().managed[name].settings['/theme']).toBeUndefined();
    expect(receipt().managed[name].settings['/hooks/mode']).toMatchObject({ value: 'aiwg', previous: { present: false } });
  });

  it('records an opted-in Muse user settings contribution at its native XDG path', async () => {
    // @ts-expect-error provider tool module has no TypeScript declaration
    const { postDeploy } = await import('../../../tools/agents/providers/muse.mjs');
    const xdg = path.join(root, 'xdg');
    await postDeploy(root, { srcRoot: root, mode: 'marketing', contextFiles: false, scope: 'user',
      hooks: false, mcp: true, quiet: true, env: { XDG_CONFIG_HOME: xdg }, userHome: root });
    const settings = path.join(xdg, 'muse/settings.json');
    const record = JSON.parse(fs.readFileSync(path.join(xdg, 'muse/.aiwg-manifest.json'), 'utf8')).managed['settings.json'];
    expect(record.hash).toBe(digest(fs.readFileSync(settings, 'utf8')));
    expect(record.owners).toEqual(['media-marketing-kit']);
    expect(Object.keys(record.settings).some(key => key.startsWith('/mcp_servers/aiwg/'))).toBe(true);
  });

  it('merges successfully mirrored user files and excludes receipt metadata from counts', async () => {
    const content = '# aiwg:managed v1 bundled\none';
    const destination = path.join(root, 'native');
    for (const owner of ['sdlc-complete', 'media-marketing-kit', 'media-marketing-kit']) {
      write(`sources/${owner}/one.md`, content);
      write(`sources/${owner}/.aiwg-manifest.json`, { managed: { 'one.md': {
        hash: digest(content), kind: 'agent', frameworkSlug: owner, owners: [owner],
      } } });
      const result = await mirrorArtifactDir(path.join(root, 'sources', owner), destination);
      expect(result).toMatchObject({ count: 1, entries: ['one.md'] });
      expect(receipt('native').managed['one.md'].owners).toEqual(owner === 'sdlc-complete'
        ? ['sdlc-complete'] : ['media-marketing-kit', 'sdlc-complete']);
      expect(receipt('native').managed['one.md'].hash).toBe(digest(content));
    }
  });

  it('never claims a user artifact skipped because the operator owns it', async () => {
    write('source/one.md', '# aiwg:managed v1 bundled\nsource');
    write('source/.aiwg-manifest.json', { managed: { 'one.md': { hash: digest('source'), frameworkSlug: 'sdlc-complete', owners: ['sdlc-complete'] } } });
    write('native/one.md', 'operator');
    const result = await mirrorArtifactDir(path.join(root, 'source'), path.join(root, 'native'));
    expect(result).toMatchObject({ count: 0, entries: [] });
    expect(fs.readFileSync(path.join(root, 'native/one.md'), 'utf8')).toBe('operator');
    expect(fs.existsSync(path.join(root, 'native/.aiwg-manifest.json'))).toBe(false);
  });

  it('mirrors unrecorded legacy files without inventing a framework owner', async () => {
    write('source/one.md', '# aiwg:managed v1 bundled\nlegacy');
    const result = await mirrorArtifactDir(path.join(root, 'source'), path.join(root, 'native'));
    expect(result.count).toBe(1);
    expect(fs.existsSync(path.join(root, 'native/.aiwg-manifest.json'))).toBe(false);
  });

  it('retains both recorded owners when mirroring skill directories', async () => {
    for (const owner of ['sdlc-complete', 'media-marketing-kit']) {
      write(`${owner}/demo/SKILL.md`, 'skill'); write(`${owner}/demo/.aiwg-managed`, 'aiwg\n');
      write(`${owner}/demo/.aiwg-manifest.json`, { managed: { 'SKILL.md': {
        hash: digest('skill'), kind: 'skill', frameworkSlug: owner, owners: [owner],
      } } });
      expect((await mirrorArtifactDir(path.join(root, owner), path.join(root, 'native'))).count).toBe(1);
    }
    expect(receipt('native/demo').managed['SKILL.md'].owners).toEqual(['media-marketing-kit', 'sdlc-complete']);
  });

  it('does not adopt operator settings carried through a JSONC merge', () => {
    write('settings.json', '{ // operator comment\n"theme": "operator", "url": "https://example.test" }');
    const before = captureDeploymentOutputs([root]);
    write('settings.json', { theme: 'operator', url: 'https://example.test', aiwg: { enabled: true } }); record(before);
    expect(Object.keys(receipt().managed['settings.json'].settings)).toEqual(['/aiwg/enabled']);
  });

  it('records explicit identical hook writes without adopting adjacent legacy files', () => {
    write('hooks/aiwg.cjs', 'same'); write('hooks/operator.cjs', 'operator');
    const before = captureDeploymentOutputs([root]);
    recordDeploymentOutputs(before, [root], { mode: 'sdlc', writtenFiles: [path.join(root, 'hooks/aiwg.cjs')] });
    expect(receipt('hooks').managed['aiwg.cjs']).toMatchObject({ hash: digest('same'), owners: ['sdlc-complete'] });
    expect(receipt('hooks').managed['operator.cjs']).toBeUndefined();
  });

  it('leaves unrecorded legacy and operator files unclaimed', () => {
    write('agents/legacy.md', 'legacy'); write('agents/operator.md', 'operator');
    const before = captureDeploymentOutputs([root]); write('agents/new.md', 'new'); record(before);
    expect(Object.keys(receipt('agents').managed)).toEqual(['new.md']);
  });

  it('does not bless edited files using mismatching emitted digests', () => {
    write('agents/edited.md', 'operator edit');
    const before = captureDeploymentOutputs([root]);
    write('agents/.aiwg-manifest.json', { managed: { 'edited.md': { hash: digest('original') } } }); record(before);
    expect(receipt('agents').managed['edited.md'].owners).toBeUndefined();
  });

  it('rejects escaping sidecar entries even when their targets are in another captured root', () => {
    write('one/keep.md', 'one'); write('two/file.md', 'two');
    const before = captureDeploymentOutputs([root]);
    write('one/.aiwg-manifest.json', { managed: { '../two/file.md': { hash: digest('two') } } });
    record(before);
    expect(receipt('one').managed['../two/file.md'].owners).toBeUndefined();
  });

  it('does not follow symlinks while capturing output files', () => {
    write('real/file.md', 'real');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    expect([...captureDeploymentOutputs([root]).keys()].some(file => file.startsWith(path.join(root, 'link') + path.sep))).toBe(false);
  });

  it('ignores symlinks and escaping receipt paths, and dry-run writes no receipts', () => {
    const outside = path.join(os.tmpdir(), 'nonexistent-aiwg-ownership-target');
    fs.symlinkSync(outside, path.join(root, 'link'));
    const before = captureDeploymentOutputs([root]); write('new.md', 'new');
    recordDeploymentOutputs(before, [root], { dryRun: true, mode: 'sdlc' });
    expect(fs.existsSync(path.join(root, '.aiwg-manifest.json'))).toBe(false);
    write('.aiwg-manifest.json', { managed: { '../escape': { hash: digest('outside') } } }); record(before);
    expect(receipt().managed['../escape'].owners).toBeUndefined();
  });
});
