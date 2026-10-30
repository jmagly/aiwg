// Shared provider skill copy utilities.
import { canDeploySkill, extractFrameworkSlug, fs, path, pruneRecordedSkillFiles, releaseSkillOwnership } from './base-runtime.mjs';
import { contentHash, ensureDir, readSidecarManifest, resolveFrameworkWorkspaceRoot, writeSidecarManifest } from './base-files.mjs';
import { PROVIDER_TO_PLATFORM, injectPlatformInContent, skillMatchesProvider } from './base-models-platforms.mjs';
import { injectBoundRules } from './base-contract.mjs';
import { getFrameworksForMode } from './base-framework-discovery.mjs';


/** Source-scoped cleanup also works when a removed standard skill is absent from this deploy's input. */
export function pruneMissingStandardSkills(destDir, opts) {
  if (!destDir || !opts?.srcRoot || opts.dryRun || !fs.existsSync(destDir)) return 0;
  const sourceRoot = path.resolve(opts.srcRoot);
  let pruned = 0;
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(destDir, entry.name);
    const receipt = readSidecarManifest(skillDir);
    if (!receipt?.skillSource || !receipt.managed?.['SKILL.md']) continue;
    const relative = path.relative(sourceRoot, receipt.skillSource);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      fs.statSync(path.join(receipt.skillSource, 'SKILL.md'));
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') continue;
    }
    if (releaseSkillOwnership(skillDir, {
      frameworkSlug: receipt.managed['SKILL.md'].frameworkSlug,
      skillSource: receipt.skillSource,
    }, opts)) pruned++;
  }
  return pruned;
}


/**
 * Deploy a skill directory (copy recursively).
 *
 * Platform handling (controlled by opts.provider):
 *   - If the skill's SKILL.md has platforms: [all] → deploy to all, inject [provider] in deployed copy
 *   - If no platforms: field → deploy to all, inject [provider] in deployed copy
 *   - If explicit restriction list → only deploy if opts.provider is in the list; keep list in deployed copy
 */
export function deploySkillDir(skillDir, destDir, opts) {
  const { force = false, dryRun = false, provider, transformSkillMd } = opts;
  const verbose = opts.verbose === true;
  const skillName = opts.skillName || path.basename(skillDir);

  // Check SKILL.md for explicit platform restriction before deploying anything
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (provider && fs.existsSync(skillMdPath)) {
    const skillContent = fs.readFileSync(skillMdPath, 'utf8');
    if (!skillMatchesProvider(skillContent, provider)) {
      if (verbose) console.log(`skip (platform restricted): ${skillName}`);
      return;
    }
  }

  const destSkillDir = path.join(destDir, skillName);
  const previous = readSidecarManifest(destSkillDir);
  const frameworkSlug = extractFrameworkSlug(opts.logicalInputPath?.(skillMdPath) || skillMdPath);
  if (!canDeploySkill(previous, skillDir, opts)) return false;
  const managed = {};
  if (!dryRun) ensureDir(destSkillDir);

  function copyRecursive(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!dryRun) ensureDir(destPath);
        copyRecursive(srcPath, destPath);
      } else {
        let srcContent = fs.readFileSync(srcPath, 'utf8');

        // Inject target platform into SKILL.md — replaces [all] token with [provider-name]
        if (entry.name === 'SKILL.md' && provider) {
          const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
          srcContent = injectPlatformInContent(srcContent, platformName);

          // Provider-specific frontmatter transform (e.g. Factory remaps
          // commandHint.allowedTools / commandHint.model). Optional callback —
          // most providers leave SKILL.md alone after platform injection.
          if (typeof transformSkillMd === 'function') {
            srcContent = transformSkillMd(srcContent, opts) || srcContent;
          }
        }

        if (entry.name === 'SKILL.md') srcContent = injectBoundRules(srcContent, srcPath, opts);

        const relative = path.relative(destSkillDir, destPath);
        managed[relative] = {
          hash: `sha256:${contentHash(srcContent)}`,
          source: opts.deploySource || 'bundled',
          version: opts.deployVersion || 'unknown',
          ...(frameworkSlug ? { frameworkSlug } : {}),
        };
        if (fs.existsSync(destPath)) {
          const destContent = fs.readFileSync(destPath, 'utf8');
          if (destContent === srcContent && !force) {
            if (verbose) console.log(`skip (unchanged): ${path.relative(destDir, destPath)}`);
            continue;
          }
        }

        if (dryRun) {
          console.log(`[dry-run] deploy ${srcPath} -> ${destPath}`);
        } else {
          fs.writeFileSync(destPath, srcContent, 'utf8');
          if (verbose) console.log(`deployed ${entry.name} -> ${path.relative(process.cwd(), destPath)}`);
        }
      }
    }
  }

  copyRecursive(skillDir, destSkillDir);
  pruneRecordedSkillFiles(destSkillDir, previous?.managed, new Set(Object.keys(managed)), opts);
  writeSidecarManifest(destSkillDir, { managed, skillSource: path.resolve(skillDir) }, dryRun);

  // Drop a `.aiwg-managed` marker so future cleanup runs can identify
  // AIWG-deployed skills regardless of frontmatter shape (some providers
  // strip `namespace:` during transform). Cleanup keys off this presence
  // to safely prune renamed/removed source skills.
  if (!dryRun) {
    try {
      fs.writeFileSync(path.join(destSkillDir, '.aiwg-managed'), 'aiwg\n', 'utf8');
    } catch { /* non-fatal */ }
  }

  if (verbose) console.log(`deployed skill: ${skillName}`);
}


