#!/usr/bin/env node
/**
 * Collect Component Docs
 *
 * Scans agentic/code/frameworks and agentic/code/addons for component docs/
 * directories and copies the markdown files into docs/frameworks/<name>/
 * and docs/addons/<name>/ so the documentation SPA can serve them.
 *
 * Also updates docs/_manifest.json with navigation entries for any newly
 * discovered files (idempotent — existing entries are preserved).
 *
 * Usage:
 *   node tools/manifest/collect-component-docs.mjs [--dry-run] [--verbose]
 *
 * Options:
 *   --dry-run          Show what would be copied/added without writing anything
 *   --check            Like --dry-run, but exit 1 if any collected doc differs from its source (#4420)
 *   --verbose          Print every file checked, not just changes
 *   --allow-unresolved Copy files whose relative links cannot be rewritten
 *
 * Relative links are rewritten as part of the copy (#2519): a link is correct
 * where it lives in the source tree, and the destination sits at a different
 * depth, so the transform belongs to whatever performs the copy. A link whose
 * target lands outside the collected set is a collection error, not a silent
 * break — the file is skipped and reported unless --allow-unresolved is set.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const MANIFEST_PATH = path.join(DOCS, '_manifest.json');
const AGENTIC = path.join(ROOT, 'agentic', 'code');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const DRY_RUN = args.includes('--dry-run') || CHECK;
const staleCollected = [];
const VERBOSE = args.includes('--verbose');
// Collect a file whose links cannot be re-expressed in the destination tree.
// Off by default: the docsite build runs with strictLinks, so a silent break
// here turns a green build red at release time (#2519).
const ALLOW_UNRESOLVED = args.includes('--allow-unresolved');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) { console.log(msg); }
function verbose(msg) { if (VERBOSE) console.log(msg); }

/**
 * Walk a directory recursively and return all .md files.
 * Returns objects { name, relPath } where relPath is relative to the docs dir
 * (e.g. "quickstart.md" or "examples/coverage.md").
 */
