#!/usr/bin/env node
/**
 * AIWG Doctor Command
 * Checks installation health and diagnoses common issues
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync, execSync } from 'child_process';
import chalk from 'chalk';
import { importImpl } from '../_resolve-impl.mjs';
import { scanStartupContext } from '../lint/claude-context-inventory.mjs';
import { scanContextMemoryFirewall } from '../security/context-memory-firewall.mjs';

const { getFrameworkRoot, getPackageRoot, getVersionInfo } = await importImpl(
  import.meta.url,
  'channel/manager.mjs'
);
const { inspectInstallation } = await importImpl(
  import.meta.url,
  'installation/manager.mjs'
);
const { communityDataPath, loadCommunityLinks, validateCommunityLinks } = await importImpl(
  import.meta.url,
  'community/links.js'
);
const { maybePrintCommunityFooter } = await importImpl(
  import.meta.url,
  'community/footer.js'
);
const { readIndexConfig, validateIndexConfig } = await importImpl(
  import.meta.url,
  'config/aiwg-config.js'
);

const { collectIndexStatus } = await importImpl(
  import.meta.url,
  'artifacts/index-status.js'
);
const { getFortemiCoreExecutableSkillStatus, getFortemiCorePrebuiltStatus, getFortemiCoreSyncStatus } = await importImpl(
  import.meta.url,
  'artifacts/fortemi-core-sync.js'
);
const { checkGitignore } = await importImpl(
  import.meta.url,
  'config/gitignore.js'
);
const { auditLegacyPermissions } = await importImpl(
  import.meta.url,
  'policy/authorization.js'
);
const { readAiwgConfig } = await importImpl(
  import.meta.url,
  'config/aiwg-config.js'
);
const { validateThreatAssessmentConfig } = await importImpl(
  import.meta.url,
  'security/threat-assessment-config.js'
);
const { validateArtifactOutputs } = await importImpl(
  import.meta.url,
  'artifacts/output-policy.js'
);
const { collectPackagedAgentInventory, diagnoseOversizedAgent } = await importImpl(
  import.meta.url,
  'agents/packaged-agent-inventory.js'
);
const { auditProjectArtifactHealth } = await importImpl(
  import.meta.url,
  'config/project-artifacts-health.mjs'
);

// AIWG_ROOT: env override > channel-manager resolved path > legacy edge path
// getFrameworkRoot() resolves correctly for npm global installs, edge, and dev channels.
const AIWG_ROOT = process.env.AIWG_ROOT || await getFrameworkRoot();

const checks = [];

// ---- Provider awareness (#1057) ----------------------------------------
// doctor used to hardcode .claude/agents and .claude/commands. On a project
// deployed to Factory, Codex, Cursor, etc. that produced misleading "No
// agents deployed" output. The per-provider section below resolves paths
// from the provider modules themselves (paths.agents / paths.commands)
// instead of literal .claude/* strings.

// Static registry of supported providers and their human-readable labels.
// Each entry exposes .paths via dynamic import so we don't pull all ten
// provider modules eagerly when the user hasn't deployed to any of them.
const PROVIDER_LABELS = {
  antigravity: 'Google Antigravity CLI',
  claude:   'Claude Code',
  factory:  'Factory',
  codex:    'Codex',
  copilot:  'Copilot',
  cursor:   'Cursor',
  opencode: 'OpenCode',
  warp:     'Warp',
  windsurf: 'Windsurf',
  openclaw: 'OpenClaw',
  openhuman: 'OpenHuman',
  omp: 'Oh My Pi',
  hermes:   'Hermes',
};

// Quick-detect dirs (agents-only) — used when no --provider flag is given.
// Mirrors the agents path each provider exports. Kept literal here so the
// check is fast and string-greppable without loading every provider module.
const PROVIDER_AGENT_DIRS = {
  antigravity: '.agents/agents',
  claude:   '.claude/agents',
  factory:  '.factory/droids',
  codex:    '.codex/agents',
  copilot:  '.github/agents',
  cursor:   '.cursor/agents',
  opencode: '.opencode/agent',
  warp:     '.warp/agents',
  windsurf: '.windsurf/agents',
  openhuman: '.agents/agents',
  omp: '.omp/agents',
  // openclaw/hermes deploy to ~/.{provider}/ — handled separately
};

// Parse doctor-specific flags from process.argv (no commander dependency).
function parseDoctorArgs(argv) {
  const out = {
    provider: null,
    allProviders: false,
    noBudgetCheck: false,
    strictContext: false,
    contextBaseline: '.aiwg/context-memory-firewall-baseline.json',
    contextBudgetTokens: 200_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--provider' && argv[i + 1]) { out.provider = argv[i + 1]; i += 1; continue; }
    if (a.startsWith('--provider=')) { out.provider = a.slice('--provider='.length); continue; }
    if (a === '--all-providers') { out.allProviders = true; continue; }
    if (a === '--no-budget-check') { out.noBudgetCheck = true; continue; }
    if (a === '--strict-context') { out.strictContext = true; continue; }
    if (a === '--context-baseline' && argv[i + 1]) { out.contextBaseline = argv[i + 1]; i += 1; continue; }
    if (a.startsWith('--context-baseline=')) { out.contextBaseline = a.slice('--context-baseline='.length); continue; }
    if (a === '--context-budget-tokens' && argv[i + 1]) {
      out.contextBudgetTokens = Number(argv[i + 1]); i += 1; continue;
    }
    if (a.startsWith('--context-budget-tokens=')) {
      out.contextBudgetTokens = Number(a.slice('--context-budget-tokens='.length)); continue;
    }
  }
  return out;
}

// ---- Skill listing budget check (#1150) -------------------------------
//
// Estimates the size of the skill listing the platform will render at
// session start and warns when it exceeds the platform's default budget,
// before the operator sees post-hoc truncation in /doctor (#1147).
//
// Per-platform model (see issue body for sources):
//   claude   — `skillListingBudgetFraction` × context window (default 1%
//              × 200k = 2000 tokens). User override read from
//              ~/.claude/settings.json.
//   codex    — fixed 8000-char cap built into Codex itself.
//   others   — skip (no documented budget).
//
// Token estimation: ~4 chars/token is the standard rough heuristic. Each
// listing entry is approximately `- name: description\n` so we sum
// `name.length + description.length + 5` per skill.

const CLAUDE_DEFAULT_BUDGET_FRACTION = 0.01;
const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CODEX_LISTING_CHAR_CAP = 8000;
const CHARS_PER_TOKEN = 4;

async function readClaudeBudgetOverride() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.config', 'claude', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      const txt = await fs.readFile(p, 'utf-8');
      const data = JSON.parse(txt);
      const v = data.skillListingBudgetFraction;
      if (typeof v === 'number' && v > 0 && v <= 1) return { value: v, source: p };
    } catch {
      /* missing or unreadable — try next */
    }
  }
  return null;
}

async function readContextWindowDirective() {
  // Honor `<!-- AIWG_CONTEXT_WINDOW: N -->` declared in the project's
  // platform context file (CLAUDE.md and friends, per context-budget rule).
  const candidates = [
    path.join(process.cwd(), 'CLAUDE.md'),
    path.join(process.cwd(), 'AGENTS.md'),
    path.join(process.cwd(), 'AIWG.md'),
  ];
  for (const p of candidates) {
    try {
      const txt = await fs.readFile(p, 'utf-8');
      const m = /AIWG_CONTEXT_WINDOW:\s*(\d+)/.exec(txt);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0) return { value: n, source: path.basename(p) };
      }
    } catch {
      /* missing — try next */
    }
  }
  return null;
}

async function resolveClaudeListingBudget() {
  const ctxDirective = await readContextWindowDirective();
  const ctx = ctxDirective?.value ?? CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const override = await readClaudeBudgetOverride();
  const fraction = override?.value ?? CLAUDE_DEFAULT_BUDGET_FRACTION;
  return {
    budgetTokens: Math.floor((ctx * fraction) / CHARS_PER_TOKEN),
    ctx,
    ctxDirective,
    fraction,
    override,
  };
}

// Strip a single ---\n...\n--- frontmatter block and pull `name:` and
// `description:` keys. Cheaper than a full YAML parse and good enough — the
// real listing render uses the same first-N-chars-from-frontmatter shape.
function extractSkillFrontmatter(src) {
  const fmEnd = src.indexOf('\n---', 4);
  if (!src.startsWith('---') || fmEnd < 0) return null;
  const block = src.slice(3, fmEnd);
  // Multi-line description support: collapse continuation lines that don't
  // start with a top-level key into the previous value.
  const out = {};
  const lines = block.split('\n');
  let lastKey = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { lastKey = null; continue; }
    const m = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = m[1];
      out[lastKey] = m[2].trim();
    } else if (lastKey && line.startsWith(' ')) {
      out[lastKey] = `${out[lastKey]} ${line.trim()}`.trim();
    }
  }
  return out;
}

async function measureSkillsListing(skillsDir) {
  let totalChars = 0;
  let count = 0;
  let totalDescChars = 0;
  let entries = [];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, dirent.name, 'SKILL.md');
    let raw = '';
    try {
      raw = await fs.readFile(skillFile, 'utf-8');
    } catch {
      continue;
    }
    const fm = extractSkillFrontmatter(raw);
    if (!fm?.name) continue;
    const desc = (fm.description || '').replace(/^["']|["']$/g, '');
    const entryChars = fm.name.length + desc.length + 5; // "- name: desc\n"
    totalChars += entryChars;
    totalDescChars += desc.length;
    count += 1;
  }
  if (count === 0) return null;
  return {
    count,
    totalChars,
    totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    avgDescChars: Math.round(totalDescChars / count),
  };
}

function mergeSkillMeasurements(measurements) {
  const present = measurements.filter(Boolean);
  if (present.length === 0) return null;
  const count = present.reduce((sum, item) => sum + item.count, 0);
  const totalChars = present.reduce((sum, item) => sum + item.totalChars, 0);
  return {
    count,
    totalChars,
    totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    avgDescChars: Math.round(
      present.reduce((sum, item) => sum + (item.avgDescChars * item.count), 0) / count,
    ),
  };
}

async function checkTotalDeployedSkillBudgetForProvider(provName, label, provider) {
  const paths = new Set();
  if (provider?.kernelSkillsPath) paths.add(provider.kernelSkillsPath);
  // Codex only scans the native kernel directory at startup. Standard-tier
  // skills remain available through `aiwg discover`/`aiwg show`, but adding
  // their hidden storage path here produces a false over-budget warning.
  if (provName !== 'codex' && provider?.paths?.skills) paths.add(provider.paths.skills);
  if (paths.size === 0) return;

  const measurements = [];
  for (const relPath of paths) {
    const skillsDir = resolveProviderPath(relPath);
    if (!skillsDir || !(await fileExists(skillsDir))) continue;
    measurements.push(await measureSkillsListing(skillsDir));
  }

  const stats = mergeSkillMeasurements(measurements);
  if (!stats) return;

  if (provName === 'claude') {
    const { budgetTokens, fraction, override } = await resolveClaudeListingBudget();
    if (stats.totalTokens > budgetTokens) {
      const budgetLabel = override ? 'configured listing budget' : 'default listing budget';
      check(
        `${label} Deployed Skill Count`,
        'warn',
        `${stats.count} deployed skills estimate ${stats.totalTokens.toLocaleString()} tokens, above Claude Code's ${budgetLabel} (${budgetTokens.toLocaleString()} tokens at ${(fraction * 100).toFixed(2)}%). Run \`aiwg use all\` for workspace-aware filtering or \`aiwg list --deployed\` to inspect include/exclude reasons. Refs #1609.`,
      );
    } else if (override) {
      check(
        `${label} Deployed Skill Count`,
        'ok',
        `${stats.count} deployed skills estimate ${stats.totalTokens.toLocaleString()} tokens, within Claude Code's configured listing budget (${budgetTokens.toLocaleString()} tokens at ${(fraction * 100).toFixed(2)}%).`,
      );
    }
  } else if (provName === 'codex' && stats.totalChars > CODEX_LISTING_CHAR_CAP) {
    check(
      `${label} Deployed Skill Count`,
      'warn',
      `${stats.count} startup-visible skills estimate ${stats.totalChars.toLocaleString()} chars, above Codex's default listing cap (${CODEX_LISTING_CHAR_CAP.toLocaleString()} chars). Run \`aiwg use all --provider codex --force\` to restore the kernel-only deployment, or \`aiwg list --deployed\` to inspect include/exclude reasons.`,
    );
  }
}

