---
enforcement: high
triggers:
  - "how do I pin a github action"
  - "container image pinning"
  - "is this workflow safe"
---

# CI Action and Container Pinning

**Enforcement Level**: HIGH
**Scope**: All CI workflow files (`.github/workflows/`, `.gitea/workflows/`, equivalent) and any `container:` references therein
**Issue**: #1293

## Principle

CI workflows execute third-party code with broad permissions on every push. A workflow that references `actions/checkout@v4` or `node:24` resolves the reference at run time — the bytes that execute today are not guaranteed to be the bytes that execute tomorrow. Anyone who can move the `v4` tag (a GitHub Action maintainer compromise, a registry account takeover, a published-but-malicious update) silently runs new code in your CI. Pinning by immutable digest closes this attack surface.

This is the same standard AIWG applies to its own CI per [`dev-idempotent-builds.md`](https://github.com/jmagly/aiwg/blob/main/agentic/code/extensions/dev/rules/dev-idempotent-builds.md) rule 2 ("no `:latest` in production"). B3 extends the standard to user projects as a deployable rule.

## Mandatory Rules

### Rule 1: GitHub Actions references pinned by 40-char commit SHA

Every `uses:` reference in a workflow file MUST point at a 40-character commit SHA, not a tag or branch.

**FORBIDDEN**:
```yaml
- uses: actions/checkout@v4              # tag — can move
- uses: actions/checkout@main            # branch — definitely moves
- uses: actions/checkout@v4.3.1          # version tag — usually immutable but a compromised account can re-point it
```

**REQUIRED**:
```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5  # v4.3.1
```

The trailing comment is non-optional. It preserves human-readable diffability without compromising the immutability of the SHA pin.

### Rule 2: Container images pinned by sha256 digest

Every `container:` or `image:` reference in a workflow MUST be `<name>:<tag>@sha256:<digest>`.

**FORBIDDEN**:
```yaml
container: node:24
container: node:latest
container: node:24-bookworm
container: ghcr.io/owner/image:v2.1.0
```

**REQUIRED**:
```yaml
container: node:24@sha256:050bf2bbe33c1d6754e060bec89378a79ed831f04a7bb1a53fe45e997df7b3bb  # 24.15.0
```

The `<name>:<tag>` prefix is retained for human readability; the digest is the trust anchor. Trailing comment captures the resolved version for diff context.

### Rule 3: Pin manifest at `ci/digests.txt` (or equivalent)

Every project that enforces this rule MUST maintain a pin manifest listing each pinned reference, its resolved version, the date pinned, and the rationale. The manifest is the source of truth for diffs — a SHA change without a corresponding manifest entry is a red flag.

Reference manifest format: see AIWG's own [`ci/digests.txt`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/ci/digests.txt).

Minimum row format:
```
<kind>  <name>            <pin>                                          <resolved-version>  <date-pinned>  <update-rationale>
container  node:24       sha256:050bf2bbe33c1d6754e060bec89378a79ed831f04a7bb1a53fe45e997df7b3bb  24.15.0  2026-05-12  initial pin
action  actions/checkout  93cb6efe18208431cddfb8368fd83d5badbf9bfd       v5.0.1              2026-05-12  initial pin
```

### Rule 4: Pin bumps go through review

Every pin update is a reviewable change. The commit should:
- Reference the issue or advisory motivating the bump (CVE, needed feature, scheduled rotation)
- Update the manifest row in the same commit as the workflow file edit
- Include `chore(ci): bump <name> pin to <version> (refs #<issue>)` style commit message

Workflow diffs that change a digest without a corresponding manifest update fail review.

### Rule 5: Standalone tools pinned by version + checksum

Tools downloaded by `curl | sh` or equivalent in CI (e.g., `syft install.sh`, ad-hoc binary releases) MUST pin a specific version AND record the installer's content hash. The version pin gives reproducibility; the content hash detects upstream tampering.

**Acceptable pattern** (strict-mode opt-in, with observed-SHA logging):
```yaml
- name: Install syft
  run: |
    VERSION=v1.18.0
    EXPECTED_INSTALL_SHA=""  # populate after first run; logs `observed` SHA
    SCRIPT=$(curl -fsSL "https://raw.githubusercontent.com/anchore/syft/${VERSION}/install.sh")
    OBSERVED_SHA=$(printf '%s' "$SCRIPT" | sha256sum | awk '{print $1}')
    echo "observed install-script SHA: ${OBSERVED_SHA}"
    if [ -n "$EXPECTED_INSTALL_SHA" ] && [ "$OBSERVED_SHA" != "$EXPECTED_INSTALL_SHA" ]; then
      echo "✗ install-script SHA drift — refusing to execute"
      exit 1
    fi
    printf '%s' "$SCRIPT" | sh -s -- -b /usr/local/bin "$VERSION"
```

## Detection Patterns

CI lint should flag the following:

```bash
# Floating action tags
grep -rE '^\s*-\s*uses:\s*[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+@(v?[0-9]+(\.[0-9]+)*|main|master|latest)\s*(#.*)?$' \
  .github/workflows/ .gitea/workflows/ 2>/dev/null

# Unpinned container images
grep -rE '^\s*(container|image):\s*[a-zA-Z0-9._/-]+:[a-zA-Z0-9._-]+\s*(#.*)?$' \
  .github/workflows/ .gitea/workflows/ 2>/dev/null \
  | grep -v 'sha256:'

# Bare :latest anywhere
grep -rnE ':latest\b' .github/workflows/ .gitea/workflows/ 2>/dev/null

# Curl-pipe-shell installers without a content hash check
grep -rnE 'curl[^|]+\|\s*(bash|sh)' .github/workflows/ .gitea/workflows/ 2>/dev/null
```

Wire these into a `npm run lint:ci-pins` script (or equivalent) and call it from the CI workflow itself so the rule is self-enforcing.

## Acceptable Exceptions

The following are NOT subject to this rule:

1. **Dockerfile `FROM` instructions in build stages** that are NOT consumed by CI directly — those are governed by the project's image-build pipeline (which should follow the same standard, but the rule lives in the Dockerfile review, not the workflow review).
2. **Ephemeral self-hosted runners** that pull pre-baked AMIs/images with their own attestation chain — the chain-of-trust is at the AMI level, not the workflow level.
3. **Reusable workflows from the same repository** (`uses: ./.github/workflows/foo.yml`) — these are pinned to the repository state at the calling commit.
4. **Build-arg substitutions for the same digest** — `FROM ${BASE_IMAGE}` where `BASE_IMAGE` is built from a digest-pinned reference one level up.

Document any other exception in a code comment adjacent to the unpinned reference, with reasoning and an issue link tracking eventual migration to a pin.

## Rationale

The mutable-tag attack surface is one of the largest unaddressed components of npm-ecosystem supply-chain risk as of 2026. The recent Shai-Hulud worm campaign demonstrated that compromised maintainer accounts can push malicious updates that propagate via floating version tags within hours. Workflows pinned by SHA stop that propagation at the boundary of every individual project that pins.

Pin-bump cost is low (one curl/git ls-remote command); incident cost from an unpinned dependency executing in CI with secret access is high. The asymmetry justifies the rule.

## References

- [`dev-idempotent-builds.md`](https://github.com/jmagly/aiwg/blob/main/agentic/code/extensions/dev/rules/dev-idempotent-builds.md) — base rule on reproducible builds
- AIWG's own pin manifest: `ci/digests.txt`
- Defenses brief C7 (action pinning) and C8 (container pinning)
- Shai-Hulud worm post-mortem references
- GitHub Actions documentation: pinning third-party actions to a full-length commit SHA

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-13
