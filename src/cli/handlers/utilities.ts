/**
 * Utility Command Handlers
 *
 * Handlers for utility commands including card prefilling, contribution workflow,
 * metadata validation, health diagnostics, and update checking.
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @source @src/cli/router.ts
 * @tests @test/unit/cli/handlers/utilities.test.ts
 * @issue #33, #342
 */

import fs from 'fs';
import path from 'path';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { doctorHandler } from './utility-doctor.js';
import { updateHandler } from './update.js';
export { doctorHandler, updateHandler };

/**
 * Handler for prefill-cards command
 *
 * Prefills kanban cards with template data for project planning.
 *
 * Usage:
 *   aiwg -prefill-cards
 *   aiwg --prefill-cards
 *   aiwg -prefill-cards --board <board-name>
 */
export const prefillCardsHandler: CommandHandler = {
  id: 'prefill-cards',
  name: 'Prefill Cards',
  description: 'Prefill kanban cards with template data',
  category: 'utility',
  aliases: ['-prefill-cards', '--prefill-cards'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run('tools/cards/prefill-cards.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Handler for contribute-start command
 *
 * Starts a contribution workflow with issue tracking and branching.
 *
 * Usage:
 *   aiwg -contribute-start
 *   aiwg --contribute-start
 *   aiwg -contribute-start --issue <issue-number>
 */
export const contributeStartHandler: CommandHandler = {
  id: 'contribute-start',
  name: 'Start Contribution',
  description: 'Start a contribution workflow',
  category: 'utility',
  aliases: ['-contribute-start', '--contribute-start'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run('tools/contrib/start-contribution.mjs', ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Handler for validate-metadata command
 *
 * Validates metadata across framework components and artifacts.
 *
 * Usage:
 *   aiwg validate-metadata
 *   aiwg validate-metadata --strict
 *   aiwg validate-metadata --recursive agentic/code/frameworks/security-engineering/skills
 */
/** Namespace field regex for SKILL.md frontmatter */
const NAMESPACE_RE = /^namespace:\s*(\S+)/m;

/** Description field regex (single-line + multi-line `>` and `|` block scalars) */
const DESCRIPTION_RE = /^description:\s*([>|]?)\s*\n?([\s\S]*?)(?=\n\w+:|\n---|$)/m;

/**
 * Count complete sentences in a description string. A sentence is delimited
 * by `.`, `?`, or `!` followed by whitespace or end-of-string.
 *
 * Per the oz-skills two-sentence discipline (PUW-030 / #1131): skills
 * should describe themselves in 1-2 sentences. Longer descriptions are
 * generally a sign that the skill is doing too much (god-session) or that
 * detail belongs in the body, not the frontmatter. Lint-only — does not
 * block deploy.
 */
function countSentences(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  const matches = trimmed.match(/[.!?]+(?:\s|$)/g);
  if (!matches) return 1; // No terminator — treat as one bare sentence
  // Trailing terminator counted; if no trailing terminator, the unterminated
  // text is also a sentence.
  const endsWithTerminator = /[.!?][)\]"'\s]*$/.test(trimmed);
  return matches.length + (endsWithTerminator ? 0 : 1);
}

/**
 * Scan canonical AIWG source SKILL.md files in `agentic/code/` for policy issues:
 * - Missing the AIWG-only `namespace: aiwg` source convention
 * - Slug (`aiwg-{name}`) that would shadow an AIWG CLI command
 *
 * Returns lines suitable for console output, or empty array if clean.
 */
async function scanSourceNamespaceIssues(frameworkRoot: string): Promise<string[]> {
  const issues: string[] = [];
  const sourceRoot = path.join(frameworkRoot, 'agentic/code');

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name === 'SKILL.md') {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const nsMatch = content.match(NAMESPACE_RE);
          if (!nsMatch) {
            const rel = path.relative(frameworkRoot, full);
            issues.push(`  WARN  missing namespace field: ${rel}`);
          }
          // PUW-030 (#1131) — two-sentence skill description discipline.
          // Lint-only. We extract the description block (handles single-line
          // and YAML block scalars) and count sentence terminators.
          const fmEnd = content.indexOf('\n---', 4);
          const fm = fmEnd > 0 ? content.slice(0, fmEnd) : content;
          const descMatch = fm.match(DESCRIPTION_RE);
          if (descMatch) {
            const desc = (descMatch[2] || '').trim().replace(/\n+/g, ' ');
            const sentenceCount = countSentences(desc);
            if (sentenceCount > 3) {
              const rel = path.relative(frameworkRoot, full);
              issues.push(`  WARN  description too long (${sentenceCount} sentences; oz-skills convention is 1-2): ${rel}`);
            }
          }
        } catch {
          // unreadable
        }
      }
    }
  }

  await walk(sourceRoot);
  return issues;
}

/**
 * Scan every `<framework>/<kind>/contributor.md` under `agentic/code/` and
 * validate its frontmatter against the registered schema for its kind.
 * Returns a list of human-readable issue lines for output, plus a count of
 * problems found. Per ADR-023 §Schema validation, malformed contributors
 * fail strict validation.
 */
async function scanContributorIssues(
  frameworkRoot: string
): Promise<{ lines: string[]; count: number }> {
  // Lazy-imported so the validate-metadata path stays fast when there are
  // no contributors yet; also avoids an upfront dep load when zod is unused.
  const [{ parseFrontmatter }, { validateContributor, getRegisteredKinds }] = await Promise.all([
    import('../../artifacts/index-builder.js'),
    import('../../contributors/validation.js'),
  ]);

  const kinds = new Set(getRegisteredKinds());
  const sourceRoot = path.join(frameworkRoot, 'agentic/code');
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name === 'contributor.md') {
        // Only validate if the parent directory name is a registered kind.
        // Avoids treating unrelated files named `contributor.md` as contributors.
        const parent = path.basename(path.dirname(full));
        if (!kinds.has(parent)) continue;

        try {
          const content = fs.readFileSync(full, 'utf-8');
          const { data } = parseFrontmatter(content);
          const validation = validateContributor(data);
          if (!validation.ok) {
            const rel = path.relative(frameworkRoot, full);
            lines.push(`  ERROR  ${rel}`);
            for (const err of validation.errors) {
              lines.push(`         ${err}`);
            }
            count++;
          }
        } catch (err) {
          const rel = path.relative(frameworkRoot, full);
          lines.push(`  ERROR  ${rel}: ${(err as Error).message}`);
          count++;
        }
      }
    }
  }

  await walk(sourceRoot);
  return { lines, count };
}

