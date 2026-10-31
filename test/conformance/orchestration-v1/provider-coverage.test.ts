/**
 * T-OG-19 S1 provider coverage reconciliation (B-OG-47, roctinam/aiwg#2911),
 * plus the T-OG-17/18 boundaries of the OpenHuman promotion.
 *
 * Pure checked-in data and synthetic fixtures: no CLI, MCP server, model,
 * credential or Mission/MC state is touched. Documentation, help output and
 * these fixtures never count as live qualification.
 */
import { readFileSync, existsSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter,
} from '../../../src/models/provider-policy.js';
import {
  PROVIDER_IDS, listProviderDefinitions, normalizeProviderDefinitionId,
} from '../../../src/providers/provider-definitions.js';
import type { RouteFeasibility } from '../../../src/providers/capability-matrix.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const INVENTORY = 'docs/providers/route-feasibility-inventory.md';
const RECHECK_DATE = '2026-10-08';
const BASELINE_DATE = '2026-10-07';

// Backlog owner -> filed S1 issue (proposal issues/filed-map.json).
const OWNER_ISSUES: Record<string, number> = {
  'B-OG-07': 2897, 'B-OG-08': 2898, 'B-OG-09': 2899, 'B-OG-28': 2900, 'B-OG-36': 2901,
  'B-OG-37': 2902, 'B-OG-38': 2903, 'B-OG-39': 2904, 'B-OG-40': 2905, 'B-OG-41': 2906,
  'B-OG-42': 2907, 'B-OG-43': 2908, 'B-OG-44': 2909, 'B-OG-45': 2910, 'B-OG-47': 2911,
  'B-OG-48': 2912,
};

type MatrixRows = Record<string, { route_feasibility: RouteFeasibility }>;
const matrix = (loadYaml(readFileSync('agentic/code/providers/capability-matrix.yaml', 'utf8')) as any)
  .providers as MatrixRows;
const coverageRows = fixtureJson('provider-coverage.json').rows as Array<{ provider: string; owner: string; scope: string;
  kind: string; nativeMcp: string; qualification: string }>;
const inventory = readFileSync(INVENTORY, 'utf8');

function canonicalMatrix(): Map<string, RouteFeasibility> {
  const rows = new Map<string, RouteFeasibility>();
  for (const [key, row] of Object.entries(matrix)) {
    const id = normalizeProviderDefinitionId(key)!;
    expect(rows.has(id), `duplicate canonical row ${id}`).toBe(false);
    rows.set(id, row.route_feasibility);
  }
  return rows;
}

type Registry = ReturnType<typeof loadProviderModelCapabilities>;

/** Throws when registry qualification ownership drifts from the coverage fixture. */
function checkOwners(registry: Registry, rows = coverageRows): void {
  for (const row of rows.filter(item => item.kind === 'deployment-provider' && item.provider !== 'generic')) {
    const entry = registry.providers[row.provider as keyof Registry['providers']];
    const owner = row.scope === 'IN'
      ? entry?.workerHealthAdapter?.invocationProfiles?.['direct-shell']?.health?.qualificationOwner
      : entry?.workerHealthCoverage?.qualificationOwner;
    if (owner !== row.owner) throw new Error(`${row.provider}: registry owner ${owner} differs from coverage owner ${row.owner}`);
  }
  const local = rows.find(item => item.provider === 'local-text');
  const localOwner = registry.workerHealthAdapters?.['local-http']?.invocationProfiles?.['direct-http']?.health?.qualificationOwner;
  if (!local || localOwner !== local.owner) throw new Error(`local: registry owner ${localOwner} differs from coverage owner ${local?.owner}`);
}

