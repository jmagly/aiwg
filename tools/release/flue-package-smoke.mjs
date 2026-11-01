#!/usr/bin/env node
// Check the installed static exports and both executable tool surfaces.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = path.resolve(process.argv[2]);
const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
for (const target of Object.values(pkg.exports).flatMap(entry => typeof entry === 'string' ? [entry] : Object.values(entry))) {
  if (!fs.statSync(path.join(directory, target)).isFile()) throw new Error(`Missing Flue export ${target}`);
}
const remote = await import(pathToFileURL(path.join(directory, 'tools.js')).href);
if (remote.createAiwgConnection({ url: 'http://localhost/mcp', token: 'synthetic' }).name !== 'aiwg') throw new Error('Missing Flue connection');
const specialists = await import(pathToFileURL(path.join(directory, 'specialists.js')).href);
const node = await import(pathToFileURL(path.join(directory, 'node.js')).href);
if (specialists.sdlcSpecialists({ tools: Object.values(node.createAiwgTools()) }).length < 1) throw new Error('Missing Flue specialists');
console.log(`PASS @aiwg/flue ${pkg.version}`);
