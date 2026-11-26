// Validates and serializes writes through the existing models.json owner.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateUserProjectModelConfig } from './provider-policy.js';
import { atomicConfigWrite as atomicWrite, withWorkerWriteLock } from '../config/worker-write.js';
export async function updateJson(file: string, mutate: (value: Record<string, any>) => void, dryRun: boolean,
  validateCandidate?: (value: Record<string, any>) => Promise<void>) {
  const update = async () => {
    let value: Record<string, any> = {};
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    mutate(value);
    const validation = validateUserProjectModelConfig(value);
    if (!validation.valid) throw new Error(validation.diagnostics.map(item => item.message).join('; '));
    await validateCandidate?.(value);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (!dryRun) await atomicWrite(file, content);
    return { file, beforeWrite: value, dryRun };
  };
  return dryRun ? update() : withWorkerWriteLock(path.dirname(file), update);
}
