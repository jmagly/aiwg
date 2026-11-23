import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('provider artifact availability audit', () => {
  it('never reports an unavailable core artifact when indexed access exists', async () => {
    const directory = resolve('tools/agents/providers');
    let audited = 0;
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.mjs') || file === 'base.mjs') continue;
      const messageListeners = process.listeners('message');
      const adapter = await import(pathToFileURL(resolve(directory, file)).href);
      expect(process.listeners('message'), `${file}: import must not install worker IPC handlers`).toEqual(messageListeners);
      if (!adapter.support) continue;
      for (const kind of ['agents', 'commands', 'skills', 'rules']) {
        if (adapter.support[kind] === false) {
          expect(adapter.paths?.[kind], `${file}: ${kind} unsupported with an indexed path`).toBeFalsy();
          continue;
        }
        expect(adapter.support[kind], `${file}: ${kind}`).toBeTruthy();
        expect(['none', 'unsupported'], `${file}: ${kind}`).not.toContain(adapter.support[kind]);
      }
      audited++;
    }
    expect(audited).toBeGreaterThanOrEqual(13);
  });
});
