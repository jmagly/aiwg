/**
 * Workspace Management Handlers
 *
 * Handlers for workspace health, migration, and rollback operations.
 * Delegates to existing CLI scripts in tools/cli/.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @source @src/cli/router.ts
 * @issue #33
 */

import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { maybePrintCommunityFooter } from '../../community/footer.js';
import { buildDeploymentStatusProbe } from '../services/deployment-verification.js';
import { detectScope } from '../scope-resolver.js';

function statusProjectRoot(args: string[], fallback: string): string {
  const valueFlags = new Set(['--scope', '--provider', '--bundle']);
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('-')) return args[index];
  }
  return fallback;
}

function statusFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Handler for workspace status command
 *
 * Shows workspace health, installed frameworks, and migration status.
 *
 * Usage:
 *   aiwg -status
 *   aiwg --status
 *   aiwg -status --verbose
 *   aiwg -status --json
 */
export const statusHandler: CommandHandler = {
  id: 'status',
  name: 'Workspace Status',
  description: 'Show workspace health and installed frameworks',
  category: 'workspace',
  aliases: ['-status', '--status'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes('--probe')) {
      const projectRoot = statusProjectRoot(ctx.args, ctx.cwd ?? process.cwd());
      const scope = detectScope(ctx.args);
      const probe = await buildDeploymentStatusProbe(projectRoot, ctx.frameworkRoot, {
        scope,
        provider: statusFlagValue(ctx.args, '--provider'),
        bundle: statusFlagValue(ctx.args, '--bundle'),
      });
      const { inspectGrokBuildNative } = await import('../../mcp/grok-build-config.mjs');
      const grokBuildNative = await inspectGrokBuildNative({ projectDir: projectRoot });
      return {
        exitCode: probe.status === 'needs-repair' ? 1 : 0,
        message: JSON.stringify({ ...probe, grokBuildNative }, null, 2),
        rawOutput: true,
      };
    }

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    const result = await runner.run('tools/cli/workspace-status.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
    const machineReadable = ctx.args.includes('--json') || ctx.args.includes('--probe') || ctx.args.includes('--serve') || ctx.args.includes('--export');
    if (result.exitCode === 0 && !machineReadable) {
      maybePrintCommunityFooter();
    }
    return result;
  },
};

/**
 * Handler for the guided onboarding wizard.
 *
 * The MVP wizard is a deterministic, no-write planner that walks the user
 * through provider, project, framework, deploy, and verification steps.
 */
export const wizardHandler: CommandHandler = {
  id: 'wizard',
  name: 'Onboarding Wizard',
  description: 'Guide first-run provider, project, framework, deploy, and verify steps',
  category: 'workspace',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run('tools/cli/wizard.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Handler for workspace migration command
 *
 * Migrates legacy .aiwg/ workspace structure to framework-scoped structure.
 * Provides interactive migration workflow with validation, backup, and reporting.
 *
 * Usage:
 *   aiwg -migrate-workspace
 *   aiwg --migrate-workspace
 *   aiwg -migrate-workspace --dry-run
 *   aiwg -migrate-workspace --no-backup
 *   aiwg -migrate-workspace --force
 *   aiwg -migrate-workspace --yes
 */
export const migrateWorkspaceHandler: CommandHandler = {
  id: 'migrate-workspace',
  name: 'Migrate Workspace',
  description: 'Migrate legacy .aiwg/ to framework-scoped structure',
  category: 'workspace',
  aliases: ['-migrate-workspace', '--migrate-workspace'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run('tools/cli/workspace-migrate.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Handler for workspace rollback command
 *
 * Rolls back workspace migration from backup.
 *
 * Usage:
 *   aiwg -rollback-workspace
 *   aiwg --rollback-workspace
 *   aiwg -rollback-workspace --list
 *   aiwg -rollback-workspace --backup <backup-path>
 */
export const rollbackWorkspaceHandler: CommandHandler = {
  id: 'rollback-workspace',
  name: 'Rollback Workspace',
  description: 'Rollback workspace migration from backup',
  category: 'workspace',
  aliases: ['-rollback-workspace', '--rollback-workspace'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run('tools/cli/workspace-rollback.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * All workspace management handlers
 */
export const workspaceHandlers: CommandHandler[] = [
  statusHandler,
  wizardHandler,
  migrateWorkspaceHandler,
  rollbackWorkspaceHandler,
];
