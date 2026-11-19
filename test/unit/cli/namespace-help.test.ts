import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { allHandlers, buildAliasMap, buildHandlerMap } from '../../../src/cli/handlers/index.js';
import { helpHandler } from '../../../src/cli/handlers/help.js';
import { run } from '../../../src/cli/router.js';

vi.mock('../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => process.cwd()),
}));
vi.mock('../../../src/extensions/loader.js', () => ({
  loadRegistry: vi.fn(async () => ({
    registry: { resolveCommand: (name: string) => buildAliasMap().get(name) },
    handlerMap: buildHandlerMap(),
  })),
}));

function captureOutput(): string[] {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`Unexpected exit: ${code}`); });
  return output;
}

afterEach(() => vi.restoreAllMocks());

describe('namespace help routing', () => {
  it('routes every namespace advertised by aiwg help without the generic stub', async () => {
    const output = captureOutput();
    await helpHandler.execute({ args: [], rawArgs: ['help'], cwd: process.cwd(), frameworkRoot: process.cwd() });
    const namespaces = new Set<string>(['config', 'workspace-context']);
    for (const line of output.flatMap(chunk => stripVTControlCharacters(chunk).split('\n'))) {
      if (line.trim() === 'Examples:') break;
      // Namespace rows advertise a literal verb or an action/command placeholder.
      // Scalar arguments such as <name>, <path>, and <framework> are leaf commands.
      const row = /^    ([a-z][\w-]*)\s+(.+?)\s{2,}\S/.exec(line);
      if (row && /^(?:[a-z]|\[scan\]|<(?:command|subcommand|action|operation)>|<[^>]*\|)/.test(row[2])) {
        namespaces.add(row[1]);
      }
    }
    expect(namespaces).toContain('corpus');
    expect(namespaces).toContain('index');
    expect(namespaces.size).toBeGreaterThan(15);
    for (const namespace of namespaces) {
      output.length = 0;
      await run([namespace, '--help']);
      const text = output.join('\n');
      expect.soft(text, namespace).not.toContain('No detailed help for');
      expect.soft(text.trim().length, namespace).toBeGreaterThan(0);
    }
  });

  it('routes authorization check help and help command forms to the action descriptor documentation', async () => {
    const output = captureOutput();
    for (const args of [['config', 'authorization', 'check', '--help'], ['help', 'config', 'authorization', 'check']]) {
      output.length = 0;
      await run(args);
      expect(output.join('\n')).toContain('inputDigest');
      expect(output.join('\n')).toContain('Example');
    }
  });

  it.each([
    ...['issue', 'issues'].flatMap(namespace => ['', 'list', 'create', 'comment', 'close'].map(verb =>
      [namespace, verb, ['Usage:', 'create', 'comment', 'close', 'list --provider local', '--body-file', '--authorize-policy', 'local storage only', 'configured external tracker']] as [string, string, string[]])),
    ['config', 'show', ['Usage:', 'show --project', '--json', '--config-dir']],
    ['config', 'authorization', ['--action-file', 'category', 'verb', 'repo', 'environment', 'target', 'resources', 'reversible', 'impact', 'actor', 'inputDigest', 'Example']],
    ['workspace-context', 'doctor', ['Usage:', 'doctor', '--json', '--apply', '--allow-conflicts']],
    ['models', '', ['list', 'audit', 'resolve', 'validate', 'sources', 'refresh', 'set-default', 'set', 'migrate', '--role', '--task', '--group', '--brief', '--workdir', '--final-output', '--transport', '--format', '--authorize-premium']],
    ['models', 'resolve', ['--task', '--group', '--brief', '--workdir', '--final-output', '--transport', '--format', '--authorize-premium']],
    ['corpus', '', ['snapshot', 'radar-init', 'curator-init', '--write', '--out', '--cadence', '--cluster', '--format']],
    ['corpus', 'snapshot', ['snapshot', '--write', '--out', '--format', '--compute-only', '--delta-only']],
    ['corpus', 'radar-init', ['--ref', '--all-missing', '--cadence', '--cluster', '--write']],
    ['corpus', 'curator-init', ['--handle', '--platform', '--cadence', '--write']],
    ['index', '', ['build', 'sync', '--graph', '--force', '--all', '--scope', '--backend']],
    ['index', 'build', ['build', '--graph', '--force', '--verbose', '--scope', '--all']],
    ['index', 'sync', ['sync', '--graph', '--backend', '--repo', '--privacy', '--generated-at', '--json']],
    ['quickref', 'deploy', ['generate', 'deploy', '--project', '--provider', '--dry-run']],
    ['setup', 'project', ['project', '--yes', '--dry-run', '--target', '--worker-dispatch']],
    ['mcp', 'install', ['serve', 'install', 'info', '--provider']],
    ['uhp', 'run', ['discover', 'harnesses', 'models', 'run', '--profile', '--input', '--stream']],
    ['auth', 'login', ['login', 'status', 'logout', '--device', '--store']],
    ['versions', 'resolve', ['list', 'resolve', 'show', '--offline']],
    ['artifacts', 'move', ['path', 'move', '--to', '--dry-run']],
    ['run', 'skill', ['<script-name>', 'skill', '--output-mode', '--cwd']],
    ['evidence', 'export', ['export', 'verify', '--output']],
    ['context-firewall', 'baseline', ['scan', 'baseline', '--write', '--confirm-reviewed']],
  ])('%s %s help exposes verbs and flags without executing', async (namespace, verb, expected) => {
    const output = captureOutput();
    const handler = allHandlers.find(candidate => candidate.id === buildAliasMap().get(namespace))!;
    const execute = vi.spyOn(handler, 'execute');
    for (const flag of ['--help', '-h']) {
      output.length = 0;
      await run([namespace, ...(verb ? [verb] : []), flag]);
      const text = output.join('\n');
      expect(text).not.toContain('No detailed help for');
      for (const token of expected) expect(text).toContain(token);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
