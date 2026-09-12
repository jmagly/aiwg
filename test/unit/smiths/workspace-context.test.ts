import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkspaceManagedBlock,
  WORKSPACE_MANAGED_END,
  WORKSPACE_MANAGED_START,
  WORKSPACE_OPERATOR_END,
  WORKSPACE_OPERATOR_START,
  PROJECT_EXTRACTION_END,
  PROJECT_EXTRACTION_START,
  auditWorkspaceContext,
  buildProviderBootstrapBlock,
  diagnoseWorkspaceContext,
  WORKSPACE_PRECEDENCE_SUPERSEDED,
  ensureWorkspaceContext,
  extractExistingProjectContext,
  migrateWorkspaceContext,
  providerContextContract,
  rollbackWorkspaceContext,
  workspaceLinkedFiles,
} from '../../../src/smiths/context-pipeline/workspace-context.js';
import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-workspace-context-'));
  roots.push(root);
  await mkdir(join(root, '.aiwg'), { recursive: true });
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('WORKSPACE.md canonical context graph (#1811)', () => {
  it('creates a managed graph and refreshes only the managed region', async () => {
    const root = await project();
    const created = await ensureWorkspaceContext(root);
    expect(created.action).toBe('created');
    let content = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(content).toContain(WORKSPACE_MANAGED_START);
    expect(content).toContain(WORKSPACE_OPERATOR_START);
    content = content.replace(WORKSPACE_OPERATOR_END, 'Operator convention: use fixtures.\n\n' + WORKSPACE_OPERATOR_END);
    await writeFile(join(root, 'WORKSPACE.md'), content);
    const refreshed = await ensureWorkspaceContext(root);
    expect(refreshed.action).toBe('unchanged');
    expect(await readFile(join(root, 'WORKSPACE.md'), 'utf8')).toContain('Operator convention: use fixtures.');
  });

  it('preserves dominant CRLF endings while refreshing managed blocks (#152)', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const workspacePath = join(root, 'WORKSPACE.md');
    const original = await readFile(workspacePath, 'utf8');
    const crlf = original
      .replace('This file is the canonical provider-neutral home', 'Stale managed text')
      .replace(/\n/g, '\r\n');
    await writeFile(workspacePath, crlf, 'utf8');

    const result = await ensureWorkspaceContext(root);
    const refreshed = await readFile(workspacePath, 'utf8');

    expect(result.action).toBe('updated');
    expect(refreshed).toContain('This file is the canonical provider-neutral home');
    expect(refreshed.match(/\r\n/g)?.length).toBe(refreshed.match(/\n/g)?.length);
  });

  it('uses the majority line ending for a mixed WORKSPACE.md (#152)', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const workspacePath = join(root, 'WORKSPACE.md');
    const original = await readFile(workspacePath, 'utf8');
    const mixed = original.replace(/\n/g, '\r\n').replace('\r\n', '\n');
    await writeFile(workspacePath, mixed.replace('This file is the canonical provider-neutral home', 'Stale managed text'), 'utf8');

    await ensureWorkspaceContext(root);
    const refreshed = await readFile(workspacePath, 'utf8');
    expect((refreshed.match(/\r\n/g)?.length ?? 0)).toBeGreaterThan(
      (refreshed.match(/(?<!\r)\n/g)?.length ?? 0),
    );
  });

  it('links repository control files locally when the artifact corpus is external', async () => {
    const root = await project();
    await writeFile(join(root, '.aiwg-location'), '../private-corpus/.aiwg\n');
    await ensureWorkspaceContext(root);
    const content = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(content).toContain('[AIWG project configuration](.aiwg/aiwg.config)');
    expect(content).not.toContain('../private-corpus/.aiwg/aiwg.config');
    expect(content).toContain('[Project-local quickref](.aiwg/quickref.json)');
    expect(content).not.toContain('../private-corpus/.aiwg/quickref.json');
    expect(content).toContain('run `aiwg artifacts path --json --check-write`');
    expect(content).toContain('Only `AIWG.md`, `aiwg.config`, and `frameworks/registry.json`');
    expect(content).toContain('never fall back to repository-local payload');
  });

  it('has an explicit, honest bootstrap contract for every registered provider', () => {
    for (const provider of listProviderDefinitions()) {
      const contract = providerContextContract(provider.id);
      expect(contract).toBeDefined();
      expect(contract?.verification.source).toBeTruthy();
      const bootstrap = buildProviderBootstrapBlock(provider.id);
      if (contract?.loadMode === 'native-include') {
        const prefix = provider.id === 'omp' ? '@../' : '@';
        expect(bootstrap).toContain(`${prefix}WORKSPACE.md`);
        expect(bootstrap.indexOf(`${prefix}WORKSPACE.md`)).toBeLessThan(bootstrap.indexOf(`${prefix}AIWG.md`));
      } else if (contract?.loadMode === 'unsupported') {
        expect(bootstrap).toContain('no verified project-local automatic context loader');
      } else {
        expect(bootstrap.indexOf('WORKSPACE.md')).toBeLessThan(bootstrap.indexOf('AIWG.md'));
      }
    }
    for (const surface of ['claude', 'codex', 'copilot', 'cursor', 'factory', 'opencode', 'warp', 'windsurf', 'devin-desktop', 'hermes', 'openclaw', 'openhuman']) {
      expect(buildProviderBootstrapBlock(surface)).toContain('Provider workspace bootstrap');
    }
  });

  // #2512 — the generated precedence ranked provider/harness instructions above
  // AIWG, so a session directive claiming to supersede earlier guidance beat a
  // rule marked CRITICAL with "Exceptions: None". Rule authority is now asserted
  // in the bootstrap file the harness reads first, not left to be inferred.
  describe('AIWG rule authority in the bootstrap', () => {
    it('asserts rule authority in every provider bootstrap block', () => {
      for (const provider of listProviderDefinitions()) {
        const bootstrap = buildProviderBootstrapBlock(provider.id);
        expect(bootstrap, `${provider.id} bootstrap must assert rule authority`)
          .toContain('AIWG rules deployed to this project are binding');
        expect(bootstrap, `${provider.id} bootstrap must name directive supersession`)
          .toMatch(/claim to supersede earlier\s+guidance/);
        expect(bootstrap, `${provider.id} bootstrap must preserve platform constraints`)
          .toContain('Platform capability and safety constraints remain absolute');
      }
    });

    it('asserts rule authority for providers with no automatic loader', () => {
      const bootstrap = buildProviderBootstrapBlock('not-a-real-provider');
      expect(bootstrap).toContain('AIWG rules deployed to this project are binding');
      expect(bootstrap).toContain('Platform capability and safety constraints remain absolute');
    });

    it('ranks AIWG rules above harness directives and below platform constraints', () => {
      const managed = buildWorkspaceManagedBlock('/tmp/example-project');
      const constraints = managed.indexOf('Platform capability and safety constraints are absolute');
      const rules = managed.indexOf('AIWG rules deployed to this project bind over');
      const workspace = managed.indexOf('Root WORKSPACE.md supplies shared project/operator context');

      expect(constraints).toBeGreaterThan(-1);
      expect(rules).toBeGreaterThan(-1);
      // Ordering is the contract: constraints, then AIWG rules, then context.
      expect(constraints).toBeLessThan(rules);
      expect(rules).toBeLessThan(workspace);
      // The old ordering must not come back.
      expect(managed).not.toContain('Provider, system, and organization instructions retain their native authority.');
    });

    it('keeps the capability-versus-directive distinction explicit', () => {
      const managed = buildWorkspaceManagedBlock('/tmp/example-project');
      expect(managed).toContain('capability versus preference');
      expect(managed).toContain('follow the rule and say plainly that you did');
    });

    // #2513 — the line filter dropped lines starting with `<` but not the
    // continuation of a tag that wrapped, so a hero anchor's alt text became
    // the project purpose in the first file every bootstrap loads.
    it('does not take wrapped HTML markup as the project purpose', async () => {
      const root = await project();
      await writeFile(join(root, 'README.md'), [
        '<div align="center">',
        '',
        '<a href="https://example.invalid"><img src="hero.png" alt="Example — one',
        'source of truth; connecting tools" width="1000"></a>',
        '',
        '# Example',
        '',
        '**The real one-line purpose of this project.**',
        '',
      ].join('\n'));

      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));

      const { content } = await extractExistingProjectContext(root);

      expect(content).toContain('The real one-line purpose of this project.');
      expect(content).not.toContain('width="1000"');
      expect(content).not.toContain('</a>');
      expect(content).not.toContain('source of truth; connecting tools');
    });

    // #2512 — the diagnostic checked that bootstrap files point AT WORKSPACE.md
    // but never that the policy inside it was current, so a workspace on the
    // superseded precedence read as healthy and nothing prompted a regenerate.
    it('flags a workspace still carrying the superseded precedence', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      const workspacePath = join(root, 'WORKSPACE.md');
      const current = await readFile(workspacePath, 'utf8');
      await writeFile(
        workspacePath,
        current.replace(
          /1\. Platform capability[\s\S]*?within the ceiling set above\./,
          `1. ${WORKSPACE_PRECEDENCE_SUPERSEDED}`,
        ),
      );

      const codes = (await diagnoseWorkspaceContext(root)).map((item) => item.code);
      expect(codes).toContain('precedence-superseded');
    });

    it('flags a bootstrap file that does not assert rule authority', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['claude'], installed: {}, scripts: {},
      }));
      const claudeMd = join(root, 'CLAUDE.md');
      await writeFile(claudeMd, buildProviderBootstrapBlock('claude')
        .replace(/AIWG rules deployed to this project are binding[\s\S]*?distinction\./, ''));

      const codes = (await diagnoseWorkspaceContext(root)).map((item) => item.code);
      expect(codes).toContain('authority-missing');
    });

    it('reports no policy drift for a freshly generated workspace', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['claude'], installed: {}, scripts: {},
      }));
      await writeFile(join(root, 'CLAUDE.md'), buildProviderBootstrapBlock('claude'));

      const codes = (await diagnoseWorkspaceContext(root)).map((item) => item.code);
      expect(codes).not.toContain('precedence-superseded');
      expect(codes).not.toContain('precedence-missing');
      expect(codes).not.toContain('authority-missing');
    });
  });

  it('classifies identical directives, polarity conflicts, possible secrets, and nested scope', async () => {
    const root = await project();
    await writeFile(join(root, 'AGENTS.md'), 'Always use fixtures.\nUse tabs for indentation.\n');
    await writeFile(join(root, 'CLAUDE.md'), 'Always use fixtures.\nNever use tabs for indentation.\ntoken=abcdefghijklmnopqrstuvwxyz\n');
    await mkdir(join(root, 'packages', 'one'), { recursive: true });
    await writeFile(join(root, 'packages', 'one', 'AGENTS.md'), 'Use package-local tests.\n');
    await mkdir(join(root, 'templates', 'project'), { recursive: true });
    await writeFile(join(root, 'templates', 'project', 'CLAUDE.md'), 'Generated template instructions.\n');
    const audit = await auditWorkspaceContext(root);
    expect(audit.identical.some((item) => item.directives.includes('Always use fixtures.'))).toBe(true);
    expect(audit.conflicts.some((item) => item.key.includes('tabs'))).toBe(true);
    expect(audit.sensitiveFindings).toHaveLength(1);
    expect(audit.plan.nestedSources).toContain('packages/one/AGENTS.md');
    expect(audit.plan.nestedSources).not.toContain('templates/project/CLAUDE.md');
  });

  it('supports deterministic dry-run, apply, idempotence, attribution, and rollback', async () => {
    const root = await project();
    await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['claude', 'opencode'] }));
    await writeFile(join(root, 'AGENTS.md'), 'Use provider-specific Codex checks.\n');
    const dryRun = await migrateWorkspaceContext(root, { dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.written).toContain('WORKSPACE.md');
    const applied = await migrateWorkspaceContext(root, { apply: true });
    expect(applied.transactionId).toBeTruthy();
    const providerPath = join(root, '.aiwg', 'context', 'providers', 'AGENTS.md');
    expect(await readFile(providerPath, 'utf8')).toContain('Source attribution: migrated from `AGENTS.md`');
    const second = await migrateWorkspaceContext(root, { apply: true });
    expect(second.changed).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8')).instructions).toEqual(['WORKSPACE.md', 'AIWG.md']);
    await rollbackWorkspaceContext(root, applied.transactionId);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('Use provider-specific Codex checks.\n');
  });

  it('extracts stable existing-project metadata into a replaceable attributed block', async () => {
    const root = await project();
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-app',
      description: 'A deterministic fixture application for context extraction.',
      packageManager: 'npm@10.9.0',
      engines: { node: '>=20.0.0' },
      scripts: { build: 'tsc', test: 'vitest', private: 'do-not-copy' },
    }));
    await writeFile(join(root, 'README.md'), '# Fixture\n\nA small application used to verify project context extraction.\n');
    await writeFile(join(root, 'tsconfig.json'), '{}\n');
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'test'));
    await mkdir(join(root, '.gitea', 'workflows'), { recursive: true });
    await writeFile(join(root, '.gitea', 'workflows', 'ci.yml'), 'name: CI\n');

    const first = await extractExistingProjectContext(root);
    const second = await extractExistingProjectContext(root);
    expect(second).toEqual(first);
    expect(first.content).toContain(PROJECT_EXTRACTION_START);
    expect(first.content).toContain(PROJECT_EXTRACTION_END);
    expect(first.content).toContain('`node >=20.0.0`');
    expect(first.content).toContain('### Stack and Tooling');
    expect(first.content).toContain('### Architecture and Topology');
    expect(first.content).toContain('### Testing');
    expect(first.content).toContain('### Continuous Integration');
    expect(first.content).toContain('`npm run build`');
    expect(first.content).not.toContain('do-not-copy');
  });

  it('refreshes an existing README-derived extraction during normal regeneration (#1866)', async () => {
    const root = await project();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    await writeFile(
      join(root, 'README.md'),
      '# Fixture\n\nPublic project purpose with reusable tooling maintained for the fixture team.\n',
    );
    const extracted = await extractExistingProjectContext(root);
    const operatorBefore = 'Operator preface: preserve this byte-for-byte.';
    const operatorAfter = 'Operator suffix: preserve this too.';
    await writeFile(
      join(root, 'WORKSPACE.md'),
      [
        '# WORKSPACE.md',
        '<!-- aiwg-managed -->',
        '<!-- Generated structure by AIWG; operator content is protected by markers. -->',
        '',
        WORKSPACE_MANAGED_START,
        'stale managed content',
        WORKSPACE_MANAGED_END,
        '',
        WORKSPACE_OPERATOR_START,
        '',
        operatorBefore,
        '',
        extracted.content,
        '',
        operatorAfter,
        '',
        WORKSPACE_OPERATOR_END,
        '',
      ].join('\n'),
    );

    await writeFile(
      join(root, 'README.md'),
      '# Fixture\n\nPrivate project purpose with reusable tooling maintained for the fixture team.\n',
    );
    const result = await ensureWorkspaceContext(root);
    const refreshed = await readFile(join(root, 'WORKSPACE.md'), 'utf8');

    expect(result.action).toBe('updated');
    expect(refreshed).toContain('Private project purpose');
    expect(refreshed).not.toContain('Public project purpose');
    expect(refreshed).toContain(operatorBefore);
    expect(refreshed).toContain(operatorAfter);
  });

  it('adopts an existing project transactionally while preserving provider context and active Codex startup', async () => {
    const root = await project();
    await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['codex', 'claude'] }));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'existing-app', scripts: { test: 'vitest' } }));
    await writeFile(join(root, 'README.md'), '# Existing\n\nAn established application with operator-owned provider guidance.\n');
    const originalOverride = [
      '# Local operator context',
      '',
      'Always run the fixture checks.',
      '',
      '<!-- spillover-from-AGENTS.md:START -->',
      'Generated framework listing that must not migrate.',
      '<!-- spillover-from-AGENTS.md:END -->',
      '',
    ].join('\n');
    await writeFile(join(root, 'AGENTS.override.md'), originalOverride);
    const originalClaude = '# Claude project notes\n\nPreserve the integration fixtures.\n';
    await writeFile(join(root, 'CLAUDE.md'), originalClaude);
    await writeFile(join(root, 'AIWG.md'), '# AIWG Framework Context\n<!-- Generated by aiwg use — do not edit manually -->\nGenerated body.\n');

    const dryRun = await migrateWorkspaceContext(root, {
      dryRun: true, extractProject: true, includeGeneratedContext: true,
    });
    expect(dryRun.written).toContain('WORKSPACE.md');
    expect(await readFile(join(root, 'AGENTS.override.md'), 'utf8')).toBe(originalOverride);
    await expect(readFile(join(root, 'WORKSPACE.md'), 'utf8')).rejects.toThrow();

    const applied = await migrateWorkspaceContext(root, {
      apply: true, extractProject: true, includeGeneratedContext: true,
    });
    const workspace = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(workspace).toContain('## Existing Project Snapshot');
    expect(workspace).toContain('existing-app');
    expect(workspace).not.toContain('Generated framework listing');
    const providerContext = await readFile(join(root, '.aiwg', 'context', 'providers', 'AGENTS.override.md'), 'utf8');
    expect(providerContext).toContain('Always run the fixture checks.');
    expect(providerContext).not.toContain('Generated framework listing');
    expect(await readFile(join(root, 'AGENTS.override.md'), 'utf8')).toContain('WORKSPACE.md');
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('@WORKSPACE.md');
    expect(applied.written).not.toContain('.aiwg/context/providers/AIWG.md');
    expect((await diagnoseWorkspaceContext(root)).some((item) => item.severity === 'error')).toBe(false);

    const repeated = await migrateWorkspaceContext(root, {
      apply: true, extractProject: true, includeGeneratedContext: true,
    });
    expect(repeated.changed).toBe(false);

    await rollbackWorkspaceContext(root, applied.transactionId);
    expect(await readFile(join(root, 'AGENTS.override.md'), 'utf8')).toBe(originalOverride);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(originalClaude);
    await expect(readFile(join(root, 'WORKSPACE.md'), 'utf8')).rejects.toThrow();
  });

  it('keeps provider startup roots out of neutral extraction even when directives overlap', async () => {
    const root = await project();
    await writeFile(join(root, 'CLAUDE.md'), '# Provider body\n\nAlways use fixtures.\n\n' + 'Framework detail.\n'.repeat(400));
    await writeFile(join(root, 'AGENTS.override.md'), 'Always use fixtures.\n');
    const audit = await auditWorkspaceContext(root);
    expect(audit.plan.neutralSources).toEqual([]);
    expect(audit.plan.providerSources).toContain('CLAUDE.md');
    expect(audit.plan.providerSources).toContain('AGENTS.override.md');
  });

  it('redacts possible credentials from audit output and refuses extraction without writes', async () => {
    const root = await project();
    const sentinel = 'sentinel-secret-value-123456789';
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'unsafe-app', description: `token=${sentinel}`,
    }));
    const audit = await auditWorkspaceContext(root);
    expect(audit.sensitiveFindings).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(sentinel);
    await expect(migrateWorkspaceContext(root, {
      apply: true, extractProject: true, includeGeneratedContext: true,
    })).rejects.toThrow('possible secret');
    await expect(readFile(join(root, 'WORKSPACE.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses rollback when post-migration work would be overwritten', async () => {
    const root = await project();
    await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['codex'] }));
    await writeFile(join(root, 'AGENTS.md'), 'Use local checks.\n');
    const applied = await migrateWorkspaceContext(root, { apply: true });
    await writeFile(join(root, 'WORKSPACE.md'), 'operator changed this after migration\n');
    await expect(rollbackWorkspaceContext(root, applied.transactionId)).rejects.toThrow('changed after migration');
  });

  it('discovers linked files and diagnoses drift without copying content', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    await writeFile(join(root, 'AIWG.md'), '# AIWG\n');
    await writeFile(join(root, 'AGENTS.md'), '<!-- aiwg-managed -->\n# drifted\n');
    await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ providers: ['codex'] }));
    const linked = await workspaceLinkedFiles(root);
    expect(linked).toContain(join(root, 'AIWG.md'));
    const diagnostics = await diagnoseWorkspaceContext(root);
    expect(diagnostics.some((item) => item.code === 'bootstrap-drift')).toBe(true);
    const workspace = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(workspace).toContain(WORKSPACE_MANAGED_END);
    expect(workspace).not.toContain('# AIWG\n');
  });

  it('indexes WORKSPACE.md and its linked project files as graph nodes', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    await writeFile(join(root, 'AIWG.md'), '# Linked AIWG context\n');
    await buildIndex(root, { force: true });
    const index = JSON.parse(await readFile(join(root, '.aiwg', '.index', 'metadata.json'), 'utf8')) as { entries: Record<string, unknown> };
    expect(index.entries).toHaveProperty('WORKSPACE.md');
    expect(index.entries).toHaveProperty('AIWG.md');
  });
});
