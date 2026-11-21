# Agent Skills Adoption Issue Plan

**Parent:** #1569  
**Status:** Filing preview; requires explicit approval before issue creation  
**Research:** `docs/reports/agentskills-standard-audit-2026-07-25.md`

## Proposed Filing Order

### Wave 0 — Decisions and corpus readiness

#### 1. `feat(skills): define Agent Skills conformance profiles and metadata bridge`

**Type:** feature / architecture  
**Labels:** `feature`, `kind/skill`, `provider/all`, `phase:elaboration`,
`priority:P1-high`  
**Depends on:** none  
**Blocks:** issues 3–7

Scope:

- pin the upstream contract and document update policy;
- define strict, AIWG-compatible, and discovery validation profiles;
- add a typed intermediate representation for standard and AIWG metadata;
- define projection rules, sidecar format, collision precedence, provenance,
  trust state, and provider degradation statuses;
- resolve `allowed-tools` versus AIWG `commandHint.allowedTools`;
- define local-directory v1 and pinned-Git v1 import sources; explicitly defer
  any registry protocol until a concrete registry is selected.

Acceptance:

- an ADR/schema maps every standard field and every current AIWG control field;
- no standard field is silently discarded;
- strict exports contain no AIWG-only top-level keys;
- name-rule ambiguity and upstream version are recorded;
- security and collision decisions are testable, not prose-only.

#### 2. `fix(skills): normalize canonical skill metadata for Agent Skills compatibility`

**Type:** maintenance / bug  
**Labels:** `bug`, `kind/skill`, `quality`, `provider/all`,
`priority:P1-high`  
**Depends on:** issue 1 profile decision  
**Blocks:** issue 6 corpus fixtures

Scope:

- repair the `ralph`/`al` directory-name mismatch without breaking aliases;
- normalize nine media-curator names to directory names;
- flatten/string-encode the Hermes template's standard `metadata` values or
  relocate AIWG structure to the extended sidecar;
- regenerate plugin mirrors;
- add a corpus regression check for independent strict-format defects.

Acceptance:

- all 496 canonical skills pass the compatible profile;
- strict failures are limited to intentional AIWG extension fields;
- plugin mirrors are regenerated and agree with canonical sources;
- aliases and discovery remain backward compatible.

### Wave 1 — Core implementation

#### 3. `feat(skills): implement secure Agent Skills directory and Git import`

**Type:** feature  
**Labels:** `feature`, `kind/skill`, `provider/all`, `phase:construction`,
`priority:P1-high`  
**Depends on:** issue 1  
**Blocks:** issues 5–7

Scope:

- add `agentskills`/path source handling to the existing skills registry layer;
- accept a local skill directory and a pinned Git URL/revision;
- stage and validate before mutating the managed store;
- preserve the full directory tree and exact source bytes;
- compute content digests and write provenance/trust sidecars;
- add dry-run, force/update policy, deterministic collision handling, atomic
  install, rollback, and structured JSON output;
- never execute imported scripts during import or validation.

Acceptance:

- a conforming fixture imports from a directory and pinned Git source;
- invalid or colliding imports leave no partial state;
- repeated imports are idempotent;
- traversal, symlink escape, oversized input, and untrusted activation cases are
  tested;
- source, revision, digest, trust, and validation results are inspectable.

#### 4. `feat(skills): add Agent Skills conformance validation to CLI and doctor`

**Type:** feature / quality  
**Labels:** `feature`, `kind/skill`, `quality`, `provider/all`,
`phase:construction`, `priority:P1-high`  
**Depends on:** issue 1  
**Blocks:** issues 5–7

Scope:

- implement the shared standard-aware parser and validator;
- expose profiles through `aiwg validate-metadata` and `aiwg skill-lint`;
- add `aiwg doctor` checks for canonical, imported, and deployed skills;
- provide stable diagnostic codes and human/JSON/CI output;
- add advisory limits for 500 lines, 5,000 tokens, resource paths, and
  one-level references;
- test against pinned `skills-ref` fixtures without embedding it as a runtime
  dependency.

Acceptance:

- all normative metadata constraints have positive and negative fixtures;
- directory-name and metadata string-map rules are enforced;
- current AIWG syntax parses in compatible mode;
- strict mode rejects AIWG-only top-level keys;
- doctor identifies source-versus-deployed drift and provider degradation.

