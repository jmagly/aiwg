#!/usr/bin/env bash
# Cut a signed AIWG release tag with the release-signing key.
#
# This wrapper exists because git's `user.signingkey` is typically set to
# a maintainer's PERSONAL commit-signing key. Tags created via plain
# `git tag -s` (or even `git tag -a` when `tag.gpgsign=true` is set) will
# then be signed with that personal key, NOT the release key published in
# `.gitea/keys/maintainers.asc`. The supply-chain gate
# (`tools/ci/verify-signed-tag.sh`) correctly rejects such tags — but the
# error surfaces in CI rather than at the moment of the mistake.
#
# This script forces the correct release key via `git tag -s -u <fingerprint>`
# and runs pre-tag sanity checks so the gate-fail loop becomes a local
# fail-fast loop instead.
#
# Background: a13dabc5 (two-key model — personal key signs commits, release
# key signs tags) and v2026.5.5 incident (signed-tag gate caught wrong-key
# tag on commit fd2ba49e — recovered via re-tag with this procedure).
#
# Usage:
#   tools/release/cut-tag.sh <version> [-m "<custom tag message>"]
#
# Example:
#   tools/release/cut-tag.sh 2026.5.6
#   tools/release/cut-tag.sh 2026.5.6-rc.1  # package version stays 2026.5.6
#   tools/release/cut-tag.sh 2026.5.6 -m "v2026.5.6 — Some Theme"
#
# What it does (fail-fast at each step):
#   1. Verifies <version> matches the CalVer YYYY.M.PATCH shape (no leading zeros)
#   2. Verifies package.json version matches <version>
#   3. Verifies .claude-plugin/marketplace.json version matches (PUW-038 lockstep)
#   4. Verifies apps/cockpit/package.json version matches (@aiwg/cockpit lockstep)
#   5. Verifies packages/cli/package.json version matches (@aiwg/cli lockstep)
#   6. Verifies package-lock.json version matches (CI check:versions / npm ci gate)
#   7. Verifies CHANGELOG.md has an entry for [<version>]
#   8. Verifies docs/releases/v<version>-announcement.md exists
#  8b. Builds the CLI and requires the release infrastructure test lane to pass
#   9. Verifies the AIWG release-signing key is available locally
#  10. Verifies the release-signing key is published in .gitea/keys/maintainers.asc
#  11. Creates the signed tag with `git tag -s -u <release-key-fingerprint>`
#  12. Verifies the tag's signature locally before any push (`git tag -v`)
#  13. Reports next-step push commands; does NOT push automatically
#
# The push step is intentionally left to the operator so this script can
# also be run as a sanity check before a release ceremony.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — single source of truth for the release-signing key
# ---------------------------------------------------------------------------
# Fingerprint of the AIWG release-signing key, per SECURITY.md and
# .gitea/keys/maintainers.asc. Override via $AIWG_RELEASE_KEY_FINGERPRINT
# for forks or migration scenarios.
#
# Release tags use the release-only identity; ordinary commits use the
# maintainer commit key. Public keys for historical tags remain in the
# repository keyring for verification.
RELEASE_KEY_FINGERPRINT="${AIWG_RELEASE_KEY_FINGERPRINT:-401584AAA3376B898FB34427839584D0E25E5126}"

