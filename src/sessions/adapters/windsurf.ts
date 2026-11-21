import { basename } from 'node:path';
import { z } from 'zod';
import {
  schemaRejectionDetail,
  schemaIssueDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import {
  streamBoundedJsonLines, type ReaderLimits,
} from '../readers.js';

export const DEVIN_DESKTOP_ADAPTER_VERSION = '1.1.0';
export const DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION = '1.0.0';
/** @deprecated Compatibility export. */
export const WINDSURF_ADAPTER_VERSION = DEVIN_DESKTOP_ADAPTER_VERSION;
/** @deprecated Compatibility export. */
export const WINDSURF_TRANSCRIPT_SCHEMA_VERSION = DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION;

const StepSchema = z.looseObject({
  schema_version: z.string().optional(),
  type: z.string().min(1),
  status: z.string().min(1),
  trajectory_id: z.string().min(1).optional(),
  execution_id: z.string().min(1).optional(),
  event_id: z.string().min(1).optional(),
  timestamp: z.string().optional(),
  model_name: z.string().optional(),
  model: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  sensitive_content_warning: z.union([z.boolean(), z.string(), z.record(z.string(), z.unknown())]).optional(),
  user_input: z.record(z.string(), z.unknown()).optional(),
  planner_response: z.record(z.string(), z.unknown()).optional(),
  code_action: z.record(z.string(), z.unknown()).optional(),
  tool_info: z.record(z.string(), z.unknown()).optional(),
});

type Step = z.infer<typeof StepSchema>;

export class DevinDesktopSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'devin-desktop' as const;
  readonly adapterVersion = DEVIN_DESKTOP_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  readonly supportedOperations = ['inspect', 'stream'] as const;
  readonly acquisitionModes = ['hook', 'jsonl'] as const;

  constructor(private readonly limits?: Partial<ReaderLimits>) {}

  async *discover(_scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    // Deliberately empty: hook enablement and transcript selection are explicit user actions.
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    const records = this.stream(source);
    let result = await records.next();
    while (!result.done) result = await records.next();
    return result.value;
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncGenerator<ProviderRecord, SourceProbe> {
    this.assertSupportedLocator(source);
    const start = parseCursor(cursor?.value);
    const input = await streamBoundedJsonLines({
      selectedPath: source.locator,
      allowedRoots: source.authorizedScope.allowedRoots,
    }, { consistency: 'provisional', limits: this.limits });
    let schemaVersion: string | null = null;
    let nativeSessionId: string | null = null;
    let seen = 0;
    for await (const line of input) {
      const parsed = StepSchema.safeParse(line.value);
      if (!parsed.success) {
        throw new SessionContractError('MALFORMED_SOURCE', 'Devin Desktop transcript step is malformed', schemaRejectionDetail(parsed.error));
      }
      const step = parsed.data;
      const currentVersion = step.schema_version ?? DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION;
      if (schemaVersion && schemaVersion !== currentVersion) {
        throw new SessionContractError('SCHEMA_DRIFT', 'mixed Devin Desktop transcript schemas', schemaIssueDetail('schema_version'));
      }
      schemaVersion = currentVersion;
      assertSupportedSchemaMajor(schemaVersion);
      const currentSession: string = step.trajectory_id
        ?? nativeSessionId
        ?? basename(source.locator, '.jsonl');
      if (step.trajectory_id && nativeSessionId && step.trajectory_id !== nativeSessionId) {
        throw new SessionContractError('SCHEMA_DRIFT', 'mixed Devin Desktop trajectory identities', schemaIssueDetail('trajectory_id'));
      }
      nativeSessionId = currentSession;
      if (seen++ < start) continue;
      yield normalizeStep(
        step,
        currentSession,
        line.sequence,
        line.byteOffset,
        canonicalLocatorClass(source.locatorClass),
        schemaVersion,
      );
    }
    if (seen === 0) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Devin Desktop transcript is empty or malformed', schemaIssueDetail('<root>'));
    }
    return {
      sourceSchemaVersion: schemaVersion!,
      consistency: 'provisional',
      operationalState: 'available',
    };
  }

  private assertSupportedLocator(source: SelectedSource): void {
    if (isLegacyLocator(source.locatorClass)) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        'legacy Devin Desktop/Windsurf protobuf stores are unsupported; enable post_cascade_response_with_transcript and select its JSONL output',
      );
    }
    if (!isCurrentHookLocator(source.locatorClass)) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        'Devin Desktop (legacy transcript compatibility) requires an explicitly selected post_cascade_response_with_transcript JSONL file',
      );
    }
  }
}

