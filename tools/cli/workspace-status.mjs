#!/usr/bin/env node
/**
 * CLI Workspace Status Tool
 *
 * Shows workspace health, installed frameworks, and migration status.
 *
 * @module tools/cli/workspace-status
 * @version 1.0.0
 * @since 2025-12-09
 *
 * @usage
 * # Show workspace status
 * aiwg -status
 *
 * # Show detailed framework health
 * aiwg -status --verbose
 *
 * # Output as JSON
 * aiwg -status --json
 */

import fs from 'fs/promises';
import { readAuthorizationHealth } from './authorization-health.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { collectDecisionOffloadReport, formatDecisionOffloadReport } from './decision-offload-report.mjs';
import { existsSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../..');
const runtimeRoot = existsSync(path.join(packageRoot, 'src')) ? 'src' : 'dist/src';
const { readNativeSandboxWarnings } = await importImpl(import.meta.url, 'config/native-sandbox-warnings.js');
const [{ resolveProjectAiwgDir }, { auditProjectArtifactHealth }] = await Promise.all([
  import(pathToFileURL(path.join(packageRoot, runtimeRoot, 'config/project-artifacts-runtime.mjs')).href),
  import(pathToFileURL(path.join(packageRoot, runtimeRoot, 'config/project-artifacts-health.mjs')).href),
]);

// ===========================
// CLI Helpers
// ===========================

/**
 * Display help message
 */
function displayHelp() {
  console.log(`
AIWG - Workspace Status Tool

Shows workspace health, installed frameworks, and migration status.

USAGE
  aiwg -status [options] [project-root]
  node tools/cli/workspace-status.mjs [options] [project-root]

OPTIONS
  --verbose, -v   Show detailed information
  --json          Output as JSON
  --probe         Output deterministic first-run verification probe
  --export <fmt>  Export fleet status payload: json | ndjson
  --serve         Serve fleet status JSON over loopback HTTP
  --bind <addr>   Bind address for --serve (default: 127.0.0.1)
  --port <port>   Port for --serve (default: 7387)
  --fleet-id <id> Machine identifier for fleet exports
  --activity-hours <n> Activity-log lookback window (default: 24)
  --help, -h      Show this help message

ARGUMENTS
  project-root    Path to project root (default: current directory)

EXAMPLES
  # Show workspace status
  aiwg -status

  # Show detailed framework health
  aiwg -status --verbose

  # Output as JSON for scripting
  aiwg -status --json

  # Output deterministic first-run verification probe
  aiwg status --probe --json

  # Export fleet status for cockpit ingestion
  aiwg status --export json --fleet-id eride
  aiwg status --export ndjson

  # Serve fleet status on loopback for polling
  aiwg status --serve --port 7387 --fleet-id eride
`);
}

/**
 * Parse command-line arguments
 */
function parseArgs(args) {
  const options = {
    verbose: false,
    json: false,
    probe: false,
    exportFormat: null,
    serve: false,
    bind: '127.0.0.1',
    port: 7387,
    fleetId: null,
    activityHours: 24,
    projectRoot: process.cwd(),
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--probe') {
      options.probe = true;
      options.json = true;
    } else if (arg === '--export' && args[i + 1]) {
      options.exportFormat = args[++i];
    } else if (arg === '--serve') {
      options.serve = true;
    } else if (arg === '--bind' && args[i + 1]) {
      options.bind = args[++i];
    } else if (arg === '--port' && args[i + 1]) {
      const port = Number(args[++i]);
      if (Number.isInteger(port) && port >= 0 && port < 65536) options.port = port;
    } else if (arg === '--fleet-id' && args[i + 1]) {
      options.fleetId = args[++i];
    } else if (arg === '--activity-hours' && args[i + 1]) {
      const hours = Number(args[++i]);
      if (Number.isFinite(hours) && hours >= 0) options.activityHours = hours;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      options.projectRoot = path.resolve(arg);
    }
  }

  return options;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonFileDetailed(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { exists: true, valid: true, data: JSON.parse(content), error: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, valid: false, data: null, error: null };
    }
    return {
      exists: true,
      valid: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get status emoji
 */
function statusEmoji(status) {
  switch (status) {
    case 'healthy':
      return '✅';
    case 'warning':
      return '⚠️';
    case 'error':
      return '❌';
    default:
      return '❓';
  }
}

function normalizeRegistryFrameworks(registry) {
  if (!registry || !registry.frameworks) return [];

  const entries = Array.isArray(registry.frameworks)
    ? registry.frameworks.map((data) => [data?.id, data])
    : Object.entries(registry.frameworks);

  return entries
    .filter(([id]) => typeof id === 'string' && id.length > 0)
    .map(([id, data]) => ({
      id,
      type: data.type || 'framework',
      version: data.version || 'unknown',
      health: data.health || 'healthy',
      installDate: data.installed || data.installedAt || data['install-date'] || 'unknown'
    }));
}

async function countDirEntries(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.length;
  } catch {
    return 0;
  }
}

async function collectProviderDeployments(projectRoot) {
  const providers = [
    { name: 'claude-code', path: '.claude', artifactDirs: ['agents', 'commands', 'skills', 'rules', 'behaviors'] },
    { name: 'codex', path: '.codex', artifactDirs: ['agents', 'prompts', 'skills', 'rules'] },
    { name: 'copilot', path: '.github', artifactDirs: ['prompts', 'instructions'] },
    { name: 'cursor', path: '.cursor', artifactDirs: ['agents', 'commands', 'skills', 'rules'] },
    { name: 'opencode', path: '.opencode', artifactDirs: ['agent', 'command', 'skill', 'rule'] },
    { name: 'warp', path: '.warp', artifactDirs: ['agents', 'commands', 'skills', 'rules'] },
    { name: 'universal', path: '.agents', artifactDirs: ['agents', 'commands', 'skills', 'rules'] }
  ];

  const deployments = [];
  for (const provider of providers) {
    const providerPath = path.join(projectRoot, provider.path);
    try {
      await fs.access(providerPath);
    } catch {
      continue;
    }

    const counts = {};
    for (const dir of provider.artifactDirs) {
      const count = await countDirEntries(path.join(providerPath, dir));
      if (count > 0) counts[dir] = count;
    }
    const manifest = await readJsonFile(path.join(providerPath, '.aiwg-manifest.json'));
    deployments.push({
      name: provider.name,
      path: provider.path,
      counts,
      lastRefresh: manifest?.generatedAt || manifest?.deployedAt || manifest?.timestamp || null
    });
  }
  return deployments;
}

async function collectProjectLocalBundles(aiwgPath, installedFrameworkIds = new Set()) {
  const bundleDirs = ['extensions', 'addons', 'frameworks', 'plugins'];
  const bundles = [];
  for (const type of bundleDirs) {
    const typeDir = path.join(aiwgPath, type);
    let entries;
    try {
      entries = await fs.readdir(typeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => type !== 'frameworks' || !installedFrameworkIds.has(entry.name))
      .map(entry => entry.name)
      .sort();
    if (names.length > 0) {
      bundles.push({ type, count: names.length, names });
    }
  }
  return bundles;
}

function parseActivityLogLine(line) {
  const match = /^##\s+\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s+([a-z]+)\s+\|\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  const [, rawTimestamp, operation, summary] = match;
  const isoTimestamp = `${rawTimestamp.replace(' ', 'T')}:00.000Z`;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  return { timestamp: isoTimestamp, rawTimestamp, operation, summary };
}

async function collectActivityLog(projectRoot, hours) {
  const aiwgRoot = resolveProjectAiwgDir(projectRoot);
  const candidates = [
    path.join(aiwgRoot, 'activity.log'),
    path.join(aiwgRoot, 'activity-log', 'activity.log')
  ];
  let content = null;
  let source = null;
  for (const candidate of candidates) {
    try {
      content = await fs.readFile(candidate, 'utf8');
      source = path.relative(projectRoot, candidate);
      break;
    } catch {
      // Try next historical location.
    }
  }
  if (!content) return { source: null, entries: [] };

  const cutoff = hours > 0 ? Date.now() - hours * 60 * 60 * 1000 : 0;
  const entries = content
    .split('\n')
    .map(parseActivityLogLine)
    .filter(Boolean)
    .filter(entry => cutoff === 0 || new Date(entry.timestamp).getTime() >= cutoff)
    .slice(-100);

  return { source, entries };
}

async function collectActiveOperations(projectRoot) {
  const aiwgRoot = resolveProjectAiwgDir(projectRoot);
  const checks = [
    { name: 'mission-control', path: path.join(aiwgRoot, 'mc') },
    { name: 'ralph', path: path.join(aiwgRoot, 'ralph') },
    { name: 'daemon', path: path.join(aiwgRoot, 'daemon') }
  ];
  const operations = [];
  for (const check of checks) {
    try {
      const entries = await fs.readdir(check.path, { withFileTypes: true });
      const count = entries.filter(entry => !entry.name.startsWith('.')).length;
      if (count > 0) {
        operations.push({
          subsystem: check.name,
          path: path.relative(projectRoot, check.path),
          count
        });
      }
    } catch {
      // No active state for this subsystem.
    }
  }
  return operations;
}

async function buildWorkspaceStatus(projectRoot) {
  const aiwgPath = resolveProjectAiwgDir(projectRoot);
  const artifactHealth = auditProjectArtifactHealth(projectRoot);
  const { rulePinState } = await importImpl(import.meta.url, 'rules/pin-state.js');
  const pins = rulePinState(projectRoot, packageRoot);
  const result = {
    nativeSandboxWarnings: await readNativeSandboxWarnings(projectRoot).catch(() => []),
    rule_pins: { rules: pins.rules, warnings: pins.warnings },
    decisionOffload: await collectDecisionOffloadReport(projectRoot),
    workspace: {
      path: aiwgPath,
      exists: false,
      isLegacy: false,
      isFrameworkScoped: false
    },
    frameworks: [],
    providerDeployments: [],
    projectLocalBundles: [],
    health: {
      overall: 'unknown',
      issues: []
    },
    migration: {
      status: 'unknown',
      backupsAvailable: 0
    },
    artifactHealth,
  };

  if (artifactHealth.severity !== 'ok') {
    result.health.issues.push({
      severity: artifactHealth.severity,
      message: `External artifact corpus: ${artifactHealth.classification}.`,
      action: artifactHealth.action,
    });
    result.health.overall = artifactHealth.severity;
  }

  try {
    await fs.access(aiwgPath);
    result.workspace.exists = true;
  } catch {
    result.workspace.exists = false;
  }

  if (!result.workspace.exists) return result;

  const frameworksDir = path.join(aiwgPath, 'frameworks');
  // SDLC-canonical artifact dirs. These coexist with `.aiwg/frameworks/` by
  // design when sdlc-complete is deployed (documented in CLAUDE.md). They only
  // indicate a genuinely-legacy (pre-#54) workspace when `.aiwg/frameworks/`
  // is absent. See issue #1516.
  const sdlcCanonicalDirs = ['intake', 'requirements', 'architecture', 'planning', 'testing'];
  // Non-SDLC top-level dirs that the pre-#1516 deploy scaffolded by mistake.
  // If any of these exist, the workspace pre-dates the manifest fix and a
  // migration is needed to move them under `.aiwg/frameworks/<id>/`.
  const orphanLegacyDirs = ['forensics', 'kb', 'media', 'media-curator', 'marketing', 'security-engineering'];

  try {
    await fs.access(frameworksDir);
    result.workspace.isFrameworkScoped = true;
  } catch {
    result.workspace.isFrameworkScoped = false;
  }

  let hasSdlcDirs = false;
  for (const dir of sdlcCanonicalDirs) {
    try {
      await fs.access(path.join(aiwgPath, dir));
      hasSdlcDirs = true;
      break;
    } catch {
      // Directory doesn't exist.
    }
  }

  let hasOrphanLegacy = false;
  for (const dir of orphanLegacyDirs) {
    try {
      await fs.access(path.join(aiwgPath, dir));
      hasOrphanLegacy = true;
      break;
    } catch {
      // Directory doesn't exist.
    }
  }

  // isLegacy now only fires when the workspace shape genuinely warrants a
  // migration: either pre-#54 SDLC-only top-level layout, or orphan non-SDLC
  // top-level dirs left over from a pre-#1516 deploy.
  if (hasSdlcDirs && !result.workspace.isFrameworkScoped) {
    result.workspace.isLegacy = true;
  } else if (hasOrphanLegacy) {
    result.workspace.isLegacy = true;
  }

  if (result.workspace.isFrameworkScoped && !result.workspace.isLegacy) {
    result.migration.status = 'completed';
  } else if (result.workspace.isLegacy && !result.workspace.isFrameworkScoped) {
    result.migration.status = 'pending';
  } else if (result.workspace.isLegacy && result.workspace.isFrameworkScoped) {
    result.migration.status = 'partial';
  } else {
    result.migration.status = 'none';
  }

  const parentDir = path.dirname(aiwgPath);
  try {
    const entries = await fs.readdir(parentDir);
    result.migration.backupsAvailable = entries.filter(
      name => name.startsWith('.aiwg.backup.')
    ).length;
  } catch {
    result.migration.backupsAvailable = 0;
  }

  const registryPath = path.join(frameworksDir, 'registry.json');
  const registryRead = await readJsonFileDetailed(registryPath);
  if (registryRead.valid) {
    result.frameworks = normalizeRegistryFrameworks(registryRead.data);
  } else if (registryRead.exists) {
    result.health.issues.push({
      severity: 'warning',
      message: 'Framework registry exists but could not be parsed.',
      action: 'Re-run aiwg use for the intended framework.',
    });
  }

  const configRead = await readJsonFileDetailed(path.join(aiwgPath, 'aiwg.config'));
  if (configRead.exists && !configRead.valid) {
    result.health.issues.push({
      severity: 'warning',
      message: 'AIWG project config exists but could not be parsed.',
      action: 'Review .aiwg/aiwg.config or re-run aiwg init.',
    });
  }

  result.providerDeployments = await collectProviderDeployments(projectRoot);
  result.projectLocalBundles = await collectProjectLocalBundles(
    aiwgPath,
    new Set(result.frameworks.map(framework => framework.id))
  );

  if (result.frameworks.length === 0) {
    result.health.overall = 'unknown';
  } else {
    const hasErrors = result.frameworks.some(f => f.health === 'error');
    const hasWarnings = result.frameworks.some(f => f.health === 'warning');

    if (hasErrors) {
      result.health.overall = 'error';
    } else if (hasWarnings) {
      result.health.overall = 'warning';
    } else {
      result.health.overall = 'healthy';
    }
  }

  if (result.health.issues.some((issue) => issue.severity === 'warning') && result.health.overall !== 'error') {
    result.health.overall = 'warning';
  }

  if (result.workspace.isLegacy && !result.workspace.isFrameworkScoped) {
    result.health.issues.push({
      severity: 'warning',
      message: 'Legacy workspace structure detected. Consider migrating.',
      action: 'aiwg -migrate-workspace'
    });
  }

  return result;
}

async function buildVerificationProbe(projectRoot) {
  const { deploymentProbeScope } = await importImpl(import.meta.url, 'cli/services/deployment-probe-scope.js');
  if (await deploymentProbeScope(projectRoot) === 'user') {
    const { buildDeploymentStatusProbe } = await importImpl(import.meta.url, 'cli/services/deployment-verification.js');
    return buildDeploymentStatusProbe(projectRoot, packageRoot, { scope: 'user' });
  }
  const workspace = await buildWorkspaceStatus(projectRoot);
  const frameworkCount = workspace.frameworks.length;
  const providerCount = workspace.providerDeployments.length;
  const malformedConfig = workspace.health.issues.some((issue) => /could not be parsed/.test(issue.message));
  const artifactNeedsRepair = workspace.artifactHealth.external_configured && workspace.artifactHealth.severity !== 'ok';
  const ready = workspace.workspace.exists && frameworkCount > 0 && providerCount > 0;
  const partial = workspace.workspace.exists && (frameworkCount > 0 || providerCount > 0 || malformedConfig);

  const userRegistryOverride = Boolean(process.env.AIWG_USER_REGISTRY_PATH && String(process.env.AIWG_USER_REGISTRY_PATH).trim());
  if (userRegistryOverride) {
    workspace.health.issues.push({
      severity: 'warning',
      message: 'AIWG_USER_REGISTRY_PATH is set (test override active); user registry is not writing to default ~/.aiwg/installed.json',
      action: 'unset AIWG_USER_REGISTRY_PATH',
    });
    if (workspace.health.overall !== 'error') {
      workspace.health.overall = 'warning';
    }
  }

  return {
    schema: 'aiwg.status.probe.v1',
    authorization: await readAuthorizationHealth(projectRoot),
    nativeSandboxWarnings: workspace.nativeSandboxWarnings,
    rule_pins: workspace.rule_pins,
    generated_at: new Date().toISOString(),
    project_root: path.resolve(projectRoot),
    engaged: ready && !artifactNeedsRepair,
    status: malformedConfig || artifactNeedsRepair ? 'needs-repair' : ready ? 'ready' : partial ? 'partial' : 'not-configured',
    checks: {
      workspace_exists: workspace.workspace.exists,
      framework_count: frameworkCount,
      provider_deployment_count: providerCount,
      health: workspace.health.overall,
      malformed_config: malformedConfig,
      artifact_health: workspace.artifactHealth.classification,
      external_artifact_reachable: workspace.artifactHealth.external_reachable,
      user_registry_path_override: userRegistryOverride,
    },
    verification: {
      required: true,
      action: artifactNeedsRepair
        ? workspace.artifactHealth.action
        : ready
        ? 'AIWG workspace and provider deployment are detected.'
        : malformedConfig
          ? 'Repair the malformed AIWG config or registry, then run this probe again.'
        : 'Run the guided path, deploy one framework, then run this probe again.',
      command: 'aiwg status --probe --json',
      next_command: artifactNeedsRepair
        ? 'aiwg artifacts repair --dry-run'
        : ready ? null : malformedConfig ? 'aiwg doctor --project-local' : 'aiwg wizard --dry-run',
    },
    agent_response_guidance: {
      when_asked_if_aiwg_is_engaged:
        'Run or read `aiwg status --probe --json`, report engaged/status/project_root/provider_deployments plainly, and do not add AIWG attribution to generated user files, commits, comments, or headers.',
      no_attribution_default: true,
      passive_footer_default: false,
    },
    workspace,
  };
}

async function readAiwgVersion() {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json')
  ];
  for (const candidate of candidates) {
    const pkg = await readJsonFile(candidate);
    if (pkg?.version) return pkg.version;
  }
  return 'unknown';
}

async function buildFleetStatusExport(projectRoot, options = {}) {
  const workspace = await buildWorkspaceStatus(projectRoot);
  const activityLog = await collectActivityLog(projectRoot, options.activityHours ?? 24);
  const activeOperations = await collectActiveOperations(projectRoot);

  return {
    schema: 'aiwg.fleet.status.v1',
    generated_at: new Date().toISOString(),
    machine: {
      fleet_id: options.fleetId || process.env.AIWG_FLEET_ID || os.hostname(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch
    },
    aiwg: {
      version: await readAiwgVersion(),
      workspace_path: workspace.workspace.path
    },
    workspace,
    frameworks: workspace.frameworks,
    provider_deployments: workspace.providerDeployments,
    activity_log: activityLog,
    active_operations: activeOperations,
    health: {
      overall: workspace.health.overall,
      flags: workspace.health.issues.map(issue => ({
        severity: issue.severity,
        message: issue.message,
        action: issue.action || null
      }))
    },
    security: {
      bind_default: '127.0.0.1',
      contains_secrets: false,
      transport: 'pull'
    }
  };
}

function writeExportPayload(payload, format) {
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
  } else if (format === 'ndjson') {
    console.log(JSON.stringify(payload));
  } else {
    throw new Error(`Unsupported export format: ${format}. Expected json or ndjson.`);
  }
}

async function startStatusServer(options) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !['/', '/status', '/status.json'].includes(req.url || '/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    try {
      const payload = await buildFleetStatusExport(options.projectRoot, options);
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error('[workspace-status] status request failed', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'status_unavailable', message: 'Workspace status is unavailable.' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.bind, resolve);
  });
  return server;
}