function listDocs(dir, _relPrefix = '') {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      results.push(...listDocs(path.join(dir, e.name), _relPrefix ? `${_relPrefix}/${e.name}` : e.name));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      results.push({ name: e.name, relPath: _relPrefix ? `${_relPrefix}/${e.name}` : e.name });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Discover components under agentic/code/{frameworks,addons}/ that have a docs/ dir. */
function discoverComponents() {
  const components = [];

  // Scan agentic/code/{frameworks,addons}/
  for (const kind of ['frameworks', 'addons']) {
    const kindDir = path.join(AGENTIC, kind);
    if (!fs.existsSync(kindDir)) continue;
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const docsDir = path.join(kindDir, entry.name, 'docs');
      const files = listDocs(docsDir);
      if (files.length > 0) {
        components.push({ kind, name: entry.name, docsDir, files });
      }
    }
  }

  // Scan tools/*/docs/
  const toolsDir = path.join(ROOT, 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const docsDir = path.join(toolsDir, entry.name, 'docs');
      const files = listDocs(docsDir);
      if (files.length > 0) {
        components.push({ kind: 'tools', name: entry.name, docsDir, files });
      }
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Relative link rewriting (#2519)
// ---------------------------------------------------------------------------

/**
 * Inline links/images `[text](target)` and reference definitions `[id]: target`.
 * Angle-bracket targets `[text](<a b.md>)` are matched so paths with spaces survive.
 */
// `[^\]]*` spans newlines on purpose — markdown link text may wrap across lines.
const INLINE_LINK_RE = /(!?\[[^\]]*\]\()(<[^>]*>|[^()\s]*)((?:\s+"[^"]*")?\))/g;
const REF_DEF_RE = /^([ \t]{0,3}\[[^\]]+\]:[ \t]*)(<[^>]*>|\S+)([^\n]*)$/gm;

/**
 * Canonical browse URL for repo files the docsite does not publish.
 *
 * Matches what the sibling public-source builder emits and what the previously
 * hand-patched collected docs use, so a link the docsite cannot resolve becomes
 * a working link to the source instead of a broken route.
 */
const SOURCE_BASE_URL = 'https://github.com/jmagly/aiwg';

/** Targets that are not repo-relative paths and must be left alone. */
function isNonRelativeTarget(target) {
  if (!target) return true;
  if (target.startsWith('#')) return true;               // same-page anchor
  if (target.startsWith('/')) return true;               // site-absolute
  if (target.startsWith('//')) return true;              // protocol-relative
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);       // http:, mailto:, data:, ...
}

/** Split "path#frag" / "path?q" into its path and the trailing suffix. */
function splitTarget(target) {
  const match = target.match(/^([^#?]*)([#?].*)?$/);
  return { pathPart: match?.[1] ?? target, suffix: match?.[2] ?? '' };
}

/**
 * Re-express one relative target for the destination location.
 *
 * Three outcomes:
 *
 * 1. The target is collected, or already lives under docs/ — re-express it
 *    relative to the destination. Preferred: the link stays inside the site.
 * 2. The target exists in the repo but the docsite does not publish it — point
 *    at the canonical source URL. The reader still reaches the file.
 * 3. The target does not resolve at source but does resolve from the
 *    destination — it was authored against the collected layout. Leave it.
 * 4. Nothing resolves — the tool cannot invent a destination. Report it so the
 *    source link is fixed deliberately.
 *
 * @returns {{ ok: true, target: string, rewroteToSource?: boolean }
 *          | { ok: false, target: string, reason: string }}
 */
function remapTarget(rawTarget, srcPath, destPath, collectedMap, collectedDests) {
  const bare = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (isNonRelativeTarget(bare)) return { ok: true, target: rawTarget };

  const { pathPart, suffix } = splitTarget(bare);
  if (!pathPart) return { ok: true, target: rawTarget };

  const absTarget = path.resolve(path.dirname(srcPath), decodeURI(pathPart));

  // A target that is itself collected moves with us; one already inside docs/
  // is reachable from the destination. Anything else leaves the collected set.
  let resolvedDest = collectedMap.get(absTarget);
  if (!resolvedDest) {
    const insideDocs = absTarget === DOCS || absTarget.startsWith(DOCS + path.sep);
    if (insideDocs && fs.existsSync(absTarget)) resolvedDest = absTarget;
  }
  if (!resolvedDest) {
    // Some links were authored against the collected layout rather than the
    // source layout — they are wrong at source and right after the copy. Leave
    // those untouched instead of "fixing" a link that already works.
    const fromDest = path.resolve(path.dirname(destPath), decodeURI(pathPart));
    const destResolves = collectedDests.has(fromDest)
      || ((fromDest === DOCS || fromDest.startsWith(DOCS + path.sep)) && fs.existsSync(fromDest));
    if (destResolves) return { ok: true, target: rawTarget };

    if (!fs.existsSync(absTarget)) return { ok: false, target: bare, reason: 'unresolved-at-source' };
    const insideRepo = absTarget.startsWith(ROOT + path.sep);
    if (!insideRepo) return { ok: false, target: bare, reason: 'outside-repo' };
    // Not published by the docsite, but it does exist — link to the source.
    const kind = fs.statSync(absTarget).isDirectory() ? 'tree' : 'blob';
    const repoRel = path.relative(ROOT, absTarget).split(path.sep).map(encodeURIComponent).join('/');
    const url = `${SOURCE_BASE_URL}/${kind}/main/${repoRel}${suffix}`;
    return { ok: true, target: rawTarget.startsWith('<') ? `<${url}>` : url, rewroteToSource: true };
  }

  const rel = path.relative(path.dirname(destPath), resolvedDest).split(path.sep).join('/');
  // Preserve the original spelling when the path is unchanged — re-encoding an
  // already-correct link is pure diff noise across every collected file.
  if (rel === pathPart.replace(/^\.\//, '')) return { ok: true, target: rawTarget };
  const encoded = rel.split('/').map(encodeURIComponent).join('/');
  const next = `${encoded}${suffix}`;
  return { ok: true, target: rawTarget.startsWith('<') ? `<${next}>` : next };
}

/**
 * Byte ranges covered by fenced code blocks. A match starting inside one is a
 * markdown sample, not a link the docsite will resolve.
 */
export function fencedRanges(text) {
  const ranges = [];
  let offset = 0;
  let start = -1;
  let marker = '';
  for (const line of text.split('\n')) {
    const fence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (start < 0) { start = offset; marker = fence[1][0]; }
      else if (fence[1][0] === marker) {
        ranges.push([start, offset + line.length]);
        start = -1;
        marker = '';
      }
    }
    offset += line.length + 1;
  }
  if (start >= 0) ranges.push([start, text.length]);
  return ranges;
}

/**
 * Rewrite every relative link in a markdown document for its collected location.
 *
 * Fenced code blocks are left untouched — a markdown sample inside a fence is
 * illustrative text, not a link the docsite will resolve.
 *
 * @returns {{ content: string, unresolved: Array<{ target: string, reason: string }>,
 *             sourceLinks: string[] }}
 */
function rewriteRelativeLinks(content, srcPath, destPath, collectedMap, collectedDests) {
  const unresolved = [];
  const sourceLinks = [];

  const apply = (text, regex, build) => {
    // Recomputed per pass: an earlier pass rewrites targets and shifts every
    // later offset, so ranges measured against the previous text would
    // misclassify links near a fence.
    const fenced = fencedRanges(text);
    const inFence = (at) => fenced.some(([start, end]) => at >= start && at < end);
    regex.lastIndex = 0;
    return text.replace(regex, (...groups) => {
      const match = groups[0];
      const at = groups[groups.length - 2];
      if (inFence(at)) return match;
      const rawTarget = groups[2];
      const result = remapTarget(rawTarget, srcPath, destPath, collectedMap, collectedDests);
      if (!result.ok) {
        unresolved.push({ target: result.target, reason: result.reason });
        return match;
      }
      if (result.rewroteToSource) sourceLinks.push(rawTarget);
      return build(groups, result.target);
    });
  };

  let next = apply(content, REF_DEF_RE, (groups, target) => `${groups[1]}${target}${groups[3]}`);
  next = apply(next, INLINE_LINK_RE, (groups, target) => `${groups[1]}${target}${groups[3]}`);

  return { content: next, unresolved, sourceLinks };
}

/** Map every source doc that will be collected to its destination path. */
function buildCollectedMap(components) {
  const map = new Map();
  for (const { kind, name, docsDir, files } of components) {
    for (const { relPath } of files) {
      map.set(path.join(docsDir, relPath), path.join(DOCS, kind, name, relPath));
    }
  }
  return map;
}

/** Ensure a directory exists (no-op if already present). */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Copy a file, creating the target directory if needed. */
function copyFile(src, dest) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/** Human-readable title from a filename slug. */
function titleFromSlug(slug) {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Generate a summary line for a markdown file by reading its first heading or first paragraph. */
function summaryFromFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // skip headings
    if (trimmed.length > 10) return trimmed.replace(/[*_`]/g, '').substring(0, 100);
  }
  return '';
}

/** Section metadata for a component (the parent nav group). */
function componentSection(kind, name, parentId) {
  const titles = {
    // Frameworks
    'sdlc-complete': { title: 'SDLC Complete', summary: 'Full lifecycle framework — internal docs and deep guides' },
    'forensics-complete': { title: 'Forensics Complete', summary: 'Digital forensics methodology and tool reference' },
    'media-curator': { title: 'Media Curator', summary: 'Media archive management guides' },
    'media-marketing-kit': { title: 'Media Marketing Kit', summary: 'Multi-channel campaign management and content operations' },
    'research-complete': { title: 'Research Complete', summary: 'Academic research workflow with GRADE methodology and FAIR compliance' },
    'ops-complete': { title: 'Ops Complete', summary: 'Operational infrastructure framework — YAML-native with sys, it, dev, stream extensions' },
    'cicd-complete': { title: 'CI/CD Complete', summary: 'End-user CI/CD lifecycle and governed pipeline/environment contracts' },
    // Addons
    'ralph': { title: 'Ralph Addon', summary: 'Iterative loop execution — quickstart, best practices, troubleshooting' },
    'rlm': { title: 'RLM Addon', summary: 'Recursive Language Model — deployment, multi-provider, integration guides' },
    'agent-persistence': { title: 'Agent Persistence', summary: 'Cross-session agent state and HITL integration' },
    'aiwg-utils': { title: 'AIWG Utils', summary: 'Core utility rules — subagent scoping, context budget, instruction comprehension' },
    'aiwg-dev': { title: 'AIWG Dev', summary: 'Developer toolkit — validate-component, dev-doctor, link-check, devkit scaffolding' },
    'voice-framework': { title: 'Voice Framework', summary: 'Voice profile documentation — four built-in voices, custom profiles, blending' },
    'testing-quality': { title: 'Testing Quality', summary: 'TDD enforcement, mutation testing, flaky test detection' },
    'daemon': { title: 'Daemon Addon', summary: 'Persistent background agent — web UI, YAML profiles, scheduled tasks, Telegram' },
    'auto-memory': { title: 'Auto Memory', summary: 'Automatic memory management — seed templates, memory evolution, cross-session persistence' },
    'guided-implementation': { title: 'Guided Implementation', summary: 'Controlled iteration loop with escalation on repeated failure' },
    'prose-integration': { title: 'Prose Integration', summary: 'OpenProse contract-driven execution — five skills, obligation semantics' },
    // Tools
    'ralph-external': { title: 'External Ralph', summary: 'Crash-resilient external loop — snapshot manager and provider API' },
  };
  const meta = titles[name] || { title: titleFromSlug(name), summary: '' };
  return {
    id: `${kind}/${name}`,
    title: meta.title,
    summary: meta.summary,
    collapsed: true,
    parent: parentId,
  };
}

/** Section metadata for a single file within a component. */
function fileSection(kind, name, relPath, docsDestDir) {
  // relPath may be "quickstart.md" or "examples/coverage.md"
  const slug = relPath.replace(/\.md$/, '');          // e.g. "quickstart" or "examples/coverage"
  const leafSlug = path.basename(slug);               // e.g. "quickstart" or "coverage"
  const filePath = path.join(docsDestDir, relPath);
  const summary = summaryFromFile(filePath);
  // parent is the component group, or a subdir group for nested files
  const parentId = slug.includes('/') ? `${kind}/${name}/${path.dirname(slug)}` : `${kind}/${name}`;

  const titleOverrides = {
    // General
    'quickstart': 'Quick Start',
    'overview': 'Overview',
    'best-practices': 'Best Practices',
    'troubleshooting': 'Troubleshooting',
    'user-guide': 'User Guide',
    'deployment-guide': 'Deployment Guide',
    'configuration-reference': 'Configuration Reference',
    'extensions-guide': 'Extensions Guide',
    'rules-reference': 'Rules Reference',
    // Ralph
    'cross-loop-learning': 'Cross-Loop Learning',
    'when-to-use-agent-loop': 'When to Use the Agent Loop',
    'agent-persistence-integration': 'Agent Persistence Integration',
    'executable-feedback-guide': 'Executable Feedback Guide',
    'reflection-memory-guide': 'Reflection & Memory Guide',
    // RLM
    'multi-provider-guide': 'Multi-Provider Guide',
    'ralph-integration': 'Ralph Integration',
    'supervisor-integration': 'Supervisor Integration',
    'taskstore-persistence': 'TaskStore Persistence',
    'messaging-events': 'Messaging Events',
    // Agent persistence
    'hitl-integration': 'HITL Integration',
    // Forensics
    'methodology': 'Methodology',
    'tool-reference': 'Tool Reference',
    'ai-assisted-forensics': 'AI-Assisted Forensics',
    'attack-mapping': 'Attack Mapping',
    'research-guide': 'Research Guide',
    // Media curator
    'standards-reference': 'Standards Reference',
    // SDLC
    'orchestrator-architecture': 'Orchestrator Architecture',
    'agent-design': 'Agent Design',
    'multi-agent-documentation-pattern': 'Multi-Agent Documentation Pattern',
    'production-grade-guide': 'Production Grade Guide',
    'vendor-detection': 'Vendor Detection',
    'token-security': 'Token Security',
    'workspace-cleanup-pattern': 'Workspace Cleanup Pattern',
    'agent-permission-tiers': 'Agent Permission Tiers',
    'agent-permission-rationale': 'Agent Permission Rationale',
    'flow-cleanup-checklist': 'Flow Cleanup Checklist',
    'simple-language-translations': 'Natural Language Reference',
    // Daemon addon
    'daemon-addon-guide': 'Daemon Addon Guide',
    // Examples (subdir)
    'coverage': 'Coverage Example',
    'test-fix-loop': 'Test-Fix Loop Example',
    'migration': 'Migration Example',
  };

  return {
    id: `${kind}/${name}/${slug}`,
    title: titleOverrides[leafSlug] || titleFromSlug(leafSlug),
    summary,
    file: `${kind}/${name}/${relPath}`,
    parent: parentId,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(DRY_RUN ? '[dry-run] Collect component docs' : 'Collecting component docs...');

  const components = discoverComponents();
  if (components.length === 0) {
    log('No component docs found.');
    return;
  }

  // Read existing manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    console.error('Could not read docs/_manifest.json');
    process.exit(1);
  }

  const existingIds = new Set((manifest.sections || []).map(s => s.id));
  const existingOrder = new Set(manifest.order || []);

  const newSections = [];
  const newOrderEntries = [];
  let copied = 0;
  let skipped = 0;
  /** Files whose links have no resolvable target — reported, not silently broken (#2519). */
  const unresolvedReports = [];
  let rewritten = 0;
  let sourceLinked = 0;
  const collectedMap = buildCollectedMap(components);
  const collectedDests = new Set(collectedMap.values());

  for (const { kind, name, docsDir, files } of components) {
    const destDir = path.join(DOCS, kind, name);

    log(`\n${kind}/${name} (${files.length} docs)`);

    // Ensure parent group section exists
    const groupId = `${kind}/${name}`;
    const parentId = kind; // "frameworks" or "addons" — must already exist in manifest
    if (!existingIds.has(groupId)) {
      const section = componentSection(kind, name, parentId);
      newSections.push(section);
      existingIds.add(groupId);
      if (!existingOrder.has(groupId)) {
        newOrderEntries.push(groupId);
        existingOrder.add(groupId);
      }
      log(`  + section: ${groupId}`);
    }

    for (const { name: filename, relPath } of files) {
      const src = path.join(docsDir, relPath);
      const dest = path.join(destDir, relPath);
      const fileId = `${kind}/${name}/${relPath.replace(/\.md$/, '')}`;

      // Rewrite relative links for the destination depth before anything is
      // written. A link that cannot be re-expressed means the target is not in
      // the collected set, which the docsite's strictLinks build would reject —
      // so skip the file and report it rather than emit a known-broken page.
      const source = fs.readFileSync(src, 'utf8');
      const { content, unresolved, sourceLinks } = rewriteRelativeLinks(source, src, dest, collectedMap, collectedDests);
      if (sourceLinks.length > 0) sourceLinked += sourceLinks.length;
      if (unresolved.length > 0) {
        unresolvedReports.push({ src: path.relative(ROOT, src), links: unresolved });
        if (!ALLOW_UNRESOLVED) {
          log(`  ! skipped (${unresolved.length} link(s) with no resolvable target): ${relPath}`);
          continue;
        }
      }
      if (content !== source) rewritten++;

      // Ensure intermediate subdirectory group sections exist for nested files
      const relDir = path.dirname(relPath);
      if (relDir !== '.') {
        const subdirId = `${kind}/${name}/${relDir}`;
        if (!existingIds.has(subdirId)) {
          newSections.push({
            id: subdirId,
            title: titleFromSlug(relDir),
            summary: '',
            collapsed: true,
            parent: groupId,
          });
          existingIds.add(subdirId);
          if (!existingOrder.has(subdirId)) {
            newOrderEntries.push(subdirId);
            existingOrder.add(subdirId);
          }
          log(`  + section: ${subdirId}`);
        }
      }

      // Copy the file (with rewritten links)
      if (!DRY_RUN) {
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, content, 'utf8');
        verbose(`  copied: ${kind}/${name}/${relPath}`);
        copied++;
      } else {
        if (CHECK && (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== content)) staleCollected.push(`docs/${kind}/${name}/${relPath}`);
        if (!CHECK) log(`  [copy] ${src} → docs/${kind}/${name}/${relPath}`);
        copied++;
      }

      // Add manifest section if not present
      if (!existingIds.has(fileId)) {
        const section = fileSection(kind, name, relPath, destDir);
        newSections.push(section);
        existingIds.add(fileId);
        if (!existingOrder.has(fileId)) {
          newOrderEntries.push(fileId);
          existingOrder.add(fileId);
        }
        log(`  + section: ${fileId}`);
      } else {
        skipped++;
        verbose(`  (exists): ${fileId}`);
      }
    }
  }

  // Inject new sections and order entries into manifest
  if (newSections.length > 0 && !DRY_RUN) {
    manifest.sections = [...(manifest.sections || []), ...newSections];
    manifest.order = [...(manifest.order || []), ...newOrderEntries];
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log(`\nUpdated docs/_manifest.json (+${newSections.length} sections)`);
  } else if (newSections.length > 0 && DRY_RUN) {
    log(`\n[dry-run] Would add ${newSections.length} sections to docs/_manifest.json`);
  } else {
    log('\nManifest already up to date.');
  }

  log(`\nDone: ${copied} files ${DRY_RUN ? 'would be ' : ''}copied, ${skipped} sections already present.`);
  if (CHECK && staleCollected.length > 0) {
    console.error(`\n${staleCollected.length} collected doc(s) differ from their source; edit the source under agentic/code and run npm run docs:collect:`);
    for (const file of staleCollected) console.error(`  ${file}`);
    process.exitCode = 1;
  }
  if (rewritten > 0) log(`Rewrote relative links in ${rewritten} file(s) for the collected layout.`);
  if (sourceLinked > 0) log(`Pointed ${sourceLinked} link(s) at the canonical source — the docsite does not publish those targets.`);

  // Emit a docs-sources.json for reference
  if (!DRY_RUN) {
    const sourcesPath = path.join(DOCS, 'docs-sources.json');
    const sources = components.map(({ kind, name, docsDir, files }) => ({
      kind,
      name,
      source: path.relative(ROOT, docsDir),
      dest: `docs/${kind}/${name}`,
      files: files.map(f => f.relPath),
    }));
    fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + '\n', 'utf8');
    log(`Wrote docs/docs-sources.json (${sources.length} components)`);
  }

  if (unresolvedReports.length > 0) {
    const REASON_LABEL = {
      'unresolved-at-source': 'does not resolve in the source tree either — fix the source link',
      'outside-repo': 'resolves outside the repository',
    };
    const total = unresolvedReports.reduce((sum, item) => sum + item.links.length, 0);
    const verb = ALLOW_UNRESOLVED ? 'collected anyway' : 'not collected';
    console.error(`\n${unresolvedReports.length} file(s) ${verb} — ${total} link(s) have no resolvable target:`);
    for (const item of unresolvedReports) {
      console.error(`  ${item.src}`);
      for (const link of item.links) console.error(`    -> ${link.target}  (${REASON_LABEL[link.reason] ?? link.reason})`);
    }
    console.error('\nCollection cannot invent a destination for these. Fix the link in the source');
    console.error('doc, or re-run with --allow-unresolved to collect it anyway (the docsite build');
    console.error('enforces strictLinks and will fail on it). See #2519.');
    if (!ALLOW_UNRESOLVED) process.exitCode = 1;
  }
}

// Guarded so the pure helpers can be imported by tests without running a collect.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { rewriteRelativeLinks, remapTarget, buildCollectedMap, isNonRelativeTarget };
