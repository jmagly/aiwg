import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { loadFortemiCoreMetadataEntries } from '../artifacts/fortemi-core-query-adapter.js';

export type ContextTier = 'line' | 'wiki';
export type ContextState = 'active' | 'stale' | 'contradicted' | 'superseded' | 'revoked' | 'origin-unavailable';

export interface ContextCandidate {
  tier: ContextTier;
  text: string;
  locator: string;
  digest: string | null;
  score: number;
  backend: string;
  verified: boolean;
  state: ContextState;
  freshness: string | null;
}

export interface ContextPackBudget {
  totalCharacters: number;
  lineCharacters: number;
  wikiCharacters: number;
  citationCharacters: number;
  instructionCharacters: number;
}

export interface ContextPack {
  schemaVersion: 'aiwg.compound-memory.context-pack.v1';
  id: string;
  taskDigest: string;
  backend: string[];
  budget: ContextPackBudget;
  used: {
    totalCharacters: number;
    lineCharacters: number;
    wikiCharacters: number;
    citationCharacters: number;
    instructionCharacters: number;
  };
  items: Array<ContextCandidate & { trust: 'quoted-data'; citation: string }>;
  instructions: Array<{ text: string; locator: string; trust: 'trusted' }>;
  excluded: Array<{ locator: string; reason: string }>;
  truncated: boolean;
  metrics: { candidates: number; selected: number; elapsedMs: number; maxFiles: number };
}

export interface WorkspaceContextOptions {
  budget?: Partial<ContextPackBudget>;
  maxFiles?: number;
  instructions?: Array<{ text: string; locator: string; trust: 'trusted' }>;
}

const DEFAULT_BUDGET: ContextPackBudget = {
  totalCharacters: 8000,
  lineCharacters: 2000,
  wikiCharacters: 4000,
  citationCharacters: 1500,
  instructionCharacters: 500,
};

const EXCLUDED_STATES = new Set<ContextState>([
  'contradicted', 'superseded', 'revoked', 'origin-unavailable',
]);

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function projectLocator(root: string, target: string): string {
  const actual = realpathSync(target);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new Error('context source cannot traverse a link outside the project');
  }
  return relative(root, actual).split(sep).join('/');
}

function terms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])];
}

function lexicalScore(taskTerms: readonly string[], text: string): number {
  if (taskTerms.length === 0) return 0;
  const normalized = text.toLocaleLowerCase();
  const hits = taskTerms.filter(term => normalized.includes(term)).length;
  return hits / taskTerms.length;
}

