import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyBuildResources,
  resourceDestination,
} from '../../../tools/scripts/copy-build-resources.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('build resource copier', () => {
  it('maps Windows source paths structurally instead of matching separators', () => {
    expect(resourceDestination(
      String.raw`src\mcp\tools\example.mjs`,
      {
        sourceRoot: 'src',
        destinationRoot: String.raw`dist\src`,
        pathApi: path.win32,
      },
    )).toBe(String.raw`dist\src\mcp\tools\example.mjs`);
  });

  it('retains resource paths beneath dist/src and ignores other files', () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'aiwg-copy-resources-'));
    temporaryDirectories.push(projectRoot);

    const sourceRoot = path.join(projectRoot, 'src');
    const destinationRoot = path.join(projectRoot, 'dist', 'src');
    const nestedSource = path.join(sourceRoot, 'mcp', 'tools');
    mkdirSync(nestedSource, { recursive: true });
    writeFileSync(path.join(nestedSource, 'example.mjs'), 'export const example = true;\n');
    writeFileSync(path.join(nestedSource, 'profile.json'), '{"enabled":true}\n');
    writeFileSync(path.join(nestedSource, 'profile.yaml'), 'enabled: true\n');
    writeFileSync(path.join(nestedSource, 'profile.yml'), 'enabled: true\n');
    writeFileSync(path.join(nestedSource, 'example.d.mts'), 'export const example: boolean;\n');
    writeFileSync(path.join(nestedSource, 'ignored.mts'), 'export const ignored = true;\n');
    writeFileSync(path.join(nestedSource, 'ignored.ts'), 'export const ignored = true;\n');

    expect(copyBuildResources({ sourceRoot, destinationRoot })).toBe(5);
    expect(readFileSync(
      path.join(destinationRoot, 'mcp', 'tools', 'example.mjs'),
      'utf8',
    )).toBe('export const example = true;\n');
    expect(readFileSync(
      path.join(destinationRoot, 'mcp', 'tools', 'profile.json'),
      'utf8',
    )).toBe('{"enabled":true}\n');
    expect(readFileSync(
      path.join(destinationRoot, 'mcp', 'tools', 'profile.yaml'),
      'utf8',
    )).toBe('enabled: true\n');
    expect(readFileSync(
      path.join(destinationRoot, 'mcp', 'tools', 'profile.yml'),
      'utf8',
    )).toBe('enabled: true\n');
    expect(readFileSync(path.join(destinationRoot, 'mcp', 'tools', 'example.d.mts'), 'utf8')).toBe('export const example: boolean;\n');
    expect(() => readFileSync(path.join(destinationRoot, 'mcp', 'tools', 'ignored.mts'))).toThrow();
    expect(() => readFileSync(
      path.join(destinationRoot, 'mcp', 'tools', 'ignored.ts'),
      'utf8',
    )).toThrow();
  });
});
