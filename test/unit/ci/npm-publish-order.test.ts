import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/npm-publish.yml'), 'utf8'));
const steps = workflow.jobs['publish-to-npmjs-org'].steps;
const temporaryRoots: string[] = [];
const step = (name: string) => steps.find((entry: { name: string }) => entry.name === name);
const index = (name: string) => steps.indexOf(step(name));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aiwg-publish-order-'));
  temporaryRoots.push(directory);
  writeFileSync(join(directory, 'CHANGELOG.md'), '## [2026.10.3]\nVersion notes\n## [2026.10.2]\nOld notes\n');
  writeFileSync(join(directory, 'summary'), '');
  return directory;
}

function runStep(name: string, directory: string, mocks = '', env: Record<string, string> = {}) {
  const script = step(name).run
    .replaceAll('${{ steps.version.outputs.version }}', '2026.10.3')
    .replaceAll('${{ steps.version.outputs.npm_tag }}', 'latest')
    .replaceAll(/\$\{\{ github\.event\.inputs\.[^}]+\}\}/g, 'evidence');
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `${mocks}\n${script}`], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      TAG: 'v2026.10.3', VERSION: '2026.10.3',
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      GITHUB_OUTPUT: join(directory, 'output'),
      ...env,
    },
  });
}

const ghMock = `
gh() {
  printf '%s\\n' "$*" >> calls
  if [ "$2" = view ]; then return "\${EXISTS:-1}"; fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --notes-file ]; then cp "$2" notes; break; fi
    shift
  done
}
`;
const registryMocks = `
timeout() {
  printf '%s\\n' "$*" >> calls
  if [ "\${TIMED_OUT:-0}" = 1 ]; then return 124; fi
  shift
  "$@"
}
npm() { printf '%s' "\${ATTESTATIONS:-}"; return "\${NPM_STATUS:-0}"; }
jq() { cat; }
sleep() { :; }
`;

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('direct stable publication and advisory registry checks', () => {
  it('keeps the Gitea mirror manual, tag-bound and ordered after npmjs identity', () => {
    const mirror = parse(readFileSync(join(root, '.gitea/workflows/npm-publish.yml'), 'utf8'));
    expect(mirror.on.push).toBeUndefined();
    expect(Object.keys(mirror.on.workflow_dispatch.inputs)).toEqual(['tag_to_publish']);
    const steps = mirror.jobs['build-and-publish'].steps;
    const position = (name: string) => steps.findIndex((item: {name:string}) => item.name === name);
    expect(position('Verify signed tag (#1299 / A9 gate)')).toBeLessThan(position('Fetch public stable tarballs and mirror them'));
    const script = steps[position('Fetch public stable tarballs and mirror them')].run;
    expect(script).toContain('registry.npmjs.org');
    expect(script).toContain('direct-stable-publish.mjs --mirror');
    expect(script).not.toContain('release-promotion.mjs');
  });

  it('validates, packs and publishes exact stable tarballs before release assets', () => {
    expect(workflow.on.push.tags).toEqual(['v*']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['tag_to_publish']);
    const ordered = ['Verify signed tag (#1299 / A9 gate)', 'Checkout release tag',
      'Validate and build stable release', 'Pack and smoke-test exact npm surfaces',
      'Generate CycloneDX SBOM', 'Preserve exact installer', 'Retain smoke-tested tarballs before publication', 'Publish smoke-tested stable tarballs to npmjs.org',
      'Preserve publication receipt', 'Create or update GitHub release', 'Generate tarball + cosign sign + manifest',
      'Use generated CycloneDX SBOM', 'Sign SBOM with cosign (keyless)', 'Prepare installer and checksum manifest',
      'Upload signed release assets to GitHub release', 'Verification summary',
      'Verify provenance attestation landed', 'Verify stable dist-tag policy', 'Report advisory npm registry checks'];
    for (const name of ordered) expect(index(name), name).toBeGreaterThanOrEqual(0);
    for (let i=1; i<ordered.length; i++) expect(index(ordered[i-1])).toBeLessThan(index(ordered[i]));
    expect(step('Retain smoke-tested tarballs before publication').with.path).toBe('${{ runner.temp }}/stable-package/');
    expect(step('Retain smoke-tested tarballs before publication').with['if-no-files-found']).toBe('error');
    expect(step('Preserve exact installer').run).toContain('validateInputs');
    expect(index('Retain smoke-tested tarballs before publication')).toBeLessThan(index('Verify all retained tarballs before publication'));
    expect(index('Verify all retained tarballs before publication')).toBeLessThan(index('Publish smoke-tested stable tarballs to npmjs.org'));
    expect(step('Verify all retained tarballs before publication').run).toContain('--verify-retention');
    expect(workflow.permissions.actions).toBe('read');
    expect(step('Checkout release tag').run).toContain('git merge-base --is-ancestor');
    expect(step('Publish smoke-tested stable tarballs to npmjs.org').run).toContain('direct-stable-publish.mjs');
    expect(step('Publish smoke-tested stable tarballs to npmjs.org').if).toBeUndefined();
    expect(step('Upload signed release assets to GitHub release').run).toContain('aiwg-cli-${VERSION}.tgz');
    expect(step('Upload signed release assets to GitHub release').run).toContain('aiwg-cockpit-${VERSION}.tgz');
    expect(workflow.jobs['socket-post-publish'].needs).toBe('publish-to-npmjs-org');
  });

  it('recovers registry bytes before building and preserves all tag/signature gates', () => {
    const recover = index('Recover published registry tarballs');
    for (const name of ['Verify workflow identity is tag-bound', 'Verify signed tag (#1299 / A9 gate)', 'Checkout release tag', 'Extract and verify version against tag']) {
      expect(index(name)).toBeLessThan(recover);
      expect(step(name).if).toBeUndefined();
    }
    expect(step('Recover published registry tarballs').run).toContain('--prepare');
    expect(step('Recover published registry tarballs').env.RELEASE_COMMIT).toContain('release_source.outputs.commit');
    expect(step('Publish smoke-tested stable tarballs to npmjs.org').env.ALREADY_PUBLISHED).toContain('recovery.outputs.published_packages');
    expect(step('Publish smoke-tested stable tarballs to npmjs.org').run).toContain('--already-published "$ALREADY_PUBLISHED"');
    for (const name of ['Validate and build stable release', 'Require slow release infrastructure tests', 'Pack and smoke-test exact npm surfaces']) {
      expect(index(name)).toBeGreaterThan(recover);
      expect(step(name).if).toBe("${{ steps.recovery.outputs.recovered != 'true' }}");
      expect(step(name)['continue-on-error']).toBeUndefined();
    }
    for (const name of ['Generate tarball + cosign sign + manifest', 'Sign SBOM with cosign (keyless)']) {
      expect(step(name).run).toContain('node tools/release/cosign-sign-blob.mjs');
      expect(step(name).run).not.toContain('cosign sign-blob');
    }
  });

  it.each(['1', '0'])('creates or updates a public stable release with announcement notes (view status %s)', (exists) => {
    const directory = fixture();
    mkdirSync(join(directory, 'docs/releases'), { recursive: true });
    writeFileSync(join(directory, 'docs/releases/v2026.10.3-announcement.md'), 'Announcement notes');
    const result = runStep('Create or update GitHub release', directory, ghMock, { EXISTS: exists });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(directory, 'calls'), 'utf8');
    expect(calls).toContain(`release ${exists === '0' ? 'edit' : 'create'} v2026.10.3`);
    if (exists === '0') {
      // Re-runs, including recovery for an older tag, must not move the latest marker.
      expect(calls).not.toContain('--latest');
      expect(calls).toContain('--draft=false --prerelease=false');
    } else {
      expect(calls).toContain('--verify-tag --latest=true --prerelease=false');
    }
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toBe('Announcement notes');
  });

  it('retains CHANGELOG and minimal fallback notes and never marks prereleases latest', () => {
    const directory = fixture();
    expect(runStep('Create or update GitHub release', directory, ghMock).status).toBe(0);
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toBe('## [2026.10.3]\nVersion notes\n');
    expect(runStep('Create or update GitHub release', directory, ghMock, { TAG: 'v2026.10.4-rc.1' }).status).toBe(0);
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toContain('# AIWG v2026.10.4-rc.1');
    expect(readFileSync(join(directory, 'calls'), 'utf8')).toContain('--latest=false --prerelease=true');
  });

  it.each(['missing', 'error', 'timeout', 'visible'])('bounds provenance lookups for all four packages when %s', (state) => {
    const directory = fixture();
    const result = runStep('Verify provenance attestation landed', directory, registryMocks, {
      ATTESTATIONS: state === 'visible' ? 'attestation' : '',
      NPM_STATUS: state === 'error' ? '1' : '0',
      TIMED_OUT: state === 'timeout' ? '1' : '0',
    });
    expect(result.status).toBe(state === 'visible' ? 0 : 1);
    const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(state === 'visible' ? 4 : 12);
    for (const name of ['aiwg', '@aiwg/cli', '@aiwg/cockpit', '@aiwg/flue']) {
      expect(calls.some(call => call.includes(`10s npm view ${name}@2026.10.3`))).toBe(true);
    }
    expect(step('Verify provenance attestation landed')['continue-on-error']).toBe(true);
    expect(step('Verify provenance attestation landed')['timeout-minutes']).toBe(3);
  });

  it('makes dist-tag failures and timeouts advisory and reports actionable warnings for both checks', () => {
    const directory = fixture();
    const policy = step('Verify stable dist-tag policy');
    expect(policy['continue-on-error']).toBe(true);
    expect(policy['timeout-minutes']).toBe(2);
    expect(policy.run).toContain('timeout 75s bash tools/release/verify-npm-dist-tags.sh "$VERSION"');
    expect(runStep(policy.name, directory, registryMocks, { TIMED_OUT: '1' }).status).toBe(124);
    const report = step('Report advisory npm registry checks');
    expect(report.if).toContain("steps.npm_provenance.outcome == 'failure'");
    expect(report.if).toContain("steps.npm_dist_tags.outcome == 'failure'");
    const result = runStep(report.name, directory, '', {
      PROVENANCE_OUTCOME: 'failure', DIST_TAGS_OUTCOME: 'failure', RC_TAG: 'v2026.10.3-rc.1',
      RC_RUN_ID: '1', RC_ARTIFACT_ID: '2', COMPARISON_RUN_ID: '3', COMPARISON_ARTIFACT_ID: '4',
      APPROVAL_ISSUE: '3201', APPROVAL_SHA256: 'a'.repeat(64),
    });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/::warning::/g)).toHaveLength(2);
    const summary = readFileSync(join(directory, 'summary'), 'utf8');
    expect(summary).toContain('dist.attestations');
    expect(summary).toContain('latest = 2026.10.3 and absence of next');
    expect(summary.match(/gh workflow run npm-publish.yml --repo jmagly\/aiwg --ref v2026.10.3/g)).toHaveLength(2);
  });

  it('keeps direct publication blocking and the sole npmjs publication entry point', () => {
    const publication = step('Publish smoke-tested stable tarballs to npmjs.org');
    expect(publication['continue-on-error']).toBeUndefined();
    expect(publication.if).toBeUndefined();
    expect(publication.run.match(/direct-stable-publish\.mjs/g)).toHaveLength(1);
    expect(JSON.stringify(workflow)).not.toMatch(/npm publish (?:\.\/|"aiwg)/);
  });
});
