// Emulate Flue's Markdown loader and runtime hooks to probe an agent without a model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('Network forbidden'); };
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('/SKILL.md')) return nextLoad(url, context);
    const instructions = readFileSync(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true,
      source: `export default ${JSON.stringify({ name: 'sdlc-quickref', instructions })};` };
  },
});

const { Assistant } = await import(pathToFileURL(process.argv[2]).href);
const { sdlcQuickref } = await import(new URL('../aiwg/skills.ts', pathToFileURL(process.argv[2])).href);
const { mounted } = await import('@flue/runtime');
Assistant();
assert.deepEqual(mounted, [sdlcQuickref]);
assert.match(sdlcQuickref.instructions, /Synthetic SDLC instructions/);
console.log('PASS agent skill import and mount');
