// Receipt owners, rather than matching filenames, determine a recorded count.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { countRecordedFrameworkArtifacts, receiptIncludesOwner } from '../../../../src/cli/handlers/use-owned-counts.js';
import { countDeployedBundleFiles } from '../../../../src/cli/handlers/use-bundle-counts.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-counts-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(relative: string, content: string) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
function receipt(relative: string, owner: string) {
  write(path.join(path.dirname(relative), '.aiwg-manifest.json'), JSON.stringify({ managed: { [path.basename(relative)]: { owners: [owner] } } }));
}
it('requires a matching owner even when a same-name native file exists', async () => {
  const source = path.join(root, 'agentic/code/addons/example');
  write('agentic/code/addons/example/agents/shared.md', 'source');
  const file = write('.claude/agents/shared.md', 'operator edit');
  receipt('.claude/agents/shared.md', 'voice-framework');
  expect(await receiptIncludesOwner(file, new Set(['example']))).toBe(false);
  expect(await countDeployedBundleFiles(source, 'agents', root, '.claude/agents', ['.md'])).toBe(0);
  receipt('.claude/agents/shared.md', 'example');
  expect(await countDeployedBundleFiles(source, 'agents', root, '.claude/agents', ['.md'])).toBe(1);
  fs.rmSync(path.join(root, '.claude/agents/.aiwg-manifest.json'));
  expect(await countDeployedBundleFiles(source, 'agents', root, '.claude/agents', ['.md'])).toBe(0);
});
it('counts framework and implicit addon skills while keeping explicit bundle ownership separate', async () => {
  for (const [group, id] of [['frameworks', 'sdlc-complete'], ['addons', 'aiwg-utils'], ['addons', 'voice-framework']]) {
    write(`agentic/code/${group}/${id}/manifest.json`, '{}');
  }
  for (const [name, owner] of [['sdlc', 'sdlc-complete'], ['help', 'aiwg-utils'], ['edited-voice', 'voice-framework']]) {
    const relative = `.claude/skills/${name}/SKILL.md`; write(relative, 'bytes'); receipt(relative, owner);
  }
  write('.claude/skills/user/SKILL.md', 'user file');
  write('.aiwg/.aiwg-manifest.json', JSON.stringify({ bundleDeployments: { claude: { 'voice-framework': { copy: false } } } }));
  expect(await countRecordedFrameworkArtifacts(root, 'claude', 'sdlc', root, [])).toEqual({ agents: 0, commands: 0, skills: 2, rules: 0 });
  expect(await countRecordedFrameworkArtifacts(root, 'claude', 'sdlc', root, ['--no-utils'])).toEqual({ agents: 0, commands: 0, skills: 1, rules: 0 });
});
it('counts shared operator mirrors without adopting unrelated files from another framework', async () => {
  write('agentic/code/frameworks/media-marketing-kit/manifest.json', '{}');
  for (const name of ['flow-release', 'unrelated', 'flow-retired']) {
    const relative = `.claude/commands/${name}.md`;
    write(relative, 'wrapper');
  }
  const shared = 'agentic/code/frameworks/sdlc-complete/skills/flow-release/SKILL.md';
  write(shared, 'source');
  write('.claude/commands/.aiwg-manifest.json', JSON.stringify({ managed: {
    'flow-release.md': { owners: ['sdlc-complete'], kind: 'skill-command', sourcePath: path.join(root, shared) },
    'unrelated.md': { owners: ['sdlc-complete'], kind: 'command' },
    'flow-retired.md': { owners: ['sdlc-complete'], kind: 'skill-command', sourcePath: path.join(root, 'missing') },
  } }));
  expect(await countRecordedFrameworkArtifacts(root, 'claude', 'marketing', root, ['--no-utils'])).toEqual({ agents: 0, commands: 1, skills: 0, rules: 0 });
});
it('uses recorded skill identity for provider-specific command filenames', async () => {
  const source = write('agentic/code/frameworks/sdlc-complete/skills/flow-release/SKILL.md', 'source');
  const file = write('.github/prompts/flow-release.prompt.md', 'wrapper');
  write('.github/prompts/.aiwg-manifest.json', JSON.stringify({ managed: {
    'flow-release.prompt.md': { owners: ['sdlc-complete'], kind: 'skill-command', sourcePath: source },
  } }));
  expect(await receiptIncludesOwner(file, new Set(['media-marketing-kit']), root)).toBe(true);
});
