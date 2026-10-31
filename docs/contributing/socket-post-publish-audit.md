# Socket post-publish audit

AIWG captures Socket package-analysis evidence after npm trusted publishing succeeds. This is a separate, fail-closed evidence workflow: it does not weaken or replace npm provenance, release signatures, or any pre-publish gate.

## What is evaluated

The workflow evaluates the CLI and Flue entry points, `aiwg`, `@aiwg/cli` and `@aiwg/flue`, at the exact release version. It inventories the published dependency tree plus every explicitly configured npm and Cargo lockfile, queries resolved external package versions, and records findings in two groups:

- **direct** — alerts and category scores on the two AIWG packages;
- **transitive** — alerts on packages reached through their runtime dependency tree.

Secondary npm lockfile roots, private packages, and workspace links are not query targets. Cargo packages at version `0.0.0` without a `source` are local workspace packages and are excluded, including `aiwg-cockpit-desktop`. Registry and git dependencies at `0.0.0` remain in the inventory. The published CLI and Flue entry points remain explicit targets.

Category scores are compared independently with [`ci/socket-score-baseline.json`](../../ci/socket-score-baseline.json). A score drop of 0.10 or greater triggers review. Scanner scoring models can evolve, so a score change is evidence to investigate—not authorization to remove or degrade a supported capability.

Intentional capability alerts require a review record containing a rationale, owner, review date, expiry date, and a condition that triggers early revalidation. Expired records fail the audit. Unreviewed high or critical alerts also fail.

The baseline classifies `socketUpgradeAvailable` as informational: it advertises a Socket replacement package rather than a security defect. Reports retain the original severity and replacement props. Socket's organization-level `action` values do not override this repository's policy.

## Failure and unavailable states

The workflow never converts missing evidence into a clean result. Missing credentials, HTTP errors, rate limits after bounded retries, malformed responses, delayed scans, `pendingScan`, `notFound`, and missing requested packages produce an `unavailable` report and a failed workflow.

Before building the published dependency inventory, the workflow polls `npm view <pkg>@<version> version` for `aiwg`, `@aiwg/cli`, `@aiwg/cockpit`, and `@aiwg/flue`. All four must return the exact release version. The default visibility wait is 45 minutes, with checks every 30 seconds. Registry requests and sleeps are bounded by the remaining wait; npm fetch retries are disabled.

If npm still holds any package in review when the wait expires, the workflow skips dependency installation and Socket scanning. Both the job summary and uploaded `workflow-status.md` record `unavailable: npm-review-pending`, the release version/tag/commit, and the exact manual re-dispatch command. The final audit gate still fails closed for unavailable evidence; the release publication remains successful. Re-dispatch once all four versions are visible.

Every run uploads workflow status evidence, including when npm visibility expires. When Socket evaluation runs, it also uploads JSON and Markdown reports even when evaluation fails. Reports contain alert metadata but never include the API token.

Each finding is bound to the scanned commit and carries one provenance record per matching workspace: manifest path, lockfile path, SHA-256 lock digest, package ecosystem, and dependency path. Repeated package/artifact/rule findings collapse into one record with all affected paths. Because the query is derived from current locks, removed packages disappear on the next successful scan instead of surviving as stale root findings.

Live alerts supply a detector key, type, severity, category, and optional file and props. The evaluator retains props and maps `key` to the evidence rule identifier. Artifact hashes, files, symbols, excerpts, behavior traces, and confidence rationales are optional enrichments: their absence does not produce validation errors. Supplied evidence must still have the expected type and nonempty text; advisory URLs must use HTTP(S), and patched versions must be valid versions. Behavioral alerts still require a rule identifier. Code-shape-only obfuscation is informational unless provenance or behavior evidence establishes security impact. Accept-risk reviews require a rationale and the exact artifact hash; a materially different artifact is therefore reviewed again. Without a matching review, direct capability alerts still block even when enrichment is absent.

Export validation rejects duplicate finding IDs and CVE findings without advisory identifiers or URLs. For CVE alerts (including `mediumCVE` and `mildCVE`), advisory evidence maps from `props.cveId` (falling back to `props.ghsaId`), `props.url`, and `props.firstPatchedVersionIdentifier`; legacy top-level fields remain supported. Upstream first-patched versions may belong to a newer major release and are preserved as advisory data, not asserted to be compatible upgrades. Capability alerts such as `potentialVulnerability` do not require an advisory URL when no advisory is supplied. The configured organization name is rendered in the report rather than a hard-coded label.

## Captured response regression fixture

