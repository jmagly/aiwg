// Static target selection must survive transactional staging without executing config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error deployment tool module
import flue from '../../../tools/agents/providers/flue.mjs';
// @ts-expect-error deployment tool module
import { deployFlueDatabase, detectFlueTarget } from '../../../tools/agents/providers/flue-project.mjs';

let scratch: string, project: string, source: string;
const write = (name: string, text: string) => fs.writeFileSync(path.join(project, name), text);
const read = (name: string) => fs.readFileSync(path.join(project, name), 'utf8');
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-cf-target-'));
  project = path.join(scratch, 'project'); fs.mkdirSync(project);
  source = path.join(scratch, 'agentic/code/frameworks/sdlc-complete');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ flue: { specialists: ['code-reviewer'] } }));
  fs.writeFileSync(path.join(source, 'agents/code-reviewer.md'), '---\nname: code-reviewer\ndescription: Synthetic reviewer\n---\nReview synthetic code.\n');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); });

it.each([false, true])('deploys remote tools and delegates without a database (package=%s)', async fluePackage => {
  write('flue.config.ts', "throw Error('never evaluate'); export default defineConfig({ target: 'cloudflare', db: './operator.ts' });");
  await flue.postDeploy(project, { srcRoot: source, frameworkSlug: 'sdlc-complete', mode: 'sdlc', fluePackage, contextFiles: false });
  expect(detectFlueTarget(project)).toBe('cloudflare');
  expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
  expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  const tools = read('src/aiwg/tools.ts');
  expect(tools).toContain(fluePackage ? "from '@aiwg/flue/tools'" : 'defineMcpConnection');
  expect(tools).toContain('env.AIWG_MCP_URL');
  expect(tools).toContain('env.AIWG_MCP_TOKEN');
  expect(tools).not.toMatch(/stdio|node:|tools\/node/);
  const delegates = read('src/aiwg/specialists.ts');
  expect(delegates).toContain('bindRemoteSpecialist(');
  expect(delegates).toContain(', aiwgConnection())');
  expect(delegates).not.toContain('useTool(');
});

it('keeps explicit Node target and db handling unchanged', () => {
  write('flue.config.ts', "export default { target: 'node', db: customDatabase() };");
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(detectFlueTarget(project)).toBe('node');
  deployFlueDatabase(project, {});
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('keeping explicit db entry'));
  expect(fs.existsSync(path.join(project, 'src'))).toBe(false);
});

it('warns for bare Wrangler config and retains Node tools and SQLite', async () => {
  write('wrangler.jsonc', '{}');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await flue.postDeploy(project, { srcRoot: source, frameworkSlug: 'sdlc-complete', mode: 'sdlc', fluePackage: true, contextFiles: false });
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('keeping Node deployment'));
  expect(read('src/db.ts')).toContain('sqlite');
  expect(read('src/aiwg/tools.ts')).toContain('@aiwg/flue/tools/node');
});

it.each([
  "// target: 'cloudflare'\nexport default { target: 'node' };",
  "export default { nested: { target: 'cloudflare' } };",
  'export default { note: "target: \'cloudflare\'" };',
  "const other = { target: 'cloudflare' }; export default {};",
  "export default { target: computeTarget() };",
])('ignores nonliteral and nonexported target declarations: %s', text => {
  write('flue.config.ts', text);
  expect(detectFlueTarget(project)).toBe('node');
  deployFlueDatabase(project, {});
  expect(read('src/db.ts')).toContain('sqlite');
});

it.each(['ts', 'mts', 'mjs', 'js', 'cjs', 'cts'])('detects target in config.%s', ext => {
  write(`flue.config.${ext}`, `module.exports = { 'target' /* comment */ : "cloudflare" };`);
  expect(detectFlueTarget(project)).toBe('cloudflare');
});

it('selects the first existing Flue config', () => {
  write('flue.config.ts', "export default { target: 'node' };");
  write('flue.config.js', "export default { target: 'cloudflare' };");
  expect(detectFlueTarget(project)).toBe('node');
});
