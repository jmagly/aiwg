#!/usr/bin/env node
/**
 * Guided onboarding command.
 *
 * Dry-run mode prints the provider/project/framework/deploy/verify plan
 * without writing files. Normal execution delegates deployment to the existing
 * `aiwg use` path and then runs the deterministic status probe.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import readline from 'readline/promises';
import { buildVerificationProbe } from './workspace-status.mjs';

const PROJECT_SIGNALS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'Gemfile',
  'build.gradle',
];

const MAX_PARENT_DEPTH = 3;

const VALID_PROVIDERS = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'factory',
  'grokbot',
  'opencode',
  'openclaw',
  'pi',
  'omp',
  'warp',
  'windsurf',
  'generic',
];

const VALID_FRAMEWORKS = [
  'sdlc',
  'research',
  'marketing',
  'forensics',
  'ops',
  'security-engineering',
  'knowledge-base',
  'media-curator',
  'writing',
  'general',
];

const PROFILE_PRESETS = {
  beginner: { framework: 'sdlc', goal: 'help me start a project' },
  default: { framework: 'sdlc', goal: 'help me start a project' },
  sdlc: { framework: 'sdlc', goal: 'help me start a project' },
  research: { framework: 'research', goal: 'organize research and citations' },
  marketing: { framework: 'marketing', goal: 'plan a marketing campaign' },
  forensics: { framework: 'forensics', goal: 'investigate an incident' },
  ops: { framework: 'ops', goal: 'manage infrastructure operations' },
  security: { framework: 'security-engineering', goal: 'assess security' },
  'knowledge-base': { framework: 'knowledge-base', goal: 'build a knowledge base' },
  writing: { framework: 'writing', goal: 'improve writing with voice guidance' },
};

const INTENT_CLUSTERS = [
  { match: /start|idea|build|project|requirements|intake/i, framework: 'sdlc', discover: 'intake wizard' },
  { match: /research|paper|citation|grade|literature/i, framework: 'research', discover: 'research workflow' },
  { match: /market|campaign|brand|content|audience/i, framework: 'marketing', discover: 'marketing intake' },
  { match: /incident|forensic|breach|ioc|timeline/i, framework: 'forensics', discover: 'incident timeline' },
  { match: /infra|server|ops|runbook|fleet/i, framework: 'ops', discover: 'ops runbook' },
  { match: /security|threat|crypto|secret|supply chain/i, framework: 'security-engineering', discover: 'security assessment' },
  { match: /remember|knowledge|wiki|memory|corpus/i, framework: 'knowledge-base', discover: 'memory ingest' },
  { match: /write|voice|draft|prose|copy/i, framework: 'writing', discover: 'apply voice profile' },
];

const PROVIDER_PROMPT_ORDER = ['codex', 'claude', 'deepseek-harness', 'pi', 'omp', 'opencode', 'cursor', 'copilot', 'warp', 'windsurf', 'factory', 'openclaw', 'grokbot', 'generic'];

function parseArgs(args) {
  const options = {
    dryRun: false,
    json: false,
    help: false,
    provider: null,
    framework: null,
    profile: null,
    nonInteractive: false,
    executionGuard: null,
    goal: '',
    projectRoot: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if ((arg === '--provider' || arg === '-p') && args[i + 1]) {
      options.provider = args[++i];
    } else if ((arg === '--framework' || arg === '-f') && args[i + 1]) {
      options.framework = args[++i];
    } else if (arg === '--profile' && args[i + 1]) {
      options.profile = args[++i];
    } else if (arg === '--non-interactive' || arg === '--yes' || arg === '-y') {
      options.nonInteractive = true;
    } else if ((arg === '--goal' || arg === '-g') && args[i + 1]) {
      options.goal = args[++i];
    } else if (!arg.startsWith('-')) {
      options.projectRoot = path.resolve(arg);
    }
  }

  return options;
}

function enforceExecutionGuards(options, input = process.stdin, output = process.stdout) {
  const guarded = { ...options };
  if (guarded.json) {
    guarded.dryRun = true;
    guarded.executionGuard = 'JSON output is plan-only and never deploys.';
  } else if (!guarded.nonInteractive && !guarded.dryRun && !(input.isTTY && output.isTTY)) {
    guarded.dryRun = true;
    guarded.executionGuard = 'Unattended execution requires --non-interactive; showing a dry-run plan instead.';
  }
  return guarded;
}

function displayHelp() {
  console.log(`
AIWG - Onboarding Wizard

USAGE
  aiwg wizard [options] [project-root]

OPTIONS
  --goal <text>       Plain-language goal used to recommend a framework
  --profile <preset>  Non-interactive preset (${Object.keys(PROFILE_PRESETS).join(', ')})
  --provider <name>   Provider to target (${VALID_PROVIDERS.join(', ')})
  --framework <name>  Framework to deploy (${VALID_FRAMEWORKS.join(', ')})
  --non-interactive   Execute with selected or inferred defaults; never prompt
  --dry-run, -n       Print the guided plan without writing files
  --json             Output the guided plan as JSON
  --help, -h         Show this help message

EXAMPLES
  aiwg wizard --dry-run --goal "help me start a project"
  aiwg wizard
  aiwg wizard --non-interactive --profile beginner --provider codex
  aiwg wizard --provider codex --framework sdlc --dry-run
`);
}

function hasCsprojFile(dir) {
  try {
    return fs.readdirSync(dir).some((entry) => /\.csproj$/i.test(entry));
  } catch {
    return false;
  }
}

function detectProjectSignal(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
    for (const signal of PROJECT_SIGNALS) {
      if (fs.existsSync(path.join(dir, signal))) {
        return { found: true, signal, foundAt: dir };
      }
    }
    if (hasCsprojFile(dir)) {
      return { found: true, signal: '*.csproj', foundAt: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { found: false, signal: null, foundAt: null };
}

function isUnsuitableCwd(cwd, home = os.homedir()) {
  const normalized = stripTrailingSep(path.resolve(cwd));
  return normalized === stripTrailingSep(home) || normalized === '/' || normalized === '/tmp';
}

function stripTrailingSep(value) {
  return value.length > 1 && /[\\/]$/.test(value) ? value.slice(0, -1) : value;
}

function detectProviders(projectRoot, env = process.env) {
  const found = [];
  const add = (name, reason) => {
    if (VALID_PROVIDERS.includes(name) && !found.some((provider) => provider.name === name)) {
      found.push({ name, reason });
    }
  };

  const envProvider = env.AIWG_PROVIDER || env.CLAUDECODE_PROVIDER;
  if (envProvider) add(envProvider, 'environment');
  if (env.CODEX_SANDBOX || env.CODEX_HOME) add('codex', 'environment');

  const projectSignals = [
    ['claude', '.claude'],
    ['codex', '.codex'],
    ['copilot', '.github'],
    ['cursor', '.cursor'],
    ['opencode', '.opencode'],
    ['warp', '.warp'],
    ['windsurf', '.windsurf'],
    ['generic', '.agents'],
  ];
  for (const [provider, relativePath] of projectSignals) {
    if (fs.existsSync(path.join(projectRoot, relativePath))) add(provider, `project path ${relativePath}`);
  }

  const primary = found.length === 1 ? found[0].name : found.length > 1 ? null : null;
  return {
    count: found.length,
    primary,
    providers: found,
    status: found.length === 0 ? 'none-detected' : found.length === 1 ? 'single-detected' : 'multiple-detected',
  };
}

function resolveProfile(profile) {
  if (!profile) return null;
  return PROFILE_PRESETS[profile] || null;
}

function resolveProvider(options, projectRoot) {
  const detected = detectProviders(projectRoot);
  if (options.provider) {
    return { provider: options.provider, detected, reason: 'selected by user' };
  }
  if (detected.primary) {
    return { provider: detected.primary, detected, reason: detected.providers[0].reason };
  }
  if (detected.providers.length > 1 && options.nonInteractive) {
    const selected = PROVIDER_PROMPT_ORDER.find((candidate) => detected.providers.some((provider) => provider.name === candidate));
    return { provider: selected || detected.providers[0].name, detected, reason: 'non-interactive default from detected providers' };
  }
  if (envPreferredProvider()) {
    return { provider: envPreferredProvider(), detected, reason: 'environment' };
  }
  return { provider: 'generic', detected, reason: 'fallback default' };
}

function envPreferredProvider() {
  const envProvider = process.env.AIWG_PROVIDER || process.env.CLAUDECODE_PROVIDER;
  if (envProvider && VALID_PROVIDERS.includes(envProvider)) return envProvider;
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex';
  return null;
}

function inferFramework(goal) {
  if (!goal) return { framework: 'sdlc', discover: 'intake wizard', reason: 'default beginner path' };
  for (const cluster of INTENT_CLUSTERS) {
    if (cluster.match.test(goal)) {
      return { framework: cluster.framework, discover: cluster.discover, reason: `matched goal phrase: ${cluster.discover}` };
    }
  }
  return { framework: 'sdlc', discover: 'aiwg steward', reason: 'no close match; start with steward/discovery' };
}

function validateSelection(name, value, allowed) {
  if (!value || allowed.includes(value)) return null;
  return {
    severity: 'error',
    message: `Unknown ${name}: ${value}`,
    action: `Choose one of: ${allowed.join(', ')}`,
  };
}

function buildWizardPlan(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const projectSignal = detectProjectSignal(projectRoot);
  const profile = resolveProfile(options.profile);
  const goal = options.goal || profile?.goal || '';
  const inferred = inferFramework(goal);
  const providerResolution = resolveProvider(options, projectRoot);
  const provider = providerResolution.provider;
  const providerDetection = providerResolution.detected;
  const framework = options.framework || profile?.framework || inferred.framework;
  const warnings = [];
  const providerError = validateSelection('provider', provider, VALID_PROVIDERS);
  const frameworkError = validateSelection('framework', framework, VALID_FRAMEWORKS);
  const profileError = options.profile && !profile
    ? validateSelection('profile', options.profile, Object.keys(PROFILE_PRESETS))
    : null;

  if (providerError) warnings.push(providerError);
  if (frameworkError) warnings.push(frameworkError);
  if (profileError) warnings.push(profileError);
  if (!options.provider && providerDetection.count > 1 && !options.nonInteractive) {
    warnings.push({
      severity: 'error',
      message: `Multiple providers detected: ${providerDetection.providers.map((item) => item.name).join(', ')}`,
      action: 'Re-run with --provider <name>, or use --non-interactive to accept the default.',
    });
  }
  if (!options.provider && providerDetection.count === 0) {
    warnings.push({
      severity: 'warning',
      message: 'No provider-specific project files were detected.',
      action: 'The wizard will use the generic provider unless you pass --provider.',
    });
  }
  if (options.executionGuard) {
    warnings.push({
      severity: 'warning',
      message: options.executionGuard,
      action: options.json ? 'Re-run without --json to execute.' : 'Re-run with --non-interactive to execute without prompts.',
    });
  }
  if (!projectSignal.found && isUnsuitableCwd(projectRoot)) {
    warnings.push({
      severity: 'warning',
      message: 'No project detected here. AIWG will deploy to the current directory.',
      action: 'Run this from your project root before deploying.',
    });
  }

  const deployArgs = ['use', framework, '--provider', provider, '--target', projectRoot, '--non-interactive'];
  const deployCommand = `aiwg ${deployArgs.join(' ')}`;
  const verifyCommand = 'aiwg status --probe --json';
  const dryRun = Boolean(options.dryRun);
  const hasErrors = warnings.some((warning) => warning.severity === 'error');

  return {
    schema: 'aiwg.wizard.plan.v1',
    dry_run: dryRun,
    non_interactive: Boolean(options.nonInteractive),
    writes_files: !dryRun && !hasErrors,
    project_root: projectRoot,
    goal: goal || null,
    profile: options.profile || null,
    recommendation: {
      provider,
      framework,
      reason: options.framework ? 'selected by user' : profile ? `profile preset: ${options.profile}` : inferred.reason,
      discover_phrase: inferred.discover,
    },
    provider_detection: providerDetection,
    project_detection: projectSignal,
    warnings,
    deployment: {
      command: deployCommand,
      args: deployArgs,
    },
    steps: [
      { id: 'provider', status: providerError ? 'error' : 'ready', detail: provider },
      { id: 'project', status: projectSignal.found ? 'ready' : 'needs-review', detail: projectSignal.foundAt || projectRoot },
      { id: 'framework', status: frameworkError ? 'error' : 'ready', detail: framework },
      { id: 'deploy', status: dryRun ? 'planned' : hasErrors ? 'blocked' : 'ready', command: deployCommand },
      { id: 'verify', status: dryRun ? 'planned' : hasErrors ? 'blocked' : 'required', command: verifyCommand },
    ],
    next_actions: [
      dryRun ? `Run: ${deployCommand}` : 'Open your target agent session in this project root.',
      `Then verify: ${verifyCommand}`,
    ],
  };
}

function printPlan(plan) {
  console.log('\nAIWG Onboarding Wizard');
  console.log('='.repeat(60));
  console.log('');
  console.log('Provider:  ' + plan.recommendation.provider + ` (${plan.provider_detection.status})`);
  console.log('Project:   ' + (plan.project_detection.found ? `${plan.project_detection.foundAt} (${plan.project_detection.signal})` : `${plan.project_root} (no signal found)`));
  console.log('Framework: ' + plan.recommendation.framework);
  console.log('Reason:    ' + plan.recommendation.reason);
  console.log('');

  if (plan.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of plan.warnings) {
      console.log(`  ${warning.severity}: ${warning.message}`);
      console.log(`    ${warning.action}`);
    }
    console.log('');
  }

  console.log('Guided Steps:');
  for (const step of plan.steps) {
    console.log(`  ${step.id.padEnd(10)} ${step.status}${step.command ? `  ${step.command}` : `  ${step.detail}`}`);
  }
  console.log('');
  if (plan.dry_run) {
    console.log('No files were written by this dry run.');
  } else {
    console.log('This run will deploy through the existing aiwg use path.');
  }
  console.log('Verification is required before treating setup as complete:');
  console.log('  ' + plan.steps.find((step) => step.id === 'verify').command);
  console.log('');
}

function canPrompt(options, input = process.stdin, output = process.stdout) {
  return !options.nonInteractive && !options.json && input.isTTY && output.isTTY;
}

function formatChoices(choices) {
  return choices.map((choice, index) => `${index + 1}) ${choice}`).join('  ');
}

async function promptChoice(rl, label, choices, defaultChoice) {
  const defaultIndex = choices.indexOf(defaultChoice);
  const suffix = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : '';
  const answer = (await rl.question(`${label}\n${formatChoices(choices)}\nChoose${suffix}: `)).trim();
  if (!answer) return defaultChoice;

  const selectedIndex = Number(answer);
  if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= choices.length) {
    return choices[selectedIndex - 1];
  }

  const normalized = choices.find((choice) => choice.toLowerCase() === answer.toLowerCase());
  return normalized || defaultChoice;
}

async function promptText(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function promptYesNo(rl, label, defaultValue = false) {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

function providerPromptChoices(detected) {
  const detectedNames = detected.providers.map((provider) => provider.name);
  const orderedDetected = PROVIDER_PROMPT_ORDER.filter((provider) => detectedNames.includes(provider));
  const remainder = PROVIDER_PROMPT_ORDER.filter((provider) => !orderedDetected.includes(provider));
  return [...orderedDetected, ...remainder];
}

async function promptWizardOptions(options, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  if (!canPrompt(options, input, output)) return options;

  const prompted = { ...options };
  const rl = io.readlineInterface || readline.createInterface({ input, output });
  try {
    const projectRoot = path.resolve(prompted.projectRoot);
    const detected = detectProviders(projectRoot);

    if (!prompted.goal && !prompted.framework && !prompted.profile) {
      prompted.goal = await promptText(rl, 'What are you working on?', 'help me start a project');
    }

    if (!prompted.provider && detected.count !== 1) {
      const choices = providerPromptChoices(detected);
      const defaultProvider = detected.providers.length > 0
        ? PROVIDER_PROMPT_ORDER.find((provider) => detected.providers.some((item) => item.name === provider)) || detected.providers[0].name
        : envPreferredProvider() || 'generic';
      prompted.provider = await promptChoice(rl, 'Which AI provider should AIWG target?', choices, defaultProvider);
    }

    if (!prompted.framework && !prompted.profile) {
      const inferred = inferFramework(prompted.goal);
      prompted.framework = await promptChoice(rl, 'Which AIWG path should be deployed first?', VALID_FRAMEWORKS, inferred.framework);
    }

    if (!prompted.dryRun) {
      const deployNow = await promptYesNo(rl, 'Deploy this plan now?', false);
      prompted.dryRun = !deployNow;
    }
  } finally {
    rl.close();
  }

  return prompted;
}

function resolveAiwgBin() {
  if (process.env.AIWG_BIN) return process.env.AIWG_BIN;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'aiwg.mjs');
}

function spawnAiwg(args, options = {}) {
  const aiwgBin = resolveAiwgBin();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [aiwgBin, ...args], {
      cwd: options.cwd || process.cwd(),
      stdio: options.capture ? 'pipe' : 'inherit',
      env: { ...process.env, AIWG_WIZARD_CHILD: '1' },
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });
    }
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
  });
}

async function executeWizardPlan(plan, options = {}) {
  if (plan.dry_run || plan.warnings.some((warning) => warning.severity === 'error')) {
    return { exitCode: plan.warnings.some((warning) => warning.severity === 'error') ? 1 : 0, plan, deploy: null, probe: null };
  }

  const runCommand = options.runCommand || spawnAiwg;
  const deploy = await runCommand(plan.deployment.args, { cwd: plan.project_root, capture: options.capture });
  if (deploy.exitCode !== 0) {
    return { exitCode: deploy.exitCode, plan, deploy, probe: null };
  }

  const probe = await buildVerificationProbe(plan.project_root);
  return { exitCode: probe.engaged ? 0 : 1, plan, deploy, probe };
}

async function wizard(args) {
  let options = parseArgs(args);
  if (options.help) {
    displayHelp();
    return;
  }

  options = await promptWizardOptions(options);
  options = enforceExecutionGuards(options);
  const plan = buildWizardPlan(options);
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan);
  }

  const result = await executeWizardPlan(plan);
  if (!options.json && result.probe) {
    console.log('Verification Result:');
    console.log(`  Status: ${result.probe.status}`);
    console.log(`  Engaged: ${result.probe.engaged ? 'yes' : 'no'}`);
    if (result.probe.verification.next_command) {
      console.log(`  Next: ${result.probe.verification.next_command}`);
    }
    console.log('');
  }

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await wizard(process.argv.slice(2));
}

export { buildWizardPlan, detectProjectSignal, detectProviders, enforceExecutionGuards, executeWizardPlan, promptWizardOptions, wizard };
