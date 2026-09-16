#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assessThreat } from './threat-assessment.mjs';

export const CONTEXT_FIREWALL_SCHEMA = 'aiwg.context-memory-firewall/v1';
export const CONTEXT_FIREWALL_BASELINE_SCHEMA = 'aiwg.context-memory-firewall-baseline/v1';
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 200_000;
export const DEFAULT_WARN_RATIO = 0.6;
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const CONTEXT_CATEGORIES = Object.freeze([
  'memory',
  'rule',
  'skill',
  'agent',
  'generated-bridge',
  'project-local',
]);

export const TRUST_LABELS = Object.freeze([
  'user-authored',
  'generated',
  'external',
  'stale',
  'quarantined',
  'superseded',
]);

const PROVIDERS = Object.freeze({
  claude: {
    agents: '.claude/agents', rules: '.claude/rules',
    skills: ['.claude/skills', '.claude/.aiwg/skills'],
    memory: ['CLAUDE.md'],
  },
  codex: {
    agents: '.codex/agents', rules: '.codex/rules',
    skills: ['.agents/skills', '.codex/.aiwg/skills'],
    bridges: ['AGENTS.md'],
  },
  copilot: {
    agents: '.github/agents', rules: '.github/instructions',
    skills: ['.github/skills', '.github/.aiwg/skills'],
    bridges: ['.github/copilot-instructions.md'],
  },
  cursor: {
    agents: '.cursor/agents', rules: '.cursor/rules',
    skills: ['.cursor/skills', '.cursor/.aiwg/skills'],
  },
  factory: {
    agents: '.factory/droids', rules: '.factory/rules',
    skills: ['.factory/skills', '.factory/.aiwg/skills'],
  },
  opencode: {
    agents: '.opencode/agent', rules: '.opencode/rule',
    skills: ['.opencode/skill', '.opencode/.aiwg/skill'],
  },
  warp: {
    agents: '.warp/agents', rules: '.warp/rules',
    skills: ['.warp/skills', '.warp/.aiwg/skills'],
    bridges: ['WARP.md'],
  },
  windsurf: {
    agents: '.windsurf/agents', rules: '.windsurf/rules',
    skills: ['.windsurf/skills', '.windsurf/.aiwg/skills'],
    bridges: ['AGENTS.md'],
  },
  hermes: {
    bridges: ['.hermes.md'],
  },
  openhuman: {
    agents: '.agents/agents', rules: '.agents/rules', skills: ['.agents/skills'],
    bridges: ['AGENTS.md'],
  },
  // Bridge-only: never invent ~/.grokbot or skill trees. Shared AIWG.md /
  // WORKSPACE.md are scanned via SHARED_CONTEXT.
  grokbot: {
    bridges: ['AGENTS.md'],
  },
});

const SHARED_CONTEXT = Object.freeze([
  { path: 'AIWG.md', category: 'memory' },
  { path: '.aiwg/AIWG.md', category: 'memory' },
  { path: 'WORKSPACE.md', category: 'project-local' },
]);

const PROJECT_LOCAL_ROOTS = Object.freeze([
  '.aiwg/context',
  '.aiwg/memory',
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdc', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.rst',
]);

function relPath(rootDir, absolute) {
  return path.relative(rootDir, absolute).split(path.sep).join('/');
}

