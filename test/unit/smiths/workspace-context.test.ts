import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  shouldSkipContextWalkDir,
  workspaceLinkedFiles,
  providerCopiesStatus,
  RESIDENT_MEMORY_START,
  RESIDENT_MEMORY_END,
} from '../../../src/smiths/context-pipeline/workspace-context.js';
import { CanonicalContextRepository } from '../../../src/memory/canonical-context.js';
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

describe('project extraction CI section (#3451)', () => {
  it('points at the workflow directories with counts instead of listing every workflow file', async () => {
    const root = await project();
    await writeFile(join(root, 'package.json'), '{"name":"fx"}');
    for (const dir of ['.gitea/workflows', '.github/workflows']) {
      await mkdir(join(root, dir), { recursive: true });
      for (let i = 0; i < 7; i++) await writeFile(join(root, dir, `wf-${i}.yml`), 'on: push\n');
    }
    const { content } = await extractExistingProjectContext(root);
    const ci = content.slice(content.indexOf('### Continuous Integration'));
    expect(ci).toContain('[`.gitea/workflows/`](./.gitea/workflows/) (7 workflow files)');
    expect(ci).toContain('[`.github/workflows/`](./.github/workflows/) (7 workflow files)');
    expect(ci).not.toContain('wf-0.yml');
  });
});

