// Capture a declared judgment artifact while its isolated attempt staging directory exists.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './pilot-files.js';
import type { Observation } from './judge-types.js';

const confined = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function captureJudgmentArtifact(observation: Observation, stagingDir: string) {
  let envelope: any;
  try { envelope = JSON.parse(observation.content); } catch { return; }
  if (envelope?.version !== 1 || !envelope.status || typeof envelope.summary !== 'string') return;
  // Empty artifacts retain the historical JSON-in-summary form.
  if (envelope.artifacts === undefined || Array.isArray(envelope.artifacts) && !envelope.artifacts.length) return;
  try {
    if (!Array.isArray(envelope.artifacts) || envelope.artifacts.length !== 1) {
      throw new Error('Worker envelope must declare exactly one JSON artifact');
    }
    const artifact = envelope.artifacts[0];
    if (typeof artifact?.path !== 'string' || !artifact.path || path.extname(artifact.path).toLowerCase() !== '.json') {
      throw new Error('Judgment artifact path must name a JSON file');
    }
    const root = await realpath(stagingDir);
    const target = path.resolve(root, artifact.path);
    if (!confined(root, target)) throw new Error('Judgment artifact path escapes attempt staging directory');
    const canonical = await realpath(target);
    if (!confined(root, canonical)) throw new Error('Judgment artifact symlink escapes attempt staging directory');
    if (!(await stat(canonical)).isFile()) throw new Error('Judgment artifact must be a regular JSON file');
    const bytes = await readFile(canonical);
    const actual = hash(bytes);
    observation.judgmentArtifact = bytes;
    observation.settings.judgment_artifact = { ref: 'judgment-artifact.json', digest: actual,
      declared_path: artifact.path, declared_digest: artifact.digest ?? null };
    if (typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
      throw new Error('Judgment artifact digest must be sha256 followed by 64 lowercase hex characters');
    }
    if (actual !== artifact.digest) throw new Error(`Judgment artifact digest mismatch: declared ${artifact.digest}, actual ${actual}`);
  } catch (error) {
    observation.judgmentError = error instanceof Error ? error.message : String(error);
  }
}
