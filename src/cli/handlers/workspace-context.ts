/** Explicit, reversible WORKSPACE.md context-graph lifecycle (#1811). */
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { handlerResultFromError } from '../errors.js';
import {
  auditWorkspaceContext,
  diagnoseWorkspaceContext,
  migrateWorkspaceContext,
  rollbackWorkspaceContext,
} from '../../smiths/context-pipeline/workspace-context.js';

function printHelp(): void {
  console.log(`
  aiwg workspace-context — Audit and migrate provider context into WORKSPACE.md

  Usage:
    aiwg workspace-context audit [--json]
    aiwg workspace-context migrate --dry-run [--json]
    aiwg workspace-context migrate --apply [--allow-conflicts] [--json]
    aiwg workspace-context rollback [transaction-id] [--json]
    aiwg workspace-context doctor [--json]

  Migration is opt-in. Audit and dry-run never write. Apply records source
  attribution and preimages under .aiwg/context-migrations/ for rollback.
`);
}

export const workspaceContextHandler: CommandHandler = {
  id: 'workspace-context',
  name: 'Workspace Context',
  description: 'Audit, migrate, diagnose, and roll back canonical WORKSPACE.md context',
  category: 'maintenance',
  aliases: [],

  async help(): Promise<HandlerResult> {
    printHelp();
    return { exitCode: 0 };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
        printHelp();
        return { exitCode: 0 };
      }
      const json = ctx.args.includes('--json');
      const positional = ctx.args.filter((arg) => !arg.startsWith('-'));
      const action = positional[0] ?? 'audit';
      if (action === 'audit') {
        const audit = await auditWorkspaceContext(ctx.cwd);
        if (json) console.log(JSON.stringify(audit, null, 2));
        else {
          console.log(`Workspace context audit: ${audit.sources.length} source(s)`);
          console.log(`  WORKSPACE.md: ${audit.workspaceExists ? 'present' : audit.legacyCompatible ? 'legacy layout supported' : 'missing'}`);
          console.log(`  Identical directives: ${audit.identical.length}`);
          console.log(`  Ambiguous conflicts: ${audit.conflicts.length}`);
          console.log(`  Sensitive findings: ${audit.sensitiveFindings.length}`);
          console.log(`  Planned outputs: ${audit.plan.outputs.join(', ')}`);
        }
        return { exitCode: audit.sensitiveFindings.length > 0 ? 1 : 0 };
      }
      if (action === 'migrate') {
        const apply = ctx.args.includes('--apply');
        const result = await migrateWorkspaceContext(ctx.cwd, {
          apply,
          dryRun: ctx.args.includes('--dry-run') || !apply,
          allowConflicts: ctx.args.includes('--allow-conflicts'),
        });
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${result.dryRun ? 'Migration dry run' : 'Migration applied'}: ${result.changed ? 'changes found' : 'already canonical'}`);
          for (const entry of result.audit.plan.routing) {
            console.log(`  ${entry.source}: ${entry.operatorBytes.toLocaleString()} chars -> ${entry.destination} (${entry.scope})`);
          }
          for (const entry of result.audit.plan.scopeReview) {
            console.log(`  REVIEW ${entry.source} carries ${entry.operatorBytes.toLocaleString()} chars of operator content and is scoped to ${entry.scope} by filename.`);
            console.log('         Content in .aiwg/context/providers/ is read by that provider only.');
            console.log("         If this is project-neutral methodology, move it into WORKSPACE.md's Project Context section first.");
          }
          for (const file of result.written) console.log(`  ${result.dryRun ? 'would write' : 'wrote'} ${file}`);
          if (result.transactionId) console.log(`  transaction: ${result.transactionId}`);
          if (result.backups.length > 0) console.log(`  recoverable preimages: ${result.backups.length}`);
        }
        return { exitCode: 0 };
      }
      if (action === 'rollback') {
        const result = await rollbackWorkspaceContext(ctx.cwd, positional[1]);
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Rolled back ${result.id}: restored ${result.restored.length} file(s).`);
        return { exitCode: 0 };
      }
      if (action === 'doctor') {
        const diagnostics = await diagnoseWorkspaceContext(ctx.cwd);
        if (json) console.log(JSON.stringify(diagnostics, null, 2));
        else for (const diagnostic of diagnostics) console.log(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
        return { exitCode: diagnostics.some((item) => item.severity === 'error') ? 1 : 0 };
      }
      printHelp();
      return { exitCode: 2, message: `Unknown workspace-context action: ${action}` };
    } catch (error) {
      return handlerResultFromError(error);
    }
  },
};

export const workspaceContextHandlers: CommandHandler[] = [workspaceContextHandler];