/** @deprecated Use DevinDesktopSessionAdapter; retained through the alias window. */
export class WindsurfSessionAdapter extends DevinDesktopSessionAdapter {}

function isCurrentHookLocator(value: string): boolean {
  return value === 'devin-desktop-cascade-hook-jsonl'
    || value === 'windsurf-cascade-hook-jsonl';
}

function isLegacyLocator(value: string): boolean {
  return value === 'devin-desktop-legacy-protobuf'
    || value === 'windsurf-legacy-protobuf';
}

function canonicalLocatorClass(value: string): string {
  return value.startsWith('windsurf-')
    ? `devin-desktop-${value.slice('windsurf-'.length)}`
    : value;
}

function normalizeStep(
  step: Step,
  nativeSessionId: string,
  sequence: number,
  offset: number,
  locatorClass: string,
  schemaVersion: string,
): ProviderRecord {
  const text = stepText(step);
  return {
    nativeSessionId,
    nativeEventId: step.event_id ?? (step.execution_id
      ? `${step.execution_id}:${sequence}` : `${nativeSessionId}:${sequence}`),
    sequence,
    kind: `devin-desktop.${step.type}`,
    role: step.type === 'user_input' ? 'user'
      : step.type === 'planner_response' ? 'assistant' : 'tool',
    participant: step.type === 'user_input' ? 'user'
      : step.type === 'planner_response' ? 'assistant' : 'tool',
    model: step.model_name ?? (typeof step.model === 'string' ? step.model : undefined),
    occurredAt: timestamp(step.timestamp),
    text,
    rawReference: { locatorClass, offset, sequence },
    extensions: {
      status: step.status,
      trajectoryId: step.trajectory_id ?? nativeSessionId,
      executionId: step.execution_id,
      model: step.model_name ?? step.model,
      sensitiveContentWarning: step.sensitive_content_warning ?? true,
      nativeStep: step,
      provenance: {
        acquisition: 'user-enabled-post_cascade_response_with_transcript',
        product: 'Devin Desktop',
        providerId: 'devin-desktop',
        compatibilityProviderId: 'windsurf',
        captureBoundary: 'completed-cascade-response',
        schema: schemaVersion,
        optInRequired: true,
        hookConfiguredByAiWG: false,
        credentialsInspected: false,
        environmentSecretsInspected: false,
        liveTokenCapture: false,
        completeHistoricalCapture: false,
        providerRetention: { maximumFiles: 100, evictionOrder: 'oldest-mtime' },
      },
      deletion: {
        aiwgDeletionDoesNotDeleteWindsurfTranscript: true,
        providerConversationDeletionStateUnknown: true,
      },
    },
  };
}

function stepText(step: Step): string {
  const candidate = step.type === 'user_input'
    ? step.user_input?.user_response
    : step.type === 'planner_response'
      ? step.planner_response?.response
      : step.code_action?.new_content ?? step.tool_info?.response;
  return typeof candidate === 'string' ? candidate : '';
}

function timestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SessionContractError('AMBIGUOUS_TIMESTAMP', 'invalid Devin Desktop timestamp');
  }
  return date.toISOString();
}

function parseCursor(value?: string): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new SessionContractError('SCHEMA_DRIFT', 'invalid Devin Desktop cursor', schemaIssueDetail('cursor'));
  return Number(value);
}
