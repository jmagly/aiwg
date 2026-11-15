/**
 * Best-Practices Audit Handler
 *
 * Launches `/best-practices-audit` — a research-grounded validation of a
 * target (file, directory, or topic) against current external best practices
 * with citation guardrails. The actual research is performed by the agent
 * following the slash command skill in research-complete; this handler is
 * a thin shim that parses flags, validates the target, computes the output
 * path, and either spawns the configured provider or prints guidance for
 * IDE-integrated providers.
 *
 * Pattern matches src/cli/handlers/sdlc-accelerate.ts — same agent-spawn
 * conventions, same provider gating, same --params / --dangerous handling.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #943
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { projectAiwgPath } from '../../config/project-artifacts.js';
import {
  parseAgentSpawnFlags,
  buildAgentArgs,
  getProviderConfig,
  isSpawnableProvider,
  dangerousWarning,
  spawnableProviders,
} from '../agent-spawn.js';

/**
 * Audit-specific flags. These are not consumed by the spawn machinery —
 * they're forwarded verbatim to the slash command so the agent skill can
 * apply them. The handler validates a few but does not interpret most;
 * focus area names and standard names are open vocabularies.
 */
interface AuditOpts {
  focus?: string;
  framework?: string;
  standard?: string;
  recency?: string;
  depth?: 'quick' | 'standard' | 'deep';
  sources?: string;
  exclude?: string;
  citeThreshold?: number;
  dissent?: boolean;
  validateMode?: boolean;
  output?: string;
}

/**
 * Best-practices audit positional + flag parser. Distinct from
 * `parseAgentSpawnFlags` because most of the flags are forwarded to the
 * skill. We extract only the ones we need to validate locally; the rest
 * survive in `remaining` and get appended to the slash-command prompt.
 */
function parseAuditFlags(args: string[]): { audit: AuditOpts; rest: string[] } {
  const audit: AuditOpts = {};
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string | undefined => args[++i];

    switch (a) {
      case '--focus':
        audit.focus = next();
        rest.push(a, audit.focus ?? '');
        break;
      case '--framework':
        audit.framework = next();
        rest.push(a, audit.framework ?? '');
        break;
      case '--standard':
        audit.standard = next();
        rest.push(a, audit.standard ?? '');
        break;
      case '--recency':
        audit.recency = next();
        rest.push(a, audit.recency ?? '');
        break;
      case '--depth': {
        const v = next();
        if (v && (v === 'quick' || v === 'standard' || v === 'deep')) {
          audit.depth = v;
        }
        rest.push(a, v ?? '');
        break;
      }
      case '--sources':
        audit.sources = next();
        rest.push(a, audit.sources ?? '');
        break;
      case '--exclude':
        audit.exclude = next();
        rest.push(a, audit.exclude ?? '');
        break;
      case '--cite-threshold': {
        const v = next();
        const n = v ? Number(v) : NaN;
        if (Number.isInteger(n) && n > 0) audit.citeThreshold = n;
        rest.push(a, v ?? '');
        break;
      }
      case '--dissent':
        audit.dissent = true;
        rest.push(a);
        break;
      case '--validate':
        audit.validateMode = true;
        rest.push(a);
        break;
      case '--output':
        audit.output = next();
        // Don't forward --output to the slash command; the handler
        // computes/normalizes the absolute output path separately.
        break;
      default:
        rest.push(a);
    }
  }

  return { audit, rest };
}

/**
 * Compute the default output path. Naming convention from #929 §5:
 *
 *   .aiwg/reports/best-practices-audit-<target-slug>-<YYYY-MM-DD>.md
 *
 * The slug is derived from a path basename, freeform topic words, or 'audit'
 * if neither produces something usable.
 */
function computeOutputPath(target: string, override: string | undefined, projectRoot: string): string {
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
  }

  const date = new Date().toISOString().slice(0, 10);

  const slugSource = existsSync(target) ? path.basename(target).replace(/\.[^.]+$/, '') : target;
  const slug =
    slugSource
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'audit';

  return projectAiwgPath(projectRoot, 'reports', `best-practices-audit-${slug}-${date}.md`);
}

export class BestPracticesAuditHandler implements CommandHandler {
  id = 'best-practices-audit';
  name = 'Best-Practices Audit';
  description = 'Research-grounded validation of a target against current external best practices';
  category = 'orchestration' as const;
  aliases = ['best-practices-audit'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
      return { exitCode: 0, message: this.getHelpText() };
    }

    // Spawn flags peeled first (--provider, --dangerous, --params).
    const { opts: spawnOpts, remaining } = parseAgentSpawnFlags(ctx.args);

    // Audit-specific flags peeled next; the rest carries the target +
    // forwarded flags into the slash-command prompt.
    const { audit, rest } = parseAuditFlags(remaining);

    // Target must be the first positional argument. Without one, this is
    // a usage error — the audit command requires a target.
    const positionals = rest.filter(a => !a.startsWith('-'));
    if (positionals.length === 0) {
      return {
        exitCode: 1,
        message:
          'best-practices-audit: missing <target>. Pass a file path, directory, or freeform topic.\n' +
          'Run: aiwg best-practices-audit --help',
      };
    }

    const target = positionals[0];
    const outputPath = computeOutputPath(target, audit.output, ctx.cwd ?? process.cwd());

    const provider = spawnOpts.provider ?? 'claude';
    const config = getProviderConfig(provider);

    const prompt = this.buildPrompt(target, rest, outputPath);

