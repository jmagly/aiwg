import { parseTOML } from 'toml-eslint-parser';

/** Remove the root MCP subtree without interpreting strings as TOML structure. */
export function stripMcpServers(text) {
  const fail = () => { throw new Error('Refusing to copy base Codex config: cannot safely classify TOML (malformed or unterminated structure)'); };
  // Reuse the existing persistent-editor validator (no new dependency). The
  // scanner below owns subtree removal; validation also catches ambiguous
  // scalar syntax and duplicate definitions, beyond balanced delimiters.
  try { parseTOML(text, { tomlVersion: '1.1.0' }); } catch { fail(); }
  // A key path may use bare, literal, or escaped basic quoted components.
  const keyPath = source => {
    const parts = [];
    let rest = source.trim();
    while (rest) {
      const match = /^(?:([A-Za-z0-9_-]+)|'([^'\r\n]*)'|"((?:[^"\\\r\n]|\\(?:[btnfr"\\]|u[\da-fA-F]{4}|U[\da-fA-F]{8}))*)")/.exec(rest);
      if (!match) fail();
      let key = match[1] ?? match[2];
      if (key === undefined) {
        key = match[3].replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|[btnfr"\\])/g, (_, escape) => {
          if (escape[0] === 'u' || escape[0] === 'U') {
            const code = Number.parseInt(escape.slice(1), 16);
            if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
            return String.fromCodePoint(code);
          }
          return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[escape];
        });
      }
      parts.push(key);
      rest = rest.slice(match[0].length).trim();
      if (!rest) break;
      if (!rest.startsWith('.')) fail();
      rest = rest.slice(1).trim();
      if (!rest) fail();
    }
    if (!parts.length) fail();
    return parts;
  };

  let table = [];
  let quote = null;
  let multiline = false;
  const brackets = [];
  let record = '';
  let drop = false;
  const kept = [];
  for (const line of text.split(/(?<=\n)/)) {
    let start = 0;
    if (!record) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        if (table[0] !== 'mcp_servers') kept.push(line);
        continue;
      }
      if (trimmed.startsWith('[')) {
        // Header strings are single-line key components; scan their quotes so
        // a bracket or hash inside a quoted name cannot terminate the header.
        let headerQuote = null;
        let end = line.length;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (headerQuote) {
            if (headerQuote === '"' && char === '\\') { i++; continue; }
            if (char === headerQuote) headerQuote = null;
          } else if (char === '"' || char === "'") headerQuote = char;
          else if (char === '#') { end = i; break; }
        }
        if (headerQuote) fail();
        const header = line.slice(0, end).trim();
        const array = header.startsWith('[[');
        const width = array ? 2 : 1;
        if (!header.endsWith(array ? ']]' : ']')) fail();
        table = keyPath(header.slice(width, -width));
        if (table[0] !== 'mcp_servers') kept.push(line);
        continue;
      }
      let keyQuote = null;
      let equals = -1;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (keyQuote) {
          if (keyQuote === '"' && char === '\\') { i++; continue; }
          if (char === keyQuote) keyQuote = null;
        } else if (char === '"' || char === "'") keyQuote = char;
        else if (char === '=') { equals = i; break; }
        else if (char === '#') break;
      }
      if (equals < 0 || keyQuote) fail();
      const key = keyPath(line.slice(0, equals));
      drop = table[0] === 'mcp_servers' || (table.length === 0 && key[0] === 'mcp_servers');
      start = equals + 1;
      if (!line.slice(start).split('#')[0].trim()) fail();
    }
    record += line;
    for (let i = start; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (quote === '"' && char === '\\') {
          // A backslash escapes the next character (including a multiline
          // continuation); it cannot conceal a closing delimiter.
          if (i + 1 >= line.length) fail();
          i++;
          continue;
        }
        if (char === quote) {
          if (!multiline) quote = null;
          else if (line.slice(i, i + 3) === quote.repeat(3)) {
            let run = 3;
            while (line[i + run] === quote) run++;
            if (run > 5) fail();
            i += run - 1;
            quote = null;
            multiline = false;
          }
        } else if (!multiline && (char === '\n' || char === '\r')) fail();
        continue;
      }
      if (char === '#') break;
      if (char === '"' || char === "'") {
        quote = char;
        multiline = line.slice(i, i + 3) === char.repeat(3);
        if (multiline) i += 2;
      } else if (char === '[' || char === '{') brackets.push(char);
      else if (char === ']' || char === '}') {
        if (brackets.pop() !== (char === ']' ? '[' : '{')) fail();
      } else if (char === '=' && !brackets.includes('{')) fail();
    }
    if (quote && !multiline) fail();
    if (!quote && brackets.length === 0) {
      if (!drop) kept.push(record);
      record = '';
    }
  }
  if (quote || brackets.length || record) fail();
  return kept.join('');
}
