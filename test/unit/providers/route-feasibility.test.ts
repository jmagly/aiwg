import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getRouteFeasibility,
  listProviders,
  type RouteProbeBudget,
} from '../../../src/providers/capability-matrix.js';
import {
  listProviderDefinitions,
  normalizeProviderDefinitionId,
} from '../../../src/providers/provider-definitions.js';

const projectRoot = resolve(import.meta.dirname, '../../..');

const inventory = readFileSync(
  resolve(projectRoot, 'docs/providers/route-feasibility-inventory.md'),
  'utf8',
);

// Qualification owners from 03 §10; aliases must never satisfy this table.
const QUALIFICATION_OWNERS: Record<string, string> = {
  claude: 'B-OG-28', codex: 'B-OG-07', muse: 'B-OG-08', hermes: 'B-OG-48',
  copilot: 'B-OG-36', factory: 'B-OG-37', cursor: 'B-OG-38', opencode: 'B-OG-39',
  warp: 'B-OG-40', 'grok-build': 'B-OG-41', openclaw: 'B-OG-42',
  antigravity: 'B-OG-43', 'deepseek-harness': 'B-OG-44', pi: 'B-OG-45',
  omp: 'B-OG-45', windsurf: 'B-OG-47', grokbot: 'B-OG-47', openhuman: 'B-OG-47',
  flue: 'B-OG-47', local: 'B-OG-09', generic: '—',
};

// Native channel anchors shared by the prose row and matrix metadata.
const CHANNEL_ANCHORS: Record<string, string> = {
  claude: 'claude -p --output-format stream-json --verbose', codex: 'codex debug models',
  muse: 'exec --json', hermes: 'hermes -z', copilot: 'copilot -p --output-format json',
  factory: 'droid exec --output-format stream-json', cursor: 'agent -p --output-format json',
  opencode: 'opencode run --format json', warp: 'oz agent run --prompt/--model/--cwd/--profile',
  'grok-build': 'grok -p --output-format streaming-json', openclaw: 'openclaw agent exec --json',
  antigravity: 'agy -p', 'deepseek-harness': 'dsh --profile headless',
  pi: 'pi --mode json --model/--thinking/--tools', omp: 'omp --mode json --model/--thinking/--profile',
  openhuman: 'openhuman-core --model M call --method openhuman.agent_chat --params-stdin',
};

// B-OG-47 promotions carry a proposed live-qualification budget until the
// operator authorizes one; a proposed budget never authorizes a probe.
const PROMOTED_PENDING_AUTHORIZATION = new Set(['openhuman', 'flue']);