describe('WORKSPACE.md canonical context graph (#1811)', () => {
  it('renders from the resolved canonical artifact store rather than a repository-local stale copy', async () => {
    const root = await project();
    const proposal = { target: 'decision' as const, key: 'startup.fixture', value: 'Old local resident fact.',
      sourceRef: 'decision.md', sourceDigest: null, reviewer: 'operator', reason: 'Reviewed fixture',
      scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
    const local = new CanonicalContextRepository(root);
    local.confirm({ preview: local.previewUpsert(proposal), proposal });
    const corpus = await project();
    await writeFile(join(root, '.aiwg-location'), corpus);
    // An unmoved repository-local store blocks regeneration instead of being silently hidden.
    await expect(ensureWorkspaceContext(root)).rejects.toThrow(/repository-local path .*Move that directory/);
    await mkdir(join(corpus, 'context'), { recursive: true });
    await cp(join(root, '.aiwg/context/compound-memory'), join(corpus, 'context/compound-memory'), { recursive: true });
    const resolved = new CanonicalContextRepository(root);
    const current = { ...proposal, value: 'Current fact from the resolved corpus.' };
    resolved.confirm({ preview: resolved.previewUpsert(current), proposal: current });
    await ensureWorkspaceContext(root);
    const emitted = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(emitted).toContain(current.value); expect(emitted).not.toContain(proposal.value);
    expect(await providerCopiesStatus(root)).toMatchObject({ status: 'current' });
  });

  it('checks emitted digests, normalizes CRLF, and detects tampered or malformed resident blocks without writes', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const before = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    const repository = new CanonicalContextRepository(root);
    const proposal = { target: 'decision' as const, key: 'startup.fixture', value: `Synthetic reviewed fact.\n${RESIDENT_MEMORY_END}`,
      sourceRef: 'decision.md', sourceDigest: null, reviewer: 'operator', reason: 'Reviewed fixture',
      scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
    repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
    expect(await providerCopiesStatus(root)).toMatchObject({ status: 'stale' });
    expect(await readFile(join(root, 'WORKSPACE.md'), 'utf8')).toBe(before);
    await ensureWorkspaceContext(root);
    const rendered = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(rendered.split(RESIDENT_MEMORY_END)).toHaveLength(2);
    expect(rendered).toContain('&lt;!-- AIWG:resident-memory:end --&gt;');
    await writeFile(join(root, 'WORKSPACE.md'), rendered.replace(/\n/g, '\r\n'));
    expect(await providerCopiesStatus(root)).toMatchObject({ status: 'current' });
    for (const changed of [rendered.replace('Synthetic reviewed fact.', 'Edited fact.'), rendered.replace(RESIDENT_MEMORY_END, ''),
      rendered + RESIDENT_MEMORY_START, rendered.replace(RESIDENT_MEMORY_START, '')]) {
      await writeFile(join(root, 'WORKSPACE.md'), changed);
      expect(await providerCopiesStatus(root)).toMatchObject({ status: 'stale' });
      expect(await readFile(join(root, 'WORKSPACE.md'), 'utf8')).toBe(changed);
    }
  });

  it('enforces the existing configured resident inline budget before writing output', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const before = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    const repository = new CanonicalContextRepository(root);
    const proposal = { target: 'decision' as const, key: 'startup.fixture', value: 'A reviewed synthetic resident fact.',
      sourceRef: 'decision.md', sourceDigest: null, reviewer: 'operator', reason: 'Reviewed fixture',
      scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
    repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', rules: { inline_budget_tokens: 1 } }));
    await expect(ensureWorkspaceContext(root)).rejects.toThrow(/exceeds rules.inline_budget_tokens/);
    expect(await readFile(join(root, 'WORKSPACE.md'), 'utf8')).toBe(before);
    expect(await providerCopiesStatus(root)).toMatchObject({ status: 'stale' });
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', rules: { inline_budget_tokens: 0 } }));
    await ensureWorkspaceContext(root);
    expect(await providerCopiesStatus(root)).toMatchObject({ status: 'current' });
  });

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
    expect(content).toContain('Only `aiwg.config`, `frameworks/registry.json`, and optional operator-only `AIWG.md` notes');
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
    for (const surface of ['claude', 'codex', 'copilot', 'cursor', 'factory', 'muse', 'opencode', 'warp', 'devin', 'devin-desktop', 'hermes', 'openclaw', 'openhuman', 'grokbot']) {
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

    it('ignores relative paths inside fenced code blocks and inline code spans (#2536)', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      const workspacePath = join(root, 'WORKSPACE.md');
      const current = await readFile(workspacePath, 'utf8');
      await writeFile(workspacePath, current.replace(WORKSPACE_OPERATOR_END, [
        'Add the citation network link to the analysis document:',
        '',
        '```',
        'Citation network: [REF-XXX-citations.md](../citations/REF-XXX-citations.md)',
        '```',
        '',
        '~~~markdown',
        'Sidecar: [REF-YYY.md](../../elsewhere/REF-YYY.md)',
        '~~~',
        '',
        'Inline example: `[escaped](../inline/escape.md)` stays documentation.',
        '',
        WORKSPACE_OPERATOR_END,
      ].join('\n')));

      const diagnostics = await diagnoseWorkspaceContext(root);
      expect(diagnostics.map((item) => item.code)).not.toContain('unsafe-link');
      expect(diagnostics.some((item) => item.severity === 'error')).toBe(false);
    });

    it('still flags an unfenced relative path that escapes the project (#2536)', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      const workspacePath = join(root, 'WORKSPACE.md');
      const current = await readFile(workspacePath, 'utf8');
      await writeFile(workspacePath, current.replace(WORKSPACE_OPERATOR_END, [
        'Real link: [outside](../outside/escape.md)',
        '',
        WORKSPACE_OPERATOR_END,
      ].join('\n')));

      const codes = (await diagnoseWorkspaceContext(root)).map((item) => item.code);
      expect(codes).toContain('unsafe-link');
    });

    it('surfaces a provider-named source carrying substantial operator content for scope review (#2537)', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['claude'], installed: {}, scripts: {},
      }));
      // The reported case: CLAUDE.md used as the project's main context file,
      // carrying a project-neutral artifact contract rather than Claude specifics.
      const contract = ['# Corpus contract', '', 'Induction pipeline, naming conventions, GRADE scheme.', ''].join('\n')
        + 'Verification discipline and housekeeping cadence. '.repeat(400);
      await writeFile(join(root, 'CLAUDE.md'), `${buildProviderBootstrapBlock('claude')}\n\n${contract}`);

      const audit = await auditWorkspaceContext(root);
      const claudeRoute = audit.plan.routing.find((entry) => entry.source === 'CLAUDE.md');
      expect(claudeRoute).toBeDefined();
      // Startup files are bootstrap surfaces; their operator content ports into
      // WORKSPACE.md, which every provider loads (#2558). The substantial body is
      // still surfaced for review so provider-only parts can be moved afterwards.
      expect(claudeRoute?.scope).toBe('project-neutral');
      expect(claudeRoute?.destination).toBe('WORKSPACE.md');
      expect(claudeRoute?.provider).toBe('claude');
      expect(claudeRoute?.operatorBytes).toBeGreaterThan(4096);
      expect(audit.plan.scopeReview.map((entry) => entry.source)).toContain('CLAUDE.md');
    });

    it('does not flag a small provider adapter for scope review (#2537)', async () => {
      const root = await project();
      await ensureWorkspaceContext(root);
      await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
        version: '1', providers: ['claude'], installed: {}, scripts: {},
      }));
      await writeFile(join(root, 'CLAUDE.md'), `${buildProviderBootstrapBlock('claude')}\n\nPrefer the Bash tool for file edits.\n`);

      const audit = await auditWorkspaceContext(root);
      expect(audit.plan.scopeReview).toHaveLength(0);
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
    const workspace = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(workspace).toContain('Source attribution: migrated from `AGENTS.md`');
    expect(workspace).toContain('Use provider-specific Codex checks.');
    await expect(readFile(join(root, '.aiwg', 'context', 'providers', 'AGENTS.md'), 'utf8')).rejects.toThrow();
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
    // Operator content from the startup files lands in the WORKSPACE.md
    // operator block, verbatim and attributed, not in an unloaded side file (#2558).
    expect(workspace).toContain('### Migrated from AGENTS.override.md');
    expect(workspace).toContain('Always run the fixture checks.');
    expect(workspace).toContain('### Migrated from CLAUDE.md');
    expect(workspace).toContain('Preserve the integration fixtures.');
    await expect(readFile(join(root, '.aiwg', 'context', 'providers', 'AGENTS.override.md'), 'utf8')).rejects.toThrow();
    expect(applied.written).not.toContain('.aiwg/context/providers/AGENTS.override.md');
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

  it('ports every provider startup root into WORKSPACE.md and writes no provider side files (#2558)', async () => {
    const root = await project();
    await writeFile(join(root, 'CLAUDE.md'), '# Provider body\n\nAlways use fixtures.\n\n' + 'Framework detail.\n'.repeat(400));
    await writeFile(join(root, 'AGENTS.override.md'), 'Always use fixtures.\n');
    const audit = await auditWorkspaceContext(root);
    expect(audit.plan.neutralSources).toEqual(expect.arrayContaining(['CLAUDE.md', 'AGENTS.override.md']));
    expect(audit.plan.providerSources).toEqual([]);
    expect(audit.plan.outputs.some((output) => output.includes('/context/providers/'))).toBe(false);
  });

  it('ports operator runbook content verbatim, preserving tables and code blocks (#2558)', async () => {
    const root = await project();
    const runbook = [
      '# Ops notes',
      '',
      '| Host | Role |',
      '|------|------|',
      '| gateway-01 | edge |',
      '',
      '```bash',
      'systemctl status nginx',
      '```',
      '',
      'Always confirm before restarting services.',
      '',
    ].join('\n');
    await writeFile(join(root, 'CLAUDE.md'), runbook);
    const applied = await migrateWorkspaceContext(root, { apply: true });
    const workspace = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(applied.written).toContain('WORKSPACE.md');
    expect(workspace).toContain('| gateway-01 | edge |');
    expect(workspace).toContain('systemctl status nginx');
    expect(workspace).toContain('### Migrated from CLAUDE.md');
    expect(workspace).not.toContain('- | Host | Role |');
    expect(workspace.indexOf('<!-- AIWG:workspace-operator:start -->')).toBeLessThan(workspace.indexOf('| gateway-01 | edge |'));

    // Idempotent: a second migration does not duplicate the ported body.
    const repeated = await migrateWorkspaceContext(root, { apply: true });
    expect(repeated.changed).toBe(false);
    expect((await readFile(join(root, 'WORKSPACE.md'), 'utf8')).split('| gateway-01 | edge |')).toHaveLength(2);
  });

  it('keeps migrated provider context linked across regeneration and reports it as not auto-loaded (#2558)', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const providerDir = join(root, '.aiwg', 'context', 'providers');
    await mkdir(providerDir, { recursive: true });
    await writeFile(join(providerDir, 'CLAUDE.md'), '# Provider-specific context from CLAUDE.md\n\nUse the Bash tool for edits.\n');

    // `aiwg use` / `aiwg regenerate` rebuild the managed block without passing providerFiles.
    const refreshed = await ensureWorkspaceContext(root);
    expect(refreshed.action).toBe('updated');
    const workspace = await readFile(join(root, 'WORKSPACE.md'), 'utf8');
    expect(workspace).toContain('[Provider-specific context](./.aiwg/context/providers/CLAUDE.md)');
    const again = await ensureWorkspaceContext(root);
    expect(again.action).toBe('unchanged');

    const diagnostics = await diagnoseWorkspaceContext(root);
    const unloaded = diagnostics.find((item) => item.code === 'provider-context-not-loaded');
    expect(unloaded?.severity).toBe('info');
    expect(unloaded?.path).toBe('.aiwg/context/providers/CLAUDE.md');
  });

  it('reports identical shared stubs once per file pair as informational, not once per line (#2558)', async () => {
    const root = await project();
    await ensureWorkspaceContext(root);
    const providerDir = join(root, '.aiwg', 'context', 'providers');
    await mkdir(providerDir, { recursive: true });
    const stub = [
      'Operator context now lives in WORKSPACE.md.',
      'Read the Project Context section there first.',
      'Never store credentials in provider files.',
      'Prefer the canonical workspace graph over provider copies.',
    ].join('\n');
    await writeFile(join(providerDir, 'CLAUDE.md'), stub);
    await writeFile(join(providerDir, 'AGENTS.override.md'), stub);

    const diagnostics = await diagnoseWorkspaceContext(root);
    const duplicates = diagnostics.filter((item) => item.code === 'duplicate-directive');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].severity).toBe('info');
    expect(duplicates[0].message).toContain('4 directive(s)');
    expect(diagnostics.some((item) => item.severity === 'warning' && item.code === 'duplicate-directive')).toBe(false);
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

  // #277 fix-round — exclusions are contextual, not blanket by-name. A
  // non-home project root is NOT subject to the home-level cache list at
  // all: a real project subtree merely named `.cache`, `.cargo`, or `Trash`
  // must still be scanned. `target`/`venv` are only skipped when they carry
  // their tool's marker file; `node_modules` is always skipped.
  it('always skips node_modules, but scans generically-named directories that lack a real project root marker (non-home root)', async () => {
    const root = await project();
    await writeFile(join(root, 'AGENTS.md'), 'Root instructions.\n');

    // node_modules is always skipped, regardless of markers.
    await mkdir(join(root, 'node_modules', 'some-pkg', 'nested'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'some-pkg', 'nested', 'AGENTS.md'), 'Should never be found.\n');

    // These names are only skipped at $HOME (see workspace-context-home-walk
    // test for that case) — on an ordinary project root they are real
    // directories and must be scanned.
    const scannableDirs = [
      ['.cache', 'act', 'deep'],
      ['.cargo', 'registry', 'src'],
      ['Trash', 'deleted-project'],
    ];
    for (const segments of scannableDirs) {
      await mkdir(join(root, ...segments), { recursive: true });
      await writeFile(join(root, ...segments, 'AGENTS.md'), 'Should be found.\n');
    }

    const audit = await auditWorkspaceContext(root);
    const foundPaths = audit.sources.map((source) => source.path);
    expect(foundPaths).not.toContain('node_modules/some-pkg/nested/AGENTS.md');
    expect(foundPaths).toContain('.cache/act/deep/AGENTS.md');
    expect(foundPaths).toContain('.cargo/registry/src/AGENTS.md');
    expect(foundPaths).toContain('Trash/deleted-project/AGENTS.md');
  });

  it('skips target/ only when it carries a Cargo/CACHEDIR marker, not merely by name', async () => {
    const root = await project();
    await writeFile(join(root, 'AGENTS.md'), 'Root instructions.\n');

    // A real project directory named `target` with no Cargo/CACHEDIR marker
    // must still be scanned.
    await mkdir(join(root, 'target', 'docs'), { recursive: true });
    await writeFile(join(root, 'target', 'docs', 'AGENTS.md'), 'Should be found.\n');

    // A genuine Cargo build-output `target/` (sibling Cargo.toml) must be skipped.
    await mkdir(join(root, 'crate', 'target', 'debug'), { recursive: true });
    await writeFile(join(root, 'crate', 'Cargo.toml'), '[package]\nname = "x"\n');
    await writeFile(join(root, 'crate', 'target', 'debug', 'AGENTS.md'), 'Should never be found.\n');

    // A CACHEDIR.TAG-marked target/ must also be skipped even with no Cargo.toml.
    await mkdir(join(root, 'other', 'target', 'deep'), { recursive: true });
    await writeFile(join(root, 'other', 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    await writeFile(join(root, 'other', 'target', 'deep', 'AGENTS.md'), 'Should never be found.\n');

    const audit = await auditWorkspaceContext(root);
    const foundPaths = audit.sources.map((source) => source.path);
    expect(foundPaths).toContain('target/docs/AGENTS.md');
    expect(foundPaths).not.toContain('crate/target/debug/AGENTS.md');
    expect(foundPaths).not.toContain('other/target/deep/AGENTS.md');
  });

  it('skips venv//.venv only when it carries pyvenv.cfg, not merely by name', async () => {
    const root = await project();
    await writeFile(join(root, 'AGENTS.md'), 'Root instructions.\n');

    // A real project directory named `venv` with no pyvenv.cfg must still be scanned.
    await mkdir(join(root, 'venv', 'docs'), { recursive: true });
    await writeFile(join(root, 'venv', 'docs', 'AGENTS.md'), 'Should be found.\n');

    // A genuine Python virtualenv (pyvenv.cfg present) must be skipped.
    await mkdir(join(root, 'repo', '.venv', 'lib', 'site-packages'), { recursive: true });
    await writeFile(join(root, 'repo', '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    await writeFile(join(root, 'repo', '.venv', 'lib', 'site-packages', 'AGENTS.md'), 'Should never be found.\n');

    const audit = await auditWorkspaceContext(root);
    const foundPaths = audit.sources.map((source) => source.path);
    expect(foundPaths).toContain('venv/docs/AGENTS.md');
    expect(foundPaths).not.toContain('repo/.venv/lib/site-packages/AGENTS.md');
  });

  it('scans a markerless (no .git/.aiwg-config/package.json) monorepo root with the full bounded walk, not depth 1', async () => {
    const root = await project(); // project() only creates an empty .aiwg/ dir — no aiwg.config, no package.json, no .git
    await mkdir(join(root, 'packages', 'one', 'deeply', 'nested'), { recursive: true });
    await writeFile(join(root, 'packages', 'one', 'deeply', 'nested', 'AGENTS.md'), 'Nested package instructions.\n');

    const audit = await auditWorkspaceContext(root);
    expect(audit.plan.nestedSources).toContain('packages/one/deeply/nested/AGENTS.md');
    expect(audit.contextWalkTruncated).toBe(false);
  });

  it('does not follow a directory symlink out of the project root', async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), 'aiwg-workspace-context-outside-'));
    try {
      await mkdir(join(outside, 'escaped'), { recursive: true });
      await writeFile(join(outside, 'escaped', 'AGENTS.md'), 'Should never be found — outside the project root.\n');
      await symlink(outside, join(root, 'linked-outside'), 'dir');

      const audit = await auditWorkspaceContext(root);
      const foundPaths = audit.sources.map((source) => source.path);
      expect(foundPaths.some((p) => p.includes('linked-outside'))).toBe(false);
      expect(foundPaths.some((p) => p.includes('escaped'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// #277 fix-round — direct unit coverage of the exported exclusion predicate.
// This is the exact function the walk calls per directory entry; testing it
// directly (rather than only through black-box walk behavior) lets us prove
// the home-level gate independently of the depth-1 bound that would
// otherwise make "excluded by name" and "excluded by depth" indistinguishable
// from the outside at $HOME.
describe('shouldSkipContextWalkDir (#277 fix-round — contextual exclusions)', () => {
  it('always skips .git and node_modules, regardless of home-root context', () => {
    expect(shouldSkipContextWalkDir('/anywhere', '.git', false)).toBe(true);
    expect(shouldSkipContextWalkDir('/anywhere', '.git', true)).toBe(true);
    expect(shouldSkipContextWalkDir('/anywhere', 'node_modules', false)).toBe(true);
    expect(shouldSkipContextWalkDir('/anywhere', 'node_modules', true)).toBe(true);
  });

  it('does not skip home-level cache names when the walk root is not $HOME', () => {
    for (const name of ['.cache', '.cargo', '.rustup', '.npm', '.nvm', '.pnpm-store', '.gradle', '.m2', 'Trash']) {
      expect(shouldSkipContextWalkDir('/project', name, false)).toBe(false);
    }
  });

  it('skips the same home-level cache names only when the walk root is $HOME', () => {
    for (const name of ['.cache', '.cargo', '.rustup', '.npm', '.nvm', '.pnpm-store', '.gradle', '.m2', 'Trash']) {
      expect(shouldSkipContextWalkDir('/home/user', name, true)).toBe(true);
    }
  });

  it('skips the two-segment Library/Caches pattern only at $HOME', () => {
    expect(shouldSkipContextWalkDir('/home/user/Library', 'Caches', true)).toBe(true);
    expect(shouldSkipContextWalkDir('/home/user/Library', 'Caches', false)).toBe(false);
    // A directory named "Caches" that isn't under "Library" is never skipped by this rule.
    expect(shouldSkipContextWalkDir('/home/user/elsewhere', 'Caches', true)).toBe(false);
  });

  it('skips the two-segment .local/share pattern only at $HOME', () => {
    expect(shouldSkipContextWalkDir('/home/user/.local', 'share', true)).toBe(true);
    expect(shouldSkipContextWalkDir('/home/user/.local', 'share', false)).toBe(false);
    // Other .local subdirectories (bin, state, ...) are never skipped by this rule.
    expect(shouldSkipContextWalkDir('/home/user/.local', 'bin', true)).toBe(false);
  });

  it('skips .codex/.tmp specifically, regardless of home-root context, but not a bare .tmp elsewhere', () => {
    expect(shouldSkipContextWalkDir('/project/.codex', '.tmp', false)).toBe(true);
    expect(shouldSkipContextWalkDir('/project/.codex', '.tmp', true)).toBe(true);
    expect(shouldSkipContextWalkDir('/project', '.tmp', false)).toBe(false);
    expect(shouldSkipContextWalkDir('/project/other', '.tmp', false)).toBe(false);
  });
});