// ===========================
// Main Status Flow
// ===========================

/**
 * Main status command
 */
async function workspaceStatus(args) {
  try {
    // Parse arguments
    const options = parseArgs(args);

    if (options.help) {
      displayHelp();
      return;
    }

    if (options.exportFormat && !['json', 'ndjson'].includes(options.exportFormat)) {
      throw new Error(`Unsupported export format: ${options.exportFormat}. Expected json or ndjson.`);
    }

    if (options.serve) {
      const server = await startStatusServer(options);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      console.log(`AIWG fleet status server listening on http://${options.bind}:${port}/status`);
      return server;
    }

    if (options.exportFormat) {
      const payload = await buildFleetStatusExport(options.projectRoot, options);
      writeExportPayload(payload, options.exportFormat);
      return;
    }

    if (options.probe) {
      const probe = await buildVerificationProbe(options.projectRoot);
      console.log(JSON.stringify(probe, null, 2));
      return;
    }

    const result = await buildWorkspaceStatus(options.projectRoot);

    if (!result.workspace.exists) {
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('\nAIWG - Workspace Status');
        console.log('='.repeat(60));
        console.log('');
        console.log('No .aiwg/ workspace found in this project.');
        for (const warning of result.nativeSandboxWarnings) console.log(`Warning: ${warning.message}`);
        console.log('');
        console.log('To create a workspace:');
        console.log('  aiwg use sdlc        # Install SDLC framework');
        console.log('  aiwg use marketing   # Install Marketing framework');
        console.log('  aiwg use all         # Install all frameworks');
      }
      return;
    }

    // Output results
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Text output
    for (const warning of result.nativeSandboxWarnings) console.log(`Warning: ${warning.message}`);
    console.log('\nAIWG - Workspace Status');
    console.log('='.repeat(60));
    console.log('');

    for (const rule of result.rule_pins.rules) console.log(`${rule.name}: pinned kernel (canonical ${rule.canonical_activation})`);
    for (const warning of result.rule_pins.warnings) console.log(warning);

    for (const line of formatDecisionOffloadReport(result.decisionOffload)) console.log(line);
    console.log('');

    // Workspace info
    console.log('Workspace:');
    console.log(`  Path: ${result.workspace.path}`);
    console.log(`  Structure: ${result.workspace.isFrameworkScoped ? 'Framework-scoped' : 'Legacy'}`);
    console.log('');

    // Migration status
    console.log('Migration:');
    switch (result.migration.status) {
      case 'completed':
        console.log('  Status: ✅ Completed');
        break;
      case 'pending':
        console.log('  Status: ⚠️  Pending (legacy structure)');
        console.log('  Action: Run "aiwg -migrate-workspace" to migrate');
        break;
      case 'partial':
        console.log('  Status: ⚠️  Partial (mixed structure)');
        console.log('  Action: Run "aiwg -migrate-workspace" to complete');
        break;
      default:
        console.log('  Status: ❓ Unknown');
    }
    if (result.migration.backupsAvailable > 0) {
      console.log(`  Backups: ${result.migration.backupsAvailable} available`);
    }
    console.log('');

    // Frameworks
    console.log('Installed Frameworks (registry):');
    if (result.frameworks.length === 0) {
      console.log('  (none)');
      console.log('');
      console.log('  To install frameworks:');
      console.log('    aiwg use sdlc');
      console.log('    aiwg use marketing');
    } else {
      for (const framework of result.frameworks) {
        const emoji = statusEmoji(framework.health);
        console.log(`  ${emoji} ${framework.id}`);
        if (options.verbose) {
          console.log(`     Type: ${framework.type}`);
          console.log(`     Version: ${framework.version}`);
          console.log(`     Health: ${framework.health}`);
          console.log(`     Installed: ${framework.installDate}`);
        }
      }
    }
    console.log('');

    // Provider deployment summary
    console.log('Provider Deployments:');
    if (result.providerDeployments.length === 0) {
      console.log('  (none detected)');
    } else {
      for (const deployment of result.providerDeployments) {
        const counts = Object.entries(deployment.counts)
          .map(([kind, count]) => `${kind}: ${count}`)
          .join('   ');
        console.log(`  ${deployment.name.padEnd(16)} ${deployment.path.padEnd(12)} ${counts || '(no artifacts counted)'}`);
      }
    }
    console.log('');

    // Project-local bundle summary
    console.log('Project-local Bundles:');
    if (result.projectLocalBundles.length === 0) {
      console.log('  (none detected)');
    } else {
      for (const group of result.projectLocalBundles) {
        console.log(`  ${group.type.padEnd(12)} ${group.count} (${group.names.join(', ')})`);
      }
    }
    console.log('');

    // Health summary
    console.log('Health:');
    console.log(`  Overall: ${statusEmoji(result.health.overall)} ${result.health.overall}`);
    if (result.health.issues.length > 0) {
      console.log('  Issues:');
      for (const issue of result.health.issues) {
        console.log(`    ${statusEmoji(issue.severity)} ${issue.message}`);
        if (issue.action) {
          console.log(`      → ${issue.action}`);
        }
      }
    }
    console.log('');

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (error.stack && process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ===========================
// CLI Entry Point
// ===========================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  await workspaceStatus(args);
}

export { workspaceStatus };
export { buildFleetStatusExport, buildVerificationProbe, buildWorkspaceStatus, startStatusServer };
