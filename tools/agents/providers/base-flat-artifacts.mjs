// Shared provider flat artifacts utilities.
import { addManagedMarker, contentHash, readSidecarManifest, updateSidecarManifest, writeFile } from './base-files.mjs';
import { extractFrameworkSlug, fs, path } from './base-runtime.mjs';
import { injectBoundRules } from './base-contract.mjs';
import { PROVIDER_TO_PLATFORM, injectPlatformInContent, stripTriggersFromContent } from './base-models-platforms.mjs';
import { shouldReportDeployCollisions } from './base-frontmatter.mjs';


// ============================================================================
// File Deployment
// ============================================================================

/**
 * Deploy files to destination directory
 * Handles transformation via provider's transform function
 */
export function deployFiles(files, destDir, opts, transformFn) {
  const { force = false, dryRun = false, provider = 'claude', fileExtension = '.md', injectPlatform = false } = opts;
  const deployVersion = opts.deployVersion || 'unknown';
  const deploySource = opts.deploySource || 'bundled';
  // Map of dest path → first batch entry that claimed it. Used to detect
  // and report cross-framework collisions within a single deploy batch
  // (#1169). Each value: { src, frameworkSlug }
  const seen = new Map();
  const actions = [];
  // Collision report — one entry per detected cross-framework collision
  // (within-batch or against sidecar). Surfaced after the loop.
  const collisions = [];

  // Read sidecar manifest for hash-based skip-on-match (#749) and
  // cross-framework collision detection (#1169)
  const sidecar = readSidecarManifest(destDir);
  const sidecarManaged = sidecar?.managed || {};

  for (const f of files) {
    let base = path.basename(f);

    // Change extension if needed
    if (fileExtension !== '.md' && base.endsWith('.md')) {
      base = base.replace(/\.md$/, fileExtension);
    }

    let dest = path.join(destDir, base);
    const currentFrameworkSlug = extractFrameworkSlug(opts.logicalInputPath?.(f) || f);

    // Read and transform source content (needed for content-equality check
    // and the collision-vs-duplicate distinction)
    const srcContent = injectBoundRules(fs.readFileSync(f, 'utf8'), f, opts);
    let transformedContent = transformFn ? transformFn(f, srcContent, opts) : srcContent;

    // Rule triggers are index metadata, not something the reading agent needs.
    // Keyed on the source path so every provider's rule deploy gets it without
    // eight call sites opting in, and so skill triggers are never touched (#2544).
    if (/(?:^|[\\/])rules[\\/][^\\/]+$/.test(f)) {
      transformedContent = stripTriggersFromContent(transformedContent);
    }

    // Inject target platform into agent .md files that use platforms: [all]
    if (injectPlatform && provider && /platforms:\s*\[all\]/.test(transformedContent)) {
      const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
      transformedContent = injectPlatformInContent(transformedContent, platformName);
    }

    // Add managed marker for provider artifacts (#749). TOML accepts `#`
    // comments, which lets doctor attribute transformed Codex agents even
    // though their YAML frontmatter is removed during serialization.
    if (base.endsWith('.md') || base.endsWith('.mdc')) {
      transformedContent = addManagedMarker(transformedContent, deployVersion, deploySource);
    } else if (base.endsWith('.toml')) {
      transformedContent = addManagedMarker(
        transformedContent,
        deployVersion,
        deploySource,
        'line-comment',
      );
    }

    // Compute content hash for sidecar comparison
    const hash = contentHash(transformedContent);

    // Within-batch collision check (#1169). If a previous file in this
    // batch already claimed this dest, distinguish:
    //   - Same content (transform/normalize is idempotent) → silent skip
    //   - Same framework + different content → "duplicate" (legacy reason)
    //   - Different framework + different content → "collision"
    if (seen.has(dest)) {
      const prev = seen.get(dest);
      const prevContent = prev.transformedContent;
      if (prevContent === transformedContent) {
        actions.push({ type: 'skip', src: f, dest, reason: 'duplicate-identical', hash, frameworkSlug: currentFrameworkSlug });
        continue;
      }
      const prevSlug = prev.frameworkSlug;
      if (currentFrameworkSlug && prevSlug && currentFrameworkSlug !== prevSlug) {
        // Cross-framework collision within a single deploy batch — first
        // wins; second is skipped. `--force` keeps the first entry too,
        // since we have no principled way to pick a winner among peers.
        collisions.push({
          dest,
          filename: base,
          existingFramework: prevSlug,
          existingSrc: prev.src,
          incomingFramework: currentFrameworkSlug,
          incomingSrc: f,
          scope: 'within-batch',
        });
        actions.push({
          type: 'skip',
          src: f,
          dest,
          reason: 'collision',
          collidingFramework: prevSlug,
        });
        continue;
      }
      actions.push({ type: 'skip', src: f, dest, reason: 'duplicate' });
      continue;
    }

    // Skip-on-match: compare hash against sidecar manifest before reading dest file (#749)
    // Guard: only skip if the destination file still exists on disk. cleanupOldRuleFiles
    // may have deleted it before deployFiles runs, so the sidecar record is stale.
    if (!force && sidecarManaged[base]?.hash === `sha256:${hash}` && fs.existsSync(dest)) {
      const verified = contentHash(fs.readFileSync(dest)) === hash;
      actions.push({ type: 'skip', src: f, dest, reason: 'hash-match', ...(verified ? { hash, frameworkSlug: currentFrameworkSlug } : {}) });
      seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
      continue;
    }

    // Cross-batch collision check against sidecar (#1169). If the dest
    // file is already managed by a *different* framework than this deploy,
    // and the new content differs, refuse to silently overwrite.
    if (
      !force &&
      fs.existsSync(dest) &&
      sidecarManaged[base]?.frameworkSlug &&
      currentFrameworkSlug &&
      sidecarManaged[base].frameworkSlug !== currentFrameworkSlug
    ) {
      const destContent = fs.readFileSync(dest, 'utf8');
      if (destContent !== transformedContent) {
        collisions.push({
          dest,
          filename: base,
          existingFramework: sidecarManaged[base].frameworkSlug,
          existingSrc: null,
          incomingFramework: currentFrameworkSlug,
          incomingSrc: f,
          scope: 'cross-batch',
        });
        actions.push({
          type: 'skip',
          src: f,
          dest,
          reason: 'collision',
          collidingFramework: sidecarManaged[base].frameworkSlug,
        });
        // Don't claim the dest in `seen` — we did not deploy. The sidecar
        // entry already holds the previous framework's record and stays.
        continue;
      }
    }

    // Fallback: check destination file content directly
    if (!force && fs.existsSync(dest)) {
      const destContent = fs.readFileSync(dest, 'utf8');
      if (destContent === transformedContent) {
        actions.push({ type: 'skip', src: f, dest, reason: 'unchanged', hash, frameworkSlug: currentFrameworkSlug });
        seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
        continue;
      }
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'changed', hash, frameworkSlug: currentFrameworkSlug });
    } else if (force && fs.existsSync(dest)) {
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'forced', hash, frameworkSlug: currentFrameworkSlug });
    } else {
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'new', hash, frameworkSlug: currentFrameworkSlug });
    }
    seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
  }

  const verbose = opts.verbose === true;
  const deployedEntries = [];
  for (const a of actions) {
    if (a.type === 'deploy') {
      if (dryRun) console.log(`[dry-run] deploy ${a.src} -> ${a.dest} (${a.reason})`);
      else writeFile(a.dest, a.content, false);
      if (verbose) console.log(`deployed ${path.basename(a.src)} -> ${path.relative(process.cwd(), opts.logicalOutputPath?.(a.dest) || a.dest)} (${a.reason})`);
      deployedEntries.push({ filename: path.basename(a.dest), hash: a.hash, frameworkSlug: a.frameworkSlug, sourcePath: path.resolve(a.src) });
    } else if (a.type === 'skip') {
      if (verbose) console.log(`skip (${a.reason}): ${path.basename(a.dest)}`);
      // Preserve existing sidecar entries for skipped files
      if (a.hash) deployedEntries.push({ filename: path.basename(a.dest), hash: a.hash, frameworkSlug: a.frameworkSlug, sourcePath: path.resolve(a.src) });
    }
  }

  // Surface cross-framework collisions to the operator (#1169). Always
  // visible (not gated on verbose) because silent loss is the failure
  // mode this guard exists to prevent.
  if (collisions.length > 0 && shouldReportDeployCollisions(opts)) {
    const tag = force ? 'override' : 'skip';
    console.warn(
      `\n⚠ Cross-framework deploy collision${collisions.length > 1 ? 's' : ''} detected (${collisions.length}):`,
    );
    for (const c of collisions) {
      console.warn(
        `  ${c.filename}: ${c.existingFramework} owns this slot; ${c.incomingFramework} skipped (${c.scope})`,
      );
    }
    if (!force) {
      console.warn(
        `  Re-run with --force to override (last-wins) or rename the colliding file at framework source.`,
      );
    }
  }

  // Update sidecar manifest with deployed file hashes (#749) including
  // framework slug for future collision detection (#1169).
  if (deployedEntries.length > 0) {
    updateSidecarManifest(destDir, deployedEntries, { dryRun, version: deployVersion, source: deploySource });
  }

  return actions;
}


/**
 * Deploy .soul.md companion files alongside agents.
 * Soul files are copied as-is (no transformation) to the same directory as agents.
 */
export function deploySoulCompanions(soulFiles, destDir, opts) {
  if (!soulFiles || soulFiles.length === 0) return [];
  return deployFiles(soulFiles, destDir, opts, null);
}
