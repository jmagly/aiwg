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
import fs from 'fs';
import path from 'path';
import os from 'os';

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
}
function writeUser(name: string, body = 'user artifact') {
  fs.writeFileSync(path.join(dir, name), body);
}
function writeSidecar(names: string[]) {
  const managed: Record<string, unknown> = {};
  for (const n of names) managed[n] = { hash: 'sha256:deadbeef', source: 'bundled', version: '0.0.0' };
  fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), JSON.stringify({ managed }, null, 2));
}

describe('#1627 artifactStem', () => {
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
    expect(rules.has('anti-laziness')).toBe(true);
    expect(rules.has('tao-loop')).toBe(true);
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
      hash: 'sha256:test', source: 'bundled', version: '0.0.0', kind: 'skill-command',
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

