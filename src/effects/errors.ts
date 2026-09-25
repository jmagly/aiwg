/**
 * Effect ledger error taxonomy, bound to the v1 exit codes.
 *
 * Messages are fixed, reference-only text: they never echo payloads, keys,
 * vault locators or rejected material.
 *
 * @see docs/contracts/effect-ledger.v1.md "CLI and exit codes"
 */

/** Exit codes pinned by the effect ledger v1 contract. */
export const EFFECT_EXIT_CODES = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  absent: 3,
  unknown: 4,
  conflict: 5,
  integrity: 6,
  artifactRootUnavailable: 7,
} as const);

export type EffectExitCode = typeof EFFECT_EXIT_CODES[keyof typeof EFFECT_EXIT_CODES];

export type EffectLedgerErrorCode =
  | 'internal'
  | 'usage'
  | 'conflict'
  | 'integrity'
  | 'artifact-root-unavailable'
  | 'key-unavailable'
  | 'lock-timeout'
  | 'purge-refused';

const EXIT_BY_CODE: Record<EffectLedgerErrorCode, EffectExitCode> = {
  internal: EFFECT_EXIT_CODES.internal,
  usage: EFFECT_EXIT_CODES.usage,
  conflict: EFFECT_EXIT_CODES.conflict,
  integrity: EFFECT_EXIT_CODES.integrity,
  'artifact-root-unavailable': EFFECT_EXIT_CODES.artifactRootUnavailable,
  'key-unavailable': EFFECT_EXIT_CODES.internal,
  'lock-timeout': EFFECT_EXIT_CODES.internal,
  'purge-refused': EFFECT_EXIT_CODES.usage,
};

export class EffectLedgerError extends Error {
  readonly exitCode: EffectExitCode;
  constructor(readonly code: EffectLedgerErrorCode, message: string, readonly reason?: string) {
    super(message);
    this.name = 'EffectLedgerError';
    this.exitCode = EXIT_BY_CODE[code];
  }
  toJSON(): { code: EffectLedgerErrorCode; reason?: string; message: string; exitCode: EffectExitCode } {
    return { code: this.code, ...(this.reason ? { reason: this.reason } : {}), message: this.message, exitCode: this.exitCode };
  }
}

export const usageError = (message: string, reason?: string) => new EffectLedgerError('usage', message, reason);
export const integrityError = (reason: string, message = 'Effect ledger integrity check failed') => new EffectLedgerError('integrity', message, reason);
export const conflictError = (message = 'Effect ID already recorded with a different payload digest') => new EffectLedgerError('conflict', message, 'payload-digest-conflict');
