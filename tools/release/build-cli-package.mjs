#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const sourceDir = path.join(repoRoot, 'packages', 'cli');
const defaultOutputDir = path.join(repoRoot, 'dist', 'packages', 'cli');
const CALVER = /^(?:19|20)\d{2}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex === -1) return { outputDir: defaultOutputDir };
  const value = argv[outputIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--output requires a directory');
  return { outputDir: path.resolve(repoRoot, value) };
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function sameRecord(left = {}, right = {}) {
  const entries = (value) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

export async function buildCliPackage({ outputDir = defaultOutputDir } = {}) {
  const core = await readJson(path.join(repoRoot, 'package.json'));
  const cli = await readJson(path.join(sourceDir, 'package.json'));

  if (cli.name !== '@aiwg/cli') throw new Error('packages/cli/package.json must name @aiwg/cli');
  if (!CALVER.test(core.version) || cli.version !== core.version) {
    throw new Error(`@aiwg/cli version ${cli.version ?? '<missing>'} must exactly match AIWG CalVer ${core.version ?? '<missing>'}`);
  }
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (!sameRecord(cli[key], core[key])) {
      throw new Error(`@aiwg/cli ${key} must exactly match the root AIWG runtime set`);
    }
  }

  const required = [
    path.join(repoRoot, 'LICENSE'),
    path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(repoRoot, 'bin', 'aiwg.mjs'),
    path.join(repoRoot, 'dist', 'src', 'cli', 'router.js'),
    path.join(repoRoot, 'dist', 'src', 'api', 'index.js'),
    path.join(repoRoot, 'dist', 'src', 'api', 'index.d.ts'),
    path.join(repoRoot, 'dist', 'src', 'resources', 'index.js'),
    path.join(repoRoot, 'dist', 'src', 'resources', 'index.d.ts'),
    path.join(repoRoot, 'schemas', 'decision', 'DecisionJob.v1.schema.json'),
    path.join(repoRoot, 'schemas', 'dataset', 'dataset-contracts.v1.schema.json'),
    path.join(repoRoot, 'schemas', 'dataset', 'dataset-schema-governance.v1.schema.json'),
    path.join(repoRoot, 'schemas', 'dataset', 'run-ledger.v1.schema.json'),
    path.join(repoRoot, 'agentic', 'code', 'providers', 'capability-matrix.yaml'),
    path.join(repoRoot, 'agentic', 'code', 'providers', 'model-capabilities.v1.json'),
    path.join(repoRoot, 'agentic', 'code', 'providers', 'model-catalog.v1.json'),
    path.join(repoRoot, 'tools', '_resolve-impl.mjs'),
    path.join(repoRoot, 'tools', 'agents', 'deploy-agents.mjs'),
    path.join(repoRoot, 'tools', 'providers', 'antigravity-transport.mjs'),
    path.join(repoRoot, 'tools', 'commands', 'deploy-prompts-codex.mjs'),
    path.join(repoRoot, 'tools', 'plugin', 'package-plugins.mjs'),
    path.join(repoRoot, 'tools', 'skills', 'deploy-skills-codex.mjs'),
  ];
  for (const filename of required) await readFile(filename);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.join(outputDir, 'bin'), { recursive: true });
  await mkdir(path.join(outputDir, 'dist'), { recursive: true });
  await cp(path.join(repoRoot, 'dist', 'src'), path.join(outputDir, 'dist', 'src'), { recursive: true });
  await cp(
    path.join(repoRoot, 'agentic', 'code', 'providers', 'capability-matrix.yaml'),
    path.join(outputDir, 'dist', 'src', 'providers', 'capability-matrix.yaml'),
  );
  for (const filename of ['model-capabilities.v1.json', 'model-catalog.v1.json']) {
    await cp(
      path.join(repoRoot, 'agentic', 'code', 'providers', filename),
      path.join(outputDir, 'dist', 'src', 'models', filename),
    );
  }
  await mkdir(path.join(outputDir, 'agentic', 'code'), { recursive: true });
  await cp(
    path.join(repoRoot, 'agentic', 'code', 'providers'),
    path.join(outputDir, 'agentic', 'code', 'providers'),
    { recursive: true },
  );
  await mkdir(path.join(outputDir, 'schemas'), { recursive: true });
  await cp(
    path.join(repoRoot, 'schemas', 'security'),
    path.join(outputDir, 'schemas', 'security'),
    { recursive: true },
  );
  await cp(
    path.join(repoRoot, 'schemas', 'decision'),
    path.join(outputDir, 'schemas', 'decision'),
    { recursive: true },
  );
  await cp(
    path.join(repoRoot, 'schemas', 'dataset'),
    path.join(outputDir, 'schemas', 'dataset'),
    { recursive: true },
  );
  await mkdir(path.join(outputDir, 'tools', 'agents'), { recursive: true });
  await mkdir(path.join(outputDir, 'tools', 'commands'), { recursive: true });
  await mkdir(path.join(outputDir, 'tools', 'plugin'), { recursive: true });
  await mkdir(path.join(outputDir, 'tools', 'providers'), { recursive: true });
  await mkdir(path.join(outputDir, 'tools', 'skills'), { recursive: true });
  await cp(path.join(repoRoot, 'tools', '_resolve-impl.mjs'), path.join(outputDir, 'tools', '_resolve-impl.mjs'));
  await cp(path.join(repoRoot, 'tools', 'agents', 'deploy-agents.mjs'), path.join(outputDir, 'tools', 'agents', 'deploy-agents.mjs'));
  await cp(
    path.join(repoRoot, 'tools', 'agents', 'providers'),
    path.join(outputDir, 'tools', 'agents', 'providers'),
    { recursive: true },
  );
  await cp(path.join(repoRoot, 'tools', 'commands', 'deploy-prompts-codex.mjs'), path.join(outputDir, 'tools', 'commands', 'deploy-prompts-codex.mjs'));
  await cp(path.join(repoRoot, 'tools', 'plugin', 'package-plugins.mjs'), path.join(outputDir, 'tools', 'plugin', 'package-plugins.mjs'));
  await cp(path.join(repoRoot, 'tools', 'providers', 'antigravity-transport.mjs'), path.join(outputDir, 'tools', 'providers', 'antigravity-transport.mjs'));
  await cp(path.join(repoRoot, 'tools', 'skills', 'deploy-skills-codex.mjs'), path.join(outputDir, 'tools', 'skills', 'deploy-skills-codex.mjs'));
  await cp(path.join(repoRoot, 'bin', 'aiwg.mjs'), path.join(outputDir, 'bin', 'aiwg.mjs'));
  await chmod(path.join(outputDir, 'bin', 'aiwg.mjs'), 0o755);
  await cp(path.join(repoRoot, 'LICENSE'), path.join(outputDir, 'LICENSE'));
  await cp(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(outputDir, 'THIRD_PARTY_NOTICES.md'));
  await cp(path.join(sourceDir, 'README.md'), path.join(outputDir, 'README.md'));
  await writeFile(path.join(outputDir, 'package.json'), `${JSON.stringify(cli, null, 2)}\n`, 'utf8');

  return { outputDir, version: cli.version };
}

async function main() {
  const result = await buildCliPackage(parseArgs(process.argv.slice(2)));
  console.log(`Built @aiwg/cli ${result.version} at ${result.outputDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
