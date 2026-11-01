/**
 * Project-Local Doctor Section
 *
 * Builds the "Project-local artifacts" section for `aiwg doctor` output
 * per the spec at @.aiwg/architecture/design-doctor-log-promote.md (#1049).
 *
 * Pure function over (projectDir, frameworkRoot) — returns a string. The
 * doctor handler in src/cli/handlers/utilities.ts is responsible for
 * printing it. Section is fully suppressed when no project-local dirs
 * are present.
 *
 * @design @.aiwg/architecture/design-doctor-log-promote.md
 * @implements #1037
 */

import { join } from 'path';
import { readFile, readdir } from 'fs/promises';
import { discoverProjectLocalBundles } from './project-local-discovery.js';
import { parseRuleFrontmatter, formatRuleFrontmatterError } from '../rules/activation.mjs';
import { buildUpstreamRegistry } from './upstream-registry.js';
import { resolveShadows } from './shadow-resolver.js';
import { checkBundleManifestIgnored } from './project-local-gitignore.js';
import { sha256OfFileRawAndNormalized } from './managed-marker.js';
import type { ProjectLocalType } from './manifest.js';
import type { AiwgConfig } from '../config/aiwg-config.js';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { projectRelativePathIfInside } from './project-local-paths.js';
import { auditProjectQuickref } from './project-quickref.js';
import { artifactHashesForProvider, candidateDeployedPaths } from './project-local-remove.js';

export interface DoctorSectionResult {
  /** Pre-formatted multi-line section (empty string when no project-local content). */
  output: string;
  /** Count of validation errors found. */
  validationErrors: number;
  /** Count of denylist violations (refuse-unsafe / refuse-phantom / refuse-duplicate). */
  denylistViolations: number;
  /** Count of artifacts whose deployed file hash differs from the registered hash. */
  driftCount: number;
  /** Discovered bundles with no recorded deployment — usually an aborted deploy (#2503). */
  undeployedCount: number;
  /** True when the section had failing content (validation, denylist, drift). */
  hasFailures: boolean;
}

interface BuildOptions {
  projectDir: string;
  frameworkRoot: string;
  /** Optional pre-loaded config; if null/undefined we skip drift detection. */
  config: AiwgConfig | null;
  /** Suppress informational subsections (counts, shadows). */
  quiet?: boolean;
}

/**
 * Hash a deployed file in raw and managed-marker-normalized forms. Returns
 * null on read errors (e.g., file missing — caller treats as
 * deploy-not-present).
 *
 * Source files are recorded via the same normalization in
 * `hashBundleArtifacts()`, so the equivalence relation is symmetric.
 *
 * @implements #1086
 */
async function hashDeployed(absPath: string): Promise<{ raw: string; normalized: string } | null> {
  try {
    return await sha256OfFileRawAndNormalized(absPath);
  } catch {
    return null;
  }
}

const TYPES: readonly ProjectLocalType[] = ['extension', 'addon', 'framework', 'plugin', 'provider'];

const TYPE_DIR: Record<ProjectLocalType, string> = {
  extension: 'extensions',
  addon: 'addons',
  framework: 'frameworks',
  plugin: 'plugins',
  provider: 'providers',
};

/**
 * Rule files `aiwg use` validates at deploy time via the shared frontmatter
 * contract (`parseRuleFrontmatter` in `src/rules/activation.mjs`, #3728).
 * Mirrors deploy's selection for a bundle source root: top-level `rules/`
 * markdown (minus deploy's excluded/generated names) plus every
 * `BEHAVIOR.md` under `behaviors/`.
 */
const RULE_MD_EXCLUDED = new Set([
  'README.md', 'manifest.md', 'agent-template.md', 'openai-compat.md',
  'factory-compat.md', 'windsurf-compat.md', 'DEVELOPMENT_GUIDE.md',
]);

async function collectBundleRuleFiles(artifactPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(join(artifactPath, 'rules'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (RULE_MD_EXCLUDED.has(entry.name)) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.soul.md') || lower.endsWith('.core.md')) continue;
      if (/^(RULES-INDEX|RULES-ONDEMAND)\.(md|mdc)$/.test(entry.name)) continue;
      files.push(join(artifactPath, 'rules', entry.name));
    }
  } catch {
    // Absent rules dir — nothing to validate.
  }
  const walkBehaviors = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walkBehaviors(full);
      else if (entry.isFile() && entry.name === 'BEHAVIOR.md') files.push(full);
    }
  };
  await walkBehaviors(join(artifactPath, 'behaviors'));
  return files;
}

