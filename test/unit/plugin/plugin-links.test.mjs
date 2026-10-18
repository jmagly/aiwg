import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rewritePublishedLinks, writeCanonicalScriptWrappers } from '../../../tools/plugin/package-plugins.mjs';
import { checkPluginLinks, markdownLinks, reportPluginLinks } from '../../../tools/plugin/plugin-links.mjs';

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-plugin-links-'));
  temporary.push(parent);
  const root = path.join(parent, 'plugin');
  fs.mkdirSync(path.join(root, 'skills', 'sample'), { recursive: true });
  return { parent, root, skill: path.join(root, 'skills/sample/SKILL.md') };
}

describe('plugin payload links (#3204)', () => {
  it('reports checkout-only paths even when the target exists', () => {
    const { parent, root, skill } = fixture();
    fs.writeFileSync(path.join(parent, 'checkout.md'), 'outside');
    fs.writeFileSync(skill, '[checkout](../../../checkout.md)\n[missing](../../docs/absent.md)');
    expect(checkPluginLinks(root)).toEqual([
      { file: 'skills/sample/SKILL.md', line: 1, target: '../../../checkout.md', reason: 'outside-payload' },
      { file: 'skills/sample/SKILL.md', line: 2, target: '../../docs/absent.md', reason: 'missing-target' },
    ]);
  });

  it('accepts packaged, encoded, fragment, query, and published links', () => {
    const { root, skill } = fixture();
    fs.writeFileSync(path.join(root, 'a b.md'), 'doc');
    fs.writeFileSync(skill, '[doc](../../a%20b.md?raw=1#heading)\n[angle](<../../a b.md>)\n[web](https://example.com) [mail](mailto:a@example.com) [anchor](#local)');
    expect(checkPluginLinks(root)).toEqual([]);
  });

  it('handles images, reference destinations, nested parentheses, and multiline labels', () => {
    const links = markdownLinks('![image](missing.png)\n[reference][id]\n[id]: ../outside.md "Title"\n[wrapped\nlabel](<doc (v1).md>)\n[nested](file(v2).md)');
    expect(links.map(({ target, line }) => ({ target, line }))).toEqual([
      { target: 'missing.png', line: 1 }, { target: '../outside.md', line: 3 },
      { target: 'doc (v1).md', line: 4 }, { target: 'file(v2).md', line: 6 },
    ]);
    const body = '[same.md](same.md)\n[x]: <other.md>';
    for (const link of markdownLinks(body)) expect(body.slice(link.start, link.start + link.target.length)).toBe(link.target);
  });

  it('ignores fenced examples, inline code, and comments, preserving line numbers', () => {
    const body = '````md\n[example](absent.md)\n```\n[still example](absent.md)\n````\n~~~\n[example](absent.md)\n~~~\n`[code](absent.md)`\n<!-- [comment](absent.md) -->\n[real](missing.md)';
    expect(markdownLinks(body).map(({ target, line }) => ({ target, line }))).toEqual([{ target: 'missing.md', line: 11 }]);
  });

  it('detects encoded traversal and symlinks leaving the installed payload', () => {
    const { parent, root, skill } = fixture();
    fs.writeFileSync(path.join(parent, 'outside.md'), 'outside');
    fs.symlinkSync(path.join(parent, 'outside.md'), path.join(root, 'alias.md'));
    fs.writeFileSync(skill, '[encoded](%2e%2e/%2e%2e/%2e%2e/outside.md)\n[symlink](../../alias.md)');
    expect(checkPluginLinks(root).map(item => item.reason)).toEqual(['outside-payload', 'outside-payload']);
  });

  it('reports each offender with a file, line, target, and summary', () => {
    const { root, skill } = fixture();
    fs.writeFileSync(skill, '\n[missing](missing.md)');
    const lines = [];
    expect(reportPluginLinks(root, line => lines.push(line))).toHaveLength(1);
    expect(lines).toEqual(['plugin/skills/sample/SKILL.md:2: missing-target: missing.md', 'plugin: 1 unresolved relative Markdown link(s)']);
  });

  it('packages the research service doc and rewrites its shared security dependency', () => {
    const root = path.resolve('agentic/code/plugins/research');
    const canonical = fs.readFileSync('agentic/code/frameworks/research-complete/docs/bibliographic-services.md', 'utf8');
    const packaged = fs.readFileSync(path.join(root, 'docs/bibliographic-services.md'), 'utf8');
    expect(packaged).toBe(canonical.replace('../../sdlc-complete/rules/token-security.md', 'https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/rules/token-security.md'));
    expect(fs.readFileSync(path.join(root, 'skills/induct-research/SKILL.md'), 'utf8')).toContain('](../../docs/bibliographic-services.md)');
    expect(checkPluginLinks(root).filter(item => !item.file.includes('/examples/'))).toEqual([]);
  });

  it('rewrites published links while retaining packaged docs and literal examples', () => {
    const { root, skill } = fixture();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/verification-contracts.md'), 'packaged');
    const shared = '../../../addons/aiwg-utils/rules/skill-discovery.md';
    fs.writeFileSync(skill, `[rule](${shared})\n[own](../../docs/verification-contracts.md)\n[repo\ndoc](../../../../../../docs/verification-contracts.md)\n[ref]: <${shared}>\n\`[literal](${shared})\`\n\`\`\`md\n[sample](${shared})\n\`\`\``);
    rewritePublishedLinks(root);
    const result = fs.readFileSync(skill, 'utf8');
    expect(result).toContain('[rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md)');
    expect(result).toContain('[ref]: <https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md>');
    expect(result).toContain('[own](../../docs/verification-contracts.md)');
    expect(result).toContain('https://github.com/jmagly/aiwg/blob/main/docs/verification-contracts.md');
    expect(result).toContain(`\`[literal](${shared})\``);
    expect(result).toContain(`[sample](${shared})`);
    rewritePublishedLinks(root);
    expect(fs.readFileSync(skill, 'utf8')).toBe(result);
  });

  it('preserves executable paths in shell fences, inline code, and script files', () => {
    const { root, skill } = fixture();
    const shared = '../../../addons/aiwg-utils/rules/skill-discovery.md';
    const executable = `\`\`\`bash\ncat ${shared}\n[example](${shared})\n\`\`\`\n\`[inline](${shared})\``;
    const script = path.join(root, 'skills/sample/assess.mjs');
    const source = `const example = '[script](${shared})';\n`;
    fs.writeFileSync(skill, `${executable}\n[prose](${shared})\n`);
    fs.writeFileSync(script, source);
    rewritePublishedLinks(root);
    expect(fs.readFileSync(skill, 'utf8')).toBe(`${executable}\n[prose](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md)\n`);
    expect(fs.readFileSync(script, 'utf8')).toBe(source);
  });

  it('regenerates canonical assess routing and executes the wrapper from another directory', () => {
    const { root } = fixture();
    const source = 'agentic/code/frameworks/sdlc-complete/skills/address-issues-threat-assess/scripts/assess.mjs';
    const file = 'skills/sample/assess.mjs';
    const wrappers = [{ file, source, exports: ['assessIssue', 'assessText', 'runCli'] }];
    fs.writeFileSync(path.join(root, file), 'stale copied implementation');
    writeCanonicalScriptWrappers(root, wrappers);
    const first = fs.readFileSync(path.join(root, file), 'utf8');
    expect(first).toContain('frameworks/sdlc-complete/skills/address-issues-threat-assess/scripts/assess.mjs');
    writeCanonicalScriptWrappers(root, wrappers);
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(first);
    const result = spawnSync(process.execPath, [path.join(root, file), '--text', 'Fix the parser.', '--format', 'json'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe('safe');
  });

  it('keeps the all-plugin unresolved inventory limited to reviewed cases', () => {
    const root = path.resolve('agentic/code/plugins');
    const actual = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => checkPluginLinks(path.join(root, entry.name))
        .map(({ line, ...item }) => ({ plugin: entry.name, ...item })));
    const expected = JSON.parse(fs.readFileSync('test/fixtures/plugins/relative-link-offenders.json', 'utf8'));
    expect(actual).toEqual(expected);
  });

  it('provides a read-only strict check with success and failure exit codes', () => {
    const packager = path.resolve('tools/plugin/package-plugins.mjs');
    const good = spawnSync(process.execPath, [packager, '--plugin', 'sdlc', '--check-links'], { encoding: 'utf8' });
    expect(good.status, good.stderr).toBe(0);
    const before = fs.readFileSync('agentic/code/plugins/research/skills/induct-research/SKILL.md', 'utf8');
    const bad = spawnSync(process.execPath, [packager, '--all', '--check-links'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('agent-loop/README.md:147: missing-target: docs/examples/test-fix.md');
    expect(bad.stderr).toContain('context-curator/README.md');
    expect(fs.readFileSync('agentic/code/plugins/research/skills/induct-research/SKILL.md', 'utf8')).toBe(before);
  });
});
