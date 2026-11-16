// Mask protected Markdown regions without changing source offsets or line breaks.
export interface ProtectedRegion { start: number; end: number; context: 'code' | 'quote' | 'inventory' }

export function protectedRegions(content: string): ProtectedRegion[] {
  const spans: ProtectedRegion[] = [];
  const add = (start: number, end: number, context: ProtectedRegion['context'] = 'code') => {
    if (end > start) spans.push({ start, end, context });
  };
  const lines = [...content.matchAll(/[^\n]+(?:\n|$)|\n/g)];
  let fence: string | undefined;
  let frontMatter = /^(?:\uFEFF)?---\s*$/.test(lines[0]?.[0].trimEnd() ?? '');
  let comment = false;
  let indented = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0];
    const start = lines[i].index!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (frontMatter) {
      add(start, start + line.length);
      if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      continue;
    }
    if (fence) {
      add(start, start + line.length);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; add(start, start + line.length); continue; }
    if (comment) {
      const end = line.indexOf('-->');
      add(start, start + (end < 0 ? line.length : end + 3));
      comment = end < 0;
      if (comment) continue;
    }
    for (const m of line.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
      add(start + m.index!, start + m.index! + m[0].length);
      if (!m[0].endsWith('-->')) comment = true;
    }
    const setext = i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1][0]);
    if (/^ {0,3}(?:#{1,6}(?:\s|$)|>|\|)/.test(line) || setext || /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      add(start, start + line.length); continue;
    }
    if (/^(?: {4}|\t)/.test(line) && (indented || i === 0 || !lines[i - 1][0].trim())) {
      add(start, start + line.length); indented = true; continue;
    }
    if (line.trim()) indented = false;
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) add(start, start + line.length, 'inventory');
  }
  const patterns: Array<[ProtectedRegion['context'], RegExp]> = [
    ['code', /(`+)(?!`)([^`]|(?!\1)`)*?\1(?!`)/g],
    ['code', /!\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])/g],
    ['code', /(?:!?\[[^\]\n]*\])?\((?:https?:\/\/)[^\s)]*\)|https?:\/\/[^\s<>]+/g],
    ['quote', /“[^”]*”|"[^"\n]+"|«[^»]*»/g],
  ];
  for (const [context, pattern] of patterns) for (const m of content.matchAll(pattern)) add(m.index!, m.index! + m[0].length, context);
  return spans;
}

/** UTF-16 length is preserved, including astral characters in protected regions. */
export function maskProse(content: string, regions = protectedRegions(content)): string {
  const chars = content.split('');
  for (const span of regions) for (let i = span.start; i < span.end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = '\u0001';
  return chars.join('');
}