[`test/fixtures/release/socket-live-npm.ndjson`](../../test/fixtures/release/socket-live-npm.ndjson) is reduced from the 2026-10-25 live organization PURL response for 335 npm components, requested with `alerts=true&summary=true`. It contains public package data, retaining original artifact metadata and unmodified alerts (including complete CVE props). The original capture SHA-256 is `0770c83ba6663fd1f560a1091883a2692308a12c87e64eaaad9c554d9033ae3f`.

Reduction keeps the first three alerts of each type in response order and drops artifacts without retained alerts and the aggregate summary, whose counts describe the unreduced response. There are 33 artifacts and 60 alerts across 22 types. `installScripts`, `potentialVulnerability`, and `gptDidYouMean` each occur only once in the source, so their single available example is retained. The fixture includes body-parser and both zod CVEs, install scripts, filesystem, network, shell, and replacement notices. Tests evaluate this fixture directly without network access.

Two earlier synthetic test expectations changed for #3578: absent behavioral enrichments now pass validation because the live API omits them, and valid first-patched versions from a different major line are retained because Socket supplies that shape for zod. Severity blocking, review expiry and artifact binding, duplicate IDs, missing CVE identifiers, and score regression checks remain covered.

## Repository configuration

Configure these values in the GitHub repository:

- secret `SOCKET_API_TOKEN`, restricted to Socket's `packages:list` scope;
- variable `SOCKET_ORG_SLUG`, containing the Socket organization slug.
- optional variable `SOCKET_NPM_VISIBILITY_WAIT_MINUTES` (default `45`): integer minutes from `1` to `90` to wait for all four exact npm versions. Values outside that range fail configuration validation.
- optional variable `SOCKET_PACE_QUOTA_MINUTES` (default `120`): how long the audit may wait for the next Socket quota window after HTTP 429. A release has roughly 800 components, more than the free plan's 500 units per hour, so pacing is on by default.

The job timeout is 240 minutes: the maximum 90-minute npm visibility wait + 120 minutes of Socket pacing + 30 minutes for checkout, inventory, scanning, and evidence upload. If increasing Socket pacing above 120 minutes, increase the workflow timeout to preserve that allowance.

The tag-bound npm publication workflow invokes the Socket workflow directly as
a reusable workflow after publication succeeds. This avoids relying on a
default-branch `workflow_run` listener when the public mirror's `main` history
differs from the signed release tag. The call passes the exact published version
and release source commit; the audit rejects a version, tag ref, or commit
mismatch before querying Socket.

The workflow uses Socket's organization-scoped batch PURL endpoint with polling
enabled. After service recovery or review remediation, dispatch the workflow
definition from `main` with the immutable release tag and its peeled commit:

```bash
VERSION=2026.9.20
TAG="v${VERSION}"
COMMIT="$(git rev-parse "${TAG}^{commit}")"
gh workflow run socket-post-publish.yml \
  --repo jmagly/aiwg \
  --ref main \
  -f version="$VERSION" \
  -f tag="$TAG" \
  -f commit="$COMMIT"
```

The `--ref main` selects the workflow definition containing the visibility wait;
the `tag` input selects the source checkout and must identify `v<version>`. The
operator supplies the peeled commit from that immutable tag; the workflow fails
before scanning if the checked-out package version, tag ref, and source commit
do not agree.

## Local fixture or operator run

```bash
SOCKET_API_TOKEN=... SOCKET_ORG_SLUG=... \
node tools/release/socket-post-publish-audit.mjs \
  --version 2026.8.8 \
  --dependency-lock /path/to/published-tree/package-lock.json \
  --dependency-lock package-lock.json \
  --dependency-lock tools/eval/package-lock.json \
  --dependency-lock apps/cockpit/desktop/src-tauri/Cargo.lock \
  --commit "$(git rev-parse HEAD)" \
  --organization "Integro Labs"
```

Socket bills the purl endpoint per request, not per component, so the audit sends up to 500 components per request (`--batch-size <N>` or `SOCKET_PURL_BATCH_SIZE` to change it). A release of about 800 components takes two requests. On a plan whose hourly API quota is smaller than one full run (the free plan allows 500 units an hour), add `--pace-quota-minutes <N>` (or `SOCKET_PACE_QUOTA_MINUTES`). When the API answers HTTP 429, the audit then waits for the next quota window and retries the same batch. It reports the 429 if the window opens more than N minutes after the run started. Without the flag, the bounded retries are unchanged. Supply the token from your secret store at run time, never from a file in the repository.

Use `--input path/to/results.ndjson` instead of credentials for deterministic fixture evaluation. A passing result exits 0, a policy failure exits 1, and unavailable evidence exits 2.
