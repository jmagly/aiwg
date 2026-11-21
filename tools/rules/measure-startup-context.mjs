#!/usr/bin/env node
// Phase 0 observation only: exercise the existing use/deployer owners unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const PROVIDERS = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
export const PO_REFERENCE = { rules_bytes: 207444, behaviors_bytes: 33411 };

export function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? filesUnder(path.join(dir, entry.name))
      : entry.isFile() ? [path.join(dir, entry.name)] : []);
}

function summarize(files) {
  return { bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    estimated_tokens: files.reduce((sum, file) => sum + file.estimated_tokens, 0), files };
}

function record(file, base, content = fs.readFileSync(file, 'utf8'), suffix = '') {
  const bytes = Buffer.byteLength(content);
  return { path: path.relative(base, file).split(path.sep).join('/') + suffix,
    bytes, estimated_tokens: Math.ceil(bytes / 4) };
}

// Measure emitted surfaces, not source rules or the list of intended deploys.
// Conventional mirrors are reported separately; they are not startup context.
export function measureDeployed(project, home, provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
  const base = provider === 'openclaw' ? home : project;
  const ruleDir = path.join(base, provider === 'openclaw' ? '.openclaw/rules' : `.${provider === 'devin' ? 'windsurf' : provider}/rules`);
  const behaviorDir = path.join(base, provider === 'hermes' ? '.hermes/behaviors'
    : provider === 'openclaw' ? '.openclaw/behaviors' : `.${provider === 'devin' ? 'windsurf' : provider}/rules/behaviors`);
  const ruleFiles = filesUnder(ruleDir).filter(file => /\.(md|mdc)$/.test(file)
    && !file.startsWith(behaviorDir + path.sep));
  const behaviorFiles = filesUnder(behaviorDir).filter(file => /\.(md|mdc)$/.test(file));
  const rules = [], behaviors = [], conditional = [], mirrors = [];
  for (const file of ruleFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const item = record(file, base, content);
    // Claude loads a rule with `paths:` frontmatter only when a matching file is
    // read or written, so it is conditional, not startup context.
    if (provider === 'claude') {
      const frontmatter = content.match(/^(?:<!--[^\n]*-->\n)?---\r?\n([\s\S]*?)\r?\n---/);
      (frontmatter && /^paths:/m.test(frontmatter[1]) ? conditional : rules).push(item);
    } else if (provider === 'openclaw') rules.push(item);
    else if (provider === 'cursor' && file.endsWith('.mdc')) {
      (/^alwaysApply:\s*true\s*$/m.test(content) ? rules : conditional).push(item);
    } else mirrors.push(item);
  }
  for (const file of behaviorFiles) {
    // Claude recursively loads Markdown rules. Cursor's native rule format is
    // MDC; the current .md behavior mirrors are not native alwaysApply rules.
    (provider === 'claude' ? behaviors : mirrors).push(record(file, base));
  }
  if (provider === 'warp' || provider === 'hermes') {
    const file = path.join(project, provider === 'warp' ? 'WARP.md' : 'AGENTS.md');
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      const heading = provider === 'warp' ? 'AIWG Rules' : 'CRITICAL Rules (always apply)';
      const start = content.indexOf(`## ${heading}\n`);
      if (start >= 0) {
        const rest = content.slice(start);
        // Warp downshifts rule headings; horizontal rules inside those bodies
        // are content, not section boundaries.
        const end = rest.slice(3).search(/^## /m);
        const section = (end < 0 ? rest : rest.slice(0, end + 3)).replace(/\n---\s*$/, '\n');
        rules.push(record(file, project, section, `#${heading}`));
      }
    }
  }
  const contextFiles = (provider === 'warp' ? ['WARP.md'] : provider === 'claude'
    ? ['CLAUDE.md', 'WORKSPACE.md', 'AIWG.md'] : ['AGENTS.md', 'WORKSPACE.md', 'AIWG.md'])
    .map(name => path.join(project, name)).filter(file => fs.existsSync(file)).map(file => record(file, project));
  const sidecar = path.join(ruleDir, '.aiwg-rules-budget.json');
  return { rules: summarize(rules), behaviors: summarize(behaviors),
    startup: summarize([...rules, ...behaviors]), conditional: summarize(conditional),
    mirrors: summarize(mirrors), context_files: summarize(contextFiles),
    budget: fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null };
}

export function isolatedEnvironment(home) {
  // No operator AIWG config, provider homes, artifact routing, or budget
  // overrides can leak into the fixture deployment.
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    HERMES_HOME: path.join(home, '.hermes'), CODEX_HOME: path.join(home, '.codex'),
    AIWG_ROOT: ROOT, NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', CI: '1' };
}

