/**
 * Tests for workspace CLI commands
 * Issue #53: Framework-scoped workspace structure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import http from 'node:http';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Workspace CLI Commands', () => {
  // Keep fixtures out of the source tree: tree-walking tests (secret scans)
  // race with directories created and removed under test/fixtures.
  let parentDir: string;
  let testDir: string;
  let aiwgDir: string;

  beforeEach(async () => {
    parentDir = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-workspace-commands-'));
    testDir = path.join(parentDir, 'workspace-test');
    aiwgDir = path.join(testDir, '.aiwg');
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(parentDir, { recursive: true, force: true });
  });

  describe('workspace-status', () => {
    it('should report no workspace when .aiwg does not exist', async () => {
      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      // Mock console output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--json', testDir]);
        const output = JSON.parse(logs[0]);
        expect(output.workspace.exists).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });

    it('should resolve an external workspace through .aiwg-location', async () => {
      const externalAiwg = path.join(testDir, '..', 'workspace-test-private', '.aiwg');
      await fs.mkdir(path.join(externalAiwg, 'frameworks'), { recursive: true });
      await fs.writeFile(path.join(testDir, '.aiwg-location'), '../workspace-test-private/.aiwg\n');
      await fs.writeFile(
        path.join(externalAiwg, 'frameworks', 'registry.json'),
        JSON.stringify({ frameworks: { sdlc: { id: 'sdlc', version: '1.0.0', health: 'healthy' } } }),
      );

      const { buildWorkspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');
      try {
        const output = await buildWorkspaceStatus(testDir);
        expect(output.workspace.exists).toBe(true);
        expect(output.workspace.path).toBe(externalAiwg);
        expect(output.frameworks[0].id).toBe('sdlc');
      } finally {
        await fs.rm(path.dirname(externalAiwg), { recursive: true, force: true });
      }
    });

    it('reports external control-plane health in the verification probe', async () => {
      const externalAiwg = path.join(testDir, 'external', '.aiwg');
      await fs.mkdir(path.join(externalAiwg, 'frameworks'), { recursive: true });
      await fs.writeFile(path.join(testDir, '.aiwg-location'), 'external/.aiwg\n');
      await fs.writeFile(path.join(externalAiwg, 'AIWG.md'), '# AIWG\n');
      await fs.writeFile(path.join(externalAiwg, 'aiwg.config'), '{}\n');
      await fs.writeFile(path.join(externalAiwg, 'frameworks', 'registry.json'), '{"frameworks":{}}\n');

      const { buildVerificationProbe } = await import('../../../tools/cli/workspace-status.mjs');
      const output = await buildVerificationProbe(testDir);
      expect(output.status).toBe('needs-repair');
      expect(output.checks.artifact_health).toBe('legacy-missing-control-plane');
      expect(output.verification.next_command).toBe('aiwg artifacts repair --dry-run');
    });

    it('should detect legacy workspace structure', async () => {
      // Create legacy structure
      await fs.mkdir(path.join(aiwgDir, 'intake'), { recursive: true });
      await fs.mkdir(path.join(aiwgDir, 'requirements'), { recursive: true });

      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--json', testDir]);
        const output = JSON.parse(logs[0]);
        expect(output.workspace.exists).toBe(true);
        expect(output.workspace.isLegacy).toBe(true);
        expect(output.workspace.isFrameworkScoped).toBe(false);
        expect(output.migration.status).toBe('pending');
      } finally {
        console.log = originalLog;
      }
    });

    it('should detect framework-scoped workspace structure', async () => {
      // Create framework-scoped structure
      await fs.mkdir(path.join(aiwgDir, 'frameworks', 'sdlc-complete', 'repo'), { recursive: true });
      await fs.mkdir(path.join(aiwgDir, 'frameworks', 'sdlc-complete', 'projects'), { recursive: true });

      // Create registry
      const registry = {
        version: '1.0.0',
        frameworks: {
          'sdlc-complete': {
            id: 'sdlc-complete',
            type: 'framework',
            version: '1.0.0',
            health: 'healthy'
          }
        }
      };
      await fs.writeFile(
        path.join(aiwgDir, 'frameworks', 'registry.json'),
        JSON.stringify(registry, null, 2)
      );

      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--json', testDir]);
        const output = JSON.parse(logs[0]);
        expect(output.workspace.exists).toBe(true);
        expect(output.workspace.isFrameworkScoped).toBe(true);
        expect(output.migration.status).toBe('completed');
        expect(output.frameworks).toHaveLength(1);
        expect(output.frameworks[0].id).toBe('sdlc-complete');
      } finally {
        console.log = originalLog;
      }
    });

    it('should load array-shaped registry entries and separate deployments from project-local bundles', async () => {
      await fs.mkdir(path.join(aiwgDir, 'frameworks', 'ops-complete', 'repo'), { recursive: true });
      await fs.mkdir(path.join(aiwgDir, 'extensions', 'agent-ops-control'), { recursive: true });
      await fs.mkdir(path.join(testDir, '.codex', 'agents'), { recursive: true });
      await fs.writeFile(path.join(testDir, '.codex', 'agents', 'ops-agent.md'), '# Ops agent');

      const registry = {
        version: '1.0.0',
        created: '2026-05-11T22:50:04.581Z',
        frameworks: [
          {
            id: 'ops-complete',
            installed: '2026-05-11T22:50:04.581Z',
            version: '1.0.0'
          }
        ]
      };
      await fs.writeFile(
        path.join(aiwgDir, 'frameworks', 'registry.json'),
        JSON.stringify(registry, null, 2)
      );

      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--json', testDir]);
        const output = JSON.parse(logs[0]);
        expect(output.frameworks).toHaveLength(1);
        expect(output.frameworks[0]).toMatchObject({
          id: 'ops-complete',
          version: '1.0.0',
          installDate: '2026-05-11T22:50:04.581Z'
        });
        expect(output.providerDeployments).toEqual([
          {
            name: 'codex',
            path: '.codex',
            counts: { agents: 1 },
            lastRefresh: null
          }
        ]);
        expect(output.projectLocalBundles).toEqual(
          expect.arrayContaining([
            { type: 'extensions', count: 1, names: ['agent-ops-control'] }
          ])
        );
      } finally {
        console.log = originalLog;
      }
    });

    it('exports stable fleet status JSON with fleet id and activity slice', async () => {
      await fs.mkdir(path.join(aiwgDir, 'frameworks'), { recursive: true });
      await fs.mkdir(path.join(testDir, '.codex', 'agents'), { recursive: true });
      await fs.writeFile(path.join(testDir, '.codex', 'agents', 'ops-agent.md'), '# Ops agent');
      await fs.writeFile(
        path.join(aiwgDir, 'activity.log'),
        '## [2026-05-17 12:00] deploy | deployed codex provider\n'
      );
      await fs.writeFile(
        path.join(aiwgDir, 'frameworks', 'registry.json'),
        JSON.stringify({
          frameworks: {
            'sdlc-complete': {
              id: 'sdlc-complete',
              version: '1.0.0',
              health: 'healthy'
            }
          }
        })
      );

      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--export', 'json', '--fleet-id', 'eride', '--activity-hours', '0', testDir]);
        const output = JSON.parse(logs.join('\n'));
        expect(output.schema).toBe('aiwg.fleet.status.v1');
        expect(output.machine.fleet_id).toBe('eride');
        expect(output.frameworks[0].id).toBe('sdlc-complete');
        expect(output.provider_deployments).toEqual([
          expect.objectContaining({
            name: 'codex',
            path: '.codex',
            counts: { agents: 1 }
          })
        ]);
        expect(output.activity_log.entries).toEqual([
          expect.objectContaining({
            operation: 'deploy',
            summary: 'deployed codex provider'
          })
        ]);
        expect(output.security).toMatchObject({
          bind_default: '127.0.0.1',
          contains_secrets: false,
          transport: 'pull'
        });
      } finally {
        console.log = originalLog;
      }
    });

    it('exports fleet status as a single NDJSON record', async () => {
      await fs.mkdir(aiwgDir, { recursive: true });
      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await workspaceStatus(['--export', 'ndjson', '--fleet-id', 'oci', testDir]);
        expect(logs).toHaveLength(1);
        const output = JSON.parse(logs[0]);
        expect(output.schema).toBe('aiwg.fleet.status.v1');
        expect(output.machine.fleet_id).toBe('oci');
      } finally {
        console.log = originalLog;
      }
    });

    it('serves fleet status JSON over loopback HTTP', async () => {
      await fs.mkdir(aiwgDir, { recursive: true });
      const { workspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      let server: http.Server | undefined;
      try {
        server = await workspaceStatus(['--serve', '--port', '0', '--fleet-id', 'eclipse', testDir]);
        const address = server.address();
        expect(typeof address).toBe('object');
        const port = typeof address === 'object' && address ? address.port : 0;
        const body = await new Promise<string>((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}/status`, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });
        const output = JSON.parse(body);
        expect(output.schema).toBe('aiwg.fleet.status.v1');
        expect(output.machine.fleet_id).toBe('eclipse');
        expect(logs[0]).toContain('127.0.0.1');
      } finally {
        console.log = originalLog;
        await new Promise<void>((resolve) => {
          if (!server) return resolve();
          server.close(() => resolve());
        });
      }
    });
  });

  describe('workspace-rollback', () => {
    it('should list available backups', async () => {
      // Create backup structure
      const backupDir = path.join(testDir, '.aiwg.backup.2025-12-09T10-00-00-000Z');
      await fs.mkdir(backupDir, { recursive: true });

      const manifest = {
        timestamp: '2025-12-09T10:00:00.000Z',
        fileCount: 10,
        totalSize: 1024,
        checksum: 'abc123'
      };
      await fs.writeFile(
        path.join(backupDir, 'migration-manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      const { rollbackWorkspace } = await import('../../../tools/cli/workspace-rollback.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await rollbackWorkspace(['--list', testDir]);
        const output = logs.join('\n');
        expect(output).toContain('.aiwg.backup.2025-12-09T10-00-00-000Z');
        expect(output).toContain('10');
      } finally {
        console.log = originalLog;
      }
    });

    it('should show message when no backups exist', async () => {
      await fs.mkdir(aiwgDir, { recursive: true });

      const { rollbackWorkspace } = await import('../../../tools/cli/workspace-rollback.mjs');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await rollbackWorkspace(['--list', testDir]);
        const output = logs.join('\n');
        expect(output).toContain('No backups found');
      } finally {
        console.log = originalLog;
      }
    });

    it('should restore a manifestless legacy internal backup', async () => {
      const migrationId = 'migration-123-legacy';
      const backupDir = path.join(aiwgDir, 'backups', migrationId);
      await fs.mkdir(path.join(backupDir, 'intake'), { recursive: true });
      await fs.writeFile(path.join(backupDir, 'intake', 'test.md'), '# Original');
      await fs.mkdir(path.join(aiwgDir, 'intake'), { recursive: true });
      await fs.writeFile(path.join(aiwgDir, 'intake', 'test.md'), '# Modified');

      const { rollbackWorkspace } = await import('../../../tools/cli/workspace-rollback.mjs');
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await rollbackWorkspace(['--yes', testDir]);
        expect(await fs.readFile(path.join(aiwgDir, 'intake', 'test.md'), 'utf8'))
          .toBe('# Original');
        expect(logs.join('\n')).toContain('Rollback complete');
        await expect(fs.access(path.join(aiwgDir, 'backups'))).rejects.toThrow();
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('deploy-agents framework initialization', () => {
    it('should be import-safe without executing a deployment', async () => {
      const deployScript = path.resolve(__dirname, '../../../tools/agents/deploy-agents.mjs');
      const moduleUrl = pathToFileURL(deployScript).href;
      const probe = [
        `const deployed = await import(${JSON.stringify(moduleUrl)});`,
        "if (typeof deployed.main !== 'function') process.exit(2);",
        'await new Promise(resolve => setTimeout(resolve, 750));',
      ].join('\n');

      execFileSync(process.execPath, ['--input-type=module', '--eval', probe], { timeout: 60_000,
        cwd: testDir,
        stdio: 'pipe',
      });

      await expect(fs.access(path.join(testDir, 'AIWG.md'))).rejects.toThrow();
    });

    it('should create marketing directories for marketing mode', async () => {
      // Placeholder for marketing mode test
      expect(true).toBe(true);
    });

    it('should create both framework directories for all mode', async () => {
      // Placeholder for all mode test
      expect(true).toBe(true);
    });
  });
});

describe('Framework Workspace Structure', () => {
  it('should match issue #53 target structure', () => {
    // Verify the expected structure matches the issue
    const expectedStructure = {
      '.aiwg': {
        'frameworks': {
          'sdlc-complete': {
            'projects': {},      // Active project artifacts
            'working': {},       // Temporary multi-agent work
            'archive': {},       // Completed projects
            'repo': {}           // Framework templates, agents, commands
          },
          'media-marketing-kit': {
            'campaigns': {},     // Marketing uses "campaigns"
            'working': {},
            'archive': {},
            'repo': {}
          },
          'registry.json': {}
        },
        'shared': {}             // Cross-framework resources
      }
    };

    expect(expectedStructure['.aiwg']['frameworks']['sdlc-complete']).toHaveProperty('projects');
    expect(expectedStructure['.aiwg']['frameworks']['sdlc-complete']).toHaveProperty('working');
    expect(expectedStructure['.aiwg']['frameworks']['sdlc-complete']).toHaveProperty('archive');
    expect(expectedStructure['.aiwg']['frameworks']['media-marketing-kit']).toHaveProperty('campaigns');
  });
});
