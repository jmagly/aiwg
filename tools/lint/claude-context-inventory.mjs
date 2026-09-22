#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export const DEFAULT_SKILL_CEILING_BYTES = 24 * 1024;
export const DEFAULT_AGENT_CEILING_BYTES = 16 * 1024;

// Conservative standard-context baseline. Current Claude models advertise 1M
// windows, but 1M dispatch can be gated behind usage credits on some plans, so
// AIWG keeps fitting the 200K standard baseline.
export const STANDARD_SONNET_BUDGET_TOKENS = 200000;
// Warn before the hard ceiling so there is headroom for the base system prompt, tool
// definitions, skill listings, and at least the opening turns of real work.
export const DEFAULT_STARTUP_WARN_RATIO = 0.6;

// Files Claude Code inlines into every session at startup (full body), in load order.
// Skill *bodies* are excluded: skills load by name/description and only inject their
// body when invoked (see issue #1672 doc findings), so they are not mandatory startup.
export const STARTUP_CONTEXT_SOURCES = [
  { label: 'CLAUDE.md', kind: 'memory', glob: ['CLAUDE.md'] },
  { label: 'AIWG.md', kind: 'memory', glob: ['AIWG.md'] },
  { label: '.aiwg/AIWG.md', kind: 'memory', glob: ['.aiwg/AIWG.md'] },
  { label: 'AGENTS.md', kind: 'memory', glob: ['AGENTS.md'] },
  { label: '.claude/rules/*.md', kind: 'rules', dir: '.claude/rules', ext: '.md' },
];

// Ancestor directories contribute their CLAUDE.md and rules too (#2562).
export const ANCESTOR_CONTEXT_SOURCES = [
  { label: 'CLAUDE.md', kind: 'memory', glob: ['CLAUDE.md'] },
  { label: '.claude/rules/*.md', kind: 'rules', dir: '.claude/rules', ext: '.md' },
];

export const DEFAULT_SKILL_GLOBS = [
  'agentic/code/**/skills/**/SKILL.md',
  '.claude/skills/**/SKILL.md',
  '.github/skills/**/SKILL.md',
];

export const DEFAULT_AGENT_DIRS = [
  'agentic/code',
  '.claude/agents',
  '.github/agents',
];

const SKILL_RE = /(?:^|\/)skills\/[^/]+\/SKILL\.md$/;
const AGENT_RE = /(?:^|\/)(?:agents?|droids?)\/[^/]+\.md$/;

async function listFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  }
  await walk(rootDir);
  return files;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  try {
    return YAML.parse(text.slice(4, end)) ?? {};
  } catch {
    return {};
  }
}

function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

function toRel(rootDir, absPath) {
  return path.relative(rootDir, absPath).split(path.sep).join('/');
}

function isClaudeFacing(relPath) {
  return (
    relPath.startsWith('agentic/code/') ||
    relPath.startsWith('.claude/') ||
    relPath.startsWith('.github/')
  );
}

export async function scanClaudeContextInventory(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const skillCeilingBytes = options.skillCeilingBytes ?? DEFAULT_SKILL_CEILING_BYTES;
  const agentCeilingBytes = options.agentCeilingBytes ?? DEFAULT_AGENT_CEILING_BYTES;
  const allFiles = await listFiles(rootDir);
  const records = [];

  for (const absPath of allFiles) {
    const relPath = toRel(rootDir, absPath);
    if (!isClaudeFacing(relPath)) continue;
    if (!SKILL_RE.test(relPath) && !AGENT_RE.test(relPath)) continue;

    const text = await fs.readFile(absPath, 'utf8');
    const stat = await fs.stat(absPath);
    const frontmatter = parseFrontmatter(text);
    const kind = SKILL_RE.test(relPath) ? 'skill' : 'agent';
    const hasSkillsPreload = Array.isArray(frontmatter.skills)
      ? frontmatter.skills.length > 0
      : typeof frontmatter.skills === 'string' && frontmatter.skills.trim().length > 0;
    const explicitFork = frontmatter.context === 'fork' || frontmatter['context'] === 'fork';

    records.push({
      kind,
      path: relPath,
      name: String(frontmatter.name ?? path.basename(path.dirname(absPath))),
      description: String(frontmatter.description ?? ''),
      bytes: stat.size,
      approxTokens: approxTokens(text),
      startupBehavior: kind === 'skill'
        ? 'listed by name/description; full body loads when invoked'
        : hasSkillsPreload
          ? 'custom subagent; skills preload at startup'
          : 'custom subagent; project memory/git status at startup',
      hasSkillsPreload,
      explicitFork,
      riskyPatterns: [
        stat.size > (kind === 'skill' ? skillCeilingBytes : agentCeilingBytes) ? 'oversized-body' : null,
        hasSkillsPreload ? 'skills-preload' : null,
        kind === 'skill' && /Dispatch\s+\d+\s+domain-specific auditor agents|parallel-dispatch/i.test(text) ? 'broad-parallel-dispatch' : null,
        kind === 'skill' && /outputs? (?:a |the )?(?:detailed|comprehensive)|detailed per-file|full scan/i.test(text) ? 'unbounded-output-risk' : null,
      ].filter(Boolean),
    });
  }

  records.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return {
    skillCeilingBytes,
    agentCeilingBytes,
    records,
    violations: records.filter((record) => record.riskyPatterns.length > 0),
  };
}

