/** Refresh the independent disabled-recovery reference from a reviewed base. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { amendWorkerSelectionShape } from './worker-selection-compat.mjs';

// Original method: git show <base>:<source>, prepend a pin header, and
// relocate imports. Keep this graph independent of installation ownership
// and default input loading in the recovery implementation under test.
const PINNED_BASE = '8c812250d6e8e139eb52f798b92934bab9350021';
const sources = {
  "agentic/code/providers/model-capabilities.v1.json": "agentic/code/providers/model-capabilities.v1.json",
  "agentic/code/providers/model-catalog.v1.json": "agentic/code/providers/model-catalog.v1.json",
  "claude-adapter.mjs": "tools/ralph-external/lib/claude-adapter.mjs",
  "codex-adapter.mjs": "tools/ralph-external/lib/codex-adapter.mjs",
  "deepseek-harness-adapter.mjs": "tools/ralph-external/lib/deepseek-harness-adapter.mjs",
  "factory-adapter.mjs": "tools/ralph-external/lib/factory-adapter.mjs",
  "muse-adapter.mjs": "tools/ralph-external/lib/muse-adapter.mjs",
  "omp-adapter.mjs": "tools/ralph-external/lib/omp-adapter.mjs",
  "opencode-adapter.mjs": "tools/ralph-external/lib/opencode-adapter.mjs",
  "pi-adapter.mjs": "tools/ralph-external/lib/pi-adapter.mjs",
  "provider-adapter.mjs": "tools/ralph-external/lib/provider-adapter.mjs",
  "schemas/models/model-catalog.v1.schema.json": "schemas/models/model-catalog.v1.schema.json",
  "schemas/models/provider-model-capabilities.v1.schema.json": "schemas/models/provider-model-capabilities.v1.schema.json",
  "session-launcher.mjs": "tools/ralph-external/session-launcher.mjs",
  "src/artifacts/citation-parser.ts": "src/artifacts/citation-parser.ts",
  "src/artifacts/index-builder.ts": "src/artifacts/index-builder.ts",
  "src/artifacts/index-files.ts": "src/artifacts/index-files.ts",
  "src/cli/handlers/models.ts": "src/cli/handlers/models.ts",
  "src/cli/provider-resolution.ts": "src/cli/provider-resolution.ts",
  "src/config/aiwg-config.ts": "src/config/aiwg-config.ts",
  "src/mcp/registry.ts": "src/mcp/registry.ts",
  "src/models/config-loader.ts": "src/models/config-loader.ts",
  "src/models/grok-build-models.ts": "src/models/grok-build-models.ts",
  "src/models/model-discovery.ts": "src/models/model-discovery.ts",
  "src/models/provider-models.ts": "src/models/provider-models.ts",
  "src/models/provider-policy.ts": "src/models/provider-policy.ts",
  "src/models/resolver.ts": "src/models/resolver.ts",
  "src/models/worker-dispatch-offer.ts": "src/models/worker-dispatch-offer.ts",
  "src/providers/provider-inventory.ts": "src/providers/provider-inventory.ts",
  "src/serve/worker-invocation.ts": "src/serve/worker-invocation.ts",
  "src/smiths/context-pipeline/aiwg-md.ts": "src/smiths/context-pipeline/aiwg-md.ts",
  "src/smiths/context-pipeline/external-links-section.ts": "src/smiths/context-pipeline/external-links-section.ts",
  "src/smiths/context-pipeline/finalization.ts": "src/smiths/context-pipeline/finalization.ts",
  "src/smiths/context-pipeline/parallelism-section.ts": "src/smiths/context-pipeline/parallelism-section.ts",
  "src/smiths/context-pipeline/workspace-context.ts": "src/smiths/context-pipeline/workspace-context.ts",
  "src/tracker/capability-protocol.ts": "src/tracker/capability-protocol.ts",
  "src/tracker/project-inputs.ts": "src/tracker/project-inputs.ts",
  "vscode-extension/schemas/aiwg.config.v1.json": "vscode-extension/schemas/aiwg.config.v1.json",
  "worker-installation.mjs": "src/models/worker-installation.mjs",
  "worker-invoke.mjs": "src/mcp/tools/worker-invoke.mjs",
  "worker-shell-control.mjs": "src/mcp/tools/worker-shell-control.mjs",
  "worker-stdin-runtime.mjs": "src/mcp/tools/worker-stdin-runtime.mjs",
  "worker-isolation.mjs": "tools/ralph-external/lib/worker-isolation.mjs"
};
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixtureDir, '../../..');
const check = process.argv.includes('--check');
const requested = process.argv.find(arg => arg.startsWith('--ref='))?.slice(6) ?? PINNED_BASE;
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}
const base = git('rev-parse', '--verify', `${requested}^{commit}`).trim();
const tree = new Set(git('ls-tree', '-r', '--name-only', base).trim().split('\n'));
const destinations = new Map(Object.entries(sources).map(([dest, source]) => [source, dest]));
function sourcePath(filename) {
  return !tree.has(filename) && filename.endsWith('.js') && tree.has(filename.slice(0, -3) + '.ts')
    ? filename.slice(0, -3) + '.ts' : filename;
}
function route(source, dest, specifier) {
  const target = sourcePath(path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)));
  const resolved = destinations.has(target) ? path.join(fixtureDir, destinations.get(target)) : path.join(root, target);
  const relative = path.relative(path.dirname(path.join(fixtureDir, dest)), resolved).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}
function relocate(body, source, dest) {
  // Preserve the existing #4125 refusal-text amendment when refreshing the baseline.
  if (source === 'src/serve/worker-invocation.ts') body = body.replace(
    "    throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Saved invocation differs from current qualified plan; resolve again');",
    "    // Kept in step with src/serve/worker-invocation.ts (#4125) so the equivalence tests compare\n"
      + "    // the same refusal text.\n"
      + "    throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Saved invocation differs from current qualified plan; resolve again'\n"
      + "      + ' from the conductor project directory you launch from (a plan resolved elsewhere, such as in the worker tree, never matches)');",
  );
  // Static imports/exports, dynamic imports, type imports, and URL-bound files.
  body = body.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)(['"])(\.[^'"\n]+)\2/g,
    (match, prefix, quote, specifier) => `${prefix}${quote}${route(source, dest, specifier)}${quote}`);
  // _resolve-impl paths are relative to src rather than the importing file.
  body = body.replace(/importImpl\((?:import\.meta\.url,\s*)?(['"])([^'"\n]+)\1\)/g, (match, quote, specifier) => {
    const target = sourcePath(`src/${specifier}`);
    const frozen = destinations.get(target);
    if (!frozen) return match;
    const relative = path.relative(path.dirname(path.join(fixtureDir, dest)), path.join(fixtureDir, frozen)).split(path.sep).join('/');
    return `import('${relative.startsWith('.') ? relative : `./${relative}`}')`;
  });
  if (source === 'src/mcp/tools/worker-invoke.mjs') {
    const signature = 'async function loadRalphExternal(relativeFromToolsRoot) {';
    if (!body.includes(signature)) throw new Error('Review changed Ralph import routing before refreshing');
    const siblings = Object.fromEntries(Object.entries(sources)
      .filter(([, file]) => file.startsWith('tools/ralph-external/'))
      .map(([file, original]) => [original.slice('tools/ralph-external/'.length), file]));
    body = body.replace(signature, `${signature}\n  const siblings = ${JSON.stringify(siblings)};\n  if (Object.hasOwn(siblings, relativeFromToolsRoot)) {\n    return import(new URL(siblings[relativeFromToolsRoot], import.meta.url).href);\n  }`);
  }
  return body;
}
let mismatches = 0;
for (const [dest, source] of Object.entries(sources)) {
  const original = git('show', `${base}:${source}`);
  const output = dest.endsWith('.json') ? original : `/**\n * FROZEN REFERENCE FIXTURE -- NOT PRODUCTION CODE.\n * Source: ${source} at ${base}.\n * Only import routing and this pin header differ from the baseline body.\n * Refresh with: node test/fixtures/ralph-recovery-baseline/refresh.mjs --ref=${base}\n * Installation ownership and default input loading stay in this fixture graph.\n * Other dependencies use repository source. Never import from production.\n */\n\n${relocate(original, source, dest)}`;
  const filename = path.join(fixtureDir, dest);
  const compatible = dest === 'src/models/provider-policy.ts' ? amendWorkerSelectionShape(output) : output;
  if (check) {
    if (readFileSync(filename, 'utf8') !== compatible) {
      process.stderr.write(`Baseline fixture differs: ${dest}\n`);
      mismatches += 1;
    }
  } else writeFileSync(filename, compatible);
}
if (mismatches) process.exitCode = 1;
else process.stdout.write(`${check ? 'Verified' : 'Refreshed'} ${Object.keys(sources).length} baseline files from ${base}\n`);
