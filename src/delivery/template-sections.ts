// Advise issue and PR composers about missing sections using the shipped template headings.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../cli/find-package-root.js';

function headings(markdown: string): { title: string; optional: boolean }[] {
  const result: { title: string; optional: boolean }[] = [];
  let fence = '';
  let optional = false;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const match = line.match(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (match) {
      result.push({ title: match[1], optional: optional || /\(optional\b|<!--\s*optional\s*-->/i.test(match[1]) });
      optional = false;
    } else if (line.trim()) {
      optional = /^\s*<!--\s*optional\s*-->\s*$/i.test(line);
    }
  }
  return result;
}

const headingKey = (title: string): string => title.replace(/<!--.*?-->/g, '')
  .replace(/\s+\(.*$/, '').trim().replace(/\s+/g, ' ').toLowerCase();

export function missingTemplateSections(body: string, template: string): string[] {
  const present = new Set(headings(body).map(heading => headingKey(heading.title)));
  return headings(template).filter(heading => !heading.optional && !present.has(headingKey(heading.title)))
    .map(heading => heading.title);
}

export function warnTemplateSections(body: string, template: string, warn = console.warn): string[] {
  const root = process.env.AIWG_ROOT ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  let content: string;
  try {
    if (!root && !path.isAbsolute(template)) throw new Error('AIWG package root unavailable');
    content = readFileSync(path.resolve(root ?? '.', template), 'utf8');
  } catch {
    warn(`Template warning: could not read ${template}; required sections were not checked.`);
    return [];
  }
  const missing = missingTemplateSections(body, content);
  if (missing.length) warn(`Template warning (${path.basename(template)}): missing required sections: ${missing.join(', ')}`);
  return missing;
}