    if (!isSpawnableProvider(provider)) {
      return {
        exitCode: 0,
        message: [
          `Provider '${config.name}' is not spawnable from the CLI.`,
          config.guidanceMessage ?? '',
          '',
          `Run this in your IDE or agent panel:`,
          `  ${prompt}`,
          '',
          `Output will be written to: ${outputPath}`,
        ].join('\n'),
      };
    }

    const warn = dangerousWarning(provider);
    if (spawnOpts.dangerous && warn) {
      console.warn(`Warning: ${warn}`);
    }

    const agentArgs = buildAgentArgs(prompt, spawnOpts);
    return this.spawnAgent(config.binary!, agentArgs, prompt, outputPath);
  }

  /**
   * Compose the slash-command invocation. The agent skill receives the
   * target and forwarded flags verbatim, plus an explicit `--output`
   * pointing at the absolute output path so the skill writes to the
   * handler-computed location regardless of how it interprets cwd.
   */
  private buildPrompt(target: string, rest: string[], outputPath: string): string {
    const flagsAfterTarget = rest.slice(rest.indexOf(target) + 1).join(' ');
    const targetStr = target.includes(' ') ? `"${target}"` : target;
    const flagsPart = flagsAfterTarget ? ` ${flagsAfterTarget}` : '';
    return `/best-practices-audit ${targetStr}${flagsPart} --output "${outputPath}"`;
  }

  private spawnAgent(
    binary: string,
    args: string[],
    prompt: string,
    outputPath: string
  ): Promise<HandlerResult> {
    return new Promise<HandlerResult>(resolve => {
      try {
        const child = spawn(binary, args, { stdio: 'inherit', env: process.env });
        child.on('close', code => resolve({ exitCode: code ?? 0 }));
        child.on('error', err => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              exitCode: 1,
              message: this.getNotFoundMessage(binary, prompt, outputPath),
            });
          } else {
            resolve({
              exitCode: 1,
              message: `Failed to launch ${binary}: ${err.message}\n\n${this.getNotFoundMessage(binary, prompt, outputPath)}`,
              error: err,
            });
          }
        });
      } catch (err) {
        resolve({
          exitCode: 1,
          message: `Failed to start best-practices-audit: ${err instanceof Error ? err.message : String(err)}\n\n${this.getNotFoundMessage(binary, prompt, outputPath)}`,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });
  }

  private getNotFoundMessage(binary: string, prompt: string, outputPath: string): string {
    return [
      `'${binary}' not found. Install the provider CLI and try again.`,
      `To run manually, open the agent and run:`,
      `  ${prompt}`,
      ``,
      `Output will be written to: ${outputPath}`,
    ].join('\n');
  }

  private getHelpText(): string {
    const spawnable = spawnableProviders().join(', ');
    return `
Best-Practices Audit — Research-grounded validation against current practice

USAGE:
  aiwg best-practices-audit <target> [options]
  aiwg best-practices-audit ".aiwg/architecture/SAD.md" --focus security
  aiwg best-practices-audit "FastAPI dependency injection" --depth deep

ARGUMENTS:
  <target>                File path, directory, freeform topic, or issue ref

FOCUS / SCOPE:
  --focus <area>          security, performance, accessibility, licensing,
                          api-design, testing, docs, ops, compliance, ...
  --framework <name>      Bias toward a named stack (React, Kubernetes, ...)
  --standard <name>       Align to a standard (OWASP, SOC2, WCAG 2.2, ...)

RESEARCH BUDGET:
  --recency <window>      Default 18m. Tighten for fast-moving domains.
  --depth quick|standard|deep   Research effort budget (default: standard)
  --sources <list>        Restrict to: vendor-docs, standards-bodies,
                          practitioner-blogs, conference-talks, academic,
                          github-discussions
  --exclude <list>        e.g. exclude SEO-spam domains
  --cite-threshold <N>    Minimum distinct sources before a finding is reported (default: 2)

REPORTING:
  --dissent               Surface practitioner disagreement, not just consensus
  --validate              Re-validate existing claims in the target rather than
                          generating new ones
  --output <path>         Default: .aiwg/reports/best-practices-audit-<slug>-<date>.md

AGENT OPTIONS:
  --provider <name>       Agent system to use (default: claude)
                          Spawnable: ${spawnable}
                          IDE-integrated (guidance only): copilot, cursor, factory, warp, windsurf
  --dangerous             Enable unrestricted mode (passes provider's native flag).
  --params "<args>"       Pass arbitrary args verbatim to the agent binary.

ANTI-HALLUCINATION GUARDRAILS:
  - No fabricated citations, DOIs, URLs, or quotes (Citation Policy enforced).
  - Findings need >= --cite-threshold distinct, retrievable sources or are
    downgraded.
  - Conflicting sources surface as labeled disagreements, not silent picks.
  - Sparse-signal honesty: confidence is downgraded rather than filled with priors.

EXAMPLES:
  aiwg best-practices-audit ".aiwg/architecture/SAD.md"
  aiwg best-practices-audit ".aiwg/architecture/SAD.md" --focus security --standard OWASP
  aiwg best-practices-audit "src/auth/" --focus security --depth deep --dissent
  aiwg best-practices-audit "FastAPI request validation patterns" --recency 6m
  aiwg best-practices-audit ".aiwg/architecture/" --validate
`;
  }
}

export const bestPracticesAuditHandler = new BestPracticesAuditHandler();

/**
 * Internal exports for testing only. Not part of the public CLI surface.
 */
export const __test__ = { parseAuditFlags, computeOutputPath };
