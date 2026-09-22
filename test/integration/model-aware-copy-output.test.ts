import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';

const REPO_ROOT = resolve(__dirname, '../..');
const roots: string[] = [];

function deploy(target: string, home: string, copyAll: boolean): void {
  execFileSync(process.execPath, [
    join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
    '--provider', 'codex',
    '--mode', 'all',
    '--deploy-skills',
    '--target', target,
    '--skip-commands-migration',
    '--quiet',
    ...(copyAll ? ['--copy-all'] : []),
  ], { timeout: 60_000,
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'pipe',
  });
}

function useAiwgUtils(target: string, home: string): string {
  return execFileSync(process.execPath, [
    join(REPO_ROOT, 'bin/aiwg.mjs'),
    'use', 'aiwg-utils',
    '--provider', 'codex',
    '--target', target,
    '--verbose',
  ], { timeout: 60_000,
    cwd: REPO_ROOT,
    env: { ...process.env, AIWG_ROOT: REPO_ROOT, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

async function workspace(provider = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-copy-output-'));
  roots.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, '.aiwg'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(project, '.aiwg/aiwg.config'), JSON.stringify({
    version: '1',
    providers: [provider],
    installed: {},
    scripts: {},
  }));
  execFileSync('git', ['init', '-q'], { timeout: 60_000, cwd: project });
  return { project, home };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('model-aware copy output', () => {
  it('aiwg use deploys and verifies the kernel model wrappers', async () => {
    const { project, home } = await workspace();
    const output = useAiwgUtils(project, home);

    expect(output).toContain(
      'Model wrappers verified: aiwg-model-reasoning-worker, aiwg-model-coding-worker, aiwg-model-efficiency-worker',
    );
    for (const role of ['reasoning', 'coding', 'efficiency']) {
      await expect(access(join(
        project,
        `.codex/agents/aiwg-model-${role}-worker.toml`,
      ))).resolves.toBeUndefined();
    }
  });

  it('full-copy mode writes standard skills and model-pinned provider wrappers', async () => {
    const { project, home } = await workspace();
    deploy(project, home, true);

    const standard = await readFile(join(project, '.agents/skills/voice-apply/SKILL.md'), 'utf8');
    expect(standard).toContain('name: "voice-apply"');

    const wrappers = [
      ['reasoning', 'gpt-5.6-sol', 'high'],
      ['coding', 'gpt-5.6-terra', 'medium'],
      ['efficiency', 'gpt-5.6-luna', 'low'],
    ] as const;
    for (const [role, model, effort] of wrappers) {
      const output = await readFile(
        join(project, `.codex/agents/aiwg-model-${role}-worker.toml`),
        'utf8',
      );
      expect(output).toContain(`model = "${model}"`);
      expect(output).toContain(`model_reasoning_effort = "${effort}"`);
      expect(output).toContain('aiwg discover');
      expect(output).toContain('aiwg show');
    }
  });

  it('quickref mode omits standard copies and resolves them through the global index', async () => {
    const { project, home } = await workspace();
    deploy(project, home, false);

    await expect(access(join(project, '.agents/skills/voice-apply/SKILL.md'))).rejects.toThrow();
    const quickref = await readFile(join(project, '.agents/skills/aiwg-utils-quickref/SKILL.md'), 'utf8');
    expect(quickref).toContain('aiwg discover');
    expect(quickref).toContain('aiwg show');

    const cliEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AIWG_ROOT: REPO_ROOT,
    };
    const indexedPath = 'agentic/code/addons/voice-framework/skills/voice-apply/SKILL.md';
    await mkdir(join(home, '.local/share/aiwg/index/framework'), { recursive: true });
    await writeFile(
      join(home, '.local/share/aiwg/index/framework/metadata.json'),
      JSON.stringify({
        version: '1.0.0',
        builtAt: new Date(0).toISOString(),
        buildTimeMs: 0,
        entries: {
          [indexedPath]: {
            path: indexedPath,
            type: 'skill',
            phase: 'other',
            name: 'voice-apply',
            title: 'Voice Apply Skill',
            tags: [],
            created: new Date(0).toISOString(),
            updated: new Date(0).toISOString(),
            checksum: 'fixture',
            summary: 'fixture',
            dependencies: [],
            dependents: [],
          },
        },
      }),
    );
    const raw = execFileSync(process.execPath, [
      join(REPO_ROOT, 'bin/aiwg.mjs'),
      'show', 'skill', 'voice-apply', '--json', '--backend', 'local',
    ], { timeout: 60_000,
      cwd: project,
      env: cliEnv,
      encoding: 'utf8',
    });
    const shown = JSON.parse(raw);
    expect(shown.path).toBe(join(
      REPO_ROOT,
      'agentic/code/addons/voice-framework/skills/voice-apply/SKILL.md',
    ));
  });
});
