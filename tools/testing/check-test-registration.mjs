#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import ts from 'typescript';
import { expandScripts, workflowRunSteps } from './workflow-commands.mjs';
import { inspectScriptLanes } from './check-script-lanes.mjs';
import { discoveryIgnore, hasReason, inspectPackageRunners, nestedRoots } from './package-runner-ownership.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Discover real runner APIs and inline suites without executing source bodies.
function sourceRunner(file, body) {
  if (file.endsWith('.py')) return 'pytest';
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(ts.isImportDeclaration).map(s => s.moduleSpecifier.text);
  const calls = new Set();
  let inline = false;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) calls.add(node.expression.text);
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'vitest'
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) inline = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (inline || imports.includes('vitest')) return 'vitest';
  if (imports.includes('node:test')) return 'node';
  if (imports.some(value => ['mocha', '@vscode/test-electron'].includes(value))
    || (calls.has('suite') && calls.has('test'))) return 'mocha';
  if (imports.includes('@jest/globals')) return 'jest';
  if (imports.includes('@playwright/test')) return 'playwright';
  if (imports.includes('bun:test')) return 'bun';
  // Legacy synchronous Ralph harnesses rethrow assertions as one Node case.
  if (file.startsWith('tools/ralph-external/') && imports.some(v => v === 'assert' || v === 'node:assert/strict')) return 'node-file-harness';
  return 'unknown';
}

