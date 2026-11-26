// Model preferences keep their models.json owner; config set/reset cannot mutate selection policy.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateJson } from '../../../src/models/config-writer.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { validateUserProjectModelConfig, WorkerSelectionPolicySchema } from '../../../src/models/provider-policy.js';
import { collectWorkerPolicyDiagnostics } from '../../../tools/cli/doctor-worker-policy.mjs';
import { main } from '../../../src/config/cli.js';

let root: string;
const key = 'defaults.workerSelection';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-selection-config-'));
  vi.stubEnv('AIWG_HOME', process.cwd()); vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const args = () => ['--project', '--target', root];
// Exercise the models.json owner with complete candidate validation, never the config CLI.
async function write(path: string, raw: string | undefined, _args: string[]): Promise<void> {
  await updateJson(join(root, 'models.json'), value => {
    value.defaults ??= {};
    if (path === key) {
      if (raw === undefined) delete value.defaults.workerSelection;
      else value.defaults.workerSelection = JSON.parse(raw);
    } else {
      value.defaults.workerSelection ??= {};
      const leaf = path.slice(key.length + 1);
      if (raw === undefined) delete value.defaults.workerSelection[leaf];
      else { try { value.defaults.workerSelection[leaf] = JSON.parse(raw); }
        catch { value.defaults.workerSelection[leaf] = raw; } }
    }
  }, false, async candidate => {
    await new ConfigLoader(root, { workerCandidate: { projectModels: candidate } }).load();
  });
}

describe('workerSelection preferences', () => {
  it.each(['', '.guards.deniedEfforts', '.mode', '.strategy', '.maxAutoTier', '.returnBudgetTokens', '.futureKey'])('rejects set/reset of model-owned %s without any writes', async suffix => {
    const bytes = '{"defaults":{"workerSelection":{"mode":"advisory"}}}\n';
    await writeFile(join(root, 'models.json'), bytes);
    for (const command of ['set', 'reset']) {
      await expect(main([command, `${key}${suffix}`, ...(command === 'set' ? ['{}'] : []), ...args()]))
        .rejects.toMatchObject({ code: 'ERR_INVALID_KEY', message: expect.stringContaining('models.json') });
      expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(bytes);
      await expect(readFile(join(root, '.aiwg/aiwg.config'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('reads model-owned preferences through the public config handler without aiwg.config', async () => {
    await write(`${key}.mode`, 'off', args());
    vi.mocked(console.log).mockClear();
    await main(['get', `${key}.mode`, ...args()]);
    expect(console.log).toHaveBeenCalledWith('"off"');
    await write(`${key}.mode`, undefined, args());
    expect((await new ConfigLoader(root).load()).defaults.workerSelection?.mode).toBeUndefined();
    await expect(readFile(join(root, '.aiwg/aiwg.config'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('doctor warns offline that a flagship ceiling is not an election', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    await write(`${key}.maxAutoTier`, 'flagship', args());
    expect(await collectWorkerPolicyDiagnostics(root, {})).toContainEqual(expect.objectContaining({
      pointer: '/defaults/workerSelection/maxAutoTier', blocking: false,
      message: expect.stringContaining('explicit user election'),
    }));
  });
  it.each(['default', 'advisory', 'off'])('sets %s and resets to inherited mode without aiwg.config', async mode => {
    await write(`${key}.mode`, mode, args());
    expect((await new ConfigLoader(root).load()).defaults.workerSelection?.mode).toBe(mode);
    await write(`${key}.mode`, undefined, args());
    expect((await new ConfigLoader(root).load()).defaults.workerSelection?.mode).toBeUndefined();
  });
  it('keeps other model preferences on root reset', async () => {
    await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { tier: 'economy' } }));
    await write(key, '{"mode":"off","returnBudgetTokens":900}', args());
    await write(key, undefined, args());
    expect(JSON.parse(await readFile(join(root, 'models.json'), 'utf8')).defaults).toEqual({ tier: 'economy' });
  });
  it.each([{ mode: 'invalid' }, { returnBudgetTokens: 0 }, { returnBudgetTokens: 1.5 }, { returnBudgetTokens: '2000' }])('rejects invalid preferences %j in both projections', policy => {
    expect(WorkerSelectionPolicySchema.safeParse(policy).success).toBe(false);
    expect(validateUserProjectModelConfig({ defaults: { workerSelection: policy } }).valid).toBe(false);
  });
  it('rejects project widening without changing the previous file', async () => {
    await write(`${key}.maxAutoTier`, 'standard', args());
    // User layer is separate and a project ceiling can only narrow it.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'user'));
    await writeFile(join(root, 'user/models.json'), '{"defaults":{"workerSelection":{"maxAutoTier":"standard"}}}');
    const before = await readFile(join(root, 'models.json'), 'utf8');
    await expect(write(`${key}.maxAutoTier`, 'premium', args())).rejects.toThrow('OG_POLICY_RELAXATION');
    expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(before);
    await expect(write(`${key}.mode`, 'invalid', args())).rejects.toThrow();
    expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(before);
  });
});
