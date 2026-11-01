// Include native core projections when inventorying still-shipped rule files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseRuleFrontmatter } from '../../rules/activation.mjs';

export async function bundledRuleOutputNames(file: string): Promise<string[]> {
  const name = path.basename(file);
  const parsed = parseRuleFrontmatter(await fs.readFile(file, 'utf8'));
  return parsed.valid && parsed.rule?.activation === 'core' ? [name, `core-${name}`] : [name];
}
