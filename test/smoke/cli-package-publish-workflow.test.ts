import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('@aiwg/cli release workflow wiring', () => {
  it('builds, retains, and publishes the exact smoke-tested CLI tarball with advisory provenance checks', () => {
    const workflow = parse(readFileSync(path.join(ROOT, '.github/workflows/npm-publish.yml'), 'utf8'));
    const steps = workflow.jobs['publish-to-npmjs-org'].steps;
    const index = (name: string) => steps.findIndex((step: { name?: string }) => step.name === name);
    const required = ['Verify signed tag (#1299 / A9 gate)', 'Validate and build stable release',
      'Pack and smoke-test exact npm surfaces', 'Retain smoke-tested tarballs before publication',
      'Publish smoke-tested stable tarballs to npmjs.org', 'Upload signed release assets to GitHub release',
      'Verify provenance attestation landed', 'Verify stable dist-tag policy'];
    for (const name of required) expect(index(name), name).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < required.length; i++) expect(index(required[i - 1])).toBeLessThan(index(required[i]));
    expect(steps[index(required[1])].run).toContain('npm run package:cli');
    expect(steps[index(required[2])].run).toContain('release-candidate.mjs pack');
    expect(steps[index(required[3])].with.path).toBe('${{ runner.temp }}/stable-package/');
    expect(index('Verify all retained tarballs before publication')).toBeLessThan(index(required[4]));
    const publish = steps[index(required[4])];
    expect(publish.run).toContain('direct-stable-publish.mjs');
    expect(publish.run).toContain('aiwg-cli-${VERSION}.tgz');
    expect(publish.if).toBeUndefined();
    expect(publish['continue-on-error']).toBeUndefined();
    expect(steps[index(required[6])]['continue-on-error']).toBe(true);
    expect(steps[index(required[6])].run).toContain('verify_attestations @aiwg/cli');
    expect(steps[index(required[7])]['continue-on-error']).toBe(true);
    expect(steps[index(required[7])].run).toContain('verify-npm-dist-tags.sh');
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['tag_to_publish']);
  });

  it('manually mirrors the public packages using the Gitea registry and verifies installation', () => {
    const workflow = parse(readFileSync(path.join(ROOT, '.gitea/workflows/npm-publish.yml'), 'utf8'));
    const steps = workflow.jobs['build-and-publish'].steps;
    const index = (name: string) => steps.findIndex((step: { name?: string }) => step.name === name);
    expect(workflow.on.push).toBeUndefined();
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['tag_to_publish']);
    const names = ['Verify workflow identity is tag-bound', 'Verify signed tag (#1299 / A9 gate)',
      'Fetch Gitea npm token from vault', 'Fetch public stable tarballs and mirror them',
      'Preserve publication receipt', 'Retire next on Gitea'];
    for (const name of names) expect(index(name), name).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < names.length; i++) expect(index(names[i - 1])).toBeLessThan(index(names[i]));
    expect(steps[index(names[2])].run).toBe('bash ci/vault-fetch.sh --spec ci/vault-fetch.npm-publish.spec');
    const mirror = steps[index(names[3])];
    expect(mirror.run).toContain('npm pack "${PACKAGE}@${VERSION}"');
    expect(mirror.run).toContain('direct-stable-publish.mjs --mirror');
    expect(mirror.run).toContain('@aiwg/cli');
    expect(mirror.run).not.toContain('AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN');
    expect(steps[index(names[4])].if).toContain('always()');
    expect(steps[index(names[5])].run).toContain('npm dist-tag rm "$PACKAGE" next');
    const verify = workflow.jobs['verify-install'].steps.find((step: { name?: string }) => step.name === 'Clean-install Gitea package tarballs');
    expect(verify.run).toContain('npm view "@aiwg/cli@${VERSION}" dist.tarball --registry=');
    expect(verify.run).toContain('"$CLI_INSTALL/node_modules/.bin/aiwg" help');
    expect(verify.run).toContain('"$COCKPIT_INSTALL/node_modules/.bin/aiwg-cockpit"');
    expect(verify.run).toContain('flue-package-smoke.mjs');
  });

  it('documents a dependency-safe Gitea mirror install in generated releases', () => {
    const workflow = readFileSync(path.join(ROOT, '.gitea/workflows/gitea-release.yml'), 'utf8');
    const workflowHeader = workflow.slice(0, workflow.indexOf('\njobs:'));

    expect(workflow).toContain('tag_to_publish:');
    expect(workflow).toContain(
      'AIWG_VERIFY_TAG_REF: refs/tags/${{ steps.release_tag.outputs.release_tag }}',
    );
    expect(workflow).toContain(
      'git checkout --detach "refs/tags/${{ steps.release_tag.outputs.release_tag }}"',
    );
    expect(workflow.indexOf('Checkout release tag')).toBeLessThan(
      workflow.indexOf('Verify source-bound storage benchmark claims'),
    );
    expect(workflowHeader).not.toContain('GT_RELEASE_TOKEN_VAULT_FIELD');
    expect(workflow).toContain(
      'api/packages/roctinam/npm/aiwg/-/%s/aiwg-%s.tgz',
    );
    expect(workflow).toContain(
      'Gitea bundled npm is a package store, not an npmjs proxy.',
    );
    expect(workflow).not.toContain(
      'npm install -g aiwg@%s --registry=https://git.integrolabs.net/api/packages/roctinam/npm/',
    );
  });

  it('keeps Gitea release asset recovery idempotent when duplicate names are accepted', () => {
    const workflow = readFileSync(path.join(ROOT, '.gitea/workflows/upload-release-sigs.yml'), 'utf8');

    expect(workflow).toContain('delete_existing_assets "$name"');
    expect(workflow).toContain("select(.name == $n) | .id");
    expect(workflow).toContain('expected exactly one $f on Gitea release after upload');
  });
});
