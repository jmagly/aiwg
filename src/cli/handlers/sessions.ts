import {
  existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  basename, dirname, isAbsolute, join, resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLAUDE_ADAPTER_VERSION,
  ClaudeSessionAdapter,
  CODEX_ADAPTER_VERSION,
  CodexSessionAdapter,
  COPILOT_ADAPTER_VERSION,
  CopilotSessionAdapter,
  CURSOR_ADAPTER_VERSION,
  CursorSessionAdapter,
  FACTORY_ADAPTER_VERSION,
  FactorySessionAdapter,
  HERMES_ADAPTER_VERSION,
  HermesSessionAdapter,
  OPENCODE_ADAPTER_VERSION,
  OpenCodeSessionAdapter,
  OPENCLAW_ADAPTER_VERSION,
  OpenClawSessionAdapter,
  OPENHUMAN_ADAPTER_VERSION,
  OpenHumanSessionAdapter,
  GROKBOT_ADAPTER_VERSION,
  GrokbotSessionAdapter,
  GROK_BUILD_ADAPTER_VERSION,
  GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
  GrokBuildSessionAdapter,
  grokBuildList,
  grokBuildSearch,
  grokBuildExport,
  grokHeadlessSessionIdFromFile,
  MUSE_ADAPTER_VERSION,
  MuseSessionAdapter,
  PI_ADAPTER_VERSION,
  PiSessionAdapter,
  DEEPSEEK_HARNESS_ADAPTER_VERSION,
  DeepSeekHarnessSessionAdapter,
  OmpSessionAdapter,
  OMP_ADAPTER_VERSION,
  WARP_ADAPTER_VERSION,
  WarpSessionAdapter,
  DEVIN_DESKTOP_ADAPTER_VERSION,
  DevinDesktopSessionAdapter,
  CandidateExtractionService,
  GENERIC_ADAPTER_VERSION,
  GenericSessionInterchangeAdapter,
  IncrementalSessionImporter,
  ImportLeaseContentionError,
  FilesystemMemoryDestination,
  FilesystemPromotionDispositionCoordinator,
  MemoryPromotionGateway,
  SESSION_CONTRACT_VERSION,
  SESSION_PROVIDER_IDS,
  SessionContractError,
  SessionRepository,
  SessionSourceSchema,
  StructuralCandidateExtractor,
  resolveMemoryConsumerManifest,
  assertSessionProviderId,
  acquireImportLease,
  defaultDiscoveryManifestPath,
  discoverWorkspaceHistories,
  deriveSessionTimeline,
  importDiscoveryManifest,
  previewDiscoveryImport,
  publicDiscoveryManifest,
  readDiscoveryManifest,
  redactSourceLocator,
  sha256,
  parseTimelineGap,
  writeDiscoveryManifest,
  buildSessionExportPlan,
  reverifySessionExportPlan,
  buildSessionAiwgFortemiIndexExport,
  recoverAiwgFortemiIndexFromFullV1Shard,
  embedAttachmentsInFullV1Shard,
  recoverEmbeddedAttachments,
  SESSION_EXPORT_PLAN_SCHEMA_VERSION,
  type SessionExportPlan,
  type SessionProviderId,
  type SessionAuthorizationContext,
  type SessionAnalyticsCategory,
  type SessionAnalyticsFact,
  type SessionAnalyticsQuery,
  type SessionAnalyticsStatus,
  type MemoryPromotionDestination,
  type SessionSourceAdapter,
  type SelectedSource,
} from '../../sessions/index.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';

const JSON_CONTRACT_VERSION = '1.0.0';

async function createLineMemoryPromotionDestination(
  projectRoot: string,
  manifestPath: string,
): Promise<MemoryPromotionDestination> {
  const modulePath = resolve(dirname(manifestPath), 'commands', 'line-memory.mjs');
  if (!existsSync(modulePath)) {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'line-memory promotion adapter is missing from the installed addon',
    );
  }
  const loaded = await import(pathToFileURL(modulePath).href) as {
    LineMemoryPromotionDestination?: new (input: {
      projectRoot: string;
      consumer: string;
    }) => MemoryPromotionDestination;
  };
  if (!loaded.LineMemoryPromotionDestination) {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'line-memory addon does not export its promotion adapter',
    );
  }
  return new loaded.LineMemoryPromotionDestination({
    projectRoot,
    consumer: 'line-memory',
  });
}

const EXIT = {
  ok: 0, usage: 2, unsupported: 3, unavailable: 4, contract: 5, storage: 6,
  locked: 7, coverage: 8,
} as const;

interface Envelope {
  contractVersion: typeof JSON_CONTRACT_VERSION;
  command: string;
  status: 'ok' | 'error' | 'preview';
  data: unknown;
  error: { code: string; message: string; details?: unknown } | null;
}

const HELP = `Usage: aiwg sessions <command> [options]

Commands:
  sources                         Show all canonical provider dispositions
  discover --workspace <path>     Inventory authorized workspace histories
  import-discovered --workspace <path>  Import the exact saved manifest
  grok-list --workspace <path>    List Grok Build CLI session IDs for a workspace
  grok-search <query> --workspace <path>  Search Grok Build CLI session IDs
  grok-export <id> --workspace <path> --out <dir>  Export one CLI transcript
  grok-id <file> --format json|streaming-json  Read a headless session ID
  import <file> --source-id <id>  Import a supported provider JSONL source
  list [--limit N] [--cursor N]   List normalized sessions
  timeline [--gap 30m]            Report chronological activity segments
  show <session-id>               Show a session with events and tags
  search <query> --workspace <id> Search authorized normalized content
  extract [session-id] --workspace <id> Extract structural candidates
  export plan --workspace <id> --out <file> <session-id...>  Select sessions into a reviewable plan
  export build --plan <file> --out <dir>  Build a Fortemi Knowledge Shard from a plan
  export verify --input <shard>   Validate a shard and its receipt
  export unpack --input <shard> --out <dir>  Recover a shard's records to disk
  candidates [--state <state>]    List the candidate review queue
  review <id> <version> <state>   Record an explicit review transition
  promote <id> <version>          Preview promotion; use --confirm to write
  tag <session-id> <tag>          Add a catalog tag
  relocate <source-id> <file>     Update AIWG source-location metadata
  reindex                         Rebuild catalog indexes
  delete <session-id>             Preview deletion; use --confirm to tombstone
  restore <session-id>            Restore a reversible catalog tombstone
  purge <session-id>              Preview terminal AIWG-copy purge
  audit --workspace <id>          Read content-free mutation events
  analytics <view> --workspace <id>  Summary, tool-calls, escalations, or HITL
  forensics <view> --workspace <id>  Authorized timeline, indicators, or evidence
  doctor                          Check catalog availability and integrity

Options:
  --json          Emit the versioned JSON contract
  --dry-run       Preview a mutation without changing state
  --db <path>     Override .aiwg/sessions/catalog.sqlite
  --manifest <path>  Override the discovery manifest path
  --provider-home <path>  Override the provider home root (testing/portable homes)
  --codex-root <path>  Explicitly authorize a shared Codex sessions/export root
  --omp-root <path>  Explicitly authorize an OMP profile sessions root
  --dsh-root <path>  Explicitly authorize a DeepSeek Harness sessions root
  --confirm, --yes  Confirm a persistent discovered batch import
  --lock-wait-ms <n>  Maximum import-lease wait (default 5000)
  --inactivity-threshold <duration>  Historical inactivity threshold (default 24h)
  --min-coverage <0..1>  Fail list/report commands below a coverage ratio
  --provider <id> Filter list or select an import adapter
  --consumer <id> Select a named memory consumer for promotion
  --workspace <id>, --tag <tag>, --limit <n>, --cursor <n>
  --page-size <n>  Extraction scan page size (default 250, maximum 500)
  --max-documents <n>  Explicit extraction safety limit; returns a partial receipt
  --include-bytes  Embed registered-output bytes in session export shards
  --max-attachment-bytes <n>  Maximum bytes per embedded output (default 67108864)
  --force         Permit replacing an existing export or recovery output

Search filters:
  --date-from <rfc3339>, --date-to <rfc3339>
  --participant <actor>, --model <id>, --role <role>, --tool <name>
  --entity <entity>, --sensitivity <class>, --extraction-state <state>
  --control-events exclude|include|only (default: exclude)
  Query syntax: FTS5 terms, quoted phrases, prefixes, AND/OR/NOT
  Follow the opaque nextCursor with the same query and filters

Analytics / forensics:
  --session <id>, --date-from <rfc3339>, --date-to <rfc3339>
  --actor <id>, --participant <id>, --tool <name>, --status <status>
  --provider <id>, --tag <tag>, --sensitivity <class>, --extraction-state <state>
  --group-by tool|session|provider, --limit <1..5000>
  --authorize-forensics  Required for each authorized forensic invocation
  --markdown      Render a sanitized forensic timeline table`;

function printHelp(ctx: HandlerContext, exitCode: number = EXIT.ok): HandlerResult {
  if (ctx.args.includes('--json')) emit(envelope('sessions.help', 'ok', { usage: HELP }, null));
  else console.log(HELP);
  return { exitCode };
}

export const sessionsHandler: CommandHandler = {
  id: 'sessions',
  name: 'Sessions',
  description: 'Manage the normalized session catalog (the singular `session` command remains the launcher)',
  category: 'project',
  aliases: [],

  async help(ctx) {
    return printHelp(ctx);
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const json = ctx.args.includes('--json');
    let parsed: ParsedArgs;
    try {
      parsed = parseArgs(ctx.args);
    } catch (error) {
      const normalized = normalizeError(error);
      const output = envelope('sessions', 'error', null, normalized.error);
      if (json) emit(output);
      else console.error(`${normalized.error.code}: ${normalized.error.message}`);
      return { exitCode: normalized.exitCode, message: normalized.error.message };
    }
    if (!parsed.command || parsed.flags.has('--help') || parsed.flags.has('-h')) {
      const explicitHelp = parsed.flags.has('--help') || parsed.flags.has('-h');
      return printHelp(ctx, explicitHelp ? EXIT.ok : EXIT.usage);
    }
    try {
      const result = await executeCommand(ctx, parsed);
      if (json) emit(result.envelope);
      else printHuman(result.envelope);
      return { exitCode: result.exitCode };
    } catch (error) {
      const normalized = normalizeError(error);
      const output = envelope(`sessions.${parsed.command}`, 'error', null, normalized.error);
      if (json) emit(output);
      else console.error(`${normalized.error.code}: ${normalized.error.message}`);
      return { exitCode: normalized.exitCode, message: normalized.error.message };
    }
  },
};

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

