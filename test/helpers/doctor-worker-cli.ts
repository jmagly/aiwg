import { installedResourceModelsHandler } from './host-resource-handler.js';
// Offline public doctor fixture: disposable installed code, fake CLI and synthetic signing trust.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { workerInstalledFixture } from './worker-installed-fixture.js';
import { workerSigningFixture } from './worker-qualification-signing.js';
import { writeExecutable } from './write-executable.js';

const exec = promisify(execFile);
export async function doctorWorkerCliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-exit-'));
  const installed = await workerInstalledFixture(root);
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  const bin = path.join(root, 'fake-bin');
  await mkdir(path.join(project, '.aiwg'), { recursive: true });
  await mkdir(config, { mode: 0o700 });
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, 'node'));
  await writeExecutable(path.join(bin, 'codex'), `#!${process.execPath}
if (process.argv.includes('--version')) console.log('codex-cli 0.161.0');
else if (process.argv.slice(2).join(' ') === 'debug models') console.log(JSON.stringify({models:[{
  slug:'synthetic-model', provider:'synthetic-inference', visibility:'listed', context_window:32000,
  output_limit:4096, supported_reasoning_levels:['medium']}]}));
else if (process.argv[2] === 'sandbox') process.exit(0);
else process.exit(90);
`);
  for (const command of ['systemd-run', 'systemctl', 'bwrap']) {
    await writeExecutable(path.join(bin, command), `#!${process.execPath}\nconsole.log('systemd 255');\n`);
  }
  await writeFile(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'],
    parallelism: { worker_dispatch: true, clis: { codex: { adapter: 'providers:codex', executable: path.join(bin, 'codex'),
      accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } }, groups: { workers: { maxParallel: 1,
      execution: { sandbox: 'workspace-write', approval: 'never', transport: 'shell' },
      members: [{ id: 'primary', cli: 'codex', model: 'synthetic-model', roles: ['coding'] }] } } } }));
  await workerSigningFixture(root, project);
  await mkdir(path.join(project, '.aiwg/frameworks'));
  await writeFile(path.join(project, '.aiwg/AIWG.md'), '# Synthetic workspace context\n');
  await writeFile(path.join(project, '.aiwg/frameworks/registry.json'), JSON.stringify({ version: '1', frameworks: [] }));
  await writeFile(path.join(project, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    roleGuidance: { coding: { groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'] } },
    guards: { denySelfDelegation: false }, dataPolicy: { allowUnknown: true } } } }));
  const brief = path.join(project, 'brief.txt');
  await writeFile(brief, 'Synthetic brief.');
  // Keep subprocess state disposable, and discover only the fake executables.
  // Inheriting PATH ran unrelated host model discovery during refresh (#4386).
  const tmp = path.join(root, 'tmp');
  await mkdir(tmp, { recursive: true });
  const env = { ...process.env, PATH: bin,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp, HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    AIWG_CONFIG: config, AIWG_HOME: installed, AIWG_ROOT: installed, AIWG_RESOLVE_IMPL_FROM: 'dist',
    AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', AIWG_COMMAND_LOG: 'off', AIWG_SKILL_USAGE: 'off',
    AIWG_MODEL_CATALOG_URL: '', AIWG_DISABLE_PROCESS_PROVIDER_DETECTION: '1',
    NODE_OPTIONS: '', NO_COLOR: '1' };
  delete (env as NodeJS.ProcessEnv).VITEST;
  // Both paths run shipped code; the public launcher also exercises router/handler propagation.
  const run = async (args: string[], direct = false) => {
    try {
      const result = await exec(process.execPath, [path.join(installed, direct ? 'tools/cli/doctor.mjs' : 'bin/aiwg.mjs'),
        ...(direct ? args.slice(1) : args)], { cwd: project, env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
      return { code: 0, ...result };
    } catch (error: any) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  const modelEntry = path.join(root, 'models.mjs');
  await writeFile(modelEntry, `const handler = ${installedResourceModelsHandler(installed)};
const args = process.argv.slice(2);
const result = await handler.execute({ args, rawArgs: ['models', ...args], cwd: process.cwd(), frameworkRoot: ${JSON.stringify(installed)} });
process.exitCode = result.exitCode;`);
  const resolve = async () => {
    const args = ['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
    '--brief', brief, '--workdir', project, '--final-output', path.join(project, 'result.json'), '--format', 'json'];
    try { return { code: 0, ...await exec(process.execPath, [modelEntry, ...args], { cwd: project, env, timeout: 60_000 }) }; }
    catch (error: any) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  return { root, installed, project, config, run, resolve };
}
