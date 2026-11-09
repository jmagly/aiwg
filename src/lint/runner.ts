import { lintRuleConflicts } from './rule-conflicts.js';
/**
 * Lint Runner
 *
 * Core lint execution engine. Matches rules to files,
 * runs checks, and collects diagnostics.
 *
 * @issue #810
 */

import fs from 'fs';
import { lintRuleActivation, loadRuleActivationEntries } from './rule-activation.js';
import { guardRulesInlineBudget, type InlineBudgetOptions } from '../rules/inline-budget.mjs';
import type { MetadataEntry } from '../artifacts/types.js';
import { dropGitignored } from '../config/gitignore.js';
import fsp from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { parseFrontmatter, runCheck } from './checks.js';
import { buildReferenceIndex } from './reference-resolution.js';
export { DEFAULT_ABSENCE_MARKERS, DEFAULT_UNCERTAINTY_PATTERNS, DEFAULT_VERIFICATION_TARGETS, DEFAULT_OBSTACLE_PATTERNS, DATED_OUTCOME_PATTERN, CLOSURE_OUTCOME_PATTERN } from './check-patterns.js';
import type {
  LintDiagnostic,
  LintResult,
  LintRule,
  LintRuleset,
  LintSeverity,
} from './types.js';

/** Resolve project-relative metadata from the nearest repository/workspace marker. */
function findProjectRoot(targetDir: string): string {
  let dir = path.resolve(targetDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.aiwg'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(targetDir);
    dir = parent;
  }
}

/**
 * Candidate paths a rule glob may be written against (#2555).
 *
 * `collectFiles` walks with `cwd: targetDir`, so files arrive target-relative
 * (`REF-001.md`) while rule globs are written repo-relative
 * (`documentation/references/**\/*.md`). Narrowing the target to the very
 * directory a rule names therefore matched nothing, and the run reported PASS
 * with every finding unreported. Matching against the target-relative path and
 * each ancestor-prefixed form makes a glob resolve the same way wherever the
 * walk is rooted.
 */
export function ruleMatchCandidates(file: string, targetDir: string): string[] {
  const normalizedFile = file.replace(/\\/g, '/');
  const candidates = [normalizedFile];
  const segments = path.resolve(targetDir).replace(/\\/g, '/').split('/').filter(Boolean);
  let prefix = '';
  for (let i = segments.length - 1; i >= 0 && segments.length - i <= 12; i -= 1) {
    prefix = prefix ? `${segments[i]}/${prefix}` : `${segments[i]}/`;
    candidates.push(`${prefix}${normalizedFile}`);
  }
  return candidates;
}

/** True when a rule's glob selects this file, wherever the walk was rooted. */
export function ruleAppliesToFile(ruleGlob: string, file: string, targetDir: string): boolean {
  return ruleMatchCandidates(file, targetDir).some((candidate) => minimatch(candidate, ruleGlob));
}

/**
 * Run a single rule against all matching files in the target
 */
async function runRule(
  rule: LintRule,
  targetDir: string,
  allFiles: string[],
  referenceIndex: Set<string>,
  projectRoot: string,
  artifactEntries?: MetadataEntry[]
): Promise<{ diagnostics: LintDiagnostic[]; files: string[] }> {
  const diagnostics: LintDiagnostic[] = [];

  // Filter files matching the rule's glob
  const ruleGlob = rule.appliesTo.glob;
  const matchingFiles = allFiles.filter(f => ruleAppliesToFile(ruleGlob, f, targetDir));

  if (matchingFiles.length === 0) return { diagnostics, files: matchingFiles };

  // Handle id-unique check at the ruleset level
  const uniqueCheck = rule.checks.find(c => c.type === 'id-unique');
  if (uniqueCheck) {
    const ids = new Map<string, string>();
    for (const file of matchingFiles) {
      const basename = path.basename(file, '.md');
      if (ids.has(basename)) {
        diagnostics.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          file,
          message: `Duplicate identifier '${basename}' — also found in ${ids.get(basename)}`,
        });
      } else {
        ids.set(basename, file);
      }
    }
  }

  if (rule.checks.some(check => check.type === 'rule-activation')) diagnostics.push(...lintRuleConflicts(targetDir, matchingFiles, projectRoot));

  // Run per-file checks
  for (const file of matchingFiles) {
    const absPath = path.resolve(targetDir, file);
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(content);

    for (const check of rule.checks) {
      if (check.type === 'id-unique') continue; // Already handled
      if (check.type === 'rule-activation') {
        diagnostics.push(...lintRuleActivation(content, file, projectRoot, artifactEntries ??= await loadRuleActivationEntries(projectRoot), absPath));
        continue;
      }

      const checkDiagnostics = runCheck(
        check,
        content,
        frontmatter,
        file,
        targetDir,
        allFiles,
        referenceIndex,
        projectRoot
      );
      for (const d of checkDiagnostics) {
        d.ruleId = rule.id;
        d.ruleName = rule.name;
        d.severity = d.severity || rule.severity;
        diagnostics.push(d);
      }
    }
  }

  return { diagnostics, files: matchingFiles };
}

/**
 * Collect all files under a target directory
 */