async function executeCommand(
  ctx: HandlerContext,
  args: ParsedArgs,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const command = args.command!;
  if (command === 'sources') {
    const reports = [...SESSION_PROVIDER_IDS].sort().map(providerDisposition);
    return ok(command, { providers: reports, count: reports.length });
  }
  if (command === 'import') return importSource(ctx, args);
  if (command === 'discover') return discoverWorkspace(ctx, args);
  if (command === 'import-discovered') return importDiscovered(ctx, args);
  if (command === 'grok-list' || command === 'grok-search' || command === 'grok-export') {
    const workspace = resolve(ctx.cwd, requiredValue(args, '--workspace'));
    const options = { cwd: workspace, binary: args.values.get('--grok-bin') };
    if (command === 'grok-list') {
      return ok(command, { sessionIds: await grokBuildList(options, boundedInteger(args.values.get('--limit'), 20, 1, 500, '--limit')) });
    }
    if (command === 'grok-search') {
      return ok(command, { sessionIds: await grokBuildSearch(options, requiredPositional(args, 0, 'query'), boundedInteger(args.values.get('--limit'), 20, 1, 500, '--limit')) });
    }
    if (isDryRun(ctx, args)) {
      return preview(command, { sessionId: requiredPositional(args, 0, 'session ID'), wouldExport: true });
    }
    const output = await grokBuildExport(options, requiredPositional(args, 0, 'session ID'), resolve(ctx.cwd, requiredValue(args, '--out')));
    return ok(command, { source: output, provider: 'grok-build', sourceId: `grok-build-${basename(output, '.md')}` });
  }
  if (command === 'grok-id') {
    const format = args.values.get('--format');
    if (format !== 'json' && format !== 'streaming-json') {
      throw new SessionContractError('INVALID_ARGUMENT', '--format must be json or streaming-json');
    }
    return ok(command, { sessionId: await grokHeadlessSessionIdFromFile(resolve(ctx.cwd, requiredPositional(args, 0, 'file')), format) });
  }

  const repository = openRepository(ctx, args);
  try {
    switch (command) {
      case 'list': {
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const limit = boundedInteger(args.values.get('--limit'), 50, 1, 500, '--limit');
        const cursor = args.values.get('--cursor');
        const providerInput = args.values.get('--provider');
        const provider = providerInput ? assertSessionProviderId(providerInput) : undefined;
        const result = repository.listSessions({
          provider,
          workspaceId,
          tag: args.values.get('--tag'),
          limit,
          cursor,
        });
        const coverage = repository.getCoverage(workspaceId);
        const response = {
          items: result.items,
          page: {
            limit,
            cursor: cursor ?? null,
            nextCursor: result.nextCursor,
            snapshotRowid: result.snapshotRowid,
            total: result.total,
          },
          coverage,
        };
        const minimum = args.values.has('--min-coverage')
          ? boundedNumber(args.values.get('--min-coverage'), 0, 0, 1, '--min-coverage')
          : null;
        if (minimum !== null
          && (coverage.coverageRatio === null || coverage.coverageRatio < minimum)) {
          return {
            envelope: envelope(
              `sessions.${command}`,
              'error',
              response,
              {
                code: 'COVERAGE_BELOW_THRESHOLD',
                message: `session coverage is below the requested threshold ${minimum}`,
                details: coverage,
              },
            ),
            exitCode: EXIT.coverage,
          };
        }
        return ok(command, response);
      }
      case 'timeline': {
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const gapMs = timelineGap(args.values.get('--gap'));
        const items = deriveSessionTimeline(repository.listTimelineInputs(workspaceId), gapMs);
        const coverage = repository.getCoverage(workspaceId);
        const response = {
          schemaVersion: '1.0.0',
          workspaceId,
          gapMs,
          items,
          count: items.length,
          coverage,
        };
        const minimum = args.values.has('--min-coverage')
          ? boundedNumber(args.values.get('--min-coverage'), 0, 0, 1, '--min-coverage')
          : null;
        if (minimum !== null
          && (coverage.coverageRatio === null || coverage.coverageRatio < minimum)) {
          return {
            envelope: envelope(
              `sessions.${command}`,
              'error',
              response,
              {
                code: 'COVERAGE_BELOW_THRESHOLD',
                message: `session coverage is below the requested threshold ${minimum}`,
                details: coverage,
              },
            ),
            exitCode: EXIT.coverage,
          };
        }
        return ok(command, response);
      }
      case 'show': {
        const id = requiredPositional(args, 0, 'session-id');
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const session = repository.getSession(id, workspaceId);
        if (!session) throw new CliError('SESSION_NOT_FOUND', `session not found: ${id}`, EXIT.unavailable);
        return ok(command, {
          session,
          tags: repository.listTags(id, workspaceId),
          events: repository.listEvents(id, workspaceId),
        });
      }
      case 'search': {
        const query = requiredPositional(args, 0, 'query');
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const providerInput = args.values.get('--provider');
        const provider = providerInput ? assertSessionProviderId(providerInput) : undefined;
        const result = repository.search({
          query,
          workspaceId,
          providers: provider ? [provider] : undefined,
          dateFrom: args.values.get('--date-from'),
          dateTo: args.values.get('--date-to'),
          participant: args.values.get('--participant'),
          model: args.values.get('--model'),
          role: args.values.get('--role'),
          tool: args.values.get('--tool'),
          tag: args.values.get('--tag'),
          entity: args.values.get('--entity'),
          sensitivity: args.values.get('--sensitivity'),
          extractionState: args.values.get('--extraction-state'),
          controlEvents: controlEventMode(args.values.get('--control-events')),
          limit: boundedInteger(args.values.get('--limit'), 50, 1, 500, '--limit'),
          cursor: args.values.get('--cursor'),
        });
        return ok(command, {
          items: result.items,
          page: { limit: boundedInteger(args.values.get('--limit'), 50, 1, 500, '--limit'),
            nextCursor: result.nextCursor },
        });
      }
      case 'analytics': {
        const view = requiredPositional(args, 0, 'analytics view');
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const query = analyticsQuery(args, workspaceId);
        if (view === 'summary') {
          return ok(command, {
            view,
            summary: repository.analyticsSummary(query),
          });
        }
        const categories = analyticsCategories(view);
        const items = repository.listAnalyticsFacts({ ...query, categories });
        return ok(command, {
          analyticsVersion: '1.0.0',
          view,
          items,
          count: items.length,
          groupBy: analyticsGrouping(items, args.values.get('--group-by')),
        });
      }
      case 'forensics': {
        if (!args.flags.has('--authorize-forensics')) {
          throw new CliError(
            'OPERATION_NOT_AUTHORIZED',
            'forensic extraction requires --authorize-forensics for this invocation',
            EXIT.usage,
          );
        }
        const view = requiredPositional(args, 0, 'forensics view');
        const { workspaceId } = authorizationContext(ctx, args, command);
        const query = analyticsQuery(args, workspaceId);
        if (view === 'indicators') {
          const items = repository.listAnalyticsFacts({
            ...query,
            categories: ['indicator'],
          });
          return ok(command, forensicOutput(view, items, args));
        }
        if (view === 'timeline') {
          const target = requiredPositional(args, 1, 'session-id or query');
          const direct = repository.getSession(target, workspaceId);
          const sessionIds = direct
            ? [target]
            : [...new Set(repository.search({
                query: target,
                workspaceId,
                limit: boundedInteger(args.values.get('--limit'), 50, 1, 500, '--limit'),
              }).items.map((item) => item.sessionId))];
          const items = sessionIds.flatMap((sessionId) =>
            repository.listAnalyticsFacts({ ...query, sessionId }));
          return ok(command, forensicOutput(view, items, args));
        }
        if (view === 'evidence') {
          const id = requiredPositional(args, 1, 'event-id, fact-id, or candidate-id');
          const evidence = repository.getAnalyticsEvidence(id, workspaceId);
          if (evidence.fact && evidence.event) {
            return ok(command, {
              analyticsVersion: '1.0.0',
              view,
              fact: evidence.fact,
              event: {
                eventId: evidence.event.eventId,
                sessionId: evidence.event.sessionId,
                sourceId: evidence.event.sourceId,
                importRunId: evidence.event.importRunId,
                sequence: evidence.event.sequence,
                kind: evidence.event.kind,
                occurredAt: evidence.event.occurredAt,
                sensitivity: evidence.event.sensitivity,
                rawReference: evidence.event.rawReference,
                digest: evidence.event.digest,
              },
            });
          }
          const candidate = repository.getCandidate(id, undefined, workspaceId);
          if (!candidate) {
            throw new CliError(
              'EVIDENCE_NOT_FOUND',
              `authorized analytics evidence not found: ${id}`,
              EXIT.unavailable,
            );
          }
          return ok(command, {
            analyticsVersion: '1.0.0',
            view,
            candidate: {
              candidateId: candidate.candidateId,
              version: candidate.version,
              type: candidate.type,
              evidence: candidate.evidence.map(({ quote: _quote, ...citation }) => citation),
              sensitivity: candidate.sensitivity,
              security: candidate.security,
              reviewState: candidate.reviewState,
            },
          });
        }
        throw new CliError(
          'INVALID_ARGUMENT',
          `unknown forensics view: ${view}`,
          EXIT.usage,
        );
      }
      case 'extract': {
        const { workspaceId } = authorizationContext(ctx, args, command);
        const sessionId = args.positionals[0];
        const pageSize = boundedInteger(args.values.get('--page-size'), 250, 1, 500, '--page-size');
        const maxDocuments = args.values.has('--max-documents')
          ? boundedInteger(args.values.get('--max-documents'), pageSize, 1, 1_000_000, '--max-documents')
          : null;
        const documents = [];
        let cursor: string | undefined;
        let truncated = false;
        do {
          const remaining = maxDocuments === null
            ? pageSize
            : Math.min(pageSize, maxDocuments - documents.length);
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          const page = repository.authorizedSearchDocumentPage({
            workspaceId,
            sessionIds: sessionId ? [sessionId] : undefined,
            limit: remaining,
            cursor,
          });
          documents.push(...page.items);
          cursor = page.nextCursor ?? undefined;
          if (maxDocuments !== null && documents.length >= maxDocuments && cursor) {
            truncated = true;
            break;
          }
        } while (cursor);
        if (sessionId && documents.length === 0) {
          throw new CliError(
            'SESSION_NOT_FOUND',
            `no authorized evidence found for session: ${sessionId}`,
            EXIT.unavailable,
          );
        }
        const dryRun = isDryRun(ctx, args);
        const service = new CandidateExtractionService(dryRun
          ? { saveCandidates: (candidates) => [...candidates] }
          : repository);
        const items = await service.extract({
          documents,
          extractor: new StructuralCandidateExtractor(),
          policy: {
            version: args.values.get('--policy-version') ?? '1.0.0',
            projectScope: workspaceId,
            temporalScope: 'source-event',
            minimumConfidence: boundedNumber(
              args.values.get('--min-confidence'),
              0.5,
              0,
              1,
              '--min-confidence',
            ),
          },
        });
        const scan = {
          complete: !truncated,
          documentsScanned: documents.length,
          pageSize,
          nextCursor: truncated ? cursor ?? null : null,
          limit: maxDocuments,
        };
        return dryRun
          ? preview(command, { items, count: items.length, durableMemoryWrites: 0, scan })
          : ok(command, { items, count: items.length, durableMemoryWrites: 0, scan });
      }
      case 'export': return exportCommand(ctx, args, repository);
      case 'candidates': {
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const state = candidateState(args.values.get('--state'));
        return ok(command, {
          items: repository.listCandidates(state, workspaceId),
        });
      }
      case 'review': {
        const { workspaceId } = authorizationContext(ctx, args, command);
        const candidateId = requiredPositional(args, 0, 'candidate-id');
        const version = boundedInteger(
          requiredPositional(args, 1, 'version'),
          1,
          1,
          Number.MAX_SAFE_INTEGER,
          'version',
        );
        const toState = candidateState(requiredPositional(args, 2, 'state'));
        if (!toState) throw new CliError('INVALID_ARGUMENT', 'review state is required', EXIT.usage);
        if (isDryRun(ctx, args)) {
          return preview(command, {
            candidateId, version, toState,
            reviewer: requiredValue(args, '--reviewer'),
            reason: requiredValue(args, '--reason'),
            securityAcknowledged: args.flags.has('--acknowledge-security-risk'),
          });
        }
        return ok(command, repository.reviewCandidate({
          candidateId,
          version,
          toState,
          reviewer: requiredValue(args, '--reviewer'),
          reason: requiredValue(args, '--reason'),
          securityAcknowledged: args.flags.has('--acknowledge-security-risk'),
          workspaceId,
        }));
      }
      case 'promote': {
        const { workspaceId } = authorizationContext(ctx, args, command);
        const candidateId = requiredPositional(args, 0, 'candidate-id');
        const version = boundedInteger(
          requiredPositional(args, 1, 'version'),
          1,
          1,
          Number.MAX_SAFE_INTEGER,
          'version',
        );
        const consumer = requiredValue(args, '--consumer');
        const manifestPath = resolveMemoryConsumerManifest(ctx.cwd, consumer);
        const destination = consumer === 'line-memory'
          ? await createLineMemoryPromotionDestination(ctx.cwd, manifestPath)
          : new FilesystemMemoryDestination({
              projectRoot: ctx.cwd,
              consumer,
              manifestPath,
            });
        const scopedPromotionStore = {
          getCandidate: (id: string, candidateVersion?: number) =>
            repository.getCandidate(id, candidateVersion, workspaceId),
          getPromotionReceipt: (id: string, candidateVersion: number, namedConsumer: string) =>
            repository.getCandidate(id, candidateVersion, workspaceId)
              ? repository.getPromotionReceipt(id, candidateVersion, namedConsumer)
              : null,
          recordPromotion: (receipt: Parameters<typeof repository.recordPromotion>[0]) => {
            if (!repository.getCandidate(receipt.candidateId, receipt.candidateVersion, workspaceId)) {
              throw new SessionContractError(
                'OPERATION_NOT_AUTHORIZED',
                'candidate version is not available in the authorized workspace',
              );
            }
            return repository.recordPromotion(receipt);
          },
        };
        const gateway = new MemoryPromotionGateway(scopedPromotionStore);
        const promotionPreview = gateway.preview({ candidateId, version, destination });
        if (!args.flags.has('--confirm') || isDryRun(ctx, args)) {
          return preview(command, promotionPreview);
        }
        const receipt = await gateway.promote({
          candidateId,
          version,
          destination,
          reviewer: requiredValue(args, '--reviewer'),
          operationId: promotionPreview.operationId,
        });
        return ok(command, { preview: promotionPreview, receipt });
      }
      case 'tag': {
        const id = requiredPositional(args, 0, 'session-id');
        const { workspaceId } = authorizationContext(ctx, args, command);
        const tag = requiredPositional(args, 1, 'tag');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(tag)) {
          throw new CliError('INVALID_TAG', 'tag must be 1-64 safe identifier characters', EXIT.usage);
        }
        if (isDryRun(ctx, args)) return preview(command, { sessionId: id, tag, wouldAdd: true });
        if (!repository.tagSession(id, tag, workspaceId)) {
          if (!repository.getSession(id, workspaceId)) {
            throw new CliError('SESSION_NOT_FOUND', `session not found: ${id}`, EXIT.unavailable);
          }
        }
        return ok(command, { sessionId: id, tag, tags: repository.listTags(id, workspaceId) });
      }
      case 'relocate': {
        const sourceId = requiredPositional(args, 0, 'source-id');
        const { workspaceId } = authorizationContext(ctx, args, command);
        const locator = requiredPositional(args, 1, 'file');
        if (!repository.getSource(sourceId, workspaceId)) {
          throw new CliError('SOURCE_NOT_FOUND', `source not found: ${sourceId}`, EXIT.unavailable);
        }
        const redactedLocator = redactSourceLocator(locator);
        if (isDryRun(ctx, args)) return preview(command, { sourceId, redactedLocator });
        repository.relocateSource(sourceId, redactedLocator, workspaceId);
        return ok(command, { sourceId, redactedLocator });
      }
      case 'reindex': {
        const { workspaceId } = authorizationContext(ctx, args, command);
        if (isDryRun(ctx, args)) return preview(command, { operation: 'reindex' });
        repository.reindex(workspaceId);
        return ok(command, { operation: 'reindex' });
      }
      case 'audit': {
        const { workspaceId } = readAuthorizationContext(ctx, args, command, repository);
        const limit = boundedInteger(args.values.get('--limit'), 100, 1, 500, '--limit');
        const cursor = args.values.get('--cursor');
        if (args.flags.has('--otel')) {
          return ok(command, repository.exportMutationEventsOtel({
            workspaceId,
            limit,
            cursor,
          }));
        }
        const page = repository.listMutationEvents({ workspaceId, limit, cursor });
        return ok(command, {
          items: page.items,
          page: { limit, nextCursor: page.nextCursor },
        });
      }
      case 'delete': {
        const id = requiredPositional(args, 0, 'session-id');
        const { workspaceId } = authorizationContext(ctx, args, command);
        const counts = repository.deletionPreview(id, workspaceId);
        if (counts.sessions === 0) {
          throw new CliError('SESSION_NOT_FOUND', `session not found: ${id}`, EXIT.unavailable);
        }
        if (!args.flags.has('--confirm') || isDryRun(ctx, args)) {
          return preview(command, {
            sessionId: id, counts, providerLogsModified: false,
            confirmationRequired: true,
          });
        }
        repository.tombstoneSession(id, workspaceId);
        return ok(command, {
          sessionId: id, counts, providerLogsModified: false, outcome: 'tombstoned',
        });
      }
      case 'restore': {
        const id = requiredPositional(args, 0, 'session-id');
        const { workspaceId } = authorizationContext(ctx, args, command);
        if (isDryRun(ctx, args)) return preview(command, { sessionId: id, wouldRestore: true });
        if (!repository.restoreSession(id, workspaceId)) {
          throw new CliError('SESSION_NOT_FOUND', `tombstoned session not found: ${id}`, EXIT.unavailable);
        }
        return ok(command, { sessionId: id, outcome: 'restored', providerLogsModified: false });
      }
      case 'purge': {
        const id = requiredPositional(args, 0, 'session-id');
        const { workspaceId } = authorizationContext(ctx, args, command);
        const completed = repository.getCompletedPurge(id, workspaceId);
        if (completed) {
          return ok(command, {
            receipt: completed,
            dependentDecisions: repository.listPromotionDependencyDecisions(completed.operationId),
            duplicate: true,
            providerLogsModified: false,
          });
        }
        const purgePreview = repository.previewPurge(id, workspaceId);
        const requestedAction = args.values.get('--dependent-action');
        const action = purgePreview.promotedDependents.length > 0 && requestedAction
          ? dependentAction(requestedAction)
          : 'origin_unavailable';
        const basis = purgePreview.promotedDependents.length > 0
          ? (args.values.get('--basis') ?? 'not-yet-confirmed')
          : (args.values.get('--basis') ?? 'no-promoted-dependents');
        const decisions = purgePreview.promotedDependents.map((item) => ({
          dependentId: item.dependentId,
          action,
          basis,
        }));
        const dispositionCoordinator = new FilesystemPromotionDispositionCoordinator({
          projectRoot: ctx.cwd,
          allowedRoots: ['.aiwg'],
        });
        if (!args.flags.has('--confirm') || isDryRun(ctx, args)) {
          return preview(command, {
            ...purgePreview,
            artifactEffects: requestedAction
              ? dispositionCoordinator.preview(purgePreview, decisions)
              : purgePreview.promotedDependents.map((item) => ({
                  dependentId: item.dependentId,
                  destinationRef: item.destinationRef,
                  allowedActions: [
                    'origin_unavailable', 'retain', 'revoke',
                    'supersede', 'delete', 'abort',
                  ],
                  confirmationRequired: true,
                })),
            providerLogsModified: false,
          });
        }
        if (purgePreview.promotedDependents.length > 0) {
          dependentAction(requiredValue(args, '--dependent-action'));
          requiredValue(args, '--basis');
        }
        const disposition = dispositionCoordinator.apply(purgePreview, decisions);
        const receipt = repository.purgeSession({
          preview: purgePreview,
          actorClass: requiredValue(args, '--actor-class'),
          reasonCode: requiredValue(args, '--reason-code'),
          decisions,
        });
        dispositionCoordinator.catalogCommitted(receipt.operationId);
        return ok(command, {
          receipt,
          artifactDisposition: disposition,
          dependentDecisions: repository.listPromotionDependencyDecisions(receipt.operationId),
          providerLogsModified: false,
        });
      }
      case 'doctor':
        return ok(command, {
          database: redactSourceLocator(databasePath(ctx, args)),
          health: repository.doctor(),
          jsonContractVersion: JSON_CONTRACT_VERSION,
        });
      default:
        throw new CliError('UNKNOWN_COMMAND', `unknown sessions command: ${command}`, EXIT.usage);
    }
  } finally {
    repository.close();
  }
}

