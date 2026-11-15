/**
 * AIWG MCP Tool: aiwg-command-run
 *
 * Single dispatch MCP tool that routes to the ~94 AIWG CLI commands.
 * Replaces the `workflow-run` stub.
 *
 * Security model:
 *   - Allow-list validated against `src/extensions/commands/definitions.ts`
 *     (loaded lazily at first call)
 *   - `args` is a string array — passed as argv, never shell-interpreted
 *   - `shell: false` enforced in spawn
 *   - Destructive commands require `confirmed: true`
 *
 * @architecture @docs/cli/agent-usage.md
 * @issues #1312 (S1)
 * @rules @token-security, @anti-laziness
 */

import { z } from 'zod';
import { integer } from '../../schema/zod-validation.mjs';
import {
  runAiwgCli,
  loadCommandAllowList,
  isDestructive,
  mcpError,
  mcpJson,
} from '../helpers.mjs';

export function registerCommandRunTool(server) {
  server.registerTool('command-run', {
    title: 'Run AIWG CLI Command',
    description: 'Dispatch to any allow-listed AIWG CLI command (`aiwg <command> [args...]`). The full surface of ~94 commands is reachable. Destructive commands require `confirmed: true`.',
    inputSchema: {
      command: z.string().describe('Command name from `command-list` (e.g. "use", "discover", "doctor")'),
      args: z.array(z.string()).prefault([]).describe('Argument array (never shell-interpreted)'),
      project_dir: z.string().optional().describe('Working directory for the command'),
      confirmed: z.boolean().default(false).describe('Required for destructive commands (true to proceed)'),
      timeout_ms: integer().min(1000).max(600_000).default(120_000).describe('Timeout (1s–10min, default 2min)'),
    },
    annotations: {
      destructiveHint: true,  // conservative default; many subcommands are read-only but the surface is broad
      openWorldHint: true,    // touches filesystem and project state
    },
  }, async ({ command, args, project_dir, confirmed, timeout_ms }) => {
    try {
      // 1. Allow-list validation
      const allowList = await loadCommandAllowList();
      if (allowList.size === 0) {
        return mcpError(
          'command-run: cannot load command allow-list from AIWG_ROOT. ' +
          'AIWG installation may be incomplete.',
          { remediation: 'Run `aiwg doctor` to verify AIWG_ROOT is set correctly.' }
        );
      }
      if (!allowList.has(command)) {
        return mcpError(
          `command-run: command "${command}" not in allow-list.`,
          { remediation: 'Call `command-list` (or `discover --type command`) to see available commands.' }
        );
      }

      // 2. Destructive-op gate
      if (isDestructive(command) && !confirmed) {
        return mcpError(
          `command-run: "${command}" is a destructive command. Re-invoke with confirmed=true to proceed.`,
          {
            remediation: 'Set confirmed=true after surfacing the impact to the user.',
            requiresConfirmation: true,
          }
        );
      }

      // 3. Argument sanity (no shell metacharacters smuggled via array elements
      // — these are passed as argv so they're safe, but reject NUL bytes which
      // would truncate argv at the OS level)
      for (const a of args) {
        if (typeof a !== 'string' || a.includes('\0')) {
          return mcpError('command-run: invalid argument (NUL byte or non-string)');
        }
      }

      // 4. Log path only — never log the args content (token-security)
      console.error(`[AIWG MCP] command-run: aiwg ${command} (${args.length} args)`);

      // 5. Spawn with shell: false (runAiwgCli enforces this)
      const { stdout, stderr, code } = await runAiwgCli(
        [command, ...args],
        { cwd: project_dir, timeoutMs: timeout_ms }
      );

      return mcpJson({
        command,
        exit_code: code,
        stdout,
        stderr,
        confirmed,
      });
    } catch (err) {
      return mcpError(`command-run: ${err.message}`);
    }
  });
}
