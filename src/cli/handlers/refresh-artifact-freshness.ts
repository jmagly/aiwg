// Verify retained provider copies against both their deployment receipt and current bundled source.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripManagedMarker } from '../../extensions/managed-marker.js';
import { generateCommandContent, parseFrontmatter, resolveSkillModelPolicy } from '../../plugin/skill-command-translator.js';

const hash = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function currentLegacySkillCommand(deployed: string, canonical: string, source: string): boolean {
  const { frontmatter, body } = parseFrontmatter(canonical);
  const name = path.basename(path.dirname(source));
  const policy = resolveSkillModelPolicy(frontmatter.commandHint);
  const fields = policy ? [`aiwg-model-role: ${policy.modelRole}`, `aiwg-model-tier: ${policy.modelTier}`,
    ...(policy.modelEffort ? [`aiwg-model-effort: ${policy.modelEffort}`] : []),
    ...(frontmatter.commandHint?.modelRationale ? [`aiwg-model-rationale: ${frontmatter.commandHint.modelRationale}`] : [])] : [];
  const mirrored = `---\nname: ${name}\ndescription: ${frontmatter.description || `Run AIWG skill ${name}`}\n${fields.length ? fields.join('\n') + '\n' : ''}---\n\n${body.trim()}\n`;
  const clean = stripManagedMarker(deployed).replace(/\n?<!-- AIWG:bound-rules:start -->[\s\S]*?<!-- AIWG:bound-rules:end -->\n?/g, '').trimEnd();
  return [mirrored, generateCommandContent(name, frontmatter, body)]
    .some(expected => expected.trimEnd() === clean);
}

export async function hasCurrentBundledArtifact(file: string, frameworkRoot: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(path.dirname(file), '.aiwg-manifest.json'), 'utf8'));
    const record = receipt.managed?.[path.basename(file)];
    if (typeof record?.hash !== 'string' || typeof record.sourcePath !== 'string') return false;
    // Installation paths can change between releases. Resolve the recorded
    // bundled suffix against this package, never against the old installation.
    const suffix = record.sourcePath.replaceAll('\\', '/').match(/(?:^|\/)(agentic\/code\/.+)$/)?.[1];
    if (!suffix) return false;
    const source = path.resolve(frameworkRoot, suffix);
    const relative = path.relative(path.join(frameworkRoot, 'agentic/code'), source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const [deployed, canonical] = await Promise.all([fs.readFile(file), fs.readFile(source)]);
    if (record.hash !== hash(deployed)) return false;
    if (typeof record.sourceHash === 'string') return record.sourceHash === hash(canonical);
    // Historical skill-command receipts recorded only the output digest.
    // Compare their known generated formats, including metadata and body.
    if (record.sourceHash !== undefined || record.kind !== 'skill-command' || path.basename(source) !== 'SKILL.md') return false;
    return currentLegacySkillCommand(deployed.toString('utf8'), canonical.toString('utf8'), source);
  } catch {
    // Legacy, unreadable, or incomplete receipts retain the conservative stamp check.
    return false;
  }
}
