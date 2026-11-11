/**
 * #1627 — Surgical deploy: prune stale AIWG-managed flat artifacts
 * (agents/commands/rules) while preserving user-authored files.
 *
 * Exercises the base.mjs helpers added for the flat-file analogue of the
 * skills holistic prune:
 *   - artifactStem
 *   - resolveAiwgRoot
 *   - computeAllArtifactBasenames
 *   - pruneStaleAiwgFiles
 *   - migrateCommandsDirectory (user-file preservation)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordManagedCopy } from '../../helpers/managed-copy-fixture.js';
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sourceRules } from './rule-source-expectations.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

async function importBase() {
  return import(/* @vite-ignore */ path.join(REPO_ROOT, 'tools/agents/providers/base.mjs'));
}

const MARKER = '<!-- aiwg:managed v0.0.0 bundled -->\n';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prune-1627-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeManaged(name: string, body = 'aiwg artifact') {
  fs.writeFileSync(path.join(dir, name), MARKER + body);
  recordManagedCopy(path.join(dir, name));
}
function writeUser(name: string, body = 'user artifact') {
  fs.writeFileSync(path.join(dir, name), body);
}
function writeSidecar(names: string[]) {
  const managed: Record<string, unknown> = {};
  for (const n of names) managed[n] = { hash: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')}`, source: 'bundled', version: '0.0.0' };
  fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), JSON.stringify({ managed }, null, 2));
}

