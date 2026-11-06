#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackagedCodexRenderer } from '../agents/providers/packaged-codex-agents.mjs';

export const AGENT_DEF_CEILING_BYTES = 16 * 1024;
export const STEWARD_AGENT_TARGET_BYTES = 12 * 1024;
export const PACKAGED_CODEX_AGENT_TARGET_BYTES = 12 * 1024;

export const DEPLOYED_AGENT_DIRS = [
  '.claude/agents',
  '.codex/agents',
  '.cursor/agents',
  '.factory/droids',
  '.github/agents',
  '.opencode/agent',
  '.warp/agents',
  '.windsurf/agents',
];

export const AGENT_DEF_SIZE_ALLOWLIST = {};

export const STEWARD_AGENT_TARGET_PATHS = [
  'agentic/code/addons/aiwg-utils/agents/aiwg-steward.md',
  'agentic/code/plugins/utils/agents/aiwg-steward.md',
  'agentic/code/agents/personas/aiwg-steward.md',
  '.claude/agents/aiwg-steward.md',
  '.codex/agents/aiwg-steward.md',
  '.github/agents/aiwg-steward.agent.md',
  '.github/agents/aiwg-steward.yaml',
];

export const PACKAGED_CODEX_AGENT_TARGET_PATHS = [
  'agentic/code/frameworks/forensics-complete/agents/log-analyst.md',
  'agentic/code/frameworks/research-complete/agents/quality-agent.md',
  'agentic/code/frameworks/sdlc-complete/agents/ai-ml-engineer.md',
];

const PACKAGED_AGENT_ROOTS = [
  ['agentic/code/frameworks', false],
  ['agentic/code/addons', false],
  ['agentic/code/plugins', false],
  ['agentic/code/agents', true],
];

const AGENT_FILE_RE = /\.(?:agent\.md|soul\.md|md|toml)$/;
const PACKAGED_AGENT_EXCLUDES = new Set([
  'README.md',
  'manifest.md',
  'agent-template.md',
  'openai-compat.md',
  'factory-compat.md',
  'windsurf-compat.md',
  'DEVELOPMENT_GUIDE.md',
]);

export function agentIdFromFilename(filename) {
  return filename
    .replace(/\.agent\.md$/, '')
    .replace(/\.soul\.md$/, '')
    .replace(/\.toml$/, '')
    .replace(/\.md$/, '');
}

async function maybeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function listAgentFiles(rootDir, relDir) {
  const dir = path.join(rootDir, relDir);
  const stat = await maybeStat(dir);
  if (!stat?.isDirectory()) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && AGENT_FILE_RE.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

async function listPackagedAgentSources(rootDir, relDir, allMarkdownFiles) {
  const dir = path.join(rootDir, relDir);
  const stat = await maybeStat(dir);
  if (!stat?.isDirectory()) return [];

  if (!allMarkdownFiles) {
    const files = [];
    const bundles = await fs.readdir(dir, { withFileTypes: true });
    for (const bundle of bundles) {
      if (!bundle.isDirectory()) continue;
      const agentsDir = path.join(dir, bundle.name, 'agents');
      const agentsStat = await maybeStat(agentsDir);
      if (!agentsStat?.isDirectory()) continue;
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isFile()
          && entry.name.endsWith('.md')
          && !entry.name.endsWith('.soul.md')
          && !PACKAGED_AGENT_EXCLUDES.has(entry.name)
        ) {
          files.push(path.join(agentsDir, entry.name));
        }
      }
    }
    return files;
  }

  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listPackagedAgentSources(
        rootDir,
        path.relative(rootDir, absolute),
        allMarkdownFiles,
      ));
      continue;
    }
    if (
      !entry.isFile()
      || !entry.name.endsWith('.md')
      || entry.name.endsWith('.soul.md')
      || PACKAGED_AGENT_EXCLUDES.has(entry.name)
    ) continue;
    files.push(absolute);
  }
  return files;
}

