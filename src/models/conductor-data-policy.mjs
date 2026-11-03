// Refuse local-only reads and direct execution of worker output by the conductor.
import { realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, matchesGlob, basename } from 'node:path';

// Literal project-relative files or directory subtrees; no globs, traversal or rule syntax.
export const LOCAL_ONLY_PATH_PATTERN = '^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9_.@+,-]+(?:/[A-Za-z0-9_.@+,-]+)*$(?![\\s\\S])';
export const validLocalOnlyPath = value => typeof value === 'string' && new RegExp(LOCAL_ONLY_PATH_PATTERN).test(value);

export function collectLocalOnlyPaths(policy, parallelism) {
  const policies = [policy?.dataPolicy, ...Object.values(policy?.dataClasses ?? {}),
    ...Object.values(parallelism?.groupTemplates ?? {}).map(group => group.dataPolicy),
    ...Object.values(parallelism?.groups ?? {}).map(group => group.dataPolicy)];
  const paths = policies.flatMap(data => data?.localOnlyPaths ?? []);
  if (!paths.every(validLocalOnlyPath)) throw new Error('Invalid dataPolicy.localOnlyPaths: expected literal project-relative paths');
  return [...new Set(paths)].sort();
}

// Resolve existing symlink ancestors without opening file contents (also handles absent leaves).
function canonical(file) {
  try { return realpathSync(file); } catch {
    const parent = dirname(file);
    return parent === file ? file : resolve(canonical(parent), relative(parent, file));
  }
}
const contains = (base, file) => relative(base, file) === ''
  || (!relative(base, file).startsWith('..' + sep) && relative(base, file) !== '..' && !isAbsolute(relative(base, file)));

