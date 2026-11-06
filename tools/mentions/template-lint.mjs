// Validate concrete canonical template references using the index's resolver.
import fs from 'node:fs';
import path from 'node:path';
import { extractTemplateReferences, templateReferenceCandidates } from '../../dist/src/artifacts/template-references.js';

export function lintTemplateReferences(file, content, root) {
  const source = path.relative(root, file).split(path.sep).join('/');
  // Marketplace copies have canonical owners; do not double-report generated payloads.
  if (!/^agentic\/code\/(addons|frameworks|extensions)\//.test(source)) return [];
  const missing = new Set(extractTemplateReferences(content).filter(reference =>
    !templateReferenceCandidates(source, reference).some(candidate => {
      try { return fs.statSync(path.resolve(root, candidate)).isFile(); }
      catch { return false; }
    }),
  ));
  const issues = [];
  for (const [index, line] of content.split('\n').entries()) {
    for (const reference of extractTemplateReferences(line)) {
      if (missing.has(reference)) issues.push({
        rule: 'ML007', severity: 'error', line: index + 1,
        message: `${reference} → template file not found`, autofix: false,
      });
    }
  }
  return issues;
}
