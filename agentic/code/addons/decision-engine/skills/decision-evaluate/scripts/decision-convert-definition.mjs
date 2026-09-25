#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDecisionRuntime } from './runtime-root.mjs';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || path.resolve(sourcePath) === path.resolve(outputPath)) {
  console.error('Usage: decision-convert-definition <v1alpha1.json> <new-v1alpha2.json>');
  process.exit(2);
}
let runtimePath;
try { runtimePath = resolveDecisionRuntime(import.meta.url); }
catch (error) { console.error(error.message); process.exit(2); }
const runtime = await import(pathToFileURL(runtimePath).href);
const source = runtime.parseDecisionJson(await readFile(sourcePath, 'utf8'));
const converted = runtime.convertDecisionDefinitionV1Alpha1(source);
await writeFile(outputPath, `${JSON.stringify(converted.definition, null, 2)}\n`, { flag: 'wx' });
console.error(JSON.stringify({ previousDigest: converted.previousDigest, digest: converted.digest }));
