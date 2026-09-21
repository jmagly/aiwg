import { basename, extname } from 'node:path';
import {
  SessionContractError,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import { readBoundedText, type ReaderLimits } from '../readers.js';

export const GROK_BUILD_ADAPTER_VERSION = '1.0.0';
export const GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION = '1.0.0';
export const GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS = 'grok-build-cli-markdown-export';

interface ExportBlock {
  heading: 'User' | 'Assistant' | 'Tools';
  text: string;
}

/**
 * Imports the documented `grok export <session-id> <file>` surface.
 *
 * The public export contract is intentionally lossy. Direct reads from
 * $GROK_HOME/sessions are prohibited until a released native schema has been
 * qualified independently.
 */
export class GrokBuildSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'grok-build' as const;
  readonly adapterVersion = GROK_BUILD_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  readonly supportedOperations = ['inspect', 'stream'] as const;
  readonly acquisitionModes = ['manual-export'] as const;

  constructor(private readonly limits?: Partial<ReaderLimits>) {}

  async *discover(_scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'Grok Build native-store discovery is disabled. Run `grok sessions list`, then '
        + '`grok export <session-id> <session-id>.md` and import that authorized export.',
    );
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    await this.readSource(source);
    return {
      sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
      consistency: 'complete',
      operationalState: 'available',
    };
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    const parsed = await this.readSource(source);
    const start = parseCursor(cursor?.value);
    for (const [sequence, block] of parsed.blocks.entries()) {
      if (sequence < start) continue;
      if (block.heading === 'Tools') {
        for (const tool of parseTools(block.text, sequence)) yield {
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

  private async readSource(source: SelectedSource): Promise<{
    sessionId: string;
    blocks: ExportBlock[];
  }> {
    if (source.locatorClass !== GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        'Grok Build accepts only a documented `grok export` Markdown transcript; '
          + 'native session files, Grok Bot exports, and Cursor stores are not supported.',
      );
    }
    const filename = basename(source.locator, extname(source.locator));
    if (!UUID.test(filename)) {
      throw new SessionContractError(
        'MALFORMED_SOURCE',
        'Grok Build export filename must be <session-id>.md so the documented CLI session ID is preserved.',
      );
    }
    const { value } = await readBoundedText({
      selectedPath: source.locator,
      allowedRoots: source.authorizedScope.allowedRoots,
    }, this.limits);
    const blocks = parseBlocks(value);
    if (blocks.length === 0 || !blocks.some((block) => block.heading === 'User')) {
      throw new SessionContractError(
        'MALFORMED_SOURCE',
        'Unrecognized Grok Build CLI export; expected exact `## User`, `## Assistant`, or `## Tools` headings.',
      );
    }
    return { sessionId: filename.toLowerCase(), blocks };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBlocks(value: string): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  let current: { heading: ExportBlock['heading']; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) blocks.push({ heading: current.heading, text });
  };
  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^## (User|Assistant|Tools)$/.exec(line);
    if (match) {
      flush();
      current = { heading: match[1] as ExportBlock['heading'], lines: [] };
    } else if (/^##\s+/.test(line) && !current) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `unknown Grok Build CLI export heading: ${line}`,
      );
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'unexpected content before the first Grok Build CLI export heading',
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
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.map((line, index) => {
    const match = /^- (.+)$/.exec(line);
    if (!match) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `unrecognized Grok Build tool summary: ${line}`,
      );
    }
    const summary = match[1];
    const name = summary.split(/:| \(/, 1)[0]?.trim();
    if (!name) {
      throw new SessionContractError('SCHEMA_DRIFT', 'empty Grok Build tool summary');
    }
    return { sequence: blockSequence * 1_000 + index, name, text: summary };
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
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build export cursor');
  }
  return Number(value);
}
