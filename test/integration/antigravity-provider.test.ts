import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = resolve('.');
const sandbox = mkdtempSync(join(tmpdir(), 'aiwg-antigravity-public-cli-'));
const workspace = join(sandbox, 'project');
const config = join(sandbox, 'aiwg-config');
mkdirSync(workspace, { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, 'channel.json'), JSON.stringify({ channel: 'edge', edgePath: repo, devMode: true }));

const baseEnv = {
  ...process.env,
  HOME: join(sandbox, 'home'),
  AIWG_CONFIG: config,
  AIWG_USER_REGISTRY_PATH: join(config, 'installed.json'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_STATE_HOME: join(sandbox, 'state'),
  NO_UPDATE_NOTIFIER: '1',
};

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function cli(args: string[], expectedStatus = 0) {
  const entry = pathToFileURL(join(repo, 'src/cli/router.ts')).href;
  const program = `import { run } from ${JSON.stringify(entry)}; await run(process.argv.slice(1)); process.exit(process.exitCode ?? 0);`;
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, '--eval', program, ...args],
    { cwd: workspace, env: baseEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(result.status, result.stderr + '\n' + result.stdout).toBe(expectedStatus);
  return { stdout: result.stdout, stderr: result.stderr };
}

function put(name: string, body: string) {
  const file = join(workspace, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const common = ['use', 'aiwg-utils', '--provider', 'antigravity', '--no-project-local', '--json'];

describe('Antigravity public use command integration', () => {
  it('normalizes canonical and alias dry-run plans without writing artifacts', () => {
    const canonical = cli([...common, '--dry-run']).stdout;
    const alias = cli(['use', 'aiwg-utils', '--provider', 'agy', '--no-project-local', '--json', '--dry-run']).stdout;
    const normalize = (output: string) => {
      const result = JSON.parse(output);
      delete result.generatedAt;
      return result;
    };
    expect(normalize(alias)).toEqual(normalize(canonical));
    expect(existsSync(join(workspace, '.agents'))).toBe(false);
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);
  }, 180000);

  it('deploys and redeploys while preserving shared operator-owned files', () => {
    const operatorAgent = '.agents/agents/operator.md';
    const operatorSkill = '.agents/skills/operator/SKILL.md';
    const otherProvider = '.codex/config.toml';
    put(operatorAgent, 'operator-owned agent\n');
    put(operatorSkill, 'operator-owned skill\n');
    put(otherProvider, '# operator-owned provider config\n');

    cli(common);
    expect(existsSync(join(workspace, '.agents/agents'))).toBe(true);
    expect(existsSync(join(workspace, '.agents/skills/aiwg-doctor/SKILL.md'))).toBe(true);
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('WORKSPACE.md');
    const firstContext = readFileSync(join(workspace, 'AGENTS.md'));

    cli(common);
    expect(readFileSync(join(workspace, 'AGENTS.md'))).toEqual(firstContext);
    expect(readFileSync(join(workspace, operatorAgent), 'utf8')).toBe('operator-owned agent\n');
    expect(readFileSync(join(workspace, operatorSkill), 'utf8')).toBe('operator-owned skill\n');
    expect(readFileSync(join(workspace, otherProvider), 'utf8')).toBe('# operator-owned provider config\n');
  }, 300000);

  it('mirrors user skills to the documented global configuration root', () => {
    cli([...common, '--scope', 'user']);
    expect(existsSync(join(sandbox, 'home/.gemini/config/skills/aiwg-doctor/SKILL.md'))).toBe(true);
    const registry = JSON.parse(readFileSync(join(config, 'installed.json'), 'utf8'));
    expect(registry.installed['aiwg-utils'].deployedTo.antigravity.entries.skills).toContain('aiwg-doctor');
  }, 180000);
});
