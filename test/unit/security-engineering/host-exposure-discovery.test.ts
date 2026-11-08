// Verify the shipped skills through the existing offline discovery handler.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverHandler } from '../../../src/cli/handlers/subcommands.js';

let temporary: string;
let root: string;
beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-exposure-discovery-'));
  root = join(temporary, 'runtime');
  mkdirSync(root, { recursive: true });
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    const target = join(root, 'agentic/code', kind);
    mkdirSync(target, { recursive: true });
    cpSync(resolve('agentic/code', kind), target, { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{"name":"aiwg"}');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, join(temporary, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, join(root, '.aiwg'));
  vi.stubEnv('AIWG_ROOT', root);
  await buildIndex(root, { graph: 'framework', force: true, explicit: true, quiet: true });
}, 60_000);
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});
it.each([
  ['firewall analysis', 'exposure-analysis'],
  ['docker published ports', 'exposure-analysis'],
  ['system hardening', 'host-hardening'],
])('discovers "%s" in the top three', async (phrase, expected) => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const messages: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => messages.push(args.join(' ')));
  try {
    const args = [phrase, '--json', '--backend', 'local', '--graph', 'framework', '--offline', '--limit', '3'];
    const result = await discoverHandler.execute({ args, rawArgs: ['discover', ...args], cwd: root, frameworkRoot: root });
    expect(result.exitCode).toBe(0);
    const results = JSON.parse(messages.join('\n')).results as { name: string }[];
    expect(results.map(result => result.name)).toContain(expected);
  } finally { log.mockRestore(); }
});