// ============================================================================
// Workspace Initialization
// ============================================================================

/**
 * Initialize framework-scoped workspace structure
 * Creates .aiwg/frameworks/{framework-id}/ directories
 */
export function initializeFrameworkWorkspace(target, mode, dryRun, srcRoot = null) {
  const aiwgBase = resolveFrameworkWorkspaceRoot(target);
  const frameworksDir = path.join(aiwgBase, 'frameworks');
  const sharedDir = path.join(aiwgBase, 'shared');

  const frameworkDirs = srcRoot
    ? getFrameworksForMode(srcRoot, mode).map(fw => ({
      id: fw.id,
      path: fw.path,
      subdirs: fw.workspaceSubdirs,
      memoryCreates: Array.isArray(fw.manifest?.memory?.creates) ? fw.manifest.memory.creates : []
    }))
    : [];

  // Backward-compatible fallback when source root isn't provided.
  if (frameworkDirs.length === 0) {
    if (mode === 'sdlc' || mode === 'both' || mode === 'all') {
      frameworkDirs.push({
        id: 'sdlc-complete',
        subdirs: ['repo', 'projects', 'working', 'archive']
      });
    }

    if (mode === 'marketing' || mode === 'all') {
      frameworkDirs.push({
        id: 'media-marketing-kit',
        subdirs: ['repo', 'campaigns', 'working', 'archive']
      });
    }

    if (mode === 'media-curator' || mode === 'all') {
      frameworkDirs.push({
        id: 'media-curator',
        subdirs: ['repo', 'library', 'working', 'archive']
      });
    }

    if (mode === 'research' || mode === 'all') {
      frameworkDirs.push({
        id: 'research-complete',
        subdirs: ['repo', 'corpus', 'working', 'archive']
      });
    }
  }

  if (frameworkDirs.length === 0) return;

  if (dryRun) {
    console.log('\n[dry-run] Would create framework-scoped workspace structure:');
    console.log(`[dry-run]   ${aiwgBase}/`);
    console.log(`[dry-run]   ${frameworksDir}/`);
    console.log(`[dry-run]   ${sharedDir}/`);
    for (const fw of frameworkDirs) {
      for (const subdir of fw.subdirs) {
        console.log(`[dry-run]   ${path.join(frameworksDir, fw.id, subdir)}/`);
      }
      for (const entry of fw.memoryCreates || []) {
        if (entry && typeof entry.path === 'string') {
          console.log(`[dry-run]   ${path.join(aiwgBase, entry.path.slice('.aiwg/'.length))}${entry.path.endsWith('/') ? '/' : ''}`);
        }
      }
    }
    return;
  }

  ensureDir(aiwgBase);
  ensureDir(frameworksDir);
  ensureDir(sharedDir);

  for (const fw of frameworkDirs) {
    const fwBase = path.join(frameworksDir, fw.id);
    ensureDir(fwBase);
    for (const subdir of fw.subdirs) {
      ensureDir(path.join(fwBase, subdir));
    }
    initializeMemoryCreates(aiwgBase, fw.path, fw.memoryCreates);
  }

  // Initialize registry.json if it doesn't exist
  const registryPath = path.join(frameworksDir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    const registry = {
      version: '1.0.0',
      created: new Date().toISOString(),
      frameworks: frameworkDirs.map(fw => ({
        id: fw.id,
        installed: new Date().toISOString(),
        version: '1.0.0'
      }))
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    console.log('Created framework registry at .aiwg/frameworks/registry.json');
  }
}



export function initializeMemoryCreates(aiwgBase, frameworkPath, creates) {
  for (const entry of creates || []) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (!entry.path.startsWith('.aiwg/')) continue;

    const targetPath = path.join(aiwgBase, entry.path.slice('.aiwg/'.length));
    const isDirectory = entry.path.endsWith('/') || path.extname(entry.path) === '';
    if (isDirectory) {
      ensureDir(targetPath);
      continue;
    }

    ensureDir(path.dirname(targetPath));
    if (fs.existsSync(targetPath)) continue;

    let content = null;
    if (typeof entry.template === 'string' && frameworkPath) {
      const templatePath = path.join(frameworkPath, entry.template);
      if (fs.existsSync(templatePath)) {
        content = fs.readFileSync(templatePath, 'utf8');
      }
    }

    if (content === null) {
      const title = path.basename(entry.path, path.extname(entry.path))
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      content = '# ' + title + '\n\n';
    }

    fs.writeFileSync(targetPath, content.endsWith('\n') ? content : content + '\n', 'utf8');
  }
}