export const validateMetadataHandler: CommandHandler = {
  id: 'validate-metadata',
  name: 'Validate Metadata',
  description: 'Validate metadata across components',
  category: 'utility',
  aliases: ['-validate-metadata', '--validate-metadata'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);
    const hasPathArg = ctx.args.some(arg => !arg.startsWith('-'));
    const wantsHelp = ctx.args.includes('--help') || ctx.args.includes('-h');
    const scriptArgs = wantsHelp || hasPathArg
      ? ctx.args
      : ['--recursive', 'agentic/code'];

    // Run the core metadata validation script
    const result = await runner.run('tools/cli/validate-metadata.mjs', scriptArgs, {
      cwd: ctx.cwd,
    });

    // Append canonical AIWG source policy. `namespace` is an AIWG extension,
    // not an Agent Skills standard requirement; shared conformance is emitted
    // by validate-metadata.mjs before this source-only convention.
    try {
      const issues = await scanSourceNamespaceIssues(frameworkRoot);
      if (issues.length > 0) {
        console.log('\n── AIWG source conventions ──');
        console.log(`  ${issues.length} canonical source convention issue(s):`);
        // Show first 20 to avoid flooding output
        issues.slice(0, 20).forEach(l => console.log(l));
        if (issues.length > 20) {
          console.log(`  ... and ${issues.length - 20} more`);
        }
        // Non-zero exit only in strict mode
        if (ctx.args.includes('--strict') && result.exitCode === 0) {
          return { exitCode: 1, message: `AIWG source convention validation failed: ${issues.length} issue(s)` };
        }
      } else {
        console.log('\n── AIWG source conventions: all canonical skills include the AIWG namespace extension ✓');
      }
    } catch {
      // Namespace scan is non-fatal
    }

    // Append contributor validation: walk source contributor.md files and
    // validate their frontmatter against the kind's zod schema (ADR-023).
    try {
      const { lines, count } = await scanContributorIssues(frameworkRoot);
      if (count > 0) {
        console.log('\n── Contributor validation ──');
        console.log(`  ${count} contributor file(s) failed schema validation:`);
        lines.slice(0, 40).forEach(l => console.log(l));
        if (lines.length > 40) {
          console.log(`  ... and ${lines.length - 40} more lines`);
        }
        // Strict mode escalates to a non-zero exit so CI catches drift.
        if (ctx.args.includes('--strict') && result.exitCode === 0) {
          return {
            exitCode: 1,
            message: `Contributor validation failed: ${count} file(s) violated schema`,
          };
        }
      } else {
        console.log('\n── Contributor validation: all contributor.md files conform to schema ✓');
      }
    } catch {
      // Contributor scan is non-fatal — never break validate-metadata if zod
      // import or filesystem walk hits an unexpected condition.
    }

    return result;
  },
};

