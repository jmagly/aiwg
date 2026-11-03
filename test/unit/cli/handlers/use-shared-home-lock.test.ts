// Prevent prepared multi-provider use from waiting on its own shared-home lease.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const write = (root: string, file: string, body: string): void => {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, body);
};

it.each(['embedded', 'subprocess'])('finishes real prepared use and addon passes in %s mode without lock waits', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-use-shared-lock-')); roots.push(root);
  const home = path.join(root, 'home'), project = path.join(root, 'project'), source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(source);
  // Use has no public --source flag. Adapt only source selection at the
  // fixture boundary; keep the real coordinator, deployer and script runner.
  const deployer = pathToFileURL(path.join(repo, 'tools/agents/deploy-agents.mjs')).href;
  const coordinator = pathToFileURL(path.join(repo, 'tools/agents/providers/provider-prepare-coordinator.mjs')).href;
  write(source, 'tools/agents/deploy-agents.mjs', `import { main as deploy } from ${JSON.stringify(deployer)};
import { appendFileSync } from 'node:fs';
export const main = (args, internal) => {
  appendFileSync(process.env.AIWG_ROOT + '/passes.jsonl', JSON.stringify({ args, internal }) + '\\n');
  return deploy(args.includes('--source') ? args : [...args, '--source', process.env.AIWG_ROOT], internal);
};
if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) process.exitCode = (await main(process.argv.slice(2))) ?? 0;
`);
  write(source, 'tools/agents/providers/provider-prepare-coordinator.mjs', `import { prepareProviderDeployments as prepare } from ${JSON.stringify(coordinator)};
export const prepareProviderDeployments = options => prepare({ ...options, jobs: options.jobs.map(job => ({ ...job, args: [...job.args, '--source', options.srcRoot] })) });
`);
  for (const helper of ['skills/deploy-skills-codex.mjs', 'commands/deploy-prompts-codex.mjs']) {
    write(source, `tools/${helper}`, `import { main } from ${JSON.stringify(pathToFileURL(path.join(repo, 'tools', helper)).href)};
export { main };
if (process.argv[1]?.endsWith(${JSON.stringify('/tools/' + helper)})) await main();
`);
  }
  write(source, 'package.json', JSON.stringify({ name: 'aiwg', version: '2026.11.0' }));
  write(source, 'agentic/code/frameworks/sdlc-complete/manifest.json', JSON.stringify({ id: 'sdlc', version: '1.0.0' }));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'agentic/code/providers/model-catalog.v1.json'), 'utf8'));
  write(source, 'agentic/code/providers/model-catalog.v1.json', JSON.stringify({ ...catalog,
    providers: { codex: catalog.providers.codex, hermes: catalog.providers.hermes } }));
  fs.copyFileSync(path.join(repo, 'agentic/code/providers/capability-matrix.yaml'),
    path.join(source, 'agentic/code/providers/capability-matrix.yaml'));
  for (const [bundle, name] of [['frameworks/sdlc-complete', 'main-probe'], ['addons/aiwg-utils', 'addon-probe'], ['extensions/dev', 'extension-probe']]) {
    write(source, `agentic/code/${bundle}/manifest.json`, JSON.stringify({ id: bundle.split('/')[1], version: '1.0.0' }));
    write(source, `agentic/code/${bundle}/skills/${name}/SKILL.md`,
      `---\nnamespace: aiwg\nname: ${name}\nplatforms: [all]\nkernel: true\ndescription: Synthetic ${name} skill\n---\n${name}.\n`);
  }
  for (const name of ['reasoning-worker', 'coding-worker', 'efficiency-worker', 'explorer', 'verifier']) {
    write(source, `agentic/code/addons/aiwg-utils/agents/aiwg-model-${name}.md`,
      `---\nname: aiwg-model-${name}\ndescription: Synthetic model wrapper\n---\nReturn WorkerClaims for each supplied criterion.\n\n## Stop rules\nStop when the supplied criterion has evidence.\n`);
  }
  write(project, '.aiwg/aiwg.config', JSON.stringify({ version: '1', providers: ['codex', 'hermes'] }));
  const result = await new Promise<{ error: Error | null; output: string }>(resolve => {
    execFile(process.execPath, [path.join(repo, 'test/fixtures/providers/use-shared-home-runner.mjs')], {
      cwd: project, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        HERMES_HOME: path.join(home, '.hermes'), CODEX_HOME: path.join(home, '.codex'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'),
        XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
        AIWG_ROOT: source, AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_PROJECT_MEMORY_HOME: path.join(root, 'memory'),
        AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_DEPLOY_SUBPROCESS: mode === 'subprocess' ? '1' : '0',
        CI: '1', NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout, stderr) => resolve({ error, output: stdout + stderr }));
  });
  expect(result.error, result.output).toBeNull();
  expect(result.output).not.toContain('Waiting for shared user-home');
  expect(result.output).not.toContain('Timed out waiting');
  const passes = fs.readFileSync(path.join(source, 'passes.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { args: string[]; internal?: { finalizeOnly?: boolean } });
  for (const provider of ['codex', 'hermes']) {
    const calls = passes.filter(pass => pass.args[pass.args.indexOf('--provider') + 1] === provider);
    expect(calls.some(pass => pass.internal?.finalizeOnly)).toBe(true);
    for (const bundle of ['addons/aiwg-utils', 'extensions/dev']) {
      expect(calls.some(pass => pass.args.includes(path.join(source, 'agentic/code', bundle)))).toBe(true);
    }
  }
  for (const name of ['main-probe', 'addon-probe']) {
    expect(fs.existsSync(path.join(project, '.agents/skills', name, 'SKILL.md')), `codex ${name}`).toBe(true);
    expect(fs.existsSync(path.join(home, '.hermes/skills', name, 'SKILL.md')), `hermes ${name}`).toBe(true);
  }
  expect(fs.existsSync(path.join(home, '.local/state/aiwg/provider-deployment.lock'))).toBe(false);
}, 60_000);
