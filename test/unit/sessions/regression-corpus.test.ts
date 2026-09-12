import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  CursorSessionAdapter,
  FactorySessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceSchema,
  deriveSessionTimeline,
  type SelectedSource,
  type SessionProviderId,
  type SessionSourceAdapter,
} from '../../../src/sessions/index.js';
import {
  scanSessionFixtureText,
  scanSessionRegressionCorpus,
} from '../../../tools/ci/session-fixture-sanitize.mjs';
import { itWithSqlite } from '../../helpers/sqlite.js';

interface CorpusFile {
  path: string;
  provider: 'claude' | 'codex' | 'cursor' | 'factory';
  case: 'positive' | 'malformed';
  locatorClass: string;
  schemaFamily: string;
  schemaVersion: string;
  providerVersion: string;
  regressions: number[];
  sha256: string;
}

interface CorpusManifest {
  schemaVersion: string;
  corpusId: string;
  files: CorpusFile[];
}

const root = resolve('.');
const corpusRoot = resolve(root, 'test/fixtures/sessions/regression-v1');
const manifest = JSON.parse(
  readFileSync(resolve(corpusRoot, 'manifest.json'), 'utf8'),
) as CorpusManifest;

describe('versioned session regression corpus', () => {
  it('passes the content-free sanitizer and reports no matched values', () => {
    expect(scanSessionRegressionCorpus(corpusRoot)).toMatchObject({
      corpusId: manifest.corpusId,
      findings: [],
    });

    const canary = ['AKIA', '0'.repeat(16)].join('');
    const findings = scanSessionFixtureText(
      'synthetic-canary.jsonl',
      JSON.stringify({ value: canary }),
    );
    expect(findings).toEqual([{
      file: 'synthetic-canary.jsonl',
      ruleId: 'AWS_ACCESS_KEY',
      line: 1,
      column: 11,
    }]);
    expect(JSON.stringify(findings)).not.toContain(canary);
  });

  it.each(manifest.files.filter((entry) => entry.case === 'malformed'))(
    'retains a failing $provider malformed regression fixture',
    async (entry) => {
      const adapter = adapterFor(entry.provider);
      const selected = selectedSource(entry);
      await expect(collect(adapter.stream(selected))).rejects.toMatchObject({
        code: 'MALFORMED_SOURCE',
      });
    },
  );

  itWithSqlite('imports all positive fixtures with stable cross-provider identity and replay', async () => {
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const workspaceId = 'workspace-regression-corpus';
    const positives = manifest.files.filter((entry) => entry.case === 'positive');
    const requests = [];

    try {
      for (const entry of positives) {
        const adapter = adapterFor(entry.provider);
        const selected = selectedSource(entry, workspaceId);
        const probe = await adapter.inspect(selected);
        const source = SessionSourceSchema.parse({
          contractVersion: SESSION_CONTRACT_VERSION,
          sourceId: selected.sourceId,
          provider: entry.provider,
          providerProfile: 'regression-corpus-v1',
          locatorClass: entry.locatorClass,
          redactedLocator: `<regression-corpus>/${entry.path}`,
          adapterVersion: adapter.adapterVersion,
          sourceSchemaVersion: probe.sourceSchemaVersion,
          disposition: adapter.disposition,
          operationalState: probe.operationalState,
          consistency: probe.consistency,
          authorizedAt: '2026-07-28T00:00:00.000Z',
          extensions: {
            [`native.${entry.provider}`]: {
              fixtureProvenance: {
                corpusId: manifest.corpusId,
                schemaFamily: entry.schemaFamily,
                schemaVersion: entry.schemaVersion,
                providerVersion: entry.providerVersion,
                sha256: entry.sha256,
              },
            },
          },
        });
        const request = {
          source,
          selectedSource: selected,
          adapter,
          workspaceId,
          policyVersion: '1.0.0',
          limits: { batchSize: 2 },
        };
        requests.push(request);
        const receipts = await importer.import(request);
        expect(receipts.reduce((sum, receipt) => sum + receipt.eventsInserted, 0))
          .toBeGreaterThan(0);
      }

      const first = repository.listSessions({ workspaceId, limit: 20 });
      expect(first.total).toBe(4);
      expect(new Set(first.items.map((session) => session.provider))).toEqual(
        new Set(['claude', 'codex', 'cursor', 'factory']),
      );
      expect(new Set(first.items.map((session) => session.sessionId)).size).toBe(4);
      expect(first.items.every((session) =>
        session.intent.status === 'selected'
        && session.intent.summary?.startsWith('Validate the synthetic'))).toBe(true);

      const firstEvents = first.items.flatMap((session) =>
        repository.listEvents(session.sessionId, workspaceId));
      expect(new Set(firstEvents.map((event) => event.eventId)).size).toBe(firstEvents.length);
      expect(firstEvents.filter((event) => event.nativeId?.startsWith('shared-event')))
        .toHaveLength(4);

      for (const request of requests) {
        expect(await importer.import(request)).toEqual([]);
      }
      const replayEvents = repository.listSessions({ workspaceId, limit: 20 }).items
        .flatMap((session) => repository.listEvents(session.sessionId, workspaceId));
      expect(replayEvents.map((event) => event.eventId).sort())
        .toEqual(firstEvents.map((event) => event.eventId).sort());

      const timeline = deriveSessionTimeline(repository.listTimelineInputs(workspaceId), 12 * 60 * 60 * 1_000);
      expect(timeline.length).toBeGreaterThan(first.total);
      expect(timeline.some((segment) => segment.boundaryBasis === 'inferred-gap')).toBe(true);
      expect(first.items.find((session) => session.provider === 'cursor')?.lifecycle).toBe('complete');
      expect(first.items.find((session) => session.provider === 'factory')?.lifecycle).toBe('complete');

      const claudeEntry = positives.find((entry) => entry.provider === 'claude')!;
      const claudeRecords = await collect(
        adapterFor('claude').stream(selectedSource(claudeEntry, workspaceId)),
      );
      expect(claudeRecords.at(-1)?.extensions?.transcriptFamily).toMatchObject({
        nativeSessionId: 'shared-session',
        parentSessionId: 'shared-session',
        continuation: true,
        subagent: true,
      });
    } finally {
      repository.close();
    }
  });
});

function adapterFor(provider: SessionProviderId): SessionSourceAdapter {
  const adapters: Partial<Record<SessionProviderId, () => SessionSourceAdapter>> = {
    claude: () => new ClaudeSessionAdapter(),
    codex: () => new CodexSessionAdapter(),
    cursor: () => new CursorSessionAdapter(),
    factory: () => new FactorySessionAdapter(),
  };
  const create = adapters[provider];
  if (!create) throw new Error(`regression corpus has no adapter for ${provider}`);
  return create();
}

function selectedSource(
  entry: CorpusFile,
  workspaceId = 'workspace-regression-corpus',
): SelectedSource {
  const locator = resolve(corpusRoot, entry.path);
  return {
    provider: entry.provider,
    locator,
    locatorClass: entry.locatorClass,
    sourceId: `regression-corpus-${entry.provider}`,
    authorizedScope: {
      workspaceId,
      allowedRoots: [dirname(locator)],
    },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of values) output.push(value);
  return output;
}
