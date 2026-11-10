import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { GrokBuildCliOptions } from '../grok-build-cli.js';
import { canFallbackGrokNative, withGrokCliFallback } from './grok-build-fallback.js';
import {
  SessionContractError,
  schemaIssueDetail,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import { readBoundedText, type ReaderLimits } from '../readers.js';
import {
  assertGrokBuildNativeEnabled,
  discoverGrokBuildNativeChatHistories,
  GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES,
  GROK_BUILD_NATIVE_LOCATOR_CLASS,
  GROK_BUILD_NATIVE_SCHEMA_VERSION,
  grokBuildNativeSessionId,
  grokBuildNativeEnabled,
  parseGrokBuildNativeCursor,
  nativeRecordPrefixes,
  readGrokBuildNativeChatHistory,
  toGrokBuildNativeRecord,
} from './grok-build-native.js';

export const GROK_BUILD_ADAPTER_VERSION = '1.2.0';
export const GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION = '1.0.0';
export const GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS = 'grok-build-cli-markdown-export';

interface ExportBlock {
  heading: 'User' | 'Assistant' | 'Tools';
  text: string;
}

/**
 * Imports the documented `grok export <session-id> <file>` surface plus the
 * experimental native `chat_history.jsonl` store with an explicit environment
 * opt-in and an explicitly authorized sessions root (`--grok-root`).
 *
 * The public export contract is intentionally lossy. Native reads use the
 * captured 1.0.77 projection in grok-build-native.ts; anything outside
 * the observed schema fails closed. Explicit CLI imports supply bounded CLI
 * options to fall back to export; direct API callers may supply the same options.
 */
export class GrokBuildSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'grok-build' as const;
  readonly adapterVersion = GROK_BUILD_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  // Compaction rewrites chat history; native cursors validate the retained projection.
  readonly sourceContinuity = 'snapshot' as const;
  get supportedOperations() {
    return grokBuildNativeEnabled() ? ['discover', 'inspect', 'stream'] as const : ['inspect', 'stream'] as const;
  }
  get acquisitionModes() {
    return grokBuildNativeEnabled() ? ['manual-export', 'jsonl'] as const : ['manual-export'] as const;
  }

  constructor(
    private readonly limits?: Partial<ReaderLimits>,
    private readonly maxFiles = GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES,
    private readonly cliFallback?: GrokBuildCliOptions,
  ) {}

  async *discover(scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    assertGrokBuildNativeEnabled();
    if (scope.allowedRoots.length === 0) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Grok Build native discovery requires an explicitly authorized sessions root; pass --grok-root.',
      );
    }
    for (const root of [...scope.allowedRoots].sort()) {
      yield* discoverGrokBuildNativeChatHistories(root, this.maxFiles);
    }
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    if (source.locatorClass === GROK_BUILD_NATIVE_LOCATOR_CLASS) {
      let native;
      try { native = await readGrokBuildNativeChatHistory(source, this.limits); } catch (error) {
        if (!canFallbackGrokNative(error, this.cliFallback)) throw error;
        return withGrokCliFallback(source, this.cliFallback!, selected => this.inspect(selected));
      }
      return {
        sourceSchemaVersion: GROK_BUILD_NATIVE_SCHEMA_VERSION,
        consistency: native.incompleteTail ? 'provisional' : 'complete',
        operationalState: 'available',
      };
    }
    await this.readSource(source);
    return {
      sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
      consistency: 'complete',
      operationalState: 'available',
    };
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    if (source.locatorClass === GROK_BUILD_NATIVE_LOCATOR_CLASS) {
      if (cursor?.value.startsWith('grok-cli:')) {
        yield* await this.fallbackRecords(source, cursor.value.slice('grok-cli:'.length));
        return;
      }
      let native;
      try { native = await readGrokBuildNativeChatHistory(source, this.limits); } catch (error) {
        if (!canFallbackGrokNative(error, this.cliFallback)) throw error;
        if (cursor?.value && cursor.value !== '0') throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build acquisition changed after a native checkpoint; restart with a separate CLI export source.');
        yield* await this.fallbackRecords(source);
        return;
      }
      const sessionId = grokBuildNativeSessionId(source.locator)!;
      const prefixes = nativeRecordPrefixes(native.records);
      const acquisition = native.records[0]?.record.acquisition === 'grok-build-native-updates' ? 'updates' : 'chat';
      const saved = cursor?.value?.match(/^grok-native:(chat|updates):(\d+):([a-f0-9]{64})$/);
      const start = parseGrokBuildNativeCursor(saved?.[2] ?? cursor?.value);
      if (start > native.records.length || (saved && (saved[1] !== acquisition || saved[3] !== prefixes[start]))) {
        throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build native checkpoint projection changed; use a separate source and `grok export` for review.');
      }
      let outputIndex = 0;
      for (const entry of native.records) {
        const position = outputIndex;
        outputIndex += 1;
        if (position < start) continue;
        const record = toGrokBuildNativeRecord(sessionId, entry);
        record.sourceCursor = `grok-native:${acquisition}:${outputIndex}:${prefixes[outputIndex]}`;
        yield record;
      }
      return;
    }
    const saved = cursor?.value?.match(/^grok-export:(\d+):([a-f0-9]{64})$/);
    const start = parseCursor(saved?.[1] ?? cursor?.value);
    const hash = createHash('sha256');
    let outputIndex = 0;
    for await (const record of this.exportRecords(source)) {
      hash.update(JSON.stringify(record) + '\n');
      outputIndex += 1;
      const digest = hash.copy().digest('hex');
      if (outputIndex === start && saved && digest !== saved[2]) {
        throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build export checkpoint prefix changed; review and import a separate export source.');
      }
      if (outputIndex <= start) continue;
      yield { ...record, sourceCursor: `grok-export:${outputIndex}:${digest}` };
    }
    if (start > outputIndex) throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build export checkpoint is beyond the retained transcript; use a separate export source.');
  }

  private async *exportRecords(source: SelectedSource): AsyncIterable<ProviderRecord> {
    const parsed = await this.readSource(source);
    for (const [sequence, block] of parsed.blocks.entries()) {
      if (block.heading === 'Tools') {
        for (const tool of parseTools(block.text, sequence)) {
          yield {
            nativeSessionId: parsed.sessionId,
            nativeEventId: undefined,
            sequence: tool.sequence,
            kind: 'tool-call',
            role: 'tool',
            toolName: tool.name,
            occurredAt: undefined,
            text: tool.text,
            rawReference: { locatorClass: source.locatorClass, sequence },
            extensions: provenance(source, parsed.sessionId, 'Tools'),
          };
        }
        continue;
      }
      yield {
        nativeSessionId: parsed.sessionId,
        nativeEventId: undefined,
        sequence: sequence * 1_000,
        kind: 'message',
        role: block.heading === 'User' ? 'user' : 'assistant',
        occurredAt: undefined,
        text: block.text,
        rawReference: { locatorClass: source.locatorClass, sequence },
        extensions: provenance(source, parsed.sessionId, block.heading),
      };
    }
  }

  private async fallbackRecords(source: SelectedSource, cursor?: string): Promise<ProviderRecord[]> {
    const saved = cursor?.match(/^(\d+):([a-f0-9]{64})$/);
    const start = parseCursor(saved?.[1] ?? cursor);
    if (!this.cliFallback) throw new SessionContractError('UNSUPPORTED_OPERATION', 'Grok Build CLI fallback is unavailable; use an explicit `grok export`.');
    return withGrokCliFallback(source, this.cliFallback, async selected => {
      const records: ProviderRecord[] = [];
      for await (const record of this.stream(selected, { value: saved ? `grok-export:${cursor}` : String(start) })) {
        const extensions = record.extensions ?? {};
        records.push({ ...record, sourceCursor: record.sourceCursor!.replace('grok-export:', 'grok-cli:'), extensions: { ...extensions,
          provenance: { ...(extensions.provenance as Record<string, unknown>), nativeFallback: true },
        } });
      }
      return records;
    });
  }

  private async readSource(source: SelectedSource): Promise<{
    sessionId: string;
    blocks: ExportBlock[];
  }> {
    if (source.locatorClass !== GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        'Grok Build accepts only a documented `grok export` Markdown transcript or an '
          + `explicitly authorized \`${GROK_BUILD_NATIVE_LOCATOR_CLASS}\` source; `
          + 'Grok Bot exports and Cursor stores are not supported.',
      );
    }
    const filename = basename(source.locator, extname(source.locator));
    if (extname(source.locator).toLowerCase() !== '.md' || !UUID.test(filename)) {
      throw new SessionContractError(
        'MALFORMED_SOURCE',
        'Grok Build export filename must be <session-id>.md so the documented CLI session ID is preserved.',
        schemaIssueDetail('filename'),
      );
    }
    const { value } = await readBoundedText({
      selectedPath: source.locator,
      allowedRoots: source.authorizedScope.allowedRoots,
    }, this.limits);
    const blocks = validateGrokBuildMarkdown(value);
    return { sessionId: filename.toLowerCase(), blocks };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateGrokBuildMarkdown(value: string): ExportBlock[] {
  const blocks = parseBlocks(value);
  for (const [sequence, block] of blocks.entries()) {
    if (block.heading === 'Tools') parseTools(block.text, sequence);
  }
  if (blocks.length === 0 || !blocks.some((block) => block.heading === 'User')) {
    throw new SessionContractError(
      'MALFORMED_SOURCE',
      'Unrecognized Grok Build CLI export; expected exact `## User`, `## Assistant`, or `## Tools` headings.',
      schemaIssueDetail('headings'),
    );
  }
  return blocks;
}