# Source the key from the configured vault at cut time (default on). Set to 0 to sign with a
# key already present in the local GPG keyring (fork/offline scenarios).
AIWG_RELEASE_SIGN_FROM_VAULT="${AIWG_RELEASE_SIGN_FROM_VAULT:-1}"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [ $# -lt 1 ]; then
  cat <<EOF >&2
Usage: $0 <version> [-m "<tag message>"]

Examples:
  $0 2026.5.6
  $0 2026.5.6 -m "v2026.5.6 — Some Release Theme"

The default tag message is "vX.Y.Z — <CalVer date>" if not provided.
EOF
  exit 1
fi

VERSION="$1"
TAG_VERSION="$VERSION"
# RC tags identify a validation attempt; package versions remain stable X.
if [[ "$VERSION" =~ ^(.+)-rc\.([1-9][0-9]*)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
fi
shift

TAG_MESSAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message)
      TAG_MESSAGE="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

TAG="v${TAG_VERSION}"

cat <<EOF
====================================================================
AIWG cut-tag — preflight checks for ${TAG}
====================================================================
EOF

# ---------------------------------------------------------------------------
# 1. CalVer shape: YYYY.M.PATCH (no leading zeros on M or PATCH)
# ---------------------------------------------------------------------------
if ! [[ "$VERSION" =~ ^[0-9]{4}\.([1-9]|1[0-2])\.([0-9]|[1-9][0-9]+)$ ]]; then
  cat <<EOF >&2
FAIL: '$TAG_VERSION' does not match stable or RC CalVer 'YYYY.M.PATCH'.
       - Month must be 1-12 with NO leading zero (use '5' not '05').
       - Patch must have no leading zero either.
       See docs/contributing/versioning.md.
EOF
  exit 1
fi
echo "  [1/13] CalVer shape OK: $VERSION"

# ---------------------------------------------------------------------------
# 2. package.json lockstep
# ---------------------------------------------------------------------------
PKG_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")
if [ "$PKG_VERSION" != "$VERSION" ]; then
  cat <<EOF >&2
FAIL: package.json version is '$PKG_VERSION', expected '$VERSION'.
       Run: npm version $VERSION --no-git-tag-version
       Or edit package.json manually and commit.
EOF
  exit 1
fi
echo "  [2/13] package.json lockstep OK"

# ---------------------------------------------------------------------------
# 3. .claude-plugin/marketplace.json version lockstep (PUW-038 #1139)
#    Current manifests use the top-level field. Keep the legacy metadata.version
#    fallback aligned with tools/workspace/check-marketplace-version.mjs so older
#    release branches can still use this wrapper.
# ---------------------------------------------------------------------------
MP_VERSION=$(node -e "const m=JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log(m.version ?? m.metadata?.version ?? '')")
if [ "$MP_VERSION" != "$VERSION" ]; then
  cat <<EOF >&2
FAIL: .claude-plugin/marketplace.json version is '$MP_VERSION',
       expected '$VERSION' (PUW-038 lockstep — #1139).
       Update the file and commit.
EOF
  exit 1
fi
echo "  [3/13] marketplace.json lockstep OK"

# ---------------------------------------------------------------------------
# 4. Published packages, including @aiwg/flue, stay in lockstep
node tools/workspace/check-marketplace-version.mjs
# @aiwg/cockpit package lockstep
# ---------------------------------------------------------------------------
COCKPIT_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('apps/cockpit/package.json','utf8')).version)")
if [ "$COCKPIT_VERSION" != "$VERSION" ]; then
  cat <<EOF >&2
FAIL: apps/cockpit/package.json version is '$COCKPIT_VERSION',
       expected '$VERSION' so @aiwg/cockpit stays compatible with aiwg.
       Update the file and commit.
EOF
  exit 1
fi
echo "  [4/13] @aiwg/cockpit package lockstep OK"

# ---------------------------------------------------------------------------
# 5. @aiwg/cli package lockstep
# ---------------------------------------------------------------------------
CLI_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('packages/cli/package.json','utf8')).version)")
if [ "$CLI_VERSION" != "$VERSION" ]; then
  cat <<EOF >&2
FAIL: packages/cli/package.json version is '$CLI_VERSION',
       expected '$VERSION' so @aiwg/cli stays compatible with aiwg.
       Update the file and commit.
EOF
  exit 1
fi
echo "  [5/13] @aiwg/cli package lockstep OK"

# ---------------------------------------------------------------------------
# 6. package-lock.json lockstep
#    CI's `check:versions` / `npm ci` reject a lockfile whose version drifts
#    from package.json, which fails the build gate and blocks npm publish.
#    Catch it here instead of after the tag is already pushed.
# ---------------------------------------------------------------------------
LOCK_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package-lock.json','utf8')).version)")
if [ "$LOCK_VERSION" != "$VERSION" ]; then
  cat <<EOF >&2
FAIL: package-lock.json version is '$LOCK_VERSION', expected '$VERSION'.
       Run: npm install --package-lock-only
       (then commit package-lock.json) so CI's check:versions / npm ci pass.
EOF
  exit 1
fi
echo "  [6/13] package-lock.json lockstep OK"

# ---------------------------------------------------------------------------
# 7. CHANGELOG.md entry exists
# ---------------------------------------------------------------------------
if ! grep -q "^## \[${VERSION}\]" CHANGELOG.md; then
  cat <<EOF >&2
FAIL: CHANGELOG.md does not contain '## [${VERSION}]'.
       Add the release entry before tagging — see docs/releases/.
EOF
  exit 1
fi
echo "  [7/13] CHANGELOG.md entry OK"

# ---------------------------------------------------------------------------
# 8. Release announcement file exists
# ---------------------------------------------------------------------------
ANNOUNCEMENT="docs/releases/v${VERSION}-announcement.md"
if [ ! -f "$ANNOUNCEMENT" ]; then
  cat <<EOF >&2
FAIL: $ANNOUNCEMENT does not exist.
       Create the release announcement before tagging.
       See docs/releases/v2026.5.5-announcement.md as a template.
EOF
  exit 1
