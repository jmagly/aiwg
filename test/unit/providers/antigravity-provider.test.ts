import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
  validateProviderDefinitionRegistry,
} from '../../../src/providers/provider-definitions.js';
import { buildAgentArgs, getProviderConfig } from '../../../src/cli/agent-spawn.js';
import { compileModelPolicy } from '../../../src/models/provider-policy.js';
import { McpServerRegistry, getProviderConfigPath, injectServers } from '../../../src/mcp/registry.mjs';
import {
  buildAntigravityArgs,
  parseAntigravityJson,
  parseAntigravityStream,
  runAntigravity,
} from '../../../tools/providers/antigravity-transport.mjs';
import * as deployment from '../../../tools/agents/providers/antigravity.mjs';

const temporary: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-antigravity-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => temporary.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('Antigravity provider contract', () => {
  it('normalizes only the documented selector alias', () => {
    expect(normalizeProviderDefinitionId('antigravity')).toBe('antigravity');
    expect(normalizeProviderDefinitionId('agy')).toBe('antigravity');
    expect(normalizeProviderDefinitionId('agy-typo')).toBeNull();
    const definition = getProviderDefinition('agy');
    expect(definition).toMatchObject({
      id: 'antigravity', aliases: ['agy'], status: 'experimental',
      paths: {
        artifacts: { skills: '.agents/.aiwg/skills' },
        kernelSkills: '.agents/skills',
        contextDiscovery: { skills: '.agents/skills' },
      },
    });
    expect(validateProviderDefinitionRegistry().filter(item => item.id === 'agy' || item.aliases.includes('agy'))).toHaveLength(1);
  });

  it('routes spawn and model flags explicitly and fails closed for unknown providers', () => {
    expect(getProviderConfig('agy')).toMatchObject({ binary: 'agy', name: 'Google Antigravity CLI' });
    expect(buildAgentArgs('hello', { provider: 'antigravity' })).toEqual(['hello']);
    expect(buildAgentArgs('hello', { provider: 'agy', dangerous: true })).toEqual(['--dangerously-skip-permissions', 'hello']);
    expect(() => getProviderConfig('antigravty')).toThrow("Unsupported provider 'antigravty'");
    const compiled = compileModelPolicy({
      provider: 'antigravity', artifact: 'agent',
      policy: { role: 'coding', tier: 'standard', effort: 'high', override: 'configured/coding' },
    });
    expect(compiled.fields).toMatchObject({ model: 'configured/coding', effort: 'high' });
  });

  it('parses pinned JSON and stream fixtures and rejects malformed streams', () => {
    const fixture = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/providers/antigravity-conformance', name), 'utf8');
    const withRuntimeConversation = (input: string) => JSON.stringify({
      ...JSON.parse(input), conversation_id: 'runtime-test-only',
    });
    const withRuntimeStreamConversation = (input: string) => input.trim().split('\n')
      .map(line => {
        const event = JSON.parse(line);
        const payloadKey = event.event;
        return JSON.stringify({
          ...event,
          ...(event.event === 'init' ? { conversation_id: 'runtime-test-only' } : {}),
          [payloadKey]: { ...event[payloadKey], conversation_id: 'runtime-test-only' },
        });
      })
      .join('\n');
    expect(parseAntigravityJson(withRuntimeConversation(fixture('json-success.json'))).status).toBe('success');
    expect(parseAntigravityJson(withRuntimeConversation(fixture('json-error.json'))).error).toContain('authentication');
    expect(parseAntigravityStream(withRuntimeStreamConversation(fixture('stream-success.ndjson'))).at(-1)?.event).toBe('result');
    expect(() => parseAntigravityStream(withRuntimeStreamConversation(fixture('stream-malformed.ndjson')))).toThrow('unknown state');
    expect(() => parseAntigravityStream('{"event":"result"}\n')).toThrow('first event must be init');
    for (const name of ['json-success.json', 'json-error.json', 'stream-success.ndjson', 'stream-malformed.ndjson']) {
      expect(fixture(name)).not.toMatch(/conversation_id|fixture response|\/home\//i);
    }
  });

  it('builds bounded headless arguments without implicit dangerous mode', () => {
    expect(buildAntigravityArgs('hello', { model: 'fixture/model', effort: 'high', sandbox: true })).toEqual([
      '-p', 'hello', '--output-format', 'json', '--model', 'fixture/model', '--effort', 'high', '--sandbox',
    ]);
    expect(buildAntigravityArgs('hello', { outputFormat: 'stream-json' })).toEqual([
      '-p', 'hello', '--output-format', 'stream-json',
    ]);
    expect(buildAntigravityArgs('hello', { outputFormat: 'stream-json' })).not.toContain('--input-format');
    expect(buildAntigravityArgs('hello')).not.toContain('--dangerously-skip-permissions');
    expect(buildAntigravityArgs('hello', { dangerous: true })[0]).toBe('--dangerously-skip-permissions');
  });

  it('surfaces stderr authentication diagnostics and terminates timed-out children', async () => {
    const failing = new EventEmitter() as EventEmitter & Record<string, any>;
    failing.stdin = { end() {} };
    failing.stdout = new PassThrough();
    failing.stderr = new PassThrough();
    failing.kill = () => true;
    queueMicrotask(() => {
      failing.stderr.write('authentication required');
      failing.emit('close', 7);
    });
    await expect(runAntigravity('hello', { spawnImpl: () => failing, timeoutMs: 100 }))
      .rejects.toThrow('Antigravity CLI exited 7: authentication required');

    let killed = false;
    const hanging = new EventEmitter() as EventEmitter & Record<string, any>;
    hanging.pid = 54321;
    hanging.stdin = { end() {} };
    hanging.stdout = new PassThrough();
    hanging.stderr = new PassThrough();
    hanging.kill = (signal: string) => { killed = signal === 'SIGTERM'; return true; };
    await expect(runAntigravity('hello', { spawnImpl: () => hanging, timeoutMs: 5 }))
      .rejects.toThrow('timed out after 5ms');
    expect(killed).toBe(true);
  });
});

describe('Antigravity MCP ownership', () => {
  it('uses canonical project/user paths and Google remote url', async () => {
    const root = temp();
    const priorHome = process.env.HOME;
    process.env.HOME = join(root, 'home');
    try {
      expect(getProviderConfigPath('agy', root)).toBe(join(root, '.agents/plugins/aiwg/mcp_config.json'));
      expect(getProviderConfigPath('antigravity', root, { scope: 'user' })).toBe(join(root, 'home/.gemini/config/mcp_config.json'));
      const registry = new McpServerRegistry(join(root, 'registry'));
      await registry.add({ name: 'remote', type: 'http', url: 'https://example.invalid/mcp' });
      const result = await injectServers(registry, 'agy', { projectDir: root });
      expect(result.error).toBeUndefined();
      const config = JSON.parse(readFileSync(join(root, '.agents/plugins/aiwg/mcp_config.json'), 'utf8'));
      expect(config.mcpServers.remote).toEqual({ url: 'https://example.invalid/mcp' });
      expect((await registry.get('remote'))?.injectedProviders).toEqual(['antigravity']);
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    }
  });

  it('preserves operator collisions and refuses malformed JSON', async () => {
    const root = temp();
    const target = join(root, '.agents/plugins/aiwg/mcp_config.json');
    mkdirSync(join(root, '.agents/plugins/aiwg'), { recursive: true });
    writeFileSync(target, JSON.stringify({ keep: true, mcpServers: { owned: { command: 'operator' } } }));
    const registry = new McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'owned', type: 'stdio', command: 'aiwg' });
    const result = await injectServers(registry, 'antigravity', { projectDir: root });
    expect(result.alreadyPresent).toEqual(['owned']);
    expect(result.serversInjected).toEqual([]);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ keep: true, mcpServers: { owned: { command: 'operator' } } });
    writeFileSync(target, '{malformed');
    await expect(injectServers(registry, 'antigravity', { projectDir: root })).rejects.toThrow('Refusing to overwrite malformed MCP config');
    expect(readFileSync(target, 'utf8')).toBe('{malformed');
  });
});

