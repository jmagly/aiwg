#!/usr/bin/env node
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE_EXTENSIONS = new Set(['.mjs', '.json', '.yaml', '.yml']);

function resourceDestination(
  sourcePath,
  {
    sourceRoot = 'src',
    destinationRoot = path.join('dist', 'src'),
    pathApi = path,
  } = {},
) {
  const relativePath = pathApi.relative(sourceRoot, sourcePath);
  const outsideSourceRoot = (
    relativePath === '..'
    || relativePath.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relativePath)
  );

  if (!relativePath || outsideSourceRoot) {
    throw new Error(`${sourcePath} is not a resource below ${sourceRoot}`);
  }

  return pathApi.join(destinationRoot, relativePath);
}

function copyBuildResources({
  sourceRoot = 'src',
  destinationRoot = path.join('dist', 'src'),
  fsApi = { cpSync, mkdirSync, readdirSync },
  pathApi = path,
} = {}) {
  let copied = 0;

  function walk(directory) {
    for (const entry of fsApi.readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = pathApi.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath);
        continue;
      }

      if (!RESOURCE_EXTENSIONS.has(pathApi.extname(entry.name)) && !entry.name.endsWith('.d.mts')) {
        continue;
      }

      const destinationPath = resourceDestination(sourcePath, {
        sourceRoot,
        destinationRoot,
        pathApi,
      });
      fsApi.mkdirSync(pathApi.dirname(destinationPath), { recursive: true });
      fsApi.cpSync(sourcePath, destinationPath);
      copied += 1;
    }
  }

  walk(sourceRoot);
  return copied;
}

function main() {
  const copied = copyBuildResources();
  console.log(`Copied ${copied} .mjs, .d.mts, JSON, and YAML files to dist/src/`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}

export {
  RESOURCE_EXTENSIONS,
  copyBuildResources,
  resourceDestination,
};
