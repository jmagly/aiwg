import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { resolveThreatAssessmentPolicy } from './threat-assessment.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const LIMITS = Object.freeze({ files: 256, fileBytes: 262_144, totalBytes: 2_097_152, nodes: 2_048, depth: 12 });
const FULL_SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /@sha256:[a-f0-9]{64}$/i;
const LOCKS = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'];
const SEVERITY_RANK = { informational: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const safePath = value => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return null;
  const normalized = path.posix.normalize(value);
  return normalized === '..' || normalized.startsWith('../') ? null : normalized.replace(/^\.\//, '');
};
const join = (base, relative) => safePath(path.posix.join(base, relative));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const source = (file, pointer = '') => ({ path: file.path, sha256: file.sha256, pointer });

/** Analyze inert exact-head file text. No filesystem, shell, network, or package-manager access occurs. */
export function inventoryWorkflowExecution(snapshot, options = {}) {
  if (!snapshot || !Array.isArray(snapshot.contents)) throw new Error('An exact-head contents array is required');
  if (typeof snapshot.head !== 'string' || !FULL_SHA.test(snapshot.head)) {
    throw new Error('Snapshot head must be an immutable commit SHA');
  }
  if (snapshot.contents.length > LIMITS.files) throw new Error('Snapshot exceeds file limit');
  if (options.executionBoundary !== undefined && !['read', 'execute'].includes(options.executionBoundary)) {
    throw new Error('executionBoundary must be read or execute');
  }
  if (options.reviewedScriptHashes !== undefined && (!Array.isArray(options.reviewedScriptHashes)
    || !options.reviewedScriptHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)))) {
    throw new Error('reviewedScriptHashes must be SHA-256 digests supplied by the trusted caller');
  }
  const reviewed = new Set(options.reviewedScriptHashes ?? []);
  const files = new Map();
  let totalBytes = 0;
  for (const entry of snapshot.contents) {
    const name = safePath(entry.path);
    if (!name || name !== entry.path || typeof entry.content !== 'string' || files.has(name)) {
      throw new Error(`Invalid or duplicate snapshot path: ${String(entry.path)}`);
    }
    const bytes = Buffer.byteLength(entry.content);
    totalBytes += bytes;
    if (bytes > LIMITS.fileBytes || totalBytes > LIMITS.totalBytes) throw new Error('Snapshot exceeds byte limit');
    const hash = sha256(entry.content);
    if (entry.sha256 && entry.sha256 !== hash) throw new Error(`Hash mismatch: ${name}`);
    if (entry.sourceRevision && entry.sourceRevision !== snapshot.head) {
      throw new Error(`Source revision mismatch: ${name}`);
    }
    files.set(name, { path: name, content: entry.content, sha256: hash });
  }
  const nodes = [];
  const edges = [];
  const findings = [];
  const omissions = [];
  if (snapshot.currentHead && snapshot.currentHead !== snapshot.head) {
    omissions.push({ reason: 'stale-head', source: snapshot.head ?? null, destination: snapshot.currentHead });
  }
  for (const prior of snapshot.omissions ?? []) {
    omissions.push({ reason: 'upstream-snapshot-omission', source: prior.surface ?? null,
      destination: prior.reason ?? 'unavailable evidence' });
  }
  for (const listed of snapshot.collections?.files?.items ?? []) {
    if (listed?.status !== 'removed' && typeof listed?.path === 'string' && !files.has(listed.path)) {
      omissions.push({ reason: 'listed-file-content-unavailable', source: listed.path, destination: listed.path });
    }
  }
  let limited = false;
  function add(kind, from, detail = {}, severity = 'informational') {
    if (nodes.length >= LIMITS.nodes) {
      if (!limited) omissions.push({ reason: 'node-limit', source: from });
      limited = true;
      return null;
    }
    const node = { id: `n${nodes.length + 1}`, kind, source: from, ...detail };
    nodes.push(node);
    if (severity !== 'informational') findings.push({ nodeId: node.id, kind, severity, source: from,
      description: detail.description ?? kind });
    return node;
  }
  function link(parent, child) {
    if (parent && child) edges.push({ from: parent.id, to: child.id });
  }
  function missing(from, destination, reason, parent) {
    const node = add('unresolved', from, { destination, reason, description: `${destination}: ${reason}` }, 'moderate');
    omissions.push({ reason, source: from, destination });
    link(parent, node);
  }
  function image(ref, from, parent) {
    if (typeof ref !== 'string' || !ref.trim()) return missing(from, String(ref), 'dynamic-or-empty-image', parent);
    const immutable = DIGEST.test(ref);
    const node = add('container-image', from, { ref, immutable, description: immutable
      ? `Digest-pinned image ${ref}` : `Mutable image reference ${ref}` }, immutable ? 'low' : 'moderate');
    link(parent, node);
  }
  function parseYaml(file, label) {
    try {
      const document = YAML.parseDocument(file.content, { uniqueKeys: true, maxAliasCount: 0, strict: true });
      if (document.errors.length) throw new Error(document.errors[0].message);
      return document.toJS({ maxAliasCount: 0 });
    } catch {
      missing(source(file), file.path, `unparseable-${label}`);
      return null;
    }
  }
  function packageAt(directory) {
    let current = directory;
    while (true) {
      const candidate = join(current, 'package.json');
      if (files.has(candidate)) return files.get(candidate);
      if (!current || current === '.') return null;
      const parent = path.posix.dirname(current);
      current = parent === '.' ? '' : parent;
    }
  }
  function script(file, name, parent, depth, trail) {
    if (depth > LIMITS.depth || trail.has(`${file.path}#${name}`)) {
      missing(source(file, `scripts.${name}`), `${file.path}#${name}`, 'script-cycle-or-depth-limit', parent);
      return;
    }
    let pkg;
    try { pkg = JSON.parse(file.content); } catch { missing(source(file), file.path, 'invalid-package-json', parent); return; }
    const value = pkg?.scripts?.[name];
    if (typeof value !== 'string') return missing(source(file), `${file.path}#${name}`, 'script-not-found', parent);
    const scriptHash = sha256(value);
    const node = add('package-script', source(file, `scripts.${name}`), { name, command: value,
      commandSha256: scriptHash, reviewed: reviewed.has(scriptHash),
      description: `Package script ${name}${reviewed.has(scriptHash) ? ' (reviewed exact hash)' : ''}` },
    reviewed.has(scriptHash) ? 'low' : 'moderate');
    link(parent, node);
    command(value, source(file, `scripts.${name}`), path.posix.dirname(file.path), node, depth + 1,
      new Set([...trail, `${file.path}#${name}`]));
  }
  function install(manager, file, parent, depth, trail, ignoreScripts = false) {
    const directory = path.posix.dirname(file.path);
    const lock = LOCKS.map(name => join(directory, name)).find(name => files.has(name)) ?? null;
    const node = add('package-install', source(file), { manager, lock: lock ? source(files.get(lock)) : null,
      ignoreScripts, description: `${manager} dependency install; lock presence does not attest lifecycle code` },
    ignoreScripts && lock ? 'low' : 'moderate');
    link(parent, node);
    const pkg = packageAt(directory);
    if (!pkg) return missing(source(file), 'package.json', 'package-manifest-unavailable', node);
    let parsed;
    try { parsed = JSON.parse(pkg.content); } catch { return missing(source(pkg), pkg.path, 'invalid-package-json', node); }
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (!ignoreScripts && typeof parsed.scripts?.[name] === 'string') script(pkg, name, node, depth + 1, trail);
    }
    // The lock is resolution evidence, not evidence that dependency lifecycle
    // scripts are absent or reviewed. This remains explicit even when frozen.
    if (!ignoreScripts) missing(source(file), `${manager} dependency lifecycle`, 'dependency-lifecycle-unreviewed', node);
  }
  function dockerfile(file, parent, depth, trail) {
    if (depth > LIMITS.depth || trail.has(file.path)) return missing(source(file), file.path, 'docker-cycle-or-depth-limit', parent);
    const node = add('dockerfile', source(file), { description: `Dockerfile ${file.path}` });
    link(parent, node);
    const stages = new Set();
    for (const [index, line] of file.content.split(/\r?\n/).entries()) {
      const from = line.match(/^\s*FROM\s+(?:--\S+\s+)*([^\s#]+)(?:\s+AS\s+([\w.-]+))?/i);
      if (from) {
        if (/\$\{|\$[A-Za-z_]/.test(from[1])) missing(source(file, `L${index + 1}`), from[1], 'dynamic-base-image', node);
        else if (stages.has(from[1])) link(node, add('docker-stage', source(file, `L${index + 1}`),
          { ref: from[1], description: `Internal Docker stage ${from[1]}` }, 'low'));
        else if (!/^scratch$/i.test(from[1])) image(from[1], source(file, `L${index + 1}`), node);
        if (from[2]) stages.add(from[2]);
      }
      const run = line.match(/^\s*RUN\s+(.+)/i);
      if (run) command(run[1], source(file, `L${index + 1}`), path.posix.dirname(file.path), node, depth + 1,
        new Set([...trail, file.path]));
    }
  }
  function command(value, from, cwd, parent, depth = 0, trail = new Set()) {
    if (depth > LIMITS.depth) return missing(from, value, 'command-depth-limit', parent);
    if (typeof value !== 'string') return missing(from, String(value), 'dynamic-command', parent);
    const commandHash = sha256(value);
    const commandReviewed = reviewed.has(commandHash);
    const node = add('command', from, { command: value, commandSha256: commandHash,
      reviewed: commandReviewed, description: `Command ${value.slice(0, 120)}` },
    commandReviewed ? 'low' : 'moderate');
    link(parent, node);
    if (/\$\{|\$\(|`/.test(value)) missing(from, value, 'dynamic-shell-expansion', node);
    let activeCwd = cwd;
    for (const part of value.split(/(?:\r?\n|&&|\|\||;)/)) {
      const text = part.trim().replace(/^\s*(?:env\s+)?(?:[A-Za-z_][\w]*=[^\s]+\s+)*/, '');
      const changeDirectory = text.match(/^cd\s+([^\s]+)$/);
      if (changeDirectory) {
        const next = join(activeCwd, changeDirectory[1]);
        if (!next) missing(from, changeDirectory[1], 'unsafe-working-directory', node);
        else activeCwd = next;
        continue;
      }
      const match = text.match(/^(?:(corepack)\s+)?(npm|npx|pnpm|yarn|bun)\s+([^\n]*)/i);
      if (match) {
        const manager = `${match[1] ? 'corepack ' : ''}${match[2]}`.toLowerCase();
        const args = match[3].trim();
        const installMatch = /^(?:install|i|add|ci)\b/i.test(args);
        if (installMatch) {
          const pkg = packageAt(activeCwd);
          if (pkg) install(manager, pkg, node, depth + 1, trail, /(?:^|\s)--ignore-scripts(?:\s|$)/.test(args));
          else missing(from, 'package.json', 'package-manifest-unavailable', node);
        } else {
          const scriptName = args.match(/^(?:(?:run|run-script)\s+)?([\w:-]+)(?:\s|$)/)?.[1];
          if (scriptName && !['exec', 'dlx', 'audit', 'config', 'version', 'help', 'pack'].includes(scriptName)) {
            const pkg = packageAt(activeCwd);
            if (pkg) script(pkg, scriptName, node, depth + 1, trail);
            else missing(from, 'package.json', 'package-manifest-unavailable', node);
          } else if (/^(?:exec|dlx)\b/.test(args) || match[2].toLowerCase() === 'npx') {
            missing(from, args, 'external-package-execution-unresolved', node);
          }
        }
      }
      const docker = text.match(/^docker\s+build\b(.*)$/i);
      if (docker) {
        const tokens = docker[1].trim().split(/\s+/);
        const specified = tokens.findIndex(token => token === '-f' || token === '--file');
        const context = tokens.at(-1) || '.';
        const contextPath = join(activeCwd, context);
        const destination = specified >= 0 ? join(activeCwd, tokens[specified + 1]) : join(contextPath, 'Dockerfile');
        if (!destination || !files.has(destination)) missing(from, destination ?? context, 'dockerfile-unavailable', node);
        else dockerfile(files.get(destination), node, depth + 1, trail);
        const contextNode = add('docker-context', from, { path: contextPath,
          description: `Docker build context ${contextPath}` }, 'moderate');
        link(node, contextNode);
        if (!contextPath || ![...files.keys()].some(name => contextPath === '.' || name === contextPath || name.startsWith(`${contextPath}/`))) {
          missing(from, context, 'docker-context-unavailable', contextNode);
        }
      }
      if (/\bplaywright\s+install\b/.test(text)) {
        const browser = add('browser-download', from, { command: text, description: 'Playwright browser download' }, 'moderate');
        link(node, browser);
      }
      const localRuntime = text.match(/^(?:node|bun|python3?)\s+([^\s;|&]+\.(?:[cm]?js|ts|py))\b/);
      if (localRuntime) {
        const target = join(activeCwd, localRuntime[1]);
        if (!target || !files.has(target)) missing(from, target ?? localRuntime[1], 'local-script-unavailable', node);
        else {
          const entry = files.get(target);
          const entryNode = add('local-script-entrypoint', source(entry), { path: target,
            reviewed: reviewed.has(entry.sha256), description: `Local script ${target}` },
          reviewed.has(entry.sha256) ? 'low' : 'moderate');
          link(node, entryNode);
        }
      }
    }
  }
  function action(ref, from, parent, depth, trail) {
    if (typeof ref !== 'string') return missing(from, String(ref), 'dynamic-action', parent);
    if (ref.startsWith('docker://')) return image(ref.slice(9), from, parent);
    if (ref.startsWith('./')) {
      if (/\$\{|\$\(/.test(ref)) return missing(from, ref, 'dynamic-local-action', parent);
      const local = safePath(ref);
      if (!local) return missing(from, ref, 'unsafe-local-action-path', parent);
      const file = [join(local, 'action.yml'), join(local, 'action.yaml')].find(name => files.has(name));
      const workflow = files.get(local);
      if (!file && workflow && /^\.github\/workflows\/.*\.ya?ml$/.test(local)) return workflowFile(workflow, parent, depth + 1, trail);
      if (!file) return missing(from, ref, 'local-action-unavailable', parent);
      if (depth > LIMITS.depth || trail.has(file)) return missing(from, file, 'action-cycle-or-depth-limit', parent);
      const manifest = parseYaml(files.get(file), 'action');
      const node = add('local-action', source(files.get(file)), { ref, description: `Local action ${ref}` }, 'moderate');
      link(parent, node);
      const nextTrail = new Set([...trail, file]);
      if (manifest?.runs?.using === 'composite') {
        for (const [index, step] of (manifest.runs.steps ?? []).entries()) visitStep(step, files.get(file), `runs.steps.${index}`, node, depth + 1, nextTrail);
      } else if (manifest?.runs?.using?.startsWith('docker')) {
        const dockerRef = manifest.runs.image;
        if (typeof dockerRef === 'string' && dockerRef.startsWith('docker://')) image(dockerRef.slice(9), source(files.get(file), 'runs.image'), node);
        else if (typeof dockerRef === 'string') {
          const target = join(local, dockerRef);
          if (files.has(target)) dockerfile(files.get(target), node, depth + 1, nextTrail);
          else missing(source(files.get(file)), target ?? dockerRef, 'local-dockerfile-unavailable', node);
        }
      } else if (manifest?.runs?.using?.startsWith('node')) {
        const main = join(local, manifest.runs.main ?? '');
        if (!main || !files.has(main)) missing(source(files.get(file)), main ?? String(manifest.runs.main), 'local-action-entrypoint-unavailable', node);
        else link(node, add('local-action-entrypoint', source(files.get(main)), { description: `Local action entrypoint ${main}` }, 'moderate'));
      } else missing(source(files.get(file)), file, 'unsupported-action-runtime', node);
      return;
    }
    const match = ref.match(/^([^\s@]+)@([^\s@]+)$/);
    if (!match) return missing(from, ref, 'unresolved-action-reference', parent);
    const immutable = FULL_SHA.test(match[2]);
    const node = add('remote-action', from, { ref, immutable,
      description: immutable ? `Commit-pinned action ${ref}` : `Mutable action reference ${ref}` }, immutable ? 'low' : 'moderate');
    link(parent, node);
  }
  function visitStep(step, file, pointer, parent, depth, trail, defaultCwd = '') {
    if (!object(step)) return missing(source(file, pointer), String(step), 'invalid-workflow-step', parent);
    if (step.uses !== undefined) action(step.uses, source(file, `${pointer}.uses`), parent, depth, trail);
    if (step.run !== undefined) {
      const cwd = typeof step['working-directory'] === 'string' ? safePath(step['working-directory']) : defaultCwd;
      if (cwd === null) missing(source(file, `${pointer}.working-directory`), String(step['working-directory']), 'unsafe-working-directory', parent);
      command(step.run, source(file, `${pointer}.run`), cwd ?? '', parent, depth, trail);
    }
  }
  function workflowFile(file, parent = null, depth = 0, trail = new Set()) {
    if (depth > LIMITS.depth || trail.has(file.path)) return missing(source(file), file.path, 'workflow-cycle-or-depth-limit', parent);
    const workflow = parseYaml(file, 'workflow');
    if (!object(workflow)) return;
    const node = add('workflow', source(file), { description: `Workflow ${file.path}` });
    link(parent, node);
    const nextTrail = new Set([...trail, file.path]);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (!object(job)) continue;
      const at = `jobs.${jobName}`;
      if (job.uses) action(job.uses, source(file, `${at}.uses`), node, depth + 1, nextTrail);
      if (job.container?.image || typeof job.container === 'string') image(job.container.image ?? job.container, source(file, `${at}.container`), node);
      for (const [name, service] of Object.entries(job.services ?? {})) {
        image(typeof service === 'string' ? service : service?.image, source(file, `${at}.services.${name}`), node);
      }
      const defaultCwd = job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '';
      for (const [index, step] of (job.steps ?? []).entries()) visitStep(step, file, `${at}.steps.${index}`, node, depth + 1, nextTrail, defaultCwd);
    }
  }
  for (const file of files.values()) {
    if (/^\.(?:github|gitea)\/workflows\/[^/]+\.ya?ml$/.test(file.path)) workflowFile(file);
  }
  const boundary = options.executionBoundary ?? 'read';
  const complete = omissions.length === 0;
  const policy = resolveThreatAssessmentPolicy(options.policy, 'pull-request-diff-summary');
  const highest = findings.reduce((severity, finding) => SEVERITY_RANK[finding.severity] > SEVERITY_RANK[severity]
    ? finding.severity : severity, 'informational');
  const thresholds = policy.profile.thresholds;
  const thresholdAction = policy.mode === 'off' ? 'proceed'
    : SEVERITY_RANK[highest] >= SEVERITY_RANK[thresholds.reject] ? 'reject'
      : SEVERITY_RANK[highest] >= SEVERITY_RANK[thresholds.requireAuthorization] ? 'require-authorization'
        : SEVERITY_RANK[highest] >= SEVERITY_RANK[thresholds.flag] ? 'flag' : 'proceed';
  const wouldAction = !complete ? 'require-authorization' : thresholdAction;
  const decidedAction = boundary === 'read' ? 'proceed' : !complete ? 'require-authorization'
    : policy.mode === 'audit' || policy.mode === 'off' ? 'separate-authorization-required'
      : ['reject', 'require-authorization'].includes(thresholdAction) ? thresholdAction
        : 'separate-authorization-required';
  return { schemaVersion: '1', head: snapshot.head ?? null, bounds: LIMITS,
    sourceCount: files.size, nodes, edges, findings, completeness: { complete, omissions },
    policy: { mode: policy.mode, profile: policy.profileName, provenance: policy.provenance },
    decision: { boundary, action: decidedAction, wouldAction,
    reason: boundary === 'read' ? 'inert-read-only-analysis' : complete
      ? 'execution-boundary-review' : 'incomplete-execution-graph' } };
}
