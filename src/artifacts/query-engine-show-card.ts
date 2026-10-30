// Render show metadata cards, sections, and companion resources.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerifiedWebRelease } from '../resources/web-release.js';
import { isCorpusBundleInstalled } from './framework-capabilities.js';
import { extractMarkdownLinks, parseFlowDoc, parseFrontmatter } from './index-builder.js';
import { buildRunHint, discoveryIdForEntry, normalizeIndexedPath } from './query-engine-entries.js';
import { type ShowParams } from './query-engine-options.js';
import { RULE_CHECK_OBLIGATION, statsText } from './query-engine-rules.js';
import { emptyRuleStats, type RuleStats } from './relations.js';
import type { MetadataEntry } from './types.js';

/** Sections include their nested headings, stopping at the next peer/ancestor. */
export function showSections(content: string) {
  const body = parseFrontmatter(content).body;
  const headings: Array<{ heading: string; level: number; start: number }> = [];
  let offset = 0;
  let fence = '';
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    } else if (!fence) {
      const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      const setext = i + 1 < lines.length && lines[i + 1].match(/^ {0,3}(=+|-+)\s*$/);
      if (atx) headings.push({ heading: atx[2], level: atx[1].length, start: offset });
      else if (line.trim() && setext) headings.push({ heading: line.trim(), level: setext[1][0] === '=' ? 1 : 2, start: offset });
    }
    offset += line.length;
  }
  return headings.map((heading, i) => {
    const end = headings.slice(i + 1).find(next => next.level <= heading.level)?.start ?? body.length;
    const text = body.slice(heading.start, end);
    return { heading: heading.heading, level: heading.level, bytes: Buffer.byteLength(text),
      lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), text };
  });
}


/** List companion directories and explicitly linked resources within the owning bundle.
 * Resolve paths against that boundary and exclude symlink components. */
