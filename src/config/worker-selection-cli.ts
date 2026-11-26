// Keep model-owned defaults out of project config set/reset, including future policy keys.
import { AiwgError, EXIT_CODES } from '../cli/errors.js';

export function assertProjectConfigOwnership(key: string): void {
  if (key === 'defaults' || key.startsWith('defaults.')) {
    throw new AiwgError({
      code: 'ERR_INVALID_KEY',
      message: `Project model preferences '${key}' belong in models.json, not aiwg.config.`,
      hint: 'Edit project-root models.json through the reviewed worker policy proposal/apply path.',
      exitCode: EXIT_CODES.USAGE,
    });
  }
}
