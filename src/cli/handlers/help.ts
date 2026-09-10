/**
 * Help Command Handler
 *
 * Displays comprehensive CLI help information.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @source @src/cli/router.ts
 * @issue #33
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { maybePrintCommunityFooter } from '../../community/footer.js';
import { listProviderDefinitions } from '../../providers/provider-definitions.js';
import { getCommandIds } from '../../extensions/commands/definitions.js';

/**
 * Help command handler
 */
export const helpHandler: CommandHandler = {
  id: 'help',
  name: 'Help',
  description: 'Show CLI help message',
  category: 'maintenance',
  aliases: ['-h', '-help', '--help'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes('--json')) {
      // Canonical IDs only: aliases and example prose are not registry entries.
      console.log(JSON.stringify({ schema: 'aiwg.command-registry.v1', commandIds: getCommandIds() }));
      return { exitCode: 0 };
    }
    displayHelp();
    return { exitCode: 0 };
  },
};

/**
 * Format a help group — bold header, aligned command/description pairs
 */
function helpGroup(title: string, commands: [string, string][]): void {
  ui.header(`  ${title}`);
  const maxCmd = Math.max(...commands.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of commands) {
    console.log(`    ${ui.bold(cmd.padEnd(maxCmd + 2))}${ui.dimText(desc)}`);
  }
  console.log('');
}

/**
 * Display comprehensive help information
 */