async function importSource(
  ctx: HandlerContext,
  args: ParsedArgs,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const input = resolve(ctx.cwd, requiredPositional(args, 0, 'file'));
  const providerInput = args.values.get('--provider') ?? 'generic';
  const provider = assertSessionProviderId(providerInput);
  if (provider !== 'generic' && provider !== 'claude' && provider !== 'codex'
    && provider !== 'copilot' && provider !== 'cursor' && provider !== 'factory'
    && provider !== 'hermes' && provider !== 'opencode' && provider !== 'openclaw'
    && provider !== 'openhuman' && provider !== 'grokbot' && provider !== 'grok-build' && provider !== 'muse' && provider !== 'pi' && provider !== 'omp' && provider !== 'deepseek-harness' && provider !== 'warp' && provider !== 'devin-desktop') {
    throw new CliError('UNSUPPORTED_OPERATION', `session import is not implemented for ${provider}`, EXIT.unsupported);
  }
  const sourceId = requiredValue(args, '--source-id');
  const workspaceId = args.values.has('--workspace')
    ? normalizeWorkspaceId(ctx.cwd, args.values.get('--workspace')!)
    : 'default';
  const isClaude = provider === 'claude';
  const isCodex = provider === 'codex';
  const isCopilot = provider === 'copilot';
  const isCursor = provider === 'cursor';
  const isFactory = provider === 'factory';
  const isHermes = provider === 'hermes';
  const isOpenCode = provider === 'opencode';
  const isOpenClaw = provider === 'openclaw';
  const isOpenHuman = provider === 'openhuman';
  const isGrokbot = provider === 'grokbot';
  const isGrokBuild = provider === 'grok-build';
  const isMuse = provider === 'muse';
  const isPi = provider === 'pi';
  const isOmp = provider === 'omp';
  const isDsh = provider === 'deepseek-harness';
  const isWarp = provider === 'warp';
  const isDevinDesktop = provider === 'devin-desktop';
  const adapter: SessionSourceAdapter = isDsh ? new DeepSeekHarnessSessionAdapter() : isOmp ? new OmpSessionAdapter() : isClaude
    ? new ClaudeSessionAdapter()
    : isCodex
      ? new CodexSessionAdapter()
      : isCopilot
        ? new CopilotSessionAdapter()
        : isCursor
          ? new CursorSessionAdapter()
          : isFactory
            ? new FactorySessionAdapter()
            : isHermes
              ? new HermesSessionAdapter()
              : isOpenCode
                ? new OpenCodeSessionAdapter()
                : isOpenClaw
                  ? new OpenClawSessionAdapter()
                  : isOpenHuman
                    ? new OpenHumanSessionAdapter()
                    : isGrokbot
                      ? new GrokbotSessionAdapter()
                      : isGrokBuild
                        ? new GrokBuildSessionAdapter()
                      : isMuse
                        ? new MuseSessionAdapter()
                      : isPi
                        ? new PiSessionAdapter()
                    : isWarp
                      ? new WarpSessionAdapter()
                      : isDevinDesktop
                        ? new DevinDesktopSessionAdapter()
                        : new GenericSessionInterchangeAdapter();
  const locatorClass = isDsh ? 'deepseek-harness-session-v2-jsonl' : isOmp ? 'omp-session-v3-jsonl' : isClaude
    ? claudeLocatorClass(input)
    : isCodex
      ? (input.endsWith('.app-server.jsonl') ? 'codex-app-server-jsonl' : 'codex-rollout-jsonl')
      : isCopilot
        ? 'copilot-chat-json-export'
        : isCursor
          ? cursorLocatorClass(input)
          : isFactory
            ? 'factory-droid-jsonl'
            : isHermes
              ? 'hermes-export-jsonl'
              : isOpenCode
                ? 'opencode-export-json'
                : isOpenClaw
                  ? 'openclaw-consistent-snapshot-jsonl'
                  : isOpenHuman
                    ? 'openhuman-enriched-jsonl'
                  : isGrokbot
                    ? 'manual-export'
                    : isGrokBuild
                      ? GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS
                    : isMuse
                      ? 'manual-export'
                    : isPi
                        ? 'pi-session-v3-jsonl'
                    : isWarp
                      ? 'warp-markdown-export'
                      : isDevinDesktop
                        ? 'devin-desktop-cascade-hook-jsonl'
                        : 'manual-export';
  const selectedSource: SelectedSource = {
    provider, locator: input, locatorClass, sourceId,
    authorizedScope: { workspaceId, allowedRoots: [dirname(input)] },
  };
  const probe = await adapter.inspect(selectedSource);
  const source = SessionSourceSchema.parse({
    contractVersion: SESSION_CONTRACT_VERSION, sourceId, provider,
    providerProfile: isDsh ? 'native-session-v2-jsonl' : isOmp ? 'native-title-slot-v3' : isClaude
      ? claudeProviderProfile(locatorClass)
      : isCodex
        ? 'app-server-v2-rollout-fallback'
        : isCopilot
          ? 'vscode-chat-json-export'
          : isCursor
            ? cursorProviderProfile(locatorClass)
            : isFactory
              ? 'documented-project-jsonl'
              : isHermes
                ? 'native-schema-23-export'
                : isOpenCode
                  ? 'sanitized-json-export'
                  : isOpenClaw
                    ? 'schema-16-event-v3-consistent-snapshot'
                    : isOpenHuman
                      ? 'schema-1-session-raw-enriched'
                      : isGrokbot
                        ? 'manual-interchange'
                        : isGrokBuild
                          ? 'documented-cli-markdown-export'
                        : isMuse
                          ? 'muse-export-trajectory-v1'
                        : isWarp
                          ? 'manual-lossy-markdown-export'
                        : isDevinDesktop
                          ? 'opt-in-cascade-transcript-hook'
                          : 'manual-interchange',
    locatorClass, redactedLocator: redactSourceLocator(input),
    adapterVersion: isDsh ? DEEPSEEK_HARNESS_ADAPTER_VERSION : isOmp ? OMP_ADAPTER_VERSION : isClaude
      ? CLAUDE_ADAPTER_VERSION
      : isCodex
        ? CODEX_ADAPTER_VERSION
        : isCopilot
          ? COPILOT_ADAPTER_VERSION
          : isCursor
            ? CURSOR_ADAPTER_VERSION
            : isFactory
              ? FACTORY_ADAPTER_VERSION
              : isHermes
                ? HERMES_ADAPTER_VERSION
                : isOpenCode
                  ? OPENCODE_ADAPTER_VERSION
                  : isOpenClaw
                    ? OPENCLAW_ADAPTER_VERSION
                    : isOpenHuman
                      ? OPENHUMAN_ADAPTER_VERSION
                      : isGrokbot
                        ? GROKBOT_ADAPTER_VERSION
                        : isGrokBuild
                          ? GROK_BUILD_ADAPTER_VERSION
                        : isMuse
                          ? MUSE_ADAPTER_VERSION
                        : isWarp
                          ? WARP_ADAPTER_VERSION
                        : isDevinDesktop
                          ? DEVIN_DESKTOP_ADAPTER_VERSION
                          : GENERIC_ADAPTER_VERSION,
    sourceSchemaVersion: probe.sourceSchemaVersion,
    disposition: isWarp || isGrokbot || isMuse
      ? 'manual-only'
      : isClaude || isCodex || isCopilot || isCursor || isFactory || isHermes
        || isOpenCode || isOpenClaw || isOpenHuman || isGrokBuild || isDevinDesktop || isOmp || isDsh || isPi
        ? 'implemented' : 'manual-only',
    operationalState: probe.operationalState,
    consistency: probe.consistency, authorizedAt: new Date().toISOString(),
    extensions: isDsh ? { 'native.deepseek-harness': {} } : isOmp ? { 'native.omp': {} } : isClaude
      ? { 'native.claude': {} }
      : isCodex
        ? { 'native.codex': {} }
        : isCopilot
          ? { 'native.copilot': {} }
          : isCursor
            ? { 'native.cursor': {} }
            : isFactory
              ? { 'native.factory': {} }
              : isHermes
                ? { 'native.hermes': {} }
                : isOpenCode
                  ? { 'native.opencode': {} }
                  : isOpenClaw
                    ? { 'native.openclaw': {} }
                    : isOpenHuman
                      ? { 'native.openhuman': {} }
                      : isGrokbot
                        ? { 'native.grokbot': {} }
                        : isGrokBuild
                          ? { 'native.grok-build': { acquisition: 'grok-cli-export-markdown' } }
                        : isMuse
                          ? { 'native.muse': {} }
                        : isWarp
                          ? { 'native.warp': {} }
                        : isDevinDesktop
                          ? { 'native.devin-desktop': {
                              product: 'Devin Desktop',
                              compatibilityProviderId: 'windsurf',
                            } }
                          : { 'native.generic': {} },
  });
  if (isDryRun(ctx, args)) {
    return preview('import', { source, wouldInspect: true, wouldPersist: false });
  }
  const lease = await acquireImportLease(
    databasePath(ctx, args),
    sha256(['single-source-import', sourceId, workspaceId].join('\0')),
    {
      waitMs: boundedInteger(
        args.values.get('--lock-wait-ms'),
        5_000,
        0,
        300_000,
        '--lock-wait-ms',
      ),
    },
  );
  try {
    const repository = openRepository(ctx, args);
    try {
      const receipts = await new IncrementalSessionImporter(repository).import({
        source, selectedSource, adapter, workspaceId, policyVersion: '1.0.0',
        inactivityThresholdMs: inactivityThreshold(args.values.get('--inactivity-threshold')),
      });
      return ok('import', {
        sourceId,
        receipts,
        totals: {
          sessionsInserted: receipts.reduce((sum, item) => sum + item.sessionsInserted, 0),
          eventsInserted: receipts.reduce((sum, item) => sum + item.eventsInserted, 0),
        },
      });
    } finally {
      repository.close();
    }
  } finally {
    await lease.release();
  }
}