fi
echo "  [8/13] Announcement file OK"

# Required before either an RC or stable tag can be created. Run before any
# signing-key lookup so failed infrastructure checks do not open the keyring.
npm run build:cli
# The Flue example's locked dependencies back the release-slow Flue end-to-end test,
# as in every CI workflow that runs this lane.
if [ -f examples/flue-node/package-lock.json ]; then
  npm ci --prefix examples/flue-node --no-audit --no-fund
fi
node tools/ci/run-with-hang-report.mjs --timeout 30m -- npm run test:release-slow
echo "  [8b/13] Release infrastructure lane passed"

# ---------------------------------------------------------------------------
# 7b. Source the signing key from the configured vault into an ephemeral keyring.
# ---------------------------------------------------------------------------
# The dedicated CI key and its machine passphrase are vault-only. We fetch both
# into mode-600 keyfiles, import the key into a throwaway GNUPGHOME, and point
# git at a loopback-pinentry gpg wrapper so `git tag -s` is non-interactive.
# Nothing is written to the operator's real keyring; everything is shredded on
# exit. Requires VAULT_CI_ROLE_ID / VAULT_CI_SECRET_ID (CI secrets, or exported from
# the operator TPM credstore — see docs/contributing/versioning.md).
GIT_TAG_GPG_OPTS=()
if [ "$AIWG_RELEASE_SIGN_FROM_VAULT" = "1" ]; then
  if [ -z "${VAULT_CI_ROLE_ID:-}" ] || [ -z "${VAULT_CI_SECRET_ID:-}" ]; then
    cat <<EOF >&2
FAIL: AIWG_RELEASE_SIGN_FROM_VAULT=1 but VAULT_CI_ROLE_ID / VAULT_CI_SECRET_ID are
       not set. Export the ci-aiwg AppRole creds before cutting the tag, e.g.
       from the operator vault handoff or credential store.
       Or set AIWG_RELEASE_SIGN_FROM_VAULT=0 to sign with a locally-held key.
       See docs/contributing/versioning.md → "Signing your release tag".
EOF
    exit 1
  fi
  RELEASE_GNUPGHOME="$(mktemp -d)"
  RELEASE_FETCH_ENV="$(mktemp)"
  chmod 700 "$RELEASE_GNUPGHOME"; chmod 600 "$RELEASE_FETCH_ENV"
  cleanup_release_key() {
    bash ci/vault-fetch.sh --cleanup >/dev/null 2>&1 || true
    [ -n "${RELEASE_GNUPGHOME:-}" ] && rm -rf "$RELEASE_GNUPGHOME"
    [ -n "${RELEASE_FETCH_ENV:-}" ] && rm -f "$RELEASE_FETCH_ENV"
  }
  trap cleanup_release_key EXIT
  if ! bash ci/vault-fetch.sh --spec ci/vault-fetch.release-signing.spec \
       --env-file "$RELEASE_FETCH_ENV"; then
    echo "FAIL: could not fetch the release-signing key from the configured vault." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a; . "$RELEASE_FETCH_ENV"; set +a
  export GNUPGHOME="$RELEASE_GNUPGHOME"
  gpg --batch --import "$GPG_SIGNING_KEY_FILE" >/dev/null 2>&1
  GPG_WRAPPER="$GNUPGHOME/git-gpg.sh"
  GPG_PROBE="$GNUPGHOME/signing-probe"
  printf 'pinentry-mode loopback\n' > "$GNUPGHOME/gpg.conf"
  cat > "$GPG_WRAPPER" <<WRAP
#!/usr/bin/env bash
exec gpg --batch --pinentry-mode loopback --passphrase-file "$GPG_PASSPHRASE_FILE" "\$@"
WRAP
  chmod 700 "$GPG_WRAPPER"
  printf 'aiwg release signing probe\n' > "$GPG_PROBE"
  if ! "$GPG_WRAPPER" --yes --local-user "$RELEASE_KEY_FINGERPRINT" \
       --detach-sign "$GPG_PROBE" >/dev/null 2>&1; then
    echo 'FAIL: release-signing probe failed with the vault-supplied passphrase.' >&2
    exit 1
  fi
  rm -f "$GPG_PROBE" "$GPG_PROBE.sig"
  GIT_TAG_GPG_OPTS=(-c "gpg.program=$GPG_WRAPPER")
  echo "  [7b/12] Release-signing key sourced from vault (ephemeral keyring)"
fi

# ---------------------------------------------------------------------------
# 9. Release-signing key available locally
# ---------------------------------------------------------------------------
if ! gpg --list-secret-keys "$RELEASE_KEY_FINGERPRINT" >/dev/null 2>&1; then
  cat <<EOF >&2