async function checkSkillBudgetForProvider(provName, label, skillsPathRel) {
  if (!skillsPathRel || skillsPathRel === 'native' || skillsPathRel === true) {
    // Not a deployable skill path on this provider.
    return;
  }
  const skillsDir = resolveProviderPath(skillsPathRel);
  if (!skillsDir || !(await fileExists(skillsDir))) return;

  const stats = await measureSkillsListing(skillsDir);
  if (!stats) return;

  // Determine the budget for this provider.
  let budget = null;
  let budgetUnit = 'tokens';
  let budgetSource = '';
  let usage = stats.totalTokens;
  let usageUnit = 'tokens';
  let recommendations = [];

  let usingOverride = false;

  if (provName === 'claude') {
    const budgetInfo = await resolveClaudeListingBudget();
    const { ctx, ctxDirective, fraction, override } = budgetInfo;
    usingOverride = Boolean(override);
    budget = budgetInfo.budgetTokens;
    budgetSource = override
      ? `${(fraction * 100).toFixed(2)}% × ${ctx.toLocaleString()} ctx (override in ${override.source.replace(os.homedir(), '~')})`
      : `${(fraction * 100).toFixed(2)}% × ${ctx.toLocaleString()} ctx (default)${ctxDirective ? ` — ctx from ${ctxDirective.source}` : ''}`;
    if (usage > budget) {
      // Round up to next 1% step, capped at 10%.
      const needed = (usage * CHARS_PER_TOKEN) / ctx;
      const recommendedFraction = Math.min(0.1, Math.ceil(needed * 100) / 100);
      const verb = override ? 'raise' : 'set';
      recommendations.push(
        `${verb} skillListingBudgetFraction to ${recommendedFraction} (~${Math.round(recommendedFraction * 100)}%) in ~/.claude/settings.json`,
      );
      recommendations.push('or remove unused frameworks (e.g. aiwg remove media-marketing)');
      recommendations.push('see docs/skills-budget-guide.md for full options');
    }
  } else if (provName === 'codex') {
    budget = CODEX_LISTING_CHAR_CAP;
    budgetUnit = 'chars';
    usage = stats.totalChars;
    usageUnit = 'chars';
    budgetSource = `${CODEX_LISTING_CHAR_CAP.toLocaleString()}-char built-in cap`;
    if (usage > budget) {
      recommendations.push('run `aiwg use all --provider codex --force` to restore the kernel-only deployment');
      recommendations.push('use `aiwg list --deployed` to inspect include/exclude reasons');
    }
  } else {
    // Other platforms: emit an info-level usage line without a verdict so
    // the operator still sees the surface area.
    check(
      `${label} Skill Budget`,
      'info',
      `${stats.count} skills, ~${stats.totalTokens.toLocaleString()} tokens — no documented budget for ${provName}, skipping verdict`,
    );
    return;
  }

  const ratio = usage / budget;
  const usageStr = `${usage.toLocaleString()} ${usageUnit}`;
  const budgetStr = `${budget.toLocaleString()} ${budgetUnit}`;
  const summary = `${stats.count} skills (avg ${stats.avgDescChars} chars desc), est. ${usageStr} vs ${budgetStr} budget — ${budgetSource}`;

  if (usage > budget) {
    const recBlock = recommendations.length ? ` | ${recommendations.join(' | ')}` : '';
    const verdict = usingOverride ? 'EXCEEDS OVERRIDE' : 'EXCEEDS DEFAULT';
    check(`${label} Skill Budget`, 'warn', `${verdict} (${ratio.toFixed(2)}×) — ${summary}${recBlock}`);
  } else {
    check(`${label} Skill Budget`, 'ok', `${ratio < 0.5 ? 'OK' : 'tight'} (${ratio.toFixed(2)}×) — ${summary}`);
  }
}

// Startup-context budget (#1673). The skill-listing budget above covers skill
// names/descriptions; this measures the aggregate context Claude Code inlines at
// session start — memory files + every `.claude/rules/*.md` (full body, no
// progressive disclosure) — against the 200K standard Sonnet window. On heavy
// `aiwg use all` deployments this is the dominant exhaustion driver (#1672): the
// standing rules alone can exceed the window before any prompt, forcing the
// credit-gated 1M upgrade or immediate `Context limit reached`. Claude-only;
// non-fatal (re-deploy can't fix a structural over-budget — see the
// enforcement-tiered deployment ADR).
async function checkStartupContextBudget(provName, label) {
  if (provName !== 'claude') return;
  let startup;
  try {
    startup = await scanStartupContext({ rootDir: process.cwd() });
  } catch {
    return; // best-effort; never block doctor on the budget probe
  }
  if (!startup || startup.components.length === 0) return; // nothing deployed here

  const k = (n) => `${Math.round(n / 1000)}K`;
  const top = startup.components
    .slice(0, 2)
    .map((c) => `${c.label} ~${k(c.approxTokens)}`)
    .join(', ');
  const headline =
    `~${k(startup.totalTokens)} tok of ${k(startup.budgetTokens)} standard window ` +
    `(memory + .claude/rules); top: ${top}`;

  if (startup.status === 'over') {
    check(
      `${label} Startup Context`,
      'warn',
      `OVER budget — ${headline}. Exceeds the standard Sonnet window before any prompt; ` +
        `forces the credit-gated 1M tier or immediate exhaustion. Reduce always-on rules ` +
        `(see the enforcement-tiered deployment ADR / #1673) or narrow the install.`,
    );
  } else if (startup.status === 'warn') {
    check(
      `${label} Startup Context`,
      'warn',
      `tight — ${headline}. Limited headroom for real work on standard Sonnet. ` +
        `Run \`aiwg context-firewall scan --provider claude\` for the attributed breakdown (#1673).`,
    );
  } else {
    check(`${label} Startup Context`, 'ok', headline);
  }
}

async function loadProvider(name) {
  try {
    const providerPath = path.join(AIWG_ROOT, 'tools/agents/providers', `${name}.mjs`);
    const mod = await import(pathToFileURL(providerPath).href);
    return mod.default || mod;
  } catch (err) {
    if (process.env.AIWG_DEBUG) {
      console.error(`loadProvider(${name}) failed: ${err?.message ?? err}`);
    }
    return null;
  }
}

// Resolve an absolute project path from a provider's paths.<kind> entry.
// Some providers export absolute paths (openclaw, hermes); relative ones
// resolve against process.cwd().
function resolveProviderPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

async function detectDeployedProviders() {
  const detected = [];
  for (const [name, dir] of Object.entries(PROVIDER_AGENT_DIRS)) {
    if (await fileExists(path.join(process.cwd(), dir))) detected.push(name);
  }
  // Aggregated providers (Windsurf / Hermes) leave a project-root AGENTS.md.
  if (await fileExists(path.join(process.cwd(), 'AGENTS.md')) && !detected.includes('windsurf')) {
    detected.push('windsurf');
  }
  return detected;
}

function check(name, status, message) {
  checks.push({ name, status, message });
}

function hasSigningMaterial(signing) {
  return Boolean(signing && (signing.key || signing.key_file));
}

function hasTrackerRemote(remotes) {
  return Boolean(remotes && (remotes.issue_tracker || remotes.primary));
}

function childProcessSucceeded(err) {
  return Boolean(err && err.status === 0);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseOpenHumanHarnessToml(content) {
  const scalar = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(content);
    return match?.[1] ?? '';
  };
  const file = /^\s*file\s*=\s*"([^"]+)"/m.exec(content)?.[1] ?? '';
  const inline = /^\s*inline\s*=\s*(?:'''([\s\S]*?)'''|"([^"]*)")/m.exec(content);
  return {
    id: scalar('id'),
    whenToUse: scalar('when_to_use'),
    hasSystemPromptTable: /^\s*\[system_prompt\]\s*$/m.test(content),
    file,
    inline: inline ? (inline[1] ?? inline[2] ?? '') : '',
    hasSubagents: /^\s*subagents\s*=/m.test(content),
  };
}

async function checkOpenHumanHarnessTier2() {
  const roots = [
    { scope: 'project', dir: path.join(process.cwd(), 'agents') },
    { scope: 'user', dir: path.join(process.env.OPENHUMAN_HOME || path.join(os.homedir(), '.openhuman'), 'agents') },
  ];
  const findings = [];
  const ids = new Map();
  let fileCount = 0;

  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('aiwg_') || !entry.name.endsWith('.toml')) continue;
      fileCount += 1;
      const tomlPath = path.join(root.dir, entry.name);
      let content = '';
      try {
        content = await fs.readFile(tomlPath, 'utf-8');
      } catch (err) {
        findings.push(`${tomlPath}: unreadable (${err?.message ?? err})`);
        continue;
      }
      const parsed = parseOpenHumanHarnessToml(content);
      if (!parsed.id) findings.push(`${tomlPath}: missing id`);
      if (parsed.id && !parsed.id.startsWith('aiwg_')) findings.push(`${tomlPath}: id '${parsed.id}' is not aiwg_-prefixed`);
      if (parsed.id) {
        const prior = ids.get(parsed.id);
        if (prior) findings.push(`${tomlPath}: duplicate id '${parsed.id}' also in ${prior}`);
        else ids.set(parsed.id, tomlPath);
      }
      if (!parsed.whenToUse.trim()) findings.push(`${tomlPath}: missing when_to_use`);
      if (!parsed.hasSystemPromptTable) findings.push(`${tomlPath}: missing [system_prompt] table`);
      if (parsed.hasSubagents) findings.push(`${tomlPath}: Worker-tier AIWG harness definitions must not set subagents`);

      if (root.scope === 'project') {
        if (!parsed.file) {
          findings.push(`${tomlPath}: project-scope harness definition must use [system_prompt] file`);
        } else {
          const promptPath = path.join(process.cwd(), 'agent', 'prompts', parsed.file);
          try {
            const prompt = await fs.readFile(promptPath, 'utf-8');
            if (!prompt.trim()) findings.push(`${tomlPath}: prompt file is empty (${promptPath})`);
            if (/^---\s*$/m.test(prompt)) findings.push(`${tomlPath}: prompt file still contains YAML frontmatter (${promptPath})`);
          } catch {
            findings.push(`${tomlPath}: prompt file missing (${promptPath})`);
          }
        }
        if (parsed.inline) findings.push(`${tomlPath}: project-scope harness definition should not inline the prompt`);
      } else {
        if (!parsed.inline.trim()) findings.push(`${tomlPath}: user-scope harness definition must contain a non-empty inline prompt`);
        if (parsed.file) findings.push(`${tomlPath}: user-scope harness definition should not use file prompts`);
      }
    }
  }

  if (findings.length > 0) {
    check('OpenHuman Tier-2 harness', 'error', findings.slice(0, 4).join('; ') + (findings.length > 4 ? `; +${findings.length - 4} more` : ''));
  } else if (fileCount > 0) {
    check('OpenHuman Tier-2 harness', 'ok', `${fileCount} AIWG native harness definition(s) valid`);
  } else {
    check('OpenHuman Tier-2 harness', 'ok', 'No AIWG native harness definitions installed');
  }
}

