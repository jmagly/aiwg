// Plan inert repository skill trees, exclusions, diagnostics and stable local names.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';
import { collectGitTree, DEFAULT_AGENT_SKILL_IMPORT_LIMITS } from './importer.js';
import { validateAgentSkillContent } from './validator.js';
import type { BundleUpstream } from '../extensions/manifest.js';

export interface BundleImportDiagnostic {
  code: 'collision' | 'script' | 'binary' | 'dangling-reference';
  file: string;
  message: string;
}
export interface RepositoryPlan {
  upstream: BundleUpstream;
  files: Map<string, Buffer>;
  diagnostics: BundleImportDiagnostic[];
}
export function repositoryKey(repo: string): string {
  const slug = path.basename(repo.replace(/\/$/, '').replace(/\.git$/, ''))
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'upstream';
  return `${slug.slice(0, 40)}-${createHash('sha256').update(repo).digest('hex').slice(0, 8)}`;
}
const excluded = (file: string) => file.split('/').some(part =>
  /^(?:tests?|__tests__|tools?|tooling|scripts|node_modules|\.git)$/i.test(part))
  || /\.(?:test|spec)\.[^/]+$/i.test(file);
const licenseFile = (file: string) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file);

function localName(name: string, prefix: string, occupied: Set<string>): string {
  const base = `${prefix}-${name}`.slice(0, 60).replace(/-$/, '');
  let candidate = base;
  let index = 2;
  while (occupied.has(candidate)) candidate = `${base}-${index++}`;
  return candidate;
}

export function planRepository(input: {
  repo: string; ref: string; only?: string; pinned?: BundleUpstream; occupied: Set<string>;
}): RepositoryPlan {
  const materialized = collectGitTree({
    kind: 'git', url: input.repo, revision: input.ref, subpath: '.',
  }, { ...DEFAULT_AGENT_SKILL_IMPORT_LIMITS, maxFiles: 10_000 }, true);
  if (materialized.source.kind !== 'git') throw new Error('Expected pinned Git source');
  const sourceFiles = new Map(materialized.entries.flatMap(entry =>
    entry.kind === 'file' ? [[entry.path, entry.bytes] as const] : []));
  const allNames = [...sourceFiles.keys()].flatMap(file => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? []);
  const names = input.pinned?.skills ?? allNames.filter(name => !input.only
    || minimatch(name, input.only) || minimatch(`skills/${name}`, input.only));
  if (!names.length) throw new Error('No skills/*/SKILL.md trees match the selection');
  const licenses = [...sourceFiles].filter(([file]) => licenseFile(file));
  if (!licenses.length) throw new Error(`No root license file found in ${input.repo}; review licensing before importing`);
  const files = new Map<string, Buffer>();
  const diagnostics: BundleImportDiagnostic[] = [];
  const renames: Record<string, string> = { ...input.pinned?.renames };
  const key = repositoryKey(input.repo);
  const prefix = key.slice(0, key.lastIndexOf('-'));

  for (const name of names.sort()) {
    const skillFile = `skills/${name}/SKILL.md`;
    const content = sourceFiles.get(skillFile)?.toString('utf8');
    if (content === undefined) throw new Error(`Pinned upstream skill is missing: ${skillFile}`);
    const validation = validateAgentSkillContent(content, { profile: 'compatible', file: skillFile, directoryName: name });
    if (!validation.valid) throw new Error(`Invalid ${skillFile}: ${validation.diagnostics.map(d => d.message).join('; ')}`);
    let target = renames[name] ?? name;
    if (input.occupied.has(target)) {
      if (input.pinned) throw new Error(`Saved rename collides with existing skill: ${target}`);
      target = localName(name, prefix, input.occupied);
      renames[name] = target;
      diagnostics.push({ code: 'collision', file: skillFile, message: `${name} collides; proposed local name: ${target}` });
    }
    input.occupied.add(target);
    const selected = [...sourceFiles].filter(([file]) => file.startsWith(`skills/${name}/`));
    for (const [file, bytes] of selected) {
      const tail = file.slice(`skills/${name}/`.length);
      if (/\.(?:[cm]?js|[cm]?ts|py|sh|bash|ps1|rb|pl|exe|dll|so|wasm)$/i.test(file)
        || bytes.subarray(0, 2).toString() === '#!') {
        diagnostics.push({ code: 'script', file, message: `Script or executable content (${excluded(tail) ? 'excluded' : 'copied inertly'})` });
      }
      if (bytes.includes(0)) diagnostics.push({ code: 'binary', file, message: 'Binary content; never executed by import' });
      if (excluded(tail)) continue;
      let output = bytes;
      if (file === skillFile && target !== name) {
        // Change only the frontmatter name; retain comments, body and upstream links verbatim.
        output = Buffer.from(content.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/,
          (_match, start: string, yaml: string, end: string) =>
            start + yaml.replace(/^name\s*:.*$/m, `name: ${target}`) + end));
      }
      files.set(`skills/${target}/${tail}`, output);
    }
    // Local links and code-formatted paths may resolve from the skill or repository root.
    const kept = new Set([...files.keys()].filter(file => file.startsWith(`skills/${target}/`))
      .map(file => `skills/${name}/${file.slice(`skills/${target}/`.length)}`));
    for (const [file, bytes] of selected) {
      if (excluded(file.slice(`skills/${name}/`.length)) || !/\.(?:md|txt)$/i.test(file)) continue;
      const tokens = bytes.toString('utf8').matchAll(/([^\s<>()`"'\[\]]+\/[^\s<>()`"'\[\]]+)/g);
      for (const match of tokens) {
        const ref = match[1].replace(/[#?].*$/, '').replace(/[.,;:]$/, '');
        if (/^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
        const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(file), ref)), ref.replace(/^\.\//, '')];
        if (!candidates.some(candidate => kept.has(candidate))) {
          diagnostics.push({ code: 'dangling-reference', file, message: `${match[1]} is absent from the copied skill tree` });
        }
      }
    }
  }
  for (const [file, bytes] of licenses) files.set(`licenses/${key}/${file}`, bytes);
  return {
    files, diagnostics,
    upstream: {
      repo: input.repo, commit: materialized.source.resolvedRevision,
      license: licenses.some(([, bytes]) => /MIT License|Permission is hereby granted/i.test(bytes.toString('utf8')))
        ? 'MIT' : 'SEE LICENSE FILES',
      skills: names, renames,
    },
  };
}
