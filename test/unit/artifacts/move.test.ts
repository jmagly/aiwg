import { mkdtempSync } from '../../helpers/temp-dir.js';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, relative as pathRelative } from 'node:path';
import { tmpdir } from 'node:os';
import { moveProjectArtifacts } from '../../../src/artifacts/move.js';
import { PROJECT_AIWG_LOCATION_FILE, resolveProjectAiwgDir } from '../../../src/config/project-artifacts.js';

describe('moveProjectArtifacts', () => {
  it('moves the artifact root, writes a pointer, updates gitignore, and rebuilds the project index', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-move-'));
    const destination = join(mkdtempSync(join(tmpdir(), 'aiwg-artifacts-destination-')), 'renamed-aiwg');
    try {
      mkdirSync(join(projectDir, '.aiwg', 'requirements'), { recursive: true });
      mkdirSync(join(projectDir, '.aiwg', 'frameworks'), { recursive: true });
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n', 'utf-8');
      writeFileSync(join(projectDir, '.aiwg', 'AIWG.md'), '# Normalized AIWG context\n', 'utf-8');
      writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), '{"version":"1"}\n', 'utf-8');
      writeFileSync(join(projectDir, '.aiwg', 'frameworks', 'registry.json'), '{"version":"1"}\n', 'utf-8');
      writeFileSync(
        join(projectDir, '.aiwg', 'requirements', 'UC-001.md'),
        ['---', 'title: Authentication Requirement', 'type: use-case', 'phase: requirements', '---', '', '# Authentication Requirement', ''].join('\n'),
        'utf-8',
      );

      const result = await moveProjectArtifacts({
        projectDir,
        to: destination,
        syncFortemi: false,
      });

      expect(result.moved).toBe(true);
      expect(existsSync(join(projectDir, '.aiwg'))).toBe(true);
      expect(readFileSync(join(projectDir, '.aiwg', 'AIWG.md'), 'utf-8')).toBe('# Normalized AIWG context\n');
      expect(readFileSync(join(projectDir, '.aiwg', 'aiwg.config'), 'utf-8')).toBe('{"version":"1"}\n');
      expect(readFileSync(join(projectDir, '.aiwg', 'frameworks', 'registry.json'), 'utf-8')).toBe('{"version":"1"}\n');
      expect(existsSync(join(projectDir, '.aiwg', 'requirements', 'UC-001.md'))).toBe(false);
      expect(existsSync(join(destination, 'requirements', 'UC-001.md'))).toBe(true);
      expect(readFileSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'utf-8')).toContain('renamed-aiwg');
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toContain(PROJECT_AIWG_LOCATION_FILE);
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toContain('!.aiwg/AIWG.md');
      expect(resolveProjectAiwgDir(projectDir, {})).toBe(destination);

      const metadata = JSON.parse(
        readFileSync(join(destination, '.index', 'project', 'metadata.json'), 'utf-8'),
      ) as { entries: Record<string, { path: string; title: string }> };
      expect(metadata.entries['.aiwg/requirements/UC-001.md']?.title).toBe('Authentication Requirement');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('moves an already pointer-configured renamed store without requiring --from', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-move-pointer-'));
    const source = join(projectDir, 'private-artifacts', 'old-aiwg-store');
    const destination = join(projectDir, 'private-artifacts', 'new-aiwg-store');
    try {
      mkdirSync(join(source, 'architecture'), { recursive: true });
      writeFileSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'private-artifacts/old-aiwg-store\n', 'utf-8');
      writeFileSync(
        join(source, 'architecture', 'ADR-PORTABLE.md'),
        ['---', 'title: Portable Store ADR', 'type: adr', 'phase: architecture', '---', '', '# Portable Store ADR', ''].join('\n'),
        'utf-8',
      );

      const result = await moveProjectArtifacts({
        projectDir,
        to: 'private-artifacts/new-aiwg-store',
        syncFortemi: false,
      });

      expect(result.from).toBe(source);
      expect(result.to).toBe(destination);
      expect(result.pointerValue).toBe('private-artifacts/new-aiwg-store');
      expect(result.moved).toBe(true);
      expect(result.reindexed).toBe(true);
      expect(existsSync(join(source, 'architecture', 'ADR-PORTABLE.md'))).toBe(false);
      expect(existsSync(join(destination, 'architecture', 'ADR-PORTABLE.md'))).toBe(true);
      expect(readFileSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'utf-8')).toContain('private-artifacts/new-aiwg-store');
      expect(resolveProjectAiwgDir(projectDir, {})).toBe(destination);

      const metadata = JSON.parse(
        readFileSync(join(destination, '.index', 'project', 'metadata.json'), 'utf-8'),
      ) as { entries: Record<string, { path: string; title: string }> };
      expect(metadata.entries['.aiwg/architecture/ADR-PORTABLE.md']?.path).toBe('.aiwg/architecture/ADR-PORTABLE.md');
      expect(metadata.entries['.aiwg/architecture/ADR-PORTABLE.md']?.title).toBe('Portable Store ADR');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('dry-runs without moving or writing the pointer', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-move-dry-'));
    const destination = join(mkdtempSync(join(tmpdir(), 'aiwg-artifacts-destination-')), '.aiwg');
    try {
      mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
      const result = await moveProjectArtifacts({
        projectDir,
        to: destination,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.moved).toBe(false);
      expect(existsSync(join(projectDir, '.aiwg'))).toBe(true);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('attaches an existing populated artifact root without moving either tree', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-attach-'));
    const destination = join(mkdtempSync(join(tmpdir(), 'aiwg-artifacts-destination-')), '.aiwg');
    try {
      mkdirSync(join(projectDir, '.aiwg', 'working'), { recursive: true });
      mkdirSync(join(destination, 'requirements'), { recursive: true });
      writeFileSync(join(projectDir, '.gitignore'), '.aiwg/\n', 'utf-8');
      writeFileSync(join(projectDir, '.aiwg', 'working', 'local.md'), '# Local\n', 'utf-8');
      writeFileSync(join(destination, 'aiwg.config'), '{"version":"1"}\n', 'utf-8');
      writeFileSync(join(destination, 'AIWG.md'), '# External normalized context\n', 'utf-8');
      writeFileSync(
        join(destination, 'requirements', 'UC-ATTACH.md'),
        ['---', 'title: Attached Requirement', 'type: use-case', '---', '', '# Attached Requirement', ''].join('\n'),
        'utf-8',
      );

      const result = await moveProjectArtifacts({
        projectDir,
        to: destination,
        attach: true,
        syncFortemi: false,
      });

      expect(result.moved).toBe(false);
      expect(result.attached).toBe(true);
      expect(existsSync(join(projectDir, '.aiwg', 'working', 'local.md'))).toBe(true);
      expect(existsSync(join(destination, 'requirements', 'UC-ATTACH.md'))).toBe(true);
      expect(readFileSync(join(projectDir, '.aiwg', 'AIWG.md'), 'utf-8')).toBe('# External normalized context\n');
      expect(readFileSync(join(projectDir, '.aiwg', 'aiwg.config'), 'utf-8')).toBe('{"version":"1"}\n');
      expect(resolveProjectAiwgDir(projectDir, {})).toBe(destination);
      expect(readFileSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE), 'utf-8')).toContain(
        pathRelative(projectDir, destination),
      );
      expect(existsSync(join(destination, '.index', 'project', 'metadata.json'))).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('refuses to attach a directory that is not an AIWG artifact root', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-attach-invalid-'));
    const destination = join(projectDir, 'not-an-artifact-root');
    try {
      mkdirSync(destination, { recursive: true });
      await expect(moveProjectArtifacts({
        projectDir,
        to: destination,
        attach: true,
        syncFortemi: false,
      })).rejects.toThrow(/has no aiwg\.config/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('refuses to attach when a local control-plane file diverges', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifacts-attach-drift-'));
    const destination = join(projectDir, 'external', '.aiwg');
    try {
      mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), '{"project":"local"}\n', 'utf-8');
      writeFileSync(join(destination, 'aiwg.config'), '{"project":"external"}\n', 'utf-8');

      await expect(moveProjectArtifacts({
        projectDir,
        to: destination,
        attach: true,
        syncFortemi: false,
      })).rejects.toThrow(/control-plane file differs/);
      expect(existsSync(join(projectDir, PROJECT_AIWG_LOCATION_FILE))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