/**
 * `aiwg sessions export {plan,build,verify,unpack}` (#2564). Sub-verb after
 * `export`, matching the issue's proposed shape:
 *   export plan --workspace ID --out selection.json SESSION_ID...
 *   export build --plan selection.json --out DIRECTORY
 *   export verify --input evidence.shard
 *   export unpack --input evidence.shard --out DIRECTORY
 */
async function exportCommand(
  ctx: HandlerContext,
  args: ParsedArgs,
  repository: SessionRepository,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const subVerb = requiredPositional(args, 0, 'export sub-command (plan|build|verify|unpack)');
  const command = `export.${subVerb}`;
  if (subVerb === 'plan') return exportPlan(ctx, args, repository, command);
  if (subVerb === 'build') return exportBuild(ctx, args, repository, command);
  if (subVerb === 'verify') return exportVerify(ctx, args, command);
  if (subVerb === 'unpack') return exportUnpack(ctx, args, command);
  throw new CliError('UNKNOWN_COMMAND', `unknown export sub-command: ${subVerb}`, EXIT.usage);
}

function exportPlan(
  ctx: HandlerContext,
  args: ParsedArgs,
  repository: SessionRepository,
  command: string,
): { envelope: Envelope; exitCode: number } {
  const workspaceId = normalizeWorkspaceId(ctx.cwd, requiredValue(args, '--workspace'));
  const out = resolve(ctx.cwd, requiredValue(args, '--out'));
  const flagSelection = args.values.get('--session')?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const sessionIds = [...new Set([...flagSelection, ...args.positionals.slice(1)])];
  const { plan } = buildSessionExportPlan(repository, { workspaceId, sessionIds, projectRoot: ctx.cwd });
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return ok(command, {
    plan: out,
    totals: plan.totals,
    sessions: plan.sessions.map((entry) => entry.sessionId),
    outputs: plan.outputs.length,
  });
}

