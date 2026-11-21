/**
 * Team Command Handler
 *
 * Routes declared teams across AIWG providers, including bounded native OMP tasks.
 * Provides a provider-agnostic abstraction for declaring, deploying, and
 * invoking agent teams. On Claude Code, delegates to native team mechanisms.
 * OMP executes explicit task files; other providers use aiwg mc orchestration.
 *
 * Subcommands: run, list, info
 *
 * @issue #598
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { promises as fs } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectAiwgPath } from '../../config/project-artifacts.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';
import { isSessionProviderResolution, resolveActiveProvider } from '../provider-resolution.js';

// ── Types ────────────────────────────────────────────────────

interface TeamMember {
  agent: string;
  role: 'lead' | 'contributor' | 'reviewer' | 'advisor';
  responsibilities?: string[];
}

interface TeamHandoff {
  from: string;
  to: string;
  artifact: string;
  gate: string;
}

interface TeamDefinition {
  name: string;
  slug: string;
  description: string;
  agents: TeamMember[];
  use_cases?: string[];
  handoffs?: TeamHandoff[];
  sdlc_phases?: string[];
  max_context_agents?: number;
  dispatch?: 'parallel' | 'sequential' | 'consensus';
  overlap_resolution?: Record<string, string>;
}

// ── Provider Detection ───────────────────────────────────────

async function detectProvider(args: string[], cwd: string): Promise<string> {
  const providerFlag = parseFlag(args, '--provider');
  if (providerFlag) return normalizeProviderDefinitionId(providerFlag) ?? providerFlag;

  // Resolved through the same shared provider-resolution path `runtime-info`
  // and `steward capabilities` use (`resolveActiveProvider` -> the `claude`
  // provider's `detection.env` markers in provider-definitions.ts) so none
  // of them disagree about which provider the current session is running
  // under (#2623, #2627, #3054). The ad-hoc `CLAUDE_CODE_VERSION`/
  // `ANTHROPIC_API_KEY` check this replaced was stale (neither is set by
  // current Claude Code) and `ANTHROPIC_API_KEY` was a false positive for
  // any non-Claude session with that key set.
  // Only a session signal counts. Native team dispatch needs the command to
  // be running inside that harness; project configuration alone does not
  // establish that.
  const resolution = await resolveActiveProvider({ cwd });
  return isSessionProviderResolution(resolution) ? (resolution.provider ?? 'unknown') : 'unknown';
}

function isNativeTeamsProvider(provider: string): boolean {
  // Only Claude Code has native agent team support
  return provider === 'claude';
}

// ── Helpers ──────────────────────────────────────────────────

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    positional.push(args[i]);
  }
  return positional;
}

async function loadTeam(slug: string, frameworkRoot: string, cwd: string): Promise<TeamDefinition | null> {
  const searchPaths = [
    projectAiwgPath(cwd, 'teams', `${slug}.json`),
    join(frameworkRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'teams', `${slug}.json`),
  ];

  for (const path of searchPaths) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const team = JSON.parse(raw) as TeamDefinition;
      return { ...team, slug: team.slug || slug };
    } catch {
      // Try next location
    }
  }
  return null;
}

async function listAllTeams(frameworkRoot: string, cwd: string): Promise<TeamDefinition[]> {
  const teams: TeamDefinition[] = [];
  const seen = new Set<string>();

  const searchDirs = [
    projectAiwgPath(cwd, 'teams'),
    join(frameworkRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'teams'),
  ];

  for (const dir of searchDirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (entry.name === 'manifest.json' || entry.name === 'schema.json') continue;
        const slug = basename(entry.name, '.json');
        if (seen.has(slug)) continue;
        try {
          const raw = await fs.readFile(join(dir, entry.name), 'utf-8');
          const team = JSON.parse(raw) as TeamDefinition;
          teams.push({ ...team, slug: team.slug || slug });
          seen.add(slug);
        } catch {
          // Skip invalid team files
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return teams;
}

// ── Subcommand: run ──────────────────────────────────────────

/** Public OMP dispatch delegates to the same bounded native runtime used by conformance. */
async function teamRunOmp(ctx: HandlerContext): Promise<HandlerResult> {
  const allowed = new Set(['--provider', '--body-file', '--cwd', '--output-root', '--max-parallel', '--model', '--profile']);
  const values: Record<string, string> = {};
  for (let i = 0; i < ctx.args.length; i++) {
    const flag = ctx.args[i];
    if (flag === '--json') continue;
    if (!allowed.has(flag) || !ctx.args[i + 1] || ctx.args[i + 1].startsWith('--')) {
      ui.error('OMP usage: aiwg team run --provider omp --body-file tasks.json [--cwd DIR] [--output-root DIR] [--max-parallel N] [--model provider/model] [--profile NAME]');
      return { exitCode: 1 };
    }
    values[flag] = ctx.args[++i];
  }
  if (!values['--body-file']) {
    ui.error('OMP native team dispatch requires --body-file tasks.json with explicit task ownership and tools.');
    return { exitCode: 1 };
  }
  const maxParallel = values['--max-parallel'] === undefined ? 4 : Number(values['--max-parallel']);
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    ui.error('OMP --max-parallel must be a positive integer.');
    return { exitCode: 1 };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const payload = JSON.parse(await fs.readFile(resolve(ctx.cwd, values['--body-file']), 'utf8'));
    const { runOmpTeam } = await import(pathToFileURL(join(ctx.frameworkRoot, 'tools/providers/omp-teams.mjs')).href);
    const result = await runOmpTeam({
      tasks: payload.tasks,
      cwd: values['--cwd'] ? resolve(ctx.cwd, values['--cwd']) : ctx.cwd,
      outputDir: values['--output-root'] ? resolve(ctx.cwd, values['--output-root']) : undefined,
      maxParallel, model: values['--model'], profile: values['--profile'], signal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
    return { exitCode: result.results.every((task: { status: string }) => task.status === 'completed') ? 0 : 1 };
  } catch (error) {
    ui.error(error instanceof SyntaxError ? 'OMP task body is invalid JSON.' : error instanceof Error ? error.message : 'OMP team dispatch failed.');
    return { exitCode: 1 };
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

async function teamRun(ctx: HandlerContext): Promise<HandlerResult> {
  if (['omp', 'oh-my-pi'].includes(await detectProvider(ctx.args, ctx.cwd))) return teamRunOmp(ctx);
  const positional = getPositionalArgs(ctx.args);
  const slug = positional[0];

  if (!slug) {
    ui.error('Usage: aiwg team run <name> [--provider <p>] [--objective "<text>"]');
    return { exitCode: 1 };
  }

  const provider = await detectProvider(ctx.args, ctx.cwd);
  const objective = parseFlag(ctx.args, '--objective') || `Execute ${slug} team workflow`;

  const team = await loadTeam(slug, ctx.frameworkRoot, ctx.cwd);
  if (!team) {
    ui.error(`Team not found: ${slug}`);
    ui.info('Run `aiwg team list` to see available teams.');
    return { exitCode: 1 };
  }

  const dispatchMode = team.dispatch || 'sequential';

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Team')} — ${ui.accent(team.name)}`);
  ui.rule();
  console.log(`  ${ui.dimText('Provider:')} ${provider}`);
  console.log(`  ${ui.dimText('Dispatch:')} ${dispatchMode}`);
  console.log(`  ${ui.dimText('Agents:')}   ${team.agents.map(a => a.agent).join(', ')}`);
  ui.blank();

  if (isNativeTeamsProvider(provider)) {
    // Claude Code: delegate to native agent teams
    console.log(`  ${ui.bold('Native team dispatch (Claude Code)')}:`);
    ui.blank();
    console.log(`  Invoke team members using @agent-name syntax:`);
    ui.blank();
    for (const member of team.agents) {
      const roleIcon = member.role === 'lead' ? '★' : member.role === 'reviewer' ? '◎' : member.role === 'advisor' ? '◇' : '○';
      console.log(`    ${roleIcon} @${member.agent}  ${ui.dimText('[' + member.role + ']')}`);
      if (member.responsibilities && member.responsibilities.length > 0) {
        console.log(`        ${ui.dimText(member.responsibilities[0])}`);
      }
    }
    ui.blank();
    if (dispatchMode === 'parallel') {
      console.log(`  ${ui.dimText('Tip:')} Launch all agents in a single message for parallel execution.`);
    }
  } else {
    // Other providers: emulate via aiwg mc
    console.log(`  ${ui.bold('Team dispatch via Mission Control (aiwg mc)')}:`);
    ui.blank();

    const lead = team.agents.find(a => a.role === 'lead') || team.agents[0];
    const others = team.agents.filter(a => a.agent !== lead.agent);

    console.log(`  ${ui.dimText('# Step 1: Start a session')}`);
    console.log(`  aiwg mc start --name "${team.name}"`);
    ui.blank();
    console.log(`  ${ui.dimText('# Step 2: Dispatch agents')}`);
    console.log(`  aiwg mc dispatch <session-id> "Run ${lead.agent}: ${objective}" --completion "${lead.agent} deliverables complete"`);
    for (const member of others) {
      console.log(`  aiwg mc dispatch <session-id> "Run ${member.agent}: ${objective}" --completion "${member.agent} review complete"`);
    }
    ui.blank();
    console.log(`  ${ui.dimText('# Step 3: Monitor')}`);
    console.log(`  aiwg mc watch`);
    ui.blank();
    ui.info(`Provider '${provider}' uses aiwg mc emulation (no native team support).`);
  }

  return { exitCode: 0 };
}

// ── Subcommand: list ─────────────────────────────────────────

async function teamList(ctx: HandlerContext): Promise<HandlerResult> {
  const json = hasFlag(ctx.args, '--json');
  const provider = await detectProvider(ctx.args, ctx.cwd);
  const teams = await listAllTeams(ctx.frameworkRoot, ctx.cwd);

  if (json) {
    console.log(JSON.stringify(teams.map(t => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      agents: t.agents.map(a => a.agent),
      dispatch: t.dispatch || 'sequential',
      sdlc_phases: t.sdlc_phases || [],
    })), null, 2));
    return { exitCode: 0 };
  }

  if (teams.length === 0) {
    ui.info('No teams found. Deploy the sdlc-complete framework with: aiwg use sdlc');
    return { exitCode: 0 };
  }

  const backend = ['omp', 'oh-my-pi'].includes(provider) ? 'native (Oh My Pi)' : isNativeTeamsProvider(provider)
    ? 'native (Claude Code)'
    : `aiwg mc emulation (${provider})`;

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Available Teams')}`);
  ui.rule();
  console.log(`  ${ui.dimText('Team backend:')} ${backend}`);
  ui.blank();

  const header = `  ${'Team'.padEnd(24)} ${'Agents'.padEnd(8)} ${'Dispatch'.padEnd(12)} Description`;
  console.log(header);
  ui.rule(70);

  for (const team of teams) {
    const slug = (team.slug || '').padEnd(24);
    const agentCount = String(team.agents.length).padEnd(8);
    const dispatch = (team.dispatch || 'sequential').padEnd(12);
    console.log(`  ${slug} ${agentCount} ${dispatch} ${team.description}`);
  }

  ui.blank();
  console.log(`  ${ui.dimText('Run:')} aiwg team run <name>   ${ui.dimText('|')}   aiwg team info <name>`);
  ui.blank();

  return { exitCode: 0 };
}

// ── Subcommand: info ─────────────────────────────────────────

async function teamInfo(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const slug = positional[0];
  const json = hasFlag(ctx.args, '--json');

  if (!slug) {
    ui.error('Usage: aiwg team info <name> [--json]');
    return { exitCode: 1 };
  }

  const team = await loadTeam(slug, ctx.frameworkRoot, ctx.cwd);
  if (!team) {
    ui.error(`Team not found: ${slug}`);
    ui.info('Run `aiwg team list` to see available teams.');
    return { exitCode: 1 };
  }

  if (json) {
    console.log(JSON.stringify(team, null, 2));
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold(team.name)}`);
  ui.rule();
  console.log(`  ${ui.dimText('Slug:')}     ${team.slug}`);
  console.log(`  ${ui.dimText('Dispatch:')} ${team.dispatch || 'sequential'}`);
  console.log(`  ${ui.dimText('Phases:')}   ${(team.sdlc_phases || []).join(', ') || 'all'}`);
  ui.blank();

  console.log(`  ${ui.bold('Description')}`);
  console.log(`  ${team.description}`);
  ui.blank();

  console.log(`  ${ui.bold('Agents')}`);
  for (const member of team.agents) {
    const roleIcon =
      member.role === 'lead' ? '★' :
      member.role === 'reviewer' ? '◎' :
      member.role === 'advisor' ? '◇' : '○';
    console.log(`  ${roleIcon} ${member.agent.padEnd(30)} ${ui.dimText('[' + member.role + ']')}`);
    if (member.responsibilities) {
      for (const r of member.responsibilities) {
        console.log(`      ${ui.dimText('•')} ${r}`);
      }
    }
  }

  if (team.use_cases && team.use_cases.length > 0) {
    ui.blank();
    console.log(`  ${ui.bold('Use Cases')}`);
    for (const uc of team.use_cases) {
      console.log(`  ${ui.dimText('•')} ${uc}`);
    }
  }

  if (team.handoffs && team.handoffs.length > 0) {
    ui.blank();
    console.log(`  ${ui.bold('Handoffs')}`);
    for (const h of team.handoffs) {
      console.log(`  ${h.from} → ${h.to}`);
      console.log(`      ${ui.dimText('Artifact:')} ${h.artifact}`);
      console.log(`      ${ui.dimText('Gate:')}     ${h.gate}`);
    }
  }

  ui.blank();
  return { exitCode: 0 };
}

// ── Help ─────────────────────────────────────────────────────

function showTeamHelp(): void {
  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Agent Teams')} — multi-agent team orchestration across all providers`);
  ui.rule();
  console.log(`
  ${ui.bold('Usage:')} aiwg team <subcommand> [options]

  ${ui.bold('Subcommands:')}
    run <name>             Run a declared team (Claude native guidance or aiwg mc)
    run --provider omp --body-file tasks.json   Execute bounded native OMP tasks
    list                   List available teams
    info <name>            Show team definition and agent roster

  ${ui.bold('Options:')}
    --provider <p>         Override provider: antigravity|agy|claude|warp|copilot|cursor|devin|opencode|factory|codex|openclaw|omp|oh-my-pi
    --objective "<text>"   Set objective passed to mc dispatch agents
    --body-file <file>    OMP task JSON with explicit ownership and tools
    --cwd <dir>          OMP working directory (defaults to current workspace)
    --output-root <dir>  OMP result and control artifact directory
    --max-parallel <n>   OMP requested worker cap (workspace ceiling still applies)
    --model <id>         OMP coordinator/worker model selector
    --profile <name>     OMP native profile
    --json                 Machine-readable output

  ${ui.bold('Provider Routing:')}
    Claude Code            Native agent team dispatch (@agent-name invocation)
    Oh My Pi               Bounded native task execution from --body-file
    All others             aiwg mc emulation (Mission Control sequential/parallel dispatch)

  ${ui.bold('Examples:')}
    aiwg team run sdlc-review
    aiwg team run --provider omp --body-file tasks.json
    aiwg team run sdlc-review --provider cursor --objective "Phase gate review"
    aiwg team run security-review --objective "Pre-release audit"
    aiwg team list
    aiwg team list --json
    aiwg team info sdlc-review
`);
}

// ── Subcommand router ─────────────────────────────────────────

const subcommands: Record<string, (ctx: HandlerContext) => Promise<HandlerResult>> = {
  run: teamRun,
  list: teamList,
  info: teamInfo,
};

// ── Exported handler ──────────────────────────────────────────

export const teamHandler: CommandHandler = {
  id: 'team',
  name: 'Agent Teams',
  description: 'Multi-agent team orchestration across all providers (run, list, info)',
  category: 'orchestration',
  aliases: ['teams'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      showTeamHelp();
      return { exitCode: 0 };
    }

    const handler = subcommands[subcmd];
    if (!handler) {
      ui.error(`Unknown subcommand: ${subcmd}. Run 'aiwg team --help' for usage.`);
      return { exitCode: 1 };
    }

    const subCtx: HandlerContext = {
      ...ctx,
      args: ctx.args.slice(1),
    };

    return handler(subCtx);
  },
};

/**
 * All team-related handlers for bulk registration
 */
export const teamHandlers: CommandHandler[] = [teamHandler];
