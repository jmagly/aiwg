// Recognize a package-mode deployment without requiring copied skill directories.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readAiwgConfig } from '../config/aiwg-config.js';
export async function hasFluePackageDeployment(project: string): Promise<boolean> {
  const config = await readAiwgConfig(project);
  if (!Object.values(config?.installed ?? {}).some(entry => entry.deployedTo.flue?.package)) return false;
  try {
    const source = await readFile(path.join(project, 'src/aiwg/skills.ts'), 'utf8');
    return /from ['"]@aiwg\/flue\/skills\/[^'"\n]+\/SKILL\.md['"]/.test(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
