import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface FixtureRecord {
  id: string; path: string; origin: string; author: string; date: string;
  permission: string; sanitization: string; schemaVersion: string;
  digest: string; expectedOutcome: string; links: string[];
}

const manifestPath = 'test/fixtures/decision/qualification-fixtures-v1.json';

describe('decision qualification fixture provenance', () => {
  it('pins named fixture bytes and required origin/permission/sanitization metadata', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { schemaVersion: string; fixtures: FixtureRecord[] };
    expect(manifest.schemaVersion).toBe('decision-qualification-fixtures/v1');
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    expect(new Set(manifest.fixtures.map(item => item.id)).size).toBe(manifest.fixtures.length);
    for (const item of manifest.fixtures) {
      expect(item.id).toMatch(/^DEC-[A-Z]+-[0-9]{2}$/);
      expect(item.path).toMatch(/^test\/fixtures\/decision\/[a-z0-9/.-]+\.json$/);
      expect(item.origin).toBe('repository-authored');
      expect(item.author.length).toBeGreaterThan(0);
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.permission).toBe('MIT (repository LICENSE)');
      expect(item.sanitization).toBe('synthetic; no personal inputs');
      expect(item.expectedOutcome.length).toBeGreaterThan(0);
      expect(item.links).toContain('JEV-16');
      const bytes = await readFile(resolve(item.path));
      expect(item.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      expect((JSON.parse(bytes.toString('utf8')) as { schemaVersion: string }).schemaVersion).toBe(item.schemaVersion);
    }
  });
});