function reconciliationRows(document: string): string[][] {
  const section = document.split('## S1 coverage reconciliation (B-OG-47)\n')[1]?.split('\n## ')[0];
  if (!section) throw new Error('missing S1 coverage reconciliation section');
  return section.split('\n').filter(line => line.startsWith('| `'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
}

/** Throws on any drift between the normalized table, the matrix and the frozen coverage fixture. */
function checkReconciliation(document: string, rows = canonicalMatrix()): void {
  const table = reconciliationRows(document);
  const ids = table.map(([target]) => /^`([a-z-]+)`$/.exec(target)?.[1]);
  const expected = [...PROVIDER_IDS, 'local'].sort();
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) throw new Error(`row set drift: ${ids.join(',')}`);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate row');
  for (const cells of table) {
    if (cells.length !== 6) throw new Error(`malformed row ${cells[0]}`);
    const [target, scope, issue, date, live, detail] = cells;
    const id = /^`([a-z-]+)`$/.exec(target)![1];
    if (live !== 'no') throw new Error(`${id}: live qualification claimed without a live report`);
    if (!detail) throw new Error(`${id}: empty sources/recheck`);
    const metadata = rows.get(id);
    if (metadata) {
      const coverage = metadata.coverage!;
      if (scope.toLowerCase() !== metadata.scope) throw new Error(`${id}: scope drift`);
      if (issue !== (coverage.profile_issue ?? '—')) throw new Error(`${id}: profile issue drift`);
      if (date !== coverage.source_date) throw new Error(`${id}: evidence date drift`);
      if (metadata.scope === 'out' && !/^Gap: .+ Recheck: .+/.test(detail)) throw new Error(`${id}: OUT row lacks gap/recheck`);
    } else if (id === 'generic') {
      if (scope !== 'OUT' || issue !== '—') throw new Error('generic must stay an OUT registry-only row');
    } else if (id === 'local') {
      if (scope !== 'IN' || issue !== `roctinam/aiwg#${OWNER_ISSUES['B-OG-09']}`) throw new Error('local must map to B-OG-09');
    } else {
      throw new Error(`${id}: no matrix row`);
    }
  }
}

describe('T-OG-19 S1 registry coverage reconciliation (B-OG-47)', () => {
  it('PC01 gives every registry entry exactly one canonical normalized row', () => {
    const rows = canonicalMatrix();
    const named = listProviderDefinitions().filter(({ id }) => id !== 'generic').map(({ id }) => id);
    expect([...rows.keys()].sort()).toEqual(named.sort());
    expect(rows.has('claude-code')).toBe(false); // alias normalizes to claude
    expect(coverageRows.filter(row => row.kind === 'deployment-provider').map(row => row.provider).sort())
      .toEqual([...PROVIDER_IDS].sort());
    for (const [id, row] of rows) {
      expect(row.coverage, id).toBeDefined();
      expect(row.coverage!.source_date, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([BASELINE_DATE, RECHECK_DATE, ...(id === 'flue' ? ['2026-10-30'] : [])], id).toContain(row.coverage!.source_date);
      expect(row.coverage!.sources.length, id).toBeGreaterThan(0);
      for (const source of row.coverage!.sources) {
        if (/^https?:/.test(source)) expect(source, id).toMatch(/^https:\/\//);
      }
    }
  });

  it('PC02 maps every IN row to its profile issue and agrees with the frozen coverage fixture', () => {
    for (const [id, row] of canonicalMatrix()) {
      const fixture = coverageRows.find(item => item.provider === id)!;
      expect(fixture.scope.toLowerCase(), id).toBe(row.scope);
      expect(fixture.qualification, id).toBe('unqualified');
      if (row.scope === 'in') {
        expect(row.coverage!.profile_issue, id).toBe(`roctinam/aiwg#${OWNER_ISSUES[fixture.owner]}`);
        expect(row.channel, id).not.toMatch(/^none\b/);
      } else {
        expect(row.coverage!.profile_issue, id).toBeNull();
        expect(fixture.owner, id).toBe('B-OG-47');
      }
    }
    const local = coverageRows.find(row => row.provider === 'local-text')!;
    expect(local).toMatchObject({ kind: 'worker-adapter', scope: 'IN', owner: 'B-OG-09' });
  });

  it('PC03 never marks help, documentation or synthetic evidence as live qualification', () => {
    const registry = loadProviderModelCapabilities();
    for (const [id, row] of canonicalMatrix()) {
      expect(row.coverage!.live_qualified, id).toBe(false);
      if (row.evidence === 'D') expect(row.identity, id).not.toBe('backend-attested');
      const entry = registry.providers[id as keyof typeof registry.providers];
      // Health records stay inert: no bundled provider is dispatchable.
      expect(entry.workerAdapter, id).toBeUndefined();
      const health = entry.workerHealthAdapter?.invocationProfiles?.['direct-shell']?.health;
      if (health) {
        expect(health.qualification?.authorizedLive, id).toBe(false);
        expect(health.qualifiedAt, id).toBeNull();
      }
    }
  });

  it('PC03b binds registry qualification ownership to the coverage fixture', () => {
    const registry = loadProviderModelCapabilities();
    expect(() => checkOwners(registry)).not.toThrow();
    const drifted = structuredClone(registry);
    drifted.providers.codex.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!.qualificationOwner = 'B-OG-48';
    expect(() => checkOwners(drifted)).toThrow(/codex: registry owner B-OG-48/);
    const outDrift = structuredClone(registry);
    outDrift.providers.grokbot.workerHealthCoverage!.qualificationOwner = 'B-OG-45';
    expect(() => checkOwners(outDrift)).toThrow(/grokbot/);
    const fixtureDrift = coverageRows.map(row => row.provider === 'openhuman' ? { ...row, owner: 'B-OG-42' } : row);
    expect(() => checkOwners(registry, fixtureDrift)).toThrow(/openhuman/);
  });

  it('PC04 records a concrete gap and recheck for each excluded row, with no fabricated command', () => {
    const registry = loadProviderModelCapabilities();
    const out = [...canonicalMatrix()].filter(([, row]) => row.scope === 'out');
    expect(out.map(([id]) => id).sort()).toEqual(['flue', 'grokbot', 'windsurf']);
    for (const [id, row] of out) {
      expect(row.channel, id).toMatch(/^none - /);
      expect(row.identity, id).toBe('unavailable');
      expect(row.coverage!.exclusion_gap?.length, id).toBeGreaterThan(40);
      expect(row.coverage!.recheck, id).toMatch(new RegExp(`^Rechecked ${id === 'flue' ? '2026-10-30' : RECHECK_DATE}`));
      expect(row.coverage!.source_date, id).toBe(id === 'flue' ? '2026-10-30' : RECHECK_DATE);
      expect(row.coverage!.sources.some(source => source.startsWith('https://')), id).toBe(true);
      const entry = registry.providers[id as keyof typeof registry.providers];
      expect(entry.workerHealthAdapter, id).toBeUndefined();
      expect(entry.workerHealthCoverage, id).toMatchObject({ scope: 'out', qualificationOwner: 'B-OG-47' });
    }
    // Devin CLI is a future-provider surface of windsurf, never an alias.
    expect(normalizeProviderDefinitionId('devin-cli')).toBeNull();
  });

  it('PC05 keeps the normalized documentation table in lockstep with the matrix', () => {
    expect(() => checkReconciliation(inventory)).not.toThrow();
  });

  it.each([
    ['missing row', (doc: string) => doc.replace(/^\| `pi` \| IN \| roctinam\/aiwg#2910 .*\n/m, '')],
    ['duplicate row', (doc: string) => doc.replace(/^(\| `pi` \| IN \| roctinam\/aiwg#2910 .*\n)/m, '$1$1')],
    ['alias instead of canonical id', (doc: string) => doc.replace('| `claude` | IN | roctinam', '| `claude-code` | IN | roctinam')],
    ['wrong profile issue', (doc: string) => doc.replace('| `codex` | IN | roctinam/aiwg#2897 |', '| `codex` | IN | roctinam/aiwg#2898 |')],
    ['missing profile issue', (doc: string) => doc.replace('| `cursor` | IN | roctinam/aiwg#2903 |', '| `cursor` | IN | — |')],
    ['evidence date drift', (doc: string) => doc.replace('| `copilot` | IN | roctinam/aiwg#2901 | 2026-10-08 |', '| `copilot` | IN | roctinam/aiwg#2901 | 2026-10-01 |')],
    ['live overclaim', (doc: string) => doc.replace('| `warp` | IN | roctinam/aiwg#2905 | 2026-10-08 | no |', '| `warp` | IN | roctinam/aiwg#2905 | 2026-10-08 | yes |')],
    ['scope drift', (doc: string) => doc.replace('| `grokbot` | OUT | — |', '| `grokbot` | IN | — |')],
    ['OUT row without gap', (doc: string) => doc.replace(/(\| `windsurf` \| OUT .*\| )Gap: /, '$1')],
  ])('PC06 rejects %s', (_name, mutate) => {
    const modified = mutate(inventory);
    expect(modified).not.toBe(inventory);
    expect(() => checkReconciliation(modified)).toThrow();
  });

  it('PC07 rejects matrix drift: missing coverage or a live claim in source data', () => {
    const rows = canonicalMatrix();
    const withoutCoverage = new Map(rows);
    withoutCoverage.set('hermes', { ...rows.get('hermes')!, coverage: undefined });
    expect(() => checkReconciliation(inventory, withoutCoverage)).toThrow();
    const dateDrift = new Map(rows);
    dateDrift.set('muse', { ...rows.get('muse')!, coverage: { ...rows.get('muse')!.coverage!, source_date: '2026-09-30' } });
    expect(() => checkReconciliation(inventory, dateDrift)).toThrow();
  });
});

describe('T-OG-17/18 OpenHuman promotion stays unqualified and source-bound', () => {
  const registry = structuredClone(loadProviderModelCapabilities());
  const entry = registry.providers.openhuman;
  const row = canonicalMatrix().get('openhuman')!;

  it('OH01 promotes into S1 on D evidence with a proposed, not authorized, live budget', () => {
    expect(row).toMatchObject({ scope: 'in', identity: 'runtime-configured-only', evidence: 'D', fanout: 'unknown',
      probe_budget: { status: 'proposed' } });
    expect(row.coverage).toMatchObject({ profile_issue: 'roctinam/aiwg#2911', source_date: RECHECK_DATE, live_qualified: false });
    expect(row.coverage!.recheck).toMatch(/promoted into S1/);
    expect(row.coverage!.sources.every(source => /^https:\/\/github\.com\/tinyhumansai\/openhuman\/(blob\/[0-9a-f]{40}\/|releases\/tag\/v)/.test(source)))
      .toBe(true);
    expect(entry.workerHealthCoverage).toBeUndefined();
  });

  // Metadata only. Rendering, execution, params delivery and stdin closure
  // are exercised against the fake binary in openhuman-direct.test.ts.
  it('OH02 bundled metadata names only the source-evidenced argv, with no bypass flag and framed --params-stdin', () => {
    const adapter = entry.workerHealthAdapter!;
    expect(adapter.invocation).toMatchObject({ kind: 'process', executable: 'openhuman-core',
      argv: ['--model', '${model}', 'call', '--method', 'openhuman.agent_chat', '--params-stdin'], stdin: 'brief-json',
      versionArgv: ['--help'] });
    const argv = (adapter.invocation as { argv: string[] }).argv.join(' ');
    expect(argv).not.toMatch(/bypass|dangerous|yolo|skip-permissions|--fallback|--force|--version/);
    expect(adapter.capabilities).toMatchObject({ nestedAgentsControllable: false, nativeFallbackControllable: false, cancel: 'none' });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.controls.children.support).toBe('unqualified');
    expect(profile.controls.effort.support).toBe('unqualified');
    expect(profile.health).toMatchObject({ handshake: 'process-only', coverage: 'degraded', outputFraming: 'final-json',
      qualificationOwner: 'B-OG-47', progressEvidence: [] });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
  });

  it('OH03 cannot dispatch until authorized live qualification exists', () => {
    expect(() => resolveWorkerAdapter(registry, 'providers:openhuman')).toThrow();
    entry.workerAdapter = structuredClone(entry.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:openhuman');
    for (const transport of ['shell', 'mcp'] as const) {
      expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport, cliVersion: '0.64.14' }))
        .toThrow();
    }
  });

  it('OH04 native agent.run_subagent cannot stand in for a model-pinned worker tool', () => {
    const tools = JSON.parse(readFileSync('test/fixtures/providers/openhuman/mcp-tools-list.json', 'utf8'));
    expect(tools.synthetic).toBe(true);
    const tool = tools.tools.find((item: { name: string }) => item.name === 'agent.run_subagent');
    const properties = Object.keys(tool.inputSchema.properties);
    expect(properties.sort()).toEqual(['agent_id', 'prompt']);
    for (const pin of ['model', 'model_override', 'effort', 'workspace', 'cwd', 'selection']) {
      expect(properties).not.toContain(pin);
    }
    expect(tool.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    const fixture = coverageRows.find(item => item.provider === 'openhuman')!;
    expect(fixture.nativeMcp).toBe('no-model-pin-tool');
    for (const profile of Object.values(entry.workerHealthAdapter!.invocationProfiles!)) {
      expect(profile.transport).toBe('shell');
      expect(profile.mcp).toBeUndefined();
    }
  });
});
