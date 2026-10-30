// Preserve source skill ownership when emitting command wrappers and prompts.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFrameworkSlug, mergeArtifactOwnership } from '../providers/skill-ownership.mjs';

export async function recordManagedCommands(
  targetDir: string,
  entries: { filename: string; content: string; sourcePath: string }[],
  version: string,
  source: string,
): Promise<void> {
  if (!entries.length) return;
  const sidecarPath = path.join(targetDir, '.aiwg-manifest.json');
  let receipt: { managed: Record<string, any> } = { managed: {} };
  try { receipt = JSON.parse(await fs.readFile(sidecarPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    let skill;
    try { skill = JSON.parse(await fs.readFile(path.join(path.dirname(entry.sourcePath), '.aiwg-manifest.json'), 'utf8')); }
    catch { /* Canonical sources may not be deployed skills. */ }
    const sourceEntry = skill?.managed?.['SKILL.md'];
    const owners = sourceEntry?.owners || [sourceEntry?.frameworkSlug
      || extractFrameworkSlug(`${skill?.skillSource}/SKILL.md`) || extractFrameworkSlug(entry.sourcePath) || source];
    const record = { hash: `sha256:${createHash('sha256').update(entry.content).digest('hex')}`,
      source, version, kind: 'skill-command', sourcePath: entry.sourcePath,
      frameworkSlug: sourceEntry?.frameworkSlug || extractFrameworkSlug(`${skill?.skillSource}/SKILL.md`) || extractFrameworkSlug(entry.sourcePath) || owners[0] };
    receipt.managed[entry.filename] = owners.reduce((current: any, owner: string) =>
      mergeArtifactOwnership(receipt.managed[entry.filename], current, owner), record);
  }
  await fs.writeFile(sidecarPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
