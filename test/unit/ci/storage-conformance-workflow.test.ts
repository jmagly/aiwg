import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('storage conformance CI gate (#2191)', () => {
  it('runs the zero-dependency storage gate after the pinned SQLite backend is available', () => {
    const workflow = readFileSync(resolve('.gitea/workflows/ci.yml'), 'utf8');
    const install = workflow.indexOf('npm run features:sqlite');
    const gate = workflow.indexOf('npm run test:conformance:storage');
    const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts as Record<string, string>;

    expect(install).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(install);
    // The pin moved into the shared installer so a contributor and CI get the
    // same build (#2515); assert it where it now lives, not where it used to.
    expect(scripts['features:sqlite']).toContain('better-sqlite3@12.8.0');
    expect(workflow).toContain('Run storage backend conformance gate (#2190/#2191)');
  });

  it('keeps live server suites outside the zero-dependency main-CI step', () => {
    const workflow = readFileSync(resolve('.gitea/workflows/ci.yml'), 'utf8');
    expect(workflow).not.toContain('npm run test:conformance:storage:server');
  });

  it('declares manual-only isolated PostgreSQL, PostgREST, and Fortemi evidence jobs', () => {
    const workflow = readFileSync(resolve('.gitea/workflows/storage-server-conformance.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\bpull_request:/);
    expect(workflow).not.toMatch(/\bpush:/);
    expect(workflow).not.toMatch(/secrets\.AIWG_(?:POSTGRES|POSTGREST|FORTEMI)/);
    expect(workflow.match(/secrets\.VAULT_CI_ROLE_ID/g)).toHaveLength(8);
    expect(workflow.match(/secrets\.VAULT_CI_SECRET_ID/g)).toHaveLength(8);
    expect(workflow).toContain('ci/vault-fetch.storage-postgres.spec');
    expect(workflow).toContain('ci/vault-fetch.storage-postgrest.spec');
    expect(workflow).toContain('ci/vault-fetch.storage-postgrest-auth.spec');
    expect(workflow).toContain('ci/vault-fetch.storage-fortemi.spec');
    expect(workflow).toContain('ci/vault-fetch.storage-fortemi-auth.spec');
    expect(workflow.match(/bash ci\/vault-fetch\.sh --cleanup/g)).toHaveLength(3);
    const postgresDriver = workflow.indexOf('pg@8.23.0');
    const postgresSuite = workflow.indexOf('test/integration/storage-postgres-live.test.ts');
    expect(postgresDriver).toBeGreaterThanOrEqual(0);
    expect(postgresSuite).toBeGreaterThan(postgresDriver);
    expect(workflow).toContain('test/integration/storage-postgrest-live.test.ts');
    expect(workflow).toContain('npm run test:fortemi:live');
    expect(workflow).toContain("default: false");
    expect(workflow).toContain('AIWG_FORTEMI_LIVE_ALLOW_WRITE: ${{ github.event.inputs.fortemi_allow_write }}');
    expect(workflow).toContain('false|\'\') unset AIWG_FORTEMI_LIVE_ALLOW_WRITE');
    expect(workflow).toContain('name: storage-fortemi-${{ gitea.sha }}');
    expect(workflow).not.toContain('AIWG_FORTEMI_LIVE_ALLOW_WRITE: 1');
    expect(workflow.match(/AIWG_STORAGE_QUALIFICATION_COMMIT/g)).toHaveLength(1);
    expect(workflow.match(/actions\/checkout@[0-9a-f]{40}/g)).toHaveLength(3);
    expect(workflow.match(/actions\/upload-artifact@[0-9a-f]{40}/g)).toHaveLength(3);
  });
});
