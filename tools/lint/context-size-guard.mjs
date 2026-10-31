#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BRIDGE_CEILING_BYTES = 8 * 1024;

export const DEFAULT_CONTEXT_FILES = [
  'AGENTS.md',
  'WARP.md',
  '.hermes.md',
  '.github/copilot-instructions.md',
];

async function maybeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export async function scanContextBridgeSizes(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const ceilingBytes = options.ceilingBytes ?? DEFAULT_BRIDGE_CEILING_BYTES;
  const files = options.files ?? DEFAULT_CONTEXT_FILES;
  const records = [];
  const violations = [];

  for (const relPath of files) {
    const filePath = path.join(rootDir, relPath);
    const stat = await maybeStat(filePath);
    if (!stat?.isFile()) {
      records.push({ path: relPath, exists: false, size: 0, ceilingBytes });
      continue;
    }
    // Flue consumes full context bytes rather than a bootstrap bridge. Report
    // its explicit payload separately; malformed markers never hide bridge bytes.
    const text = relPath === 'AGENTS.md' ? await fs.readFile(filePath, 'utf8') : '';
    const inline = text.match(/^<!-- AIWG:flue-context:start -->\r?\n# Flue AIWG context \(experimental\)\r?\n[\s\S]*?^<!-- AIWG:flue-context:end -->/m);
    const inlineBytes = inline && text.split('<!-- AIWG:flue-context:start -->').length === 2
      && text.split('<!-- AIWG:flue-context:end -->').length === 2 ? Buffer.byteLength(inline[0]) : 0;
    const record = { path: relPath, exists: true, size: stat.size - inlineBytes, ceilingBytes,
      ...(inlineBytes ? { inlineBytes } : {}) };
    records.push(record);
    if (record.size > ceilingBytes) {
      violations.push(record);
    }
  }

  return { ceilingBytes, records, violations };
}

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatContextBridgeSizeReport(result) {
  const lines = [];
  lines.push(`Bridge-bytes ceiling (per file): ${formatSize(result.ceilingBytes)}.`);
  lines.push('Measures generated bridge files only — not the startup skill listing, not skill bodies.');
  for (const record of result.records) {
    if (!record.exists) {
      lines.push(`  - ${record.path}: missing`);
    } else {
      const status = record.size > result.ceilingBytes ? 'VIOLATION' : 'ok';
      lines.push(`  - ${record.path}: ${formatSize(record.size)} (${status})${record.inlineBytes ? `; inline Flue context: ${formatSize(record.inlineBytes)} (no verified provider ceiling)` : ''}`);
    }
  }
  if (result.violations.length > 0) {
    lines.push('');
    lines.push('Oversized default-loaded bridge file(s) (bridge-bytes budget):');
    for (const record of result.violations) {
      lines.push(`  - ${record.path} (${formatSize(record.size)})`);
    }
    lines.push('');
    lines.push('Move long-form content to Tier 3 and expose it through Tier 2 discover/show pointers (bridge-bytes budget; the startup skill listing and on-demand skill bodies are measured separately).');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let rootDir = process.cwd();
  let ceilingBytes = DEFAULT_BRIDGE_CEILING_BYTES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      rootDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      rootDir = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--ceiling-bytes' && argv[i + 1]) {
      ceilingBytes = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--ceiling-bytes=')) {
      ceilingBytes = Number(arg.slice('--ceiling-bytes='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/lint/context-size-guard.mjs [--root <repo>] [--ceiling-bytes <n>]');
      return 0;
    }
  }

  if (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0) {
    console.error('Invalid --ceiling-bytes value.');
    return 2;
  }

  const result = await scanContextBridgeSizes({ rootDir, ceilingBytes });
  const report = formatContextBridgeSizeReport(result);
  if (result.violations.length > 0) {
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