function parseBlocks(value: string): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  let current: { heading: ExportBlock['heading']; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (!text && current.heading === 'Tools') {
      throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build tools block is empty', schemaIssueDetail('tools'));
    }
    if (text) blocks.push({ heading: current.heading, text });
  };
  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^## (User|Assistant|Tools)$/.exec(line);
    if (match) {
      flush();
      current = { heading: match[1] as ExportBlock['heading'], lines: [] };
    } else if (/^##\s+/.test(line)) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'unknown Grok Build CLI export heading; check the source CLI version',
        schemaIssueDetail('headings'),
      );
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'unexpected content before the first Grok Build CLI export heading',
        schemaIssueDetail('headings'),
      );
    }
  }
  flush();
  return blocks;
}

function parseTools(text: string, blockSequence: number): Array<{
  sequence: number;
  name: string;
  text: string;
}> {
  const summaries: string[] = [];
  for (const line of text.split('\n')) {
    if (/^- .+/.test(line)) summaries.push(line.slice(2));
    else if (summaries.length) summaries[summaries.length - 1] += `\n${line}`;
    else if (line.trim()) {
      throw new SessionContractError('SCHEMA_DRIFT', 'unrecognized Grok Build tool summary', schemaIssueDetail('tools'));
    }
  }
  if (!summaries.length || summaries.length > 1_000) {
    throw new SessionContractError('SCHEMA_DRIFT', 'Grok Build tools block has no summaries or exceeds 1,000 summaries', schemaIssueDetail('tools'));
  }
  return summaries.map((summary, index) => {
    const name = summary.split(/:| \(/, 1)[0]?.trim();
    if (!name) throw new SessionContractError('SCHEMA_DRIFT', 'empty Grok Build tool summary', schemaIssueDetail('tools'));
    return { sequence: blockSequence * 1_000 + index, name, text: summary.trimEnd() };
  });
}

function provenance(
  source: SelectedSource,
  sessionId: string,
  heading: ExportBlock['heading'],
): Record<string, unknown> {
  return {
    lifecycle: 'unknown-at-import',
    provenance: {
      product: 'grok-build',
      acquisition: 'grok-cli-export-markdown',
      exportCommand: `grok export ${sessionId} ${sessionId}.md`,
      sourceSchema: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
      heading,
      nativeStoreInspected: false,
      toolOutputAvailable: false,
      originalFilename: basename(source.locator),
    },
    identity: {
      nativeSessionIdKnown: true,
      nativeEventIdKnown: false,
    },
    lossReport: {
      lossless: false,
      unavailableInCliExport: [
        'timestamps', 'model', 'grokVersion', 'workingDirectory', 'toolResults',
        'attachments', 'fileSnapshots', 'compaction', 'lineage', 'subagents',
      ],
    },
  };
}

function parseCursor(value?: string): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build export cursor', schemaIssueDetail('cursor'));
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build export cursor', schemaIssueDetail('cursor'));
  }
  return cursor;
}
