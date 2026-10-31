// Keep the remote package entry portable and its caller credentials explicit.
import fs from 'node:fs';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';

vi.mock('@flue/runtime', () => ({ defineMcpConnection: (value: unknown) => value }));
import { createAiwgConnection } from '../../../packages/flue/tools.js';

it('requires a caller token before defining a remote connection', () => {
  for (const token of [undefined, '']) {
    expect(() => createAiwgConnection({ url: 'https://example.invalid/mcp', token }))
      .toThrow('createAiwgConnection requires a caller-supplied token');
  }
});

it('defaults to the server tool names in the fixed aiwg namespace', () => {
  expect(createAiwgConnection({ url: 'https://example.invalid/mcp', token: 'synthetic' }))
    .toEqual({ name: 'aiwg', url: 'https://example.invalid/mcp', auth: 'synthetic',
      tools: ['discover', 'skill-show', 'artifact-write'] });
});

it('imports only the portable runtime peer, with no node:* or local Node adapter imports', () => {
  const source = fs.readFileSync(new URL('../../../packages/flue/tools.js', import.meta.url), 'utf8');
  const imports = ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName);
  expect(imports).toEqual(['@flue/runtime']);
});