function displayHelp(): void {
  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('AIWG')}`);
  ui.rule();
  ui.blank();
  console.log(`  ${ui.dimText('Usage:')} aiwg ${ui.accent('<command>')} ${ui.dimText('[options]')}`);
  ui.blank();

  helpGroup('FRAMEWORK', [
    ['use <framework>', 'Deploy framework (sdlc, marketing, media-curator, research, forensics, security-engineering, ops, validation, knowledge-base, all)'],
    ['use cockpit', 'Install the opt-in @aiwg/cockpit package outside the base aiwg footprint'],
    ['list', 'List installed frameworks and addons'],
    ['remove <id>', 'Remove a framework or addon'],
  ]);

  helpGroup('PROJECT', [
    ['new <name>', 'Create new project with SDLC templates'],
    ['init', 'Create the baseline .aiwg/aiwg.config file'],
    ['setup project', 'CLI helper used by agents for repo/tracker/delivery/signing policy'],
    ['quickref generate --project', 'Generate the canonical project quickref skill (--dry-run previews deterministic output)'],
    ['quickref deploy --project', 'Deploy the project quickref to configured provider kernel surfaces'],
  ]);

  helpGroup('WORKSPACE', [
    ['status', 'Show workspace health and installed frameworks'],
    ['sessions <command>', 'Manage the normalized session catalog, imports, and analytics'],
    ['migrate-workspace', 'Migrate legacy .aiwg/ to framework-scoped structure'],
    ['rollback-workspace', 'Rollback workspace migration from backup'],
  ]);

  helpGroup('MCP SERVER', [
    ['mcp serve', 'Start AIWG MCP server (stdio transport)'],
    ['mcp install [target]', 'Generate MCP client config (claude, copilot, factory, cursor)'],
    ['mcp info', 'Show MCP server capabilities'],
  ]);

  helpGroup('TOOLSMITH', [
    ['runtime-info', 'Show runtime environment summary'],
    ['runtime-info --discover', 'Full tool discovery and catalog generation'],
    ['runtime-info --check <tool>', 'Check specific tool availability'],
    ['runtime-info --transports', 'Show configured transport capabilities separately from providers'],
    ['uhp <operation> --profile <name>', 'Inspect or smoke-test an explicit experimental UHP endpoint profile'],
  ]);

  helpGroup('CATALOG', [
    ['catalog list', 'List all models in catalog'],
    ['catalog info <id>', 'Show detailed model information'],
    ['catalog search <q>', 'Search models by query'],
  ]);

  helpGroup('DISCOVERY', [
    ['discover "<phrase>"', 'Find skills/agents/commands/rules by capability'],
    ['show <type> <name>', 'Stream the body of an indexed artifact'],
    ['versions <list|resolve|show>', 'Browse and resolve signed AIWG web resource releases'],
    ['auth <login|status|logout>', 'Authenticate for paid AIWG web resources'],
    ['index <subcommand>', 'Manage the artifact index (build/query/discover/deps/stats)'],
    ['artifacts move --to <path>', 'Move/rename the project AIWG artifact root and reindex'],
  ]);

  helpGroup('DISPATCH', [
    ['run skill <name>', 'Execute a script-bearing skill'],
    ['run <script-name>', 'Run a user-defined script from .aiwg/aiwg.config'],
    ['writing <plan|proofread>', 'Use grounded briefs and authorized proofreading'],
    ['writer-profile <action>', 'Manage author-controlled writer profile sidecars'],
    ['output-mode <action>', 'Configure composable output language and presentation'],
  ]);

  helpGroup('FEATURES', [
    ['features', 'Show optional feature install status'],
    ['cockpit [--status|doctor]', 'Launch Cockpit or diagnose its executor topology'],
  ]);

  helpGroup('VALIDATION', [
    ['validate-metadata [path]', 'Validate AIWG component metadata (defaults to agentic/code)'],
    ['context-firewall [scan]', 'Audit provider context, trust, drift, poisoning signals, and budget'],
    ['context-firewall baseline', 'Plan or explicitly write the reviewed context baseline'],
  ]);

  helpGroup('METRICS', [
    ['cost-report --fleet', 'Observe OpenRouter per-bot MTD spend and correlate local activity'],
  ]);

  helpGroup('EVIDENCE', [
    ['evidence export --output <dir>', 'Package portable activity, report, source, eval, and provenance evidence'],
    ['evidence verify <bundle>', 'Verify every member hash and the bundle checkpoint'],
  ]);

  helpGroup('SCAFFOLDING', [
    ['new-bundle <name>', 'Create project-local bundle (--type extension|addon|framework|plugin|provider, --starter skill|rule|agent|minimal, --dry-run)'],
    ['new-extension <name>', 'Alias for new-bundle --type extension'],
    ['new-addon <name>', 'Alias for new-bundle --type addon'],
    ['new-framework <name>', 'Alias for new-bundle --type framework'],
    ['new-plugin <name>', 'Alias for new-bundle --type plugin'],
    ['new-provider <name>', 'Alias for new-bundle --type provider'],
    ['add-agent <name>', 'Add agent to existing bundle'],
    ['add-command <name>', 'Add command to existing bundle'],
    ['add-skill <name>', 'Add skill to existing bundle'],
    ['scaffold-addon <name>', '[legacy] Use new-addon instead'],
    ['scaffold-framework <name>', '[legacy] Use new-framework instead'],
  ]);

  helpGroup('PROMOTE', [
    ['promote <name>', 'Graduate project-local bundle to upstream (--to upstream|corpus, --dry-run, --cleanup)'],
  ]);

  helpGroup('RALPH LOOP', [
    ['ralph "<task>"', 'Execute iterative task loop (--completion, --max-iterations)'],
    ['ralph-status', 'Check current loop status'],
    ['ralph-abort', 'Abort running loop'],
    ['ralph-resume', 'Resume interrupted loop'],
  ]);

  helpGroup('MAINTENANCE', [
    ['doctor', 'Check installation health'],
    ['version', 'Show version and channel info'],
    ['refresh', 'Update AIWG and redeploy frameworks (formerly: sync)'],
    ['update', 'Update the active installation and re-deploy installed frameworks (alias: upgrade)'],
    ['help', 'Show this help message'],
  ]);

  helpGroup('CHANNEL', [
    ['--use-dev [path]', 'Customize AIWG live from a local clone or fork'],
    ['--use-main', 'Switch to edge channel (bleeding edge)'],
    ['--use-stable', 'Switch back to stable npm package'],
  ]);

  ui.rule();
  ui.blank();
  const providers = listProviderDefinitions().filter(({ id }) => id !== 'generic');
  console.log(`  ${ui.dimText('Providers:')} ${providers.length} — ${providers.map(({ id }) => id).join(', ')} (default: claude; aliases: agy → antigravity, devin → windsurf, oh-my-pi → omp)`);
  ui.blank();
  console.log(`  ${ui.dimText('Examples:')}`);
  console.log(`    aiwg use sdlc                   ${ui.dimText('Install SDLC framework')}`);
  console.log(`    aiwg use sdlc --global          ${ui.dimText('Install user assets + lightweight project wiring')}`);
  console.log(`    aiwg use cockpit                ${ui.dimText('Install opt-in Cockpit package')}`);
  console.log(`    aiwg cockpit                    ${ui.dimText('Launch Cockpit after install')}`);
  console.log(`    aiwg discover "deploy"          ${ui.dimText('Find skills by capability')}`);
  console.log(`    aiwg show skill intake-wizard   ${ui.dimText('Stream a skill body')}`);
  console.log(`    aiwg doctor                     ${ui.dimText('Check installation health')}`);
  console.log(`    aiwg refresh                    ${ui.dimText('Pull latest + redeploy frameworks')}`);
  maybePrintCommunityFooter();
  ui.blank();
}
