/**
 * Grok Bot session adapter — manual-export only until product evidence exists
 * for a native session filesystem or API locator.
 *
 * Auto-discover is unsupported and must never scrape invented ~/.grokbot,
 * Cursor session paths, or other unverified roots.
 *
 * Authorized imports reuse the AIWG generic session interchange format so
 * operators can supply an explicit export without inventing a Grok schema.
 *
 * @see docs/providers/grokbot-sessions.md
 * @issue #215
 */

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
import {
  GenericSessionInterchangeAdapter,
} from './generic.js';
import type { ReaderLimits } from '../readers.js';

export const GROKBOT_ADAPTER_VERSION = '1.0.0';
export const GROKBOT_EXPORT_SCHEMA_VERSION = '1.0.0';
export const GROKBOT_LOCATOR_CLASS = 'manual-export' as const;

export class GrokbotSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'grokbot' as const;
  readonly adapterVersion = GROKBOT_ADAPTER_VERSION;
  readonly disposition = 'manual-only' as const;
  readonly supportedOperations = ['inspect', 'stream'] as const;
  readonly acquisitionModes = ['manual-export'] as const;

  private readonly interchange: GenericSessionInterchangeAdapter;

  constructor(limits?: Partial<ReaderLimits>) {
    this.interchange = new GenericSessionInterchangeAdapter(limits);
  }

  async *discover(_scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'Grok Bot session auto-discover is unsupported until a verified native locator exists; '
        + 'select an authorized manual export explicitly. AIWG does not scrape ~/.grokbot, '
        + '~/grokbot-skills, or Cursor session paths.',
    );
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    this.assertManualExport(source);
    return this.interchange.inspect(source);
  }

  async *stream(
    source: SelectedSource,
    cursor?: ImportCursor,
  ): AsyncIterable<ProviderRecord> {
    this.assertManualExport(source);
    yield* this.interchange.stream(source, cursor);
  }

  private assertManualExport(source: SelectedSource): void {
    if (source.locatorClass !== GROKBOT_LOCATOR_CLASS) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        `Grok Bot supports only locatorClass "${GROKBOT_LOCATOR_CLASS}" until native session evidence exists `
          + `(got "${source.locatorClass}"). Do not reuse Cursor session locators.`,
      );
    }
  }
}
