// Synchronize tracker issue forms from the owning aiwg-utils bundle.
import fs from 'node:fs';
import path from 'node:path';

const templates = ['bug-report', 'feature-request', 'tester-report', 'imported-report'];

export function syncIssueTemplateCopies(root, { check = false, dryRun = false } = {}) {
  const differences = [];
  for (const name of templates) {
    const source = path.join(root, 'agentic/code/addons/aiwg-utils/templates/issues', `${name}.md`);
    const canonical = fs.readFileSync(source);
    for (const tracker of ['.gitea', '.github']) {
      const relative = `${tracker}/ISSUE_TEMPLATE/${name}.md`;
      const target = path.join(root, relative);
      if (!fs.existsSync(target)) differences.push(`Missing: ${relative}`);
      else if (!fs.readFileSync(target).equals(canonical)) differences.push(`Changed: ${relative}`);
      if (!check && !dryRun) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, canonical);
      }
    }
  }
  return differences;
}
