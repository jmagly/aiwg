// Exercise owner-aware flat pruning with synthetic bundles and deployment receipts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeArtifactInventory, deployFiles, pruneStaleAiwgFiles } from '../../../tools/agents/providers/base.mjs';
import { pruneStaleAiwgArtifacts } from '../../../tools/agents/providers/stale-artifact-prune.mjs';

const OLD = 'content-diversifier';
const RENAMED = 'verbalized-content-diversifier';
const VS = 'verbalized-sampling';
const WQ = 'writing-quality';
const provider = { paths: { agents: '.claude/agents' } };
const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
type RecordEntry = { hash?: string; frameworkSlug?: string; owners?: string[]; kind?: string };
let root: string, source: string, project: string, dest: string;

function write(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function ship(owner: string, stem: string): void {
  write(path.join(source, 'agentic/code/addons', owner, 'agents', `${stem}.md`), `# ${owner}: ${stem}\n`);
}

function receipt(): { managed: Record<string, RecordEntry> } {
  return JSON.parse(fs.readFileSync(path.join(dest, '.aiwg-manifest.json'), 'utf8'));
}

function record(name: string, entry: RecordEntry, bytes = '# Previously deployed agent\n'): string {
  const target = path.join(dest, name);
  write(target, bytes);
  const sidecar = path.join(dest, '.aiwg-manifest.json');
  const manifest = fs.existsSync(sidecar) ? receipt() : { managed: {} };
  manifest.managed[name] = { hash: hash(bytes), ...entry };
  write(sidecar, JSON.stringify(manifest, null, 2) + '\n');
  return target;
}

function prune(opts: object = {}, explicitSource: string | null = null): void {
  pruneStaleAiwgArtifacts(provider, project, explicitSource || source, { quiet: true, ...opts }, explicitSource);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-owner-prune-'));
  source = path.join(root, 'source');
  project = path.join(root, 'project');
  dest = path.join(project, '.claude/agents');
  fs.mkdirSync(path.join(source, 'agentic/code/frameworks'), { recursive: true });
  ship(VS, RENAMED);
  ship(WQ, OLD);
  vi.stubEnv('AIWG_ROOT', source);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#3807 owner-aware flat artifact pruning', () => {
  it('builds global and owner inventories using framework entry paths and explicit addons', () => {
    write(path.join(source, 'agentic/code/frameworks/demo/manifest.json'), '{"entry":{"agents":"payload/agents"}}');
    write(path.join(source, 'agentic/code/frameworks/demo/payload/agents/framework-agent.md'), '# Agent');
    write(path.join(source, 'agentic/code/addons/writing-quality/manifest.json'), '{"explicitInstall":true}');
    const inventory = computeArtifactInventory(source, 'agents');
    expect(inventory.stems).toEqual(new Set([OLD, RENAMED, 'framework-agent']));
    expect(inventory.ownerStems.get(VS)).toEqual(new Set([RENAMED]));
    expect(inventory.ownerStems.get(WQ)).toEqual(new Set([OLD]));
    expect(inventory.ownerStems.get('demo')).toEqual(new Set(['framework-agent']));
    expect(computeArtifactInventory(path.join(source, 'agentic/code/addons', VS), 'agents')).toEqual(inventory);
  });

  it.each([
    { frameworkSlug: VS },
    { owners: [VS] },
    { frameworkSlug: VS, owners: [VS] },
  ])('prunes the pre-2026.11.0 verbalized agent despite writing-quality shipping its stem (%j)', ownership => {
    const stale = record(`${OLD}.md`, ownership);
    const renamed = record(`${RENAMED}.md`, { frameworkSlug: VS });
    prune({}, path.join(source, 'agentic/code/addons', VS));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(renamed)).toBe(true);
    expect(receipt().managed[`${OLD}.md`]).toBeUndefined();
    expect(receipt().managed[`${RENAMED}.md`]).toMatchObject({ frameworkSlug: VS });
  });

  it('preserves operator edits without changing their receipt', () => {
    const stale = record(`${OLD}.md`, { frameworkSlug: VS });
    const before = receipt();
    fs.appendFileSync(stale, 'Operator edit\n');
    prune();
    expect(fs.readFileSync(stale, 'utf8')).toContain('Operator edit');
    expect(receipt()).toEqual(before);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('operator-edited'));
  });

  it('preserves operator-owned files and unrecorded managed-marker files', () => {
    const operator = path.join(dest, 'operator-agent.md');
    const unrecorded = path.join(dest, `${OLD}.md`);
    const retired = path.join(dest, 'unrecorded-retired.md');
    write(operator, '# Operator agent\n');
    write(unrecorded, '<!-- aiwg:managed v2026.10.19 bundled -->\n# Legacy agent\n');
    write(retired, '<!-- aiwg:managed v2026.10.19 bundled -->\n# Retired legacy agent\n');
    prune();
    expect(fs.readFileSync(operator, 'utf8')).toBe('# Operator agent\n');
    expect(fs.readFileSync(unrecorded, 'utf8')).toContain('# Legacy agent');
    expect(fs.readFileSync(retired, 'utf8')).toContain('# Retired legacy agent');
    expect(fs.existsSync(path.join(dest, '.aiwg-manifest.json'))).toBe(false);
  });

  it('preserves an owner receipt without a digest', () => {
    const file = record(`${OLD}.md`, { frameworkSlug: VS, hash: undefined });
    prune();
    expect(fs.existsSync(file)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unverifiable ownership'));
  });

  it.each([
    { frameworkSlug: WQ },
    { owners: [WQ] },
    { frameworkSlug: VS, owners: [VS, WQ] },
    { frameworkSlug: WQ, owners: [VS] },
  ])('preserves a shared path when any recorded owner still ships the stem (%j)', ownership => {
    const live = record(`${OLD}.md`, ownership, '# Live writing-quality agent\n');
    const before = receipt();
    // Retiring VS must never delete WQ's live file at the same provider path.
    prune({}, path.join(source, 'agentic/code/addons', VS));
    expect(fs.readFileSync(live, 'utf8')).toBe('# Live writing-quality agent\n');
    expect(receipt()).toEqual(before);
  });

  it('preserves a collision while both recorded owners still ship the stem', () => {
    ship(VS, OLD);
    const file = record(`${OLD}.md`, { frameworkSlug: VS, owners: [VS, WQ] });
    prune();
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each([false, true])('preserves the live owner using writer-produced shared receipts (different bytes: %s)', differentBytes => {
    const verbalized = path.join(source, 'agentic/code/addons', VS, 'agents', `${OLD}.md`);
    const writing = path.join(source, 'agentic/code/addons', WQ, 'agents', `${OLD}.md`);
    write(verbalized, '# Shared agent\n');
    write(writing, differentBytes ? '# Writing-quality agent\n' : '# Shared agent\n');
    fs.mkdirSync(dest, { recursive: true });
    deployFiles([verbalized], dest, {});
    deployFiles([writing], dest, { force: differentBytes });
    const live = path.join(dest, `${OLD}.md`);
    const sidecar = path.join(dest, '.aiwg-manifest.json');
    const before = [live, sidecar].map(file => fs.readFileSync(file));
    expect(receipt().managed[`${OLD}.md`]).toMatchObject({
      frameworkSlug: WQ, owners: [VS, WQ], hash: hash(before[0].toString()),
    });
    // The old owner retires its source after both have claimed this flat path.
    fs.unlinkSync(verbalized);
    prune({}, path.join(source, 'agentic/code/addons', VS));
    expect([live, sidecar].map(file => fs.readFileSync(file))).toEqual(before);
  });

  it('prunes a shared path after all recorded owners retire it, despite an unrelated live namesake', () => {
    ship('unrelated-addon', OLD);
    fs.unlinkSync(path.join(source, 'agentic/code/addons', WQ, 'agents', `${OLD}.md`));
    const stale = record(`${OLD}.md`, { frameworkSlug: VS, owners: [VS, WQ] });
    prune();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('prunes receipts belonging to a removed bundle', () => {
    const stale = record(`${OLD}.md`, { owners: ['removed-addon'] });
    prune();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('uses global stems for legacy receipts without owner identity', () => {
    const live = record(`${OLD}.md`, {});
    const stale = record('retired-agent.md', {});
    prune();
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it.each([{ copyMode: true }, { copyStandardSkills: true }])('never prunes in copy mode (%j)', opts => {
    const stale = record(`${OLD}.md`, { frameworkSlug: VS });
    const before = receipt();
    prune(opts);
    expect(fs.existsSync(stale)).toBe(true);
    expect(receipt()).toEqual(before);
    const inventory = computeArtifactInventory(source, 'agents');
    expect(pruneStaleAiwgFiles(dest, inventory.stems, { ...opts, ownerStems: inventory.ownerStems })).toEqual([]);
  });

  it('prints the same prune plan in dry run and leaves payloads and receipts byte-unchanged', () => {
    const stale = record(`${OLD}.md`, { frameworkSlug: VS });
    const live = record(`${RENAMED}.md`, { frameworkSlug: VS });
    const sidecar = path.join(dest, '.aiwg-manifest.json');
    const before = [stale, live, sidecar].map(file => fs.readFileSync(file));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    prune({ dryRun: true, verbose: true, quiet: false });
    expect([stale, live, sidecar].map(file => fs.readFileSync(file))).toEqual(before);
    const planned = log.mock.calls.map(args => args.join(' '));
    expect(planned).toContain(`[dry-run] would prune stale AIWG artifact: ${path.relative(process.cwd(), stale)}`);
    expect(planned).toContain('  Pruned: 1 stale AIWG agents file');
    log.mockClear();
    prune({ verbose: true, quiet: false });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(log).toHaveBeenCalledWith(`pruned stale AIWG artifact: ${path.relative(process.cwd(), stale)}`);
    expect(log).toHaveBeenCalledWith('  Pruned: 1 stale AIWG agents file');
  });

  it('keeps skill-command wrappers on their skill inventory', () => {
    const file = record('live-skill.md', { owners: [VS], kind: 'skill-command' });
    const inventory = computeArtifactInventory(source, 'commands');
    expect(pruneStaleAiwgFiles(dest, inventory.stems, {
      ownerStems: inventory.ownerStems, skillCommandStems: new Set(['live-skill']),
    })).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each(['commands', 'rules'])('applies owner-aware pruning to %s', type => {
    write(path.join(source, 'agentic/code/addons', WQ, type, `${OLD}.md`), '# Still shipped\n');
    const stale = record(`${OLD}.md`, { frameworkSlug: VS });
    pruneStaleAiwgArtifacts({ paths: { [type]: '.claude/agents' } }, project, source,
      { [`${type}Only`]: true, quiet: true }, null);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
