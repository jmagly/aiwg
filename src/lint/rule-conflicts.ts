// Warn on literal opposite directives for an explicitly declared subject at equal precedence.
import fs from 'node:fs';
import path from 'node:path';
import { parseRuleFrontmatter } from '../rules/activation.mjs';
import { loadRulePinConfigs } from '../rules/pins.mjs';
import { resolveRulePrecedence } from '../rules/precedence.mjs';
import { ruleOrderingAliases } from '../rules/project-precedence.js';
import { resolveFrameworkIndexRoot } from '../artifacts/framework-index-paths.js';
import type { LintDiagnostic } from './types.js';

export function lintRuleConflicts(targetDir: string, files: string[], projectRoot: string): LintDiagnostic[] {
  const seen = new Map<string, { file: string; positive: boolean }[]>();
  const diagnostics: LintDiagnostic[] = [];
  const emitted = new Set<string>();
  const configs = loadRulePinConfigs(projectRoot);
  const root = resolveFrameworkIndexRoot(projectRoot);
  for (const file of [...files].sort()) {
    if (/\.core\.md$|\/(?:README|RULES-INDEX|RULES-ONDEMAND)\.md$/.test(file)) continue;
    const absolute = path.resolve(targetDir, file);
    const parsed = parseRuleFrontmatter(fs.readFileSync(absolute, 'utf8'));
    if (!parsed.valid) continue;
    const data = parsed.data as Record<string, unknown>;
    const subjects = typeof data.subject === 'string' ? [data.subject] : Array.isArray(data.subjects) ? data.subjects : [];
    if (!subjects.length) continue;
    const ordering = resolveRulePrecedence({ ...parsed.rule, name: String(data.name ?? path.basename(file, '.md')) }, configs, ruleOrderingAliases(absolute, root, projectRoot));
    for (const line of parsed.body.split('\n')) {
      const match = line.trim().match(/^(?:[-*]\s+)?(always|never|must not|must|do not)\s+(.+?)[.!]?$/i);
      if (!match) continue;
      const positive = /^(always|must)$/i.test(match[1]);
      const directive = match[2].toLowerCase().replace(/\s+/g, ' ');
      for (const subject of subjects.filter((item): item is string => typeof item === 'string' && !!item.trim())) {
        const key = JSON.stringify([subject.trim().toLowerCase(), ordering.precedence, directive]);
        const previous = seen.get(key) ?? [];
        for (const other of previous) {
          if (other.file === file || other.positive === positive) continue;
          const pair = JSON.stringify([other.file, file, subject]);
          if (emitted.has(pair)) continue;
          emitted.add(pair);
          diagnostics.push({ ruleId: 'rules/activation', ruleName: 'Rule activation contract', severity: 'warn', file,
            message: `Possible conflicting rules ${other.file} and ${file}: opposite directives on declared subject '${subject}' at precedence ${ordering.precedence}. Review scope and ordering.` });
        }
        seen.set(key, [...previous, { file, positive }]);
      }
    }
  }
  return diagnostics;
}
