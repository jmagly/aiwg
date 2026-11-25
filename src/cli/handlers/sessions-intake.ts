// `aiwg sessions import --from-dir`: idempotent intake-directory batch import (#3168).
import { join } from 'node:path';
import {
  fingerprintSourceFile, intakeSourceId, isRecognisedIntakeFile, listIntakeDirFiles,
  summarizeIntakeReceipts, INTAKE_DIR_SCHEMA_VERSION,
  type IntakeFileReceipt, type SessionProviderId, type SessionRepository,
} from '../../sessions/index.js';
import type { HandlerContext } from './types.js';
import type { Envelope, ParsedArgs } from './sessions.js';

type Result = { envelope: Envelope; exitCode: number };

/** Handler-local helpers the batch reuses, so the single-file import path stays the only import path. */
export interface IntakeDirDeps {
  assertSupportedImportProvider(providerInput: string): SessionProviderId;
  normalizeWorkspaceId(cwd: string, value: string): string;
  isDryRun(ctx: HandlerContext, args: ParsedArgs): boolean;
  preview(command: string, data: unknown): Result;
  ok(command: string, data: unknown): Result;
  openRepository(ctx: HandlerContext, args: ParsedArgs): SessionRepository;
  adapterVersionFor(provider: SessionProviderId): string;
  importSource(ctx: HandlerContext, args: ParsedArgs): Promise<Result>;
  importFailureReason(error: unknown): string;
}

export async function importFromDir(
  ctx: HandlerContext,
  args: ParsedArgs,
  dir: string,
  deps: IntakeDirDeps,
): Promise<{ envelope: Envelope; exitCode: number }> {
  const {
    assertSupportedImportProvider, normalizeWorkspaceId, isDryRun, preview, ok,
    openRepository, adapterVersionFor, importSource, importFailureReason,
  } = deps;
  const provider = assertSupportedImportProvider(args.values.get('--provider') ?? 'generic');
  const workspaceId = args.values.has('--workspace')
    ? normalizeWorkspaceId(ctx.cwd, args.values.get('--workspace')!)
    : 'default';
  const prefix = args.values.get('--source-id');
  const files = await listIntakeDirFiles(dir);
  if (isDryRun(ctx, args)) {
    return preview('import', {
      fromDir: dir,
      provider,
      workspaceId,
      sourceIdPrefix: prefix ?? null,
      files: files.map((file) => {
        const recognition = isRecognisedIntakeFile(provider, file);
        return {
          file,
          sourceId: recognition.recognised ? intakeSourceId(prefix, file) : null,
          recognised: recognition.recognised,
          reason: recognition.reason ?? null,
        };
      }),
      wouldPersist: false,
    });
  }
  const repository = openRepository(ctx, args);
  try {
    const interrupted = new Map<string, { runId: string; interruptedAt: string }>();
    const receipts: IntakeFileReceipt[] = [];
    for (const file of files) {
      const recognition = isRecognisedIntakeFile(provider, file);
      const input = join(dir, file);
      if (!recognition.recognised) {
        receipts.push({
          file, sourceId: null, digest: null, status: 'skipped',
          reason: recognition.reason ?? 'unrecognised file', sessionsInserted: 0, eventsInserted: 0,
        });
        continue;
      }
      const sourceId = intakeSourceId(prefix, file);
      let digest: string | null = null;
      try {
        const fingerprint = await fingerprintSourceFile({ selectedPath: input, allowedRoots: [dir] });
        digest = fingerprint.digest;
        const checkpoint = repository.getCheckpoint(sourceId, adapterVersionFor(provider));
        if (checkpoint?.prefixDigest === digest && checkpoint.sourceSize === fingerprint.size) {
          receipts.push({
            file, sourceId, digest, status: 'already-imported',
            reason: 'content digest already imported', sessionsInserted: 0, eventsInserted: 0,
          });
          continue;
        }
      } catch (error) {
        receipts.push({
          file, sourceId, digest, status: 'rejected',
          reason: importFailureReason(error), sessionsInserted: 0, eventsInserted: 0,
        });
        continue;
      }
      const fileValues = new Map(args.values);
      fileValues.delete('--from-dir');
      fileValues.set('--source-id', sourceId);
      try {
        const result = await importSource(ctx, {
          command: 'import', positionals: [input], flags: new Set(args.flags),
          values: fileValues, codexRoots: args.codexRoots, claudeProjectDirs: args.claudeProjectDirs, exclude: args.exclude,
        });
        const data = result.envelope.data as {
          receipts?: unknown;
          interruptedRuns?: Array<{ runId: string; interruptedAt: string }>;
          totals?: { sessionsInserted?: number; eventsInserted?: number };
        };
        for (const run of data.interruptedRuns ?? []) interrupted.set(run.runId, run);
        receipts.push({
          file, sourceId, digest, status: 'imported', reason: null,
          sessionsInserted: data.totals?.sessionsInserted ?? 0,
          eventsInserted: data.totals?.eventsInserted ?? 0,
        });
      } catch (error) {
        receipts.push({
          file, sourceId, digest, status: 'rejected',
          reason: importFailureReason(error), sessionsInserted: 0, eventsInserted: 0,
        });
      }
    }
    return ok('import', {
      fromDir: dir,
      provider,
      workspaceId,
      sourceIdPrefix: prefix ?? null,
      schemaVersion: INTAKE_DIR_SCHEMA_VERSION,
      files: receipts,
      summary: summarizeIntakeReceipts(receipts),
      interruptedRuns: [...interrupted.values()],
    });
  } finally {
    repository.close();
  }
}