function normalizedClaim(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function resolvedBudget(input: Partial<ContextPackBudget> = {}): ContextPackBudget {
  const budget = { ...DEFAULT_BUDGET, ...input };
  boundedInteger(budget.totalCharacters, 256, 65536, 'totalCharacters');
  boundedInteger(budget.lineCharacters, 0, 65536, 'lineCharacters');
  boundedInteger(budget.wikiCharacters, 0, 65536, 'wikiCharacters');
  boundedInteger(budget.citationCharacters, 0, 16384, 'citationCharacters');
  boundedInteger(budget.instructionCharacters, 0, 8192, 'instructionCharacters');
  return budget;
}

function lineCandidates(root: string, taskTerms: readonly string[]): ContextCandidate[] {
  const memoryPath = resolve(root, '.aiwg/memory/line-memory.txt');
  const metadataPath = resolve(root, '.aiwg/memory/line-memory.meta.json');
  if (!existsSync(memoryPath)) return [];
  projectLocator(root, memoryPath);
  const values = readFileSync(memoryPath, 'utf8').split(/\r?\n/).filter(value => value.trim());
  let entries: Record<string, Record<string, unknown>> = {};
  if (existsSync(metadataPath)) {
    projectLocator(root, metadataPath);
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as { entries?: Record<string, Record<string, unknown>> };
    entries = parsed.entries ?? {};
  }
  return values.map<ContextCandidate>((text, index) => {
    const entry = Object.values(entries).find(candidate => candidate.value === text && candidate.status === 'active');
    const sources = Array.isArray(entry?.sources) ? entry.sources : [];
    const score = lexicalScore(taskTerms, text);
    return {
      tier: 'line',
      text,
      locator: typeof entry?.id === 'string' ? `line-memory:${entry.id}` : `.aiwg/memory/line-memory.txt#line-${index + 1}`,
      digest: typeof entry?.digest === 'string' ? entry.digest : sha256(text),
      score,
      backend: 'line-memory-lexical',
      verified: sources.length > 0,
      state: 'active',
      freshness: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }).filter(candidate => candidate.score > 0);
}

function markdownText(raw: string): string {
  return raw
    .replace(/^---\s*[\s\S]*?\n---\s*/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\?\[\[[^\]]+\]\]/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wikiCandidates(root: string, taskTerms: readonly string[], maxFiles: number): ContextCandidate[] {
  const wikiRoot = resolve(root, '.aiwg/wiki');
  if (!existsSync(wikiRoot)) return [];
  projectLocator(root, wikiRoot);
  const pending = [wikiRoot];
  const results: ContextCandidate[] = [];
  let visited = 0;
  while (pending.length > 0 && visited < maxFiles) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (visited >= maxFiles) break;
      const target = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      visited += 1;
      const locator = projectLocator(root, target);
      const raw = readFileSync(target, 'utf8').slice(0, 65536);
      const text = markdownText(raw).slice(0, 1200);
      const score = lexicalScore(taskTerms, text);
      if (score <= 0) continue;
      const stat = statSync(target);
      results.push({
        tier: 'wiki',
        text,
        locator,
        digest: sha256(raw),
        score,
        backend: 'wiki-lexical-fallback',
        verified: /(?:^|\n)(?:source|sources|provenance):/i.test(raw),
        state: 'active',
        freshness: stat.mtime.toISOString(),
      });
    }
  }
  return results;
}

function fortemiWikiCandidates(
  root: string,
  taskTerms: readonly string[],
  maxFiles: number,
): ContextCandidate[] {
  const loaded = loadFortemiCoreMetadataEntries(root, 'project');
  if (loaded.reason || loaded.entries.length === 0) return [];
  const results: ContextCandidate[] = [];
  for (const entry of loaded.entries
    .filter(candidate => candidate.path.startsWith('.aiwg/wiki/') && candidate.path.endsWith('.md'))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, maxFiles)) {
    const target = resolve(root, entry.path);
    if (!existsSync(target)) continue;
    const locator = projectLocator(root, target);
    const raw = readFileSync(target, 'utf8').slice(0, 65536);
    const text = markdownText(raw).slice(0, 1200);
    const score = lexicalScore(taskTerms, [entry.title, entry.summary, text].join(' '));
    if (score <= 0) continue;
    results.push({
      tier: 'wiki',
      text,
      locator,
      digest: /^(?:sha256:)?[0-9a-f]{64}$/i.test(entry.checksum)
        ? `sha256:${entry.checksum.replace(/^sha256:/, '').toLocaleLowerCase()}`
        : sha256(raw),
      score,
      backend: 'fortemi-core',
      verified: /(?:^|\n)(?:source|sources|provenance):/i.test(raw),
      state: 'active',
      freshness: entry.updated || statSync(target).mtime.toISOString(),
    });
  }
  return results;
}

function rank(candidates: readonly ContextCandidate[]): ContextCandidate[] {
  const effectiveScore = (candidate: ContextCandidate) => (
    candidate.state === 'stale' ? candidate.score * 0.5 : candidate.score
  );
  return [...candidates].sort((left, right) => (
    effectiveScore(right) - effectiveScore(left)
    || (left.tier === right.tier ? 0 : left.tier === 'line' ? -1 : 1)
    || left.locator.localeCompare(right.locator)
  ));
}

