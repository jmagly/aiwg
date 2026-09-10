// Pure source-range editing; provider filesystem access belongs to the caller.
import { parseTOML } from 'toml-eslint-parser';

const keys = node => node.key.keys.map(key => key.type === 'TOMLBare' ? key.name : key.value);
const starts = (path, prefix) => prefix.every((key, index) => path[index] === key);
function parse(text) {
  try { return parseTOML(text, { tomlVersion: '1.0.0' }); }
  catch { throw new Error('Invalid TOML configuration; no changes made'); }
}

export function replaceServer(text, name, section) {
  const ast = parse(text);
  const target = ['mcp_servers', name];
  const replacement = parse(section).body[0].body;
  if (replacement.length !== 1 || replacement[0].type !== 'TOMLTable' ||
      replacement[0].resolvedKey.length !== 2 || !starts(replacement[0].resolvedKey, target)) {
    throw new Error('Invalid replacement server definition');
  }
  const inline = '{ ' + replacement[0].body.map(node => section.slice(...node.range)).join(', ') + ' }';
  const encodedName = section.slice(...replacement[0].key.keys[1].range);
  const edits = [];
  let present = false;
  let placed = false;
  const edit = (range, value = '') => edits.push({ start: range[0], end: range[1], value });

  function inspectValue(node, path) {
    if (path[0] === 'mcp_servers') {
      if (path.length <= 2 && node.type !== 'TOMLInlineTable') {
        throw new Error('MCP configuration and server entries must be TOML tables');
      }
      if (starts(path, target)) present = true;
    }
    if (node.type === 'TOMLInlineTable') {
      for (const entry of node.body) inspectValue(entry.value, [...path, ...keys(entry)]);
    }
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLTable') {
      const path = node.resolvedKey;
      if (path[0] === 'mcp_servers' &&
          (typeof path[1] === 'number' || typeof path[2] === 'number')) {
        throw new Error('MCP configuration and server entries must not be TOML arrays of tables');
      }
      if (starts(path, target)) present = true;
      for (const entry of node.body) inspectValue(entry.value, [...path, ...keys(entry)]);
    } else inspectValue(node.value, keys(node));
  }

  const selectedTables = ast.body[0].body.filter(node => node.type === 'TOMLTable' && starts(node.resolvedKey, target));
  if (selectedTables.length === 1 && text.slice(...selectedTables[0].range) === section) {
    return { text, alreadyPresent: true };
  }
  if (selectedTables.length === 1 && selectedTables[0].resolvedKey.length === 2) {
    const [start, end] = selectedTables[0].range;
    if (!ast.comments.some(comment => comment.range[0] >= start && comment.range[0] < end)) {
      const output = text.slice(0, start) + section + text.slice(end);
      parse(output);
      return { text: output, alreadyPresent: true };
    }
  }

  function editInlineMap(node) {
    const entries = node.body;
    const selected = entries.map((entry, index) => keys(entry)[0] === name ? index : -1).filter(index => index >= 0);
    if (selected.length === 0) {
      edit([node.range[1] - 1, node.range[1] - 1], `${entries.length ? ', ' : ''}${encodedName} = ${inline}`);
    } else {
      const first = selected[0];
      if (keys(entries[first]).length === 1) edit(entries[first].value.range, inline);
      else edit(entries[first].range, `${encodedName} = ${inline}`);
      // Keep the first selected entry as the replacement anchor. Remove each
      // subsequent contiguous run together with one separator, never a neighbor.
      for (let cursor = 1; cursor < selected.length;) {
        const start = selected[cursor];
        let end = start;
        while (cursor + 1 < selected.length && selected[cursor + 1] === end + 1) {
          cursor++;
          end++;
        }
        if (end + 1 < entries.length) edit([entries[start].range[0], entries[end + 1].range[0]]);
        else edit([entries[start - 1].range[1], entries[end].range[1]]);
        cursor++;
      }
    }
    placed = true;
  }
  function planEntry(entry, base) {
    const path = [...base, ...keys(entry)];
    if (path.length === 1 && path[0] === 'mcp_servers') {
      editInlineMap(entry.value);
    } else if (starts(path, target)) {
      if (path.length === 2) {
        edit(entry.value.range, inline);
        placed = true;
      } else edit(entry.range);
    }
  }
  for (const node of ast.body[0].body) {
    if (node.type !== 'TOMLTable') { planEntry(node, []); continue; }
    if (starts(node.resolvedKey, target)) {
      const closing = ast.tokens.filter(token => token.range[0] >= node.key.range[1] && token.value === ']');
      const last = closing[node.kind === 'array' ? 1 : 0];
      if (!last) throw new Error('Invalid TOML table range');
      edit([node.range[0], last.range[1]]);
      for (const entry of node.body) edit(entry.range);
    } else for (const entry of node.body) planEntry(entry, node.resolvedKey);
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].start < edits[index - 1].end) throw new Error('Overlapping TOML edit ranges');
  }
  let output = text;
  for (const change of edits.reverse()) output = output.slice(0, change.start) + change.value + output.slice(change.end);
  if (!placed) output += `${output.endsWith('\n') ? '' : '\n'}\n${section}\n`;
  parse(output);
  return { text: output, alreadyPresent: present };
}
