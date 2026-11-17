// Regress multi-repository walk bounds and duplicate-directive load scopes (#4259, #4263).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
const shared = 'Keep the shared project directive.';
const workspace = [
  '<!-- AIWG:workspace-context:start -->', '<!-- AIWG:workspace-context:end -->',
  '<!-- AIWG:workspace-operator:start -->', '<!-- AIWG:workspace-operator:end -->',
].join('\n');

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-context-multirepo-'));
  roots.push(root);
  await writeFile(join(root, 'WORKSPACE.md'), workspace);
  return root;
}

async function context(root: string, relative: string, body: string): Promise<void> {
  const file = join(root, relative);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, body);
}

async function doctor() {
  return (await import('../../../src/smiths/context-pipeline/workspace-doctor.js')).diagnoseWorkspaceContext;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('multi-repository context walk (#4259)', () => {
  it('ignores nested artifact stores larger than the default directory budget and preserves findings at raised bounds', async () => {
    const root = await fixture();
    // More than 20,000 directories across two repositories, with both index and checkpoint stores.
    for (let batch = 0; batch < 101; batch += 1) {
      await Promise.all(Array.from({ length: 200 }, (_, index) => {
        const id = batch * 200 + index;
        return mkdir(join(root, 'repos', id % 2 ? 'one' : 'two', '.aiwg',
          id % 3 ? '.index' : 'checkpoints', String(id)), { recursive: true });
      }));
    }
    for (const name of ['one', 'two']) {
      await context(root, `repos/${name}/.git`, 'gitdir: /synthetic/worktree\n');
      await context(root, `repos/${name}/CLAUDE.md`, `${shared}\nUse ${name} conventions.\n`);
      await context(root, `repos/${name}/AGENTS.md`, `${shared}\nKeep ${name} changes focused.\n`);
    }
    const defaults = await (await doctor())(root);
    expect(defaults.some((item) => item.code === 'context-walk-truncated')).toBe(false);
    expect(defaults.filter((item) => item.code === 'duplicate-directive')).toHaveLength(2);
    vi.stubEnv('AIWG_CONTEXT_WALK_MAX_DEPTH', '30');
    vi.stubEnv('AIWG_CONTEXT_WALK_MAX_DIRECTORIES', '500000');
    vi.resetModules();
    expect(await (await doctor())(root)).toEqual(defaults);
  });

  it.each(['.index', 'fixtures', 'templates'])('prunes non-context %s trees before they consume the depth budget', async (store) => {
    const root = await fixture();
    await context(root, `repos/one/${store}/${'deep/'.repeat(12)}AGENTS.md`, 'Never load stored examples.\n');
    await context(root, 'repos/one/src/AGENTS.md', shared);
    const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-audit.js');
    const audit = await auditWorkspaceContext(root);
    expect(audit.contextWalkTruncated).toBe(false);
    expect(audit.plan.nestedSources).toEqual(['repos/one/src/AGENTS.md']);
  });

  it.each([
    ['AIWG_CONTEXT_WALK_MAX_DEPTH', 'depth', '2'],
    ['AIWG_CONTEXT_WALK_MAX_DIRECTORIES', 'directories', '2'],
  ])('names the %s bound, limit, skipped path and consuming subtree', async (variable, bound, limit) => {
    const root = await fixture();
    await context(root, 'repos/one/src/AGENTS.md', shared);
    vi.stubEnv(variable, limit);
    vi.resetModules();
    const finding = (await (await doctor())(root)).find((item) => item.code === 'context-walk-truncated');
    expect(finding?.message).toContain(`${bound}=${limit}`);
    expect(finding?.message).toContain('repos/one');
    expect(finding?.message).toContain('subtree repos');
  });
});

describe('duplicate-directive scope and boilerplate (#4263)', () => {
  const boilerplate = '# CLAUDE.md\n## Repository Purpose\n---\n--------\n@AIWG.md\n';

  it.each(['.git directory', '.git file', 'AIWG project'])('does not compare independent sibling repos marked by %s', async (marker) => {
    const root = await fixture();
    for (const name of ['one', 'two']) {
      const directory = join(root, 'repos', name);
      await mkdir(directory, { recursive: true });
      if (marker === '.git directory') await mkdir(join(directory, '.git'));
      if (marker === '.git file') await writeFile(join(directory, '.git'), 'gitdir: /synthetic/worktree\n');
      if (marker === 'AIWG project') await context(directory, '.aiwg/aiwg.config', '{}\n');
      // Include a real shared directive to prove repository separation independently of filtering.
      await context(directory, 'src/CLAUDE.md', `${boilerplate}${shared}\nUse ${name} conventions.\n`);
    }
    expect((await (await doctor())(root)).filter((item) => item.code === 'duplicate-directive')).toEqual([]);
  });

  it('ignores Markdown structure, managed content and required imports within one repository', async () => {
    const root = await fixture();
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      await context(root, file, `${boilerplate}Repository Purpose\n------------------\n`
        + '<!-- AIWG:provider-bootstrap:start -->\nKeep generated bootstrap policy.\n<!-- AIWG:provider-bootstrap:end -->\n');
    }
    expect((await (await doctor())(root)).filter((item) => item.code === 'duplicate-directive')).toEqual([]);
  });

  it('accepts intentional provider bridge stubs within one repository', async () => {
    const root = await fixture();
    const bridge = '# Provider workspace bootstrap\n'
      + 'Read and follow [WORKSPACE.md](./WORKSPACE.md) first.\n'
      + 'Then read [AIWG.md](./AIWG.md) for AIWG discovery, quickrefs, and framework routing.\n';
    await context(root, 'AGENTS.md', bridge);
    await context(root, 'CLAUDE.md', bridge);
    expect((await (await doctor())(root)).filter((item) => item.code === 'duplicate-directive')).toEqual([]);
  });

  it('still reports real duplicate directives within one repo AGENTS.md and CLAUDE.md', async () => {
    const root = await fixture();
    await context(root, 'AGENTS.md', `${boilerplate}${shared}\nUse agent conventions.\n`);
    await context(root, 'CLAUDE.md', `${boilerplate}${shared}\nUse Claude conventions.\n`);
    const findings = (await (await doctor())(root)).filter((item) => item.code === 'duplicate-directive');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning' });
    expect(findings[0].message).toContain('1 identical directive(s)');
    expect(findings[0].message).toContain('AGENTS.md, CLAUDE.md');
  });

  it('keeps ordinary subdirectories in the root load scope', async () => {
    const root = await fixture();
    await context(root, 'AGENTS.md', `${shared}\nUse root conventions.\n`);
    await context(root, 'packages/component/CLAUDE.md', `${shared}\nUse component conventions.\n`);
    expect((await (await doctor())(root)).filter((item) => item.code === 'duplicate-directive')).toHaveLength(1);
  });
});
