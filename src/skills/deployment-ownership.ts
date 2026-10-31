// Verify managed projection ownership before discovery or mutation.
import fs from 'node:fs';
import path from 'node:path';
import type { Platform } from '../agents/types.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { AGENT_SKILLS_SIDECAR_SCHEMA } from './agent-skills.js';
import {
  AGENT_SKILL_DEPLOYMENT_SIDECAR, AGENT_SKILL_MANAGED_MARKER, MARKER_CONTENT,
  type DeploymentSidecar,
} from './deployment-types.js';

export function readDeploymentSidecar(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): DeploymentSidecar | undefined {
  try {
    const sidecarPath = path.join(targetPath, AGENT_SKILL_DEPLOYMENT_SIDECAR);
    const stat = fs.lstatSync(sidecarPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as DeploymentSidecar;
    if (
      value.schemaVersion !== 1
      || value.kind !== 'aiwg-managed-agent-skill-projection'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
      || !normalizeProviderDefinitionId(value.provider)
      || !/^[0-9a-f]{64}$/.test(value.sourceDigest)
      || !['native', 'projected', 'degraded', 'unsupported'].includes(
        value.projectionStatus,
      )
      || !Array.isArray(value.reasons)
      || !value.reasons.every((item) => typeof item === 'string')
      || !Array.isArray(value.warnings)
      || !value.warnings.every((item) => typeof item === 'string')
      || value.portable?.$schema !== AGENT_SKILLS_SIDECAR_SCHEMA
      || value.portable.schemaVersion !== 1
      || typeof value.portable.aiwg !== 'object'
      || value.portable.aiwg === null
      || Array.isArray(value.portable.aiwg)
      || value.portable.provenance?.sourceDigest !== value.sourceDigest
      || !['strict', 'compatible', 'discovery'].includes(
        value.portable.validationProfile,
      )
      || !['untrusted', 'trusted', 'revoked'].includes(
        value.portable.trust?.state,
      )
      || !['inactive', 'active', 'blocked'].includes(
        value.portable.trust?.activation,
      )
      || (expectedName !== undefined && value.name !== expectedName)
      || (expectedProvider !== undefined && value.provider !== expectedProvider)
      || path.basename(targetPath) !== value.name
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Codex, Antigravity, DeepSeek Harness, Flue, and Muse intentionally consume the
 * same portable project skill surface (<repo>/.agents/skills). A projection
 * written for any member is managed ownership for the others when the
 * desired payload is otherwise byte-identical.
 */
export function providersShareProjectionSurface(
  actual: Platform,
  expected: Platform,
): boolean {
  const shared = new Set<Platform>(['antigravity', 'codex', 'deepseek-harness', 'flue', 'muse']);
  return actual === expected || (shared.has(actual) && shared.has(expected));
}

export function isManagedTarget(
  targetPath: string,
  expectedName?: string,
  expectedProvider?: Platform,
): boolean {
  if (!fs.existsSync(targetPath)) return false;
  try {
    const targetStat = fs.lstatSync(targetPath);
    const marker = path.join(targetPath, AGENT_SKILL_MANAGED_MARKER);
    const sidecar = readDeploymentSidecar(targetPath, expectedName);
    return (
      targetStat.isDirectory()
      && !targetStat.isSymbolicLink()
      && fs.lstatSync(marker).isFile()
      && !fs.lstatSync(marker).isSymbolicLink()
      && fs.readFileSync(marker, 'utf8') === MARKER_CONTENT
      && sidecar !== undefined
      && (expectedProvider === undefined
        || providersShareProjectionSurface(sidecar.provider, expectedProvider))
    );
  } catch {
    return false;
  }
}