describe('Antigravity native project deployment', () => {
  it('preserves operator files and produces idempotent provider-owned agents', () => {
    const root = temp();
    const source = join(root, 'source.md');
    const operator = join(root, '.agents/agents/operator.md');
    mkdirSync(join(root, '.agents/agents'), { recursive: true });
    writeFileSync(source, '---\nname: fixture\ndescription: fixture agent\ntools: Read\n---\n\nInstructions.\n');
    writeFileSync(operator, 'operator-owned\n');
    const options = { dryRun: false, force: false, deployVersion: 'test', deploySource: 'test', provider: 'antigravity' };
    expect(deployment.deployAgents([source], root, options)).toHaveLength(1);
    const first = readFileSync(join(root, '.agents/agents/source.md'), 'utf8');
    expect(first).toContain('tools:\n  - read_file');
    expect(first).not.toContain('tools: Read');
    expect(deployment.deployAgents([source], root, options)).toEqual([
      expect.objectContaining({ type: 'skip', reason: 'hash-match' }),
    ]);
    expect(readFileSync(join(root, '.agents/agents/source.md'), 'utf8')).toBe(first);
    expect(readFileSync(operator, 'utf8')).toBe('operator-owned\n');
  });

  it('preserves operator-owned shared skills across kernel deploy and redeploy', () => {
    const root = temp();
    const skill = join(root, 'aiwg-doctor');
    const operator = join(root, '.agents/skills/operator-skill/SKILL.md');
    mkdirSync(skill, { recursive: true });
    mkdirSync(join(root, '.agents/skills/operator-skill'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: aiwg-doctor\ndescription: fixture kernel\nkernel: true\n---\n\nFixture.\n');
    writeFileSync(operator, 'operator-owned\n');
    const options = { dryRun: false, force: false, provider: 'antigravity' };
    expect(deployment.deploySkills([skill], root, options).kernel).toBe(1);
    expect(deployment.deploySkills([skill], root, options).kernel).toBe(1);
    expect(readFileSync(operator, 'utf8')).toBe('operator-owned\n');
  });

  it('emits byte-identical agent artifacts for canonical and alias selectors', () => {
    const root = temp();
    const source = join(root, 'source.md');
    const canonical = join(root, 'canonical');
    const alias = join(root, 'alias');
    writeFileSync(source, '---\nname: fixture\ndescription: fixture agent\n---\n\nInstructions.\n');
    deployment.deployAgents([source], canonical, { provider: 'antigravity', dryRun: false });
    deployment.deployAgents([source], alias, { provider: 'agy', dryRun: false });
    expect(readFileSync(join(canonical, '.agents/agents/source.md')))
      .toEqual(readFileSync(join(alias, '.agents/agents/source.md')));
  });

  it('accepts user-scope staging for the documented global skill mirror', async () => {
    const root = temp();
    mkdirSync(join(root, 'source/skills'), { recursive: true });
    await expect(deployment.deploy({
      srcRoot: join(root, 'source'), target: join(root, 'stage'), mode: 'sdlc', scope: 'user',
      skillsOnly: true, quiet: true, contextFiles: false,
    })).resolves.toMatchObject({ provider: 'antigravity', exceeded: false });
  });
});