async function exportBuild(
  ctx: HandlerContext,
  args: ParsedArgs,
  repository: SessionRepository,
  command: string,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const planPath = resolve(ctx.cwd, requiredValue(args, '--plan'));
  const outDirectory = resolve(ctx.cwd, requiredValue(args, '--out'));
  const shardName = args.values.get('--shard-name') ?? 'evidence.shard';
  if (basename(shardName) !== shardName) {
    throw new CliError('INVALID_ARGUMENT', '--shard-name must be a filename, not a path', EXIT.usage);
  }
  const finalPath = join(outDirectory, shardName);
  const receiptPath = `${finalPath}.receipt.json`;
  if (!args.flags.has('--force') && (existsSync(finalPath) || existsSync(receiptPath))) {
    throw new CliError(
      'OUTPUT_EXISTS',
      `refusing to overwrite an existing shard or receipt: ${finalPath} (use --force to replace)`,
      EXIT.usage,
    );
  }
  let plan: SessionExportPlan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8')) as SessionExportPlan;
  } catch {
    throw new CliError('MALFORMED_SOURCE', `plan file is not readable JSON: ${planPath}`, EXIT.usage);
  }
  if (plan.schemaVersion !== SESSION_EXPORT_PLAN_SCHEMA_VERSION) {
    throw new CliError(
      'UNKNOWN_SCHEMA_MAJOR',
      `plan schemaVersion ${plan.schemaVersion} is not supported by this build (expected ${SESSION_EXPORT_PLAN_SCHEMA_VERSION})`,
      EXIT.contract,
    );
  }
  // Recheck source changes before writing (#2564 acceptance criteria):
  // re-select from the live repository and reject on any digest drift.
  const {
    sessions, eventsBySessionId, catalogTagsBySessionId, outputBytesByRegistrationId, attachmentBytesByEventId,
  } = reverifySessionExportPlan(repository, plan, { projectRoot: ctx.cwd });
  const includeBytes = args.flags.has('--include-bytes');
  const outputs = plan.outputs.map((output) => ({
    ...output,
    bytesEmbedded: includeBytes && outputBytesByRegistrationId.has(output.registrationId),
  }));
  const index = buildSessionAiwgFortemiIndexExport(
    plan.workspaceId, sessions, eventsBySessionId, outputs, catalogTagsBySessionId,
  );
  // aiwgFortemiIndexToKnowledgeShardWithReport targets the declared
  // full-v1/2.0.0 archive contract and validates losslessness -- unlike the
  // plain aiwgFortemiIndexToKnowledgeShard (core-v1), which silently embeds
  // the whole input record as opaque note metadata regardless of whether it
  // maps to any native component. The mapping in fortemi-export-mapping.ts
  // was built specifically so every AIWG-specific field lands in a real
  // full-v1 component (tags, provenance_events) rather than being smuggled
  // through as an unmapped blob.
  const { aiwgFortemiIndexToKnowledgeShardWithReport } = await import('@fortemi/core');
  const result = await aiwgFortemiIndexToKnowledgeShardWithReport(index);
  if (!result.success || !result.archive) {
    throw new CliError(
      'MALFORMED_SOURCE',
      `full-v1 shard conversion failed: ${JSON.stringify(result.losses)}`,
      EXIT.contract,
    );
  }
  let bytes = result.archive;
  let embeddedAttachmentCount = 0;
  let embeddedAttachmentBytes = 0;
  if (includeBytes) {
    const maximum = Number(args.values.get('--max-attachment-bytes') ?? 64 * 1024 * 1024);
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new CliError('INVALID_ARGUMENT', '--max-attachment-bytes must be a positive integer', EXIT.usage);
    }
    const attachments = plan.outputs.map((output) => {
      const content = outputBytesByRegistrationId.get(output.registrationId)!;
      if (content.length > maximum) {
        throw new CliError(
          'SOURCE_TOO_LARGE',
          `registered output exceeds --max-attachment-bytes: ${output.outputLocator}`,
          EXIT.contract,
        );
      }
      return {
        recordId: `output_${output.registrationId}`,
        attachmentId: randomUUID(),
        filename: basename(output.outputLocator),
        mimeType: output.mediaType,
        bytes: content,
      };
    });
    for (const attachment of plan.attachments ?? []) {
      const content = attachmentBytesByEventId.get(attachment.eventId)!;
      if (content.length > maximum) {
        throw new CliError(
          'SOURCE_TOO_LARGE',
          `session attachment exceeds --max-attachment-bytes: ${attachment.filename}`,
          EXIT.contract,
        );
      }
      attachments.push({
        recordId: attachment.eventId,
        attachmentId: randomUUID(),
        filename: basename(attachment.filename),
        mimeType: attachment.mediaType,
        bytes: content,
      });
    }
    embeddedAttachmentCount = attachments.length;
    embeddedAttachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);
    bytes = await embedAttachmentsInFullV1Shard(bytes, attachments);
  }
  mkdirSync(outDirectory, { recursive: true, mode: 0o700 });
  // Interrupted writes must never be mistaken for a completed export: write
  // to a sibling temp file, then rename (atomic on the same filesystem), and
  // only then write the receipt -- the receipt's existence is the completion
  // signal, not the shard file's.
  const tempPath = join(outDirectory, `.${shardName}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, bytes, { mode: 0o600 });
  if (args.flags.has('--force')) renameSync(tempPath, finalPath);
  else {
    try {
      linkSync(tempPath, finalPath);
      unlinkSync(tempPath);
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw new CliError('OUTPUT_EXISTS', `refusing to overwrite an existing shard: ${finalPath}`, EXIT.usage, error);
    }
  }
  const readBack = readFileSync(finalPath);
  const shardDigest = sha256(readBack);
  if (readBack.length !== bytes.length) {
    throw new CliError('IMPORT_INTERRUPTED', 'shard readback size did not match the written archive', EXIT.storage);
  }
  const receipt = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    workspaceId: plan.workspaceId,
    planGeneratedAt: plan.generatedAt,
    sessionIds: plan.sessions.map((entry) => entry.sessionId),
    totals: plan.totals,
    indexSchemaVersion: index.schema_version,
    archiveProfile: result.profile,
    archiveSchemaVersion: result.schema_version,
    lossless: result.lossless,
    losses: result.losses,
    fortemiReceipt: result.receipt,
    shardFile: shardName,
    shardDigest,
    shardBytes: readBack.length,
    embeddedAttachmentCount,
    embeddedAttachmentBytes,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: args.flags.has('--force') ? 'w' : 'wx',
  });
  return ok(command, { shard: finalPath, receipt: receiptPath, ...receipt });
}

async function exportVerify(
  ctx: HandlerContext,
  args: ParsedArgs,
  command: string,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const input = resolve(ctx.cwd, requiredValue(args, '--input'));
  let bytes: Buffer;
  try {
    bytes = readFileSync(input);
  } catch {
    throw new CliError('SOURCE_NOT_AUTHORIZED', `shard file is not readable: ${input}`, EXIT.usage);
  }
  let recovered;
  let embeddedAttachments;
  try {
    recovered = recoverAiwgFortemiIndexFromFullV1Shard(bytes);
    embeddedAttachments = recoverEmbeddedAttachments(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError('MALFORMED_SOURCE', `shard failed validation: ${message}`, EXIT.contract);
  }
  const shardDigest = sha256(bytes);
  const receiptPath = `${input}.receipt.json`;
  let receiptMatches: boolean | null = null;
  if (existsSync(receiptPath)) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { shardDigest?: string; shardBytes?: number };
      receiptMatches = receipt.shardDigest === shardDigest && receipt.shardBytes === bytes.length;
    } catch {
      receiptMatches = false;
    }
  }
  return ok(command, {
    valid: true,
    schemaVersion: recovered.schema_version,
    itemCount: recovered.items.length,
    shardDigest,
    shardBytes: bytes.length,
    receiptChecked: existsSync(receiptPath),
    receiptMatches,
    embeddedAttachmentCount: embeddedAttachments.length,
  });
}

async function exportUnpack(
  ctx: HandlerContext,
  args: ParsedArgs,
  command: string,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const input = resolve(ctx.cwd, requiredValue(args, '--input'));
  const outDirectory = resolve(ctx.cwd, requiredValue(args, '--out'));
  let bytes: Buffer;
  try {
    bytes = readFileSync(input);
  } catch {
    throw new CliError('SOURCE_NOT_AUTHORIZED', `shard file is not readable: ${input}`, EXIT.usage);
  }
  let recovered;
  try {
    recovered = recoverAiwgFortemiIndexFromFullV1Shard(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError('MALFORMED_SOURCE', `shard failed validation: ${message}`, EXIT.contract);
  }
  const attachments = recoverEmbeddedAttachments(bytes);
  mkdirSync(outDirectory, { recursive: true, mode: 0o700 });
  const finalPath = join(outDirectory, 'index.json');
  if (!args.flags.has('--force') && existsSync(finalPath)) {
    throw new CliError('OUTPUT_EXISTS', `refusing to overwrite recovered output: ${finalPath}`, EXIT.usage);
  }
  const attachmentPaths = attachments.map((attachment) => join(
    outDirectory, 'attachments', attachment.recordId, basename(attachment.filename),
  ));
  if (!args.flags.has('--force')) {
    const conflict = attachmentPaths.find((attachmentPath) => existsSync(attachmentPath));
    if (conflict) throw new CliError('OUTPUT_EXISTS', `refusing to overwrite recovered attachment: ${conflict}`, EXIT.usage);
  }
  const tempPath = join(outDirectory, `.index.json.${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(recovered, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, finalPath);
  for (const [index, attachment] of attachments.entries()) {
    const attachmentDirectory = join(outDirectory, 'attachments', attachment.recordId);
    mkdirSync(attachmentDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(attachmentPaths[index], attachment.bytes, { mode: 0o600 });
  }
  return ok(command, {
    index: finalPath,
    schemaVersion: recovered.schema_version,
    itemCount: recovered.items.length,
    sessionRecordCount: recovered.items.filter((item) => item.type === 'aiwg.session').length,
    eventRecordCount: recovered.items.filter((item) => item.type === 'aiwg.session-event').length,
    recoveredAttachmentCount: attachments.length,
    recoveredAttachmentBytes: attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0),
  });
}

async function discoverWorkspace(
  ctx: HandlerContext,
  args: ParsedArgs,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const workspace = resolve(ctx.cwd, requiredValue(args, '--workspace'));
  const manifest = await discoverWorkspaceHistories({
    workspace,
    providerHome: args.values.has('--provider-home')
      ? resolve(ctx.cwd, args.values.get('--provider-home')!)
      : undefined,
    ompRoot: args.values.has('--omp-root')
      ? resolve(ctx.cwd, args.values.get('--omp-root')!) : undefined,
    dshRoot: args.values.has('--dsh-root')
      ? resolve(ctx.cwd, args.values.get('--dsh-root')!) : undefined,
    codexRoot: args.values.has('--codex-root')
      ? resolve(ctx.cwd, args.values.get('--codex-root')!)
      : undefined,
  });
  const manifestPath = resolve(
    ctx.cwd,
    args.values.get('--manifest') ?? defaultDiscoveryManifestPath(manifest.workspacePath),
  );
  const data = {
    manifest: publicDiscoveryManifest(manifest),
    manifestPath: redactSourceLocator(manifestPath),
    exactManifestRequiredForImport: true,
  };
  if (isDryRun(ctx, args)) {
    return preview('discover', { ...data, wouldPersistManifest: false });
  }
  await writeDiscoveryManifest(manifestPath, manifest);
  return ok('discover', { ...data, manifestPersisted: true });
}

async function importDiscovered(
  ctx: HandlerContext,
  args: ParsedArgs,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const workspace = resolve(ctx.cwd, requiredValue(args, '--workspace'));
  const canonicalWorkspace = realpathSync(workspace);
  const manifestPath = resolve(
    ctx.cwd,
    args.values.get('--manifest') ?? defaultDiscoveryManifestPath(canonicalWorkspace),
  );
  const manifest = await readDiscoveryManifest(manifestPath);
  if (manifest.workspaceId !== canonicalWorkspace) {
    throw new CliError(
      'MANIFEST_WORKSPACE_MISMATCH',
      'discovery manifest does not belong to the explicitly authorized workspace',
      EXIT.contract,
    );
  }
  const confirmed = args.flags.has('--confirm') || args.flags.has('--yes');
  if (isDryRun(ctx, args) || !confirmed) {
    let existing = null;
    try {
      const repository = openRepository(ctx, args);
      existing = repository.getBatchImportRunForManifest(
        manifest.manifestId,
        manifest.workspaceId,
      );
      repository.close();
    } catch {
      // A preview can still describe the exact manifest before a catalog exists.
    }
    return preview('import-discovered', {
      manifest: publicDiscoveryManifest(manifest),
      receipt: previewDiscoveryImport(manifest, existing),
      confirmationRequired: !isDryRun(ctx, args),
      wouldPersist: false,
    });
  }

  const lease = await acquireImportLease(
    databasePath(ctx, args),
    sha256(['discovered-import', manifest.manifestId, manifest.workspaceId].join('\0')),
    {
      waitMs: boundedInteger(
        args.values.get('--lock-wait-ms'),
        5_000,
        0,
        300_000,
        '--lock-wait-ms',
      ),
    },
  );
  try {
    const repository = openRepository(ctx, args);
    try {
      const receipt = await importDiscoveryManifest({
        manifest,
        repository,
        signal: ctx.signal,
        inactivityThresholdMs: inactivityThreshold(args.values.get('--inactivity-threshold')),
      });
      return ok('import-discovered', {
        manifestId: manifest.manifestId,
        receipt,
        resumable: receipt.run.status !== 'complete',
      });
    } finally {
      repository.close();
    }
  } finally {
    await lease.release();
  }
}

function providerDisposition(provider: SessionProviderId): Record<string, unknown> {
  if (provider === 'codex') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl'],
      reasonCode: null,
      remediation: 'Authorize an App Server export or Codex sessions root, then import an explicit JSONL source.',
      evidence: {
        adapterVersion: CODEX_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md',
      },
    };
  }
  if (provider === 'claude') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl', 'hook', 'manual-export'],
      reasonCode: null,
      remediation: 'Authorize a Claude projects or hook root and import a JSONL file, '
        + 'or import an explicitly selected Claude web/account conversations.json export.',
      evidence: {
        adapterVersion: CLAUDE_ADAPTER_VERSION,
        verifiedAt: '2026-09-15',
        documentation: 'https://code.claude.com/docs/en/sessions',
      },
    };
  }
  if (provider === 'copilot') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
      reasonCode: null,
      remediation: 'Use Chat: Export Chat in VS Code, then import the explicitly selected JSON file.',
      evidence: {
        adapterVersion: COPILOT_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://code.visualstudio.com/docs/chat/chat-sessions#_export-a-chat-session-as-a-json-file',
      },
    };
  }
  if (provider === 'cursor') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl', 'manual-export'],
      reasonCode: null,
      remediation: 'Authorize a workspace agent-transcripts root, or import Cursor CLI/Cloud Agent exports explicitly.',
      evidence: {
        adapterVersion: CURSOR_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://docs.cursor.com/en/cli/reference/output-format',
      },
    };
  }
  if (provider === 'factory') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl', 'api'],
      reasonCode: null,
      remediation: 'Authorize a Factory projects root and import a Droid JSONL transcript; API and Exec require explicit negotiated transports.',
      evidence: {
        adapterVersion: FACTORY_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://docs.factory.ai/reference/hooks-reference',
      },
    };
  }
  if (provider === 'hermes') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['jsonl', 'api', 'sqlite-snapshot'],
      reasonCode: null,
      remediation: 'Use `hermes sessions export` or an explicitly verified sqlite3.backup() snapshot export.',
      evidence: {
        adapterVersion: HERMES_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://hermes-agent.nousresearch.com/docs/user-guide/sessions/',
      },
    };
  }
  if (provider === 'opencode') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export', 'api', 'jsonl'],
      reasonCode: null,
      remediation: 'Use `opencode export <sessionID>` or an explicitly authorized negotiated local API/SSE transport.',
      evidence: {
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://opencode.ai/docs/cli/',
      },
    };
  }
  if (provider === 'openclaw') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['api', 'sqlite-snapshot', 'jsonl'],
      reasonCode: null,
      remediation: 'Use an authorized read-only Gateway transport or a schema-16/event-v3 sqlite3.backup() projection.',
      evidence: {
        adapterVersion: OPENCLAW_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://docs.openclaw.ai/reference/session-management-compaction',
      },
    };
  }
  if (provider === 'openhuman') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['jsonl'],
      reasonCode: null,
      remediation: 'Import an explicitly selected schema-1 session_raw JSONL file, optionally bundled with thread/turn enrichment.',
      evidence: {
        adapterVersion: OPENHUMAN_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://github.com/tinyhumansai/openhuman/releases',
      },
    };
  }
  if (provider === 'omp') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl'], reasonCode: null,
      remediation: 'Authorize the selected OMP profile sessions root or an explicit native JSONL file.',
      evidence: {
        adapterVersion: OMP_ADAPTER_VERSION,
        verifiedAt: '2026-09-04',
        documentation: 'https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts',
      },
    };
  }
  if (provider === 'deepseek-harness') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'], acquisitionModes: ['jsonl'],
      reasonCode: null,
      remediation: 'Authorize an explicit DeepSeek Harness raw JSONL sessions root. Compressed .zstd histories must be exported as raw JSONL first.',
      evidence: {
        adapterVersion: DEEPSEEK_HARNESS_ADAPTER_VERSION,
        verifiedAt: '2026-09-05',
        documentation: 'https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/session/session-persistence-jsonl',
      },
    };
  }
  if (provider === 'pi') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl'], reasonCode: null,
      remediation: 'Authorize PI_CODING_AGENT_SESSION_DIR, the default Pi sessions root, or an explicit v3 JSONL export.',
      evidence: {
        adapterVersion: PI_ADAPTER_VERSION,
        verifiedAt: '2026-09-04',
        documentation: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts',
      },
    };
  }
  if (provider === 'grokbot') {
    return {
      provider, disposition: 'manual-only', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
      reasonCode: 'MANUAL_SOURCE_SELECTION_REQUIRED',
      remediation: 'Select an authorized AIWG session interchange export; Grok Bot auto-discover is unsupported until a native locator exists.',
      evidence: {
        adapterVersion: GROKBOT_ADAPTER_VERSION,
        verifiedAt: '2026-09-15',
        documentation: 'docs/providers/grokbot-sessions.md',
      },
    };
  }
  if (provider === 'grok-build') {
    return {
      provider, disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
      reasonCode: 'CLI_EXPORT_REQUIRED',
      remediation: 'Run `grok sessions list`, then `grok export <session-id> <session-id>.md` and import the explicitly authorized Markdown file.',
      evidence: {
        adapterVersion: GROK_BUILD_ADAPTER_VERSION,
        verifiedAt: '2026-09-21',
        documentation: 'https://docs.x.ai/build/features/sessions',
      },
    };
  }
  if (provider === 'muse') {
    return {
      provider, disposition: 'manual-only', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
      reasonCode: 'MANUAL_SOURCE_SELECTION_REQUIRED',
      remediation: 'Run `muse export` and explicitly select the trajectory JSON; Muse Code auto-discover is unsupported until a native session root is evidenced on disk.',
      evidence: {
        adapterVersion: MUSE_ADAPTER_VERSION,
        verifiedAt: '2026-09-24',
        documentation: 'docs/providers/muse-sessions.md',
      },
    };
  }
  if (provider === 'warp') {
    return {
      provider, disposition: 'manual-only', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
      reasonCode: 'LOSSY_MARKDOWN_ONLY',
      remediation: 'Run `/export-to-file` in Warp and import the explicitly selected Markdown file.',
      evidence: {
        adapterVersion: WARP_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://docs.warp.dev/agent-platform/capabilities/slash-commands',
      },
    };
  }
  if (provider === 'devin-desktop') {
    return {
      provider,
      product: 'Devin Desktop',
      compatibilityAliases: ['windsurf'],
      aliasDeprecatedAfter: '2027-07-27',
      disposition: 'implemented', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['hook', 'jsonl'],
      reasonCode: null,
      remediation: 'Enable Devin Desktop post_cascade_response_with_transcript, then explicitly select its JSONL output.',
      evidence: {
        adapterVersion: DEVIN_DESKTOP_ADAPTER_VERSION,
        verifiedAt: '2026-07-27',
        documentation: 'https://docs.devin.ai/desktop/cascade/hooks',
      },
    };
  }
  if (provider === 'generic') {
    return {
      provider, disposition: 'manual-only', operationalState: 'available',
      supportedOperations: ['inspect', 'stream'], acquisitionModes: ['manual-export'],
      reasonCode: 'MANUAL_SOURCE_SELECTION_REQUIRED',
      remediation: 'Pass a declared interchange file to `aiwg sessions import`.',
      evidence: { adapterVersion: GENERIC_ADAPTER_VERSION, verifiedAt: '2026-07-26' },
    };
  }
  return {
    provider, disposition: 'unsupported', operationalState: 'unavailable',
    supportedOperations: [], acquisitionModes: [],
    reasonCode: 'ADAPTER_NOT_IMPLEMENTED',
    remediation: 'Use the generic interchange until the provider adapter milestone is delivered.',
    evidence: { adapterVersion: null, verifiedAt: '2026-07-26' },
  };
}

