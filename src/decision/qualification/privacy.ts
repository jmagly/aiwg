/** Qualification canary scan of sanitized text captures. Never put the canary value in diagnostics. */
export const QUALIFICATION_PRIVACY_SURFACES = [
  'stdout', 'stderr', 'test-report', 'trace', 'receipt', 'snapshot', 'export', 'thrown-error',
  // Host-visible runtime activity: evidence callbacks, admission/prefix evidence and audit records.
  'activity-record',
] as const;
export type QualificationPrivacySurface = typeof QUALIFICATION_PRIVACY_SURFACES[number];

export interface QualificationPrivacyCapture {
  surface: QualificationPrivacySurface;
  /** Already-captured bytes, including an empty string for an observed empty surface. */
  content: string | Uint8Array;
}

export interface QualificationPrivacyScan {
  clean: boolean;
  missing: QualificationPrivacySurface[];
  affected: QualificationPrivacySurface[];
}

/**
 * Scans raw and JSON-escaped spellings on each observed surface. An omitted
 * surface is not assumed empty, and an empty canary list cannot prove privacy.
 * The caller must collect streams/errors at their actual source; this function
 * cannot infer that a supplied capture covers the whole process lifetime.
 */
export function scanQualificationPrivacy(
  captures: readonly QualificationPrivacyCapture[],
  canaries: readonly string[],
): QualificationPrivacyScan {
  const missing: QualificationPrivacySurface[] = [];
  const affected: QualificationPrivacySurface[] = [];
  if (!canaries.length || canaries.some(value => typeof value !== 'string' || !value.length)) {
    throw new Error('qualification privacy scan requires nonempty synthetic canaries');
  }
  const known = new Set<string>(QUALIFICATION_PRIVACY_SURFACES);
  const bySurface = new Map<QualificationPrivacySurface, string>();
  for (const item of captures) {
    if (!known.has(item.surface) || bySurface.has(item.surface)) {
      throw new Error('qualification privacy capture has unknown or duplicate surface');
    }
    if (typeof item.content !== 'string' && !(item.content instanceof Uint8Array)) {
      throw new Error('qualification privacy capture requires text or bytes');
    }
    bySurface.set(item.surface, typeof item.content === 'string' ? item.content : new TextDecoder().decode(item.content));
  }
  for (const surface of QUALIFICATION_PRIVACY_SURFACES) {
    const content = bySurface.get(surface);
    if (content === undefined) {
      missing.push(surface);
    } else if (canaries.some(canary => content.includes(canary) || content.includes(JSON.stringify(canary).slice(1, -1)))) {
      affected.push(surface);
    }
  }
  return { clean: !missing.length && !affected.length, missing, affected };
}