function feasibilityRows(document: string): string[][] {
  const section = document.split('## Per-target feasibility\n')[1]?.split('\n## ')[0];
  expect(section, 'per-target feasibility section').toBeDefined();
  return section!.split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function checkBudget(id: string, budget: RouteProbeBudget): void {
  if (PROMOTED_PENDING_AUTHORIZATION.has(id)) {
    expect(budget.status, id).toBe('proposed');
    expect(Object.keys(budget).sort(), id).toEqual(['calls', 'status', 'tokens']);
    return;
  }
  checkAuthorizedBudget(budget);
}

function budgetCell(budget: RouteProbeBudget): string {
  return budget.status === 'authorized'
    ? `authorized (${budget.authorized_by}, ${budget.authorized_at}; ${budget.hosts.join(', ')}): ${budget.calls} / ${budget.tokens}`
    : `proposed (operator authorization required): ${budget.calls} / ${budget.tokens}`;
}

function checkAuthorizedBudget(
  budget: RouteProbeBudget,
): asserts budget is Extract<RouteProbeBudget, { status: 'authorized' }> {
  expect(budget.status).toBe('authorized');
  if (budget.status !== 'authorized') throw new Error('Budget is not authorized');
  expect(budget.authorized_by).toBe('operator');
  expect(budget.authorized_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(budget.authorized_at).toBe('2026-10-07');
  expect(budget.hosts).toEqual(['titan', 'noodle']);
}

function checkInventory(
  document: string,
  lookup: typeof getRouteFeasibility = getRouteFeasibility,
): void {
  const rows = feasibilityRows(document);
  const targets = rows.map(([target]) => target.match(/^`([a-z-]+)`/)?.[1]);
  const expected = [...listProviderDefinitions().map(({ id }) => id), 'local'];
  expect(targets.slice().sort()).toEqual(expected.sort());
  expect(new Set(targets).size).toBe(rows.length);

  for (const cells of rows) {
    expect(cells).toHaveLength(7);
    const [target, scope, identity, channel, controls, budget, owner] = cells;
    const id = target.match(/^`([a-z-]+)`/)![1];
    expect(owner, id).toBe(QUALIFICATION_OWNERS[id]);
    expect(channel.length, id).toBeGreaterThan(0);
    expect(controls.length, id).toBeGreaterThan(0);
    expect(budget, id).toMatch(/^(authorized \(operator, 2026-10-07; titan, noodle\)|proposed \(operator authorization required\)): \d+ \/ \d+$/);

    const metadata = lookup(id);
    if (metadata) {
      expect(scope.split(' ')[0].toLowerCase(), id).toBe(metadata.scope);
      expect(identity, id).toBe(metadata.identity);
      expect(channel, id).toMatch(new RegExp(`^${metadata.evidence}: `));
      if (metadata.scope === 'in') {
        expect(CHANNEL_ANCHORS[id], id).toBeDefined();
        expect(channel, id).toContain(`\`${CHANNEL_ANCHORS[id]}\``);
        expect(metadata.channel, id).toContain(CHANNEL_ANCHORS[id]);
      }
      expect(controls.match(/^(None|Controlled|Unknown)\b/)?.[1].toLowerCase(), id).toBe(metadata.fanout);
      if (metadata.scope === 'in' && metadata.fanout === 'unknown') {
        expect(controls, id).toContain('blocks strict use');
      }
      checkBudget(id, metadata.probe_budget);
      expect(budget, id).toBe(budgetCell(metadata.probe_budget));
    } else {
      expect(identity, id).toBe('unavailable');
      expect(scope, id).toBe(id === 'local' ? 'IN' : 'OUT');
    }
  }
}

// Synthetic alias fixtures: every spelling must normalize to a registry
// provider that carries a feasibility row. No live CLI is consulted.
const ALIAS_FIXTURES: Array<[alias: string, canonical: string]> = [
  ['claude-code', 'claude'],
  ['openai', 'codex'],
  ['agy', 'antigravity'],
  ['dsh', 'deepseek-harness'],
  ['oh-my-pi', 'omp'],
  ['pi-coding-agent', 'pi'],
  ['devin', 'windsurf'],
  ['devin-desktop', 'windsurf'],
  ['devin-local', 'windsurf'],
  ['cascade', 'windsurf'],
  ['tinyhumansai', 'openhuman'],
  ['github-copilot', 'copilot'],
  ['factory-ai', 'factory'],
];

describe('route-feasibility evidence inventory (B-OG-27)', () => {
  it('records a valid feasibility row for every named registry provider', () => {
    const named = listProviderDefinitions().filter(({ id }) => id !== 'generic');

    expect(named).toHaveLength(19);
    expect(listProviderDefinitions()).toHaveLength(20);

    for (const definition of named) {
      const row = getRouteFeasibility(definition.id);
      expect(row, definition.id).toBeDefined();
      expect(row?.scope).toMatch(/^(in|out)$/);
      expect(row?.identity).toMatch(/^(backend-attested|runtime-configured-only|unavailable)$/);
      expect(row?.evidence).toMatch(/^(H|R|D)$/);
      expect(row?.channel.length).toBeGreaterThan(0);
      expect(row?.fanout).toMatch(/^(none|controlled|unknown)$/);
      checkBudget(definition.id, row!.probe_budget);
      expect(Number.isInteger(row?.probe_budget.calls)).toBe(true);
      expect(Number.isInteger(row?.probe_budget.tokens)).toBe(true);
      expect(row!.probe_budget.calls).toBeGreaterThanOrEqual(0);
      expect(row!.probe_budget.tokens).toBeGreaterThanOrEqual(0);
      if (row?.scope === 'in') {
        // An IN route without inference budget cannot run its later live
        // qualification probe; OUT rows carry a 0-token evidence recheck.
        expect(row.probe_budget.calls).toBeGreaterThan(0);
        expect(row.probe_budget.tokens).toBeGreaterThan(0);
      }
    }
  });

  it('resolves matrix rows through canonical keys listed by the matrix', () => {
    for (const key of listProviders()) {
      expect(getRouteFeasibility(key)).toBeDefined();
    }
    // Matrix `claude-code` normalizes to registry `claude`, not a new row.
    expect(getRouteFeasibility('claude')).toBe(getRouteFeasibility('claude-code'));
  });

  it('normalizes every fixture alias to a provider with a feasibility row', () => {
    for (const [alias, canonical] of ALIAS_FIXTURES) {
      expect(normalizeProviderDefinitionId(alias)).toBe(canonical);
      expect(getRouteFeasibility(alias), alias).toBeDefined();
      expect(getRouteFeasibility(alias)).toBe(getRouteFeasibility(canonical));
    }
  });

  it('separates generic and inference providers from executable harness targets', () => {
    const generic = listProviderDefinitions().find(({ id }) => id === 'generic');
    expect(generic?.capabilities.matrixRef).toBeNull();
    expect(getRouteFeasibility('generic')).toBeUndefined();

    // `openai` is the models inference-provider name; as a harness selector
    // it is an alias for `codex`, never a separate feasibility target.
    expect(normalizeProviderDefinitionId('openai')).toBe('codex');
    expect(getRouteFeasibility('openai')).toBe(getRouteFeasibility('codex'));
  });

  it('tracks unique canonical feasibility rows, qualification owners and matrix metadata', () => {
    checkInventory(inventory);
    expect(inventory).toMatch(/Final qualification stays with B-OG-07\/08\/09\/28/);
  });

  it.each([
    ['missing row despite alias', (_row: string) => ''],
    ['duplicate row', (row: string) => `${row}\n${row}`],
    ['alias instead of canonical target', (row: string) => row.replace('`claude`', '`claude-code`')],
    ['missing owner', (row: string) => row.replace('B-OG-28', '—')],
    ['wrong qualification owner', (row: string) => row.replace('B-OG-28', 'B-OG-07')],
    ['scope mismatch', (row: string) => row.replace('| IN |', '| OUT |')],
    ['identity mismatch', (row: string) => row.replace('runtime-configured-only', 'backend-attested')],
    ['evidence mismatch', (row: string) => row.replace('| H:', '| D:')],
    ['empty evidence channel', (row: string) => row.replace(/\| H:.*? \| Unknown:/, '| | Unknown:')],
    ['native channel mismatch', (row: string) => row.replace('claude -p --output-format stream-json --verbose', 'unqualified -p')],
    ['fan-out mismatch', (row: string) => row.replace('Unknown:', 'Controlled:')],
    ['missing strict-use block', (row: string) => row.replace('blocks strict use', '')],
    ['budget mismatch', (row: string) => row.replace('3 / 30000', '3 / 1')],
    ['authorization operator mismatch', (row: string) => row.replace('(operator,', '(someone,')],
    ['authorization date mismatch', (row: string) => row.replace('2026-10-07;', '2026-10-08;')],
    ['authorization hosts mismatch', (row: string) => row.replace('titan, noodle)', 'titan)')],
    ['budget authorization overclaim', (row: string) => row.replace('authorized (operator, 2026-10-07; titan, noodle)', 'authorized')],
  ])('rejects %s in the feasibility table', (_name, mutate) => {
    const claudeRow = inventory.split('\n').find((line) => line.startsWith('| `claude` |'))!;
    const modified = inventory.replace(claudeRow, mutate(claudeRow));
    expect(modified).toContain('| `claude-code`, `claude` |');
    expect(() => checkInventory(modified)).toThrow();
  });

  it.each(['authorized_by', 'authorized_at', 'hosts'] as const)(
    'rejects an authorized matrix budget missing %s provenance', (field) => {
      const metadata = structuredClone(getRouteFeasibility('claude')!);
      // Deliberately model malformed YAML that bypasses the TypeScript type.
      delete (metadata.probe_budget as unknown as Record<string, unknown>)[field];
      expect(() => checkInventory(inventory, (id) => (
        id === 'claude' ? metadata : getRouteFeasibility(id)
      ))).toThrow();
    },
  );

  it('keeps the B-OG-47 promotion budget proposed and confined to promoted rows', () => {
    const row = inventory.split('\n').find((line) => line.startsWith('| `openhuman` |'))!;
    expect(row).toContain('proposed (operator authorization required): 3 / 30000');
    const overclaim = inventory.replace(row, row.replace(
      'proposed (operator authorization required)', 'authorized (operator, 2026-10-07; titan, noodle)'));
    expect(() => checkInventory(overclaim)).toThrow();
    const proposed = { status: 'proposed', calls: 3, tokens: 30000 } as RouteProbeBudget;
    expect(() => checkInventory(inventory, (id) => (
      id === 'claude' ? { ...getRouteFeasibility('claude')!, probe_budget: proposed } : getRouteFeasibility(id)
    ))).toThrow();
  });

  it('rejects an authorized matrix budget with an empty hosts list', () => {
    const metadata = structuredClone(getRouteFeasibility('claude')!);
    Object.assign(metadata.probe_budget, { hosts: [] });
    expect(() => checkInventory(inventory, (id) => (
      id === 'claude' ? metadata : getRouteFeasibility(id)
    ))).toThrow();
  });

  it('keeps Grok Build child controls unqualified until behavioral evidence exists', () => {
    expect(getRouteFeasibility('grok-build')?.fanout).toBe('unknown');
    const row = feasibilityRows(inventory).find(([target]) => target === '`grok-build`')!;
    expect(row[4]).toContain('version-scoped behavioral evidence');
    expect(row[4]).toContain('blocks strict use');
  });

  it('distinguishes local restrictions from unresolved whole-path evidence', () => {
    const row = feasibilityRows(inventory).find(([target]) => target.startsWith('`local`'))!;
    expect(row[3]).toContain('no cloud transfer (unproven)');
    expect(row[4]).toMatch(/^Unknown fan-out and processing:/);
    for (const control of ['endpoint ownership', 'upstream', 'redirects', 'cloud fallback', 'tools', 'telemetry', 'egress']) {
      expect(row[4]).toContain(control);
    }
    expect(row[4]).toContain('blocks strict use');
    expect(row[4]).toContain('Required:');
  });
});