export function buildContextPack(
  task: string,
  candidates: readonly ContextCandidate[],
  options: WorkspaceContextOptions = {},
): ContextPack {
  const started = performance.now();
  const budget = resolvedBudget(options.budget);
  const maxFiles = boundedInteger(options.maxFiles ?? 1000, 1, 10000, 'maxFiles');
  const excluded: ContextPack['excluded'] = [];
  const deduplicated = new Map<string, ContextCandidate>();
  for (const candidate of rank(candidates)) {
    if (EXCLUDED_STATES.has(candidate.state)) {
      excluded.push({ locator: candidate.locator, reason: candidate.state });
      continue;
    }
    const key = normalizedClaim(candidate.text);
    if (!key) continue;
    if (deduplicated.has(key)) {
      excluded.push({ locator: candidate.locator, reason: 'duplicate-claim' });
      continue;
    }
    deduplicated.set(key, candidate);
  }

  const used = {
    totalCharacters: 0,
    lineCharacters: 0,
    wikiCharacters: 0,
    citationCharacters: 0,
    instructionCharacters: 0,
  };
  const instructions: ContextPack['instructions'] = [];
  for (const instruction of options.instructions ?? []) {
    const cost = instruction.text.length;
    if (used.instructionCharacters + cost > budget.instructionCharacters
      || used.totalCharacters + cost > budget.totalCharacters) {
      excluded.push({ locator: instruction.locator, reason: 'instruction-budget' });
      continue;
    }
    instructions.push(instruction);
    used.instructionCharacters += cost;
    used.totalCharacters += cost;
  }

  const items: ContextPack['items'] = [];
  for (const candidate of deduplicated.values()) {
    const section = candidate.tier === 'line' ? 'lineCharacters' : 'wikiCharacters';
    const sectionLimit = candidate.tier === 'line' ? budget.lineCharacters : budget.wikiCharacters;
    const citation = `${candidate.locator}${candidate.digest ? ` ${candidate.digest}` : ''}`;
    const contentCost = candidate.text.length;
    const citationCost = citation.length;
    if (used[section] + contentCost > sectionLimit) {
      excluded.push({ locator: candidate.locator, reason: `${candidate.tier}-budget` });
      continue;
    }
    if (used.citationCharacters + citationCost > budget.citationCharacters) {
      excluded.push({ locator: candidate.locator, reason: 'citation-budget' });
      continue;
    }
    if (used.totalCharacters + contentCost + citationCost > budget.totalCharacters) {
      excluded.push({ locator: candidate.locator, reason: 'total-budget' });
      continue;
    }
    items.push({ ...candidate, trust: 'quoted-data', citation });
    used[section] += contentCost;
    used.citationCharacters += citationCost;
    used.totalCharacters += contentCost + citationCost;
  }

  const identity = {
    taskDigest: sha256(task),
    budget,
    items: items.map(item => ({ locator: item.locator, digest: item.digest, text: item.text })),
    instructions,
  };
  return {
    schemaVersion: 'aiwg.compound-memory.context-pack.v1',
    id: sha256(JSON.stringify(identity)),
    taskDigest: identity.taskDigest,
    backend: [...new Set(items.map(item => item.backend))].sort(),
    budget,
    used,
    items,
    instructions,
    excluded,
    truncated: excluded.some(item => item.reason.endsWith('budget')),
    metrics: {
      candidates: candidates.length,
      selected: items.length,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      maxFiles,
    },
  };
}

export function buildWorkspaceContextPack(
  projectRoot: string,
  task: string,
  options: WorkspaceContextOptions = {},
): ContextPack {
  const started = performance.now();
  if (!task.trim()) throw new Error('context task must be nonblank');
  const root = realpathSync(projectRoot);
  const taskTerms = terms(task);
  const maxFiles = boundedInteger(options.maxFiles ?? 1000, 1, 10000, 'maxFiles');
  const candidates = [
    ...lineCandidates(root, taskTerms),
    ...(() => {
      const indexed = fortemiWikiCandidates(root, taskTerms, maxFiles);
      return indexed.length > 0 ? indexed : wikiCandidates(root, taskTerms, maxFiles);
    })(),
  ];
  const pack = buildContextPack(task, candidates, { ...options, maxFiles });
  // Workspace callers need retrieval plus assembly latency, not assembly alone.
  pack.metrics.elapsedMs = Number((performance.now() - started).toFixed(3));
  return pack;
}