const BRAND_HEX = '#818CF8';

async function runDoctor() {
  const isTTY = Boolean(process.stdout.isTTY);
  const mark = isTTY ? chalk.hex(BRAND_HEX)('◆') : '◆';
  const rule = isTTY ? chalk.dim('  ' + '─'.repeat(42)) : '  ' + '-'.repeat(42);

  console.log('');
  console.log(isTTY ? `  ${mark} ${chalk.bold('AIWG Doctor')}` : '  ◆ AIWG Doctor');
  console.log(rule);
  console.log('');

  // 1. Check AIWG installation — use channel-manager resolved root, not legacy edge path
  const aiwgInstalled = await fileExists(AIWG_ROOT);
  if (aiwgInstalled) {
    check('AIWG Installation', 'ok', `Found at ${AIWG_ROOT}`);
  } else {
    check('AIWG Installation', 'error', `AIWG not found at ${AIWG_ROOT}. Run: npm install -g aiwg`);
  }

  const installation = inspectInstallation({ actualRoot: getPackageRoot() });
  const installationDetail = [
    `canonical=${installation.identity?.method ?? 'unrecorded'}:${installation.identity?.root ?? '(none)'}`,
    `actual=${installation.actualMethod}:${installation.actualRoot}`,
    // An edge/customize install launches from one root and reads the corpus
    // from another; naming both keeps this line and `aiwg installation show`
    // describing the same configuration (#2505).
    ...(installation.launcher ? [`launcher=${installation.launcher.method}:${installation.launcher.root}`] : []),
    `mode=${installation.identity?.runMode ?? 'unrecorded'}`,
    `state=${installation.state}`,
  ].join(' | ');
  check(
    'Installation Identity',
    installation.state === 'aligned' ? 'ok' : 'error',
    installation.state === 'aligned' ? installationDetail : `${installationDetail}. ${installation.drift.join('; ')}`,
  );

  // 1b. Build state — surface a missing/incomplete dist/ as a clear error with
  // remediation instead of letting consumers hit cryptic MODULE_NOT_FOUND at
  // CLI runtime. The `.mjs`/JSON/YAML files (incl. dist/src/update/notifier.mjs)
  // are copied by `npm run build:cli`'s build:copy-mjs step, separate from
  // tsc, so a partial build is plausible. Fixes #1513 (#1512 follow-up: the
  // research agent hit MODULE_NOT_FOUND in a checkout where dist/ was clean).
  if (aiwgInstalled) {
    const distDir = path.join(AIWG_ROOT, 'dist');
    const notifierEntry = path.join(distDir, 'src', 'update', 'notifier.mjs');
    const cliRouter = path.join(distDir, 'src', 'cli', 'router.js');
    const distExists = await fileExists(distDir);
    const notifierOk = await fileExists(notifierEntry);
    const routerOk = await fileExists(cliRouter);
    if (distExists && notifierOk && routerOk) {
      check('AIWG Build', 'ok', `dist/ built (router + notifier present)`);
    } else if (!distExists) {
      check('AIWG Build', 'error', `dist/ is missing at ${AIWG_ROOT}. Run: npm run build:cli (dev checkout) or reinstall via npm install -g aiwg`);
    } else {
      const missing = [
        !routerOk ? 'dist/src/cli/router.js' : null,
        !notifierOk ? 'dist/src/update/notifier.mjs' : null,
      ].filter(Boolean).join(', ');
      check('AIWG Build', 'error', `dist/ is incomplete (missing: ${missing}). Run: npm run build:cli to rebuild, or reinstall via npm install -g aiwg`);
    }
  }

  // 2. Check version — include channel label (stable / next / nightly / edge)
  let versionInfo = null;
  try {
    versionInfo = await getVersionInfo();
    const channelLabel = versionInfo.channel !== 'stable' ? ` [${versionInfo.channel}]` : '';
    check('AIWG Version', 'ok', `${versionInfo.version}${channelLabel}`);
  } catch {
    try {
      const version = execSync('aiwg -version 2>/dev/null', { encoding: 'utf-8' }).trim();
      check('AIWG Version', 'ok', version.split('\n')[0]);
    } catch {
      check('AIWG Version', 'warn', 'Could not determine version');
    }
  }

  // 2b. Customize mode — upstream staleness check (fork mode only)
  if (versionInfo?.devMode && versionInfo?.edgePath) {
    try {
      // Check if upstream remote exists (fork mode)
      const remotes = execSync('git remote', { cwd: versionInfo.edgePath, encoding: 'utf-8' }).trim().split('\n');
      if (remotes.includes('upstream')) {
        // Count commits upstream has that we don't
        let aheadCount = 0;
        try {
          execSync('git fetch upstream --dry-run', { cwd: versionInfo.edgePath, stdio: 'pipe' });
          aheadCount = parseInt(
            execSync('git rev-list HEAD..upstream/main --count', {
              cwd: versionInfo.edgePath, encoding: 'utf-8'
            }).trim(), 10
          ) || 0;
        } catch {
          // fetch dry-run can fail on no-network; skip count
        }
        const sourcePath = versionInfo.edgePath.replace(os.homedir(), '~');
        if (aheadCount > 0) {
          check(
            'Customize Mode',
            'info',
            `Active — source: ${sourcePath} | upstream has ${aheadCount} commit(s) — tell Steward "sync my AIWG" to update`,
          );
        } else {
          check('Customize Mode', 'ok', `Active (fork) — source: ${sourcePath} — up to date with upstream`);
        }
      } else {
        // Local clone mode (no upstream remote)
        const sourcePath = versionInfo.edgePath.replace(os.homedir(), '~');
        check('Customize Mode', 'ok', `Active (local clone) — source: ${sourcePath}`);
      }
    } catch {
      const sourcePath = versionInfo.edgePath.replace(os.homedir(), '~');
      check('Customize Mode', 'ok', `Active — source: ${sourcePath}`);
    }
  }

  try {
    const warnings = [];
    const links = loadCommunityLinks({ warn: (message) => warnings.push(message) });
    const issues = validateCommunityLinks(links);
    if (warnings.length > 0 || issues.length > 0 || links.channels.length === 0) {
      check('Community Links', 'warn', [...warnings, ...issues].join('; ') || 'No community channels configured');
    } else {
      check('Community Links', 'ok', communityDataPath());
    }
  } catch (err) {
    check('Community Links', 'warn', err instanceof Error ? err.message : String(err));
  }

  // 3. Check the repository-local control plane and external artifact corpus.
  const projectAiwg = path.join(process.cwd(), '.aiwg');
  const hasProjectAiwg = await fileExists(projectAiwg);
  if (hasProjectAiwg) {
    check('Project .aiwg/', 'ok', 'Found in current directory');
  } else {
    check('Project .aiwg/', 'info', 'No .aiwg/ in current directory (not an AIWG project)');
  }
  try {
    const artifactHealth = auditProjectArtifactHealth(process.cwd());
    if (artifactHealth.external_configured) {
      const detail = `${artifactHealth.classification}; local=${artifactHealth.local_control_root}; external=${artifactHealth.artifact_root}`;
      check(
        'External Artifact Corpus',
        artifactHealth.severity === 'ok' ? 'ok' : artifactHealth.severity === 'error' ? 'error' : 'warn',
        artifactHealth.action ? `${detail} — ${artifactHealth.action}` : detail,
      );
    }
  } catch (error) {
    check('External Artifact Corpus', 'error', `health audit failed: ${error.message}`);
  }

  // 4-5. Provider-aware agents + commands check (#1057).
  // Determine which providers to inspect:
  //   --provider <name>  → just that one
  //   --all-providers    → every supported provider
  //   (default)          → auto-detect deployed providers via PROVIDER_AGENT_DIRS
  const {
    provider: providerArg,
    allProviders,
    noBudgetCheck,
    strictContext,
    contextBaseline,
    contextBudgetTokens,
  } = parseDoctorArgs(process.argv.slice(2));
  let providersToCheck = [];
  if (providerArg) {
    providersToCheck = [providerArg];
  } else if (allProviders) {
    providersToCheck = Object.keys(PROVIDER_LABELS);
  } else {
    providersToCheck = await detectDeployedProviders();
    // Always include claude as a baseline so existing single-provider users
    // still get the "Claude Code Agents" line they're used to.
    if (!providersToCheck.includes('claude')) providersToCheck.unshift('claude');
  }

  // Compare deployed agent findings with the package that this Doctor process
  // is actually running. Deployment size alone cannot establish an upstream
  // package defect: a non-target provider may still contain older managed bytes.
  const packagedAgentInventory = await collectPackagedAgentInventory(AIWG_ROOT);

  for (const provName of providersToCheck) {
    const provider = await loadProvider(provName);
    const label = PROVIDER_LABELS[provName] || provName;
    if (!provider || !provider.paths) {
      check(`${label} Agents`, 'warn', `Unknown provider: ${provName}`);
      continue;
    }

    // Agents
    // #2506: track the per-class artifact counts so a provider tree that was
    // pruned to a half-deployed shape (commands/rules present, zero agents)
    // is reported instead of rendering as healthy.
    let deployedAgentCount = null;
    let deployedCommandCount = null;
    const agentsPathRel = provider.paths.agents;
    const agentsPath = resolveProviderPath(agentsPathRel);
    if (agentsPath && await fileExists(agentsPath)) {
      try {
        const stat = await fs.stat(agentsPath);
        if (stat.isDirectory()) {
          const files = await fs.readdir(agentsPath);
          const agentCount = files.filter(
            f => f.endsWith('.md') || f.endsWith('.agent.md') || f.endsWith('.toml'),
          ).length;
          deployedAgentCount = agentCount;
          check(
            `${label} Agents`,
            agentCount > 0 ? 'ok' : 'info',
            `${agentCount} agents deployed (${agentsPathRel})`,
          );

          // Agent-def size ceiling (#1587). A deployed agent definition is loaded
          // verbatim as the subagent system prompt; stacked with a rule-heavy host
          // context it can overflow the prompt budget and fail dispatch with
          // "Prompt is too long" at 0 tokens. Flag any def over the 16 KB ceiling.
          const AGENT_DEF_CEILING = 16 * 1024;
          const agentFiles = files.filter(
            f => f.endsWith('.md') || f.endsWith('.agent.md')
              || f.endsWith('.soul.md') || f.endsWith('.toml'),
          );
          const oversized = [];
          for (const f of agentFiles) {
            try {
              const fstat = await fs.stat(path.join(agentsPath, f));
              if (fstat.isFile() && fstat.size > AGENT_DEF_CEILING) {
                const content = await fs.readFile(path.join(agentsPath, f), 'utf8');
                oversized.push({
                  name: f,
                  size: fstat.size,
                  diagnosis: diagnoseOversizedAgent(
                    f,
                    content,
                    packagedAgentInventory,
                    AGENT_DEF_CEILING,
                  ),
                });
              }
            } catch {
              /* unreadable file — skip */
            }
          }
          if (oversized.length > 0) {
            oversized.sort((a, b) => b.size - a.size);
            const worst = oversized
              .slice(0, 3)
              .map(o => `${o.name} (${(o.size / 1024).toFixed(1)} KB)`)
              .join(', ');
            const currentPackage = oversized.filter(o => o.diagnosis === 'current-package').length;
            const staleDeployment = oversized.filter(o => o.diagnosis === 'stale-deployment').length;
            const unmanagedLocal = oversized.filter(o => o.diagnosis === 'unmanaged-local').length;
            const diagnoses = [];
            if (currentPackage > 0) {
              diagnoses.push(
                `${currentPackage} also exceed the ceiling in current packaged sources (current upstream packaging issue; externalize examples to the catalog)`,
              );
            }
            if (staleDeployment > 0) {
              diagnoses.push(
                `${staleDeployment} are stale managed deployment bytes while current packaged sources are within the ceiling (run aiwg refresh --provider ${provName})`,
              );
            }
            if (unmanagedLocal > 0) {
              diagnoses.push(
                `${unmanagedLocal} are unmanaged or project-local and cannot be attributed to the current package`,
              );
            }
            check(
              `${label} Agent def sizes`,
              'warn',
              `${oversized.length} agent def(s) over the 16 KB subagent-dispatch ceiling: ${worst}${oversized.length > 3 ? ', …' : ''}. ` +
              `${diagnoses.join('; ')}. Oversized defs can fail Task dispatch with "Prompt is too long".`,
            );
          } else if (agentFiles.length > 0) {
            check(`${label} Agent def sizes`, 'ok', `All ${agentFiles.length} agent defs ≤ 16 KB`);
          }
        } else {
          // Aggregated single-file (e.g. Hermes/Windsurf AGENTS.md)
          check(`${label} Agents`, 'ok', `Aggregated at ${agentsPathRel}`);
        }
      } catch {
        check(`${label} Agents`, 'info', `No agents deployed at ${agentsPathRel}`);
      }
    } else if (providerArg || allProviders) {
      // User explicitly asked about this provider — be explicit when missing.
      check(`${label} Agents`, 'info', `No agents deployed (run: aiwg use sdlc --provider ${provName})`);
    } else if (provName === 'claude') {
      // Default-case fallback for back-compat output.
      check('Claude Code Agents', 'info', 'No agents deployed (run: aiwg use sdlc)');
    }

    // Commands
    const commandsPathRel = provider.paths.commands;
    if (commandsPathRel) {
      const commandsPath = resolveProviderPath(commandsPathRel);
      if (commandsPath && await fileExists(commandsPath)) {
        try {
          const files = await fs.readdir(commandsPath);
          const cmdCount = files.filter(f => f.endsWith('.md') || f.endsWith('.prompt.md')).length;
          deployedCommandCount = cmdCount;
          check(`${label} Commands`, 'ok', `${cmdCount} commands deployed (${commandsPathRel})`);
        } catch {
          // Skip silently — commands are optional for several providers
        }
      } else if (provName === 'claude') {
        // Claude Code uses a skill-only deployment model — `aiwg use` does not
        // deploy slash commands here. Capabilities are reached via natural
        // language ("create an intake form") or `aiwg discover` (#1228).
        check(
          'Claude Code Commands',
          'ok',
          'Skill-only model — capabilities reached via natural language or `aiwg discover`'
        );
      }
    }

    // Deployment consistency (#2506). A provider tree holding commands or
    // rules but no agents is half-deployed: commands and rules reference
    // agents that are no longer on disk. This is the shape a cross-provider
    // prune used to leave behind, and a bare "0 agents deployed" check mark
    // is the line most likely to stop someone investigating.
    {
      const rulesPathRel = provider.paths.rules;
      const rulesPath = rulesPathRel ? resolveProviderPath(rulesPathRel) : null;
      let deployedRuleCount = null;
      if (rulesPath && await fileExists(rulesPath)) {
        try {
          const stat = await fs.stat(rulesPath);
          if (stat.isDirectory()) {
            const files = await fs.readdir(rulesPath);
            deployedRuleCount = files.filter(f => f.endsWith('.md') || f.endsWith('.mdc')).length;
          }
        } catch {
          /* unreadable rules dir — treat as unknown */
        }
      }
      const companions = [];
      if (deployedCommandCount > 0) companions.push(`${deployedCommandCount} command(s)`);
      if (deployedRuleCount > 0) companions.push(`${deployedRuleCount} rule(s)`);
      if (deployedAgentCount === 0 && companions.length > 0) {
        check(
          `${label} Deployment consistency`,
          'warn',
          `Half-deployed tree: ${companions.join(' and ')} present with 0 agents at ${agentsPathRel}. `
          + `Commands and rules can reference agents that are no longer on disk. `
          + `Run 'aiwg use sdlc --provider ${provName}' to restore the agent surface, `
          + `or remove the tree if this provider is no longer in use.`,
        );
      }

      // #2506: recorded deployment state that claims agents against an empty
      // directory is unambiguous drift. Only the zero-on-disk case is flagged;
      // per-bundle counts legitimately differ from a raw directory listing.
      if (deployedAgentCount === 0) {
        try {
          const cfg = await readAiwgConfig(process.cwd());
          const claiming = Object.entries(cfg?.installed ?? {})
            .filter(([, entry]) => (entry?.deployedTo?.[provName]?.agents ?? 0) > 0)
            .map(([name, entry]) => `${name} (${entry.deployedTo[provName].agents})`);
          if (claiming.length > 0) {
            check(
              `${label} Recorded deployment drift`,
              'warn',
              `.aiwg/aiwg.config records deployed agents for ${provName} that are not on disk: `
              + `${claiming.join(', ')}. Re-run 'aiwg use <bundle> --provider ${provName}' to redeploy, `
              + `or 'aiwg refresh --provider ${provName}' to reconcile.`,
            );
          }
        } catch {
          /* no readable config — nothing to reconcile against */
        }
      }
    }

    // Skill listing budget (#1150) — pre-flight warn before the operator
    // sees post-hoc truncation in /doctor inside the running session.
    //
    // Post-kernel-pivot (#1212): the platform's flat skill listing scans
    // `kernelSkillsPath` (e.g., `.claude/skills/`) — that's what the
    // budget actually applies to. Standard-tier skills under
    // `<provider>/.aiwg/skills/` are hidden from the platform scanner
    // and don't count against the budget.
    if (!noBudgetCheck) {
      const budgetPath = provider.kernelSkillsPath || provider.paths.skills;
      await checkSkillBudgetForProvider(provName, label, budgetPath);
      await checkTotalDeployedSkillBudgetForProvider(provName, label, provider);
      await checkStartupContextBudget(provName, label);
    }

    if (provName === 'openhuman') {
      await checkOpenHumanHarnessTier2();
    }
  }

  // Provider context and persistent-memory firewall (#2040). This complements
  // per-provider listing/startup estimates with one cross-category inventory,
  // deployment-manifest drift checks, reviewed digests, and poisoning labels.
  // The default doctor is advisory; --strict-context promotes any violation or
  // missing review baseline to an error and therefore a non-zero doctor exit.
  if (!noBudgetCheck) {
    try {
      const supported = providersToCheck.filter((name) =>
        ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'opencode', 'pi', 'omp', 'warp', 'windsurf', 'hermes', 'openhuman'].includes(name),
      );
      const firewall = await scanContextMemoryFirewall({
        rootDir: process.cwd(),
        packageRoot: AIWG_ROOT,
        providers: supported,
        baselinePath: contextBaseline,
        budgetTokens: contextBudgetTokens,
      });
      const stale = firewall.trust.stale;
      const quarantined = firewall.trust.quarantined;
      const external = firewall.trust.external;
      const changed = firewall.records.filter((record) => record.reviewStatus === 'changed-review-required').length;
      const categorySummary = Object.entries(firewall.categories)
        .map(([category, value]) => `${category}=${value.bytes.toLocaleString()}B`)
        .join(', ');
      const summary =
        `${firewall.totals.files} file(s), ~${firewall.totals.approxTokens.toLocaleString()} / `
        + `${firewall.budget.tokens.toLocaleString()} tokens; ${categorySummary}; `
        + `stale=${stale}, quarantined=${quarantined}, external=${external}, changed=${changed}`;
      const baselineMissing = !firewall.baseline.exists;
      const unsafe = firewall.violations.length > 0 || baselineMissing;
      if (unsafe) {
        const status = strictContext ? 'error' : 'warn';
        const baselineMessage = baselineMissing
          ? ` Review baseline missing at ${firewall.baseline.path}; run \`aiwg context-firewall baseline --plan\`, review every record, then use the confirmed write command it prints.`
          : '';
        check('Context/memory firewall', status, `${summary}.${baselineMessage}`);
      } else {
        check('Context/memory firewall', 'ok', `${summary}; reviewed baseline ${firewall.baseline.path}`);
      }
    } catch (error) {
      check('Context/memory firewall', strictContext ? 'error' : 'warn', `scan failed: ${error.message}`);
    }
  }

  // 5b. CLAUDE.md @AIWG.md hook check (#1437).
  // When claude is in the providers-to-check list AND the workspace has an
  // AIWG.md at the project root, verify CLAUDE.md exists AND contains the
  // AIWG-managed marker block. If not, point the operator at `aiwg regenerate`.
  if (providersToCheck.includes('claude')) {
    const projectRoot = process.cwd();
    const aiwgMd = path.join(projectRoot, 'AIWG.md');
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    const hasAiwgMd = await fileExists(aiwgMd);

    if (hasAiwgMd) {
      const hasClaudeMd = await fileExists(claudeMd);
      if (!hasClaudeMd) {
        check(
          'Claude CLAUDE.md hook',
          'warn',
          'AIWG.md exists at project root but CLAUDE.md is missing. Run `aiwg regenerate` to create it with the @AIWG.md include.',
        );
      } else {
        try {
          const claudeContent = await fs.readFile(claudeMd, 'utf-8');
          const hasStart = claudeContent.includes('<!-- AIWG:claude-md-hook:start -->');
          const hasEnd = claudeContent.includes('<!-- AIWG:claude-md-hook:end -->');
          const hasInclude = /^@AIWG\.md\s*$/m.test(claudeContent);

          if (hasStart && hasEnd) {
            // Marker block present — verify @AIWG.md include is inside it.
            const startIdx = claudeContent.indexOf('<!-- AIWG:claude-md-hook:start -->');
            const endIdx = claudeContent.indexOf('<!-- AIWG:claude-md-hook:end -->');
            const blockContent = claudeContent.substring(startIdx, endIdx);
            if (blockContent.includes('@AIWG.md')) {
              check('Claude CLAUDE.md hook', 'ok', 'AIWG-managed @AIWG.md hook block present in CLAUDE.md');
            } else {
              check(
                'Claude CLAUDE.md hook',
                'warn',
                'CLAUDE.md has AIWG marker block but the @AIWG.md include is missing inside it. Run `aiwg regenerate --force` to repair.',
              );
            }
          } else if (hasStart || hasEnd) {
            check(
              'Claude CLAUDE.md hook',
              'warn',
              'CLAUDE.md has a malformed AIWG hook block (one marker missing). Run `aiwg regenerate --force` to repair.',
            );
          } else if (hasInclude) {
            // Operator hand-added @AIWG.md without the marker block — works but
            // future regenerates can't manage it. Recommend the managed block.
            check(
              'Claude CLAUDE.md hook',
              'info',
              'CLAUDE.md includes @AIWG.md but not under the AIWG-managed marker block. Run `aiwg regenerate` to convert to managed block (future regenerates can update it cleanly).',
            );
          } else {
            check(
              'Claude CLAUDE.md hook',
              'warn',
              'AIWG.md exists but CLAUDE.md has no @AIWG.md link — Claude is not loading project AIWG context. Run `aiwg regenerate` to insert the hook.',
            );
          }
        } catch {
          check('Claude CLAUDE.md hook', 'warn', 'Could not read CLAUDE.md');
        }
      }
    }
    // If no AIWG.md exists, the regenerate-related check is silent — this is
    // an empty/non-AIWG project, not a hook problem. Other checks handle that.
  }

  // 5b-ii. AGENTS.md @AIWG.md hook check (#1597). Codex and the other AGENTS.md-based
  // providers need the @AIWG.md bridge inside AGENTS.md, mirroring the Claude check —
  // an operator-owned AGENTS.md without the hook silently drops AIWG context.
  {
    const projectRoot = process.cwd();
    const aiwgMd = path.join(projectRoot, 'AIWG.md');
    const agentsMd = path.join(projectRoot, 'AGENTS.md');
    if ((await fileExists(aiwgMd)) && (await fileExists(agentsMd))) {
      try {
        const content = await fs.readFile(agentsMd, 'utf-8');
        const hasBlock = content.includes('<!-- AIWG:context-hook:start -->') && content.includes('<!-- AIWG:context-hook:end -->');
        const hasInclude = /^[ \t]*@AIWG\.md[ \t]*$/m.test(content);
        const isManaged = content.includes('<!-- aiwg-managed -->');
        if (isManaged || hasBlock || hasInclude) {
          check('Codex AGENTS.md hook', 'ok', 'AGENTS.md loads @AIWG.md (managed bridge or hook block present).');
        } else {
          check(
            'Codex AGENTS.md hook',
            'warn',
            'AIWG.md exists but AGENTS.md has no @AIWG.md link — Codex/fallback is not loading project AIWG context. Run `aiwg regenerate` to insert the hook.',
          );
        }
      } catch {
        check('Codex AGENTS.md hook', 'warn', 'Could not read AGENTS.md');
      }
    }
  }

  // 5c. Twin/bridge file drift check (#1579).
  // A pre-existing, non-AIWG-managed WARP.md / .hermes.md / AGENTS.md silently
  // keeps loading stale context across upgrades — burying the Discover-First
  // Protocol so agents fabricate CLI commands (the #1522 / #1411 failure mode).
  // The lean managed bridge is ~4KB; the reported failure was a 634KB stale
  // aggregate. Flag a twin that lacks the canonical `aiwg-managed` marker AND is
  // far larger than the lean bridge — that combination is unambiguous drift and
  // never trips on legitimate thin pointers (e.g. the ~10-line `.hermes.md`) or
  // small operator-authored files.
  {
    const projectRoot = process.cwd();
    const STALE_TWIN_BYTES = 16 * 1024; // ~4x the lean managed bridge
    const isAiwgProject =
      (await fileExists(path.join(projectRoot, '.aiwg'))) ||
      (await fileExists(path.join(projectRoot, 'AIWG.md')));
    if (isAiwgProject) {
      const twins = [
        { file: 'WARP.md', remediation: 'aiwg use --provider warp --force' },
        { file: '.hermes.md', remediation: 'aiwg use --provider hermes --force' },
        { file: 'AGENTS.md', remediation: 'aiwg regenerate --force' },
      ];
      for (const { file, remediation } of twins) {
        const p = path.join(projectRoot, file);
        if (!(await fileExists(p))) continue;
        try {
          const content = await fs.readFile(p, 'utf-8');
          const head = content.split('\n').slice(0, 50).join('\n');
          const managed =
            head.includes('<!-- aiwg-managed -->') ||
            /Generated by\s+(AIWG|aiwg)/i.test(head);
          const bytes = Buffer.byteLength(content, 'utf-8');
          if (managed) {
            check(`${file} bridge`, 'ok', `${file} carries the AIWG-managed marker`);
          } else if (bytes > STALE_TWIN_BYTES) {
            check(
              `${file} bridge`,
              'warn',
              `${file} exists (${Math.round(bytes / 1024)}KB), is not AIWG-managed, and is far larger than the lean managed bridge (~4KB) — stale context keeps loading and the Discover-First Protocol never reaches the agent (agents may fabricate CLI commands). Run \`${remediation}\` to back up and replace it.`,
            );
          }
          // Small non-managed file (thin pointer / minimal operator file): no finding.
        } catch {
          check(`${file} bridge`, 'warn', `Could not read ${file}`);
        }
      }
    }
  }

  // 6. Check Skill Seekers (optional)
  const skillSeekersPath = path.join(AIWG_ROOT, 'skill-seekers');
  const hasSkillSeekers = await fileExists(skillSeekersPath);
  if (hasSkillSeekers) {
    check('Skill Seekers', 'ok', 'Community skills available');
  } else {
    // #1264(c): aiwg install-skill-seekers was never implemented. Stop directing
    // operators at a missing command.
    check('Skill Seekers', 'info', 'Not installed (optional). See agentic/code/addons/skill-factory/ for the canonical skill-authoring addon.');
  }

  // 6b. Check Optional Features (#1219) — runtime-optional packages
  // tracked in the features catalog and installed only when needed.
  try {
    const statusPath = path.join(AIWG_ROOT, 'dist', 'src', 'features', 'status.js');
    const { getAllFeatureStatuses } = await import(pathToFileURL(statusPath).href);
    const statuses = await getAllFeatureStatuses();
    for (const s of statuses) {
      const label = `Optional: ${s.feature.name}`;
      if (s.available) {
        const versions = s.packages.map(p => `${p.name} ${p.version ?? '?'}`).join(', ');
        check(label, 'ok', `installed (${versions})`);
      } else {
        const broken = s.packages.filter(p => p.installed && !p.loadable);
        if (broken.length > 0) {
          const detail = broken.map(p => `${p.name}: ${p.error || 'native entry point failed to load'}`).join('; ');
          check(label, 'warn', `native build unavailable (${detail}) — run \`aiwg features install ${s.feature.name}\` to rebuild with scoped lifecycle-script approval`);
        } else {
          check(label, 'info', `not installed — \`aiwg features install ${s.feature.name}\` to enable`);
        }
      }
    }
  } catch (err) {
    // Best-effort — if the features module isn't built yet (e.g. on
    // a fresh dev clone before `npm run build`), just skip the section.
    if (process.env.AIWG_DEBUG) {
      console.error(`Optional Features check skipped: ${err?.message ?? err}`);
    }
  }

  // 6c. Check PATH for `aiwg` (#1279).
  //
  // Migrated from the now-removed `bin/postinstall.mjs` lifecycle script. The
  // postinstall hook was deleted to eliminate a worm-amplification primitive
  // (audit finding F1 / threat scenario S3, Aikido report 2026-05-12): a
  // compromised AIWG release with a `postinstall` hook executes arbitrary
  // code on every machine that `npm install -g aiwg` touches, before the
  // operator ever invokes the CLI. Removing the hook removes the capability.
  //
  // The PATH-guidance UX it provided still has value, so it surfaces here
  // (and in README "Installation troubleshooting") instead. On success this
  // check is silent — no need to clutter doctor output when PATH works. On
  // failure it prints shell-specific guidance and the `npx aiwg` fallback.
  // Doctor's exit code is not affected (PATH guidance is informational).
  try {
    execSync('aiwg --version', { stdio: 'ignore' });
    // aiwg is callable — no PATH issue to report.
  } catch {
    const isTTY = Boolean(process.stdout.isTTY);
    const cyan = isTTY ? chalk.cyan : (s) => s;
    const yellow = isTTY ? chalk.yellow : (s) => s;
    const shell = process.env.SHELL || '';
    const lines = [];
    lines.push('aiwg installed but may not be in your PATH.');
    lines.push('   If you get "command not found", add npm global bin to PATH:');
    if (shell.includes('zsh')) {
      lines.push(`     ${cyan('echo \'export PATH="$(npm config get prefix)/bin:$PATH"\' >> ~/.zshrc')}`);
      lines.push(`     ${cyan('source ~/.zshrc')}`);
    } else if (shell.includes('bash')) {
      lines.push(`     ${cyan('echo \'export PATH="$(npm config get prefix)/bin:$PATH"\' >> ~/.bashrc')}`);
      lines.push(`     ${cyan('source ~/.bashrc')}`);
    } else {
      lines.push(`     ${cyan('npm config get prefix')}    # Find your npm global bin directory`);
      lines.push('     Add that path + /bin to your shell\'s PATH');
    }
    lines.push(`   Or run directly with npx: ${cyan('npx aiwg <command>')}`);
    check('PATH', 'warn', yellow(lines.join('\n        ')));
  }

  // 7. Check Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (major >= 18) {
    check('Node.js', 'ok', nodeVersion);
  } else {
    check('Node.js', 'error', `${nodeVersion} (requires >= 18.0.0)`);
  }

  // 8. Check MCP server
  const mcpServer = path.join(AIWG_ROOT, 'src/mcp/server.mjs');
  const hasMcp = await fileExists(mcpServer);
  if (hasMcp) {
    check('MCP Server', 'ok', 'Available (run: aiwg mcp serve)');
  } else {
    check('MCP Server', 'warn', 'Not found');
  }

  // 8b. Check CLI runtime integrity — catches older published packages that
  // shipped without helper scripts the current CLI depends on (e.g. 2026.3.3
  // was published before tools/cli/deploy.mjs existed, causing `aiwg sync` to
  // fail with MODULE_NOT_FOUND).
  const requiredCliScripts = [
    'deploy.mjs',
    'update.mjs',
    'version.mjs',
    'runtime-info.mjs',
    'config-gitignore.mjs',
  ];
  const missingCli = [];
  for (const script of requiredCliScripts) {
    const scriptPath = path.join(AIWG_ROOT, 'tools/cli', script);
    if (!(await fileExists(scriptPath))) {
      missingCli.push(script);
    }
  }
  if (missingCli.length === 0) {
    check('CLI Runtime Integrity', 'ok', `${requiredCliScripts.length} helper scripts present`);
  } else {
    check(
      'CLI Runtime Integrity',
      'error',
      `Missing tools/cli scripts: ${missingCli.join(', ')}. Your installed AIWG is missing files the CLI depends on. Upgrade: npm install -g aiwg@latest`,
    );
  }

  // 8c. Discovery kernel availability (#1264(g)).
  //
  // Verify the discovery commands an AIWG-aware agent expects: discover, show,
  // index, runtime-info. Each is a smoke probe — non-fatal warning if the
  // command isn't routable, because doctor must work even on a partially
  // installed system. Surfaces missing surfaces loudly so an operator/agent
  // knows the install is degraded before they try to use it.
  const { spawnSync } = await import('node:child_process');
  const aiwgBin = process.env.AIWG_BIN || 'aiwg';
  const probeCommand = (name, args, expectStdout = null, validateStdout = null) => {
    try {
      const r = spawnSync(aiwgBin, args, {
        encoding: 'utf-8',
        // Framework discovery can legitimately take longer than ten seconds
        // while the release suite is concurrently packing and rebuilding
        // provider indices. Keep the probe bounded, but align it with the
        // integration runner budget so doctor does not report a false outage.
        timeout: 30_000,
        shell: process.platform === 'win32',
      });
      if (r.error || r.status !== 0) {
        const detail = r.error
          ? `spawn failed: ${r.error.code || r.error.message}`
          : `exit=${r.status ?? '?'} ${(r.stderr || '').trim().split('\n')[0] || 'no stderr'}`;
        return { ok: false, detail };
      }
      if (expectStdout && !(r.stdout || '').includes(expectStdout)) {
        return { ok: false, detail: `stdout missing expected marker '${expectStdout}'` };
      }
      if (validateStdout) {
        const validation = validateStdout(r.stdout || '');
        if (validation !== true) return { ok: false, detail: validation };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  };

  const discoveryProbes = [
    {
      label: 'Discovery: aiwg discover',
      args: ['discover', 'aiwg doctor', '--json', '--limit', '10'],
      hint: 'aiwg discover is unavailable — agents may bypass index-driven lookup',
      validateStdout: (stdout) => {
        try {
          const payload = JSON.parse(stdout);
          if (!Array.isArray(payload.results) || payload.results.length === 0) {
            return 'discover exited successfully but returned zero results for the known aiwg-doctor capability';
          }
          if (!payload.results.some((result) => result?.name === 'aiwg-doctor')) {
            return 'discover did not return the known aiwg-doctor capability';
          }
          return true;
        } catch (error) {
          return `discover returned invalid JSON: ${error.message}`;
        }
      },
    },
    {
      label: 'Discovery: aiwg show',
      args: ['show', 'skill', 'aiwg-doctor'],
      hint: 'aiwg show cannot fetch a known kernel skill body',
    },
    {
      label: 'Discovery: aiwg index',
      args: ['index', 'stats', '--json'],
      hint: 'aiwg index pipeline unavailable — project-local artifact index may be missing',
      // Global/home-dir runtimes (OpenClaw etc.) run with no project-local
      // index. That's expected, not a failure — `aiwg discover` still works via
      // the framework index auto-built from the install root (#1541). Don't warn
      // when the only problem is an absent project-local index AND discover works.
      globalTolerant: true,
    },
    {
      label: 'Discovery: aiwg runtime-info',
      args: ['runtime-info', '--check', 'aiwg'],
      hint: 'aiwg runtime-info cannot self-check — toolsmith catalog may be broken',
    },
  ];

  let discoverOk = false;
  for (const probe of discoveryProbes) {
    const r = probeCommand(probe.label, probe.args, null, probe.validateStdout);
    if (probe.args[0] === 'discover') discoverOk = r.ok;
    if (r.ok) {
      check(probe.label, 'ok', `\`aiwg ${probe.args.join(' ')}\` succeeded`);
    } else if (probe.globalTolerant && discoverOk && /No artifact index found/i.test(r.detail || '')) {
      // No project-local index in a global/home-dir context (OpenClaw etc.).
      // Discovery still works via the framework index from the install root —
      // proven by the `aiwg discover` probe above — so this is expected, not a
      // warning. Inside a project, run `aiwg index build` to add a project index.
      check(probe.label, 'ok', 'no project-local index (global context) — discovery uses the framework index from the install root; run `aiwg index build` inside a project for project-scoped queries');
    } else {
      // Warn (not error) — discovery is degraded but doctor itself still works.
      check(probe.label, 'warn', `${probe.hint} — ${r.detail}`);
    }
  }

  // 8d. Component-to-driver coverage (#1958).
  //
  // A healthy index is insufficient when a shipped component has no
  // operational entry point. Join component manifests to source discovery
  // metadata and surface the same invariant enforced by CI.
  try {
    const coverageModule = await import(pathToFileURL(
      path.join(AIWG_ROOT, 'tools/manifest/check-discovery-coverage.mjs'),
    ).href);
    const coverage = coverageModule.buildCoverageReport(AIWG_ROOT);
    if (coverage.ok) {
      check(
        'Discovery: component drivers',
        'ok',
        `${coverage.counts.covered} covered, ${coverage.counts.exempt} explicitly exempt`,
      );
    } else {
      const missing = coverage.components
        .filter(component => component.status === 'missing' || component.status === 'invalid')
        .map(component => `${component.kind}:${component.component}`)
        .slice(0, 8);
      check(
        'Discovery: component drivers',
        'error',
        `${coverage.counts.missing} missing, ${coverage.counts.invalid} invalid — ${missing.join(', ')}`,
      );
    }
  } catch (error) {
    check(
      'Discovery: component drivers',
      'warn',
      `coverage report unavailable — ${error.message}`,
    );
  }

  // 9. Check installed addons
  const addonChecks = [
    { id: 'daemon', label: 'Daemon Addon', manifest: 'agentic/code/addons/daemon/manifest.json',
      artifacts: ['behaviors/concierge.behavior.md', 'agents/concierge.md', 'skills/daemon-status/SKILL.md', 'rules/daemon-interaction.md'] },
    { id: 'agent-loop', label: 'Agent Loop Addon', manifest: 'agentic/code/addons/agent-loop/manifest.json',
      artifacts: ['agents/ralph-loop.md'] },
    { id: 'rlm', label: 'RLM Addon', manifest: 'agentic/code/addons/rlm/manifest.json',
      artifacts: [] },
    { id: 'ring', label: 'Ring Methodology', manifest: 'agentic/code/addons/ring-methodology/manifest.json',
      artifacts: [] },
  ];

  for (const addon of addonChecks) {
    const manifestPath = path.join(AIWG_ROOT, addon.manifest);
    const hasManifest = await fileExists(manifestPath);
    if (hasManifest) {
      // Check key artifacts exist
      const missing = [];
      for (const artifact of addon.artifacts) {
        const artifactPath = path.join(path.dirname(manifestPath), artifact);
        if (!(await fileExists(artifactPath))) {
          missing.push(artifact);
        }
      }
      if (missing.length > 0) {
        check(addon.label, 'warn', `Installed but missing: ${missing.join(', ')}`);
      } else {
        try {
          const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
          check(addon.label, 'ok', `v${manifest.version || 'unknown'}`);
        } catch {
          check(addon.label, 'ok', 'Installed');
        }
      }
    }
    // Skip silently if not installed — addons are optional
  }

  // 9b. Upstream addon manifest sweep (#1088)
  // Every directory under agentic/code/addons/ must declare itself via
  // either manifest.json (canonical) or WIP.md (deferred). Anything else
  // ships dark — discoverable by `aiwg use <name>` but invisible to the
  // catalog, registry, and validator.
  try {
    const upstreamAddonsDir = path.join(AIWG_ROOT, 'agentic/code/addons');
    if (await fileExists(upstreamAddonsDir)) {
      const entries = await fs.readdir(upstreamAddonsDir, { withFileTypes: true });
      const orphaned = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const addonPath = path.join(upstreamAddonsDir, entry.name);
        const hasManifest = await fileExists(path.join(addonPath, 'manifest.json'));
        const hasWip = await fileExists(path.join(addonPath, 'WIP.md'));
        if (!hasManifest && !hasWip) {
          orphaned.push(entry.name);
        }
      }
      if (orphaned.length > 0) {
        check(
          'Upstream addon manifests',
          'warn',
          `${orphaned.length} addon(s) missing both manifest.json and WIP.md: ${orphaned.join(', ')}. ` +
            `Each upstream addon must declare itself as deployable (manifest.json) or deferred (WIP.md). See #1088.`,
        );
      } else {
        check('Upstream addon manifests', 'ok', `${entries.filter(e => e.isDirectory()).length} addons declared`);
      }
    }
  } catch {
    // Sweep is best-effort; never block doctor on FS exceptions
  }

  // 10. Check behaviors (OpenClaw native or Claude emulated)
  const openclawBehaviors = path.join(os.homedir(), '.openclaw', 'behaviors');
  const claudeHooks = path.join(process.cwd(), '.claude', 'hooks');
  const hasOpenclawBehaviors = await fileExists(openclawBehaviors);
  const hasClaudeHooks = await fileExists(claudeHooks);
  if (hasOpenclawBehaviors) {
    const entries = await fs.readdir(openclawBehaviors, { withFileTypes: true });
    const behaviorCount = entries.filter(e => e.isDirectory()).length;
    if (behaviorCount > 0) {
      check('OpenClaw Behaviors', 'ok', `${behaviorCount} behaviors deployed (native)`);
    } else {
      check('OpenClaw Behaviors', 'info', 'Behaviors directory exists but empty (run: aiwg use daemon)');
    }
  } else if (hasClaudeHooks) {
    const entries = await fs.readdir(claudeHooks);
    const hookCount = entries.filter(f => f.endsWith('.md') || f.endsWith('.json')).length;
    if (hookCount > 0) {
      check('Behaviors (Claude)', 'ok', `${hookCount} behavior hooks deployed (emulated)`);
    } else {
      check('Behaviors (Claude)', 'info', 'Hooks directory exists but empty');
    }
  } else {
    check('Behaviors', 'info', 'No behaviors deployed (run: aiwg use daemon)');
  }

  // 11a. Storage config validation (no-op when .aiwg/storage.config absent)
  try {
    const projectDir = process.cwd();
    const storageCfgPath = path.join(projectDir, '.aiwg', 'storage.config');
    if (await fileExists(storageCfgPath)) {
      try {
        const raw = await fs.readFile(storageCfgPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Lazy import the validator from the compiled storage module so we
        // don't duplicate the credential-walk logic in this script.
        const { validateStorageConfig } = await import(path.join(AIWG_ROOT, 'dist', 'src', 'storage', 'config.js'));
        validateStorageConfig(parsed, storageCfgPath);
        check('Storage Config', 'ok', `Valid: ${storageCfgPath}`);
      } catch (err) {
        check('Storage Config', 'error', err.message);
      }
    } else {
      check('Storage Config', 'info', 'No .aiwg/storage.config (using fs defaults)');
    }
  } catch {
    // Validator import failed (e.g., dist not built in dev). Non-fatal — skip silently.
  }

  // 11b. Validate .aiwg/aiwg.config remotes block (#994)
  // Ensures any declared remote name actually exists in `git remote`.
  try {
    const projectDir = process.cwd();
    const aiwgCfgPath = path.join(projectDir, '.aiwg', 'aiwg.config');
    if (await fileExists(aiwgCfgPath)) {
      let raw;
      try {
        raw = JSON.parse(await fs.readFile(aiwgCfgPath, 'utf-8'));
      } catch (err) {
        check('Remotes Config', 'error', `Failed to parse .aiwg/aiwg.config: ${err.message}`);
        raw = null;
      }
      if (raw && raw.remotes) {
        // Collect actual git remote names; tolerate non-git directories.
        let gitRemotes = [];
        try {
          gitRemotes = execSync('git remote', { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
            .trim()
            .split('\n')
            .filter(Boolean);
        } catch {
          // Not a git repo — skip silently
        }

        if (gitRemotes.length > 0) {
          const declared = [];
          if (raw.remotes.primary) declared.push({ field: 'primary', name: raw.remotes.primary });
          if (raw.remotes.issue_tracker) declared.push({ field: 'issue_tracker', name: raw.remotes.issue_tracker });
          if (raw.remotes.ci) declared.push({ field: 'ci', name: raw.remotes.ci });
          for (const sec of raw.remotes.secondary || []) {
            if (sec && sec.name) declared.push({ field: `secondary.${sec.name}`, name: sec.name });
          }

          const missing = declared.filter(d => !gitRemotes.includes(d.name));
          if (missing.length === 0) {
            const primary = raw.remotes.primary || 'origin';
            check('Remotes Config', 'ok', `primary=${primary} (${declared.length} declared, all present)`);
          } else {
            const list = missing.map(m => `${m.field}=${m.name}`).join(', ');
            check(
              'Remotes Config',
              'warn',
              `Declared remote(s) missing from git: ${list}. Available: ${gitRemotes.join(', ')}`,
            );
          }
        }
      }
    }
  } catch {
    // Non-fatal — skip silently
  }

  // Artifact output destination policy (#2122). Missing blocks are valid and
  // resolve to the safe explicit-only compatibility default.
  try {
    const aiwgCfgPath = path.join(process.cwd(), '.aiwg', 'aiwg.config');
    if (await fileExists(aiwgCfgPath)) {
      const raw = JSON.parse(await fs.readFile(aiwgCfgPath, 'utf-8'));
      const issues = validateArtifactOutputs(raw.artifact_outputs);
      if (issues.length > 0) check('Artifact Output Policy', 'error', issues.join('; '));
      else {
        const policy = raw.artifact_outputs ?? { canonical: 'aiwg', provider_native: 'explicit-only' };
        check('Artifact Output Policy', 'ok', `canonical=${policy.canonical ?? 'aiwg'}, provider-native=${policy.provider_native ?? 'explicit-only'}`);
      }
    }
  } catch (err) {
    check('Artifact Output Policy', 'warn', `Could not validate artifact_outputs: ${err.message}`);
  }

  // 11c. Validate .aiwg/aiwg.config delivery block (#995)
  // Sanity-check the resolved delivery policy against actual repo state.
  try {
    const projectDir = process.cwd();
    const aiwgCfgPath = path.join(projectDir, '.aiwg', 'aiwg.config');
    if (await fileExists(aiwgCfgPath)) {
      let raw;
      try {
        raw = JSON.parse(await fs.readFile(aiwgCfgPath, 'utf-8'));
      } catch {
        raw = null;
      }
      if (raw && raw.delivery) {
        const d = raw.delivery;
        const issues = [];

        // mode validation
        const validModes = ['direct', 'feature-branch', 'pr-required'];
        if (d.mode && !validModes.includes(d.mode)) {
          issues.push(`mode=${d.mode} (must be one of ${validModes.join(', ')})`);
        }

        // merge_style validation
        const validMergeStyles = ['rebase-merge', 'squash', 'merge', 'fast-forward-only'];
        if (d.merge_style && !validMergeStyles.includes(d.merge_style)) {
          issues.push(`merge_style=${d.merge_style} (must be one of ${validMergeStyles.join(', ')})`);
        }

        // force_push_policy validation
        const validForcePush = ['never', 'own-branch-only', 'allowed'];
        if (d.force_push_policy && !validForcePush.includes(d.force_push_policy)) {
          issues.push(`force_push_policy=${d.force_push_policy} (must be one of ${validForcePush.join(', ')})`);
        }

        // signing identity validation (#1601)
        if (d.signing) {
          const validSigningFormats = ['openpgp', 'ssh', 'x509'];
          if (d.signing.format && !validSigningFormats.includes(d.signing.format)) {
            issues.push(`signing.format=${d.signing.format} (must be one of ${validSigningFormats.join(', ')})`);
          }
          const validSigningEnforce = ['commits', 'tags', 'all'];
          if (d.signing.enforce && !validSigningEnforce.includes(d.signing.enforce)) {
            issues.push(`signing.enforce=${d.signing.enforce} (must be one of ${validSigningEnforce.join(', ')})`);
          }
        }
        if (d.require_signed_commits && !hasSigningMaterial(d.signing)) {
          issues.push('require_signed_commits=true but delivery.signing.key/key_file is not configured');
        }

        // default_branch existence — best effort, only when in a git repo
        const defaultBranch = d.default_branch || 'main';
        try {
          execFileSync('git', ['-C', projectDir, 'rev-parse', '--verify', '--quiet', defaultBranch], {
            stdio: 'pipe',
          });
        } catch (err) {
          if (childProcessSucceeded(err)) {
            // Some sandboxes surface a spawn EPERM even when git returned
            // status 0 and stdout. Treat that as success; keep real failures.
          } else {
          // Branch may not exist locally on a fresh clone; downgrade to info, not error
            issues.push(`default_branch '${defaultBranch}' not found locally (may be remote-only — this is informational)`);
          }
        }

        if (issues.length === 0) {
          const mode = d.mode || 'pr-required';
          const merge = d.merge_style || 'rebase-merge';
          check('Delivery Policy', 'ok', `mode=${mode} merge=${merge} default_branch=${defaultBranch}`);
        } else {
          check('Delivery Policy', 'warn', issues.join('; '));
        }
      }

      // 11d. Validate delivery identity / tracker actor block (#1601)
      if (raw) {
        const actor = raw.remotes?.tracker_actor;
        if (actor) {
          const issues = [];
          const validVia = ['tea', 'gh', 'mcp', 'api'];
          if (actor.via && !validVia.includes(actor.via)) {
            issues.push(`tracker_actor.via=${actor.via} (must be one of ${validVia.join(', ')})`);
          }
          if (actor.login && Array.isArray(actor.forbid_actors) && actor.forbid_actors.includes(actor.login)) {
            issues.push(`tracker_actor.login=${actor.login} is also listed in forbid_actors`);
          }
          if (issues.length === 0) {
            const route = actor.via ? ` via ${actor.via}` : '';
            const forbidden = Array.isArray(actor.forbid_actors) && actor.forbid_actors.length > 0
              ? `; forbidden=${actor.forbid_actors.join(',')}`
              : '';
            check('Delivery Identity', 'ok', `tracker_actor=${actor.login || '(login unset)'}${route}${forbidden}`);
          } else {
            check('Delivery Identity', 'warn', issues.join('; '));
          }
        } else if (hasTrackerRemote(raw.remotes)) {
          check(
            'Delivery Identity',
            'warn',
            'remotes.issue_tracker is configured but remotes.tracker_actor is not set; tracker writes may use whichever credential is available. Set remotes.tracker_actor.login/via or document why reads-only credentials are acceptable. Refs #1601.',
          );
        }
      }

      // 11d. Validate .aiwg/aiwg.config parallelism block (#1359)
      // Provider-scoped parallelism caps for rate-limit awareness.
      if (raw && raw.parallelism) {
        const p = raw.parallelism;
        const issues = [];
        const checkRange = (field, min, max) => {
          if (p[field] !== undefined) {
            const n = p[field];
            if (!Number.isInteger(n) || n < min || n > max) {
              issues.push(`${field}=${n} (must be integer ${min}-${max})`);
            }
          }
        };
        checkRange('max_parallel_subagents', 1, 50);
        checkRange('max_parallel_ralph_loops', 1, 20);
        checkRange('max_parallel_mc_missions', 1, 20);

        // Detect operator override vs provider default
        const primary = Array.isArray(raw.providers) ? raw.providers[0] : undefined;
        const PROVIDER_DEFAULTS = {
          claude:   { max_parallel_subagents: 4 },
          codex:    { max_parallel_subagents: 10 },
          copilot:  { max_parallel_subagents: 10 },
          cursor:   { max_parallel_subagents: 10 },
          factory:  { max_parallel_subagents: 10 },
          opencode: { max_parallel_subagents: 10 },
          warp:     { max_parallel_subagents: 10 },
          windsurf: { max_parallel_subagents: 10 },
          openclaw: { max_parallel_subagents: 10 },
          hermes:   { max_parallel_subagents: 10 },
        };
        const expectedDefault = PROVIDER_DEFAULTS[primary]?.max_parallel_subagents ?? 4;
        const isOverride =
          p.max_parallel_subagents !== undefined &&
          p.max_parallel_subagents !== expectedDefault;

        if (issues.length === 0) {
          const subs = p.max_parallel_subagents ?? expectedDefault;
          const label = isOverride
            ? `max_parallel_subagents=${subs} (operator override; provider default for ${primary || 'unknown'} = ${expectedDefault})`
            : `max_parallel_subagents=${subs} (provider default for ${primary || 'unknown'})`;
          check('Parallelism Cap', 'ok', label);
        } else {
          check('Parallelism Cap', 'warn', issues.join('; '));
        }
      } else if (raw) {
        // No parallelism block — agents will fall back to resolveParallelism()
        // defaults, but visibility is reduced. Hint at the right command.
        check(
          'Parallelism Cap',
          'info',
          'no parallelism block — agents fall back to provider defaults; run "aiwg config set --project parallelism.max_parallel_subagents N" to make it explicit',
        );
      }
    }
  } catch {
    // Non-fatal — skip silently
  }

  // 11e. Validate configurable forge-content threat policy (#1938).
  try {
    const threatConfigPath = path.join(process.cwd(), '.aiwg', 'aiwg.config');
    if (await fileExists(threatConfigPath)) {
      const raw = JSON.parse(await fs.readFile(threatConfigPath, 'utf-8'));
      const errors = validateThreatAssessmentConfig(raw.security?.threatAssessment);
      if (errors.length) {
        check('Threat Assessment Policy', 'error', errors.join('; '));
      } else {
        const policy = raw.security?.threatAssessment;
        const profile = policy?.defaultProfile || 'balanced';
        const mode = policy?.mode || 'enforce';
        const source = policy ? '.aiwg/aiwg.config' : 'backward-compatible default';
        check('Threat Assessment Policy', 'ok', `mode=${mode} profile=${profile} (${source})`);
      }
    }
  } catch (error) {
    check('Threat Assessment Policy', 'error', error.message);
  }

  // Permission normalization health (#1800). Errors fail closed in the
  // evaluator; doctor makes legacy sources and remediation visible.
  try {
    const permissionProjectDir = process.cwd();
    const permissionConfig = await readAiwgConfig(permissionProjectDir);
    if (permissionConfig) {
      const diagnostics = await auditLegacyPermissions(permissionProjectDir, permissionConfig);
      if (!diagnostics.length) {
        check('Permissions', 'ok', 'normalized authorization model valid');
      } else {
        const errors = diagnostics.filter(item => item.severity === 'error');
        const legacy = diagnostics.filter(item => item.code.startsWith('legacy-'));
        const status = errors.length ? 'error' : 'warn';
        check(
          'Permissions',
          status,
          `${errors.length} error(s), ${legacy.length} legacy source(s) — run "aiwg steward permissions audit"`,
        );
      }
    }
  } catch (err) {
    check('Permissions', 'error', `authorization audit failed: ${err.message}`);
  }

  // 10b. Provider-aware model-policy diagnostics (#1802/#1805).
  // Report canonical intent separately from the target's enforceable surface;
  // never claim skill pins on providers whose skill schema ignores them.
  try {
    const registryPath = path.join(
      AIWG_ROOT,
      'agentic',
      'code',
      'providers',
      'model-capabilities.v1.json',
    );
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
    const PINNED_MAP = {
      sonnet: 'claude-sonnet-4-6',
      opus:   'claude-opus-4-7',
      haiku:  'claude-haiku-4-5',
    };
    for (const provName of providersToCheck) {
      const capability = registry.providers?.[provName];
      if (!capability) continue;
      const provider = await loadProvider(provName);
      const label = PROVIDER_LABELS[provName] || provName;
      const dir = resolveProviderPath(provider?.paths?.agents);
      const aliases = [];
      let modeled = 0;
      let total = 0;
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { /* absent */ }
      for (const ent of entries) {
        if (!ent.isFile() || !/\.(?:md|toml)$/.test(ent.name)) continue;
        total++;
        const target = path.join(dir, ent.name);
        let content = '';
        try {
          content = await fs.readFile(target, 'utf-8');
        } catch { continue; }
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const modelMatch = ent.name.endsWith('.toml')
          ? content.match(/^model\s*=\s*"([^"]+)"\s*$/m)
          : fmMatch?.[1].match(/^model:\s*(\S+)\s*$/m);
        if (!modelMatch) continue;
        modeled++;
        const value = modelMatch[1].trim();
        if (PINNED_MAP[value]) {
          aliases.push({
            file: path.relative(process.cwd(), target),
            alias: value,
            pinned: PINNED_MAP[value],
          });
        }
      }
      const skillSurface = capability.skill;
      if (aliases.length > 0) {
        const sample = aliases.slice(0, 3)
          .map(item => `${item.file} (${item.alias}→${item.pinned})`).join('; ');
        check(
          `${label} Model Policy`,
          'warn',
          `${aliases.length} agent alias(es) need compilation; agent=${capability.agent}, skill=${skillSurface}. Examples: ${sample}`,
        );
      } else if (total > 0) {
        const status = capability.agent === 'unsupported' ? 'warn' : 'ok';
        check(
          `${label} Model Policy`,
          status,
          `canonical=${total}, modeled=${modeled}, agent=${capability.agent}, skill=${skillSurface}; skill policy is not reported as pinned when ${skillSurface}`,
        );
      }
    }
  } catch {
    // Non-fatal — skip silently
  }

  // 10c. SECURITY.md presence for projects using security-engineering (#1422).
  try {
    const projectDir = process.cwd();
    const cfgPath = path.join(projectDir, '.aiwg', 'aiwg.config');
    let securityEngineeringInstalled = await fileExists(path.join(projectDir, '.aiwg', 'security-engineering'));
    if (await fileExists(cfgPath)) {
      try {
        const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
        securityEngineeringInstalled = securityEngineeringInstalled || Boolean(cfg?.installed?.['security-engineering']);
      } catch {
        // Parse failures are reported by the config checks above.
      }
    }
    if (securityEngineeringInstalled) {
      const hasSecurityMd =
        await fileExists(path.join(projectDir, 'SECURITY.md')) ||
        await fileExists(path.join(projectDir, 'docs', 'SECURITY.md'));
      if (hasSecurityMd) {
        check('SECURITY.md', 'ok', 'private vulnerability disclosure channel documented');
      } else {
        check('SECURITY.md', 'warn', 'security-engineering is installed but no SECURITY.md or docs/SECURITY.md exists; seed from agentic/code/frameworks/security-engineering/templates/SECURITY.md');
      }
    }
  } catch {
    // Non-fatal — skip silently.
  }

  // 11. Check .gitignore for AIWG runtime patterns (warning if missing).
  // Use the shared config helper so doctor and `aiwg config gitignore --fix`
  // cannot drift on which runtime paths are required.
  try {
    const result = await checkGitignore(process.cwd());
    const missing = result.missingRuntime;
    if (missing.length === 0) {
      check('.gitignore', 'ok', 'AIWG runtime paths covered');
    } else {
      check('.gitignore', 'warn', `Missing AIWG runtime patterns: ${missing.join(', ')} — run "aiwg config gitignore --fix"`);
    }
  } catch {
    // No .gitignore or unreadable — skip silently
  }

  // 12. Artifact index (.aiwg/.index/) — presence + staleness (#1488)
  //
  // The artifact graph index is a regenerable build artifact (gitignored per
  // check #11). A fresh clone legitimately has none, so:
  //   - skip silently when no index exists AND nothing signals the project uses one
  //   - info  when no index exists but .aiwg/config.yaml declares an `index:` block
  //   - warn  when the index exists but recorded source files have changed (stale)
  //   - ok    when the index exists and every recorded file still matches on disk
  try {
    const indexDir = path.join(process.cwd(), '.aiwg', '.index');
    const indexExists = await fileExists(indexDir);

    if (!indexExists) {
      let declaresIndex = false;
      // Canonical home: .aiwg/aiwg.config `index` block (#1491).
      try {
        const ac = JSON.parse(await fs.readFile(path.join(process.cwd(), '.aiwg', 'aiwg.config'), 'utf-8'));
        if (ac && typeof ac.index === 'object' && ac.index !== null) declaresIndex = true;
      } catch {
        // no aiwg.config / unparseable
      }
      // Legacy fallback: .aiwg/config.yaml `index:` block.
      if (!declaresIndex) {
        try {
          const cfg = await fs.readFile(path.join(process.cwd(), '.aiwg', 'config.yaml'), 'utf-8');
          declaresIndex = /^\s*index\s*:/m.test(cfg);
        } catch {
          // No config — the project doesn't use the artifact index; stay silent.
        }
      }
      if (declaresIndex) {
        check('artifact-index', 'info', '.aiwg/.index/ not built — run "aiwg index build --all" to enable discovery queries');
      }
    } else {
      // Collect checksum-manifest.json files (top level + one subdir level —
      // graphs may write flat or under .aiwg/.index/<graph>/).
      const manifestPaths = [];
      const topManifest = path.join(indexDir, 'checksum-manifest.json');
      if (await fileExists(topManifest)) manifestPaths.push(topManifest);
      try {
        const entries = await fs.readdir(indexDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const sub = path.join(indexDir, e.name, 'checksum-manifest.json');
            if (await fileExists(sub)) manifestPaths.push(sub);
          }
        }
      } catch {
        // ignore readdir errors
      }

      if (manifestPaths.length === 0) {
        check('artifact-index', 'warn', '.aiwg/.index/ present but no checksum-manifest.json — run "aiwg index build --force" to rebuild');
      } else {
        // Phase-1 stat comparison (mtime + size) against recorded entries.
        // Bounded so doctor stays fast on large research corpora.
        const MAX_CHECK = 2000;
        let checked = 0, stale = 0, missing = 0;
        for (const mp of manifestPaths) {
          if (checked >= MAX_CHECK) break;
          let manifest;
          try {
            manifest = JSON.parse(await fs.readFile(mp, 'utf-8'));
          } catch {
            continue;
          }
          const recorded = (manifest && manifest.entries) || {};
          for (const [rel, entry] of Object.entries(recorded)) {
            if (checked >= MAX_CHECK) break;
            checked++;
            try {
              const st = await fs.stat(path.join(process.cwd(), rel));
              if (st.mtime.toISOString() !== entry.mtime || st.size !== entry.size) stale++;
            } catch {
              missing++; // recorded source no longer on disk
            }
          }
        }
        const drift = stale + missing;
        if (checked === 0) {
          check('artifact-index', 'ok', '.aiwg/.index/ present (empty manifest)');
        } else if (drift === 0) {
          check('artifact-index', 'ok', `.aiwg/.index/ up to date (${checked} file(s) verified)`);
        } else {
          check('artifact-index', 'warn', `.aiwg/.index/ is stale — ${drift} of ${checked} indexed file(s) changed or removed; run "aiwg index build" to refresh`);
        }
      }
    }
  } catch {
    // Non-fatal — skip silently.
  }

  // 13. Index config (#1491) — validate index.graphs + flag the deprecated config.yaml home.
  try {
    const { index, source } = await readIndexConfig(process.cwd());
    if (source === 'config.yaml') {
      check('index-config', 'warn', 'index config still in .aiwg/config.yaml — migrate the index block into .aiwg/aiwg.config (#1491; see docs/cli/reference.md)');
    }
    if (index) {
      const errs = validateIndexConfig(index);
      if (errs.length > 0) {
        const more = errs.length > 1 ? ` (+${errs.length - 1} more)` : '';
        check('index-config', 'error', `${errs.length} index.graphs error(s): ${errs[0]}${more} — run "aiwg index build" for the full list`);
      } else if (source === 'aiwg.config') {
        check('index-config', 'ok', 'index.graphs valid (.aiwg/aiwg.config)');
      }
    }
  } catch {
    // Non-fatal — skip silently.
  }

  // 13b. Durable index-graph registry (#1624) — surface malformed graph defs
  // that previously loaded silently, on-disk index dirs that match no graph
  // (drift), and registered durable indices that were never built. Scoped to
  // AIWG projects; built-ins being unbuilt in a fresh project is normal and is
  // intentionally NOT flagged here (only operator/module-registered graphs).
  try {
    if (existsSync(path.join(process.cwd(), '.aiwg'))) {
      const report = collectIndexStatus(process.cwd());
      const registeredMissing = report.graphs.filter(
        (g) => g.origin === 'registered' && g.missing,
      );
      if (report.warnings.length > 0) {
        const first = report.warnings[0];
        const more = report.warnings.length > 1 ? ` (+${report.warnings.length - 1} more)` : '';
        check(
          'durable-indices',
          'warn',
          `${report.warnings.length} graph-config problem(s) previously dropped silently: [${first.source}] ${first.graph}: ${first.reason}${more} — run "aiwg index status"`,
        );
      } else if (report.orphanIndexDirs.length > 0) {
        check(
          'durable-indices',
          'warn',
          `${report.orphanIndexDirs.length} on-disk index dir(s) match no registered graph (drift) — run "aiwg index status"`,
        );
      } else if (registeredMissing.length > 0) {
        check(
          'durable-indices',
          'warn',
          `${registeredMissing.length} registered durable index(es) not built (${registeredMissing.map((g) => g.name).join(', ')}) — run "aiwg index build --all"`,
        );
      } else if (report.graphs.some((g) => g.origin === 'registered')) {
        check('durable-indices', 'ok', `${report.summary.built}/${report.summary.total} index graphs built, no drift`);
      }
    }
  } catch {
    // Non-fatal — never break doctor on the durable-index probe.
  }

  // 13c. Fortemi Core prebuilt framework index (#1697) — release packages
  // should include this cache so Fortemi-backed discovery can answer framework
  // queries without forcing a local rebuild first.
  try {
    const local = getFortemiCoreSyncStatus(process.cwd(), 'framework');
    const prebuilt = getFortemiCorePrebuiltStatus('framework');
    if (prebuilt.built && !prebuilt.stale) {
      const executable = getFortemiCoreExecutableSkillStatus('framework');
      if (executable.missing.length > 0) {
        check('fortemi-core-index', 'warn', `prebuilt framework index is missing executable metadata for ${executable.missing.length} source skill(s): ${executable.missing.slice(0, 5).join(', ')} — run "npm run release:fortemi-index" before release packaging`);
      } else {
        const localNote = local.built && !local.stale ? '; local cache also ready' : '';
        check('fortemi-core-index', 'ok', `prebuilt framework index present (${prebuilt.itemCount ?? 0} items; ${executable.packagedExecutableCount}/${executable.sourceExecutableCount} executable skills preserved${localNote})`);
      }
    } else if (local.built && !local.stale) {
      check('fortemi-core-index', 'ok', `local framework cache ready (${local.itemCount ?? 0} items); prebuilt package index not present`);
    } else if (prebuilt.optedIn && prebuilt.stale) {
      check('fortemi-core-index', 'warn', `${prebuilt.reason ?? 'prebuilt framework index is stale'} — run "npm run release:fortemi-index" before release packaging`);
    } else {
      check('fortemi-core-index', 'info', 'no prebuilt framework index packaged; Fortemi discovery will require "aiwg index sync --backend fortemi-core --graph framework"');
    }
  } catch {
    // Non-fatal — older installs may not expose the helper yet.
  }

  // Print results
  console.log('');

  const statusSymbols = { ok: '✓', warn: '⚠', error: '✗', info: '○' };
  const colorFns = {
    ok: isTTY ? chalk.green : (s) => s,
    warn: isTTY ? chalk.yellow : (s) => s,
    error: isTTY ? chalk.red : (s) => s,
    info: isTTY ? chalk.cyan : (s) => s
  };

  for (const { name, status, message } of checks) {
    const symbol = statusSymbols[status];
    const colorFn = colorFns[status] || ((s) => s);
    console.log(`  ${colorFn(symbol)} ${name}: ${message}`);
  }

  // Summary
  const pass = checks.filter(c => c.status === 'ok').length;
  const errors = checks.filter(c => c.status === 'error').length;
  const warnings = checks.filter(c => c.status === 'warn').length;

  console.log(rule);
  console.log('');

  if (errors > 0) {
    const msg = `${errors} error(s), ${warnings} warning(s), ${pass} passed`;
    console.log(isTTY ? chalk.red(`  ✗ ${msg}`) : `  FAIL ${msg}`);
    console.log('');
    process.exit(1);
  } else if (warnings > 0) {
    const msg = `${warnings} warning(s), ${pass} passed`;
    console.log(isTTY ? chalk.yellow(`  ⚠ ${msg}`) : `  WARN ${msg}`);
  } else {
    console.log(isTTY ? chalk.green(`  ✓ All ${pass} checks passed`) : `  OK All ${pass} checks passed`);
  }

  maybePrintCommunityFooter();
  console.log('');
}

runDoctor().catch(error => {
  console.error('Doctor failed:', error.message);
  process.exit(1);
});
