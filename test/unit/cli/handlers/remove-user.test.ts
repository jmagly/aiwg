// User removal checks existing manifests before deleting recorded names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_SCOPE_PATHS } from '../../../../src/cli/scope-resolver.js';
import { writeUserRegistry } from '../../../../src/config/user-registry.js';
import { removeUserScopeDeploy } from '../../../../src/cli/handlers/remove-user.js';

let root: string;
const provider = 'codex';
const original = { ...USER_SCOPE_PATHS[provider] };
const kinds = ['agents', 'commands', 'rules', 'behaviors'] as const;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const target = (kind: typeof kinds[number]) => path.join(USER_SCOPE_PATHS[provider][kind], 'demo.md');
const run = (dry = false) => removeUserScopeDeploy(['sdlc', '--provider', provider, ...(dry ? ['--dry-run'] : [])]);
async function registry(shared = false) {
  const entry = { version: 'test', source: 'bundled' as const, installedAt: '2026-10-30T00:00:00Z', deployedTo: {
    [provider]: { agents: 1, commands: 1, rules: 1, skills: 0,
      entries: Object.fromEntries(kinds.map(kind => [kind, ['demo.md']])) },
  } };
  await writeUserRegistry({ version: '1', installed: { sdlc: entry, ...(shared ? { marketing: structuredClone(entry) } : {}) } });
}
function receipt(kind: typeof kinds[number], owners = ['sdlc-complete']) {
  fs.writeFileSync(path.join(USER_SCOPE_PATHS[provider][kind], '.aiwg-manifest.json'), JSON.stringify({ managed: {
    'demo.md': { hash: hash('deployed'), owners },
  } }));
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-remove-user-'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(root, 'installed.json'));
  for (const kind of kinds) {
    USER_SCOPE_PATHS[provider][kind] = path.join(root, kind);
    fs.mkdirSync(USER_SCOPE_PATHS[provider][kind]);
    fs.writeFileSync(target(kind), 'deployed');
    receipt(kind);
  }
  await registry();
});
afterEach(() => {
  Object.assign(USER_SCOPE_PATHS[provider], original);
  vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});

describe('user-scope manifest safeguards', () => {
  it.each(kinds)('keeps and reports an operator edit to %s in preview and real removal', async kind => {
    fs.writeFileSync(target(kind), 'operator edit');
    for (const dry of [true, false]) {
      const result = await run(dry);
      expect(result.exitCode, result.message).toBe(0);
      expect(result.message).toContain(`preserve ${target(kind)} — modified or unverifiable managed file`);
      expect(fs.readFileSync(target(kind), 'utf8')).toBe('operator edit');
    }
  });
  it('removes unchanged files whose digests match', async () => {
    const preview = await run(true);
    expect(preview.message).not.toContain('legacy manifest');
    for (const kind of kinds) expect(fs.existsSync(target(kind))).toBe(true);
    expect((await run()).exitCode).toBe(0);
    for (const kind of kinds) expect(fs.existsSync(target(kind))).toBe(false);
  });
  it('keeps names another installed framework still records even without a digest receipt', async () => {
    await registry(true);
    for (const kind of kinds) fs.unlinkSync(path.join(USER_SCOPE_PATHS[provider][kind], '.aiwg-manifest.json'));
    for (const dry of [true, false]) {
      const result = await run(dry);
      for (const kind of kinds) {
        expect(result.message).toContain(`preserve ${target(kind)} — shared with another installed framework`);
        expect(fs.readFileSync(target(kind), 'utf8')).toBe('deployed');
      }
    }
  });
  it('keeps names with another owner in the provider manifest', async () => {
    for (const kind of kinds) receipt(kind, ['sdlc-complete', 'media-marketing-kit']);
    const result = await run();
    expect(result.message).toContain('shared with another installed framework');
    for (const kind of kinds) expect(fs.existsSync(target(kind))).toBe(true);
  });
  it('retains legacy name-based deletion and explicitly reports the missing digest', async () => {
    for (const kind of kinds) {
      fs.unlinkSync(path.join(USER_SCOPE_PATHS[provider][kind], '.aiwg-manifest.json'));
      fs.writeFileSync(target(kind), 'legacy content');
    }
    expect((await run(true)).message).toContain('legacy manifest has no digest; would remove by recorded name');
    for (const kind of kinds) expect(fs.existsSync(target(kind))).toBe(true);
    expect((await run()).message).toContain('legacy manifest has no digest; removing by recorded name');
    for (const kind of kinds) expect(fs.existsSync(target(kind))).toBe(false);
  });
});