function claudeLocatorClass(input: string): string {
  if (input.endsWith('.hooks.jsonl') || input.endsWith('.hook.jsonl')) return 'claude-hook-jsonl';
  if (input.endsWith('.json')) return 'claude-web-export-json';
  return 'claude-transcript-jsonl';
}

function claudeProviderProfile(locatorClass: string): string {
  if (locatorClass === 'claude-web-export-json') return 'web-account-export-conversations-json';
  return 'documented-local-jsonl';
}

function cursorLocatorClass(input: string): string {
  if (input.endsWith('.md') || input.endsWith('.markdown')) return 'cursor-editor-markdown';
  if (input.endsWith('.cloud.jsonl')) return 'cursor-cloud-events-jsonl';
  if (input.split(/[\\/]+/).includes('agent-transcripts')) return 'cursor-agent-transcript-jsonl';
  return 'cursor-cli-stream-json';
}

function cursorProviderProfile(locatorClass: string): string {
  if (locatorClass === 'cursor-editor-markdown') return 'editor-markdown-lossy';
  if (locatorClass === 'cursor-cloud-events-jsonl') return 'cloud-agents-api-v1';
  if (locatorClass === 'cursor-agent-transcript-jsonl') return 'agent-transcript-jsonl';
  return 'cli-stream-json';
}

