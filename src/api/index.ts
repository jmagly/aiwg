/**
 * Supported programmatic entry points for the installed AIWG package.
 *
 * `run()` dispatches through the same router used by `bin/aiwg.mjs`. Resource
 * helpers expose the signed web-release contract without requiring callers to
 * import private `dist/` paths.
 */
export { run } from '../cli/router.js';
export * from '../resources/index.js';
export * from '../sessions/index.js';
export * from '../memory/index.js';
export * from '../storage/index.js';
export * from '../security/threat-assessment-config.js';
export * from '../security/artifact-verifier.js';
export * from '../security/artifact-attestation.js';
export * from '../providers/transformation-receipt.js';
export * from '../providers/transformation-receipt-integration.js';
export * from '../marketplace/artifact-attestation.js';
export * from '../uhp/index.js';
export * from '../mission-protocol/index.js';
export * from '../governance/index.js';
export * from '../output-modes/index.js';
export * from '../writing/contextual-diagnostics.js';
export * from '../schema/index.js';
export * from '../dataset/index.js';
export * from '../network-analysis/index.js';
export * from '../decision/index.js';
export * from '../effects/index.js';
export {
  ARTIFACT_TRUST_ROOT_MEDIA_TYPE,
  ARTIFACT_TRUST_ROOT_SCHEMA_VERSION,
  ARTIFACT_TRUST_STATE_SCHEMA_VERSION,
  bootstrapTrustRoot,
  parseTrustRoot,
  parseTrustState,
  readTrustState,
  validateTrustRoot,
  validateTrustState,
  verifyRootTransition,
  writeTrustState,
  channelStateKey,
  canonicalJson,
  dssePae,
  publicKeyFingerprint,
  sha256,
  type ArtifactTrustRoot,
  type ArtifactTrustState,
  type RootBootstrapResult,
  type RootTransitionResult,
  type ArtifactTrustPolicySettings,
  type TrustedChannelState,
} from '../security/artifact-trust.js';

export * from '../writing/writer-profile.js';
export * from '../writing/writer-profile-store.js';
export * from '../writing/writer-profile-legacy.js';
export * from '../writing/exemplar-selection.js';
export * from '../writing/writing-brief.js';
export * from '../writing/fidelity.js';
export * from '../writing/voice-revision.js';
export * from '../writing/voice-evaluation.js';
export * from '../writing/writing-consumer.js';
export * from '../writing/writing-channels.js';
export * from '../writing/writing-receipt.js';
export * from '../writing/writer-migration.js';