// Inspect declarations and owning lanes without executing test source bodies.
export async function inspectTestRegistration(root = repositoryRoot) {
  root = path.resolve(root);
  const { nodeFiles, releaseLaneWorkflows = {}, optInPackageTests = [], scriptLaneExemptions = [],
    packageRunnerLanes = [], unavailableLanes = {}, unavailableTestFiles = {} } = await import(pathToFileURL(path.join(root, 'config/test-lanes.mjs')).href);
  const configs = globSync('config/vitest*.config.js', { cwd: root }).sort();
  const lanes = [];
  for (const config of configs) {
    const { default: value } = await import(pathToFileURL(path.join(root, config)).href);
    lanes.push({ id: config, runner: 'vitest', files: new Set(globSync([...value.test.include, ...(value.test.includeSource ?? [])], { cwd: root, ignore: value.test.exclude ?? [] })), live: config.includes('live') || config.includes('uat-daemon') || config.includes('uat-fleet-sandbox') });
  }
  lanes.push({ id: 'node', runner: 'node', files: new Set(globSync(nodeFiles, { cwd: root })), live: false });
  const packageRunners = inspectPackageRunners(root, packageRunnerLanes, optInPackageTests, unavailableLanes);
  lanes.push(...packageRunners.lanes);
  // Exclude owned input-fixture trees, not unit suites whose SUT topic is fixtures.
  const ignored = discoveryIgnore;
  const nestedSources = [...nestedRoots.map(dir => `${dir}/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}`),
    'agentic/code/extensions/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}'];
  const candidates = new Set(globSync([
    'test/**/*.{test,spec,uat}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/frameworks/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/addons/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    '{src,tools}/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    ...nestedRoots.map(dir => `${dir}/**/*.{test,spec,uat}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}`),
    'agentic/code/extensions/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
  ], { cwd: root, ignore: ignored }));
  // Python fixture tests remain candidates: consuming an import fixture does not
  // establish that CI executes its test bodies. Keep dependency/build exclusions.
  for (const file of globSync('**/{test_*,*_test}.py', { cwd: root, nodir: true,
    ignore: ignored.filter(pattern => !pattern.includes('fixtures')) })) candidates.add(file);
  // Filename discovery alone misses inline suites and unsuffixed runner imports.
  // Generated plugin mirrors remain excluded; nested packages are source owners.
  const runners = new Map();
  for (const file of globSync(['{src,tools}/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/addons/*/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}', ...nestedSources], { cwd: root, ignore: ignored })) {
    const body = fs.readFileSync(path.join(root, file), 'utf8');
    if (!/vitest|node:test|mocha|@vscode\/test-electron|@jest\/globals|@playwright\/test|bun:test|suite\s*\(/.test(body)) continue;
    const runner = sourceRunner(file, body);
    if (runner === 'unknown') continue;
    candidates.add(file);
    runners.set(file, runner);
  }
  const records = [];
  const errors = [...packageRunners.errors];
  // A config file alone is not an enforced lane: expand canonical CI npm scripts
  // and require every offline config to be reachable from that workflow.
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const scriptLanes = inspectScriptLanes(root, scripts, scriptLaneExemptions);
  errors.push(...scriptLanes.errors);
  const ciRun = workflowRunSteps(fs.readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'))
    .map(step => step.run).join('\n');
  const { text: reachable, names: seen } = expandScripts(ciRun, scripts);
  for (const name of seen) if (!scripts[name]) errors.push(`Canonical CI references missing npm script ${name}`);
  const invokedNodePatterns = [...reachable.matchAll(/node --test ([^\n;&]+)/g)].flatMap(match => match[1].trim().split(/\s+/));
  for (const pattern of invokedNodePatterns) {
    if (!nodeFiles.includes(pattern)) errors.push(`Unclassified Node CLI argument/pattern in canonical CI: ${pattern}`);
  }
  const releaseReachable = new Map();
  for (const [config, workflowFile] of Object.entries(releaseLaneWorkflows)) {
    if (!fs.existsSync(path.join(root, workflowFile))) {
      errors.push(`Release lane workflow is missing: ${workflowFile}`);
      releaseReachable.set(config, '');
      continue;
    }
    const run = workflowRunSteps(fs.readFileSync(path.join(root, workflowFile), 'utf8'))
      .map(step => step.run).join('\n');
    const { text: commands, names } = expandScripts(run, scripts);
    for (const name of names) if (!scripts[name]) errors.push(`Release workflow references missing npm script ${name}`);
    releaseReachable.set(config, commands);
  }
  for (const lane of lanes) {
    // An undeclared Node lane is absent, but every configured lane must discover files.
    if (!lane.files.size && (lane.id !== 'node' || nodeFiles.length)) {
      errors.push(`${lane.id}: lane discovers zero files`);
    }
    if (lane.package) {
      if (lane.reachable && Object.hasOwn(unavailableLanes, lane.id)) errors.push(`CI-owned package lane is listed as unavailable; remove it: ${lane.id}`);
      if (!lane.reachable && !hasReason(unavailableLanes[lane.id])) errors.push(`Unavailable lane requires a reason in config/test-lanes.mjs: ${lane.id}`);
    } else if (releaseReachable.has(lane.id)) {
      if (!releaseReachable.get(lane.id).includes(`--config ${lane.id}`)) errors.push(`Release lane is not reachable from its workflow: ${lane.id}`);
    } else if (lane.id === 'node') {
      for (const pattern of nodeFiles) if (!reachable.includes(pattern)) errors.push(`Node ownership pattern is absent from canonical CI: ${pattern}`);
    } else if (!reachable.includes(`--config ${lane.id}`) && !hasReason(unavailableLanes[lane.id])) {
      errors.push(lane.live ? `Unavailable lane requires a reason in config/test-lanes.mjs: ${lane.id}`
        : `Offline lane is not reachable from canonical CI: ${lane.id}`);
    }
  }
  for (const file of [...candidates].sort()) {
    const runner = runners.get(file) ?? sourceRunner(file, fs.readFileSync(path.join(root, file), 'utf8'));
    const owners = lanes.filter(lane => lane.files.has(file));
    if (runner === 'unknown') errors.push(`${file}: unknown test API; declare an explicit owning runner`);
    const unavailableReason = unavailableTestFiles[file];
    if (!owners.length && !hasReason(unavailableReason)) {
      const nested = nestedRoots.some(dir => file.startsWith(`${dir}/`)) || file.startsWith('agentic/code/addons/');
      errors.push(`${file}: unassigned test file${nested ? `; missing ${runner} lane` : ''}`);
    }
    // These two coverage overlays deliberately remeasure default-lane suites.
    const overlays = new Set(['config/vitest.audit-foundations-coverage.config.js',
      'config/vitest.testing-quality-coverage.config.js']);
    const executionOwners = owners.filter(owner => !overlays.has(owner.id));
    if (executionOwners.length > 1 && !owners.some(owner => releaseReachable.has(owner.id))) {
      errors.push(`${file}: test has multiple owning lanes`);
    }
    // Release-only files must have exactly one owner, including coverage overlays.
    if (owners.length > 1 && owners.some(owner => releaseReachable.has(owner.id))) {
      errors.push(`${file}: release test has multiple owning lanes`);
    }
    for (const owner of owners) {
      if (owner.runner !== (runner === 'node-file-harness' ? 'node' : runner)) errors.push(`${file}: ${runner} handed to ${owner.runner} in ${owner.id}`);
    }
    records.push({ file, runner, lanes: owners.map(({ id, live }) => ({ id, live })),
      ...(hasReason(unavailableReason) ? { unavailableReason } : {}) });
  }
  for (const [file, reason] of Object.entries(unavailableTestFiles)) {
    if (!candidates.has(file)) errors.push(`Unavailable test entry references undiscovered file: ${file}`);
    if (!hasReason(reason)) errors.push(`Unavailable test requires a reason: ${file}`);
    if (lanes.some(lane => lane.files.has(file))) errors.push(`Assigned test is listed as unavailable; remove it: ${file}`);
  }
  for (const [id, reason] of Object.entries(unavailableLanes)) {
    const lane = lanes.find(lane => lane.id === id);
    if (!lane) errors.push(`Unavailable entry references unknown lane: ${id}`);
    else if (!hasReason(reason) && !errors.includes(`Unavailable lane requires a reason in config/test-lanes.mjs: ${id}`)) errors.push(`Unavailable lane requires a reason in config/test-lanes.mjs: ${id}`);
  }
  const unavailable = lanes.filter(lane => hasReason(unavailableLanes[lane.id])).map(lane => ({
    id: lane.id, reason: unavailableLanes[lane.id], files: [...lane.files].sort(),
  }));
  if (!records.length) errors.push('No candidate test files found');
  const report = { schemaVersion: 1, scope: 'Root, framework/addon, tools, nested packages/apps and extension sources, including Python test filenames, inline suites and runner entry points. Python tests require an owning lane or an explicit unavailableTestFiles reason. Owned JS/TS input fixtures, addon templates, dependency/build trees and generated plugin mirrors excluded. Package scripts require CI reachability or a reasoned opt-in.', units: 'Source files and imported APIs, not registered or executed cases', totalFiles: records.length, files: records, scriptLanes: scriptLanes.records, unavailableLanes: unavailable, errors };
  return report;
}

export async function runRegistrationGate(root = repositoryRoot) {
  root = path.resolve(root);
  const report = await inspectTestRegistration(root);
  const { errors, totalFiles } = report;
  const output = path.join(root, 'test-results/test-registration.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Runner ownership: ${totalFiles} source files assigned; report ${path.relative(root, output)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runRegistrationGate();
}