describe('#1627 artifactStem', () => {
  it('limits a single-bundle prune to its own stale outputs (#4087)', async () => {
    const { pruneStaleAiwgFiles } = await importBase();
    for (const name of ['retired.md', 'foreign.md', 'shared.md', 'unattributed.md']) writeManaged(name);
    const file = path.join(dir, '.aiwg-manifest.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.managed['retired.md'].owners = ['selected'];
    receipt.managed['foreign.md'].owners = ['other'];
    receipt.managed['shared.md'].owners = ['selected', 'other'];
    fs.writeFileSync(file, JSON.stringify(receipt));
    const opts = { onlyOwner: 'selected', ownerStems: new Map([['selected', new Set()]]) };
    expect(pruneStaleAiwgFiles(dir, new Set(), { ...opts, dryRun: true })).toEqual([path.join(dir, 'retired.md')]);
    expect(pruneStaleAiwgFiles(dir, new Set(), opts)).toEqual([path.join(dir, 'retired.md')]);
    for (const name of ['foreign.md', 'shared.md', 'unattributed.md']) expect(fs.existsSync(path.join(dir, name))).toBe(true);
  });

  it('strips provider extension variants to a common stem', async () => {
    const base = await importBase();
    expect(base.artifactStem('foo.md')).toBe('foo');
    expect(base.artifactStem('foo.mdc')).toBe('foo');
    expect(base.artifactStem('foo.agent.md')).toBe('foo');
    expect(base.artifactStem('foo.prompt.md')).toBe('foo');
    expect(base.artifactStem('foo.instructions.md')).toBe('foo');
    expect(base.artifactStem('RULES-INDEX.md')).toBe('RULES-INDEX');
  });
});

describe('#1627 resolveAiwgRoot', () => {
  it('resolves the AIWG root from a nested path inside the repo', async () => {
    const base = await importBase();
    const nested = path.join(REPO_ROOT, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'agents');
    expect(base.resolveAiwgRoot(nested)).toBe(REPO_ROOT);
  });

  it('returns null for an isolated dir with no AIWG tree', async () => {
    const base = await importBase();
    const saved = process.env.AIWG_ROOT;
    delete process.env.AIWG_ROOT;
    try {
      expect(base.resolveAiwgRoot(dir)).toBeNull();
    } finally {
      if (saved !== undefined) process.env.AIWG_ROOT = saved;
    }
  });
});

describe('#1627 computeAllArtifactBasenames', () => {
  it('returns the global source stems for agents/rules (mode-independent)', async () => {
    const base = await importBase();
    const agents = base.computeAllArtifactBasenames(REPO_ROOT, 'agents');
    const rules = base.computeAllArtifactBasenames(REPO_ROOT, 'rules');
    expect(agents).toBeInstanceOf(Set);
    expect(agents.has('software-implementer')).toBe(true);
    expect(agents.has('code-reviewer')).toBe(true);
    // ADR 57–61, 265–272: prune retains body-delivered rules, while migrated
    // summary/bound/on-demand rules leave the recursively loaded rules tree.
    const expected = ['frameworks', 'addons'].flatMap(kind =>
      sourceRules(REPO_ROOT, kind as 'frameworks' | 'addons', true))
      .filter(rule => rule.fileDelivered && !rule.consolidated).map(rule => rule.name);
    expect(rules).toEqual(new Set(expected));
    const nested = path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils');
    expect(base.computeAllArtifactBasenames(nested, 'rules')).toEqual(rules);
  });

  it('returns null when there is no AIWG framework/addon tree', async () => {
    const base = await importBase();
    const saved = process.env.AIWG_ROOT;
    delete process.env.AIWG_ROOT;
    try {
      expect(base.computeAllArtifactBasenames(dir, 'agents')).toBeNull();
    } finally {
      if (saved !== undefined) process.env.AIWG_ROOT = saved;
    }
  });
});

describe('#1627 pruneStaleAiwgFiles', () => {
  it('prunes a managed file whose stem is not in the desired set', async () => {
    const base = await importBase();
    writeManaged('stale-agent.md');
    const removed = base.pruneStaleAiwgFiles(dir, new Set(['keep-me']));
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'stale-agent.md'))).toBe(false);
  });

  it('preserves an operator-authored file lacking any AIWG ownership signal', async () => {
    const base = await importBase();
    writeUser('my-agent.md');
    const removed = base.pruneStaleAiwgFiles(dir, new Set(['something-else']));
    expect(removed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'my-agent.md'))).toBe(true);
  });

  it('preserves a managed file whose stem IS in the desired set', async () => {
    const base = await importBase();
    writeManaged('current-agent.md');
    const removed = base.pruneStaleAiwgFiles(dir, new Set(['current-agent']));
    expect(removed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'current-agent.md'))).toBe(true);
  });

  it('never removes RULES-INDEX.md or the sidecar manifest', async () => {
    const base = await importBase();
    fs.writeFileSync(path.join(dir, 'RULES-INDEX.md'), MARKER + 'index');
    writeSidecar(['RULES-INDEX.md']);
    const removed = base.pruneStaleAiwgFiles(dir, new Set([]));
    expect(removed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'RULES-INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.aiwg-manifest.json'))).toBe(true);
  });

  it('is extension-agnostic (.agent.md pruned, .mdc kept by stem)', async () => {
    const base = await importBase();
    writeManaged('legacy.agent.md');   // stem "legacy" not desired → prune
    writeManaged('keep.mdc');          // stem "keep" desired → survive
    const removed = base.pruneStaleAiwgFiles(dir, new Set(['keep']));
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'legacy.agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keep.mdc'))).toBe(true);
  });

  it('uses the sidecar manifest as an ownership signal (no in-file marker)', async () => {
    const base = await importBase();
    writeUser('sidecar-owned.md');      // no in-file marker
    writeSidecar(['sidecar-owned.md']); // but recorded as AIWG-managed
    const removed = base.pruneStaleAiwgFiles(dir, new Set([]));
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'sidecar-owned.md'))).toBe(false);
    // sidecar entry dropped
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8'));
    expect(sidecar.managed['sidecar-owned.md']).toBeUndefined();
  });

  it('dry-run reports would-be-removed files without deleting', async () => {
    const base = await importBase();
    writeManaged('stale.md');
    const removed = base.pruneStaleAiwgFiles(dir, new Set([]), { dryRun: true });
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'stale.md'))).toBe(true);
  });

  it('no-ops on a missing directory', async () => {
    const base = await importBase();
    const removed = base.pruneStaleAiwgFiles(path.join(dir, 'nope'), new Set([]));
    expect(removed).toHaveLength(0);
  });
});

