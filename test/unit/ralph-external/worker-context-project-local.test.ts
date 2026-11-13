// Launch-time context deployment must select one provider without writing into HOME.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureWorkerContextForLaunch } from '../../../tools/ralph-external/lib/worker-context.mjs';
import { ensureWorkerContextBootstrap, workerContextBootstrapStatus, workerContextDeployEnv } from '../../../src/config/worker-context.js';

it.each(['codex', 'muse'])('T-OG-04 deploys only %s in the worker tree with a read-only HOME, then skips', async provider => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-local-context-'));
  const home = path.join(scratch, 'home'), work = path.join(scratch, 'worker');
  mkdirSync(home); mkdirSync(work); mkdirSync(path.join(work, '.aiwg'));
  const config = { version: '1.0', providers: ['hermes', 'codex', 'muse'] };
  const configFile = path.join(work, '.aiwg/aiwg.config');
  writeFileSync(configFile, JSON.stringify(config));
  chmodSync(home, 0o555);
  let deploys = 0;
  const deployScratch: string[] = [];
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    AIWG_CONFIG: path.join(home, '.aiwg'), CI: '1', NO_UPDATE_NOTIFIER: '1',
    AIWG_SKIP_ACTIVITY_LOG: '1', AIWG_RESOLVE_IMPL_FROM: 'dist' };
  try {
    const ensure = () => ensureWorkerContextForLaunch({ workdir: work, cli: provider, config,
      resolveFromConfig: async () => ({ providers: config.providers, skipped: [] }),
      mapCli: async () => ({ provider }),
      ensureFn: opts => ensureWorkerContextBootstrap({ ...opts,
        spawn: ((bin, argv, options) => {
          if (bin === 'git') return spawnSync(bin, argv, { ...options, env, timeout: 30000 });
          deploys++;
          expect(argv).toEqual(['use', 'all', '--provider', provider, '--scope', 'project', '--target', work, '--yes']);
          deployScratch.push(path.basename(path.dirname(String(options.env?.XDG_DATA_HOME ?? ''))));
          expect(String(options.env?.XDG_DATA_HOME ?? '').startsWith(work)).toBe(false);
          return spawnSync(process.execPath, [path.resolve('bin/aiwg.mjs'), ...argv], { ...options,
            env: { ...env, ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([name]) =>
              ['HOME', 'USERPROFILE', 'AIWG_CONFIG', 'AIWG_USER_REGISTRY_PATH', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'CODEX_HOME', 'HERMES_HOME'].includes(name) || name.startsWith('XDG_'))) }, timeout: 180000 });
        }) as typeof spawnSync,
      }),
    });
    expect(await ensure()).toMatchObject({ ensured: true, providers: [provider] });
    expect(workerContextBootstrapStatus({ workdir: work, provider })).toEqual({ present: true, missing: [] });
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(scratch).sort()).toEqual(['home', 'worker']);
    const deployed = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(deployed.providers.sort()).toEqual([...config.providers].sort());
    expect(Object.keys(deployed.installed.all.deployedTo)).toEqual([provider]);
    const afterDeploy = readFileSync(configFile, 'utf8');
    expect(readdirSync(work)).not.toContain('.hermes');
    // #4150: regenerable deploy data (the framework index) stays out of the worker tree.
    expect(readdirSync(path.join(work, '.aiwg'))).not.toContain('data');
    expect(readdirSync(path.join(work, '.aiwg'))).not.toContain('cache');
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('aiwg-worker-deploy-') && deployScratch.includes(name))).toEqual([]);
    expect(await ensure()).toMatchObject({ ensured: false, providers: [provider] });
    expect(readFileSync(configFile, 'utf8')).toBe(afterDeploy);
    expect(deploys).toBe(1);
  } finally {
    chmodSync(home, 0o755);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);

it('#4150 keeps deploy data and cache in the scratch directory when one is given, else in the worker tree', () => {
  const work = '/work/tree', scratch = '/tmp/aiwg-worker-deploy-x';
  const scoped = workerContextDeployEnv(work, {}, scratch);
  expect(scoped).toMatchObject({ XDG_DATA_HOME: '/tmp/aiwg-worker-deploy-x/data', XDG_CACHE_HOME: '/tmp/aiwg-worker-deploy-x/cache',
    XDG_CONFIG_HOME: '/work/tree/.aiwg/config', XDG_STATE_HOME: '/work/tree/.aiwg/state', AIWG_CONFIG: '/work/tree/.aiwg', HOME: work });
  expect(workerContextDeployEnv(work, {})).toMatchObject({ XDG_DATA_HOME: '/work/tree/.aiwg/data', XDG_CACHE_HOME: '/work/tree/.aiwg/cache' });
});