FAIL: Release-signing key $RELEASE_KEY_FINGERPRINT not found in local
       GPG keyring. Either import it (gpg --import) or override the
       fingerprint with \$AIWG_RELEASE_KEY_FINGERPRINT.
       If you are running from Codex or another agent runtime, check:
         gpgconf --list-dirs | grep '^homedir:'
       The runtime may set HOME to an isolated role directory. If the
       operator keyring is elsewhere, rerun with:
         GNUPGHOME=/home/<user>/.gnupg tools/release/cut-tag.sh $TAG_VERSION
       See docs/contributing/versioning.md → "Signing your release tag".
EOF
  exit 1
fi
echo "  [9/13] Release-signing key present locally"

# ---------------------------------------------------------------------------
# 10. Release-signing key published in maintainers.asc
# ---------------------------------------------------------------------------
# Extract fingerprints from the committed keyring and check ours is among
# them. We use `gpg --show-keys --with-colons` so the output is parseable
# without depending on locale.
if ! gpg --show-keys --with-colons .gitea/keys/maintainers.asc 2>/dev/null \
     | awk -F: '$1=="fpr" {print $10}' | grep -qx "$RELEASE_KEY_FINGERPRINT"; then
  cat <<EOF >&2
FAIL: Release-signing key $RELEASE_KEY_FINGERPRINT is NOT published in
       .gitea/keys/maintainers.asc. The supply-chain gate will reject
       the tag. Publish the key:
         gpg --armor --export $RELEASE_KEY_FINGERPRINT >> .gitea/keys/maintainers.asc
         git add .gitea/keys/maintainers.asc
         git commit -m 'security: republish release signing key'
EOF
  exit 1
fi
echo "  [10/13] Release-signing key published in maintainers.asc"

# ---------------------------------------------------------------------------
# 11. Create signed tag with explicit release key (-u override)
# ---------------------------------------------------------------------------
if [ -z "$TAG_MESSAGE" ]; then
  TODAY=$(date -u '+%Y-%m-%d')
  TAG_MESSAGE="${TAG} — ${TODAY}"
fi

# Refuse to overwrite an existing local tag — operators must run
# `git tag -d $TAG` explicitly first to acknowledge the destructive op.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  cat <<EOF >&2
FAIL: Tag '$TAG' already exists locally. Refusing to overwrite.
       To recreate intentionally:
         git tag -d $TAG
         git push origin :refs/tags/$TAG    # if it was already pushed
         $0 $TAG_VERSION                          # re-run this script
EOF
  exit 1
fi

git "${GIT_TAG_GPG_OPTS[@]}" tag -s -u "$RELEASE_KEY_FINGERPRINT" "$TAG" -m "$TAG_MESSAGE"
echo "  [11/13] Signed tag '$TAG' created with release key"

# ---------------------------------------------------------------------------
# 12. Local verify (mirror of the CI gate logic)
# ---------------------------------------------------------------------------
# Verification must use the same ephemeral release-key adapter as signing.
# The repository-level gpg.program intentionally points at the distinct
# commit-signing key, so plain `git tag -v` would invoke the wrong AppRole and
# reject a tag that was correctly signed with the release key.
if ! git "${GIT_TAG_GPG_OPTS[@]}" tag -v "$TAG" >/dev/null 2>&1; then
  cat <<EOF >&2
FAIL: Ephemeral release-key verification of '$TAG' did not succeed.
       Check that the release key is not expired or revoked and that the
       injected release-key route resolves to the expected fingerprint.
       Deleting the bad tag for cleanup:
EOF
  git tag -d "$TAG" >/dev/null 2>&1 || true
  exit 1
fi
echo "  [12/13] Local 'git tag -v' verification passed"

# ---------------------------------------------------------------------------
# 13. Report next steps; do NOT auto-push
# ---------------------------------------------------------------------------
if [ "$TAG_VERSION" != "$VERSION" ]; then
  cat <<EOF

  [13/13] RC tag verified. Push the exact candidate to the GitHub mirror
  when its full validation run is authorized:

    git push github main "refs/tags/$TAG"

  Watch release-candidate.yml and preserve its immutable artifact bundle.
  Complete the real release comparison and regression disposition before
  requesting stable promotion. See docs/contributing/versioning.md.

====================================================================
EOF
else
cat <<EOF

  [13/13] Ready to push. The push step is left manual on purpose —
  inspect the tag once more with 'git tag -v $TAG' if you want, then:

    git push origin main --tags
    git push github main --tags    # if mirroring to GitHub

  After push, watch for the gitea-release / npm-publish / github-mirror
  workflows. The supply-chain gate runs first; a green gate is the
  precondition for any artifact emission.

====================================================================
EOF
fi
