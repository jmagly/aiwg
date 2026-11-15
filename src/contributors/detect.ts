/**
 * Contributor Detection Runner
 *
 * Runs a contributor's declarative detection spec against the project root.
 * Determines whether the contributor's framework is *in use* on this project,
 * not just installed. Pure I/O — no code execution.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #938
 */

import { glob } from 'glob';
import type { DetectionSpec } from './types.js';

/**
 * Run a contributor's detection spec. Returns the count of files matching
 * any glob pattern (with deduplication). The caller compares against
 * `spec.minCount` to decide in-use status.
 */
export async function runDetection(spec: DetectionSpec, projectRoot: string): Promise<number> {
  const seen = new Set<string>();
  for (const pattern of spec.glob) {
    const matches = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      dot: false,
      absolute: false,
    });
    for (const m of matches) seen.add(m);
  }
  return seen.size;
}

/**
 * Convenience wrapper: returns true when match count meets minCount (default 1).
 */
export async function isInUse(spec: DetectionSpec, projectRoot: string): Promise<boolean> {
  const min = spec.minCount ?? 1;
  const count = await runDetection(spec, projectRoot);
  return count >= min;
}