export async function buildProjectLocalDoctorSection(
  opts: BuildOptions,
): Promise<DoctorSectionResult> {
  const { projectDir, frameworkRoot, config, quiet = false } = opts;

  const discovery = await discoverProjectLocalBundles(projectDir);
  const quickrefAudit = await auditProjectQuickref(projectDir, config?.providers ?? []);
  const quickrefErrors = [...quickrefAudit.errors];
  if (quickrefAudit.exists) {
    for (const name of ['quickref.json', 'quickref.config.json']) {
      const sourcePath = projectAiwgPath(projectDir, name);
      const quickrefRelPath = projectRelativePathIfInside(projectDir, sourcePath);
      const ignored = quickrefRelPath
        ? await checkBundleManifestIgnored(projectDir, quickrefRelPath)
        : null;
      if (ignored === true && quickrefRelPath) {
        quickrefErrors.push(`${quickrefRelPath} is ignored by git; operator project quickref input must be committed`);
      }
    }
  }

  // No project-local content → no section at all
  if (discovery.isEmpty && discovery.errors.length === 0 && !quickrefAudit.exists && quickrefErrors.length === 0) {
    return { output: '', validationErrors: 0, denylistViolations: 0, driftCount: 0, undeployedCount: 0, hasFailures: false };
  }

  const lines: string[] = ['', '── Project-local artifacts ────────────────────────────────────'];

  // Counts
  if (!quiet) {
    lines.push(`  Discovered: ${discovery.bundles.length} bundle${discovery.bundles.length === 1 ? '' : 's'}`);
    for (const t of TYPES) {
      const dirName = TYPE_DIR[t];
      const ofType = discovery.bundles.filter(b => b.type === t);
      if (ofType.length === 0 && discovery.bundles.length > 0) continue;
      const idList = ofType.length > 0 ? `  (${ofType.map(b => b.id).join(', ')})` : '';
      lines.push(`    ${dirName.padEnd(11)} ${ofType.length}${idList}`);
    }
    lines.push('');
    if (quickrefAudit.exists) {
      lines.push(`  Project quickref: ${quickrefAudit.skillName ?? 'invalid source'}`);
      lines.push('');
    }
  }

  // Rule frontmatter validation (#3728): the same validator `aiwg use`
  // applies at deploy time, so a bundle that would fail deployment is
  // flagged here instead of passing with a clean bill of health.
  const ruleErrors: string[] = [];
  for (const bundle of discovery.bundles) {
    for (const file of await collectBundleRuleFiles(bundle.artifactPath)) {
      let content: string;
      try {
        content = await readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseRuleFrontmatter(content);
      if (!parsed.valid) {
        ruleErrors.push(formatRuleFrontmatterError(
          projectRelativePathIfInside(projectDir, file) ?? file,
          parsed.data,
          parsed.diagnostics,
        ));
      }
    }
  }

  // Validation
  const validationErrors = discovery.errors.length + quickrefErrors.length + ruleErrors.length;
  if (validationErrors === 0) {
    if (!quiet) lines.push(`  Validation: ✓ all manifests${quickrefAudit.exists ? ' and project quickref source' : ''} valid`);
  } else {
    lines.push(`  Validation: ✗ ${validationErrors} error${validationErrors === 1 ? '' : 's'}`);
    for (const e of discovery.errors.slice(0, 10)) {
      lines.push(`    ✗ ${e.path}: ${e.field} — ${e.actual}`);
    }
    const quickrefShown = quickrefErrors.slice(0, Math.max(0, 10 - discovery.errors.length));
    for (const error of quickrefShown) {
      lines.push(`    ✗ ${error}`);
    }
    const ruleShown = ruleErrors.slice(0, Math.max(0, 10 - discovery.errors.length - quickrefShown.length));
    for (const error of ruleShown) {
      lines.push(`    ✗ ${error}`);
    }
    if (validationErrors > 10) {
      lines.push(`    + ${validationErrors - 10} more (run 'aiwg list --project-local' for full list)`);
    }
  }
  lines.push('');

  // Shadows + denylist
  let denylistViolations = 0;
  // Bundles the resolver deliberately refused are already reported below as
  // denylist violations; the undeployed check must not double-count them.
  const refusedBundleIds = new Set<string>();
  if (discovery.bundles.length > 0) {
    try {
      const upstream = await buildUpstreamRegistry({ frameworkRoot });
      const shadowResult = await resolveShadows(discovery.bundles, upstream);
      const refusals = shadowResult.resolutions.filter(
        r => r.verdict === 'refuse-unsafe' || r.verdict === 'refuse-phantom' || r.verdict === 'refuse-duplicate',
      );
      denylistViolations = refusals.length;
      for (const refusal of refusals) refusedBundleIds.add(refusal.bundleId);

      if (!quiet) {
        const informational = shadowResult.shadows.filter(
          s => s.verdict === 'deploy-with-warning' || s.verdict === 'deploy-acknowledged',
        );
        if (informational.length > 0) {
          lines.push(`  Shadows (${informational.length}):`);
          for (const s of informational) {
            const marker = s.verdict === 'deploy-acknowledged' ? '!!' : '⚠';
            const note = s.verdict === 'deploy-acknowledged' ? '  overrides safety-critical (acknowledged)' : `  overrides ${s.upstream?.source ?? 'upstream'}`;
            lines.push(`    ${marker} ${s.bundleId} :: ${s.artifactType}/${s.artifactId}${note}`);
          }
          lines.push('');
        }
      }

      if (refusals.length > 0) {
        lines.push(`  Denylist violations (${refusals.length}):`);
        for (const r of refusals) {
          lines.push(`    ✗ ${r.bundleId} :: ${r.artifactType}/${r.artifactId}  [${r.verdict}]`);
        }
        lines.push('');
      } else if (!quiet) {
        lines.push('  Denylist violations: 0');
        lines.push('');
      }
    } catch {
      // Shadow resolution failure is non-fatal for doctor
    }
  }

  // Drift detection (requires config and artifactHashes)
  let driftCount = quickrefAudit.drift.length;
  const driftLines: string[] = quickrefAudit.drift.map(message => `    ✗ project quickref :: ${message}`);
  let unhashedSeen = false;
  if (config) {
    for (const bundle of discovery.bundles) {
      const entry = config.installed[bundle.id];
      if (!entry || entry.source !== 'project-local') continue;
      if (!entry.artifactHashes && !entry.deployedArtifactHashes) {
        unhashedSeen = true;
        continue;
      }
      for (const provider of Object.keys(entry.deployedTo)) {
        const hashes = artifactHashesForProvider(entry, provider);
        for (const [sourceRel, expectedHash] of Object.entries(hashes)) {
          let actualHash: { raw: string; normalized: string } | null = null;
          for (const deployedAbs of candidateDeployedPaths(projectDir, provider, sourceRel)) {
            actualHash = await hashDeployed(deployedAbs);
            if (actualHash) break;
          }
          if (actualHash === null) {
            // Missing — not drift, deploy is just absent
            continue;
          }
          // "Differs from source" must be judged against the source, not only
          // against whichever rendering the registry recorded. A bundle can be
          // (re)deployed through a path that writes the source verbatim plus
          // the managed marker after the registry captured a transformed copy;
          // the deployed file then matches its source line-for-line while the
          // recorded hash never will (#2560). Accept the recorded deployed
          // hash, the recorded source hash, or the current source file.
          const accepted = new Set<string>([expectedHash]);
          const recordedSourceHash = entry.artifactHashes?.[sourceRel];
          if (recordedSourceHash) accepted.add(recordedSourceHash);
          const currentSourceHash = await hashDeployed(join(bundle.artifactPath, sourceRel));
          if (currentSourceHash) accepted.add(currentSourceHash.normalized);
          if (!accepted.has(actualHash.normalized) && !accepted.has(actualHash.raw)) {
            driftCount++;
            driftLines.push(`    ✗ ${bundle.id} :: ${sourceRel} @ ${provider}  (deployed file differs from source)`);
          }
        }
      }
    }
  }

  if (driftCount > 0) {
    lines.push(`  Drift (${driftCount}):`);
    lines.push(...driftLines);
    lines.push('');
  } else if (!quiet) {
    lines.push('  Drift: 0');
    if (unhashedSeen) {
      lines.push('    (some entries lack artifactHashes — re-run `aiwg use <bundle>` to record)');
    }
    lines.push('');
  }

  // Undeployed bundles (#2503).
  //
  // A bundle whose deploy aborted (a bad support-asset reference, a failed CLI
  // contribution) leaves no `installed` entry, so every check above — manifest
  // validation, drift — silently skips it and reports a clean bill of health
  // for a bundle that is not actually available. The only prior signal was a
  // WARN line in `aiwg use` output, long scrolled away by the time anyone
  // wonders where the skill went.
  const undeployed = config
    ? discovery.bundles.filter((bundle) => {
      if (refusedBundleIds.has(bundle.id)) return false;
      const entry = config.installed[bundle.id];
      return !entry || entry.source !== 'project-local';
    })
    : [];
  if (undeployed.length > 0) {
    lines.push(`  Deployment: ✗ ${undeployed.length} discovered bundle${undeployed.length === 1 ? '' : 's'} not deployed`);
    for (const bundle of undeployed.slice(0, 5)) {
      lines.push(`    ✗ ${bundle.type}/${bundle.id} (${bundle.localPath}) — no deployment recorded`);
    }
    if (undeployed.length > 5) lines.push(`    + ${undeployed.length - 5} more`);
    lines.push(`    Run \`aiwg use ${undeployed[0].id}\` and read the output — a deploy that`);
    lines.push('    fails reports the reason there.');
    lines.push('');
  } else if (!quiet && config && discovery.bundles.length > 0) {
    lines.push('  Deployment: ✓ all discovered bundles deployed');
    lines.push('');
  }

  // Provider deployment matrix
  if (!quiet && config) {
    const projectLocalEntries = Object.entries(config.installed).filter(
      ([, e]) => e.source === 'project-local',
    );
    if (projectLocalEntries.length > 0) {
      const allProviders = new Set<string>();
      for (const [, entry] of projectLocalEntries) {
        for (const p of Object.keys(entry.deployedTo)) allProviders.add(p);
      }
      const provList = [...allProviders].sort();

      if (provList.length > 0) {
        lines.push('  Provider deployment matrix:');
        lines.push(`    ${'bundle'.padEnd(20)}${provList.map(p => p.padEnd(8)).join('')}`);
        for (const [name, entry] of projectLocalEntries) {
          const cells = provList.map(p => {
            const c = entry.deployedTo[p];
            if (!c) return '-'.padEnd(8);
            const total = (c.agents ?? 0) + (c.commands ?? 0) + (c.skills ?? 0) + (c.rules ?? 0);
            return `✓ ${total}`.padEnd(8);
          }).join('');
          lines.push(`    ${name.padEnd(20)}${cells}`);
        }
        lines.push('');
      }
    }
  }

  // #1085 — flag bundles whose source is silently git-ignored. Best-effort
  // (uses `git check-ignore`); skipped silently outside git repos.
  let gitignoredCount = 0;
  if (discovery.bundles.length > 0) {
    const ignored: string[] = [];
    for (const b of discovery.bundles) {
      const manifestRelPath = projectRelativePathIfInside(projectDir, join(b.bundlePath, 'manifest.json'));
      const isIgnored = manifestRelPath
        ? await checkBundleManifestIgnored(projectDir, manifestRelPath)
        : null;
      if (isIgnored === true) ignored.push(`${b.type}/${b.id} (${manifestRelPath})`);
    }
    gitignoredCount = ignored.length;
    if (ignored.length > 0) {
      lines.push(`  Git tracking: ✗ ${ignored.length} bundle${ignored.length === 1 ? '' : 's'} silently ignored`);
      for (const i of ignored.slice(0, 5)) {
        lines.push(`    ✗ ${i}`);
      }
      if (ignored.length > 5) {
        lines.push(`    + ${ignored.length - 5} more`);
      }
      lines.push('    Project-local bundle source should be tracked. Add to .gitignore:');
      lines.push('      !.aiwg/quickref.json');
      lines.push('      !.aiwg/quickref.config.json');
      lines.push('      !.aiwg/addons/');
      lines.push('      !.aiwg/extensions/');
      lines.push('      !.aiwg/frameworks/');
      lines.push('      !.aiwg/plugins/');
      lines.push('    Or run `aiwg new-bundle <name>` to have AIWG add this block automatically.');
      lines.push('');
    } else if (!quiet) {
      lines.push('  Git tracking: ✓ all bundle manifests visible to git');
      lines.push('');
    }
  }

  const hasFailures = validationErrors > 0 || denylistViolations > 0 || driftCount > 0
    || gitignoredCount > 0 || undeployed.length > 0;
  return {
    output: lines.join('\n'),
    validationErrors,
    denylistViolations,
    driftCount,
    undeployedCount: undeployed.length,
    hasFailures,
  };
}

/** Convenience accessor: just the section text. */
export async function projectLocalDoctorSection(
  projectDir: string,
  frameworkRoot: string,
  config: AiwgConfig | null,
  quiet = false,
): Promise<string> {
  const r = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config, quiet });
  return r.output;
}
