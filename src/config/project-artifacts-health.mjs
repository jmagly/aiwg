/**
 * Deterministic health audit for projects whose artifact corpus is external.
 *
 * The repository-local `.aiwg` directory is the control plane. The configured
 * artifact root is the corpus. This audit deliberately does not mutate either.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_PROJECT_AIWG_DIR,
  PROJECT_AIWG_LOCATION_FILE,
  readProjectArtifactLocation,
  resolveProjectAiwgDir,
} from './project-artifacts-runtime.mjs';

export const PROJECT_CONTROL_PLANE_FILES = Object.freeze([
  'AIWG.md',
  'aiwg.config',
  join('frameworks', 'registry.json'),
]);

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
];

function configuredSource(projectDir, env) {
  for (const key of ARTIFACT_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key].trim()) return { kind: 'environment', key };
  }
  if (readProjectArtifactLocation(projectDir)) return { kind: 'pointer', path: join(projectDir, PROJECT_AIWG_LOCATION_FILE) };
  return { kind: 'default' };
}

function listFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
    }
  };
  visit(root);
  return files.sort();
}

function sameFile(left, right) {
  return existsSync(left) && existsSync(right) && readFileSync(left).equals(readFileSync(right));
}

export function auditProjectArtifactHealth(projectDir, env = process.env) {
  const root = resolve(projectDir);
  const localRoot = join(root, DEFAULT_PROJECT_AIWG_DIR);
  const artifactRoot = resolveProjectAiwgDir(root, env);
  const source = configuredSource(root, env);
  const externalConfigured = resolve(localRoot) !== resolve(artifactRoot);
  const externalReachable = existsSync(artifactRoot) && statSync(artifactRoot).isDirectory();

  const controls = PROJECT_CONTROL_PLANE_FILES.map((file) => {
    const localPath = join(localRoot, file);
    const externalPath = join(artifactRoot, file);
    const local = existsSync(localPath);
    const external = externalReachable && existsSync(externalPath);
    return { file: file.split(sep).join('/'), local, external, identical: local && external ? sameFile(localPath, externalPath) : null };
  });
  const missingLocal = controls.filter((item) => !item.local).map((item) => item.file);
  const divergentControl = controls.filter((item) => item.identical === false).map((item) => item.file);
  const localPayload = listFiles(localRoot).filter((file) => !PROJECT_CONTROL_PLANE_FILES.includes(file));
  const divergentPayload = externalReachable
    ? localPayload.filter((file) => !sameFile(join(localRoot, file), join(artifactRoot, file)))
    : [];

  let classification = 'local';
  let severity = 'ok';
  let repairable = false;
  let action = null;

  if (externalConfigured) {
    if (!externalReachable) {
      classification = 'degraded-offline';
      severity = missingLocal.length ? 'error' : 'warning';
      action = 'Reconnect or attach the external corpus, then run `aiwg artifacts repair --dry-run`.';
    } else if (missingLocal.length) {
      classification = 'legacy-missing-control-plane';
      severity = 'error';
      repairable = controls.filter((item) => !item.local).every((item) => item.external);
      action = 'Run `aiwg artifacts repair --dry-run`, then `aiwg artifacts repair --apply` after reviewing the plan.';
    } else if (divergentControl.length) {
      // Only control-plane divergence is genuinely manual: `repairProjectArtifacts`
      // refuses outright on it, because AIWG.md / aiwg.config / registry.json have
      // no safe automatic winner (#2516).
      classification = 'duplicated-divergent';
      severity = 'error';
      action = 'Reconcile the reported control-plane files manually; automatic repair refuses while they diverge.';
    } else if (divergentPayload.length) {
      // Divergent *payload* is repairable and always has been — repair archives the
      // local variant under archive/local-corpus-migration/conflicts/local/, leaves
      // the external variant untouched, and removes local only after byte
      // verification. Reporting this as manual-only steered operators away from a
      // working automatic path and into hand-migrating corpora (#2516).
      classification = 'duplicated-divergent-payload';
      severity = 'warning';
      repairable = true;
      action = 'Run `aiwg artifacts repair --dry-run`, then `aiwg artifacts repair --apply`; divergent local variants are archived, never overwritten.';
    } else if (localPayload.length) {
      classification = 'duplicated-identical';
      severity = 'warning';
      repairable = true;
      action = 'Run `aiwg artifacts repair --dry-run`, then `aiwg artifacts repair --apply` to remove identical local corpus duplicates.';
    } else {
      classification = 'healthy-split-root';
      severity = 'ok';
    }
  }

  return {
    classification,
    severity,
    external_configured: externalConfigured,
    source,
    local_control_root: localRoot,
    artifact_root: artifactRoot,
    external_reachable: externalReachable,
    control_files: controls,
    missing_local_control_files: missingLocal,
    divergent_control_files: divergentControl,
    duplicated_local_corpus_files: localPayload.map((file) => file.split(sep).join('/')),
    divergent_local_corpus_files: divergentPayload.map((file) => file.split(sep).join('/')),
    repairable,
    action,
  };
}
