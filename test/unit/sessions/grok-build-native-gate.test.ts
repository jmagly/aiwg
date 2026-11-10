// Verify that unqualified native storage requires an explicit experimental opt-in.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GrokBuildSessionAdapter, GROK_BUILD_NATIVE_LOCATOR_CLASS,
  discoverGrokBuildNativeChatHistories, readGrokBuildNativeChatHistory,
  readGrokBuildActiveRegistry, discoverWorkspaceHistories,
  type SelectedSource,
} from '../../../src/sessions/index.js';

const optIn = 'AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL';
const root = resolve('test/fixtures/sessions/grok-build');
const nativeRoot = resolve(root, 'native-layout');
const source: SelectedSource = {
  provider: 'grok-build', sourceId: 'experimental-fixture',
  locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
  locator: resolve(nativeRoot, '%2Fsynthetic%2Fgrok-workspace',
    '0199b111-1111-7111-8111-111111111111', 'chat_history.jsonl'),
  authorizedScope: { workspaceId: 'synthetic', allowedRoots: [nativeRoot] },
};
const denied = {
  code: 'UNSUPPORTED_OPERATION',
  message: expect.stringMatching(/experimental.*unqualified.*AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1.*grok export/),
};
const roots: string[] = [];
beforeEach(() => vi.stubEnv(optIn, undefined));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) result.push(item);
  return result;
}

it.each([undefined, '', '0', 'true'])('does not advertise native ingestion with opt-in %s', value => {
  vi.stubEnv(optIn, value);
  const adapter = new GrokBuildSessionAdapter();
  expect(adapter.supportedOperations).toEqual(['inspect', 'stream']);
  expect(adapter.acquisitionModes).toEqual(['manual-export']);
});

it.each(['discover', 'inspect', 'stream'] as const)('blocks adapter %s of native storage by default', async operation => {
  const adapter = new GrokBuildSessionAdapter();
  const pending = operation === 'discover' ? collect(adapter.discover(source.authorizedScope))
    : operation === 'inspect' ? adapter.inspect(source) : collect(adapter.stream(source));
  await expect(pending).rejects.toMatchObject(denied);
});

it('reports the experimental gate before a malformed native stream locator', async () => {
  const malformed = { ...source, locator: resolve(nativeRoot, 'not-a-uuid', 'chat_history.jsonl') };
  await expect(collect(new GrokBuildSessionAdapter().stream(malformed))).rejects.toMatchObject(denied);
});

it('explains the experimental gate before checking discovery root grants', async () => {
  await expect(collect(new GrokBuildSessionAdapter().discover({
    workspaceId: 'synthetic', allowedRoots: [],
  }))).rejects.toMatchObject(denied);
});

it.each(['discover', 'read', 'active-registry'])('blocks direct native %s helpers by default', async operation => {
  const pending = operation === 'discover' ? collect(discoverGrokBuildNativeChatHistories(nativeRoot))
    : operation === 'read' ? readGrokBuildNativeChatHistory(source)
    : readGrokBuildActiveRegistry(resolve(root, 'native-active-sessions.json'), [root]);
  await expect(pending).rejects.toMatchObject(denied);
});

it('reports why workspace discovery needs CLI export even with an authorized native root', async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), 'aiwg-grok-gate-'));
  roots.push(workspace);
  const manifest = await discoverWorkspaceHistories({
    workspace, providerHome: workspace, expectedProviders: ['grok-build'], grokRoot: nativeRoot,
  });
  expect(manifest.sources).toEqual([]);
  expect(manifest.providers).toEqual([expect.objectContaining({
    status: 'export-required', disposition: 'manual-export',
    reasonCode: 'GROK_BUILD_NATIVE_EXPERIMENTAL_DISABLED',
    remediation: expect.stringContaining(`${optIn}=1`),
  })]);
});

it('enables the existing synthetic fixture only with opt-in and blocks reads after revocation', async () => {
  const adapter = new GrokBuildSessionAdapter();
  vi.stubEnv(optIn, '1'); vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  expect(adapter.supportedOperations).toEqual(['discover', 'inspect', 'stream']);
  expect(adapter.acquisitionModes).toEqual(['manual-export', 'jsonl']);
  expect(await collect(adapter.stream(source))).toHaveLength(4);
  vi.stubEnv(optIn, undefined);
  await expect(adapter.inspect(source)).rejects.toMatchObject(denied);
});