### Wave 2 — Deployment and end-to-end quality

#### 5. `feat(skills): deploy imported Agent Skills through every provider adapter`

**Type:** feature  
**Labels:** `feature`, `kind/skill`, `provider/all`, `phase:construction`,
`priority:P1-high`  
**Depends on:** issues 1, 3, 4  
**Blocks:** issues 6–7

Scope:

- deploy from the managed imported representation through all 12 target IDs;
- preserve scripts, references, assets, and other files;
- emit strict standard frontmatter on native Agent Skills surfaces;
- move AIWG bookkeeping out of portable `SKILL.md`;
- replace silent truncation with explicit projection/degradation behavior;
- handle Hermes and Devin Desktop layout constraints explicitly;
- retain safe managed cleanup and protect user-owned collisions.

Acceptance:

- one conforming fixture deploys successfully to every supported target;
- every output is either strict-conforming or reports a documented degraded
  projection;
- imported resources and standard fields survive;
- provider transforms cannot introduce strict-invalid frontmatter;
- update and uninstall affect only AIWG-managed artifacts.

#### 6. `test(skills): add Agent Skills round-trip and 12-provider conformance matrix`

**Type:** test / quality  
**Labels:** `quality`, `kind/skill`, `provider/all`, `phase:construction`,
`priority:P1-high`  
**Depends on:** issues 2–5  
**Blocks:** parent completion

Scope:

- add a normative fixture corpus and malformed/security fixtures;
- cover import → managed store → provider deploy → reparse;
- verify all standard fields, body, and resource hashes;
- verify AIWG extension recovery through sidecars;
- cover collisions, precedence, idempotence, rollback, symlinks, and provider
  degradation;
- add CI drift detection against the pinned upstream rules.

Acceptance:

- all 12 targets have explicit assertions;
- portable round trips preserve semantic standard content and resource hashes;
- exact-byte preservation is asserted in the managed store;
- failures are deterministic and leave no partial deployment;
- a controlled upstream-version update produces a reviewable fixture diff.

### Wave 3 — User experience

#### 7. `docs(skills): document Agent Skills import, mapping, trust, and provider behavior`

**Type:** documentation  
**Labels:** `docs`, `documentation`, `kind/skill`, `provider/all`,
`priority:P2-medium`  
**Depends on:** issues 3–6  
**Blocks:** parent completion

Scope:

- document directory and pinned-Git import;
- provide the six-field mapping table and AIWG extension/sidecar rules;
- explain strict, compatible, and discovery profiles;
- document trust prompts, script safety, provenance, collisions, and updates;
- publish the 12-provider path/degradation matrix;
- add troubleshooting and round-trip examples;
- correct existing contradictory claims about required AIWG skill fields.

Acceptance:

- a user can import, validate, deploy, inspect, update, and remove a fixture
  using documented commands;
- provider-specific differences and unsupported semantics are explicit;
- no documentation implies an official agentskills.io registry exists;
- examples are exercised in documentation tests or CI smoke tests.

## Dependency Graph

```text
1 contract ──┬──> 3 import ──┐
             ├──> 4 validate ├──> 5 deploy ──> 6 matrix ──> 7 docs
             └──> 2 corpus ──┘
```

Issues 2, 3, and 4 can proceed in parallel after issue 1. Issue 7 may begin
earlier, but it should not close until the tested CLI and provider behavior are
stable.

## Duplicate Search Terms

Before filing, search open and closed issues for:

- `Agent Skills`, `agentskills.io`, `skills-ref`, `conformance`
- `skill import`, `skills registry`, `ClawHub`, `OpenClaw`
- `validate-metadata`, `skill-lint`, `frontmatter linter`
- `round trip`, `provider matrix`, `skill resources`
- `ralph name`, `media-curator skill name`, `aiwg-orchestrate metadata`

Existing #1569 remains the parent tracking issue. Closed #1553 confirmed that
OpenHuman can load `SKILL.md` bundles directly and established its current
global, one-level deployment behavior. The provider-deployment issue should cite
that evidence and retain its verified path semantics; it should not reopen the
superseded project trust-marker design.
