// Exercise core projection inventory and stale cleanup with synthetic rules.
import { recordManagedCopy } from '../../../helpers/managed-copy-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bundledRuleOutputNames } from '../../../../src/cli/handlers/refresh-rule-inventory.js';
import { pruneStaleManagedAgentFiles } from '../../../../src/cli/handlers/refresh.js';
let root: string;
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); if (bytes.includes('aiwg:managed')) recordManagedCopy(file); };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-core-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it.each(['core', 'kernel'])('inventories only the native names produced by %s activation', async activation => {
  const file = path.join(root, 'policy.md');
  write(file, `---\nactivation: ${activation}\n---\n# Policy\n`);
  expect(await bundledRuleOutputNames(file)).toEqual(activation === 'core' ? ['policy.md', 'core-policy.md'] : ['policy.md']);
});
it('keeps a current core projection while removing a retired one', async () => {
  const source = path.join(root, 'source'), project = path.join(root, 'project');
  write(path.join(source, 'package.json'), '{"version":"2026.10.19"}');
  write(path.join(source, 'agentic/code/addons/aiwg-utils/rules/policy.md'), '---\nactivation: core\n---\n# Policy\n');
  for (const name of ['core-policy.md', 'core-retired.md']) write(path.join(project, '.claude/rules', name), '<!-- aiwg:managed v2026.10.19 bundled -->\n# Compact policy\n');
  const result = await pruneStaleManagedAgentFiles({ projectRoot: project, frameworkRoot: source, provider: 'claude', dryRun: true });
  expect(result.removals).toEqual([{ provider: 'claude', paths: ['.claude/rules/core-retired.md'] }]);
  expect(fs.existsSync(path.join(project, '.claude/rules/core-policy.md'))).toBe(true);
  expect(fs.existsSync(path.join(project, '.claude/rules/core-retired.md'))).toBe(true);
});