async function collectFiles(
  targetDir: string,
  recursive: boolean,
  respectGitignore = true,
): Promise<string[]> {
  const pattern = recursive ? '**/*' : '*';
  try {
    const files = await glob(pattern, {
      cwd: targetDir,
      nodir: true,
      dot: false,
    });
    const linted = files.filter(f => f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
    return respectGitignore ? dropGitignored(targetDir, linted) : linted;
  } catch {
    return [];
  }
}

/**
 * Auto-detect which rulesets apply to a target path
 *
 * Maps known directory patterns to rulesets:
 * - .aiwg/research/ → research-complete
 * - .aiwg/requirements/, .aiwg/architecture/ → sdlc-complete
 */
function autoDetectRulesets(target: string, available: LintRuleset[]): LintRuleset[] {
  const normalized = target.replace(/\\/g, '/');

  const matches: LintRuleset[] = [];
  for (const rs of available) {
    // Match by framework ID patterns
    if (normalized.includes('research') && rs.framework.includes('research')) {
      matches.push(rs);
    } else if (
      (normalized.includes('requirements') ||
        normalized.includes('architecture') ||
        normalized.includes('testing') ||
        normalized.includes('deployment')) &&
      rs.framework.includes('sdlc')
    ) {
      matches.push(rs);
    }
  }

  // If no auto-detection, return all available
  return matches.length > 0
    ? available.filter(ruleset => ruleset.id === 'rule-activation' || matches.includes(ruleset))
    : available;
}

/**
 * Run lint on a target path with specified or auto-detected rulesets
 */
export async function runLint(
  targetDir: string,
  rulesets: LintRuleset[],
  options: { recursive?: boolean; failOn?: LintSeverity; respectGitignore?: boolean; ci?: boolean; allowEmpty?: boolean; artifactEntries?: MetadataEntry[]; startupBudget?: InlineBudgetOptions } = {}
): Promise<LintResult> {
  const recursive = options.recursive ?? true;
  const targetStat = await fsp.stat(targetDir).catch(() => null);
  const scanDir = targetStat?.isFile() ? path.dirname(targetDir) : targetDir;
  const projectRoot = findProjectRoot(scanDir);
  const respectGitignore = options.respectGitignore ?? true;
  let allFiles: string[];
  let targetMessage = '';
  if (!targetStat) {
    allFiles = [];
    targetMessage = `Target does not exist or is inaccessible: ${targetDir}.`;
  } else if (targetStat.isFile()) {
    const file = path.basename(targetDir);
    if (!/\.(md|yaml|yml|json)$/.test(file)) {
      allFiles = [];
      targetMessage = `Unsupported file type: ${file}. Expected .md, .yaml, .yml or .json.`;
    } else {
      allFiles = respectGitignore ? dropGitignored(scanDir, [file]) : [file];
    }
  } else {
    allFiles = await collectFiles(scanDir, recursive, respectGitignore);
  }
  const referenceIndex = buildReferenceIndex(allFiles);
  const allDiagnostics: LintDiagnostic[] = [];
  const inapplicableRules: string[] = [];
  const ruleCoverage: Record<string, string[]> = {};
  let rulesSelected = 0;

  for (const ruleset of rulesets) {
    for (const rule of ruleset.rules) {
      rulesSelected += 1;
      const { diagnostics, files } = await runRule(rule, scanDir, allFiles, referenceIndex, projectRoot, options.artifactEntries);
      ruleCoverage[rule.id] = files;
      if (files.length === 0) inapplicableRules.push(rule.id);
      allDiagnostics.push(...diagnostics);
    }
  }

  let budget: ReturnType<typeof guardRulesInlineBudget> | undefined;
  if (options.startupBudget) {
    try {
      budget = guardRulesInlineBudget({
        ...options.startupBudget, reportOnly: options.ci ? false : (options.startupBudget.reportOnly ?? true),
      });
    } catch (error) {
      allDiagnostics.push({
        ruleId: 'rules/inline-budget', ruleName: 'Rules inline budget', file: '(assembled startup)',
        severity: 'error', message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (budget) {
    for (const item of budget.diagnostics) allDiagnostics.push({
      ruleId: 'rules/inline-budget', ruleName: 'Rules inline budget', file: '(assembled startup)',
      severity: item.severity, message: item.message,
    });
  }

  const errors = allDiagnostics.filter(d => d.severity === 'error').length;
  const warnings = allDiagnostics.filter(d => d.severity === 'warn').length;
  const infos = allDiagnostics.filter(d => d.severity === 'info').length;

  const failOn = options.failOn || 'error';
  let passed = true;
  if (failOn === 'error' && errors > 0) passed = false;
  if (failOn === 'warn' && (errors > 0 || warnings > 0)) passed = false;
  if (failOn === 'info' && allDiagnostics.length > 0) passed = false;

  const rulesApplied = rulesSelected - inapplicableRules.length;
  const coverageMessage = allFiles.length === 0
    ? `No files checked. ${targetMessage || 'The target is empty, contains no supported files, or all files are ignored.'}`
    : rulesApplied === 0
      ? 'No rules applied. Check the target path and selected ruleset globs.'
      : undefined;
  if (options.ci && !options.allowEmpty && coverageMessage) passed = false;

  return {
    target: targetDir,
    rulesets: rulesets.map(r => r.id),
    diagnostics: allDiagnostics,
    ...(budget ? { inlineBudget: budget.report } : {}),
    ruleCoverage,
    summary: {
      filesChecked: allFiles.length,
      errors,
      warnings,
      infos,
      passed,
      // A run where no rule selected a file must never read the same as a clean
      // run (#2555). Reporters surface this; callers can gate on it.
      rulesSelected,
      rulesApplied,
      inapplicableRules,
      coverageMessage,
    },
    timestamp: new Date().toISOString(),
  };
}

export { autoDetectRulesets };
