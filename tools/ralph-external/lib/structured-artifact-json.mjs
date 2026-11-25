// Parse original JSON bytes without duplicate keys, non-finite numbers or silent repair.
import { createHash } from 'node:crypto';
export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const jsonDigest = value => digest(JSON.stringify(value));

export function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
  const parsed = JSON.parse(text);
  let offset = 0;
  const space = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const c = text[offset++];
      if (c === '\\') offset++;
      else if (c === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error('Unterminated string');
  }
  function visit(depth = 0) {
    if (depth > 256) throw new Error('JSON nesting exceeds 256');
    space();
    const c = text[offset];
    if (c === '"') { string(); return; }
    if (c === '{' || c === '[') {
      offset++; space();
      const end = c === '{' ? '}' : ']';
      const keys = new Set();
      if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        if (c === '{') {
          space(); const key = string();
          if (keys.has(key)) throw new Error(`Duplicate object key: ${key}`);
          keys.add(key); space(); offset++;
        }
        visit(depth + 1); space();
        if (text[offset++] === end) return;
      }
    } else {
      const start = offset;
      while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset++;
      const token = text.slice(start, offset);
      if (token !== 'true' && token !== 'false' && token !== 'null' && !Number.isFinite(Number(token))) throw new Error('Non-finite JSON number');
    }
  }
  visit();
  return parsed;
}