function openRepository(ctx: HandlerContext, args: ParsedArgs): SessionRepository {
  const path = databasePath(ctx, args);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return new SessionRepository(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SQLITE_BUSY|database is locked/i.test(message)) {
      throw new CliError(
        'IMPORT_LOCKED',
        'the session catalog is busy; retry after the active writer finishes',
        EXIT.locked,
        { owner: null, waitedMs: 0 },
      );
    }
    throw new CliError(
      'CATALOG_UNAVAILABLE',
      message,
      EXIT.storage,
    );
  }
}

function databasePath(ctx: HandlerContext, args: ParsedArgs): string {
  if (args.values.has('--db')) return resolve(ctx.cwd, args.values.get('--db')!);
  return resolve(projectRootCandidate(ctx.cwd) ?? ctx.cwd, '.aiwg/sessions/catalog.sqlite');
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const valueFlags = new Set([
    '--db', '--provider', '--workspace', '--tag', '--limit', '--cursor', '--source-id',
    '--date-from', '--date-to', '--participant', '--model', '--role', '--tool',
    '--entity', '--sensitivity', '--extraction-state', '--page-size', '--max-documents',
    '--state', '--reviewer', '--reason', '--policy-version', '--min-confidence',
    '--consumer', '--actor-class', '--reason-code', '--dependent-action', '--basis',
    '--manifest', '--provider-home', '--codex-root', '--omp-root', '--dsh-root', '--lock-wait-ms', '--min-coverage', '--gap',
    '--inactivity-threshold',
    '--control-events',
    '--session', '--status', '--actor', '--group-by',
    '--out', '--plan', '--input', '--shard-name', '--max-attachment-bytes', '--format', '--grok-bin',
  ]);
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError('MISSING_OPTION_VALUE', `missing value for ${arg}`, EXIT.usage);
      }
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith('-')) {
      flags.add(arg);
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags, values };
}

function requiredPositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError('MISSING_ARGUMENT', `missing required ${name}`, EXIT.usage);
  return value;
}

function requiredValue(args: ParsedArgs, flag: string): string {
  const value = args.values.get(flag);
  if (!value) throw new CliError('MISSING_ARGUMENT', `missing required ${flag}`, EXIT.usage);
  return value;
}

function authorizationContext(
  ctx: HandlerContext,
  args: ParsedArgs,
  operation: string,
): SessionAuthorizationContext {
  return {
    actorId: 'local-catalog-owner',
    workspaceId: normalizeWorkspaceId(ctx.cwd, requiredValue(args, '--workspace')),
    operation,
    catalogScope: 'workspace',
    mode: 'local-owner',
  };
}

function readAuthorizationContext(
  ctx: HandlerContext,
  args: ParsedArgs,
  operation: string,
  repository: SessionRepository,
): SessionAuthorizationContext {
  const explicit = args.values.get('--workspace');
  if (explicit) {
    return {
      actorId: 'local-catalog-owner',
      workspaceId: normalizeWorkspaceId(ctx.cwd, explicit),
      operation,
      catalogScope: 'workspace',
      mode: 'local-owner',
    };
  }
  const project = projectRootCandidate(ctx.cwd);
  if (project) {
    return {
      actorId: 'local-catalog-owner',
      workspaceId: project,
      operation,
      catalogScope: 'workspace',
      mode: 'local-owner',
    };
  }
  const candidates = repository.listWorkspaceIds();
  if (candidates.length === 1) {
    return {
      actorId: 'local-catalog-owner',
      workspaceId: candidates[0],
      operation,
      catalogScope: 'workspace',
      mode: 'local-owner',
    };
  }
  if (candidates.length > 1) {
    throw new CliError(
      'WORKSPACE_AMBIGUOUS',
      'current workspace cannot be inferred safely; pass --workspace explicitly',
      EXIT.usage,
      {
        candidates,
        example: `aiwg sessions ${operation} --workspace ${JSON.stringify(candidates[0])}`,
      },
    );
  }
  throw new CliError(
    'WORKSPACE_REQUIRED',
    'current workspace cannot be inferred; pass --workspace explicitly',
    EXIT.usage,
    {
      candidates: [],
      example: `aiwg sessions ${operation} --workspace <path-or-id>`,
    },
  );
}