export async function scanPackagedCodexAgentDefSizes(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const ceilingBytes = options.ceilingBytes ?? AGENT_DEF_CEILING_BYTES;
  const targetBytes = options.targetBytes ?? PACKAGED_CODEX_AGENT_TARGET_BYTES;
  const targetPaths = new Set(options.targetPaths ?? PACKAGED_CODEX_AGENT_TARGET_PATHS);
  const sourceRoots = options.sourceRoots ?? PACKAGED_AGENT_ROOTS;
  const scanned = [];
  const violations = [];
  const renderFailures = [];
  const targetScanned = [];
  const targetViolations = [];

  const render = await createPackagedCodexRenderer(rootDir);
  for (const [relDir, allMarkdownFiles] of sourceRoots) {
    const files = await listPackagedAgentSources(rootDir, relDir, allMarkdownFiles);
    for (const filePath of files) {
      const relPath = path.relative(rootDir, filePath);
      try {
        const source = await fs.readFile(filePath, 'utf8');
        const rendered = render(filePath, source);
        const record = {
          agentId: agentIdFromFilename(path.basename(filePath)),
          path: relPath,
          renderedPath: relPath.replace(/\.md$/, '.toml'),
          size: Buffer.byteLength(rendered),
        };
        scanned.push(record);
        if (record.size > ceilingBytes) violations.push(record);
        if (targetPaths.has(relPath)) {
          targetScanned.push(record);
          if (record.size > targetBytes) targetViolations.push(record);
        }
      } catch (error) {
        renderFailures.push({
          path: relPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ceilingBytes,
    targetBytes,
    scanned,
    violations,
    renderFailures,
    targetScanned,
    targetViolations,
  };
}

export async function scanDeployedAgentDefSizes(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const ceilingBytes = options.ceilingBytes ?? AGENT_DEF_CEILING_BYTES;
  const stewardTargetBytes = options.stewardTargetBytes ?? STEWARD_AGENT_TARGET_BYTES;
  const stewardTargetPaths = options.stewardTargetPaths ?? STEWARD_AGENT_TARGET_PATHS;
  const deployedAgentDirs = options.deployedAgentDirs ?? DEPLOYED_AGENT_DIRS;
  const allowlist = options.allowlist ?? AGENT_DEF_SIZE_ALLOWLIST;

  const scanned = [];
  const violations = [];
  const allowedOversized = [];
  const stewardTargetScanned = [];
  const stewardTargetViolations = [];

  for (const relDir of deployedAgentDirs) {
    const files = await listAgentFiles(rootDir, relDir);
    for (const filePath of files) {
      const stat = await maybeStat(filePath);
      if (!stat?.isFile()) continue;
      const relPath = path.relative(rootDir, filePath);
      const filename = path.basename(filePath);
      const agentId = agentIdFromFilename(filename);
      const record = {
        agentId,
        path: relPath,
        size: stat.size,
      };
      scanned.push(record);
      if (stat.size <= ceilingBytes) continue;
      if (allowlist[agentId]) {
        allowedOversized.push({ ...record, rationale: allowlist[agentId] });
      } else {
        violations.push(record);
      }
    }
  }

  for (const relPath of stewardTargetPaths) {
    const filePath = path.join(rootDir, relPath);
    const stat = await maybeStat(filePath);
    if (!stat?.isFile()) continue;
    const record = {
      agentId: 'aiwg-steward',
      path: relPath,
      size: stat.size,
    };
    stewardTargetScanned.push(record);
    if (stat.size > stewardTargetBytes) {
      stewardTargetViolations.push(record);
    }
  }

  return {
    ceilingBytes,
    stewardTargetBytes,
    scanned,
    violations,
    allowedOversized,
    stewardTargetScanned,
    stewardTargetViolations,
  };
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatAgentDefSizeReport(result) {
  const lines = [];
  lines.push(`Scanned ${result.scanned.length} deployed agent definition(s); ceiling ${formatKb(result.ceilingBytes)}.`);
  if (result.allowedOversized.length > 0) {
    lines.push('');
    lines.push('Allowed oversized definitions:');
    for (const item of result.allowedOversized.sort((a, b) => b.size - a.size)) {
      lines.push(`  - ${item.path} (${formatKb(item.size)}) — ${item.rationale}`);
    }
  }
  if (result.violations.length > 0) {
    lines.push('');
    lines.push('Oversized deployed agent definitions:');
    for (const item of result.violations.sort((a, b) => b.size - a.size)) {
      lines.push(`  - ${item.path} (${formatKb(item.size)})`);
    }
    lines.push('');
    lines.push('Externalize worked examples or repeated rule boilerplate to the discoverable examples catalog, then redeploy.');
  }
  if (result.stewardTargetScanned.length > 0) {
    lines.push('');
    lines.push(`Scanned ${result.stewardTargetScanned.length} steward Tier-1 definition(s); target ${formatKb(result.stewardTargetBytes)}.`);
  }
  if (result.stewardTargetViolations.length > 0) {
    lines.push('');
    lines.push('Steward definitions over the Tier-1 target:');
    for (const item of result.stewardTargetViolations.sort((a, b) => b.size - a.size)) {
      lines.push(`  - ${item.path} (${formatKb(item.size)})`);
    }
    lines.push('');
    lines.push('Keep aiwg-steward as a Tier-1 routing core and move detailed tables to steward-quickref or the routing reference catalog.');
  }
  if (result.packagedCodex) {
    const packaged = result.packagedCodex;
    lines.push('');
    lines.push(`Rendered ${packaged.scanned.length} packaged Codex agent definition(s); ceiling ${formatKb(packaged.ceilingBytes)}.`);
    if (packaged.violations.length > 0) {
      lines.push('');
      lines.push('Oversized packaged Codex definitions:');
      for (const item of packaged.violations.sort((a, b) => b.size - a.size)) {
        lines.push(`  - ${item.renderedPath} (${formatKb(item.size)})`);
      }
    }
    if (packaged.renderFailures.length > 0) {
      lines.push('');
      lines.push('Packaged Codex render failures:');
      for (const item of packaged.renderFailures) {
        lines.push(`  - ${item.path}: ${item.error}`);
      }
    }
    if (packaged.targetScanned.length > 0) {
      lines.push('');
      lines.push(`Checked ${packaged.targetScanned.length} regression target(s); headroom target ${formatKb(packaged.targetBytes)}.`);
    }
    if (packaged.targetViolations.length > 0) {
      lines.push('');
      lines.push('Packaged Codex regression targets over the headroom target:');
      for (const item of packaged.targetViolations.sort((a, b) => b.size - a.size)) {
        lines.push(`  - ${item.renderedPath} (${formatKb(item.size)})`);
      }
    }
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let rootDir = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      rootDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      rootDir = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/lint/agent-def-sizes.mjs [--root <repo>]');
      return 0;
    }
  }

  const result = await scanDeployedAgentDefSizes({ rootDir });
  result.packagedCodex = await scanPackagedCodexAgentDefSizes({ rootDir });
  const report = formatAgentDefSizeReport(result);
  if (
    result.violations.length > 0
    || result.stewardTargetViolations.length > 0
    || result.packagedCodex.violations.length > 0
    || result.packagedCodex.renderFailures.length > 0
    || result.packagedCodex.targetViolations.length > 0
  ) {
    console.error(report);
    return 1;
  }
  console.log(report);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
