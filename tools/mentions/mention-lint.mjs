#!/usr/bin/env node
/**
 * @-Mention Linter
 *
 * Validates @-mention style and correctness across codebase.
 *
 * Usage:
 *   aiwg mention-lint [--target <dir>] [--fix] [--strict] [--json]
 */

import fs from 'fs';
import path from 'path';
import { lintTemplateReferences } from './template-lint.mjs';

// Configuration
const MENTION_PATTERN = /@[\w./-]+\.(?:md|ts|js|py|go|rs|java|tsx|jsx)/g;
const MENTION_PREFIX_PATTERN = /@(\.aiwg|src|test|lib|docs)\//;

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: '.',
    fix: false,
    strict: false,
    json: false,
    rules: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--target':
      case '-t':
        options.target = args[++i];
        break;
      case '--fix':
        options.fix = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--rules':
        options.rules = args[++i]?.split(',');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

// Lint rules
const RULES = {
  ML001: {
    id: 'ML001',
    description: 'Path does not exist',
    severity: 'error',
    autofix: false,
    check: (mention, filePath, targetDir) => {
      const mentionPath = mention.replace(/^@/, '');
      const fullPath = path.resolve(targetDir, mentionPath);
      if (!fs.existsSync(fullPath)) {
        return { message: `${mention} → file not found` };
      }
      return null;
    }
  },

  ML002: {
    id: 'ML002',
    description: 'Wrong case',
    severity: 'warning',
    autofix: true,
    check: (mention) => {
      // Check for uppercase in path (should be lowercase)
      const pathPart = mention.replace(/^@/, '').split('/').slice(0, -1).join('/');
      if (pathPart !== pathPart.toLowerCase()) {
        return {
          message: `${mention} should use lowercase paths`,
          fix: '@' + mention.slice(1).toLowerCase()
        };
      }
      return null;
    }
  },

  ML003: {
    id: 'ML003',
    description: 'Missing required prefix',
    severity: 'warning',
    autofix: true,
    check: (mention) => {
      if (!MENTION_PREFIX_PATTERN.test(mention)) {
        // Try to infer correct prefix
        if (mention.includes('/src/') || mention.match(/\.(ts|js|tsx|jsx)$/)) {
          return {
            message: `${mention} should have @src/ prefix`,
            fix: mention.replace('@', '@src/')
          };
        }
        if (mention.includes('/test/') || mention.includes('.test.') || mention.includes('.spec.')) {
          return {
            message: `${mention} should have @test/ prefix`,
            fix: mention.replace('@', '@test/')
          };
        }
        if (mention.includes('requirements') || mention.includes('architecture') || mention.includes('security')) {
          return {
            message: `${mention} should have @.aiwg/ prefix`,
            fix: mention.replace('@', '@.aiwg/')
          };
        }
      }
      return null;
    }
  },

  ML004: {
    id: 'ML004',
    description: 'Deprecated path pattern',
    severity: 'warning',
    autofix: true,
    check: (mention) => {
      // Old patterns that should be updated
      const deprecatedPatterns = [
        { pattern: /@requirements\//, replacement: '@.aiwg/requirements/', msg: 'Use @.aiwg/requirements/' },
        { pattern: /@architecture\//, replacement: '@.aiwg/architecture/', msg: 'Use @.aiwg/architecture/' },
        { pattern: /@security\//, replacement: '@.aiwg/security/', msg: 'Use @.aiwg/security/' },
        { pattern: /@intake\//, replacement: '@.aiwg/intake/', msg: 'Use @.aiwg/intake/' }
      ];

      for (const { pattern, replacement, msg } of deprecatedPatterns) {
        if (pattern.test(mention)) {
          return {
            message: `${mention} uses deprecated pattern. ${msg}`,
            fix: mention.replace(pattern, replacement)
          };
        }
      }
      return null;
    }
  },

  ML005: {
    id: 'ML005',
    description: 'Invalid ID format',
    severity: 'warning',
    autofix: true,
    check: (mention) => {
      // Check UC-NNN format (should be 3 digits)
      const ucMatch = mention.match(/UC-(\d+)/);
      if (ucMatch && ucMatch[1].length < 3) {
        const fixed = mention.replace(/UC-(\d+)/, (_, n) => `UC-${n.padStart(3, '0')}`);
        return {
          message: `UC ID should be 3 digits (UC-${ucMatch[1]} → UC-${ucMatch[1].padStart(3, '0')})`,
          fix: fixed
        };
      }

      // Check ADR-NNN format
      const adrMatch = mention.match(/ADR-(\d+)/);
      if (adrMatch && adrMatch[1].length < 3) {
        const fixed = mention.replace(/ADR-(\d+)/, (_, n) => `ADR-${n.padStart(3, '0')}`);
        return {
          message: `ADR ID should be 3 digits (ADR-${adrMatch[1]} → ADR-${adrMatch[1].padStart(3, '0')})`,
          fix: fixed
        };
      }

      // Check NFR format
      const nfrMatch = mention.match(/NFR-([A-Z]+)-(\d+)/);
      if (nfrMatch && nfrMatch[2].length < 3) {
        const fixed = mention.replace(/NFR-([A-Z]+)-(\d+)/, (_, cat, n) => `NFR-${cat}-${n.padStart(3, '0')}`);
        return {
          message: `NFR ID should be 3 digits`,
          fix: fixed
        };
      }

      return null;
    }
  },

  ML006: {
    id: 'ML006',
    description: 'Duplicate mentions',
    severity: 'info',
    autofix: true,
    // This is handled at file level, not mention level
    check: () => null
  }
};

// Find files to lint
function findFiles(targetDir) {
  const files = [];
  const extensions = ['.md', '.yaml', '.yml', '.json', '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java'];

  function walk(dir) {
    if (dir.includes('node_modules') || dir.includes('.git')) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(targetDir);
  return files;
}

// Extract mentions from file
function extractMentions(content) {
  const mentions = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    const regex = new RegExp(MENTION_PATTERN.source, 'g');

    while ((match = regex.exec(line)) !== null) {
      mentions.push({
        text: match[0],
        line: i + 1,
        column: match.index + 1
      });
    }
  }

  return mentions;
}

// Lint a single file
function lintFile(filePath, targetDir, rules) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const mentions = extractMentions(content);
  const issues = !rules || rules.includes('ML007')
    ? lintTemplateReferences(filePath, content, process.cwd()) : [];

  // Check for duplicates (ML006)
  const seen = new Map();
  for (const mention of mentions) {
    if (seen.has(mention.text)) {
      if (!rules || rules.includes('ML006')) {
        issues.push({
          rule: 'ML006',
          severity: 'info',
          line: mention.line,
          message: `${mention.text} appears multiple times (first at line ${seen.get(mention.text)})`,
          autofix: true
        });
      }
    } else {
      seen.set(mention.text, mention.line);
    }

    // Run other rules
    for (const [ruleId, rule] of Object.entries(RULES)) {
      if (ruleId === 'ML006') continue; // Already handled
      if (rules && !rules.includes(ruleId)) continue;

      const result = rule.check(mention.text, filePath, targetDir);
      if (result) {
        issues.push({
          rule: ruleId,
          severity: rule.severity,
          line: mention.line,
          column: mention.column,
          message: result.message,
          fix: result.fix,
          autofix: rule.autofix
        });
      }
    }
  }

  return { filePath, issues, content };
}

// Apply fixes to file
function applyFixes(filePath, content, issues) {
  let fixed = content;
  let fixCount = 0;

  // Sort issues by line descending to apply fixes from bottom up
  const fixableIssues = issues
    .filter(i => i.autofix && i.fix)
    .sort((a, b) => b.line - a.line);

  for (const issue of fixableIssues) {
    const lines = fixed.split('\n');
    const line = lines[issue.line - 1];

    // Find and replace the mention
    const oldMention = issue.message.split(' ')[0];
    if (line.includes(oldMention)) {
      lines[issue.line - 1] = line.replace(oldMention, issue.fix);
      fixed = lines.join('\n');
      fixCount++;
    }
  }

  if (fixCount > 0) {
    fs.writeFileSync(filePath, fixed);
  }

  return fixCount;
}

// Format output
function formatOutput(results, options) {
  if (options.json) {
    return JSON.stringify(results, null, 2);
  }

  let output = '';
  let totalIssues = 0;
  let fixableCount = 0;

  for (const { filePath, issues } of results) {
    if (issues.length === 0) continue;

    const relativePath = path.relative(options.target, filePath);
    output += `\n${relativePath}\n`;

    for (const issue of issues) {
      const prefix = issue.severity === 'error' ? '✗' :
                     issue.severity === 'warning' ? '⚠' : 'ℹ';
      const fixable = issue.autofix ? ' (auto-fixable)' : '';
      output += `  L${issue.line}: ${prefix} ${issue.rule} ${issue.message}${fixable}\n`;
      totalIssues++;
      if (issue.autofix) fixableCount++;
    }
  }

  const errorCount = results.flatMap(r => r.issues).filter(i => i.severity === 'error').length;
  const warnCount = results.flatMap(r => r.issues).filter(i => i.severity === 'warning').length;
  const infoCount = results.flatMap(r => r.issues).filter(i => i.severity === 'info').length;

  output += `\nSummary: ${totalIssues} issues (${errorCount} errors, ${warnCount} warnings, ${infoCount} info)\n`;
  if (fixableCount > 0 && !options.fix) {
    output += `         ${fixableCount} auto-fixable (run with --fix)\n`;
  }

  return output;
}

// Show help
function showHelp() {
  console.log(`
@-Mention Linter

Usage:
  aiwg mention-lint [options]

Options:
  --target, -t <dir>  Directory to lint (default: .)
  --fix               Auto-fix fixable issues
  --strict            Exit with error on any issue
  --json              Output as JSON
  --rules <ids>       Run specific rules (comma-separated)
  --help, -h          Show this help

Rules:
  ML001  Path does not exist (error)
  ML002  Wrong case (warning, auto-fix)
  ML003  Missing required prefix (warning, auto-fix)
  ML004  Deprecated path pattern (warning, auto-fix)
  ML005  Invalid ID format (warning, auto-fix)
  ML006  Duplicate mentions (info, auto-fix)
  ML007  Template file does not exist (error; canonical bundle sources)

Examples:
  aiwg mention-lint                    # Lint current directory
  aiwg mention-lint --fix              # Auto-fix issues
  aiwg mention-lint --strict           # Fail on any issue
  aiwg mention-lint --rules ML001,ML005  # Run specific rules
`);
}

// Main
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    return;
  }

  const targetDir = path.resolve(options.target);
  if (!fs.existsSync(targetDir)) {
    console.error(`Target directory not found: ${targetDir}`);
    process.exit(1);
  }

  const files = findFiles(targetDir);
  const results = [];

  for (const file of files) {
    const result = lintFile(file, targetDir, options.rules);

    if (options.fix && result.issues.length > 0) {
      const fixCount = applyFixes(file, result.content, result.issues);
      if (fixCount > 0) {
        result.fixedCount = fixCount;
        // Re-lint after fixes
        const afterFix = lintFile(file, targetDir, options.rules);
        result.issues = afterFix.issues;
      }
    }

    results.push(result);
  }

  console.log(formatOutput(results, options));

  // Exit code
  const hasErrors = results.some(r => r.issues.some(i => i.severity === 'error'));
  const hasAnyIssues = results.some(r => r.issues.length > 0);

  if (hasErrors || (options.strict && hasAnyIssues)) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
