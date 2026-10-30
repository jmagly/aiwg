// Exercise host-audit routing through the public handler against an isolated canonical corpus.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverHandler } from '../../../src/cli/handlers/subcommands.js';

const fixture = JSON.parse(readFileSync(resolve('test/fixtures/artifacts/host-audit-discovery.json'), 'utf8')) as {
  positive: string[];
  negative: { phrase: string; expected: string }[];
};
const skill = 'agentic/code/extensions/sys/skills/sys-host-audit.md';
const agent = 'agentic/code/frameworks/ops-complete/agents/sys-host-profiler.md';
const sources = [skill, agent];
const identities = ['sys-host-audit', 'Sys Host Profiler'];
let temporary: string;
let root: string;

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-host-audit-discovery-'));
  root = join(temporary, 'runtime');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    const target = join(root, 'agentic/code', kind);
    mkdirSync(target, { recursive: true });
    cpSync(resolve('agentic/code', kind), target, { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{"name":"aiwg"}');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    vi.stubEnv(key, join(temporary, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
    vi.stubEnv(key, join(root, '.aiwg'));
  }
  vi.stubEnv('AIWG_ROOT', root);
  await buildIndex(root, { graph: 'framework', force: true, explicit: true, quiet: true });
});

beforeEach(() => vi.spyOn(process, 'cwd').mockReturnValue(root));

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

async function discover(phrase: string, type?: string) {
  const messages: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => messages.push(args.join(' ')));
  const args = [phrase, '--json', '--backend', 'local', '--graph', 'framework', '--offline', '--limit', '3'];
  if (type) args.push('--type', type);
  try {
    const result = await discoverHandler.execute({ args, rawArgs: ['discover', ...args], cwd: root, frameworkRoot: root });
    expect(result.exitCode).toBe(0);
    return JSON.parse(messages.join('\n')).results as { type: string; name: string }[];
  } finally {
    log.mockRestore();
  }
}

it.each(fixture.positive)('routes "%s" to host audit or profiler in the top three', async phrase => {
  const results = await discover(phrase);
  expect(results.some(result => identities.includes(result.name)), results.map(result => result.name).join(', ')).toBe(true);
});

it.each(fixture.negative)('keeps unrelated "$phrase" out of host audit routing', async ({ phrase, expected }) => {
  const results = await discover(phrase);
  expect(results[0]?.name).toBe(expected);
  expect(results.some(result => identities.includes(result.name)), results.map(result => result.name).join(', ')).toBe(false);
});

it.each([['skill', identities[0]], ['agent', identities[1]]])('can discover the existing %s directly', async (type, name) => {
  const results = await discover("what's running on this server", type);
  expect(results.some(result => result.name === name)).toBe(true);
});

it.each(sources)('%s prohibits secret collection and requires report redaction', source => {
  const body = readFileSync(resolve(source), 'utf8');
  expect(body).toMatch(/NEVER read or print credentials, keys, tokens, environment values, or private config/);
  expect(body).toMatch(/Redact anything sensitive.*report/);
  expect(body).toMatch(/NEVER.*(?:sudo|elevated privileges)/);
  expect(body).not.toMatch(/cat \/etc\/(?:fstab|resolv\.conf)/);
});
