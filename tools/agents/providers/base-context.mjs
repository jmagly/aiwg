// Shared provider context utilities.
import { boundedExecFileSync, fs, helperEnvironment, path, writeContextFileSync } from './base-runtime.mjs';
import { listOnDemandRuleFiles, renderOnDemandRuleSection } from './base-rule-index.mjs';


// ============================================================================
// AGENTS.md Template Handling
// ============================================================================

/**
 * Build a Markdown "Repo Topology" block from .aiwg/aiwg.config remotes (#998).
 *
 * Returns an empty string when there's no `remotes` block configured — agents
 * should fall back to the today-default behavior in that case.
 *
 * The output is a small Markdown section suitable for token substitution into
 * AIWG.md / AGENTS.md / similar context files. URL resolution is best-effort:
 * when `git remote get-url <name>` fails (not a git repo, missing remote), the
 * remote name is shown without a URL.
 *
 * @param {string} targetDir - Project directory (the one that owns .aiwg/aiwg.config)
 * @returns {string} Markdown block (with leading/trailing blank lines), or '' when absent
 */
export function buildRemotesTopologyBlock(targetDir) {
  const cfgPath = path.join(targetDir, '.aiwg', 'aiwg.config');
  if (!fs.existsSync(cfgPath)) return '';

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return '';
  }
  if (!cfg || !cfg.remotes) return '';

  // Apply the same defaults as resolveRemotes() in src/config/aiwg-config.ts.
  // Inlined here so the deploy path doesn't depend on the compiled TS bundle.
  const primary = cfg.remotes.primary || 'origin';
  const issueTracker = cfg.remotes.issue_tracker || primary;
  const ci = cfg.remotes.ci || primary;
  const secondary = Array.isArray(cfg.remotes.secondary) ? cfg.remotes.secondary : [];

  function getUrl(remote) {
    try {
      return boundedExecFileSync('git', ['-C', targetDir, 'remote', 'get-url', '--', remote], 'quick', {
        env: helperEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  const lines = [];
  lines.push('## Repo Topology');
  lines.push('');
  lines.push('Agents: respect this when picking remotes/providers. From `.aiwg/aiwg.config` `remotes` block (#994).');
  lines.push('');
  const primaryUrl = getUrl(primary);
  const primarySuffix = primaryUrl ? ` (${primaryUrl})` : '';
  lines.push(`- **Primary**: \`${primary}\`${primarySuffix} — issues, PRs, CI live here`);
  if (issueTracker !== primary) {
    const u = getUrl(issueTracker);
    lines.push(`- **Issue tracker**: \`${issueTracker}\`${u ? ` (${u})` : ''}`);
  }
  if (ci !== primary) {
    const u = getUrl(ci);
    lines.push(`- **CI**: \`${ci}\`${u ? ` (${u})` : ''}`);
  }
  for (const sec of secondary) {
    if (!sec || !sec.name) continue;
    const u = getUrl(sec.name);
    const purpose = sec.purpose ? ` — ${sec.purpose}` : '';
    const releaseTag = sec.push_on_release ? ' (push tags on release)' : '';
    lines.push(`- **Secondary**: \`${sec.name}\`${u ? ` (${u})` : ''}${purpose}${releaseTag}`);
  }
  lines.push('');
  return lines.join('\n');
}


/**
 * Substitute the topology + count tokens in template content. Shared by the
 * Claude hook file and createAgentsMdFromTemplate so every consumer gets the
 * same {{REMOTES_TOPOLOGY}} treatment without each provider reinventing it.
 */
export function interpolateContextTokens(content, opts) {
  const counts = opts?.counts || {};
  const topology = opts?.topology || '';
  const onDemandRules = opts?.onDemandRules || '';
  return content
    .replace(/\{\{AGENTS_COUNT\}\}/g, String(counts.agents || 0))
    .replace(/\{\{COMMANDS_COUNT\}\}/g, String(counts.commands || 0))
    .replace(/\{\{SKILLS_COUNT\}\}/g, String(counts.skills || 0))
    .replace(/\{\{RULES_COUNT\}\}/g, String(counts.rules || 0))
    .replace(/\{\{REMOTES_TOPOLOGY\}\}/g, topology)
    .replace(/\{\{ON_DEMAND_RULES\}\}/g, onDemandRules);
}


/**
 * Create or update AGENTS.md from template
 * Common logic used by multiple providers
 */
// Managed-block markers (#1571). The AIWG SDLC section is wrapped in these so
// every later `aiwg use`/`aiwg refresh` can UPDATE it in place — append-once-and-
// skip meant existing AGENTS.md bridges never received content updates.
export const AIWG_MD_BEGIN = '<!-- BEGIN AIWG-managed (auto-generated; edits between these markers are overwritten on redeploy) -->';

export const AIWG_MD_END = '<!-- END AIWG-managed -->';


/**
 * Inject/update an AIWG-managed section in a workspace markdown file (AGENTS.md,
 * SOUL.md, …) from a template. Wraps the section in BEGIN/END markers and updates
 * in place on redeploy (no-op if unchanged), preserving operator content outside
 * the markers and migrating legacy unmarked sections. (#1571 / #1572)
 *
 * @param {string} target - directory containing the dest file
 * @param {string} destFilename - e.g. 'AGENTS.md' or 'SOUL.md'
 * @param {string} srcRoot
 * @param {string} templateSubpath - relative to sdlc-complete/templates
 * @param {boolean} dryRun
 * @param {{sectionMarker?: string, legacyHeading?: string}} [opts]
 */
export function createManagedMdFromTemplate(target, destFilename, srcRoot, templateSubpath, dryRun, opts = {}) {
  const sectionMarker = opts.sectionMarker || '<!-- AIWG SDLC Framework Integration -->';
  const legacyHeading = opts.legacyHeading || '## AIWG SDLC Framework';
  const templatePath = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', templateSubpath);
  const destPath = path.join(target, destFilename);

  if (!fs.existsSync(templatePath)) {
    console.warn(`${destFilename} template not found at ${templatePath}`);
    return;
  }

  let template = fs.readFileSync(templatePath, 'utf8');
  // Token interpolation — gives every template-based provider {{REMOTES_TOPOLOGY}},
  // {{ON_DEMAND_RULES}} (#1675), and the shared count tokens for free. The
  // on-demand list is computed lazily only when the template references it.
  template = interpolateContextTokens(template, {
    topology: buildRemotesTopologyBlock(target),
    onDemandRules: template.includes('{{ON_DEMAND_RULES}}')
      ? renderOnDemandRuleSection(listOnDemandRuleFiles(srcRoot), { heading: '### On-Demand Rules' })
      : '',
  });

  // Extract the AIWG section from the template (everything from its section
  // marker onward) and wrap it in managed markers so redeploys can update it.
  const tmplMarker = template.indexOf(sectionMarker);
  const aiwgSection = (tmplMarker !== -1 ? template.slice(tmplMarker) : template).trim();
  const templatePrefix = tmplMarker !== -1 ? template.slice(0, tmplMarker).trim() : '';
  const managedBlock = `${AIWG_MD_BEGIN}\n${aiwgSection}\n${AIWG_MD_END}`;

  const write = (content, verb) => {
    if (dryRun) {
      console.log(`[dry-run] Would ${verb} ${destFilename} AIWG-managed section`);
    } else {
      writeContextFileSync(destPath, content, 'utf8');
      console.log(`${verb[0].toUpperCase()}${verb.slice(1)} ${destFilename} AIWG-managed section`);
    }
  };

  // 1. Fresh file — write prefix (if any) + managed block.
  if (!fs.existsSync(destPath)) {
    const out = (templatePrefix ? templatePrefix + '\n\n---\n\n' : '') + managedBlock + '\n';
    write(out, 'create');
    return;
  }

  const existing = fs.readFileSync(destPath, 'utf8');
  const begIdx = existing.indexOf(AIWG_MD_BEGIN);
  const endIdx = existing.indexOf(AIWG_MD_END);

  // 2. Markers present — replace the managed block in place, preserve everything outside.
  if (begIdx !== -1 && endIdx !== -1 && endIdx > begIdx) {
    const updated = existing.slice(0, begIdx) + managedBlock + existing.slice(endIdx + AIWG_MD_END.length);
    if (updated === existing) return; // already current — no-op
    write(updated, 'update');
    return;
  }

  // 3. Legacy unmarked AIWG section — migrate to the managed block. The section
  //    is always EOF-appended, so the operator prefix is everything before it.
  const legacyMarkerIdx = existing.indexOf(sectionMarker);
  const legacyIdx = legacyMarkerIdx !== -1 ? legacyMarkerIdx : existing.indexOf(legacyHeading);
  if (legacyIdx !== -1) {
    const prefix = existing.slice(0, legacyIdx).replace(/\n+---\s*$/, '').trimEnd();
    write(prefix + '\n\n---\n\n' + managedBlock + '\n', 'migrate');
    return;
  }

  // 4. No AIWG section at all — append the managed block.
  write(existing.trimEnd() + '\n\n---\n\n' + managedBlock + '\n', 'append');
}


/** AGENTS.md bridge — thin wrapper over createManagedMdFromTemplate (#1571). */
export function createAgentsMdFromTemplate(target, srcRoot, templateSubpath, dryRun) {
  createManagedMdFromTemplate(target, 'AGENTS.md', srcRoot, templateSubpath, dryRun, {
    sectionMarker: '<!-- AIWG SDLC Framework Integration -->',
    legacyHeading: '## AIWG SDLC Framework',
  });
}
