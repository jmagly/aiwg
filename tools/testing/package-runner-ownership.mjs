// Reconcile nested package test scripts and declared source lanes with CI calls.
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { commands, unprefixed, workflowRunSteps } from './workflow-commands.mjs';
import { runsOnMain } from './check-script-lanes.mjs';

export const nestedRoots = ['packages', 'apps', 'vscode-extension', 'extensions'];
export const discoveryIgnore = ['**/node_modules/**', '**/dist/**', '**/test-output/**',
  '**/coverage/**', '**/.vscode-test/**', 'test/fixtures/**',
  'agentic/code/frameworks/*/test/fixtures/**', 'agentic/code/addons/*/test/fixtures/**',
  'agentic/code/addons/*/templates/**'];

export function inspectPackageRunners(root, declarations, optIns, unavailable) {
  const errors = [];
  const manifests = globSync([...nestedRoots.map(dir => `${dir}/**/package.json`),
    'agentic/code/{addons,extensions}/*/**/package.json', 'package.json'],
  { cwd: root, ignore: discoveryIgnore }).sort();
  const packages = new Map(manifests.map(file => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const dir = path.posix.dirname(file);
    return [dir, { name: pkg.name ?? dir, scripts: pkg.scripts ?? {} }];
  }));
  const called = new Set();
  const pending = [];
  for (const file of globSync(['.gitea/workflows/*.{yml,yaml}', '.github/workflows/*.{yml,yaml}'], { cwd: root }).sort()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file !== '.gitea/workflows/ci.yml' && !runsOnMain(source)) continue;
    for (const step of workflowRunSteps(source)) {
      pending.push({ run: step.run, cwd: step['working-directory'] ?? '.' });
    }
  }
  // Resolve literal npm invocations in their actual package directory. A parent
  // alias may call another package recursively; text matching loses that cwd.
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    let cwd = path.posix.normalize(item.cwd);
    for (const raw of commands(item.run)) {
      let words = unprefixed(raw);
      if (words[0] === 'cd' && words[1]) {
        cwd = path.posix.join(cwd, words[1]);
        continue;
      }
      const npm = words.indexOf('npm');
      if (npm < 0) continue;
      // Only shell commands and known wrappers can invoke npm, never echo or
      // arbitrary command arguments containing an illustrative npm string.
      if (npm > 0 && !['if', 'then', 'do', 'timeout', 'nice'].includes(words[0])
        && !(words[0] === 'node' && words[npm - 1] === '--')) continue;
      words = words.slice(npm + 1);
      let dir = cwd;
      const args = [];
      for (let i = 0; i < words.length; i++) {
        const option = words[i];
        if (['--prefix', '-C', '--workspace', '-w'].includes(option) || /^(--prefix|--workspace|-w)=/.test(option)) {
          const [flag, inline] = option.split('=');
          const value = inline ?? words[++i];
          if (!value) continue;
          if (flag === '--prefix' || flag === '-C') dir = path.posix.join(cwd, value);
          else dir = [...packages].find(([, pkg]) => pkg.name === value)?.[0] ?? path.posix.join(cwd, value);
        } else args.push(option);
      }
      const script = ['run', 'run-script'].includes(args[0]) ? args[1] : args[0] === 'test' ? 'test' : undefined;
      if (!script || !packages.has(dir)) continue;
      const key = `${dir}#${script}`;
      if (called.has(key)) continue;
      called.add(key);
      const pkg = packages.get(dir);
      if (!Object.hasOwn(pkg.scripts, script)) {
        if (dir !== '.') errors.push(`Nested CI references missing npm script: ${dir} ${script}`);
        continue;
      }
      for (const name of [`pre${script}`, script, `post${script}`]) {
        if (typeof pkg.scripts[name] === 'string') pending.push({ run: pkg.scripts[name], cwd: dir });
      }
    }
  }
  const lanes = [];
  const ids = new Set();
  for (const entry of declarations) {
    const { id, runner, package: dir, script, files } = entry;
    if (!id || !runner || !dir || !script || !Array.isArray(files) || !files.length) {
      errors.push(`Invalid package runner lane: ${JSON.stringify(entry)}`);
      continue;
    }
    if (ids.has(id)) errors.push(`Duplicate package runner lane: ${id}`);
    ids.add(id);
    if (!Object.hasOwn(packages.get(dir)?.scripts ?? {}, script)) errors.push(`Package runner lane references missing script: ${id} (${dir} ${script})`);
    const reachable = called.has(`${dir}#${script}`);
    lanes.push({ id, runner, files: new Set(globSync(files, { cwd: path.join(root, dir),
      ignore: [...discoveryIgnore, ...(entry.exclude ?? [])], nodir: true }).map(file => path.posix.join(dir, file))),
    live: !reachable, reachable, package: dir, script });
  }
  const packageByName = new Map([...packages].filter(([dir]) => dir !== '.').map(([dir, pkg]) => [pkg.name, { dir, ...pkg }]));
  for (const [dir, pkg] of packages) {
    if (dir === '.') continue;
    for (const script of Object.keys(pkg.scripts)) {
      if (script !== 'test' && !script.startsWith('test:')) continue;
      const optedIn = optIns.some(entry => entry?.package === pkg.name && entry?.script === script);
      const reasonedLane = lanes.some(lane => lane.package === dir && lane.script === script && hasReason(unavailable[lane.id]));
      if (!called.has(`${dir}#${script}`) && !optedIn && !reasonedLane) {
        errors.push(`Workspace package test has no invoking CI job: ${pkg.name} ${script}`);
      }
    }
  }
  for (const entry of optIns) {
    if (!entry?.package || !entry?.script) errors.push(`Opt-in package test entry is missing package or script: ${JSON.stringify(entry)}`);
    else if (!hasReason(entry.reason)) errors.push(`Opt-in package test has no reason: ${entry.package} ${entry.script}`);
    else if (!packageByName.has(entry.package)) errors.push(`Opt-in package test references unknown package: ${entry.package} ${entry.script}`);
    else if (!Object.hasOwn(packageByName.get(entry.package).scripts, entry.script)) errors.push(`Opt-in package test references missing script: ${entry.package} ${entry.script}`);
    else if (called.has(`${packageByName.get(entry.package).dir}#${entry.script}`)) errors.push(`Opt-in package test is owned by CI; remove it: ${entry.package} ${entry.script}`);
  }
  return { lanes, errors };
}

export function hasReason(value) {
  return typeof value === 'string' && Boolean(value.trim());
}
