# Agent Skills import and deployment

AIWG can validate, import, inspect, update, deploy, export, and uninstall skills
that follow the [Agent Skills](https://agentskills.io/) directory format. Import
is a local managed workflow: agentskills.io specifies a format and authoring
rules, but it does not provide an official registry API or registry protocol.

AIWG pins its interpretation to
`agentskills/agentskills@38a2ff82958afee88dadf4831509e6f7e9d8ef4e`
and `skills-ref` `0.1.0`. Runtime commands do not fetch the specification or
reference validator. See [Upstream baseline](#upstream-baseline) for the update
policy.

## Complete workflow

Portable AIWG source skills use `platforms: [all]`, so explicit copies also
work with newly added providers. Enumerate providers only when a skill
requires a specific native tool, and document that dependency in its body.
The shipped help, document consolidation, and semantic-memory workflows use
generic file operations and CLI commands and need no provider allowlist.

Platform restrictions control copying into provider directories. Indexed
`aiwg discover` and `aiwg show` still expose the source independently of
whether the current provider can load or execute a native skill.

The repository fixture at
`test/fixtures/agent-skills/lifecycle/portable-complete/` is a complete example.
The commands below assume its directory has been copied to
`./portable-complete`.

### 1. Validate

Use `compatible` for an Agent Skills bundle that also carries recognized AIWG
control fields:

```bash
aiwg validate-metadata --profile compatible ./portable-complete/SKILL.md
```

Use `strict` to test the portable boundary. A source with AIWG fields such as
`namespace` or `platforms` intentionally fails strict validation until it is
projected during deployment:

```bash
aiwg validate-metadata --profile strict ./portable-complete/SKILL.md
```

Validation reads Markdown and referenced resources. It does not execute scripts.

### 2. Preview import

```bash
aiwg skills import ./portable-complete \
  --profile compatible \
  --dry-run \
  --json
```

Dry-run validates, calculates the source digest, reports provenance and trust,
and writes nothing.

### 3. Import, trust, and activate

```bash
aiwg skills import ./portable-complete \
  --profile compatible \
  --trust \
  --activate
```

Activation always requires explicit trust. Trust applies to the exact source
locator and content digest; changing either invalidates the prior activation.
Import copies accepted regular files as exact bytes into:

```text
.aiwg/skills/imported/portable-complete/source/
.aiwg/skills/imported/portable-complete/manifest.json
```

Scripts, references, assets, license files, and empty directories are preserved.
Import, inspection, validation, and deployment never execute imported scripts.

### 4. Import a pinned Git source

Git imports require all three source selectors. The revision may be a commit,
tag, or other explicit Git revision; AIWG records both the requested revision
and resolved commit.

```bash
aiwg skills import \
  --git https://example.com/team/skills.git \
  --rev 0123456789abcdef0123456789abcdef01234567 \
  --subpath skills/portable-complete \
  --profile compatible \
  --trust \
  --activate
```

Unpinned Git requests are rejected. AIWG also rejects unsafe Git arguments,
credential-bearing URLs, traversal, symlinks, special files, and configured
size-limit violations before managed state is promoted.

### 5. Inspect

```bash
aiwg skills info portable-complete --provider agentskills
aiwg doctor
```

`skills info` reports the managed path, digest, validation profile, source
locator, requested/resolved Git revisions when applicable, trust, and activation.
`doctor` compares active provider projections with regenerated strict output and
reports source, sidecar, resource, or projection drift.

### 6. Preview and deploy

```bash
aiwg skills deploy portable-complete --target generic --dry-run --json
aiwg skills deploy portable-complete --target generic
```

Use any canonical target ID from the [provider matrix](#provider-matrix), or use
`--target all` to return one structured result per target:

```bash
aiwg skills deploy portable-complete --target all --json
```

The all-target command writes every supported managed projection, including the
Hermes user-global `~/.hermes/skills/<name>` bundle.

### 7. Update

After reviewing a change in the same local or Git source:

```bash
aiwg skills import ./portable-complete \
  --profile compatible \
  --update \
  --trust \
  --activate

aiwg skills deploy portable-complete --target generic
```

`--update` is required when the same source changes. Use `--force` only for an
intentional source-locator replacement after reviewing the collision. A changed
digest requires a new trust and activation decision. Both import and deployment
use staged atomic promotion and restore the prior managed version on failure.

### 8. Uninstall a provider projection

```bash
aiwg skills uninstall portable-complete --target generic --dry-run
aiwg skills uninstall portable-complete --target generic
```

Uninstall removes only a directory with the exact AIWG ownership marker and a
valid matching deployment sidecar. It never removes a user-owned collision.
The managed import remains available for inspection and later redeployment.

### 9. Export an AIWG skill as a strict bundle

Export is separate from publish. It creates a portable Agent Skills directory
from a local AIWG skill without requiring any registry protocol:

```bash
aiwg skills export aiwg-status --out ./agent-skill-exports --json
```

The exported directory is `./agent-skill-exports/aiwg-status/`. Its `SKILL.md`
contains only strict Agent Skills frontmatter. Recognized AIWG control fields
are omitted from `SKILL.md` and listed in `.aiwg-agent-skill-export.json` with
source path, source digest, export digest, exported time, AIWG version, and the
pinned upstream baseline. Use `--dry-run` to preview and `--force` only after
reviewing an existing output directory.

## Portable and AIWG metadata

### Six standard fields

| Agent Skills field | AIWG representation | Strict deployment |
|---|---|---|
| `name` | `standard.name` | Preserved; 1-64 lowercase ASCII letters, digits, or single hyphens, matching the directory |
| `description` | `standard.description` | Preserved; never silently truncated |
| `license` | `standard.license` | Preserved, including a relative license-file reference |
| `compatibility` | `standard.compatibility` | Preserved |
| `metadata` | `standard.metadata` | Preserved as string-to-string entries |
| `allowed-tools` | `standard["allowed-tools"]` | Preserved; experimental upstream |

`name` and `description` are required by Agent Skills. `namespace` and
`platforms` are not Agent Skills requirements. They are AIWG control fields that
canonical AIWG sources may require under separate source policy.

### Retained AIWG categories

Recognized AIWG fields are accepted by `compatible`, retained in the sidecar,
and excluded from strict `SKILL.md`.

| Category | Retained fields |
|---|---|
| Identity and compatibility | `namespace`, `aliases`, `deprecated_names`, `legacyName`, `version`, `author`, `status` |
| Provider and discovery | `platforms`, `triggers`, `triggerPhrases`, `autoTrigger`, `autoTriggerConditions`, `kernel`, `category`, `capabilities` |
| Execution contract | `requires`, `ensures`, `errors`, `invariants`, `tools`, `script`, `references`, `inputRequirements`, `outputFormat` |
| Invocation policy | `userInvocable`, `disableModelInvocation`, `context`, `effort`, `allowedTools` |
| Command and orchestration | `commandHint` |

AIWG `allowedTools` may project to standard `allowed-tools` only when it is a
list of direct, whitespace-free tool identifiers. `commandHint.allowedTools`
has different command-generation semantics and is never promoted.

### Compatible source

```yaml
---
name: portable-complete
description: Use this complete portable fixture to verify Agent Skills round trips.
license: LICENSE.txt
compatibility: Requires a POSIX-compatible shell and UTF-8 text support.
metadata:
  author: AIWG
  version: "1"
allowed-tools: Read Grep Bash
namespace: fixtures
platforms: [all]
userInvocable: true
---
```

The compatible profile accepts the recognized AIWG fields. It still rejects
unknown external fields, invalid YAML, invalid standard types, and name/directory
mismatches.

### Strict provider projection

```yaml
---
name: portable-complete
description: Use this complete portable fixture to verify Agent Skills round trips.
license: LICENSE.txt
compatibility: Requires a POSIX-compatible shell and UTF-8 text support.
metadata:
  author: AIWG
  version: "1"
allowed-tools: Read Grep Bash
---
```

The provider copy retains the Markdown body and regular resource bytes. AIWG
control fields move to `.aiwg-agent-skill.json`, outside portable frontmatter:

```json
{
  "schemaVersion": 1,
  "kind": "aiwg-managed-agent-skill-projection",
  "name": "portable-complete",
  "provider": "generic",
  "projectionStatus": "native",
  "sourceDigest": "<sha256>",
  "reasons": [
    "provider exposes a native recursive Agent Skills bundle surface"
  ],
  "warnings": [],
  "portable": {
    "$schema": "https://aiwg.io/schemas/skills/agent-skill-sidecar.v1.schema.json",
    "schemaVersion": 1,
    "aiwg": {
      "namespace": "fixtures",
      "platforms": ["all"],
      "userInvocable": true
    },
    "provenance": {
      "sourceKind": "directory",
      "locator": "<reviewed-source>",
      "sourceDigest": "<sha256>",
      "importedAt": "<timestamp>",
      "aiwgVersion": "<version>"
    },
    "validationProfile": "compatible",
    "trust": {
      "state": "trusted",
      "activation": "active"
    }
  }
}
```

The sibling `.aiwg-managed` marker establishes ownership. Neither file is part
of the Agent Skills format.

## Validation profiles

| Profile | Intended input | Unknown fields | Name defects | Result |
|---|---|---|---|---|
| `strict` | Portable Agent Skills output | Error | Error | Invalid on any normative error |
| `compatible` | Standard fields plus recognized AIWG fields | Error | Error | Valid only when all normative rules pass |
| `discovery` | Candidate metadata during scanning | Warning | Warning | Skips unreadable YAML or missing descriptions |

The 500-line and 5,000-token guidance, experimental `allowed-tools` notice,
deep resource references, and missing resource references are advisories.
Normative field/type/name/YAML errors block strict and compatible validation.

## Trust, provenance, and collisions

- Trust is explicit and bound to source locator plus digest.
- Activation requires trust; untrusted imports remain inspectable.
- Any digest drift invalidates activation until reviewed again.
- Local import records the canonical directory locator.
- Git import records URL, requested revision, resolved commit, subpath, and
  digest.
- Source bytes remain immutable under the managed import until an explicit
  update succeeds.
- Project-owned skills outrank user-owned skills, which outrank explicit
  imports, which outrank packaged AIWG-managed skills.
- Deployment and uninstall refuse user-owned target collisions, even when a
  partial or forged marker is present.

## Provider matrix

`<project>` means the directory where the AIWG command runs. `<name>` is the
validated Agent Skills name.

| Target ID | Deployed path | Status for conforming fixture | Resource result | Provider behavior |
|---|---|---|---|---|
| `antigravity` | `<project>/.agents/skills/<name>` | `native` | exact | Project-local native Agent Skills bundle; global skill deployment remains disabled because Google's documented global paths conflict |
| `claude` | `<project>/.claude/skills/<name>` | `native` | exact | Recursive native bundle |
| `codex` | `<project>/.agents/skills/<name>` | `projected` | exact | Project compatibility surface; descriptions over 500 characters are `degraded`/blocked, never truncated |
| `copilot` | `<project>/.github/skills/<name>` | `native` | exact | Recursive native bundle |
| `cursor` | `<project>/.cursor/skills/<name>` | `native` | exact | Recursive native bundle |
| `deepseek-harness` | `<project>/.agents/skills/<name>` | `native` | exact | DeepSeek Harness native filesystem skill surface, shared with other `.agents/skills` consumers |
| `factory` | `<project>/.factory/skills/<name>` | `projected` | exact | Adds Factory description guidance, then strictly reparses |
| `grokbot` | `$AIWG_GROKBOT_SKILLS_DIR/<name>` | `native` | exact | Uses only the explicitly configured absolute skill root; unset or invalid roots fail closed |
| `grok-build` | `<project>/.grok/skills/<name>` | `native` | exact | Experimental project-local native recursive bundle; distinct from Grok Bot and the xAI model/API category |
| `hermes` | `~/.hermes/skills/<name>` | `native` | exact | User-global recursive bundle with managed ownership sidecars |
| `muse` | `<project>/.agents/skills/<name>` | `native` | exact | Experimental project-local native recursive bundle; shares the `.agents/skills` surface with antigravity/codex/deepseek-harness |
| `opencode` | `<project>/.opencode/skill/<name>` | `native` | exact | Recursive native bundle |
| `openclaw` | `~/.openclaw/skills/<name>` | `native` | exact | Global recursive native bundle |
| `openhuman` | `~/.openhuman/skills/<name>` | `projected` | exact | Verified global one-level skill layout |
| `omp` | `<project>/.omp/skills/<name>` | `native` | exact | OMP project-local imported Agent Skills bundle; native one-level discovery |
| `pi` | `<project>/.pi/skills/<name>` | `native` | exact | Pi project-local Agent Skills bundle; loading remains subject to Pi project trust |
| `warp` | `<project>/.warp/skills/<name>` | `native` | exact | Recursive native bundle |
| `windsurf` | `<project>/.windsurf/skills/<name>` | `projected` | exact | One bundle directly below the one-level surface |
| `generic` | `<project>/skills/<name>` | `native` | exact | Recursive portable fallback |

Every supported projection is reparsed with the strict validator. Results
always include provider, path, source digest, projection status, reasons, and
warnings. `degraded` and `unsupported` results name the limitation and do not
silently discard standard data.

## Troubleshooting

| Diagnostic or symptom | Meaning | Remediation |
|---|---|---|
| `AS_YAML_PARSE` | Frontmatter is not valid YAML | Correct the YAML; do not rely on provider-specific parsers |
| `AS_NAME_FORMAT` | Name violates lowercase ASCII/hyphen rules | Use 1-64 lowercase ASCII letters, digits, and single hyphens |
| `AS_NAME_DIRECTORY` | `name` differs from the parent directory | Rename the directory or frontmatter so they match exactly |
| `AS_FIELD_UNKNOWN` | Field is neither standard nor a recognized compatible AIWG field | Remove it or map intentional AIWG policy to a documented field |
| `AS_FIELD_EXTENSION` | A recognized AIWG field was sent to strict validation | Validate source with `compatible`; deployment moves it to the sidecar |
| `AS_METADATA_VALUE_TYPE` | A `metadata` value is not a string | Quote or convert every metadata value to a string |
| `AS_RESOURCE_PATH` | A resource reference is absolute or escapes the skill | Use an in-skill relative reference |
| `AS_IMPORT_TRUST_REQUIRED` | Activation was requested without trust | Repeat import with both `--trust` and `--activate` after review |
| `AS_IMPORT_COLLISION` | A higher-precedence skill or changed source owns the name | Inspect the reported path; rename, use same-source `--update`, or use reviewed `--force` |
| `AS_IMPORT_MANAGED_DRIFT` | Managed bytes differ from the recorded digest | Review the store and restore with an explicit forced import |
| `AS_DEPLOY_IMPORT_INACTIVE` | Import is not trusted and active | Review and re-import the exact digest with trust and activation |
| `AS_DEPLOY_IMPORT_DRIFT` | Deployment source no longer matches its digest | Restore or explicitly update the managed import |
| `AS_DOCTOR_DEPLOYED_DRIFT` | Provider files, sidecar, or resources differ from the desired projection | Review local changes, then redeploy the managed import |
| `AS_EXPORT_COLLISION` | Export output already exists | Inspect the target directory; rerun with `--force` only after review |
| `AS_EXPORT_VALIDATION` | The source skill is not compatible with the Agent Skills contract | Fix the source metadata/body/resource diagnostics before exporting |
| Provider result is `degraded` | Provider cannot represent accepted data without loss | Read `reasons`; change the source or select another provider |
| Provider result is `unsupported` | No safe managed projection is enabled | Use the provider's documented routing path; no target was written |

## Upstream baseline

The accepted baseline is recorded in:

- `src/skills/agent-skills.ts`
- `test/fixtures/agent-skills/upstream-38a2ff82958afee88dadf4831509e6f7e9d8ef4e/`
- `test/fixtures/agent-skills/lifecycle/provider-oracle.json`
- `test/fixtures/agent-skills/lifecycle/validation-oracle.json`
- [Agent Skills portability ADR](../architecture/adr-agent-skills-portability-contract.md)

Updating upstream behavior requires one reviewed change to the typed baseline,
normative/ambiguity fixtures, reference comparison, lifecycle oracles, ADR, and
this guide. CI then presents the fixture and expected-result changes as a
controlled diff. Runtime validation never changes behavior based on live web
content.

## Traceability

| Parent acceptance area | Implementation and evidence |
|---|---|
| Format contract and sidecar | #1875; `src/skills/agent-skills.ts`; sidecar schema and contract tests |
| Canonical corpus compatibility | #1876; corpus compatibility test and normalization manifest |
| Secure managed import | #1877; `src/skills/importer.ts`; local/Git/security/lifecycle tests |
| Shared validation and doctor | #1878; `src/skills/validator.ts`; validator and doctor tests |
| Provider deployment | #1879; `src/skills/deployer.ts`; provider/lifecycle tests |
| Complete conformance matrix | #1880; lifecycle fixtures and round-trip test |
| User workflow and docs smoke | #1881; this guide, CLI reference, and documentation test |
| Hermes managed projection and strict export | #1894, #1895, #1896; `src/skills/exporter.ts`; deployer/export/docs tests |

Together these rows provide the implementation and documentation evidence for
parent issue #1569.

## See also

- [CLI reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md#skills)
- [SKILL.md quality rubric](quality-rubric.md)
- [Agent Skills adoption audit](../reports/agentskills-standard-audit-2026-07-25.md)
- [Agent Skills portability ADR](../architecture/adr-agent-skills-portability-contract.md)
