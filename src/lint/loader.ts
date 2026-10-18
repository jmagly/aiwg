/**
 * Lint Rule Loader
 *
 * Discovers and loads lint rulesets from installed frameworks.
 * Each framework ships a `lint/` directory with a `ruleset.yaml`
 * and individual rule YAML files.
 *
 * @issue #810
 */

import fs from 'fs';
import { ruleActivationRuleset } from './rule-activation.js';
import fsp from 'fs/promises';
import path from 'path';
import type { LintRule, LintRuleset } from './types.js';
import { projectAiwgPath } from '../config/project-artifacts.js';

/**
 * Parse YAML frontmatter-style content (simple key: value parser)
 * Handles the subset of YAML used in lint rule definitions.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;
  let inChecks = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip comments and empty lines
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Top-level key: value
    const topMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (topMatch && !trimmed.startsWith('  ')) {
      // Flush any pending array
      if (currentArray && currentKey) {
        result[currentKey] = currentArray;
        currentArray = null;
      }

      currentKey = topMatch[1];
      const value = topMatch[2].trim();

      if (value === '') {
        // Could be start of a nested structure
        if (currentKey === 'checks') {
          inChecks = true;
          currentArray = [];
        } else if (currentKey === 'applies-to') {
          currentObject = {};
          result[currentKey] = currentObject;
        }
      } else {
        inChecks = false;
        result[currentKey] = parseValue(value);
      }
      continue;
    }

    // Nested key under applies-to
    if (currentObject && trimmed.match(/^\s{2}\w/)) {
      const nestedMatch = trimmed.match(/^\s{2}(\w[\w-]*)\s*:\s*(.+)$/);
      if (nestedMatch) {
        currentObject[nestedMatch[1]] = parseValue(nestedMatch[2].trim());
        continue;
      }
    }

    // Array item in checks
    if (inChecks && trimmed.match(/^\s{2}-\s/)) {
      currentObject = {};
      if (currentArray) currentArray.push(currentObject);
      const itemMatch = trimmed.match(/^\s{2}-\s+(\w[\w-]*)\s*:\s*(.+)$/);
      if (itemMatch) {
        currentObject[itemMatch[1]] = parseValue(itemMatch[2].trim());
      }
      continue;
    }

    // Properties of current check item
    if (inChecks && currentObject && trimmed.match(/^\s{4}\w/)) {
      const propMatch = trimmed.match(/^\s{4}(\w[\w-]*)\s*:\s*(.+)$/);
      if (propMatch) {
        const val = propMatch[2].trim();
        // Handle inline arrays: [field1, field2, field3]
        if (val.startsWith('[') && val.endsWith(']')) {
          currentObject[propMatch[1]] = val
            .slice(1, -1)
            .split(',')
            .map((s: string) => s.trim());
        } else {
          currentObject[propMatch[1]] = parseValue(val);
        }
        continue;
      }
    }
  }

  // Flush trailing array
  if (currentArray && currentKey) {
    result[currentKey] = currentArray;
  }

  return result;
}

function parseValue(val: string): string | number | boolean | string[] {
  // Boolean
  if (val === 'true') return true;
  if (val === 'false') return false;

  // Number
  if (/^\d+(\.\d+)?$/.test(val)) return Number(val);

  // Inline array
  if (val.startsWith('[') && val.endsWith(']')) {
    return val
      .slice(1, -1)
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''));
  }

  // Strip quotes and unescape YAML double-quote sequences
  const unquoted = val.replace(/^["']|["']$/g, '');
  return unquoted.replace(/\\\\/g, '\\');
}

/**
 * Load a single lint rule from a YAML file
 */
export async function loadRule(filePath: string): Promise<LintRule> {
  const content = await fsp.readFile(filePath, 'utf8');
  const parsed = parseSimpleYaml(content);

  const appliesTo = parsed['applies-to'] as Record<string, string> | undefined;

  return {
    id: String(parsed.id || ''),
    name: String(parsed.name || ''),
    description: String(parsed.description || ''),
    severity: (parsed.severity as LintRule['severity']) || 'warn',
    appliesTo: {
      glob: appliesTo?.glob || '**/*',
    },
    checks: (parsed.checks as LintRule['checks']) || [],
  };
}

/**
 * Load a ruleset and all its rules from a framework's lint/ directory
 */
export async function loadRuleset(lintDir: string, frameworkId: string): Promise<LintRuleset | null> {
  const rulesetPath = path.join(lintDir, 'ruleset.yaml');
  if (!fs.existsSync(rulesetPath)) return null;

  const content = await fsp.readFile(rulesetPath, 'utf8');
  const parsed = parseSimpleYaml(content);

  // Load individual rule files
  const rules: LintRule[] = [];
  const entries = await fsp.readdir(lintDir);

  for (const entry of entries) {
    if (entry === 'ruleset.yaml') continue;
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

    try {
      const rule = await loadRule(path.join(lintDir, entry));
      rules.push(rule);
    } catch {
      // Skip malformed rule files
    }
  }

  return {
    id: String(parsed.id || frameworkId),
    name: String(parsed.name || frameworkId),
    description: String(parsed.description || ''),
    framework: frameworkId,
    version: String(parsed.version || '1.0.0'),
    rules,
  };
}

/**
 * Discover all available rulesets from installed frameworks
 *
 * Looks in two locations:
 * 1. Framework source: agentic/code/frameworks/{id}/lint/
 * 2. Deployed frameworks: .aiwg/frameworks/{id}/lint/
 */
export async function discoverRulesets(cwd: string, frameworkRoot: string): Promise<LintRuleset[]> {
  const rulesets: LintRuleset[] = [ruleActivationRuleset];

  // Check framework source directories
  const frameworksDir = path.join(frameworkRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(frameworksDir)) {
    try {
      const frameworks = await fsp.readdir(frameworksDir);
      for (const fw of frameworks) {
        const lintDir = path.join(frameworksDir, fw, 'lint');
        if (fs.existsSync(lintDir)) {
          const ruleset = await loadRuleset(lintDir, fw);
          if (ruleset) rulesets.push(ruleset);
        }
      }
    } catch {
      // Skip on error
    }
  }

  // Also check .aiwg/frameworks/ for deployed rulesets
  const deployedDir = projectAiwgPath(cwd, 'frameworks');
  if (fs.existsSync(deployedDir)) {
    try {
      const frameworks = await fsp.readdir(deployedDir);
      for (const fw of frameworks) {
        if (fw === 'registry.json') continue;
        const lintDir = path.join(deployedDir, fw, 'lint');
        if (fs.existsSync(lintDir)) {
          // Skip if already loaded from source
          if (!rulesets.find(r => r.id === fw)) {
            const ruleset = await loadRuleset(lintDir, fw);
            if (ruleset) rulesets.push(ruleset);
          }
        }
      }
    } catch {
      // Skip on error
    }
  }

  return rulesets;
}
