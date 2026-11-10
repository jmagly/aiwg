// Synthetic native-source append fixtures shared by tail service and CLI tests.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSessionAdapterRegistry } from '../../../src/sessions/adapter-registry.js';
import { grokbotTranscriptReplicaFilename } from '../../../src/sessions/adapters/grokbot-locator.js';
import { type SelectedSource, type SessionSource, type SessionProviderId } from '../../../src/sessions/contracts.js';

const grokbot = grokbotTranscriptReplicaFilename('synthtest01', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1');
export const tailFixtures: Array<[SessionProviderId, string, string]> = [
  ['claude', 'claude-transcript-jsonl', 'claude/fork-session.jsonl'],
  ['codex', 'codex-rollout-jsonl', 'codex/rollout-2026-07-27T10-00-00-019d0000-0000-7000-8000-000000000003.jsonl'],
  ['muse', 'muse-native-session-log', 'muse/native/2026/09/25/00000000-0000-4000-8000-000000000002/session.jsonl'],
  ['grokbot', 'grokbot-native-transcript-replica', `grokbot/native/${grokbot}`],
  ['pi', 'pi-session-v3-jsonl', 'pi/valid.jsonl'],
  ['copilot', 'copilot-chat-json-export', 'copilot/complete.chat.json'],
  ['cursor', 'cursor-cli-stream-json', 'cursor/cli-complete.jsonl'],
  ['factory', 'factory-droid-jsonl', 'factory/complete.jsonl'],
  ['hermes', 'hermes-export-jsonl', 'hermes/complete.jsonl'],
  ['opencode', 'opencode-sse-jsonl', 'opencode/events.jsonl'],
  ['openclaw', 'openclaw-consistent-snapshot-jsonl', 'openclaw/complete.jsonl'],
  ['openhuman', 'openhuman-enriched-jsonl', 'openhuman/complete.jsonl'],
  ['grok-build', 'grok-build-native-chat-history', 'grok-build/native-layout/%2Fsynthetic%2Fgrok-workspace/0199b111-1111-7111-8111-111111111111/chat_history.jsonl'],
  ['omp', 'omp-session-v3-jsonl', 'omp/title-slot.jsonl'],
  ['deepseek-harness', 'deepseek-harness-session-v2-jsonl', 'deepseek-harness/session.v2.jsonl'],
  ['warp', 'warp-markdown-export', 'warp/complete.md'],
  ['devin-desktop', 'windsurf-cascade-hook-jsonl', 'windsurf/current.jsonl'],
  ['generic', 'manual-export', 'generic/valid-v1.jsonl'],
];

export async function tailFixture(root: string, entry = tailFixtures[0]) {
  const [provider, locatorClass, relative] = entry;
  const locator = resolve(root, relative);
  await mkdir(dirname(locator), { recursive: true });
  let full = await readFile(resolve('test/fixtures/sessions', relative), 'utf8');
  if (provider === 'codex') full = full.trimEnd().split('\n').filter(line => { try { JSON.parse(line); return true; } catch { return false; } }).join('\n') + '\n';
  if (provider === 'claude') full = full.replace('Fork-specific response', 'Fork-specific response token=tail-secret-canary synthetic@example.test');
  let initial: string;
  let rewrite = false;
  if (provider === 'grokbot') {
    const doc = JSON.parse(full);
    initial = full;
    const last = Math.max(...doc.value.entries.map((entry: { seq: number }) => entry.seq));
    doc.value.entries.push({ kind: 'message', id: 'tail-native-event', seq: last + 1,
      timestampMs: 1700000100000, role: 'assistant', content: 'appended fixture event' });
    full = JSON.stringify(doc);
    rewrite = true;
  } else if (provider === 'copilot') {
    initial = full;
    const doc = JSON.parse(full);
    doc.requests.push({ ...doc.requests[0], requestId: 'tail-appended-request' });
    full = JSON.stringify(doc);
    rewrite = true;
  } else if (provider === 'hermes' || provider === 'openclaw') {
    const doc = JSON.parse(full);
    const records = provider === 'hermes' ? doc.messages : doc.sessions[0].events;
    records.pop();
    initial = JSON.stringify(doc) + '\n';
    rewrite = true;
  } else if (provider === 'warp' || relative.endsWith('.md')) {
    initial = full.slice(0, full.lastIndexOf('\n## ')) + '\n';
    full = initial + full.slice(full.lastIndexOf('\n## ') + 1);
  } else {
    const lines = full.trimEnd().split('\n');
    initial = lines.slice(0, -1).join('\n') + '\n';
    full = lines.join('\n') + '\n';
  }
  if (provider === 'grok-build' && locatorClass === 'grok-build-native-chat-history') {
    await writeFile(resolve(dirname(locator), 'summary.json'), await readFile(resolve('test/fixtures/sessions', dirname(relative), 'summary.json'), 'utf8'));
  }
  await writeFile(locator, full);
  const adapter = createSessionAdapterRegistry().get(provider);
  const selectedSource: SelectedSource = { provider, sourceId: provider === 'generic' ? 'generic-fixture-v1' : `tail-${provider}`, locatorClass, locator,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] } };
  const records = [];
  for await (const record of adapter.stream(selectedSource)) records.push(record);
  const probe = await adapter.inspect(selectedSource);
  const source: SessionSource = { contractVersion: '1.0.0', sourceId: selectedSource.sourceId,
    provider, providerProfile: 'synthetic-tail-fixture', locatorClass, redactedLocator: '<fixture>',
    adapterVersion: adapter.adapterVersion, disposition: adapter.disposition, ...probe,
    authorizedAt: '2026-10-01T00:00:00Z', extensions: {} };
  await writeFile(locator, initial);
  return { adapter, source, selectedSource, records,
    append: () => rewrite ? writeFile(locator, full) : appendFile(locator, full.slice(initial.length)) };
}