export function showResources(filePath: string, source: string, release?: VerifiedWebRelease): Array<{ path: string; bytes: number }> {
  if (release) {
    const base = path.posix.dirname(filePath);
    const linked = new Set(extractMarkdownLinks(source).map(link => path.posix.normalize(path.posix.join(base, link))));
    const boundary = filePath.match(/^(raw\/agentic\/code\/(?:frameworks|addons|extensions)\/[^/]+)\//)?.[1];
    return [...release.descriptors.values()].filter(descriptor => {
      const relative = path.posix.relative(base, descriptor.path);
      const category = /(?:^|\/)(?:templates|scripts|references|resources|assets)\//.test(relative);
      const inside = relative !== '..' && !relative.startsWith('../');
      return (inside && category || linked.has(descriptor.path) && (inside || category))
        && (!boundary || descriptor.path.startsWith(`${boundary}/`));
    }).map(descriptor => ({ path: path.posix.relative(base, descriptor.path), bytes: descriptor.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  const base = path.dirname(filePath);
  const normalizedBase = normalizeIndexedPath(base);
  const boundary = normalizedBase.match(/^(.*\/(?:frameworks|addons|extensions)\/[^/]+)(?:\/|$)/)?.[1]
    ?? normalizedBase.match(/^(.*\/\.aiwg)(?:\/|$)/)?.[1] ?? base;
  const resources = new Map<string, { path: string; bytes: number }>();
  const walk = (relative: string) => {
    const absolute = path.resolve(base, relative);
    const contained = path.relative(boundary, absolute);
    if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) return;
    let cursor = boundary;
    let stat: fs.Stats | undefined;
    try {
      for (const component of contained.split(path.sep)) {
        cursor = path.join(cursor, component);
        stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) return;
      }
    } catch { return; }
    if (stat?.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name));
    } else if (stat?.isFile() && absolute !== filePath) {
      const key = normalizeIndexedPath(path.relative(base, absolute));
      resources.set(key, { path: key, bytes: stat.size });
    }
  };
  for (const directory of ['templates', 'scripts', 'references', 'resources', 'assets']) walk(directory);
  const { data } = parseFrontmatter(source);
  const declared = Array.isArray(data.resources) ? data.resources.filter((value): value is string => typeof value === 'string') : [];
  for (const link of [...extractMarkdownLinks(source), ...declared]) {
    if (path.isAbsolute(link) || /^[a-z]+:/i.test(link)) continue;
    const relative = path.relative(base, path.resolve(base, link));
    // Outside the artifact directory, only declared companion categories qualify.
    if ((relative === '..' || relative.startsWith(`..${path.sep}`)) && !/(?:^|\/)(?:templates|scripts|references|resources|assets)\//.test(normalizeIndexedPath(relative))) continue;
    walk(relative);
  }
  return [...resources.values()].sort((a, b) => a.path.localeCompare(b.path));
}


export async function emitShowCard(
  cwd: string, aiwgRoot: string | null, entry: MetadataEntry, filePath: string, source: string,
  params: ShowParams, bindings: { fields: Record<string, unknown>; text: string },
  extra: Record<string, unknown>, local: boolean, release?: VerifiedWebRelease,
): Promise<void> {
  const { data } = parseFrontmatter(source);
  const flow = entry.type === 'flow' || entry.type === 'runbook' ? parseFlowDoc(source, entry.path) : null;
  const sections = showSections(source);
  const selected = (params.sections ?? []).map(heading => {
    const exact = sections.filter(section => section.heading === heading);
    const matches = exact.length ? exact : sections.filter(section => section.heading.toLowerCase() === heading.toLowerCase());
    if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Unknown'} heading "${heading}". Headings: ${sections.map(section => section.heading).join(', ') || '(none)'}`);
    return matches[0].text;
  });
  const owner = normalizeIndexedPath(entry.path).match(/(?:^|\/)(?:agentic\/code|\.aiwg)\/(frameworks|addons|extensions)\/([^/]+)\//);
  const kind = owner ? ({ frameworks: 'framework', addons: 'addon', extensions: 'extension' } as const)[owner[1] as 'frameworks' | 'addons' | 'extensions'] : null;
  const installed = local && (owner && aiwgRoot
    ? await isCorpusBundleInstalled(cwd, aiwgRoot, kind!, owner[2]) : true);
  const resources = local || release ? showResources(filePath, source, release) : [];
  const resource = params.resource ? resources.find(resource => resource.path === params.resource) : undefined;
  if (params.resource && !resource) throw new Error(`Unknown resource "${params.resource}". Resources: ${resources.map(resource => resource.path).join(', ') || '(none)'}`);
  const quote = (value: string) => '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
  const command = `aiwg show ${entry.type} ${extra.hint ? params.name : discoveryIdForEntry(entry)}`
    + (params.graph ? ` --graph ${quote(params.graph)}` : '')
    + (params.backend ? ` --backend ${params.backend}` : '')
    + (params.resourceSource ? ` --resource-source ${params.resourceSource}` : '')
    + (params.aiwgVersion ? ` --aiwg-version ${quote(params.aiwgVersion)}` : '')
    + (params.offline ? ' --offline' : '');
  let resourceBody: string | undefined;
  if (resource) {
    if (local) resourceBody = fs.readFileSync(path.join(path.dirname(filePath), resource.path), 'utf8');
    else if (release) {
      const { fetchVerifiedRawResource } = await import('../resources/web-release.js');
      resourceBody = (await fetchVerifiedRawResource(release,
        path.posix.normalize(path.posix.join(path.posix.dirname(filePath), resource.path)),
        { ...params.webReleaseOptions, offline: params.offline })).toString('utf8');
    }
  }
  const localPin = extra.local_pin as { canonical_activation: string; matches: Array<{ source: string }> } | undefined;
  const pinNote = localPin ? `Pinned locally: kernel (canonical ${localPin.canonical_activation}; ${localPin.matches.map(match => match.source).join(', ')}).` : '';
  const contentNotice = 'This is a metadata card. The component body has not been fetched. Before deciding or applying its workflow, read the needed sections or --body using the drill-in commands below. Read full governing rules before governed work; --rules alone lists checks.';
  const card = {
    id: discoveryIdForEntry(entry), type: entry.type, name: entry.name ?? String(data.name ?? entry.title),
    title: entry.title, path: filePath, description: String(data.description ?? data.summary ?? flow?.description ?? entry.capability ?? entry.ruleSummary ?? entry.summary ?? ''),
    capability: owner ? { kind, name: owner[2] } : null, installed, kernel: entry.kernel ?? false,
    ...(['rule', 'behavior'].includes(entry.type) ? {
      activation: localPin ? 'kernel' : entry.activation ?? data.activation ?? null, enforcement: data.enforcement ?? entry.ruleEnforcement ?? null,
      bound_to: data.bound_to ?? entry.bound_to ?? {},
    } : {}),
    bound_rules: [], rule_stats: emptyRuleStats(), required_rule_checks: [], rule_check_obligation: RULE_CHECK_OBLIGATION,
    ...bindings.fields,
    outline: sections.map(({ text: _text, ...metadata }) => metadata), resources,
    ...(!params.body && !selected.length ? { content_notice: contentNotice } : {}),
    drill_in: {
      sections: sections.map(section => `${command} --section ${quote(section.heading)}`),
      rules: `${command} --rules`, rule_bodies: `${command} --rules --with-rule-bodies`,
      resources: `${command} --resources`, resource: resources.map(resource => `${command} --resource ${quote(resource.path)}`),
      body: `${command} --body`,
    },
    ...extra,
    ...(params.body || selected.length ? { content: params.body ? source : selected.join('\n') } : {}),
    ...(resource ? { resource: { ...resource, body: resourceBody! } } : {}),
  };
  if (params.json) { console.log(JSON.stringify(card, null, 2)); return; }
  if ('content' in card) {
    if (extra.hint) process.stdout.write(`<!-- AIWG: ${card.installed ? 'installed bundle artifact — not in the selected index.' : 'corpus-only artifact — not in the indexed workspace.'}\n     ${extra.hint}\n     Origin: ${filePath}\n-->\n\n`);
    if (entry.script) process.stdout.write(`<!-- AIWG: executable skill — run via: ${buildRunHint(entry)} -->\n`);
    if (pinNote) process.stdout.write(`${pinNote}\n`);
    process.stdout.write(card.content!);
    if (!card.content!.endsWith('\n')) process.stdout.write('\n');
    if (bindings.text) process.stdout.write(bindings.text);
    return;
  }
  const lines = [`# ${card.type}: ${card.name}`, `ID: ${card.id}`, card.description,
    `Owner: ${card.capability ? `${card.capability.kind}:${card.capability.name}` : 'project/unowned'} | installed: ${card.installed}`, statsText(card.rule_stats as RuleStats)];
  if (pinNote) lines.push(pinNote);
  if ('activation' in card) lines.push(`Activation: ${card.activation} | enforcement: ${card.enforcement}`, `Bound targets: ${JSON.stringify(card.bound_to)}`);
  lines.push(contentNotice, bindings.text || RULE_CHECK_OBLIGATION, '\n## Outline', ...card.outline.map(section => `- ${section.heading} (${section.bytes} bytes, ${section.lines} lines)`),
    '\n## Resources', ...resources.map(resource => `- ${resource.path} (${resource.bytes} bytes)`), '\n## Drill in',
    ...Object.values(card.drill_in).flat().map(command => `- ${command}`));
  if (card.resource) lines.push(`\n## Resource: ${card.resource.path}`, card.resource.body);
  console.log(lines.join('\n'));
}