function insideRoot(rootDir, target) {
  const relative = path.relative(rootDir, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function digestBuffer(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function approxTokens(bytes) {
  return Math.ceil(bytes / 4);
}

async function exists(absolute) {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

async function readJson(absolute) {
  return JSON.parse(await fs.readFile(absolute, 'utf8'));
}

async function walkFiles(rootDir, options = {}) {
  const files = [];
  const include = options.include ?? (() => true);
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if ((entry.isFile() || entry.isSymbolicLink()) && include(absolute, entry)) files.push(absolute);
    }
  };
  await visit(rootDir);
  return files;
}

async function loadDeploymentManifest(directory) {
  const manifestPath = path.join(directory, '.aiwg-manifest.json');
  try {
    const parsed = await readJson(manifestPath);
    return parsed?.managed && typeof parsed.managed === 'object' ? parsed.managed : {};
  } catch {
    return {};
  }
}

function packageKey(category, absolute) {
  if (category === 'skill') return `skill:${path.basename(path.dirname(absolute))}`;
  return `${category}:${path.basename(absolute).replace(/\.agent\.md$/i, '.md').replace(/\.toml$/i, '.md')}`;
}

async function buildPackagedInventory(packageRoot) {
  const sourceRoot = path.join(packageRoot, 'agentic', 'code');
  const inventory = new Map();
  if (!(await exists(sourceRoot))) return inventory;
  const files = await walkFiles(sourceRoot, {
    include: (absolute) => {
      const normalized = absolute.split(path.sep).join('/');
      return normalized.endsWith('/SKILL.md')
        || /\/agents\/[^/]+\.md$/i.test(normalized)
        || /\/rules\/[^/]+\.(?:md|mdc)$/i.test(normalized);
    },
  });
  for (const absolute of files) {
    const normalized = absolute.split(path.sep).join('/');
    const category = normalized.endsWith('/SKILL.md')
      ? 'skill'
      : normalized.includes('/agents/') ? 'agent' : 'rule';
    const buffer = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    const key = packageKey(category, absolute);
    const entries = inventory.get(key) ?? [];
    entries.push({ path: relPath(packageRoot, absolute), bytes: stat.size, digest: digestBuffer(buffer) });
    inventory.set(key, entries);
  }
  return inventory;
}

function choosePackagedSource(record, inventory) {
  const candidates = inventory.get(packageKey(record.category, record.absolutePath)) ?? [];
  if (candidates.length === 0) return null;
  if (record.manifest?.frameworkSlug) {
    const needle = `/${record.manifest.frameworkSlug}/`;
    const scoped = candidates.filter((candidate) => `/${candidate.path}`.includes(needle));
    if (scoped.length === 1) return scoped[0];
  }
  const digestMatches = candidates.filter((candidate) => candidate.digest === record.digest);
  if (digestMatches.length > 0) return digestMatches.sort((a, b) => a.path.localeCompare(b.path))[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function skillListingTokens(content, candidate) {
  const name = path.basename(path.dirname(candidate.absolutePath));
  const frontmatterEnd = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
  const frontmatter = frontmatterEnd > 0 ? content.slice(4, frontmatterEnd) : '';
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.replace(/^['"]|['"]$/g, '') ?? '';
  return Math.ceil((name.length + description.length + 5) / 4);
}

function budgetContribution(category, content, bytes, candidate) {
  if (category === 'agent') return 0;
  if (category === 'skill') return skillListingTokens(content, candidate);
  return approxTokens(bytes);
}

async function loadBaseline(baselinePath, rootDir) {
  const absolute = path.resolve(rootDir, baselinePath);
  if (!insideRoot(rootDir, absolute)) {
    throw new Error(`Review baseline must stay within the project root: ${baselinePath}`);
  }
  if (!(await exists(absolute))) {
    return { path: relPath(rootDir, absolute), absolute, exists: false, files: {} };
  }
  const real = await fs.realpath(absolute);
  const realRoot = await fs.realpath(rootDir);
  if (!insideRoot(realRoot, real)) {
    throw new Error(`Review baseline resolves outside the project root: ${baselinePath}`);
  }
  const parsed = await readJson(absolute);
  if (parsed?.schemaVersion !== CONTEXT_FIREWALL_BASELINE_SCHEMA || !parsed.files || typeof parsed.files !== 'object') {
    throw new Error(`${absolute}: expected ${CONTEXT_FIREWALL_BASELINE_SCHEMA} with a files object`);
  }
  return { path: relPath(rootDir, absolute), absolute, exists: true, files: parsed.files };
}

function mergeCandidate(map, candidate) {
  const key = `${candidate.category}:${candidate.path}`;
  const existing = map.get(key);
  if (existing) {
    for (const provider of candidate.providers) existing.providers.add(provider);
    return;
  }
  map.set(key, { ...candidate, providers: new Set(candidate.providers) });
}

async function collectCandidates(rootDir, providers, baselinePath) {
  const candidates = new Map();
  const add = (absolute, category, provider) => {
    const relative = relPath(rootDir, absolute);
    if (relative === baselinePath) return;
    mergeCandidate(candidates, {
      absolutePath: absolute,
      path: relative,
      category,
      providers: new Set([provider]),
    });
  };

  for (const shared of SHARED_CONTEXT) {
    const absolute = path.join(rootDir, shared.path);
    if (await exists(absolute)) add(absolute, shared.category, 'shared');
  }

  for (const localRoot of PROJECT_LOCAL_ROOTS) {
    const absoluteRoot = path.join(rootDir, localRoot);
    if (!(await exists(absoluteRoot))) continue;
    const files = await walkFiles(absoluteRoot, {
      include: (absolute) => TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase()),
    });
    for (const absolute of files) add(absolute, 'project-local', 'shared');
  }

  for (const providerName of providers) {
    const provider = PROVIDERS[providerName];
    if (!provider) throw new Error(`Unknown provider '${providerName}'`);
    for (const relative of provider.memory ?? []) {
      const absolute = path.join(rootDir, relative);
      if (await exists(absolute)) add(absolute, 'memory', providerName);
    }
    for (const relative of provider.bridges ?? []) {
      const absolute = path.join(rootDir, relative);
      if (await exists(absolute)) add(absolute, 'generated-bridge', providerName);
    }
    for (const [field, category] of [['rules', 'rule'], ['agents', 'agent']]) {
      const relative = provider[field];
      if (!relative) continue;
      const absoluteRoot = path.join(rootDir, relative);
      if (!(await exists(absoluteRoot))) continue;
      const files = await walkFiles(absoluteRoot, {
        include: (absolute) => {
          const name = path.basename(absolute);
          if (name.startsWith('.aiwg-')) return false;
          const extension = path.extname(name).toLowerCase();
          return category === 'agent'
            ? ['.md', '.toml'].includes(extension)
            : ['.md', '.mdc'].includes(extension);
        },
      });
      for (const absolute of files) add(absolute, category, providerName);
    }
    for (const relative of provider.skills ?? []) {
      const absoluteRoot = path.join(rootDir, relative);
      if (!(await exists(absoluteRoot))) continue;
      const files = await walkFiles(absoluteRoot, {
        include: (absolute) => path.basename(absolute) === 'SKILL.md',
      });
      for (const absolute of files) add(absolute, 'skill', providerName);
    }
  }

  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function manifestForCandidate(candidate) {
  if (!['agent', 'rule'].includes(candidate.category)) return null;
  const managed = await loadDeploymentManifest(path.dirname(candidate.absolutePath));
  return managed[path.basename(candidate.absolutePath)] ?? null;
}

async function isManaged(candidate, buffer, manifest) {
  if (manifest) return true;
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf8');
  if (/aiwg[-:]managed|Generated by AIWG/i.test(head)) return true;
  if (candidate.category === 'skill') {
    return exists(path.join(path.dirname(candidate.absolutePath), '.aiwg-managed'));
  }
  return false;
}

function poisoningSummary(content, candidate, managed) {
  const report = assessThreat({
    surface: 'handoff',
    content,
    source: { kind: 'provider-context', id: candidate.path },
    actor: { trust: managed ? 'package-managed' : 'untrusted' },
    requestedAction: 'load-as-provider-context',
  });
  const active = report.findings.filter((finding) => !finding.suppressed);
  const ids = [...new Set(active.map((finding) => finding.ruleId))].sort();
  const idSet = new Set(ids);
  const dangerousCombination = idSet.has('credential-or-env-probing')
    && (idSet.has('instruction-override') || idSet.has('third-party-execution'));
  const poisoning = idSet.has('instruction-override') || dangerousCombination;
  return {
    poisoning,
    signals: ids,
    severity: report.risk.severity,
    action: report.decision.action,
  };
}

async function inspectCandidate(candidate, context) {
  const { rootDir, baseline, packageInventory, maxFileBytes, contentScan } = context;
  const lstat = await fs.lstat(candidate.absolutePath);
  let real = candidate.absolutePath;
  if (lstat.isSymbolicLink()) {
    try {
      real = await fs.realpath(candidate.absolutePath);
    } catch {
      real = candidate.absolutePath;
    }
  }
  if (!insideRoot(rootDir, real)) {
    return {
      path: candidate.path, category: candidate.category,
      providers: [...candidate.providers].sort(), bytes: 0, approxTokens: 0,
      budgetTokens: 0,
      digest: null, trust: 'external', reviewStatus: 'external-review-required',
      managed: false, deployedStatus: 'external', packagedPath: null, packagedBytes: 0,
      signals: [], findings: ['external-path'],
    };
  }

  const stat = await fs.stat(real);
  const baselineEntry = baseline.files[candidate.path] ?? null;
  if (stat.size > maxFileBytes) {
    return {
      path: candidate.path, category: candidate.category,
      providers: [...candidate.providers].sort(), bytes: stat.size, approxTokens: approxTokens(stat.size),
      budgetTokens: approxTokens(stat.size),
      digest: null, trust: 'quarantined', reviewStatus: 'oversized-review-required',
      managed: false, deployedStatus: 'unverified', packagedPath: null, packagedBytes: 0,
      signals: [], findings: ['oversized-file'],
    };
  }

  const buffer = await fs.readFile(real);
  const content = buffer.toString('utf8');
  const digest = digestBuffer(buffer);
  candidate.digest = digest;
  const manifest = await manifestForCandidate(candidate);
  candidate.manifest = manifest;
  const managed = await isManaged(candidate, buffer, manifest);
  const packaged = choosePackagedSource(candidate, packageInventory);
  const packagedDigestMatch = Boolean(packaged?.digest && packaged.digest === digest);
  const manifestDrift = Boolean(manifest?.hash && manifest.hash !== digest);
  const baselineChanged = Boolean(baselineEntry?.digest && baselineEntry.digest !== digest);
  const threat = contentScan
    ? poisoningSummary(content, candidate, managed)
    : { poisoning: false, signals: [], severity: 'informational', action: 'proceed' };

  let trust;
  let reviewStatus;
  const findings = [];
  if (baselineEntry?.trust === 'superseded') {
    trust = 'superseded';
    reviewStatus = 'superseded';
  } else if (threat.poisoning && !managed) {
    trust = 'quarantined';
    reviewStatus = 'quarantine-review-required';
    findings.push('poisoning-signal');
  } else if (manifestDrift) {
    trust = 'stale';
    reviewStatus = 'deployed-drift';
    findings.push('stale-deployed-bytes');
  } else if (baselineChanged) {
    trust = 'quarantined';
    reviewStatus = 'changed-review-required';
    findings.push('changed-since-review');
  } else if (baselineEntry?.trust && TRUST_LABELS.includes(baselineEntry.trust)) {
    trust = baselineEntry.trust;
    reviewStatus = 'reviewed';
  } else {
    trust = managed ? 'generated' : 'user-authored';
    reviewStatus = 'unreviewed';
  }

  if (threat.signals.length > 0 && (!threat.poisoning || managed)) findings.push('content-review-signal');

  return {
    path: candidate.path,
    category: candidate.category,
    providers: [...candidate.providers].sort(),
    bytes: stat.size,
    approxTokens: approxTokens(stat.size),
    budgetTokens: budgetContribution(candidate.category, content, stat.size, candidate),
    digest,
    trust,
    reviewStatus,
    managed,
    deployedStatus: manifestDrift ? 'stale' : manifest ? 'manifest-current' : managed ? 'managed-unverified' : 'unmanaged',
    manifest: manifest ? {
      hash: manifest.hash ?? null,
      source: manifest.source ?? null,
      version: manifest.version ?? null,
      frameworkSlug: manifest.frameworkSlug ?? null,
    } : null,
    packagedPath: packaged?.path ?? null,
    packagedBytes: packaged?.bytes ?? 0,
    packagedDigestMatch,
    signals: threat.signals,
    findings,
  };
}

function aggregate(records) {
  const categories = Object.fromEntries(CONTEXT_CATEGORIES.map((category) => [category, {
    files: 0, bytes: 0, approxTokens: 0, budgetTokens: 0, packagedBytes: 0, staleDeployedBytes: 0,
  }]));
  const trust = Object.fromEntries(TRUST_LABELS.map((label) => [label, 0]));
  for (const record of records) {
    const bucket = categories[record.category];
    bucket.files += 1;
    bucket.bytes += record.bytes;
    bucket.approxTokens += record.approxTokens;
    bucket.budgetTokens += record.budgetTokens;
    bucket.packagedBytes += record.packagedBytes;
    if (record.deployedStatus === 'stale') bucket.staleDeployedBytes += record.bytes;
    trust[record.trust] += 1;
  }
  return { categories, trust };
}

export async function scanContextMemoryFirewall(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const packageRoot = path.resolve(options.packageRoot ?? rootDir);
  const providerInput = options.providers ?? (options.provider ? [options.provider] : null);
  let providers = providerInput?.length ? [...new Set(providerInput)] : [];
  if (!providers.length) {
    for (const [provider, config] of Object.entries(PROVIDERS)) {
      const paths = [
        config.agents,
        config.rules,
        ...(config.skills ?? []),
        ...(config.memory ?? []),
        ...(config.bridges ?? []),
      ].filter(Boolean);
      for (const relative of paths) {
        if (!path.isAbsolute(relative) && await exists(path.resolve(rootDir, relative))) {
          providers.push(provider);
          break;
        }
      }
    }
  }
  const baselineInput = options.baselinePath ?? '.aiwg/context-memory-firewall-baseline.json';
  const baseline = await loadBaseline(baselineInput, rootDir);
  const budgetTokens = options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const warnRatio = options.warnRatio ?? DEFAULT_WARN_RATIO;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const contentScan = options.contentScan !== false;

  for (const provider of providers) {
    if (!PROVIDERS[provider]) throw new Error(`Unknown provider '${provider}'`);
  }
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) throw new Error('budgetTokens must be a positive number');
  if (!Number.isFinite(warnRatio) || warnRatio <= 0 || warnRatio >= 1) throw new Error('warnRatio must be between 0 and 1');

  const packageInventory = await buildPackagedInventory(packageRoot);
  const candidates = await collectCandidates(rootDir, providers, baseline.path);
  const records = [];
  for (const candidate of candidates) {
    records.push(await inspectCandidate(candidate, {
      rootDir, baseline, packageInventory, maxFileBytes, contentScan,
    }));
  }

  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const potentialTokens = records.reduce((sum, record) => sum + record.approxTokens, 0);
  const totalTokens = records.reduce((sum, record) => sum + record.budgetTokens, 0);
  const warnTokens = Math.floor(budgetTokens * warnRatio);
  const violations = [];
  if (totalTokens > budgetTokens) violations.push({ code: 'context-budget-over', paths: [] });
  for (const record of records) {
    if (['stale', 'quarantined', 'external'].includes(record.trust)) {
      violations.push({ code: record.findings[0] ?? `${record.trust}-context`, paths: [record.path] });
    }
  }
  const warnings = [];
  if (!baseline.exists) warnings.push({ code: 'review-baseline-missing', paths: [baseline.path] });
  if (totalTokens > warnTokens && totalTokens <= budgetTokens) warnings.push({ code: 'context-budget-tight', paths: [] });
  for (const record of records) {
    if (record.findings.includes('content-review-signal')) warnings.push({ code: 'content-review-signal', paths: [record.path] });
  }

  return {
    schemaVersion: CONTEXT_FIREWALL_SCHEMA,
    rootDir,
    packageRoot,
    providers,
    budget: { tokens: budgetTokens, warnTokens, warnRatio },
    baseline: { path: baseline.path, exists: baseline.exists },
    totals: { files: records.length, bytes: totalBytes, approxTokens: totalTokens, potentialTokens },
    ...aggregate(records),
    records,
    violations,
    warnings,
    status: violations.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
  };
}

export function formatContextMemoryFirewall(result, options = {}) {
  const limit = options.limit ?? 25;
  const lines = [
    `Context/memory firewall: ${result.status.toUpperCase()}`,
    `Providers: ${result.providers.join(', ') || 'none'}`,
    `Budget: ~${result.totals.approxTokens.toLocaleString()} / ${result.budget.tokens.toLocaleString()} tokens `
      + `(warn ${result.budget.warnTokens.toLocaleString()})`,
    `Review baseline: ${result.baseline.exists ? result.baseline.path : `missing (${result.baseline.path})`}`,
    '',
    'Attribution:',
  ];
  for (const category of CONTEXT_CATEGORIES) {
    const bucket = result.categories[category];
    lines.push(
      `  - ${category}: ${bucket.files} file(s), ${bucket.bytes.toLocaleString()} deployed bytes, `
        + `${bucket.packagedBytes.toLocaleString()} current packaged bytes, `
        + `~${bucket.budgetTokens.toLocaleString()} budget tokens (${bucket.approxTokens.toLocaleString()} potential)`
        + (bucket.staleDeployedBytes ? `, ${bucket.staleDeployedBytes.toLocaleString()} stale deployed bytes` : ''),
    );
  }
  lines.push('', 'Trust labels:');
  for (const label of TRUST_LABELS) lines.push(`  - ${label}: ${result.trust[label]}`);

  const review = result.records.filter((record) => record.reviewStatus !== 'reviewed' || record.findings.length > 0);
  if (review.length > 0) {
    lines.push('', `Review output (${review.length} file(s); showing ${Math.min(limit, review.length)}):`);
    for (const record of review.slice(0, limit)) {
      const signals = record.signals.length ? `; signals=${record.signals.join(',')}` : '';
      lines.push(`  - ${record.path}: ${record.trust}; ${record.reviewStatus}${signals}`);
    }
  }
  if (result.violations.length > 0) {
    lines.push('', 'Gate violations:');
    for (const violation of result.violations.slice(0, limit)) {
      lines.push(`  - ${violation.code}${violation.paths.length ? `: ${violation.paths.join(', ')}` : ''}`);
    }
  }
  if (!result.baseline.exists) {
    lines.push('', 'After reviewing every listed file, create a baseline with:');
    lines.push('  aiwg context-firewall baseline --plan');
  }
  return lines.join('\n');
}

export function formatReviewBaselinePlan(result, outputPath) {
  const destination = outputPath ?? '.aiwg/context-memory-firewall-baseline.json';
  const lines = [
    'Context/memory firewall baseline plan (no files changed)',
    `Destination: ${destination}`,
    `Records to approve: ${result.records.length}`,
    '',
    'Review every record:',
  ];
  for (const record of result.records) {
    const findings = record.findings.length ? `; findings=${record.findings.join(',')}` : '';
    lines.push(
      `  - ${record.path}: ${record.trust}; ${record.reviewStatus}; ${record.digest ?? 'no digest'}${findings}`,
    );
  }
  if (result.records.length === 0) lines.push('  - none');
  lines.push('', 'After reviewing every record, write the baseline with:');
  const output = destination === '.aiwg/context-memory-firewall-baseline.json'
    ? ''
    : ` --output ${JSON.stringify(destination)}`;
  lines.push(`  aiwg context-firewall baseline --write --confirm-reviewed${output}`);
  return lines.join('\n');
}

export async function writeReviewBaseline(result, outputPath) {
  const unsafe = result.records.filter((record) => ['quarantined', 'stale', 'external'].includes(record.trust));
  if (unsafe.length > 0) {
    throw new Error(`Refusing to baseline ${unsafe.length} quarantined, stale, or external file(s)`);
  }
  const absolute = path.resolve(result.rootDir, outputPath);
  if (!insideRoot(result.rootDir, absolute)) {
    throw new Error(`Review baseline must stay within the project root: ${outputPath}`);
  }
  const files = {};
  for (const record of result.records) {
    if (!record.digest) continue;
    files[record.path] = {
      digest: record.digest,
      trust: record.trust === 'superseded' ? 'superseded' : record.managed ? 'generated' : 'user-authored',
      category: record.category,
      providers: record.providers,
    };
  }
  const baseline = {
    schemaVersion: CONTEXT_FIREWALL_BASELINE_SCHEMA,
    reviewedAt: new Date().toISOString(),
    files,
  };
  const parent = path.dirname(absolute);
  const realRoot = await fs.realpath(result.rootDir);
  let existingAncestor = parent;
  while (!(await exists(existingAncestor))) {
    const next = path.dirname(existingAncestor);
    if (next === existingAncestor) {
      throw new Error(`Could not resolve review baseline parent: ${outputPath}`);
    }
    existingAncestor = next;
  }
  const realAncestor = await fs.realpath(existingAncestor);
  if (!insideRoot(realRoot, realAncestor)) {
    throw new Error(`Review baseline parent resolves outside the project root: ${outputPath}`);
  }
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!insideRoot(realRoot, realParent)) {
    throw new Error(`Review baseline parent resolves outside the project root: ${outputPath}`);
  }
  try {
    const existing = await fs.lstat(absolute);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace a symlinked review baseline: ${outputPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return absolute;
}

function parseArgs(argv) {
  const options = { providers: [], strict: false, json: false, contentScan: true, confirmReviewed: false, limit: 25 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const take = () => { index += 1; return next; };
    if (arg === '--root' && next) options.rootDir = path.resolve(take());
    else if (arg.startsWith('--root=')) options.rootDir = path.resolve(arg.slice(7));
    else if (arg === '--package-root' && next) options.packageRoot = path.resolve(take());
    else if (arg.startsWith('--package-root=')) options.packageRoot = path.resolve(arg.slice(15));
    else if (arg === '--provider' && next) options.providers.push(take());
    else if (arg.startsWith('--provider=')) options.providers.push(arg.slice(11));
    else if (arg === '--baseline' && next) options.baselinePath = take();
    else if (arg.startsWith('--baseline=')) options.baselinePath = arg.slice(11);
    else if (arg === '--budget-tokens' && next) options.budgetTokens = Number(take());
    else if (arg.startsWith('--budget-tokens=')) options.budgetTokens = Number(arg.slice(16));
    else if (arg === '--warn-ratio' && next) options.warnRatio = Number(take());
    else if (arg.startsWith('--warn-ratio=')) options.warnRatio = Number(arg.slice(13));
    else if (arg === '--limit' && next) options.limit = Number(take());
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-content-scan') options.contentScan = false;
    else if (arg === '--confirm-reviewed') options.confirmReviewed = true;
    else if (arg === '--plan-baseline') options.planBaseline = true;
    else if (arg.startsWith('--plan-baseline=')) options.planBaseline = arg.slice(16);
    else if (arg === '--write-baseline') options.writeBaseline = true;
    else if (arg.startsWith('--write-baseline=')) options.writeBaseline = arg.slice(17);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log([
        'Internal engine for `aiwg context-firewall`; use the public CLI for operator workflows.',
        '  --root <path>              Project root (default: cwd)',
        '  --package-root <path>      Current AIWG package root (default: project root)',
        '  --provider <name>          Limit to a provider; repeatable',
        '  --baseline <path>          Reviewed digest/trust baseline',
        '  --budget-tokens <n>        Portable provider-context budget (default: 200000)',
        '  --strict                   Fail on violations or a missing review baseline',
        '  --json                     Emit machine-readable JSON',
        '  --no-content-scan          Skip poisoning classification',
        '  --plan-baseline[=<path>]   Show every record a baseline would approve',
        '  --write-baseline[=<path>]  Write reviewed digests (requires --confirm-reviewed)',
        '  --confirm-reviewed         Confirm every emitted file was reviewed',
      ].join('\n'));
      return 0;
    }
    const scanOptions = {
      ...options,
      providers: options.providers.length ? options.providers : undefined,
    };
    const result = await scanContextMemoryFirewall(scanOptions);
    if (options.planBaseline) {
      const destination = typeof options.planBaseline === 'string'
        ? options.planBaseline
        : options.baselinePath ?? '.aiwg/context-memory-firewall-baseline.json';
      result.operation = {
        kind: 'baseline-plan',
        destination,
        changed: false,
        requiresConfirmation: true,
        records: result.records.length,
      };
    }
    if (options.writeBaseline) {
      if (!options.confirmReviewed) throw new Error('--write-baseline requires --confirm-reviewed');
      const destination = typeof options.writeBaseline === 'string'
        ? options.writeBaseline
        : options.baselinePath ?? '.aiwg/context-memory-firewall-baseline.json';
      const written = await writeReviewBaseline(result, destination);
      result.operation = {
        kind: 'baseline-write',
        destination: relPath(result.rootDir, written),
        changed: true,
        records: result.records.length,
      };
      result.baseline = { path: relPath(result.rootDir, written), exists: true };
      result.warnings = result.warnings.filter((warning) => warning.code !== 'review-baseline-missing');
      result.status = result.violations.length > 0 ? 'fail' : result.warnings.length > 0 ? 'warn' : 'pass';
      if (!options.json) console.log(`Wrote reviewed context baseline: ${written}`);
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (options.planBaseline) {
      const destination = typeof options.planBaseline === 'string'
        ? options.planBaseline
        : options.baselinePath ?? '.aiwg/context-memory-firewall-baseline.json';
      console.log(formatReviewBaselinePlan(result, destination));
    } else console.log(formatContextMemoryFirewall(result, { limit: options.limit }));
    const missingBaseline = !result.baseline.exists && !options.writeBaseline;
    if (options.strict && (missingBaseline || result.violations.length > 0)) return 1;
    return 0;
  } catch (error) {
    console.error(`Context/memory firewall error: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