async function readIfExists(absPath) {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

async function listDirFiles(dir, ext) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (!ext || entry.name.endsWith(ext)))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

// Measure the aggregate context Claude Code inlines at session startup and compare it
// against the standard Sonnet budget. This is the dominant exhaustion driver in heavy
// AIWG deployments: even an empty prompt can exceed the standard window before any work
// begins, forcing a 1M-context upgrade (credit-gated) or immediate exhaustion.
export async function scanStartupContext(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const budgetTokens = options.budgetTokens ?? STANDARD_SONNET_BUDGET_TOKENS;
  const warnRatio = options.warnRatio ?? DEFAULT_STARTUP_WARN_RATIO;
  const includeAncestors = options.includeAncestors ?? true;
  const components = [];

  // Claude Code walks up from the working directory and inlines every
  // ancestor's CLAUDE.md and `.claude/rules/*.md` alongside the project's own.
  // A project nested under a workspace that carries its own rule deployment
  // starts with both sets, which is what turned a "~97K, ok" project into a
  // subagent dispatch failure with "Prompt is too long" (#2562).
  if (includeAncestors) {
    let current = path.resolve(rootDir);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
      const relative = path.relative(rootDir, current) || '.';
      for (const source of ANCESTOR_CONTEXT_SOURCES) {
        if (source.glob) {
          for (const rel of source.glob) {
            const text = await readIfExists(path.join(current, rel));
            if (text == null) continue;
            components.push({
              label: `${relative}/${rel}`, kind: source.kind, files: 1,
              bytes: Buffer.byteLength(text), approxTokens: approxTokens(text), ancestor: current,
            });
          }
        } else if (source.dir) {
          const files = await listDirFiles(path.join(current, source.dir), source.ext);
          let bytes = 0;
          let tokens = 0;
          for (const file of files) {
            const text = await readIfExists(file);
            if (text == null) continue;
            bytes += Buffer.byteLength(text);
            tokens += approxTokens(text);
          }
          if (files.length > 0) {
            components.push({
              label: `${relative}/${source.label}`, kind: source.kind, files: files.length,
              bytes, approxTokens: tokens, ancestor: current,
            });
          }
        }
      }
    }
  }

  for (const source of STARTUP_CONTEXT_SOURCES) {
    if (source.glob) {
      for (const rel of source.glob) {
        const text = await readIfExists(path.join(rootDir, rel));
        if (text == null) continue;
        components.push({ label: rel, kind: source.kind, files: 1, bytes: Buffer.byteLength(text), approxTokens: approxTokens(text) });
      }
    } else if (source.dir) {
      const files = await listDirFiles(path.join(rootDir, source.dir), source.ext);
      let bytes = 0;
      let tokens = 0;
      for (const file of files) {
        const text = await readIfExists(file);
        if (text == null) continue;
        bytes += Buffer.byteLength(text);
        tokens += approxTokens(text);
      }
      if (files.length > 0) {
        components.push({ label: source.label, kind: source.kind, files: files.length, bytes, approxTokens: tokens });
      }
    }
  }

  const totalTokens = components.reduce((sum, c) => sum + c.approxTokens, 0);
  const totalBytes = components.reduce((sum, c) => sum + c.bytes, 0);
  const warnTokens = Math.floor(budgetTokens * warnRatio);
  let status = 'ok';
  if (totalTokens > budgetTokens) status = 'over';
  else if (totalTokens > warnTokens) status = 'warn';

  const ancestorTokens = components.filter((c) => c.ancestor).reduce((sum, c) => sum + c.approxTokens, 0);

  return {
    rootDir,
    budgetTokens,
    warnTokens,
    warnRatio,
    components: components.sort((a, b) => b.approxTokens - a.approxTokens),
    totalBytes,
    totalTokens,
    /** Tokens contributed by ancestor directories' CLAUDE.md and rules (#2562). */
    ancestorTokens,
    status,
  };
}

