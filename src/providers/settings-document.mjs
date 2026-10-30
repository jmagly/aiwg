// Parse provider settings and render safe semantic edits in their native format.
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
import { parseDocument } from 'yaml';
import { parseJson } from '../mcp/json-document.mjs';

export const stableSettings = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export function parseSettings(file, bytes) {
  const text = bytes.toString();
  if (file.endsWith('.toml')) return getStaticTOMLValue(parseTOML(text));
  if (/\.ya?ml$/.test(file)) {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error('Invalid YAML settings');
    return doc.toJS() ?? {};
  }
  return parseJson(text);
}
const tomlValue = value => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join(', ')} }`;
  if (value === null || value === undefined) throw new Error('Unrepresentable TOML value');
  return JSON.stringify(value);
};
export function renderSettings(file, bytes, value) {
  if (file.endsWith('.toml')) {
    // Root inline tables are valid TOML and preserve arbitrary dotted keys.
    const text = Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join('\n') + '\n';
    if (stableSettings(parseSettings(file, Buffer.from(text))) !== stableSettings(value)) throw new Error('TOML settings round trip failed');
    return Buffer.from(text);
  }
  if (/\.ya?ml$/.test(file)) {
    const doc = parseDocument(bytes.toString());
    const update = (before, after, keys = []) => {
      for (const key of Object.keys(before || {})) if (!Object.hasOwn(after, key)) doc.deleteIn([...keys, key]);
      for (const [key, child] of Object.entries(after)) {
        const prior = before?.[key];
        if (stableSettings(prior) === stableSettings(child)) continue;
        if (prior && child && typeof prior === 'object' && typeof child === 'object' && !Array.isArray(prior) && !Array.isArray(child)) update(prior, child, [...keys, key]);
        else doc.setIn([...keys, key], child);
      }
    };
    update(doc.toJS(), value);
    return Buffer.from(doc.toString());
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