describe('#1627 migrateCommandsDirectory preserves user commands', () => {
  it('removes AIWG-managed command files but keeps operator-authored ones', async () => {
    const base = await importBase();
    writeManaged('aiwg-command.md');
    writeUser('my-command.md');
    const changed = base.migrateCommandsDirectory(dir, {});
    expect(changed).toBe(true);
    expect(fs.existsSync(path.join(dir, 'aiwg-command.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'my-command.md'))).toBe(true);
  });

  it('returns false (no-op) when only operator files are present', async () => {
    const base = await importBase();
    writeUser('user-only.md');
    const changed = base.migrateCommandsDirectory(dir, {});
    expect(changed).toBe(false);
    expect(fs.existsSync(path.join(dir, 'user-only.md'))).toBe(true);
  });

  it('dry-run does not delete managed command files', async () => {
    const base = await importBase();
    writeManaged('aiwg-command.md');
    const changed = base.migrateCommandsDirectory(dir, { dryRun: true });
    expect(changed).toBe(true);
    expect(fs.existsSync(path.join(dir, 'aiwg-command.md'))).toBe(true);
  });
});

/**
 * #2507 — skill-command wrappers are named after skills, not command sources,
 * so they fall outside the command desired set by construction. Once they carry
 * an ownership signal, both the flat prune and the commands→skills migration
 * would delete wrappers the same deploy had just written.
 */
describe('#2507 skill-command wrappers survive prune and migration', () => {
  function writeSkillCommand(name: string): void {
    fs.writeFileSync(path.join(dir, name), `${MARKER}# wrapper\n`, 'utf8');
    const manifestPath = path.join(dir, '.aiwg-manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : { managed: {} };
    manifest.managed[name] = {
      hash: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}`, source: 'bundled', version: '0.0.0', kind: 'skill-command',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  it('pruneStaleAiwgFiles leaves skill-command wrappers alone', async () => {
    const base = await importBase();
    writeSkillCommand('address-issues.md');
    writeManaged('stale-real-command.md');

    const removed = base.pruneStaleAiwgFiles(dir, new Set([]));

    expect(removed.map((p: string) => path.basename(p))).toEqual(['stale-real-command.md']);
    expect(fs.existsSync(path.join(dir, 'address-issues.md'))).toBe(true);
  });

  it('migrateCommandsDirectory leaves skill-command wrappers alone', async () => {
    const base = await importBase();
    writeSkillCommand('aiwg-doctor.md');
    writeManaged('legacy-command.md');

    const changed = base.migrateCommandsDirectory(dir, {});

    expect(changed).toBe(true);
    expect(fs.existsSync(path.join(dir, 'legacy-command.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'aiwg-doctor.md'))).toBe(true);
  });

  it('updateSidecarManifest records the artifact kind', async () => {
    const base = await importBase();
    base.updateSidecarManifest(
      dir,
      [{ filename: 'wrapper.md', hash: 'abc', kind: 'skill-command' }],
      { version: '1.0.0', source: 'bundled' },
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8'));
    expect(manifest.managed['wrapper.md'].kind).toBe('skill-command');
  });

  // #2511 — the exemption that keeps a wrapper alive while its skill exists was
  // also keeping it alive after the skill was deleted. Retiring it needs a skill
  // inventory, not the command desired set it can never appear in.
  it('retires a wrapper whose source skill no longer ships', async () => {
    const base = await importBase();
    writeSkillCommand('address-issues.md');
    writeSkillCommand('deleted-skill.md');

    const removed = base.pruneStaleAiwgFiles(dir, new Set([]), {
      skillCommandStems: new Set(['address-issues']),
    });

    expect(removed.map((p: string) => path.basename(p))).toEqual(['deleted-skill.md']);
    expect(fs.existsSync(path.join(dir, 'address-issues.md'))).toBe(true);
  });

  it('keeps the blanket exemption when no skill inventory is supplied', async () => {
    const base = await importBase();
    writeSkillCommand('deleted-skill.md');

    expect(base.pruneStaleAiwgFiles(dir, new Set([]))).toEqual([]);
    expect(base.pruneStaleAiwgFiles(dir, new Set([]), { skillCommandStems: null })).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'deleted-skill.md'))).toBe(true);
  });

  it('accepts the skill inventory as an array', async () => {
    const base = await importBase();
    writeSkillCommand('kept.md');
    writeSkillCommand('gone.md');

    const removed = base.pruneStaleAiwgFiles(dir, new Set([]), { skillCommandStems: ['kept'] });

    expect(removed.map((p: string) => path.basename(p))).toEqual(['gone.md']);
  });

  it('computeAllSkillNames returns kernel and standard skills together', async () => {
    const base = await importBase();
    const names = base.computeAllSkillNames(REPO_ROOT);
    expect(names).toBeInstanceOf(Set);
    // A kernel skill and a standard skill must both be present.
    expect(names.has('aiwg-doctor')).toBe(true);
    expect(names.has('address-issues')).toBe(true);
  });
});

/**
 * #2508 — `aiwg use all` runs kernel-only, which deploys no flat artifacts and
 * therefore cannot judge any of them stale. The empty-desired-set prune is a
 * migration for the pre-#152 bulk default and only applies when the bulk
 * install is the sole thing the project deployed.
 */
describe('#2508 kernel-only flat prune is gated on bundle ownership', () => {
  async function importDeployAgents() {
    return import(/* @vite-ignore */ path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'));
  }

  function writeConfig(installed: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, '.aiwg'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.aiwg', 'aiwg.config'),
      JSON.stringify({ version: '1', providers: ['claude'], installed }, null, 2),
      'utf8',
    );
  }

  it('allows the migration prune when only the bulk install is recorded', async () => {
    const mod = await importDeployAgents();
    writeConfig({ all: { deployedTo: {} } });
    expect(mod.bulkInstallOwnsFlatArtifacts(dir)).toBe(true);
  });

  it('allows the migration prune when no config is present', async () => {
    const mod = await importDeployAgents();
    expect(mod.bulkInstallOwnsFlatArtifacts(dir)).toBe(true);
  });

  it('blocks the migration prune when another bundle owns the surface', async () => {
    const mod = await importDeployAgents();
    writeConfig({ all: { deployedTo: {} }, sdlc: { deployedTo: {} } });
    expect(mod.bulkInstallOwnsFlatArtifacts(dir)).toBe(false);
  });

  it('blocks the migration prune for an addon-only install', async () => {
    const mod = await importDeployAgents();
    writeConfig({ rlm: { deployedTo: {} } });
    expect(mod.bulkInstallOwnsFlatArtifacts(dir)).toBe(false);
  });
});



describe('#3740 activation projection owns rule retirement', () => {
  it.each([true, false])('preserves projected kernels only with delivery ownership (%s)', async projected => {
    const { pruneStaleAiwgArtifacts } = await import('../../../tools/agents/providers/stale-artifact-prune.mjs');
    const rules = path.join(dir, '.omp/rules');
    const agents = path.join(dir, '.omp/agents');
    fs.mkdirSync(rules, { recursive: true });
    fs.mkdirSync(agents, { recursive: true });
    const kernel = path.join(rules, 'dev-pipeline-safety.md');
    fs.writeFileSync(kernel, MARKER + 'Extension kernel policy');
    fs.writeFileSync(path.join(agents, 'retired-agent.md'), MARKER + 'Retired definition');
    recordManagedCopy(path.join(agents, 'retired-agent.md'));
    fs.writeFileSync(path.join(rules, 'operator.md'), 'Operator policy');
    fs.writeFileSync(path.join(rules, '.aiwg-manifest.json'), JSON.stringify({
      managed: { 'dev-pipeline-safety.md': { hash: `sha256:${createHash('sha256').update(fs.readFileSync(kernel)).digest('hex')}` } },
      ...(projected ? { delivery: { rules: '.omp/rules', entryPoint: '.omp/rules/RULES-INDEX.md' } } : {}),
    }));
    pruneStaleAiwgArtifacts({ paths: { rules: '.omp/rules', agents: '.omp/agents' } }, dir, REPO_ROOT,
      { deployRules: true, quiet: true }, null);
    expect(fs.existsSync(kernel)).toBe(projected);
    expect(fs.existsSync(path.join(agents, 'retired-agent.md'))).toBe(false);
    expect(fs.readFileSync(path.join(rules, 'operator.md'), 'utf8')).toBe('Operator policy');
  });
});