// Subagent dispatch headroom (#2562). A dispatch inherits the inlined startup
// context plus the agent definition and the base system prompt, and still
// needs room to work inside the standard window.
export const SUBAGENT_AGENT_DEF_TOKENS = 4_000;       // 16 KB agent-def ceiling
export const SUBAGENT_SYSTEM_PROMPT_TOKENS = 12_000;  // base system prompt + tool schemas
export const SUBAGENT_MIN_WORKING_TOKENS = 40_000;    // room to actually do the task

export function subagentDispatchHeadroom(startup) {
  const consumed = startup.totalTokens + SUBAGENT_AGENT_DEF_TOKENS + SUBAGENT_SYSTEM_PROMPT_TOKENS;
  const headroom = startup.budgetTokens - consumed;
  return {
    headroom,
    status: headroom < 0 ? 'fails' : headroom < SUBAGENT_MIN_WORKING_TOKENS ? 'at-risk' : 'ok',
  };
}

export function formatStartupContext(result) {
  const lines = [];
  lines.push('Startup context budget (standard Sonnet baseline):');
  lines.push(
    `  total ~${result.totalTokens} tokens vs budget ${result.budgetTokens} ` +
      `(warn ${result.warnTokens}) -> ${result.status.toUpperCase()}`,
  );
  for (const c of result.components) {
    lines.push(`    - ${c.label}: ~${c.approxTokens} tokens (${c.files} file${c.files === 1 ? '' : 's'})`);
  }
  if (result.status === 'over') {
    lines.push(
      '  OVER BUDGET: startup context exceeds the standard window. Claude Code will ' +
        'upgrade to the credit-gated 1M tier or exhaust context before work begins. ' +
        'Reduce deployed .claude/rules/* and memory files (pointer/index form, fewer ' +
        'always-on rules).',
    );
  } else if (result.status === 'warn') {
    lines.push('  WARNING: startup context leaves limited headroom for real work on standard Sonnet.');
  }
  return lines.join('\n');
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatClaudeContextInventory(result, options = {}) {
  const limit = options.limit ?? 25;
  const lines = [];
  const skills = result.records.filter((record) => record.kind === 'skill');
  const agents = result.records.filter((record) => record.kind === 'agent');
  lines.push(`Scanned ${skills.length} skill(s) and ${agents.length} agent/subagent definition(s).`);
  lines.push(`Skill ceiling: ${formatKb(result.skillCeilingBytes)}; agent ceiling: ${formatKb(result.agentCeilingBytes)}.`);
  lines.push('');
  lines.push(`Top ${Math.min(limit, result.records.length)} largest Claude-facing artifacts:`);
  for (const record of result.records.slice(0, limit)) {
    const flags = record.riskyPatterns.length > 0 ? ` [${record.riskyPatterns.join(', ')}]` : '';
    lines.push(`  - ${record.path}: ${formatKb(record.bytes)}, ~${record.approxTokens} tokens, ${record.startupBehavior}${flags}`);
  }
  if (result.violations.length > 0) {
    lines.push('');
    lines.push('Flagged context risks:');
    for (const record of result.violations.slice(0, limit)) {
      lines.push(`  - ${record.path}: ${record.riskyPatterns.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let rootDir = process.cwd();
  let strict = false;
  let limit = 25;
  let startupOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      rootDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      rootDir = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--limit' && argv[i + 1]) {
      limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--startup') {
      startupOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/lint/claude-context-inventory.mjs [--root <repo>] [--limit N] [--startup] [--strict]\n' +
          '  --startup  Report only the aggregate startup-context budget.\n' +
          '  --strict   Exit non-zero on per-artifact violations OR startup context over budget.',
      );
      return 0;
    }
  }

  const startup = await scanStartupContext({ rootDir });

  if (startupOnly) {
    const report = formatStartupContext(startup);
    if (strict && startup.status === 'over') {
      console.error(report);
      return 1;
    }
    console.log(report);
    return 0;
  }

  const result = await scanClaudeContextInventory({ rootDir });
  const report = `${formatStartupContext(startup)}\n\n${formatClaudeContextInventory(result, { limit })}`;
  if (strict && (result.violations.length > 0 || startup.status === 'over')) {
    console.error(report);
    return 1;
  }
  console.log(report);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