export function deployFixture({ project, home, provider, framework }) {
  const command = `aiwg use ${framework} --provider ${provider}`;
  try {
    boundedExecFileSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), 'use', framework,
      '--provider', provider, '--target', project], 'long', {
      cwd: project, env: isolatedEnvironment(home), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'pipe',
    });
    return { command, exit_code: 0 };
  } catch (error) {
    // Preserve emitted-byte evidence for every provider, even if an unrelated
    // existing deploy verification fails. Such a measurement cannot pass U1.
    return { command, exit_code: error.status ?? 1,
      error: String(error.stderr || error.message).trim().split('\n')[0] };
  }
}

export async function measureStartupContext({ fixture = path.join(ROOT, 'test/fixtures/rule-binding/project'),
  providers = PROVIDERS, framework = 'sdlc', deploy = deployFixture } = {}) {
  if (!providers.length || providers.some(provider => !PROVIDERS.includes(provider))) throw new Error('Invalid providers');
  const result = {};
  for (const provider of providers) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-measure-'));
    try {
      const project = path.join(temp, 'project'), home = path.join(temp, 'home');
      fs.cpSync(fixture, project, { recursive: true, filter: source => {
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Fixture symlink is not isolated: ${source}`);
        return true;
      } });
      fs.mkdirSync(home);
      const deployment = await deploy({ project, home, provider, framework });
      result[provider] = measureDeployed(project, home, provider);
      if (deployment) result[provider].deployment = deployment;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return { version: 1, framework, token_estimate: 'sum(ceil(UTF-8 bytes per file / 4)); not a tokenizer',
    metric: 'Emitted native rule surfaces, including indexes and Claude behavior rules. Context adapters are separate; do not add context_files to startup (may overlap).',
    providers: result };
}

export function measurementGates(report, { baseline, maxClaudeBytes, checkPo = false } = {}) {
  const gates = [];
  for (const [provider, measured] of Object.entries(report.providers)) {
    if (measured.deployment) gates.push({ gate: 'deployment', provider, pass: measured.deployment.exit_code === 0 });
  }
  if (checkPo) for (const [key, expected] of Object.entries(PO_REFERENCE)) {
    const category = key.replace('_bytes', '');
    const actual = report.providers.claude?.[category].bytes;
    gates.push({ gate: 'PO', category, expected, actual, pass: Number.isFinite(actual) && Math.abs(actual - expected) / expected <= 0.01 });
  }
  if (maxClaudeBytes !== undefined) gates.push({ gate: 'U1', provider: 'claude',
    limit: maxClaudeBytes, actual: report.providers.claude?.startup.bytes,
    pass: report.providers.claude?.startup.bytes <= maxClaudeBytes });
  if (baseline) for (const [provider, previous] of Object.entries(baseline.providers)) {
    gates.push({ gate: 'U1-provider-regression', provider, limit: previous.startup.bytes,
      actual: report.providers[provider]?.startup.bytes,
      pass: report.providers[provider]?.startup.bytes <= previous.startup.bytes });
  }
  return gates;
}

async function main() {
  const { values } = parseArgs({ options: {
    fixture: { type: 'string' }, provider: { type: 'string', multiple: true }, framework: { type: 'string', default: 'sdlc' },
    output: { type: 'string' }, 'existing-project': { type: 'string' }, baseline: { type: 'string' },
    'max-claude-bytes': { type: 'string' }, 'check-po': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node tools/rules/measure-startup-context.mjs [--fixture DIR] [--provider NAME ...] [--framework sdlc] [--existing-project DIR] [--output FILE] [--check-po] [--baseline FILE] [--max-claude-bytes N]');
    return;
  }
  const maxClaudeBytes = values['max-claude-bytes'] === undefined ? undefined : Number(values['max-claude-bytes']);
  if (maxClaudeBytes !== undefined && (!Number.isSafeInteger(maxClaudeBytes) || maxClaudeBytes < 0)) throw new Error('Invalid byte limit');
  const report = await measureStartupContext({ fixture: values.fixture, providers: values.provider, framework: values.framework });
  if (values['existing-project']) {
    // Read the repository's current deploy; never refresh or mutate it.
    const project = path.resolve(values['existing-project']);
    const available = fs.existsSync(path.join(project, '.claude/rules'));
    report.existing_project = { available,
      note: 'Read-only worktree inspection; absence is not a zero-byte deployed baseline.',
      claude: available ? measureDeployed(project, '', 'claude') : null };
  }
  report.gates = measurementGates(report, { maxClaudeBytes, checkPo: values['check-po'],
    baseline: values.baseline ? JSON.parse(fs.readFileSync(values.baseline, 'utf8')) : undefined });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, json);
  process.stdout.write(json);
  if (report.gates.some(gate => !gate.pass)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
