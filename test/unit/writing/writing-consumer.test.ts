import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWriterProfile } from '../../../src/writing/writer-profile.js';
import { WriterProfileStore } from '../../../src/writing/writer-profile-store.js';
import { resolveOutputModes, writeOutputModeState } from '../../../src/output-modes/registry.js';
import { applyWritingConsumer } from '../../../src/writing/writing-consumer.js';
import { registerWriterProfileResources } from '../../../src/mcp/tools/writer-profiles.mjs';
import { outputModeHandler } from '../../../src/cli/handlers/output-mode.js';
import * as profileApi from '../../../src/writing/writer-profile.js';
import * as storeApi from '../../../src/writing/writer-profile-store.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'writing-consumer-')); roots.push(cwd);
  vi.stubEnv('TMPDIR', cwd);
  vi.stubEnv('AIWG_CONFIG', path.join(cwd, 'user')); vi.stubEnv('AIWG_SESSION_ID', path.basename(cwd));
  const profile = parseWriterProfile({ schemaVersion: 1, id: 'author', version: '1.0.0', name: 'Private author', provenance: { source: 'private source', license: 'author' }, samples: [{ id: 'private-sample', text: 'Private author sample prose', sha256: createHash('sha256').update('Private author sample prose').digest('hex'), approved: true, status: 'active', provenance: { source: 'private', license: 'author' }, rights: { useForVoice: true, shareText: false }, sensitivity: 'private' }], preferences: [{ id: 'explicit', key: 'warmth', value: 'warm', origin: 'explicit', confidence: 'high' }] });
  await new WriterProfileStore({ cwd }).save(profile, 0);
  return { cwd, profile, request: { cwd, frameworkRoot: cwd, provider: 'test-provider', consumer: 'test-consumer', format: 'prose' as const } };
}