function projectRootCandidate(start: string): string | null {
  let current: string;
  try {
    const resolved = realpathSync(resolve(start));
    current = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    current = resolve(start);
  }
  while (true) {
    if (existsSync(resolve(current, '.aiwg', 'aiwg.config'))) return current;
    // A repository root is the project boundary. Do not let an unrelated
    // ancestor workspace configuration capture session catalog reads.
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizeWorkspaceId(cwd: string, value: string): string {
  const pathLike = isAbsolute(value)
    || value === '.'
    || value === '..'
    || value.startsWith('./')
    || value.startsWith('../');
  if (!pathLike) return value;
  const candidate = resolve(cwd, value);
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function boundedInteger(
  value: string | undefined, fallback: number, min: number, max: number, name: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new CliError('INVALID_ARGUMENT', `${name} must be an integer`, EXIT.usage);
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new CliError('INVALID_ARGUMENT', `${name} must be between ${min} and ${max}`, EXIT.usage);
  }
  return parsed;
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new CliError('INVALID_ARGUMENT', `${name} must be between ${min} and ${max}`, EXIT.usage);
  }
  return parsed;
}

function timelineGap(value: string | undefined): number {
  try {
    return parseTimelineGap(value);
  } catch (error) {
    throw new CliError(
      'INVALID_ARGUMENT',
      error instanceof Error ? error.message : 'invalid timeline gap',
      EXIT.usage,
    );
  }
}

function inactivityThreshold(value: string | undefined): number {
  try {
    return parseTimelineGap(value ?? '24h');
  } catch (error) {
    throw new CliError(
      'INVALID_ARGUMENT',
      error instanceof Error ? error.message : 'invalid inactivity threshold',
      EXIT.usage,
    );
  }
}

function controlEventMode(
  value: string | undefined,
): 'exclude' | 'include' | 'only' {
  if (value === undefined) return 'exclude';
  if (value === 'exclude' || value === 'include' || value === 'only') return value;
  throw new CliError(
    'INVALID_ARGUMENT',
    '--control-events must be exclude, include, or only',
    EXIT.usage,
  );
}

type CandidateState = 'pending' | 'accepted' | 'rejected' | 'deferred' | 'promoted' | 'superseded';

function candidateState(value: string | undefined): CandidateState | undefined {
  if (value === undefined) return undefined;
  const states = new Set<CandidateState>([
    'pending', 'accepted', 'rejected', 'deferred', 'promoted', 'superseded',
  ]);
  if (!states.has(value as CandidateState)) {
    throw new CliError('INVALID_ARGUMENT', `invalid candidate state: ${value}`, EXIT.usage);
  }
  return value as CandidateState;
}

function dependentAction(
  value: string,
): 'revoke' | 'supersede' | 'retain' | 'origin_unavailable' | 'delete' | 'abort' {
  const actions = new Set([
    'revoke', 'supersede', 'retain', 'origin_unavailable', 'delete', 'abort',
  ]);
  if (!actions.has(value)) {
    throw new CliError('INVALID_ARGUMENT', `invalid dependent action: ${value}`, EXIT.usage);
  }
  return value as 'revoke' | 'supersede' | 'retain'
    | 'origin_unavailable' | 'delete' | 'abort';
}

function analyticsQuery(args: ParsedArgs, workspaceId: string): SessionAnalyticsQuery {
  const providerInput = args.values.get('--provider');
  const statusInput = args.values.get('--status');
  return {
    workspaceId,
    provider: providerInput ? assertSessionProviderId(providerInput) : undefined,
    sessionId: args.values.get('--session'),
    dateFrom: args.values.get('--date-from'),
    dateTo: args.values.get('--date-to'),
    tool: args.values.get('--tool'),
    status: statusInput ? analyticsStatus(statusInput) : undefined,
    actor: args.values.get('--actor') ?? args.values.get('--participant'),
    tag: args.values.get('--tag'),
    sensitivity: args.values.get('--sensitivity'),
    extractionState: args.values.get('--extraction-state'),
    limit: boundedInteger(args.values.get('--limit'), 500, 1, 5_000, '--limit'),
  };
}

function analyticsStatus(value: string): SessionAnalyticsStatus {
  const allowed = new Set<SessionAnalyticsStatus>([
    'requested', 'running', 'succeeded', 'failed', 'granted', 'denied',
    'timed-out', 'unsupported', 'provider-unknown', 'observed',
  ]);
  if (!allowed.has(value as SessionAnalyticsStatus)) {
    throw new CliError('INVALID_ARGUMENT', `invalid analytics status: ${value}`, EXIT.usage);
  }
  return value as SessionAnalyticsStatus;
}

function analyticsCategories(view: string): SessionAnalyticsCategory[] {
  if (view === 'tool-calls') return ['tool-call', 'tool-result'];
  if (view === 'escalations') return ['escalation'];
  if (view === 'hitl') return ['hitl'];
  throw new CliError('INVALID_ARGUMENT', `unknown analytics view: ${view}`, EXIT.usage);
}

function analyticsGrouping(
  items: SessionAnalyticsFact[],
  groupBy: string | undefined,
): Record<string, number> | null {
  if (!groupBy) return null;
  if (!['tool', 'session', 'provider'].includes(groupBy)) {
    throw new CliError('INVALID_ARGUMENT', `invalid --group-by value: ${groupBy}`, EXIT.usage);
  }
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = groupBy === 'tool'
      ? item.toolName
      : groupBy === 'session'
        ? item.sessionId
        : item.provider;
    const key = typeof value === 'string' && value ? value : '<unknown>';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function forensicOutput(
  view: string,
  items: SessionAnalyticsFact[],
  args: ParsedArgs,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    analyticsVersion: '1.0.0',
    view,
    items,
    count: items.length,
    authorization: {
      explicit: true,
      providerLogsModified: false,
      historicalContentExecuted: false,
    },
  };
  if (args.flags.has('--markdown')) {
    output.markdown = [
      `# Session Forensics ${view}`,
      '',
      `Facts: ${items.length}`,
      '',
      '| Time | Provider | Session | Category | Status | Evidence |',
      '|---|---|---|---|---|---|',
      ...items.map((item) => {
        const citation = item.sourceCitation as Record<string, unknown> | undefined;
        return [
          item.occurredAt ?? '<unknown>',
          item.provider ?? '<unknown>',
          item.sessionId ?? '<unknown>',
          item.category ?? '<unknown>',
          item.status ?? '<unknown>',
          citation?.eventId ?? item.eventId ?? '<unknown>',
        ].map((value) => String(value).replaceAll('|', '\\|')).join(' | ');
      }).map((row) => `| ${row} |`),
    ].join('\n');
  }
  return output;
}

function isDryRun(ctx: HandlerContext, args: ParsedArgs): boolean {
  return Boolean(ctx.dryRun || args.flags.has('--dry-run'));
}

function ok(command: string, data: unknown): { envelope: Envelope; exitCode: number } {
  return { envelope: envelope(`sessions.${command}`, 'ok', data, null), exitCode: EXIT.ok };
}

function preview(command: string, data: unknown): { envelope: Envelope; exitCode: number } {
  return { envelope: envelope(`sessions.${command}`, 'preview', data, null), exitCode: EXIT.ok };
}

function envelope(
  command: string, status: Envelope['status'], data: unknown, error: Envelope['error'],
): Envelope {
  return { contractVersion: JSON_CONTRACT_VERSION, command, status, data, error };
}

function emit(value: Envelope): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHuman(value: Envelope): void {
  if (value.status === 'preview') console.log('Preview (no changes applied)');
  if (value.command === 'sessions.forensics' && value.data
    && typeof value.data === 'object' && 'markdown' in value.data
    && typeof value.data.markdown === 'string') {
    console.log(value.data.markdown);
    return;
  }
  if (value.command === 'sessions.timeline' && value.data
    && typeof value.data === 'object' && 'items' in value.data) {
    const data = value.data as { items: Array<Record<string, unknown>>; coverage?: { status?: string } };
    for (const item of data.items) {
      console.log([
        item.startAt ?? '<unknown-time>',
        item.endAt ?? '<unknown-time>',
        item.provider,
        item.sessionId,
        `segment=${item.segmentIndex}`,
        `events=${item.eventCount}`,
        `boundary=${item.boundaryBasis}`,
        `confidence=${item.confidence}`,
      ].join(' '));
    }
    console.log(`Coverage: ${data.coverage?.status ?? 'unknown'}`);
    return;
  }
  console.log(JSON.stringify(value.data, null, 2));
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function normalizeError(error: unknown): {
  error: { code: string; message: string; details?: unknown };
  exitCode: number;
} {
  if (error instanceof CliError) {
    return {
      error: { code: error.code, message: error.message, details: error.details },
      exitCode: error.exitCode,
    };
  }
  if (error instanceof SessionContractError) {
    const exitCode = error.code === 'UNSUPPORTED_OPERATION' ? EXIT.unsupported : EXIT.contract;
    return { error: { code: error.code, message: error.message }, exitCode };
  }
  if (error instanceof ImportLeaseContentionError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: {
          owner: error.owner,
          waitedMs: error.waitMs,
        },
      },
      exitCode: EXIT.locked,
    };
  }
  return {
    error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
    exitCode: EXIT.storage,
  };
}
