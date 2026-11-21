# Agent Skills Standard Adoption Audit

**Date:** 2026-07-25  
**Parent issue:** #1569  
**Upstream baseline:** `agentskills/agentskills@38a2ff82958afee88dadf4831509e6f7e9d8ef4e` (2026-07-09)  
**Scope:** Research and planning spike; no runtime behavior changed

## Executive Summary

AIWG can adopt the Agent Skills format without replacing its existing skills
architecture. The repository already has a multi-registry skills CLI, provider
path resolution, recursive resource copying, and skill deployment for 12 target
IDs. The missing layer is a standard-aware boundary around those components:

1. parse and validate an external Agent Skills folder;
2. preserve its complete resource tree and provenance;
3. map the six standard fields to AIWG's richer internal metadata;
4. deploy the portable representation through the existing provider adapters;
5. verify round-trip behavior and report provider-specific degradation.

The current AIWG corpus is not strict-conforming. All 496 canonical `SKILL.md`
files contain AIWG extension fields, principally `namespace` and `platforms`,
which the current reference validator rejects. Eleven canonical files also have
independent format defects. This makes a two-profile policy necessary:

- **Agent Skills strict:** only standard fields are emitted at the portability
  boundary.
- **AIWG extended:** canonical source may retain AIWG fields, but the standard
  projection must be lossless for standard data and deterministic for AIWG
  extensions.

Treating every canonical AIWG file as strict Agent Skills source would discard
deployment policy, triggers, orchestration contracts, and model hints. Treating
AIWG's current frontmatter as portable would fail strict consumers. A projection
layer is the compatible solution.

## Verified Upstream Contract

The current specification defines a skill as a directory containing a required
`SKILL.md`; `scripts/`, `references/`, and `assets/` are conventional optional
directories. `SKILL.md` consists of YAML frontmatter followed by Markdown.

The standard frontmatter fields are:

| Field | Requirement | Constraint |
|---|---|---|
| `name` | required | 1–64 characters; lowercase letters/numbers/hyphens; no leading, trailing, or consecutive hyphens; must match parent directory |
| `description` | required | 1–1024 characters; should explain what the skill does and when to use it |
| `license` | optional | license name or reference to a bundled license file |
| `compatibility` | optional | 1–500 character environment/product requirements |
| `metadata` | optional | string-to-string map for additional properties |
| `allowed-tools` | optional, experimental | space-delimited pre-approved tools |

The body is free-form Markdown. The specification recommends keeping
`SKILL.md` below 500 lines and 5,000 tokens, using relative resource paths, and
keeping references one level deep. Clients are expected to use progressive
disclosure: load discovery metadata first, load the full instructions only when
activated, and load referenced resources only as needed.

The official client guidance also introduces runtime concerns outside basic
syntax:

- scan project and user skill roots, including `.agents/skills`;
- apply deterministic collision precedence, with project skills overriding user
  skills;
- require trust confirmation before activating untrusted project skills;
- preserve skill context while instructions or resources are active;
- prefer lenient discovery for recoverable cosmetic defects, while skipping
  missing descriptions or unparseable YAML.

The upstream `skills-ref` package is version `0.1.0` and explicitly described as
a reference implementation, not a production library. AIWG should reproduce
the normative rules in its own tested validator and use the pinned reference
implementation as a compatibility oracle in fixtures.

### Upstream ambiguity to track

The website describes ASCII lowercase names, while the current reference
validator source accepts lowercase Unicode alphanumeric characters. AIWG's
portable profile should initially enforce the narrower website rule for maximum
client compatibility, record the upstream commit used, and add a fixture that
can be updated if the normative text is clarified.

## Corpus Audit

The audit scanned every `SKILL.md` under `agentic/code`, separating canonical
sources from generated/plugin mirrors.

| Population | Files | Strict pass | Pass except AIWG extension fields | Over 500 lines |
|---|---:|---:|---:|---:|
| Canonical addons | 224 | 0 | 223 | 9 |
| Canonical extensions | 4 | 0 | 4 | 0 |
| Canonical frameworks/templates | 268 | 0 | 258 | 76 |
| **Canonical total** | **496** | **0** | **485** | **85** |
| Plugin mirrors | 509 | 0 | 500 | 133 |
| **Repository total** | **1,005** | **0** | **985** | **218** |

