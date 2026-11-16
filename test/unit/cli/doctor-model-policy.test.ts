// Doctor's alias remediation must agree with the model IDs deployment writes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadModelConfig } from '../../../tools/agents/providers/base.mjs';
import { deployAgents } from '../../../tools/agents/providers/claude.mjs';

const repo = resolve(import.meta.dirname, '../../..');
let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each(['default', 'override', 'null', 'array', 'unresolved'])('doctor hints match Claude deploy (%s)', scenario => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-doctor-model-policy-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const put = (relative: string, content: string) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  put('.aiwg/aiwg.config', JSON.stringify({ providers: ['claude'], installed: {} }));
  put('models.json', JSON.stringify({ defaults: { workerSelection: { roleGuidance: {} } },
    ...(scenario === 'override' ? { claude: { coding: { model: 'custom-doctor-coding' } } } : {}),
    ...(scenario === 'null' ? { claude: null } : {}),
    ...(scenario === 'array' ? { claude: [] } : {}),
    ...(scenario === 'unresolved' ? { claude: { coding: { model: null } } } : {}),
  }));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AIWG_ROOT', repo);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const config = loadModelConfig(repo);
  const files = ['sonnet', 'opus', 'haiku'].map(alias => put(`source/${alias}.md`,
    `---\nname: ordinary-${alias}\nmodel: ${alias}\ntools: Read\n---\nFixture.\n`));
  // Doctor diagnoses the stale deployed aliases before the refresh.
  for (const file of files) put(`.claude/agents/${file.split('/').at(-1)}`, readFileSync(file, 'utf8'));
  const doctor = () => {
    const result = spawnSync(process.execPath,
      [join(repo, 'tools/cli/doctor.mjs'), '--provider', 'claude', '--no-budget-check'],
      { cwd: root, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, AIWG_ROOT: repo, AIWG_HOME: repo,
          XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
          XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), NO_COLOR: '1' } });
    expect(result.error).toBeUndefined();
    expect([0, 1], result.stderr).toContain(result.status);
    const line = result.stdout.split('\n').find(line => line.includes('Claude Code Model Policy:'));
    expect(line, result.stderr).toBeDefined();
    return line!;
  };
  const hint = doctor();
  if (scenario === 'unresolved') {
    expect(hint).toContain('⚠ Claude Code Model Policy:');
    expect(hint).toContain('Claude tiers cannot be resolved');
    return;
  }
  expect(hint).toContain('3 agent alias(es) need compilation');
  deployAgents(files, root, { modelsConfig: config, force: true, quiet: true });
  for (const [alias, role] of Object.entries({ sonnet: 'coding', opus: 'reasoning', haiku: 'efficiency' })) {
    const deployed = readFileSync(join(root, '.claude/agents', `${alias}.md`), 'utf8');
    const model = deployed.match(/^model: (.+)$/m)![1];
    expect(model).toBe(config.claude[role].model);
    expect(hint).toContain(`${alias}→${model}`);
  }
  expect(doctor()).toContain('✓ Claude Code Model Policy:');
}, 300_000);
