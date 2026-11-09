// Keep platform mutation in the shared restoration owner, including child snippets.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const testRoot = path.resolve(import.meta.dirname, '../..');
const owner = 'helpers/windows-simulation.mjs';
const processRef = String.raw`process\s*(?:\.\s*platform|\[\s*['"\x60]platform['"\x60]\s*\])`;
function overrides(source) {
  return new RegExp(String.raw`(?:defineProperty|replaceProperty|spyOn)\s*\(\s*process\s*,\s*['"\x60]platform['"\x60]|defineProperties\s*\(\s*process\s*,\s*\{[\s\S]*?\bplatform\s*:|Object\.assign\s*\(\s*process\s*,\s*\{[\s\S]*?\bplatform\s*:|${processRef}\s*=(?!=)`).test(source);
}

it.each([
  'Object.defineProperty' + '(process, "platform", { value: "win32" });',
  'Reflect.defineProperty' + '(process, `platform`, descriptor);',
  'Object.defineProperty' + '(\n process,\n \'platform\', descriptor);',
  'Object.defineProperties' + '(process, { platform: descriptor });',
  'Object.assign' + '(process, { platform: "win32" });',
  'process' + '.platform = "win32";',
  'process' + '["platform"] = "win32";',
  'vi.spyOn' + '(process, "platform", "get");',
])('recognizes direct mutation: %s', source => { expect(overrides(source)).toBe(true); });

it('rejects platform overrides anywhere in test outside the simulation helper', () => {
  const offenders = [];
  for (const entry of fs.readdirSync(testRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(testRoot, file).split(path.sep).join('/');
    if (relative !== owner && overrides(fs.readFileSync(file, 'utf8'))) offenders.push(relative);
  }
  expect(offenders, 'Use test/helpers/windows-simulation.mjs for guaranteed restoration').toEqual([]);
});
