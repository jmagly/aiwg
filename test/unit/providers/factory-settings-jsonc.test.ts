import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripJsonComments } from '../../../tools/agents/providers/base.mjs';
import { deployFactoryHooks, enableFactoryCustomDroids } from '../../../tools/agents/providers/factory.mjs';

// ~/.factory/settings.json is user-global and is written back after parsing,
// so comment stripping must never alter data inside JSON strings.
let home: string;
let savedHome: string | undefined;

const operatorSettings = {
  matcherGlob: 'src/**/*.ts',
  mcpServers: { docs: { url: 'https://mcp.example.com/sse' } },
  escaped: 'quote \\" then //not-a-comment',
};

function settingsPath(): string {
  return path.join(home, '.factory', 'settings.json');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-factory-jsonc-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
  const serialized = JSON.stringify(operatorSettings, null, 2);
  fs.writeFileSync(
    settingsPath(),
    `// operator settings\n${serialized.slice(0, 1)} /* block */${serialized.slice(1)}\n`,
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('stripJsonComments', () => {
  it('removes comments but keeps // and slash-star sequences inside strings', () => {
    const doc = '// note\n{ /* c */ "glob": "a/**/*.md", "url": "https://x.example/p", "q": "x\\"//y" }';
    expect(JSON.parse(stripJsonComments(doc))).toEqual({ glob: 'a/**/*.md', url: 'https://x.example/p', q: 'x"//y' });
  });

  it('round-trips comment delimiters in operator keys and values', () => {
    const settings = { '/* key */': '<!-- value -->', ...operatorSettings };
    const serialized = JSON.stringify(settings, null, 2);
    const doc = `// note\n${serialized.slice(0, 1)} /* block */${serialized.slice(1)}\n`;
    expect(JSON.parse(stripJsonComments(doc))).toEqual(settings);
  });
});

describe('Factory user settings writers', () => {
  it('deployFactoryHooks migrates managed hooks, preserving values and backing up comments', async () => {
    const settings = { ...operatorSettings, hooks: { SessionStart: [{ hooks: [
      { type: 'command', command: 'aiwg sync --dry-run --quiet' },
    ] }] } };
    fs.writeFileSync(settingsPath(), '// operator settings\n' + JSON.stringify(settings, null, 2));
    const original = fs.readFileSync(settingsPath(), 'utf8');
    await deployFactoryHooks(false);
    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    expect(written).toMatchObject(operatorSettings);
    expect(written.hooks).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, '.factory/hooks.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
    const backups = fs.readdirSync(path.dirname(settingsPath())).filter((name) => name.includes('.aiwg-backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(settingsPath()), backups[0]), 'utf8')).toBe(original);
  });

  it('deployFactoryHooks does not back up a file that is already canonical JSON', async () => {
    fs.writeFileSync(settingsPath(), `${JSON.stringify(operatorSettings, null, 2)}\n`);
    await deployFactoryHooks(false);
    expect(fs.readdirSync(path.dirname(settingsPath())).filter((name) => name.includes('.aiwg-backup-'))).toEqual([]);
  });

  it('enableFactoryCustomDroids keeps comments and preserves globs and URLs', () => {
    enableFactoryCustomDroids(false);
    const text = fs.readFileSync(settingsPath(), 'utf8');
    expect(text).toContain('// operator settings');
    expect(JSON.parse(stripJsonComments(text))).toMatchObject({ ...operatorSettings, enableCustomDroids: true });
  });
});