describe('participating consumer and scoped writer modes', () => {
  it('passes an explicit task through registry resolution and preserves unscoped behavior', async () => {
    const { cwd, request } = await setup();
    const store = new WriterProfileStore({ cwd });
    const profile = await store.read('author');
    profile.preferences.push({ id: 'task-neutral', key: 'warmth', value: 'neutral', task: 'article', origin: 'explicit', confidence: 'high', status: 'accepted', evidence: [] });
    await store.save(profile, profile.revision);
    for (const task of ['article', undefined, 'email', 'article']) {
      const expected = task === 'article' ? 'neutral' : 'warm';
      const result = await applyWritingConsumer('Unchanged prose.', { ...request, invocationModes: ['writer-author'], task });
      expect(result.modes[0].instructions).toContain(`"warmth":"${expected}"`);
      expect(result.content).toBe('Unchanged prose.');
      expect(result.state.applied).toEqual([]);
    }
    const scoped = await resolveOutputModes(cwd, cwd, [], { project: ['writer-author'], session: [] }, { task: 'article' });
    expect(scoped.modes[0].scope).toBe('project');
    expect(scoped.modes[0].instructions).toContain('"warmth":"neutral"');
    for (const task of ['', ' ', 'x'.repeat(121), 42 as unknown as string]) {
      await expect(applyWritingConsumer('text', { ...request, task })).rejects.toThrow('Invalid writer task context');
    }
  });
  it('imports no selection and retains byte identity for empty stacks and structured outputs', async () => {
    const { cwd, request } = await setup();
    const input = '{"content":"unaltered\\n🧵"}';
    const empty = await applyWritingConsumer(input, request);
    expect(empty.content).toBe(input); expect(empty.instructionExport).toBe('');
    await writeOutputModeState(cwd, 'project', ['writer-author']);
    const structured = await applyWritingConsumer(input, { ...request, format: 'json', runtime: { transform: () => 'corrupted' } });
    expect(structured.content).toBe(input); expect(structured.state.applied).toEqual([]);
    expect(structured.state.providerInterception).toBe(false);
  });
  it('exports usable instructions for unsupported consumers without claiming application', async () => {
    const { cwd, request } = await setup();
    await writeOutputModeState(cwd, 'project', ['writer-author']);
    const result = await applyWritingConsumer('Original.', request);
    expect(result.state).toMatchObject({ selected: ['writer-author'], delivered: [], applied: [], fallback: 'unaltered' });
    expect(result.instructionExport).toContain('warmth');
    expect(result.instructionExport).not.toContain('Private author');
  });
  it('composes one writer, short structure and advisory engineering language', async () => {
    const { cwd, request } = await setup();
    const dir = path.join(cwd, '.aiwg', 'output-modes'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'short.json'), JSON.stringify({ id: 'short', version: '1', description: 'Short prose', kind: 'structure', stage: 'structure', instructions: 'Be concise without dropping qualifications.', provenance: { source: 'test', license: 'MIT' }, validation: { level: 'advisory' } }));
    const result = await applyWritingConsumer('Hello.', { ...request, invocationModes: ['short', 'writer-author', 'asd-ste'], runtime: { transform: (text, mode) => mode.id === 'writer-author' ? text.replace('Hello', 'Welcome') : text } });
    expect(result.state.selected).toEqual(['writer-author', 'asd-ste', 'short']);
    expect(result.content).toBe('Welcome.'); expect(result.state.applied).toEqual(result.state.selected);
    expect(result.state.validated).toEqual([]);
    expect(result.state.deliveredTo).toBe('local-transform-callback');
  });
  it('honors same-ID invocation precedence, isolates sessions/workspaces and rejects implicit voice merging', async () => {
    const { cwd, profile } = await setup();
    await writeOutputModeState(cwd, 'project', ['writer-author']);
    await writeOutputModeState(cwd, 'session', ['writer-author']);
    const resolved = await resolveOutputModes(cwd, cwd, ['writer-author']);
    expect(resolved.modes[0].scope).toBe('invocation');
    const other = path.join(cwd, 'other'); await mkdir(other);
    expect((await resolveOutputModes(other, other)).modes).toEqual([]);
    await new WriterProfileStore({ cwd }).save({ ...profile, id: 'second' }, 0);
    await expect(resolveOutputModes(cwd, cwd, ['writer-second'])).rejects.toThrow('merge');
    await writeOutputModeState(cwd, 'project', []);
    vi.stubEnv('AIWG_SESSION_ID', 'different-session');
    expect((await resolveOutputModes(cwd, cwd)).modes).toEqual([]);
  });
  it('keeps nested invocation selections local and disables or clears persistent selections', async () => {
    const { cwd, request } = await setup();
    const command = (args: string[]) => outputModeHandler.execute({ cwd, frameworkRoot: cwd, args, rawArgs: ['output-mode', ...args] });
    expect((await command(['enable', 'writer-author', '--scope', 'project'])).exitCode).toBe(0);
    const outer = await applyWritingConsumer('Hello.', { ...request, runtime: { transform: async text => {
      const inner = await applyWritingConsumer(text, { ...request, invocationModes: ['channel-engineering'] });
      expect(inner.state.selected).toContain('channel-engineering');
      return text;
    } } });
    expect(outer.state.selected).toEqual(['writer-author']);
    expect((await resolveOutputModes(cwd, cwd)).modes.map(mode => mode.id)).toEqual(['writer-author']);
    expect((await command(['disable', 'writer-author', '--scope', 'project'])).exitCode).toBe(0);
    expect((await resolveOutputModes(cwd, cwd)).modes).toEqual([]);
    expect((await command(['enable', 'writer-author', '--scope', 'session'])).exitCode).toBe(0);
    expect((await command(['clear', '--scope', 'session'])).exitCode).toBe(0);
    expect((await resolveOutputModes(cwd, cwd)).modes).toEqual([]);
  });
  it('MCP catalog omits private metadata and scoped reads use shared export policy', async () => {
    const { cwd } = await setup();
    const callbacks = new Map<string, (...args: any[]) => Promise<any>>();
    const server = { registerResource: (name: string, _uri: unknown, _metadata: unknown, callback: (...args: any[]) => Promise<any>) => callbacks.set(name, callback) };
    registerWriterProfileResources(server, { projectRoot: cwd, loadApi: async () => ({ ...profileApi, ...storeApi }) });
    const catalog = await callbacks.get('writer-profiles')!();
    expect(catalog.contents[0].text).not.toContain('Private author');
    const shared = await callbacks.get('writer-profile')!(new URL('aiwg://writer-profiles/project/author'), { scope: 'project', id: 'author' });
    expect(shared.contents[0].text).not.toContain('private source');
    expect(shared.contents[0].text).not.toContain('Private author sample prose');
    expect(JSON.parse(shared.contents[0].text).id).toBe('shared-profile');
    await expect(callbacks.get('writer-profile')!(new URL('aiwg://writer-profiles/user/author'), { scope: 'user', id: 'author' })).rejects.toThrow();
  });
});