The line recommendation is advisory, not a conformance failure. Large skills
should be progressively split into referenced resources during normal
maintenance, with the 85 canonical files tracked as migration debt rather than
blocking import/deploy.

### Repository-wide strict blockers

All 1,005 files contain fields outside the standard allow-list. Common fields:

| Field | Files |
|---|---:|
| `namespace`, `platforms` | 1,005 each |
| `commandHint` | 514 |
| `triggers` | 77 |
| orchestration/contract fields | approximately 53 |
| `kernel` | 49 |
| `tools` | 35 |
| `version` | 29 |
| `category` | 25 |
| `script` | 23 |

The official `skills-ref` validator was run against all 496 canonical
directories. It rejected all 496 at YAML parsing because AIWG commonly uses flow
sequences such as `platforms: [all]`, which StrictYAML disallows. This precedes
its rejection of unexpected fields. Therefore `skills-ref` cannot be embedded
as AIWG's source parser.

### Independent canonical defects

After ignoring AIWG-only fields, 485 of 496 canonical files satisfy the audited
standard rules. The remaining 11 are:

- `agentic/code/addons/agent-loop/skills/ralph/SKILL.md`: `name: al` does not
  match directory `ralph`.
- Nine media-curator skills use title-case, spaced names rather than their
  lowercase hyphenated directory names:
  `archive-acquisition`, `audio-extraction`, `cover-art-embedding`,
  `integrity-verification`, `metadata-tagging`, `provenance-tracking`,
  `quality-filtering`, `transcribe-media`, and `youtube-acquisition`.
- `agentic/code/frameworks/sdlc-complete/templates/hermes/skills/aiwg-orchestrate/SKILL.md`
  has nested/non-string values under `metadata`; standard metadata values must
  be strings.

Plugin copies repeat the nine media-curator defects and should be regenerated
from canonical sources, not repaired independently.

## Existing AIWG Architecture and Gaps

### Registry and installation

`src/skills/registry.ts` coordinates local, ClawHub, and OpenClaw adapters.
`aiwg skills install` already selects a registry and a target provider.
`RegistryAdapter` even documents `agentskills` as a future implementation, but
no Agent Skills adapter exists.

The current adapters usually copy a directory directly into a provider path.
They do not provide:

- local path, archive, or Git URL import for a standard folder;
- source trust and explicit activation confirmation;
- immutable provenance (source URL/path, revision, content digest);
- collision policy between project, user, AIWG-managed, and imported skills;
- validation before mutation;
- atomic staging/rollback;
- a stable canonical cache from which multiple providers can be deployed.

There is no official Agent Skills registry in the specification. The first
implementation should accept a local directory and optionally a Git
URL/revision; a future registry adapter must not assume an
`agentskills.io` registry protocol that does not exist.

### Validation

AIWG currently has three related but divergent paths:

- `tools/linters/skill-frontmatter-linter.mjs` requires AIWG fields
  `name`, `namespace`, `description`, and `platforms`;
- `aiwg validate-metadata` validates AIWG extension/component metadata;
- `aiwg skill-lint` evaluates authoring quality with configurable rubrics.

The shared validator added in #1878 resolves that distinction: `namespace` and
`platforms` remain canonical AIWG source conventions, but are not Agent Skills
requirements. They are compatible-profile extensions and strict-profile
errors. `validate-metadata`, `skill-lint`, imports, and `doctor` now consume one
structured diagnostic model rather than shelling out to `skills-ref`.

### Deployment

Provider definitions expose 12 targets:

| Target | Skill base | Namespace shape |
|---|---|---|
| Claude | `.claude/skills` | recursive |
| Codex | `.codex/skills` definition; normal use routes to project `.agents/skills` | recursive; current transform truncates to 100/500 |
| Copilot | `.github/skills` | recursive |
| Cursor | `.cursor/skills` | recursive |
| Factory | `.factory/skills` | recursive with frontmatter transform |
| Hermes | `~/.hermes/skills` | MCP-skip/special handling |
| OpenCode | `.opencode/skill` | recursive |
| OpenClaw | `~/.openclaw/skills` | recursive |
| OpenHuman | `~/.openhuman/skills` | recursive |
| Warp | `.warp/skills` | recursive |
| Devin Desktop | `.windsurf/skills` | one-level |
| Generic | `skills` | recursive |

The shared deployer already recursively copies resources and adds an
`.aiwg-managed` marker. Provider deployment also mutates frontmatter by injecting
`platforms`, while Codex uses a separate parser/serializer and provider-specific
length limits. These transforms can make a conforming imported skill
non-conforming after deployment.

