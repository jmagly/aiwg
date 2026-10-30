import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { frameworkOwnershipTests, hash, receipts } from '../helpers/ownership-deployment.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// SDLC keeps the complete public CLI ownership contract in the default lane.
frameworkOwnershipTests('sdlc', 'sdlc-complete');

describe('framework deploy ownership receipts (#3769)', () => {
  it('records two framework owners of an identical file through the real deployer', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-shared-ownership-')); temporary.push(scratch);
    const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
    fs.mkdirSync(project); fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
    for (const slug of ['sdlc-complete', 'media-marketing-kit', 'media-marketing-kit']) {
      const source = path.join(scratch, 'agentic/code/frameworks', slug);
      fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(source, 'agents/shared.md'), '---\nname: shared\ndescription: Shared fixture\n---\nSame instructions.\n');
      const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/agents/deploy-agents.mjs'), '--source', source,
        '--target', project, '--provider', 'claude', '--no-context-files', '--no-attribution', '--deploy-version', '1'],
      { cwd: ROOT, env: { ...env, AIWG_ROOT: source }, encoding: 'utf8', timeout: 60_000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const entry = receipts(project).get(path.join(project, '.claude/agents/shared.md'));
      expect(entry.hash).toBe(hash(path.join(project, '.claude/agents/shared.md')));
      expect(entry.owners).toEqual(slug === 'sdlc-complete' ? ['sdlc-complete'] : ['media-marketing-kit', 'sdlc-complete']);
    }
  });

});