const CONTEXT_FIREWALL_HELP = `aiwg context-firewall — inspect provider context and reviewed memory

Usage:
  aiwg context-firewall [scan] [options]
  aiwg context-firewall baseline [--plan]
  aiwg context-firewall baseline --write --confirm-reviewed [--output <path>]

Actions:
  scan       Read-only inventory, trust, poisoning, drift, and budget checks (default)
  baseline   Plan or explicitly write the reviewed digest baseline

Options:
  --root <path>           Project root (default: current directory)
  --provider <name>       Limit to a provider; repeatable
  --baseline <path>       Existing reviewed baseline used by the scan
  --output <path>         Baseline destination (must remain within the project)
  --budget-tokens <n>     Portable provider-context budget
  --warn-ratio <n>        Warning threshold as a fraction of the budget
  --strict                Exit non-zero for violations or a missing baseline
  --json                  Emit stable machine-readable output
  --limit <n>             Bound scan detail in human-readable output
  --no-content-scan       Skip poisoning classification
  --plan                  Show every record; do not write (baseline default)
  --write                 Write after review; requires --confirm-reviewed
  --confirm-reviewed      Confirm every record in the plan was reviewed
`;

function contextFirewallError(message: string): HandlerResult {
  return { exitCode: 2, message: `${message}\n\n${CONTEXT_FIREWALL_HELP}` };
}

/**
 * Public operator route for the context/memory firewall.
 *
 * The implementation remains a reusable packaged engine, while this handler
 * owns stable command vocabulary and keeps internal script entrypoints out of
 * user- and agent-facing remediation guidance.
 */
export const contextFirewallHandler: CommandHandler = {
  id: 'context-firewall',
  name: 'Context Firewall',
  description: 'Audit provider context and manage its reviewed baseline',
  category: 'maintenance',
  aliases: ['-context-firewall', '--context-firewall'],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: CONTEXT_FIREWALL_HELP, rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
      return { exitCode: 0, message: CONTEXT_FIREWALL_HELP };
    }

    const action = ctx.args[0] && !ctx.args[0].startsWith('-') ? ctx.args[0] : 'scan';
    if (!['scan', 'baseline'].includes(action)) {
      return contextFirewallError(`Unknown context-firewall action '${action}'.`);
    }

    const input = action === 'scan' ? ctx.args.slice(action === ctx.args[0] ? 1 : 0) : ctx.args.slice(1);
    const forwarded: string[] = ['--package-root', ctx.frameworkRoot];
    let output: string | undefined;
    let plan = false;
    let write = false;
    let confirmed = false;

    for (let index = 0; index < input.length; index += 1) {
      const arg = input[index];
      if (arg === '--output') {
        output = input[index + 1];
        if (!output) return contextFirewallError('--output requires a path.');
        index += 1;
      } else if (arg.startsWith('--output=')) {
        output = arg.slice('--output='.length);
        if (!output) return contextFirewallError('--output requires a path.');
      } else if (arg === '--plan') {
        plan = true;
      } else if (arg === '--write') {
        write = true;
      } else if (arg === '--confirm-reviewed') {
        confirmed = true;
      } else {
        forwarded.push(arg);
      }
    }

    if (action === 'scan' && (output || plan || write || confirmed)) {
      return contextFirewallError('Baseline mutation options require the `baseline` action.');
    }
    if (plan && write) return contextFirewallError('Choose either --plan or --write, not both.');
    if (write && !confirmed) {
      return contextFirewallError('Baseline writes require --confirm-reviewed after inspecting the plan.');
    }
    if (confirmed && !write) {
      return contextFirewallError('--confirm-reviewed is only valid with --write.');
    }

    if (action === 'baseline') {
      if (write) {
        forwarded.push(output ? `--write-baseline=${output}` : '--write-baseline', '--confirm-reviewed');
      } else {
        forwarded.push(output ? `--plan-baseline=${output}` : '--plan-baseline');
      }
    }

    const runner = createScriptRunner(ctx.frameworkRoot);
    return runner.run('tools/security/context-memory-firewall.mjs', forwarded, { cwd: ctx.cwd });
  },
};

/**
 * All utility handlers
 */
export const utilityHandlers: CommandHandler[] = [
  prefillCardsHandler,
  contributeStartHandler,
  validateMetadataHandler,
  doctorHandler,
  contextFirewallHandler,
  updateHandler,
];