Deployment needs a standard projection contract:

1. preserve the imported source unchanged in an AIWG-managed cache;
2. emit only standard frontmatter for native Agent Skills destinations;
3. move AIWG/provider bookkeeping to sidecars or an AIWG metadata namespace
   outside portable `SKILL.md`;
4. record explicit degradation where a provider cannot preserve a nested
   resource tree or `allowed-tools`;
5. never silently truncate standard-valid metadata; report an incompatibility
   or use a documented provider projection.

## Recommended Design

### Canonical imported representation

Stage each imported folder under a project-local managed store, keyed by
normalized name and content digest. Store:

- the byte-preserved source tree;
- parsed standard metadata;
- source kind and locator;
- requested/resolved revision for Git sources;
- SHA-256 digest;
- validation profile and diagnostics;
- trust state;
- installation timestamp and AIWG version.

Do not execute scripts during import, validation, listing, or deployment.
Activation/execution remains the provider's responsibility and must respect the
trust decision.

### Metadata bridge

Use an internal typed model with two explicit projections:

- `standard`: the six standard fields and body/resources;
- `aiwg`: namespace, platforms, triggers, model/tool/orchestration policy,
  package ownership, and deployment bookkeeping.

On external import, preserve unknown fields for diagnostics but reject them in
strict mode. In lenient mode, accept only after warning and store them as
untrusted source metadata; do not automatically reinterpret arbitrary keys as
AIWG control policy.

On AIWG export/deploy to a strict destination:

- map portable `name`, `description`, `license`, and `compatibility` directly;
- emit portable string metadata only when it is genuinely consumer-facing;
- translate an AIWG allowed-tools policy to `allowed-tools` only when semantic
  equivalence is known;
- omit AIWG control fields from `SKILL.md`;
- retain omitted fields in an AIWG sidecar so a round trip through AIWG is not
  lossy.

### Validation profiles

Provide:

- `strict`: normative standard errors plus advisory resource/size warnings;
- `compatible`: strict portable fields plus explicitly recognized AIWG
  extensions;
- `discovery`: client-guidance mode that warns on cosmetic name issues but
  rejects unreadable YAML or missing descriptions.

Diagnostics should include stable codes, severity, file, YAML path, message,
standard source/version, and remediation. JSON output must remain deterministic
for CI.

## Delivery Phases

### Phase 0 — Contract and migration

Define the profiles, typed intermediate representation, metadata projection,
provenance/trust model, collision precedence, and provider degradation vocabulary.
Normalize the 11 independently defective canonical sources and regenerate
mirrors.

### Phase 1 — Import and validation

Implement directory import first, then pinned Git URL/revision import. Validate
before staging, compute digests, use atomic writes, and expose dry-run/JSON
results. Integrate shared validation into `validate-metadata`, `skill-lint`, and
`doctor`.

### Phase 2 — Provider deployment and verification

Route imported skills through provider definitions and standard-aware
projections. Add fixture-driven tests for every provider, complete resource-tree
preservation, collision behavior, trust gates, idempotence, failure rollback,
and AIWG sidecar round trips.

### Phase 3 — Documentation and optional ecosystem work

Document import sources, field mapping, security, provider differences, and
troubleshooting. Only after the local/Git contract stabilizes should AIWG
consider an adapter for a concrete third-party registry or publishing/export
workflow.

## Acceptance Traceability for #1569

| Parent criterion | Planned coverage |
|---|---|
| Import and deploy a conforming folder to every provider | Phases 1–2; directory fixture plus 12-target matrix |
| Validator in `validate-metadata` and `doctor` | Phase 1 shared validator integration |
| AIWG/standard metadata mapping | Phase 0 typed bridge and projections |
| User-facing documentation | Phase 3 |
| Round-trip sanity | Phase 2 byte/resource and standard-field tests; AIWG data retained in sidecar |

## Research Sources

- Agent Skills specification: <https://agentskills.io/specification>
- Agent Skills client implementation guidance:
  <https://agentskills.io/client-implementation>
- Agent Skills authoring best practices:
  <https://agentskills.io/skill-creation/best-practices>
- Upstream repository: <https://github.com/agentskills/agentskills>
- Pinned reference validator:
  <https://github.com/agentskills/agentskills/tree/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/skills-ref>
