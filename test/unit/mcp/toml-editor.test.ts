import { describe, expect, it } from 'vitest';
import { replaceServer } from '../../../src/mcp/toml-editor.mjs';

const section = '[mcp_servers.target]\ncommand = "new"\nargs = ["literal $&"]';
const inline = '{ command = "new", args = ["literal $&"] }';

describe('TOML server source-range edits', () => {
  it.each([
    { name: 'empty map', before: 'mcp_servers = {}\n', after: `mcp_servers = {target = ${inline}}\n`, present: false },
    { name: 'absent inline server', before: 'mcp_servers = { other.command = "keep" }\n', after: `mcp_servers = { other.command = "keep" , target = ${inline}}\n`, present: false },
    { name: 'inline server', before: 'mcp_servers.target = { command = "old" } # tail\n', after: `mcp_servers.target = ${inline} # tail\n`, present: true },
    { name: 'inline map', before: 'mcp_servers = { target = { command = "old" }, other.command = "keep" }\n', after: `mcp_servers = { target = ${inline}, other.command = "keep" }\n`, present: true },
    { name: 'inline dotted run', before: 'mcp_servers = { target.command = "old", target.args = [], other.command = "keep" }\n', after: `mcp_servers = { target = ${inline}, other.command = "keep" }\n`, present: true },
    { name: 'inline dotted final run', before: 'mcp_servers = { other.command = "keep", target.command = "old", target.args = [] }\n', after: `mcp_servers = { other.command = "keep", target = ${inline} }\n`, present: true },
    { name: 'inline under table', before: '[mcp_servers]\ntarget = { command = "old" }\n', after: `[mcp_servers]\ntarget = ${inline}\n`, present: true },
    { name: 'quoted explicit table', before: '# before\n[mcp_servers."target"]\ncommand = "old"\n# after\n[other]\nvalue = 9223372036854775807\n', after: `# before\n${section}\n# after\n[other]\nvalue = 9223372036854775807\n`, present: true },
    { name: 'spaced explicit table', before: '[ mcp_servers . target ]\ncommand = "old"\n', after: `${section}\n`, present: true },
    { name: 'header-shaped multiline string', before: 'note = """\n[mcp_servers.target]\nkeep\n"""\n', after: `note = """\n[mcp_servers.target]\nkeep\n"""\n\n${section}\n`, present: false },
  ])('preserves exact unrelated bytes in $name', ({ before, after, present }) => {
    expect(replaceServer(before, 'target', section)).toEqual({ text: after, alreadyPresent: present });
    expect(replaceServer(after, 'target', section)).toEqual({ text: after, alreadyPresent: true });
  });

  it('removes stale nested definitions without deleting comments or other tables', () => {
    const before = '# keep\r\n[mcp_servers.target] # header\r\ncommand = "old" # tail\r\n[mcp_servers.target.env]\r\nOLD = "gone"\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n';
    const after = '# keep\r\n # header\r\n # tail\r\n\r\n\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n\n' + section + '\n';
    expect(replaceServer(before, 'target', section)).toEqual({ text: after, alreadyPresent: true });
    expect(replaceServer(after, 'target', section).text).toBe(after);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'two words', 'a.b', 'close]name', 'café', ''])('edits literal inline key %j without object property lookup', name => {
    const key = JSON.stringify(name);
    const replacement = `[mcp_servers.${key}]\ncommand = "new"`;
    const before = `mcp_servers = { ${key} = { command = "old" }, other.command = "keep" }\n`;
    expect(replaceServer(before, name, replacement)).toEqual({
      text: `mcp_servers = { ${key} = { command = "new" }, other.command = "keep" }\n`, alreadyPresent: true,
    });
  });

  it.each(['secret = "unterminated', 'mcp_servers = 3', 'mcp_servers = []', '[[mcp_servers]]\nx=1', '[[mcp_servers.target]]\nx=1', 'mcp_servers.target = 3', 'mcp_servers.other = []'])('rejects invalid input %j with a content-free diagnostic', before => {
    expect(() => replaceServer(before, 'target', section)).toThrow(/TOML/);
    try { replaceServer(before, 'target', section); } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it.each(['command = "new"', '[mcp_servers.other]\ncommand = "new"', '[mcp_servers.target]\nx=1\n[other]\nx=2'])('rejects replacement outside the requested server: %j', replacement => {
    expect(() => replaceServer('', 'target', replacement)).toThrow('Invalid replacement server definition');
  });
});