// Retain quoting for glob characters, but never execute shell expansions or substitutions.
const literalPattern = value => value.replace(/[*?\[\]{}()!+@]/g, char => char === ']' ? ']' : `[${char}]`);
function shellCommands(command) {
  const commands = [];
  let words = [], value = '', pattern = '', glob = false, quote = null;
  const word = () => {
    if (value) words.push({ value, pattern, glob });
    value = ''; pattern = ''; glob = false;
  };
  const end = () => { word(); if (words.length) commands.push(words); words = []; };
  const append = (char, active) => {
    value += char;
    pattern += active ? char : literalPattern(char);
    glob ||= active && /[*?[]/.test(char);
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\' && quote !== "'" && index + 1 < command.length
      && (quote !== '"' || /["\\$`\n]/.test(command[index + 1]))) {
      const next = command[++index];
      if (next !== '\n') append(next, false);
    } else if (quote) {
      if (char === quote) quote = null;
      else append(char, false);
    } else if (char === "'" || char === '"') quote = char;
    else if (/[;&|<>()`\n]/.test(char)) end();
    else if (/\s/.test(char)) word();
    else append(char, true);
  }
  end();
  return commands;
}

function globComponents(token, cwd) {
  const values = token.value.split('/'), patterns = token.pattern.split('/');
  const parts = isAbsolute(token.value) ? [] : cwd.split('/').filter(Boolean)
    .map(value => ({ value, pattern: literalPattern(value) }));
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value || value === '.') continue;
    if (value === '..') parts.pop();
    else parts.push({ value, pattern: patterns[index] });
  }
  return parts;
}

function globOverlaps(parts, file, subtree) {
  const names = file.split(sep).filter(Boolean), memo = new Map();
  const match = (index, depth) => {
    const key = `${index}:${depth}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    // A matched ancestor is conservative: readers can subsequently traverse it.
    if (index === parts.length) result = true;
    else if (depth === names.length) result = subtree || parts.slice(index).every(part => part === '**');
    else if (parts[index] === '**') result = match(index + 1, depth)
      || (!names[depth].startsWith('.') && match(index, depth + 1));
    else result = matchesGlob(names[depth], parts[index]) && match(index + 1, depth + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function globReferences(token, cwd, protectedPaths) {
  if (!token.glob) return false;
  const parts = globComponents(token, cwd);
  const firstGlob = parts.findIndex(part => /[*?[]/.test(part.pattern));
  const prefix = firstGlob < 0 ? parts.length : firstGlob;
  const canonicalPrefix = canonical(resolve(sep, ...parts.slice(0, prefix).map(part => part.value)));
  const patterns = [parts.map(part => part.pattern), [
    ...canonicalPrefix.split(sep).filter(Boolean).map(literalPattern),
    ...parts.slice(prefix).map(part => part.pattern),
  ]];
  return protectedPaths.some(file => {
    let subtree = true;
    try { subtree = statSync(file).isDirectory(); } catch { /* Absent declarations still protect future subtrees. */ }
    return patterns.some(pattern => globOverlaps(pattern, file, subtree));
  });
}

// Recognize common recursive readers; option values and search patterns are not path operands.
function recursiveRoots(words) {
  const index = words.findIndex(word => ['rg', 'grep', 'find'].includes(basename(word.value)));
  if (index < 0) return [];
  const name = basename(words[index].value), args = words.slice(index + 1).map(word => word.value);
  if (name === 'grep' && !args.some(arg => /^-[^-]*[rR]/.test(arg)
    || ['--recursive', '--dereference-recursive'].includes(arg))) return [];
  if (name === 'find') {
    const roots = [];
    for (const arg of args) {
      if (['-H', '-L', '-P'].includes(arg) && !roots.length) continue;
      if (/^[-(!]/.test(arg)) break;
      roots.push(arg);
    }
    return roots.length ? roots : ['.'];
  }
  const valueOptions = new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob',
    '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--after-context',
    '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--encoding', '-j', '--threads']);
  let needsPattern = !args.includes('--files'), options = true;
  const roots = [];
  for (let cursor = 0; cursor < args.length; cursor++) {
    const arg = args[cursor];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (/^(?:-[ef].+|--(?:regexp|file)=)/.test(arg)) needsPattern = false;
      if (valueOptions.has(arg)) {
        if (['-e', '--regexp', '-f', '--file'].includes(arg)) needsPattern = false;
        cursor++;
      }
      continue;
    }
    if (needsPattern) needsPattern = false;
    else roots.push(arg);
  }
  return roots.length ? roots : ['.'];
}

// Read Git's existing worktree metadata, never invoke Git or a worker-owned helper.
// Retained worktrees stay untrusted after the worker stops, until integration.
export function conductorWorkerTrees(root) {
  const trees = [resolve(root, '.aiwg/working/worktrees')];
  try {
    let git = resolve(root, '.git');
    if (!statSync(git).isDirectory()) {
      git = resolve(root, readFileSync(git, 'utf8').trim().replace(/^gitdir: /, ''));
    }
    try { git = resolve(git, readFileSync(resolve(git, 'commondir'), 'utf8').trim()); } catch { /* Main checkout. */ }
    for (const entry of readdirSync(resolve(git, 'worktrees'))) {
      try {
        const metadata = resolve(git, 'worktrees', entry);
        const tree = dirname(resolve(metadata, readFileSync(resolve(metadata, 'gitdir'), 'utf8').trim()));
        if (canonical(tree) !== canonical(root)) trees.push(tree);
      } catch { /* A stale entry must not hide other registered workers. */ }
    }
  } catch { /* Projects without Git metadata still protect the standard worker directory. */ }
  return [...new Set(trees)];
}

const workerExecutionDenial = 'AIWG: conductor must not execute or import worker-written code; use aiwg ralph-external --verify-worker instead';
const runtime = /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|npm|npx|pnpm|yarn|bun|deno|vitest|jest|pytest|py\.test|mocha|ava|tap|tsx|ts-node|make|cmake|ctest|cargo|go|ruby|perl|php|java)$/;
const shells = new Set(['sh', 'bash', 'dash', 'zsh']);
const wrappers = new Set(['env', 'nice', 'timeout', 'systemd-run', 'sudo', 'command', 'exec', 'nohup']);
const wrapperValues = new Set(['-n', '--adjustment', '-p', '--property', '-u', '--user', '-g', '--group',
  '-C', '--chdir', '--working-directory', '--unit', '--description', '--slice', '--kill-after', '-k', '-s', '--signal']);

function workerExecution(command, initialCwd, trees, depth = 0) {
  if (depth > 4) return true;
  const protectedTrees = trees.flatMap(tree => [resolve(tree), canonical(resolve(tree))]);
  const copies = [];
  let cwd = initialCwd;
  const untrusted = candidate => {
    const file = resolve(cwd, candidate.replace(/^file:\/\//, ''));
    return [...protectedTrees, ...copies].some(base => contains(base, file) || contains(base, canonical(file)));
  };
  const references = value => (value.match(/[^\s"'`;&|<>()\[\]{},]+/g) ?? [])
    .some(token => untrusted(token.split('=').at(-1)));
  for (const words of shellCommands(command)) {
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? '')) index++;
    let name = basename(words[index]?.value ?? '');
    while (wrappers.has(name)) {
      // Common resource/process wrappers confer no verification authority.
      const wrapper = name;
      index++;
      while (index < words.length) {
        const arg = words[index].value;
        if (arg === '--') { index++; break; }
        if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { index++; continue; }
        if (!arg.startsWith('-')) break;
        const [option, assigned] = arg.split('=');
        const takesValue = wrapperValues.has(option) && !(wrapper === 'systemd-run' && option === '--user');
        const value = assigned ?? (takesValue ? words[index + 1]?.value : undefined);
        if (['-C', '--chdir', '--working-directory'].includes(option) && value) cwd = resolve(cwd, value);
        index += takesValue && assigned === undefined ? 2 : 1;
      }
      if (wrapper === 'timeout') index++; // Duration follows timeout's options.
      name = basename(words[index]?.value ?? '');
    }
    const args = words.slice(index + 1).map(word => word.value);
    if (name === 'cd') {
      const target = args.find(arg => arg !== '--' && arg !== '-P' && arg !== '-L');
      if (target) cwd = resolve(cwd, target);
      continue;
    }
    if (['cp', 'mv', 'install'].includes(name)) {
      const operands = args.filter(arg => !arg.startsWith('-'));
      const destination = operands.at(-1);
      for (const source of operands.slice(0, -1)) if (destination && untrusted(source)) {
        copies.push(resolve(cwd, destination), resolve(cwd, destination, basename(source)));
      }
      continue;
    }
    if (words[index]?.value.includes('/') && untrusted(words[index].value)) return true;
    if (shells.has(name)) {
      const inline = args.findIndex(arg => /^-[^-]*c/.test(arg));
      if (inline >= 0 && args[inline + 1] !== undefined) {
        if (workerExecution(args[inline + 1], cwd, [...protectedTrees, ...copies], depth + 1)) return true;
        continue;
      }
    }
    if ((runtime.test(name) || shells.has(name)) && (untrusted('.') || words.some(word => references(word.value)))) return true;
  }
  return false;
}

export function conductorToolDenial(event, root, paths, workerTrees = conductorWorkerTrees(root)) {
  const input = event.tool_input ?? {};
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : root;
  const protectedPaths = paths.flatMap(file => [resolve(root, file), canonical(resolve(root, file))]);
  const denied = candidate => {
    if (typeof candidate !== 'string' || !candidate) return false;
    const file = resolve(cwd, candidate);
    return protectedPaths.some(base => contains(base, file) || contains(base, canonical(file)));
  };
  if ([input.file_path, input.path].some(denied)) return 'AIWG: local-only task input is unavailable to this conductor';
  if (typeof input.command === 'string') {
    if (workerTrees.length && workerExecution(input.command, cwd, workerTrees)) return workerExecutionDenial;
    // Covers literal/quoted paths, compound commands and common redirections. This is
    // deliberately conservative, not a shell interpreter or a filesystem sandbox.
    const command = input.command;
    const tokens = command.match(/[^\s"'`;&|<>()]+/g) ?? [];
    if (paths.some(file => command.includes(file)) || tokens.some(token => denied(token) || denied(token.split('=').at(-1)))) {
      return 'AIWG: command references a local-only task input';
    }
    const commands = shellCommands(command);
    if (commands.flat().some(token => globReferences(token, cwd, protectedPaths))
      || commands.some(words => recursiveRoots(words).some(candidate => {
        const ancestor = resolve(cwd, candidate);
        return protectedPaths.some(file => contains(ancestor, file) || contains(canonical(ancestor), file));
      }))) return 'AIWG: command may read a local-only task input through a glob or ancestor search';
  }
  return null;
}

export function runConductorDataHook(root, paths, denyWorkerExecution = false) {
  try {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('oversized event');
    const event = JSON.parse(raw);
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string'
      || !event.tool_input || typeof event.tool_input !== 'object') throw new Error('invalid event');
    const reason = conductorToolDenial(event, root, paths, denyWorkerExecution ? conductorWorkerTrees(root) : []);
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }) + '\n');
  } catch {
    process.stderr.write('AIWG local-only guard: refusing malformed tool event\n');
    process.exitCode = 2;
  }
}
