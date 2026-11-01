import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site notification is a post-attestation callback, not a tag-push race', async () => {
  const workflow = await readFile('.gitea/workflows/notify-site.yml', 'utf8');
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /AIWG_VERIFY_TAG_REF=.*verify-signed-tag\.sh/);
  assert.match(workflow, /git show .*setup\.aiwg\.yaml.*> \/tmp\/setup\.aiwg\.yaml/);
  assert.match(workflow, /git cat-file -e .*agentic\.yaml/);
  assert.match(workflow, /missing authoritative agentic\.yaml/);
  assert.match(workflow, /SETUP_SHA256=\$\(sha256sum \/tmp\/setup\.aiwg\.yaml/);
  assert.match(workflow, /setup_sha256: \$setup_sha256/);
  assert.match(workflow, /aiwg\.site-publication\/v1/);
  assert.match(workflow, /aiwg\.resource-manifest\/v1/);
  assert.match(workflow, /aiwg\.resource-manifest\/v2/);
  assert.match(workflow, /application\/vnd\.aiwg\.artifact-attestation\.v1\+json/);
  assert.match(workflow, /setup\.aiwg\.yaml\.aiwg-attestation\.json/);
  assert.match(workflow, /agentic\.yaml\.aiwg-attestation\.json/);
  assert.match(workflow, /channel_sequence/);
  assert.match(workflow, /channel_expires_at/);
  assert.match(workflow, /httpMetadataIsNonAuthoritative: true/);
  assert.match(workflow, /attestation-aware aiwg\.io deploy dispatched/);
});

test('private web release handoff follows mirrored evidence and carries signed-source descriptors', async () => {
  const workflow = await readFile('.gitea/workflows/upload-release-sigs.yml', 'utf8');
  const mirror = workflow.indexOf('- name: Verify release assets land on Gitea release');
  const dispatch = workflow.indexOf('- name: Dispatch private web release pipeline');
  assert.ok(mirror >= 0 && dispatch > mirror, 'web publication must follow release evidence mirroring');
  assert.match(workflow, /aiwg\.web-release-handoff\/v1/);
  assert.match(workflow, /AIWG_VERIFY_TAG_REF=.*verify-signed-tag\.sh/);
  assert.match(workflow, /git cat-file -e .*agentic\.yaml/);
  assert.match(workflow, /Web attestation emission is stopped; mirrored release evidence was not deleted/);
  assert.match(workflow, /requireMonotonicSequence: true/);
  assert.match(workflow, /requireExpiry: true/);
  assert.match(workflow, /channel: "stable"/);
  assert.match(workflow, /after: "signed-release-and-attestations-published"/);
  assert.match(workflow, /httpMetadataIsNonAuthoritative: true/);
});

const PUBLIC_TOKEN_TO_MIRROR_OUTPUT = new Map([
  ['$TARBALL', 'tarball'],
  ['aiwg-cli-${VERSION}.tgz', 'cli_tarball'],
  ['aiwg-cockpit-${VERSION}.tgz', 'cockpit_tarball'],
  ['aiwg-flue-${VERSION}.tgz', 'flue_tarball'],
  ['$TARBALL_SIG', 'tarball_sig'],
  ['$MANIFEST', 'manifest'],
  ['$MANIFEST_SIG', 'manifest_sig'],
  ['$SBOM', 'sbom'],
  ['$SBOM_SIG', 'sbom_sig'],
  ['$INSTALLER', 'installer'],
  ['$CHECKSUMS', 'checksums'],
]);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test('Gitea downloads, uploads and verifies the complete GitHub asset set', async () => {
  const github = await readFile('.github/workflows/npm-publish.yml', 'utf8');
  const mirror = await readFile('.gitea/workflows/upload-release-sigs.yml', 'utf8');
  const publicUpload = section(github, 'gh release upload "$TAG"', '--clobber');
  const download = section(mirror, '- name: Download signed assets from GitHub release', '- name: Look up Gitea release ID');
  const upload = section(mirror, '- name: Upload signed assets to Gitea release', '- name: Verify release assets land on Gitea release');
  const verify = section(mirror, '- name: Verify release assets land on Gitea release', '- name: Dispatch private web release pipeline');

  for (const [publicToken, output] of PUBLIC_TOKEN_TO_MIRROR_OUTPUT) {
    assert.ok(publicUpload.includes(publicToken), `GitHub upload must include ${publicToken}`);
    const expression = `\${{ steps.tag.outputs.${output} }}`;
    assert.ok(download.includes(expression), `mirror download must include ${output}`);
    assert.ok(upload.includes(expression), `mirror upload must include ${output}`);
    assert.ok(verify.includes(expression), `mirror verification must include ${output}`);
  }
  assert.match(verify, /COUNT=.*grep -cFx "\$f"/);
  assert.match(verify, /expected exactly one \$f on Gitea release after upload/);
});
