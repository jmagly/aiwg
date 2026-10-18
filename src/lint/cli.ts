/**
 * Lint CLI Entry Point
 *
 * Parses CLI arguments and dispatches to the lint runner.
 *
 * Usage:
 *   aiwg lint .aiwg/research/
 *   aiwg lint .aiwg/research/ --ruleset research
 *   aiwg lint --list-rulesets
 *   aiwg lint --list-rules research
 *   aiwg lint .aiwg/ --format json --ci --fail-on warn
 *
 * @issue #810
 */

import fs from 'fs';
import { readAiwgConfigCandidate } from '../config/aiwg-config.js';
import type { InlineBudgetOptions } from '../rules/inline-budget.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverRulesets } from './loader.js';
import { autoDetectRulesets, runLint } from './runner.js';
import { formatResult, formatRulesetList, formatRuleList } from './reporters.js';
import type { LintOptions, LintOutputFormat, LintSeverity } from './types.js';

/**
 * Resolve the AIWG install root — the directory containing `agentic/code/frameworks/`.
 * Walks up from the running script's location so it works at any compiled depth
 * (dev source vs `dist/src/lint/` vs an npm install path) without per-location math.
 * Honors `AIWG_ROOT` env override first. Fixes #1515 (lint couldn't find rulesets
 * when run outside the AIWG repo).
 *
 * Both markers (`agentic/code/frameworks/` AND `package.json`) must be present at
 * the same level — that excludes stale `dist/agentic/` partials from prior builds
 * (which exist without a sibling `package.json`).
 */
function findAiwgRoot(): string {
  if (process.env.AIWG_ROOT) return process.env.AIWG_ROOT;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, 'agentic', 'code', 'frameworks')) &&
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd(); // last-resort fallback
}

const AIWG_ROOT = findAiwgRoot();

/**
 * Parse CLI arguments into LintOptions
 */
function parseArgs(args: string[]): LintOptions {
  const options: LintOptions = {
    target: '',
    recursive: true,
    format: 'full',
    ci: false,
    failOn: 'error',
    dryRun: false,
    listRulesets: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--list-rulesets') {
      options.listRulesets = true;
    } else if (arg === '--list-rules' && i + 1 < args.length) {
      options.listRules = args[++i];
    } else if (arg === '--ruleset' && i + 1 < args.length) {
      options.rulesets = args[++i].split(',').map(s => s.trim());
    } else if (arg === '--format' && i + 1 < args.length) {
      options.format = args[++i] as LintOutputFormat;
    } else if (arg === '--startup-plan' && i + 1 < args.length) {
      options.startupPlan = args[++i];
    } else if (arg === '--ci') {
      options.ci = true;
    } else if (arg === '--allow-empty') {
      options.allowEmpty = true;
    } else if (arg === '--fail-on' && i + 1 < args.length) {
      options.failOn = args[++i] as LintSeverity;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--recursive' || arg === '-r') {
      options.recursive = true;
    } else if (arg === '--no-recursive') {
      options.recursive = false;
    } else if (arg === '--no-gitignore') {
      options.respectGitignore = false;
    } else if (!arg.startsWith('-') && !options.target) {
      options.target = arg;
    }

    i++;
  }

  return options;
}

/**
 * Main lint CLI entry point
 */
export async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const cwd = process.cwd();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg lint <target> [--ruleset <name>] [--format full|summary|json] [--ci] [--allow-empty] [--fail-on error|warn|info] [--no-gitignore]');
    console.log('  --ci           Fail on lint violations, zero files checked or zero rules applied');
    console.log('  --allow-empty  Allow zero files or zero applied rules under --ci');
    console.log('  --startup-plan <json>  Guard a complete projected startup set { provider, files: [{ path, bytes | content }] }');
    console.log('  --list-rulesets | --list-rules <ruleset>');
    return;
  }

  // Discover available rulesets. `cwd` is where the user runs the lint (used
  // to find deployed `.aiwg/frameworks/*/lint/` overlays); `AIWG_ROOT` is the
  // AIWG install (used to find shipped `agentic/code/frameworks/*/lint/`).
  // Prior to #1515 this hardcoded both to `cwd`, which only worked inside the
  // AIWG repo itself — user projects got an empty "Available:" list.
  const allRulesets = await discoverRulesets(cwd, AIWG_ROOT);

  // Handle --list-rulesets
  if (options.listRulesets) {
    console.log(formatRulesetList(allRulesets));
    return;
  }

  // Handle --list-rules
  if (options.listRules) {
    const ruleset = allRulesets.find(
      r => r.id === options.listRules || r.framework === options.listRules
    );
    if (!ruleset) {
      console.error(`Ruleset '${options.listRules}' not found. Run 'aiwg lint --list-rulesets' to see available sets.`);
      process.exitCode = 1;
      return;
    }
    console.log(formatRuleList(ruleset));
    return;
  }

  // Require a target for actual linting
  if (!options.target) {
    console.error('Usage: aiwg lint <target> [--ruleset <name>] [--format full|summary|json] [--ci] [--allow-empty] [--fail-on error|warn|info] [--no-gitignore]');
    console.error('       aiwg lint --list-rulesets');
    console.error('       aiwg lint --list-rules <ruleset>');
    process.exitCode = 1;
    return;
  }

  // Resolve target path
  const targetDir = path.resolve(cwd, options.target);

  // Select rulesets
  let selectedRulesets = allRulesets;
  if (options.rulesets && options.rulesets.length > 0) {
    selectedRulesets = allRulesets.filter(
      r => options.rulesets!.includes(r.id) || options.rulesets!.includes(r.framework)
    );
    if (selectedRulesets.length === 0) {
      console.error(`No matching rulesets for: ${options.rulesets.join(', ')}`);
      console.error('Available: ' + allRulesets.map(r => r.id).join(', '));
      process.exitCode = 1;
      return;
    }
  } else {
    selectedRulesets = autoDetectRulesets(options.target, allRulesets);
  }

  // Dry run
  if (options.dryRun) {
    console.log(`Dry run: would lint '${options.target}' with rulesets: ${selectedRulesets.map(r => r.id).join(', ')}`);
    for (const rs of selectedRulesets) {
      console.log(`  ${rs.id}: ${rs.rules.length} rules`);
      for (const rule of rs.rules) {
        console.log(`    - ${rule.id} [${rule.severity}]: ${rule.description}`);
      }
    }
    return;
  }

  let startupBudget: InlineBudgetOptions | undefined;
  if (options.startupPlan) {
    const plan = JSON.parse(fs.readFileSync(path.resolve(cwd, options.startupPlan), 'utf8'));
    if (!plan || typeof plan.provider !== 'string' || !Array.isArray(plan.files)) {
      throw new Error('Startup plan must contain provider and files (the complete assembled startup set).');
    }
    startupBudget = { provider: plan.provider, files: plan.files, config: await readAiwgConfigCandidate(cwd) ?? {} };
  }

  // Run lint
  const result = await runLint(targetDir, selectedRulesets, {
    startupBudget,
    recursive: options.recursive,
    ci: options.ci,
    allowEmpty: options.allowEmpty,
    failOn: options.failOn,
    respectGitignore: options.respectGitignore ?? true,
  });

  // Output results
  console.log(formatResult(result, options.format || 'full'));

  // Set exit code in CI mode
  if (options.ci && !result.summary.passed) {
    process.exitCode = 1;
  }
}
