# Changelog

All notable changes to AIWG project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project uses [Calendar Versioning (CalVer)](https://calver.org/) with npm-compatible format (`YYYY.M.PATCH`).

## [Unreleased]

## [2026.9.7] - 2026-09-12 – "Only what the run owns"

### Changed

- Rank AIWG's deployed rules above provider, harness, and session directives in the generated
  WORKSPACE.md precedence block. Platform capability and safety constraints remain absolute; a
  session-level directive no longer outranks a rule marked CRITICAL. Regenerate to pick this up.

### Added

- Detect a bootstrap whose precedence block no longer puts AIWG rules first, and route the
  finding to `aiwg regenerate` through the steward.

### Changed

- Lead the README with natural-language requests rather than CLI invocations, keep its tooling
  interactions prompt-driven, and fix Mermaid diagram rendering.

### Fixed

- Stop `aiwg use all` from deleting another bundle's surface. The kernel-only path called the
  flat-artifact prune with an empty desired set, so every AIWG-managed agent, command, and rule
  matched as stale: `aiwg use sdlc` followed by `aiwg use all` took `.claude/agents` from 139 to
  0 and `.claude/rules` from 47 to 2, and reported success.
- Report the artifacts a deploy accounts for rather than a directory listing. Counts came from a
  readdir, so a run that wrote nothing still printed whatever sat in the provider tree and a
  no-op deploy was indistinguishable from a successful one.
- Retire skill-command wrappers whose source skill is gone, instead of leaving them advertising
  a command that resolves to nothing.
- Stop a provider-scoped refresh from pruning provider trees it was not asked to touch.
  `aiwg refresh --provider claude` had been leaving `.codex/` with zero agents while its
  commands, rules, and AGENTS.md bridge stayed intact and advertised.
- Leave git-tracked artifacts to an explicit opt-in during the cross-provider prune. Deleting a
  regenerable ignored artifact and deleting a committed file are different questions; the prune
  had answered both the same way and produced 161 staged deletions in a working tree holding
  unrelated in-flight work.
- Keep `--force` scoped to overwriting artifacts AIWG does not manage, rather than also
  authorising deletion of tracked files in a tree the run was not asked to touch.
- Treat an edge launcher redirect as aligned rather than reporting it as installation drift.
- Report divergent artifact payload as repairable instead of manual-only.
- Resolve the artifact root when writing hook traces instead of hardcoding `.aiwg`, so
  split-root workspaces record traces in the configured corpus.
- Declare AIWG ownership on the generated project quickref.
- Keep bundle agents and deploy-directory support assets in project-local deployments.
- Resolve `WatchService.start()` only once chokidar reports the watch armed, not merely that its
  initial scan finished. A file created in that window was reported by neither, so the `add`
  event was absent rather than late and no caller-side wait could recover it.
- Skip sqlite-backed test suites with a named remedy when the optional `better-sqlite3` backend
  is absent, instead of failing 61 tests across 25 files with symptoms that never name the
  cause. A default `npm install && npm test` is green; `npm run features:sqlite` enables the
  suites, and CI installs the same pinned build.

- Cover restoration-observer edge cases and import-lease ownership preservation, with per-file source coverage in CI.
- Replace untrusted fleet transport and response-decoding errors with safe diagnostics in structured and text reports.
- Include workspace discovery and retrieval in context-pack elapsed time, with deterministic timing-boundary tests.
- Strengthen memory confirmation, CLI routing, independent budgets, metrics, and cache regression assertions.
- Preserve provider JSON and TOML settings during MCP registration, escaping values and rejecting malformed input.
- Handle split UTF-8 output, child timeouts, and stdin failures in MCP CLI requests; use structured command discovery.
- Reject incomplete, fractional, unsafe, and non-finite mission limits before dispatch through CLI and MCP surfaces.
- Strengthen memory, recovery, session, provider, and documentation test assertions and fixture cleanup.

- Preserve required runtime and idempotency extension activation when forwarding mission approval replies (#2310).

- Route public mission approvals over the task's negotiated A2A transport, retaining prompt correlation,
  validating pending responses and rejecting duplicate submissions (#2310).

## [2026.9.6] - 2026-09-08 – "Verifiable test conformance"

### Added

- Expand testing-quality with source-bound conformance assessment, runner discovery and execution receipts,
  negative controls, reversible normalization, platform templates, research guidance, and SDLC agents and flows.
  Qualify real Vitest and pytest lifecycles and retain explicit limits for other platform profiles.

### Fixed

- Exercise AIWG's own test conformance workflow: restore omitted Vitest tests, split mixed contract runners,
  fail closed on validator setup errors, strengthen schema/fixture oracles, and prove multi-target control attribution.
- Reconcile real Vitest nested-suite counters independently from result-file counts.
- Execute artifact query integration on a deterministic corpus, replacing absent-corpus early returns with exact
  ranking, filtering, limit, and populated-index assertions.
- Share genuine package preparation in a required serial lane, correct coverage threshold placement, and enforce
  a measured Testing Quality library denominator with a deliberate failure control.

## [2026.9.5] - 2026-09-07 - "DeepSeek Harness, shared bundles, and controlled writing"

### Fixed

- Index validated external project-local bundles in nested members so deployment, discovery, show, and managed quickrefs agree without copying source bundles. Exclude unrelated external files and escaping payload links (#2308).
- Route artifact writes through the configured external corpus and independently verify Fortemi execution receipts.
- Drain DeepSeek Harness output before reporting successful completion.

### Added

- Session exploration workflows, recipe references, and discoverable catalog help.

### Changed

- Clarify first-use onboarding, workflow examples, provider setup, and public documentation navigation while retaining
  the full capability reference.
- Report indexed artifact access for Hermes, OpenHuman, and Antigravity when native artifact deployment is unavailable.

### Documentation

- Add the native subagent harness voice-evaluation lane and record thirty Astra/Sol cases, primary reviews, replay outcomes and comparison limits.

- Record the Gemma native-schema follow-up: format recovery, remaining edit-budget and fidelity failures, and unchanged rejection of unqualified voice revisions.

- Record forty current Qwen/Gemma expression revalidation calls, primary-reviewed passes, strict-format failures and resource/settings limits.

- Retire GPT-OSS20b from current-model qualification and retain its existing reports as historical evidence pending eligible-model revalidation.

- Record the TinyStyler negative mechanism trial and the bounded-expression/paragraph-addressing comparison, including failed proposals and unresolved cadence.

- Record the negative paired core-guidance handoff result, including factual regressions, unchanged voice acceptance and additional token cost.

### Fixed
- Protect explicit channel CTAs and required literals before generation, merging overlaps with existing code/Markdown protection while retaining final constraint checks.


### Documentation
- Publish paired Qwen/GPT-OSS channel development results, including failed slices, reused baseline provenance and the remaining qualification limits.


### Fixed
- Route negation, qualification and first-person lexical changes to explicit semantic review instead of treating wording differences as conclusive fidelity failures. Quantity, command, citation and protected-content invariants still fail closed; final reviewers can inspect a cloned assessment.


### Fixed

- Pass channel/task context into writer-profile compilation so scoped author
  preferences apply to the intended output without leaking across calls (#2301).

### Added

- Published four-policy, two-count exemplar development results and exact-token
  envelope audit with text-free receipts; no retrieval default promoted (#2295).

- Five opt-in channel structure packs with bounded local consumer adapters,
  one-post chat constraints and explicit unsupported-consumer coverage (#2301).
- Canonical writing receipts, opt-in legacy migration/rollback and a local
  `writing plan|proofread` CLI path (#2303). No publication is performed.

- Bounded voice revision, individual human edit decisions, explicit profile-learning
  proposals and undo (#2299). Reported usage and reserved budgets remain distinct.
- Writer sidecars in the existing mode resolver, truthful participating-consumer
  state and scoped shared MCP profile resources (#2300). Selection alone does
  not intercept provider responses.
- Voice evaluation design, blinding, clustered analysis and leakage checks
  (#2302). Real pilot data, human ratings and model comparisons remain required.

- Deterministic, profile-scoped exemplar selection with four budgeted strategies,
  split leakage checks and reproducible receipts (#2295). Fixture ablations
  measure selector behavior; model-quality comparison remains unqualified.
- Structured fact/intent/audience briefs and authorized proofreading with
  grounded author claims and pinned provider-launch annotations (#2296).
- Conservative fidelity review and final mandatory output-mode validation,
  including accurate attempted/retained fallback receipts (#2298).

- Opt-in writer profile sidecars with approved sample evidence, author overrides,
  lossless legacy attachments, scoped revisioned storage, controlled exports,
  revocation, and advisory output-mode compilation (#2294). Legacy voice files
  retain their existing loading behavior.

- Contextual writing diagnostics with UTF-16 spans, protected contexts,
  reasoned exceptions, explicit rule overrides and repetition review across
  words, paragraphs and documents (#2297). Legacy validator fields remain
  compatible but are labeled deprecated heuristics. The 32 labeled regression
  cases are fixture measurements, not human voice qualification.

- Natural voice evidence ledger and ownership ADR with pinned research artifacts,
  bounded claim mappings, deferred additional-source assessments, and validation
  rejecting anecdotal release thresholds (#2293). This establishes the evidence
  contract; it does not qualify generated voice quality.

- Experimental DeepSeek Harness provider (`deepseek-harness`, alias `dsh`) with
  AGENTS-first context, native filesystem skills, least-authority Cordis
  defaults, exact-version-gated headless and SDK JSON-RPC execution, raw v2
  session import, credential-reference-only OpenRouter conformance, and public
  provider/site documentation (#2160, #2162–#2167, #2290).
- Opt-in `network-analysis` addon for governed saved-PCAP/PCAPNG analysis with
  bounded TShark recipes, metadata-first evidence, stable citations, optional
  local Termshark review, framework handoffs, and deterministic conformance
  evidence (#2269–#2281).

### Fixed

- Fortemi dataset qualification discovers the consolidated execution tool,
  independently validates receipts and approved request digests, and exercises
  bounded replay, resume, journal recovery, and archive (#2242; Fortemi #1131).

## [2026.9.4] - 2026-09-05 - "Clear recovery for lightweight CLI setup"

### Fixed

- Bundled setup through `@aiwg/cli` stops before project initialization and
  explains how to install the full `aiwg` package, instead of starting an
  incomplete deployment and crashing on a missing addons directory (#2287).

## [2026.9.3] - 2026-09-05 - "Broader provider support, reliable project discovery"

### Added

- Experimental Google Antigravity CLI provider (`antigravity`, alias and
  executable `agy`) with project-scoped agents and skills, collision-safe MCP
  injection, explicit model/session routing, and a bounded offline-qualified
  headless adapter pinned to CLI 1.1.26 (#2258–#2267).
- Contributor Covenant 2.0 community standards, enforcement responsibilities,
  reporting channel, and impact guidelines ([jmagly/aiwg#186](https://github.com/jmagly/aiwg/pull/186)).
- Experimental Oh My Pi (`omp`, alias `oh-my-pi`) integration with distinct native
  resource paths, profile-aware configuration, agents, owned MCP injection,
  extension bridge, model discovery, JSON/RPC execution, bounded teams, and
  title-prefixed session imports. See the [provider guide](docs/providers/omp.md)
  for the pinned version, support limits, and removal workflow (#2244–#2256).
- Opt-in Fortemi live storage qualification now produces sanitized, durable
  receipts binding the tested revision, endpoint identity, server contract,
  complete operation inventory, mutation status, and resource bounds. Dataset
  workflows also gain a schema-first live contract preflight and durable UAT
  plan; these checks do not certify Server persistence or recovery.

### Changed

- Promoted the Hermes provider integration from experimental to stable and
  identified the `pi` provider explicitly as the Pi Coding Agent harness
  published at [pi.dev](https://pi.dev/) across current provider documentation.
- Synchronized OMP across the public homepage, provider and capability
  matrices, setup navigation, operator references, and getting-started guides.
  Together with Antigravity, the public platform list now matches 14 named
  provider integrations and no longer counts Ollama, an LLM backend, as an
  AIWG deployment provider.

### Fixed

- Existing project-local skills remain discoverable when their Fortemi Core
  project cache is missing, stale, or corrupt. Discovery falls back to the existing
  local project index, and framework deployment, refresh, and upgrade synchronize
  the project index after local bundle reconciliation (#2155).
- Portable workflows, including `aiwg-guide`, documentation consolidation,
  and semantic-memory skills, declare `platforms: [all]` across canonical and
  plugin copies. Newly supported providers can deploy them without stale
  provider allowlists silently excluding them (#2282).
- Fortemi MCP reads accept nested original/revised content, and search results
  with opaque note IDs retrieve missing path metadata before applying subsystem
  filtering. Search hydration is bounded to 50 results.
- Concurrent SQLite graph initialization now retries journal-mode and schema
  contention within the configured busy timeout and closes failed connections.
  Deterministic lock regressions and renewed source-bound benchmark evidence
  cover the change.

### Release boundaries

- OMP remains experimental at its reviewed 18.1.10 baseline. Antigravity remains
  experimental with offline conformance pinned to 1.1.26; authenticated model
  execution has not been qualified.
- Fortemi Server remains alpha and pre-certification. Live probes require an
  explicitly configured endpoint, default to read-only, and gate writes
  separately. Fortemi Core capability discovery is a separate static-cache
  path and does not require a live Server endpoint.

## [2026.9.2] - 2026-09-04 - "Pi from resources to runtime"

### Changed

- **Pi is now integrated across deployment, model selection, headless execution,
  and session intelligence** - AIWG deploys a reviewed trust-gated extension
  bridge, discovers Pi's configured backend/model catalog, launches External
  Ralph sessions with model, thinking, tools, and session controls, and uses
  bounded RPC-first cancellation (#2147, #2150, #2151).

- **Pi v3 sessions are a first-class governed source** - Authorized discovery,
  stable native IDs and tree topology, core-entry normalization, opaque future
  entries, resource limits, and sensitive tool/custom-data redaction are
  covered by provider conformance and repository importer gates (#2152).

### Security

- **Headless Pi runs fail closed at trust and tool-policy boundaries** - The
  managed extension never prompts without a TUI and blocks destructive or
  package-mutating shell calls; machine protocols keep JSONL on stdout and
  diagnostics on stderr. MCP remains explicitly unsupported in Pi core.

### Tests

- Qualified Pi Coding Agent 0.85.0 against OpenRouter using isolated agent and
  session roots. Model discovery, RPC state/abort, strict JSONL, live inference,
  and terminal `agent_settled` all passed without persisting credentials or raw
  output.

### Release boundaries

- Pi remains experimental pending its promotion gate. AIWG does not install Pi
  packages, credentials, or MCP extensions, and operator-owned settings,
  prompts, skills, extensions, sessions, and trust decisions remain preserved.


- Corrected the Pi Coding Agent package name to
  `@earendil-works/pi-coding-agent` and synchronized the provider guide,
  quickstart, CLI reference, trust policy, OpenRouter example, session/RPC
  boundaries, and upstream verification baseline with Pi 0.85.0.

### Tests

- Added pinned Pi provider and version-3 session conformance fixtures covering
  resource discovery, explicit headless trust, branches, compaction, retry
  evidence, opaque future entries, malformed JSONL, and credential redaction.
- Added an opt-in Pi/OpenRouter smoke harness that uses an ephemeral pinned
  package or reviewed source build, isolated agent/session roots, explicit
  trust, strict JSONL/RPC checks, and value-free evidence.

## [2026.9.1] - 2026-09-04 - "Governed data, broader provider reach"

### Added

- **Schema governance now has a first-class control plane** - A catalog,
  lifecycle policy, compatibility analysis, validation commands, and storage
  parity checks make schema evolution explicit and testable across packaged
  resources (roctinam/aiwg#2223, roctinam/aiwg#2227).

- **Dataset intelligence adds governed, reproducible data workflows** - The new
  addon provides source-adapter contracts, standards profiles, canonical run
  ledgers, provenance, orchestration commands, migration guidance, and
  cross-runtime conformance coverage.

- **Pi Coding Agent is available as an experimental resource-first provider** -
  `aiwg use all --provider pi` deploys a Pi-neutral `AGENTS.md`, portable Agent
  Skills, and native `.pi/prompts` templates at project or relocated user scope.
  Provider detection, capability routing, receipts, planning records, and
  end-to-end coverage are included. The public provider inventory now enforces
  12 named integrations plus a separately identified generic fallback
  (roctinam/aiwg#2148, roctinam/aiwg#2149).

- **Output modes now have a supported extension and discovery surface** - The
  output-mode registry and protected transformation runtime are exported from
  the package API, with guides for selection, custom profiles, integration, and
  troubleshooting.

- **Fortemi storage qualification now runs against the live server path** - A
  dedicated conformance gate exercises published Core receipts against clean
  PGlite and Fortemi environments (roctinam/aiwg#2194).

### Fixed

- **Release CI installs Rust from an immutable archive** - The conformance
  workflow no longer depends on a mutable installer endpoint.

- **Dataset documentation, packaging, and orchestration stay aligned** -
  Governed schemas ship with the CLI, report directories are created before
  use, source links resolve correctly, and addon commands bind to the shared
  orchestration service.

- **Provider documentation cannot silently drift from the registry** - A unit
  test compares the published provider inventory with canonical definitions and
  asserts the exact named-provider count.

### Release boundaries

- Pi support in this release covers provider identity, detection, capability
  reporting, and native resource deployment. Runtime extensions, model-catalog
  integration, and persisted-session ingestion remain future work.
- Dataset standards profiles and adapters establish governed contracts; they do
  not certify external datasets or replace operator review of source rights,
  quality, or fitness for purpose.

## [2026.9.0] - 2026-09-01 - "Cited civic workflows, safer publication"

### Added

- **Civic research and publication now have an opt-in, cited review kit** -
  Four bounded agents, eight skills, three rules, three FlowPlaybooks, fifteen
  resolvable Flow capabilities, ten schemas, ten templates, examples, and
  deployment metadata support public-source review, public-records planning,
  meeting and vote reconciliation, public-technology research, local-resource
  profiles, editorial correction, and publication QA
  (roctinam/aiwg#2213-#2222).

- **Civic contracts expose source, jurisdiction, and review fields** - Source
  registry contracts record provenance, license and terms, acquisition method,
  jurisdiction, and declared uses. CAP, GTFS, and HSDS remain vendor-neutral
  AIWG profile contracts. A control-to-source matrix links every skill to the
  primary standards and public-sector guidance that informed its design and
  records which boundaries are executable or declarative.

### Security

- **Selected declared civic conditions produce machine-readable blocks** -
  Local gates block declared access-control bypass and unresolved source
  authorization/rights; conflicted or unverified vote evidence; declared
  material claims without citations; unnamed privacy/accessibility review;
  unresolved declared corrections/deployment states; and publication packets
  lacking named exact-hash approval. Broader jurisdiction, consent,
  anti-targeting, retention, and independent-review requirements remain
  explicit human workflow rules.

### Fixed

- **Required CI workflows no longer cancel one another** - Workflow-specific
  concurrency groups isolate CI, documentation, and metadata-validation runs so
  the release gate can observe each required check independently.

- **Release publication and recovery paths are retry-safe** - Gitea npm jobs
  scope Vault route variables correctly, recovery dispatch is supported,
  duplicate release assets are replaced on retry, and GitHub signing identity
  is bound to the release tag.

- **Prebuilt release indices are reproducible** - Generated index timestamps no
  longer introduce non-deterministic package output.

- **Civic executable gates reject malformed contracts before evaluating
  policy** - Source, meeting, and publication commands validate their complete
  JSON Schemas and return the documented invalid-input exit code with bounded
  JSON-pointer diagnostics instead of allowing a partial object to pass.

- **Civic newsroom discovery resolves its shipped FlowPlaybook** - The planning
  skill and design map now reference the deployed `civic-newsroom.yaml` path.

- **Executable addon skills retain their support payloads after deployment** -
  Bundled addon installs now copy declared scripts and existing referenced
  assets into native provider skill directories. Civic gate wrappers resolve
  the installed AIWG source root when executed from a deployed Codex skill.

### Release boundaries

- Civic Action prepares structured artifacts and local findings; named humans
  retain authority for acquisition, recording, contact, submission, legal
  interpretation, identity resolution, procurement decisions, correction
  approval, and publication.
- A machine pass means only that no blocking condition was found among the
  declared, schema-valid fields. It is not legal advice, factual verification,
  standards certification, a compliance determination, or authorization to
  act. Review and hash fields are asserted metadata unless a command explicitly
  verifies them.
- Records, procurement, local-resource, and correction assets are profile and
  review contracts. Jurisdiction-specific rules and external adapters do not
  ship in this release; missing integrations perform no external action.

## [2026.8.28] - 2026-08-31 - "Governed evidence, resilient tooling"

### Added

- **Ops outputs now cross a mandatory redaction boundary** - A public text,
  stream, and nested-structured API sanitizes common and project-defined secret
  classes before responses or persistent/external sinks. Typed markers preserve
  optional length/HMAC correlation metadata, failures deny publication without a
  payload, and exceptional bypasses require a sink-enabled, scoped audit record
  (jmagly/aiwg#178).

- **Ops artifacts are classified and destination-gated** - Versioned governance
  schemas, secure kind/category defaults, inheritance, custom ordered classes,
  sink visibility ceilings, cross-repo approval checks, payload-free decisions,
  and separately gated sanitized summaries now cover repository, tracker,
  comment, export, and bundle boundaries (jmagly/aiwg#179).

- **Ops evidence has enforceable minimization and lifecycle controls** - Durable
  evidence defaults to bounded excerpts, outcomes, counts, and digests; raw
  capture requires a reason and short TTL. Category/classification/sink/tier
  policies drive summarize, redact, archive, retain, and delete actions with
  reversible holds and payload-free disposition receipts (jmagly/aiwg#180).

### Fixed

- **Output-mode selection now fails safe before persistence and execution** -
  Proposed project and session stacks are validated before state is saved,
  personal profiles follow the active AIWG user-config resolver, nested runs
  clear stale mode variables, child flags after `--` remain untouched, strict
  profile/state validation rejects malformed policy, and protected literals
  cannot be removed, duplicated, or confused with input text.

- **Ops extension YAML templates now honor their declared schemas** - IT asset,
  service, and network-state templates use strict first-class IT kinds, the
  provisioning playbook uses structured references, and all shipped ops
  extension templates resolve through manifest-declared schemas. A reusable
  all-extension conformance validator with negative reference/shape tests now
  runs in CI and reports file-plus-JSON-pointer diagnostics (jmagly/aiwg#181).

- **Development-channel build drift now fails with an actionable recovery
  path** - When a configured checkout has a compiled router but is missing the
  compiled installation manager, the launcher reports the exact `build:cli`
  command and keeps `aiwg --use-stable` reachable instead of surfacing a raw
  Node module import error (roctinam/aiwg#2212).

- **Scoped SQLite session installs now complete through the production feature
  path** - Session storage can install its optional SQLite backend through the
  same feature workflow used by deployed commands, with CI coverage for the
  package and runtime boundary (jmagly/aiwg#182).

- **A2A dual-version negotiation preserves compatible routes** - Client and
  dispatch adapters retain the legacy interface base where required while
  qualifying negotiated version-specific endpoints with codec and routing
  regression coverage.

- **Executable skills retain their release-index metadata** - Fortemi Core
  package indices preserve script entrypoints and execution flags so a skill
  discovered from the release corpus remains runnable rather than degrading to
  documentation-only metadata.

### Release boundaries

- Ops evidence governance applies at the new boundary APIs and CLI preparation
  path; existing custom integrations must call that boundary before publishing
  operational payloads.
- The SQLite feature remains optional and is installed only when selected by a
  session workflow. This release does not add SQLite to the base package.

## [2026.8.27] - 2026-08-28 - "Qualified storage scale-out"

### Added

- **Shared-server storage has executable qualification evidence** - Dedicated
  PostgreSQL and PostgREST CI jobs obtain short-lived credentials from Vault,
  run live conformance suites, and publish versioned reference evidence for
  direct and REST-backed deployments. Performance claims now fail closed when
  their evidence is stale, incomplete, or outside the declared qualification
  scope.

- **Storage migrations require semantic proof before cutover** - The migration
  coordinator now verifies logical identity, snapshot and replay integrity,
  tombstones, revision and digest continuity, parity, approval-bound cutover,
  and rollback safety across local and shared-server backends.

### Changed

- **Artifact indexes share deterministic ordering and pagination semantics** -
  Graphology, JSON, and SQLite backends now expose the same stable traversal
  order and cursor behavior, backed by the common storage conformance corpus.

### Fixed

- **Address-issues cycles restore the complete templated tracker response** -
  Native goal and resume flows now render and validate the canonical `AL CYCLE`
  comment, including required status, evidence, verification, and continuation
  details, before posting it to an issue (roctinam/aiwg#2206).

### Release boundaries

- Shared-server reference evidence covers the declared PostgreSQL and PostgREST
  qualification environments. It is not a blanket performance guarantee for
  undeclared database versions, extensions, network topologies, or workloads.
- Migration cutover remains approval-bound. Qualification evidence does not
  authorize an unattended production cutover or replace a deployment-specific
  rollback plan.

## [2026.8.26] - 2026-08-26 - "Verified dependency evidence"

### Security

- **Root, Droid Bridge, and evaluation dependency graphs resolve patched
  releases** - Lockfiles now carry patched `nanoid`, `esbuild`, MCP/HTTP,
  `js-yaml`, and related transitive packages, with protocol and YAML regression
  tests guarding the upgraded boundaries (roctinam/aiwg#2199, #2200, #2201).

- **Desktop XML dependencies clear the reported RustSec denial-of-service
  findings** - The Tauri lock graph now resolves `quick-xml 0.41.0`, and the
  desktop documentation records the application boundary and minimum safe
  version (roctinam/aiwg#2202).

- **Dependency alerts carry reproducible provenance** - Exported findings now
  include commit, workspace, manifest, lockfile digest, dependency path,
  ecosystem, direct/transitive classification, and artifact-integrity evidence.
  Validation rejects duplicate identifiers, incomplete advisories, and invalid
  patched-major claims (roctinam/aiwg#2204).

- **Obfuscated-code findings require behavioral evidence** - Actionable alerts
  must identify a file, symbol, rule, artifact hash, confidence, and excerpt or
  trace. Code shape alone remains informational, and suppressions are bound to
  an exact artifact hash plus rationale (roctinam/aiwg#2205).

### Fixed

- **Claude append-import fixture is independent of the calendar** - The
  repository conformance test uses a deliberately long inactivity threshold so
  its fixed historical timestamp cannot age into an inactive session and break
  CI as wall time advances.

- **Fortemi's package budget covers the reviewed release corpus** - The bounded
  prebuilt-index gate now accommodates the 3,705-item framework corpus while
  retaining an explicit size ceiling and packed-install smoke coverage.

### Release boundaries

- `RUSTSEC-2024-0429` remains in the optional Tauri GTK3 source graph through
  `glib 0.18.5`. Issue #2203 is explicitly deferred pending a compatible GTK4
  stack. This release does not qualify or publish Linux `.deb`, `.rpm`, or
  `.AppImage` desktop bundles; the Cockpit Bridge, browser UI, VS Code shell,
  and npm source package remain supported release surfaces.

## [2026.8.25] - 2026-08-25 - "Safe help, reliable Windows refresh"

### Fixed

- **Per-command help no longer enters command execution paths** - The CLI
  router intercepts `--help` and `-h` before hooks or handlers can mutate
  installation or project state. Refresh, Doctor, artifact verification, and
  plugin packaging keep detailed help, while commands without dedicated help
  return a safe generic fallback (jmagly/aiwg#174).

- **Windows package-manager wrappers preserve their native quoting** - Global
  updates routed through `cmd.exe` now pass `.cmd` and `.bat` payloads with
  verbatim Windows arguments, including manager paths containing spaces. This
  prevents Node from re-escaping an already quoted wrapper command
  (jmagly/aiwg#173).

- **Refresh makes package-update failures visible after recovery work** - When
  an installation update fails but framework re-deployment continues, the
  final interactive summary warns that the previous AIWG version may remain,
  and quiet mode reports `refreshed-with-update-failure` instead of a false
  success (jmagly/aiwg#173).

- **Release publication allows cold runners to finish** - Stable and
  prerelease npm publication jobs now have enough timeout headroom for
  dependency installation, the full release gate set, signing audits, and all
  three package publishes.

## [2026.8.20] - 2026-08-24 - "Portable missions, verified storage migrations"

### Added

- **Universal Harness Protocol client transport** - The experimental UHP client
  now provides validated discovery, model and harness inventory, request and
  streaming execution, cancellation, continuation, file exchange, structured
  errors, and Cockpit projection over the versioned `2026-08-11` contract.

- **One versioned Mission contract across execution surfaces** - Mission
  inventory, codecs, schema baselines, migration tooling, consumer matrices,
  and reversible backend routing now make protocol drift explicit across CLI,
  Cockpit, Flow, and persistence consumers.

- **Scalable storage backend and migration contracts** - A fail-closed
  capability matrix and `aiwg.storage-migration/v1` coordinator define logical
  identities, snapshots, atomic receipts, revision/digest resume, tombstones,
  bounded replay, parity verification, approval-bound cutover, and rollback.

- **Common storage conformance corpus** - The versioned golden dataset proves
  local JSON, Graphology, and SQLite parity for typed topology, Unicode/null
  attributes, updates, deletion/reload, traversal, and set operations with
  `npm run test:conformance:storage`.

- **Composition graphs now support guarded human-decision cycles and outcome evidence** -
  Feedback routes can require strict-decrease integer progress in addition to a
  hard iteration ceiling; approval-required nodes pause and resume from
  checkpoints; and reports expose normalized scope, duplicate-suppression, and
  node/branch/join resource evidence (roctinam/aiwg#2184, #2186).

- **Composition benchmarks now require negative controls** - Benchmark records
  keep the workload and instrument fixed while applying a deliberately wrong
  policy, and mark the measurement invalid when that control unexpectedly
  passes (roctinam/aiwg#2183).

### Fixed

- **SQLite graph persistence is hardened for sustained local use** - The
  backend now enforces safe WAL engine versions, transactional schema upgrades,
  native set operations and recursive traversal, deterministic reconciliation,
  bounded busy handling, checkpoint metrics, online backup, and multi-process
  concurrency/crash-reopen coverage.

- **Configured graph backends are exercised through the real CLI path** -
  Subprocess integration tests verify JSON, Graphology, and SQLite selection,
  status/stats visibility, persistence, and unavailable-backend failure without
  silently falling back.

- **The first valid composition graph is discoverable from the CLI** -
  Validation diagnostics print expected constants, help locates installed
  contracts and fixtures, and `aiwg composition example` prints or copies a
  known-valid starter (roctinam/aiwg#2185).

- **Stable release discussions are now verified as publication artifacts** -
  The AIWG release-plan reference requires exactly one GitHub Announcements
  discussion for each stable mirrored release and verifies that it links the
  release, npm package, versioned release notes, and CHANGELOG.

## [2026.8.19] - 2026-08-24 - "Scoped graph links, complete index visibility"

### Changed

- **Bulk provider installs are kernel-only by default** - `aiwg use all` now
  installs the compact kernel skill set on every provider and relies on
  discovery for the broader catalog. Operators who need the former fully
  copied agent, command, skill, and rule surface can request it explicitly
  with `--copy-all` (jmagly/aiwg#152).

- **Markdown links now participate in artifact graph traversal** - Indexed
  relative Markdown links create typed `markdown-link` edges when the target
  resolves to another indexed artifact in the active graph. External URLs,
  anchor-only links, image links, and files outside the active graph remain
  reader navigation only, preserving @-mentions as the durable traceability
  and provenance syntax (jmagly/aiwg#147).

### Fixed

- **Kernel-only installs remove stale managed bulk artifacts** - Re-running
  `aiwg use all` prunes legacy AIWG-managed agents, commands, and expanded
  rules—including Codex TOML agents—while preserving unmarked operator-owned
  files (jmagly/aiwg#152).

- **Global graph statistics are visible by default** - `aiwg index stats`
  now loads default-built global graph definitions before reporting aggregate
  or single-graph statistics, so graphs declared in the user AIWG config appear
  with coverage computed from their configured scan roots (jmagly/aiwg#148).

- **Symlinked artifact directories are indexed consistently** -
  `findArtifactFiles` now follows symlinked and junctioned directories with
  realpath cycle protection, skips broken links cleanly, and rejects unknown
  graph names instead of silently falling back to the project graph
  (jmagly/aiwg#149).

- **GitHub trusted-publish checkout keeps the workspace trusted** - The
  npmjs.org publish workflow preserves Git's safe-directory trust after its
  isolated package-publish checkout so follow-on release steps can continue to
  inspect the workspace.

## [2026.8.18] - 2026-08-23 - "Negotiated agents, canonical installs"

### Added

- **Optional Flow graph execution profile** - The `graph-pattern` addon now
  layers validated graph playbooks, scaffold/explain/dry-run/replay commands,
  adapter-backed execution, deterministic conformance fixtures, and Cockpit
  projection over AIWG's existing Flow and Mission substrate. Graph nodes can
  dispatch agent, tool, Sandbox, and durable-code work without introducing a
  second orchestration language (#2127-#2134).

- **Negotiated A2A 1.0 compatibility** - A2A clients, Bridge routing, mock
  executors, and terminal observers now negotiate 1.0 interfaces while
  retaining explicit 0.3 compatibility. Versioned codecs normalize messages,
  tasks, status updates, artifacts, streaming events, and webhook payloads into
  one internal mission model with downgrade-resistant interface selection.

### Changed

- **Explicit graph degraded modes and Sandbox lineage** - Graph execution now
  records policy-bound degraded outcomes, validates Sandbox retry and resume
  lineage through a versioned event contract, and documents the controlled
  Cloudflare tunnel handoff for the Flow static-site surface.

### Fixed

- **Canonical global installation preservation** - AIWG now records one
  provider-neutral installation identity with its method, root, update
  strategy, manager executable, channel, and run mode. Update, refresh,
  background maintenance, Doctor, Steward, and runtime reporting use that
  identity, fail safely on path drift, and require explicit
  `aiwg installation adopt|switch` recovery instead of silently switching
  between nvm, Homebrew, source, npm, or signed-web installations (#2157).

## [2026.8.17] - 2026-08-22 - "Runnable graphs, useful release conversations"

### Added

- **Guided GitHub release discussions** - Stable releases now open one
  idempotent GitHub Announcements discussion after publication verification.
  The post links the GitHub release, npm versions, release notes, and CHANGELOG,
  then explains practical user impact in a conversational professional voice
  instead of duplicating the full notes. The active AIWG release plan can refine
  that voice from the operator's reviewed SOUL and style profile, and discussion
  creation is a hard completion gate.

- **Graph development pattern gap audit** - A repository-grounded assessment
  maps AIWG's existing Flow, Mission, RLM, A2A, Sandbox, and Cockpit primitives
  against current graph-system practice. It recommends a graph profile over the
  existing Flow metalanguage, with state, conditional routing, guarded cycles,
  reducers, run identity, adapters, conformance tests, and a read-only operator
  view rather than a second orchestration DSL.

- **Flow domain static-site deployment plan** - A versioned, validated #2125
  bootstrap approves private `roctinam/flow.aiwg.io` on the shared
  `serve-static` origin, routes graph content under `/graph/`, rejects
  fourth-level DNS, supplies exact Caddy/volume and pinned Gitea workflow
  payloads, reserves collision-checked isolated-container ports for future
  exceptions, and records the controlled DNS/tunnel/operator handoff without
  creating repositories or changing live infrastructure (#2125).

- **Claim-gated composition policy evaluation** - `aiwg composition benchmark`
  now expands a versioned fixed-task manifest into raw records and a
  reproducible summary for single-pass, Self-Refine, parallel candidates,
  strict LCM, adaptive convergence, and budget-partial policies. The harness
  reuses topology-lab aggregation, reports success-conditioned resources and
  self-judge bias, injects six failure modes, records nine local-corpus research
  decisions, and blocks quality/efficiency claims for synthetic evidence
  (#2118).

- **Safe polyrhythmic composition pattern** - The composition-engine addon now
  ships strict 4/5 LCM and adaptive convergence profiles over one typed
  problem-mode/user-mode contract, with evidence-bound user-state handling,
  conflict and failed-beat semantics, final-only synthesis, agent-only and
  read-only-tool examples, and fail-closed high-risk/unsupported-claim policy
  (#2117).

- **Deterministic FlowGraph execution runtime** - `aiwg composition run`
  executes validated phased and multi-track graphs through an explicit adapter,
  with stable activation/invocation identities, typed reducers, bounded joins,
  optional/fallback/partial failure handling, mutation-safe retries,
  capability narrowing, replay checkpoints, provider conformance, and redacted
  requested-versus-realized resource traces. MissionConductor retains durable
  ledger and provenance ownership (#2116).

- **Provider-neutral Flow graph composition contract** - The new
  `composition-engine` addon defines strict `flow.aiwg.io/v1alpha1`
  `FlowGraph` schema and generated TypeScript types, semantic diagnostics,
  normalized adapter input, five conformance fixtures, and
  `aiwg composition validate`. The profile extends the existing Flow
  metalanguage without requiring fourth-level DNS or provider fields (#2115).

### Changed

- **Recoverable Cockpit browser bootstrap** - Installation guidance now shows
  how to mint a fresh 60-second one-time browser URL for an already-running
  Bridge, including managed-install, source-checkout, and SSH local-forward
  usage while keeping the reusable bearer off the URL.

### Fixed

- **Python-aware built-in codebase indexing** - `aiwg index build` now detects
  conventional Python manifests, package roots, `tests/`, and `scripts/` while
  preserving JavaScript/TypeScript defaults. Projects can safely replace only
  the built-in codebase graph's scan roots or extensions through the validated
  `index.graphOverrides.codebase` contract (#2123).

## [2026.8.16] - 2026-08-21 - "Verified publication completion"

### Fixed

- **Attested site dispatch integrity** - The post-publication callback now
  carries the signed setup artifact digest at the top level expected by the
  aiwg.io deployment contract. Stable publication can therefore bind the exact
  `setup.aiwg.yaml` bytes, adjacent attestation, and release manifest through
  the final site deployment without weakening the existing fail-closed gates
  (#2089).

- **Accurate project index coverage** - Index statistics now measure indexed
  entries and total files over the same source set, including `WORKSPACE.md`
  and its linked project context. Human and JSON output stay aligned, never
  report more indexed artifacts than current files, and expose missing index
  entries instead of producing coverage above 100% (jmagly/aiwg#146).

- **Fortemi conformance runner bootstrap** - The cross-project shard gate now
  selects the same digest-pinned Node 24 job image as core CI before installing
  its checksum-verified Rust toolchain, rather than inheriting a runner image
  that may not provide Node.

## [2026.8.15] - 2026-08-21 - "Verified setup handoffs"

### Added

- **Attested public setup and agent handoff** - The reviewed repository-owned
  `agentic.yaml` requires exact-byte local verification before delegating to
  `setup.aiwg.yaml`. Release dispatch binds both files to the signed tag and
  requests stable-channel attestation publication, while aiwg.io verifies the
  signed web manifest and adjacent DSSE provenance before reporting verified
  inspection status (#2089).

- **Split customer/internal tracker roles** - Project configuration can declare
  a customer-facing issue tracker, provider, and actor independently from the
  internal engineering tracker. Workspace resolution, setup, config display,
  and generated tracker guidance preserve Gitea delivery authority while
  routing customer follow-up to GitHub (#2124).

### Fixed

- **Context-aware security terminology** - Threat assessment no longer treats
  ordinary ML/NLP uses of `token` as credential probing. Credential-qualified
  terms and explicit requests to inspect or disclose authentication material
  remain blocking, with cross-surface corpus measurements and regression
  coverage (#2136).

- **Destination-aware tracker authority links** - Generated root and nested
  context documents now render the tracker configuration link relative to the
  document receiving it, so both `AIWG.md` and `.aiwg/AIWG.md` resolve the same
  source of truth (customer report jmagly/aiwg#145).

## [2026.8.14] - 2026-08-20 - "Controlled output surfaces"

### Added

- **Composable output modes** - A provider-neutral registry and runtime stack
  adds a true `unaltered` default, project/user custom profiles, existing voice
  adapters, deterministic cross-kind composition, protected-content policy,
  advisory ASD-STE and Wittgenstein-inspired examples, and invocation, session,
  and project selection through `aiwg output-mode` and `aiwg run` (#2121).

- **Explicit artifact destination policy** - Project configuration now keeps
  canonical AIWG artifacts as the source of truth and makes provider-native
  presentation/export surfaces explicit-only by default. Claude Code bootstrap
  guidance preserves canonical plans and reviews when Claude Design is
  explicitly requested, and dual output records traceable provenance (#2122).

## [2026.8.13] - 2026-08-20 - "Hermes profile-aware deployment"

### Changed

- **Native Hermes skill projection** - Hermes deployments now remove AIWG's
  provider-oriented `platforms` field and project portable source tags into
  `metadata.hermes.tags`, keeping deployed skills visible to Hermes while
  preserving portable source metadata.

- **Checksum-verified publication tools** - The npm publication workflow now
  installs pinned Cosign and Syft release binaries directly after verifying
  their SHA-256 digests, avoiding third-party action and remote-installer
  availability failures.

### Fixed

- **Profile-aware Hermes deployment** - Framework, kernel, and managed skills,
  provider paths, user scope, and project quickrefs now honor the active
  `HERMES_HOME` with Hermes-compatible path semantics, so multi-profile and
  wrapped Hermes sessions receive AIWG capabilities at the directory they
  actually scan (#2119, #2120).

- **Hermes context precedence** - Generated `.hermes.md` bridges explicitly
  route to `AGENTS.md` while matching Hermes's first-found context behavior;
  deployment counts and provider metadata now describe the same active
  profile (#2119, #2120).

## [2026.8.12] - 2026-08-17 - "Verifiable artifacts and research labs"

### Added

- **Cross-asset artifact trust lifecycle** - AIWG now exposes stable artifact
  verification outcomes, trust-root and trust-state handling, attestation
  emission, CLI verification, public schemas, adversarial vectors, and
  operational guidance across first-party asset classes (#2087, #2088).

- **Portable release-surface attestations** - Marketplace v2 bundles, provider
  transformation receipts, and signed web-release descriptors carry portable
  provenance contracts that can be verified across marketplace, deployment,
  and release boundaries (#2089, #2090, #2091).

- **Research experiment addons** - Five bounded experiment bundles add
  century-readiness review, long-context retrieval benchmarking, a
  natural-language evaluation harness, orchestration topology comparison, and
  premortem-v2 analysis with fixtures and recorded evidence (#2042, #2043,
  #2044, #2046, #2047).

- **Synthetic monitorability red team** - A dedicated addon probes whether
  orchestration and evaluation systems remain observable when labels are
  missing or monitor limits are stressed, with reproducible fixtures and
  evidence (#2045).

### Changed

- **Authenticated provider transformation inventory** - Deployment receipts
  bind transformed provider outputs to their source inventories, while doctor,
  status, and normal first-use output distinguish expected pre-receipt state
  from actionable trust failures.

- **Fortemi conformance portability** - The shard gate validates runner
  capabilities explicitly, provisions pinned Rust, and fetches receipt refs
  atomically so conformance remains reproducible across capable Gitea runners
  (#2111).

### Fixed

- **Effective gitignore detection** - Doctor and configuration checks now use
  Git's ignore engine, correctly handling broad patterns, negations,
  repository excludes, global excludes, and non-redundant remediation (#2106).

- **Deterministic delivery cleanup tests** - Steward discovery children are
  tracked and terminated on signals, process-group assumptions are removed,
  and deployment integration budgets account for their bounded subprocesses
  (#2107, #2108).

- **Self-hosted tracker configuration** - Project setup persists an explicit
  issue-provider hint for self-hosted Gitea, and repair normalizes the legacy
  `main-only-blocked` force-push policy to `own-branch-only` (#2112, #2113).

## [2026.8.11] - 2026-08-15 - "Reliable refresh and discovery"

### Fixed

- **Multi-bundle refresh preservation** - `aiwg refresh --all` now routes every
  selected installed bundle through the active package's verified deployment
  handler. Cleanup preserves artifacts owned by desired bundles on the provider
  being refreshed, deployment failures stop the cleanup pass, and a real
  four-bundle regression retains all 124 deployed Claude agents (#2102,
  GitHub #143).

- **Fresh and repeated discovery availability** - `aiwg use` now rebuilds the
  framework graph and synchronizes its Fortemi Core export as one post-deploy
  operation. Packaged prebuilt fallback validation checks the manifest, schema,
  backend, graph, checksums, and item count at the actual packaged path, so
  fresh and repeated deployments leave default discover/show usable without a
  manual sync (#2103, GitHub #142).

- **Codex dispatch-budget enforcement** - packaged Codex provider bundles now
  retain bounded dispatch metadata, keeping the kernel and quick-reference
  surface within the provider's model-visible context budget (#2099).

- **Cockpit test dependency alignment** - the nested Cockpit web package and
  both lockfiles now use the repository's Vitest 4 line, restoring deterministic
  contributor and release validation (GitHub PR #140).

- **Loaded-runner integration budgets** - doctor retains non-empty
  known-capability validation with a bounded 30-second discovery probe, while
  deployment integrations receive explicit three-minute outer budgets that can
  no longer expire before their already-bounded subprocesses (#2104).

### Changed

- **Release preview isolation** - the default deployment-preview regression now
  owns its temporary workspace and environment, preventing unrelated local
  provider state from changing release-gate results.

## [2026.8.10] - 2026-08-15 - "Deterministic release packaging"

### Fixed

- **Clean-checkout release packaging** - the global-install regression now
  materializes the gitignored Fortemi Core release index before creating its
  lifecycle-script-free tarball, then protects the pack operation with the
  shared build lock. Tag publication no longer depends on an earlier test or
  workflow step having populated generated package content (#2100).

- **Release-runner deployment verification** - provider copy-profile tests use
  a bounded three-minute subprocess budget so valid full-copy verification is
  not killed at 60 seconds when hosted release runners are under load (#2100).

- **OpenClaw target isolation** - the cross-agent compatibility mirror now
  honors the explicit deployment target instead of the provider subprocess's
  working directory, preventing isolated or test deployments from repopulating
  the AIWG checkout with the full copied skill set (#2100).

## [2026.8.9] - 2026-08-15 - "Prompt-first docs and verified setup"

### Added

- **Cross-asset authenticity research contract** - accepted a DSSE + in-toto
  Statement envelope for every first-party AIWG asset class, exact-byte digest
  and canonical-payload rules, publisher delegation/rotation/revocation and
  freshness policy, stable verifier outcomes, JSON Schemas, adversarial
  conformance vectors, and a phased implementation/runbook roadmap (#2068).

- **Devin Desktop provider selector** - `devin` is now the preferred selector
  for the existing Windsurf-compatible deployment adapter. `devin-desktop`
  remains equivalent, `windsurf` remains a deprecated compatibility selector,
  and the distinct `devin-cli` surface is still rejected explicitly.

- **Policy-boundary-aware issue composition** - issue authoring now assesses
  final drafts before tracker mutation, preserves safe drafts, gates flagged
  drafts, and splits deterministically separable rejected drafts into linked
  atomic issues. Stable segment markers and recovery envelopes prevent
  duplicates after a partial multi-issue write; `aiwg issue plan` exposes the
  same contract for local issue creation.
- **Self-verifying deployment workflow** - `aiwg use` now composes deployment,
  capability indexing, canonical context generation, and scoped verification
  into one command. Human output reports a stable readiness outcome and
  provider reload action; `--json` emits the versioned
  `aiwg.use.result.v1` envelope. `aiwg doctor --deployment` and
  `aiwg status --probe --json` reuse the same verification primitives.

### Changed

- **Release configuration reference implementation** - synchronized AIWG's
  active project release config and `aiwg-npm` sidecar with the current v1
  schemas and pre-tag CI command set. Public schema-validated examples now ship
  with the repository, so clean-clone CI cannot silently skip the dogfood
  configuration when the private project artifact corpus is detached.

- **Prompt-first public documentation** - advanced capability discovery,
  orchestration, and automation commands now live in the agent/script-oriented
  `docs/cli/` corpus. Public user pages preserve only installation and repair
  commands; generated site content replaces agent-owned command procedures with
  natural-language prompts and stable asset IDs (#1937).

- **Focused `aiwg use` completion report** - the default human-readable result
  now presents one compact summary that separates artifacts copied to each
  provider from the authoritative framework inventory indexed for discovery.
  All index artifact types are included, required core types have explicit zero
  counts, provider reload rationale moves to `--verbose`, and registry scan
  chatter is suppressed outside verbose diagnostics.

### Fixed

- **Provider skill copy-profile repair** - Codex component deployments now
  reconcile stale AIWG-managed standard skills against the global kernel
  inventory, restoring the intended 25-skill kernel/quickref surface while
  preserving operator-owned skills. Cross-provider conformance now verifies
  kernel-only, explicit full-copy, and full-copy repair behavior for every
  supported provider, and Codex documentation reflects the project-local copy
  profile (#2095, #2097).

- **Split-root workflow safety** - `aiwg artifacts path` now exposes the
  effective project artifact corpus to scripts in plain-text and stable JSON
  forms. Release and documentation-sync skills resolve configuration, evidence,
  reports, and state through that path so redirected payload cannot drift back
  into the repository-local control plane (#2099).

- **Canonical documentation synchronization** - refreshed canonical component
  sources that had fallen behind their collected public documentation, keeping
  future documentation collection deterministic (#2098).

- **Cockpit release version lockstep** - release metadata validation now checks
  the Cockpit manifest plus both lockfile version fields, preventing an
  independently published package from retaining the previous CalVer while the
  root release advances (#2096).

- **Web build dependency advisories** - advanced Vite to `6.4.3` and refreshed
  its locked Babel, Nano ID, and PostCSS toolchain dependencies, clearing the
  web workspace's npm audit findings without changing the production bundle.

- **Deployment false-success and false-failure handling** - required artifact,
  registry, index, context, and provider-wiring failures produce a non-zero
  result, advisory-only limitations remain usable, repeated installs are
  idempotent, and machine-readable failures remain valid JSON without a
  presentation prefix.

## [2026.8.8] - 2026-08-12 - "Managed project capability routing"

### Added

- **Managed project capability quickrefs** - project-local extensions, addons,
  frameworks, plugins, and providers can synthesize a compact, project-only
  kernel quickref from discovered bundle manifests. Operators can curate the
  result with `.aiwg/quickref.config.json`; legacy `.aiwg/quickref.json`
  definitions remain supported without expanding the base AIWG quickrefs.
- **Intelligent regeneration selection** - `aiwg regenerate` now inspects
  canonical workspace markers and stable project or legacy context, explains
  its evidence, and selects workspace refresh or transactional adoption when no
  branch flag is supplied.

### Changed

- **Relocated artifact control plane** - artifact moves preserve local project
  control files while discovery and synchronization follow the attached corpus.
- **CLI performance enforcement** - CI applies a stable cold-start performance
  gate with documented local reproduction and diagnostics.
- **Documentation release cadence** - scheduled documentation publication now
  checks for releasable changes every six hours.

### Fixed

- **Project-bound session lookup** - session catalog discovery stops at the
  nearest repository boundary instead of adopting an unrelated ancestor AIWG
  workspace.
- **Deterministic provider packaging** - clean plugin builds remove undeclared
  legacy skills, normalize flat skills into provider-compatible directories,
  and rewrite checkout-only self references to packaged plugin roots.

## [2026.8.7] - 2026-08-05 - "Audited activity fixtures"

### Changed

- **Claude plugin release metadata** - all 39 repository-hosted plugins and the
  marketplace catalog advance to `2026.8.7`; the externally hosted `training`
  plugin retains its independent `1.0.0` version.

### Fixed

- **npm publication boundary** - the intentional Activity v1 conformance
  fixtures are now represented in the tarball top-level allowlist, allowing the
  supply-chain audit to distinguish them from an injected package root.
- **Packaging regression prevention** - a unit test now requires every positive
  root in `package.json#files` to be declared in the audited tarball allowlist.

## [2026.8.6] - 2026-08-04 - "Governed sandbox integration and external artifact roots"

### Added

- **External artifact-root attachment** - `aiwg artifacts attach --to <path>`
  connects an existing AIWG artifact corpus without moving or overwriting either
  tree, validates the target project, writes the location pointer, and refreshes
  discovery metadata.
- **Agentic Sandbox MCP operations** - Cockpit exposes the qualified nine-tool
  fleet and activity surface with explicit authorization, completeness, and
  fail-closed contract handling.
- **Regression coverage for reorganized contracts** - exact mirrored Activity
  v1 schemas, drift checks, external-root resolution, and the credential-free
  Sandbox qualification prevent stale source locations and API assumptions from
  silently returning.

### Changed

- **Claude plugin release metadata** - all 39 repository-hosted plugins and the
  marketplace catalog advance to `2026.8.6`; the externally hosted `training`
  plugin retains its independent `1.0.0` version.
- **Sandbox compatibility evidence** - qualification is pinned to Agentic
  Sandbox `v2026.8.3` and records unavailable runtime tiers as insufficient
  evidence rather than a passing result.

### Fixed

- **Artifact discovery outside the repository** - workspace status, resource
  preflight, indexing, and synchronization now consistently follow the
  `.aiwg-location` contract after a corpus is attached.
- **Activity schema drift** - the Cockpit and Sandbox boundary now uses exact,
  mirrored schemas with a CI gate that detects upstream divergence.

## [2026.8.5] - 2026-08-04 - "Observable sandbox operations and reliable plugin delivery"

### Added

- **Session analytics and forensic evidence indices** - session import and
  reindex maintain versioned, content-free operational facts with stable source
  citations. New `sessions analytics` and explicitly authorized
  `sessions forensics` views provide filtered JSON and sanitized Markdown
  timelines without executing or exporting historical provider payloads
  (#1974).
- **Reviewed line-memory promotion** - line-memory interoperates with reviewed
  promotion workflows while preserving provenance and review boundaries.
- **Marketing design operations** - theme selection, comparison, templates,
  schemas, and a theme-manager workflow support repeatable cross-channel visual
  design decisions.
- **Governed Cockpit activity views** - coverage-first timeline and signed
  export surfaces preserve sandbox completeness, authorization, and provenance
  evidence while managed-Docker posture identifies instances that need secure
  recreation (#2011, #2012).
- **Web release revalidation contracts** - signed-resource metadata supports
  payload-bound ETag and Last-Modified revalidation, verified-cache recovery,
  structured diagnostics, and scoped CDN purge verification.

### Changed

- **Claude plugin release metadata** - all 39 repository-hosted plugins now
  advance with the marketplace release version so Claude Code refreshes cached
  payloads; the independently versioned training plugin remains external.

### Fixed

- **Standalone Claude plugin paths and discovery** - newly packaged plugin
  payloads resolve their own assets through `CLAUDE_PLUGIN_ROOT`, all declared
  skills use Claude-compatible `skills/<name>/SKILL.md` layouts, and manifests
  match their bundled skill inventories.
- **Line-memory context-pack concurrency** - reviewed batch touches again use
  the project memory lock, preventing concurrent writers from losing facts.
- **Cockpit activity error stability** - timeline and export preserve upstream
  401/403 status instead of dereferencing success-only fields, and malformed
  completeness envelopes now fail closed before reaching the UI.
- **Documentation drift** - the plugin catalog, provider guidance, paid-resource
  token names, HTTP cache behavior, theme-manager path, welcome instructions,
  and threat-policy link now match shipped contracts.

## [2026.8.4] - 2026-08-03 - "Governed missions and complete plugin delivery"

### Added

- **Complete Claude Code plugin catalog** - all 40 packaged frameworks and
  addons are independently installable from the marketplace, with cached
  bundles retaining their complete runtime-relative dependency trees.
- **Provider-neutral corpus memory ingest** - `aiwg storage import-corpus`
  previews and ingests local research text through the storage/MCP abstraction,
  preserves Markdown metadata, and skips binary attachments safely. Fortemi
  storage supports local stdio plus authenticated HTTPS/SSE Enterprise MCP
  registry entries without persisting credential values (#1508).
- **Shared-host mission admission** - mission workloads declare resource,
  isolation, and policy requirements before dispatch, with deterministic
  admission decisions and auditable denial evidence (#1566).
- **Operator decision evidence** - approvals, denials, overrides, and expired
  decisions use a canonical audit model with stable identities and sanitized
  evidence projections (#1567).
- **Durable mission controls** - pause, resume, cancel, retry, and recovery
  controls survive conductor restarts and are projected into Cockpit alongside
  approval and mission activity views (#1591, #1592, #1657).

### Changed

- **Fortemi research retrieval** - corpus snapshots and query results preserve
  curated retrieval evidence across package boundaries instead of reducing it
  to the core-only representation (#1690).

### Fixed

- **HITL approval interoperability** - drivers and consumers now use the
  canonical approval contract, preserving decision identity and lifecycle
  semantics across runtime boundaries (#1565).
- **Annotated release tag verification** - GitHub mirroring compares the
  peeled commit behind annotated tags, avoiding false mismatches against tag
  object IDs.
- **Claude trace hooks** - generated `SubagentStart` and `SubagentStop`
  commands pass the required `start` and `stop` arguments and repair stale
  registrations on refresh.

## [2026.8.3] - 2026-08-03 - "Plugin lifecycle and release reliability"

### Changed

- **MCP server dependency compatibility** - MCP SDK 1.30.0 permits the fixed
  Hono v2 server line, so the production graph deduplicates to
  `@hono/node-server@2.0.11` and removes the Windows static-serving advisory
  route tracked in #1973.

### Fixed

- **Project-local plugin removal** - removal and doctor checks compare deployed
  files with provider-transformed hashes, preventing freshly deployed skills
  from being reported as mutated while preserving later operator edits (#1998).
- **Local plugin source handling** - `install-plugin --source` now preserves the
  framework-root contract and provides supported migration guidance for
  project-local plugin wrappers instead of crashing on a path-type error
  (#1996).
- **GitHub release mirroring** - stable releases wait for and verify the
  operator-pushed signed annotated tag before release creation, eliminating the
  tag-arrival race without synthesizing tags in CI (#1988).

## [2026.8.2] - 2026-08-03 - "Git-native provenance exchange"

### Added

- **Git-native package exchange** - versioned closed envelopes bind package
  identity to canonical Git remotes, immutable commits, tree/artifact digests,
  W3C PROV, Ed25519 publisher trust, dependencies, licenses, optional SBOMs,
  and lossless Fortemi `2.0.0/full-v1` evidence. Signed federated catalogs,
  project/global indices, offline verification, portable export/import, and
  operation receipts provide decentralized discovery without treating catalog
  inclusion as endorsement (#2009).

### Changed

- **Remote package installation** - movable refs resolve to commit-keyed
  detached caches before deployment, standalone `.aiwg/plugins/` wrappers are
  discovered safely, and external payload deployment copies complete skills,
  agents, and rules for the selected provider (#2009).

## [2026.8.1] - 2026-08-02 - "Persistent memory and governed fleet operations"

### Added

- **Compound memory** - a provider-neutral addon now composes immutable raw
  intake, linked llm-wiki knowledge, reviewed line-memory facts, bounded hybrid
  context packs, registered outputs, governed canonical context, and auditable
  review/maintenance cycles. Three-session conformance proves continuity,
  provenance, hard context budgets, portable migration, and deterministic
  fallback behavior (#1999-#2006).
- **Sandbox fleet workloads and missions** - a neutral workload contract,
  durable multi-target conductor, Cockpit projections, restart-safe identity,
  bounded retries, and three-target recovery evidence support governed fleet
  operations across sandbox runtimes (#1992-#1994).
- **Paid-resource authentication** - `aiwg auth` adds OS-backed account
  storage, exact-origin authorization, account/status/logout controls, and
  signed-resource integration without exposing access material in URLs, cache
  keys, or repository state (#1995).

### Changed

- **Codex deployment reliability** - component-scoped addon sweeps preserve
  kernel skills, generated native skills include `agents/openai.yaml` metadata,
  setup reports `$aiwg-regenerate`, and Codex provider trees are added to
  `.gitignore` without changing already tracked files.
- **Development-checkout notifier routing** - the launcher resolves logging and
  update-notifier modules from the active package, and ignores cache notices
  produced by a different installed version.

### Fixed

- **Lightweight external addon workflows** - `@aiwg/cli` now ships the runtime
  needed to create deterministic standalone plugin archives and deploys valid
  project-local wrappers for their declared providers. Installations can target
  the current project or the global user scope, with the corresponding artifact
  and Fortemi indices refreshed after deployment (#2007, #2008).
- **Fleet admission and recovery** - inventory faults now fail closed, runtime
  child identities survive dispatch and restart, and daemon health semantics
  remain stable during fleet reconciliation.
- **Provider documentation drift** - Codex skill paths, RLM verification,
  regeneration syntax, addon catalog coverage, and Ops extension structure now
  match the shipped runtime contracts.

## [2026.8.0] - 2026-08-01 - "Secure external jobs and operational intelligence"

### Added

- **Session analytics and forensic evidence** - session import and reindex now
  maintain a versioned, content-free analytics index for tool, escalation, HITL,
  lifecycle, retry/quota-pressure, and anomaly facts with stable source
  citations. New `sessions analytics` and explicitly authorized
  `sessions forensics` views provide filtered JSON and sanitized Markdown
  facts and authorized forensic timelines without executing or exporting historical provider payloads
  (#1974).
- **External-trigger single-shot jobs** - the new `aiwg job validate`,
  `aiwg job render-cron`, and `aiwg job run --once` commands define and execute
  approval-gated provider work while cron, systemd timers, or Gitea Actions own
  scheduling. Runs use prompt-on-stdin execution, structured results, stable
  idempotency, locking, redacted evidence, and race-safe Gitea claims (#1985).
- **Design theme operations** - the media-marketing framework now includes a
  theme manager, schemas, templates, comparison workflows, and design QA
  guidance for reusable cross-channel visual systems.

### Changed

- **Registry-signature CI runtime** - main Gitea CI now uses the repository's
  digest-pinned Node 24/npm 11 runtime so the non-waiveable dependency-signature
  gate recognizes npm's rotated registry signing keys.
- **Fortemi shard interoperability** - shard export now defaults to the
  `full-v1` receipt contract, binds producer, converter, and consumer evidence,
  and keeps legacy core-only output available through an explicit mode.
- **Fortemi core dependency** - the supported core and receipt fixtures now use
  `@fortemi/core@2026.7.15`, with conformance and discovery gates enforcing the
  same converter lineage.
- **Truthful scheduling capability reporting** - provider matrices, daemon
  guidance, CLI references, and steward output now distinguish external
  scheduling from AIWG-owned orchestration instead of implying a resident
  scheduler exists (#1984).
- **Cockpit live acceptance evidence** - protected daily validation now waits
  for runtime re-adoption, requires an observable transient disconnect, and
  records the executor-reported version before accepting recovery (#1981).

### Security

- **Windows static-asset traversal defense** - AIWG serve now uses
  `@hono/node-server@2.0.11`, a fixed v2 line for
  `GHSA-frvp-7c67-39w9`. A regression rejects percent-encoded Windows
  backslashes before they can resolve outside the configured static root
  (#1973).
- **Production dependency floor** - minimum compatible versions now include
  current fixes for Hono, MCP SDK, js-yaml, ws, yaml, glob/minimatch, and their
  routed validator dependencies. Chokidar moves to v4 to remove the vulnerable
  picomatch v2 chain. SDK 1.29 still retains a transitive Hono node-server v1
  advisory; SDK 1.30 fixes that route but remains blocked by the seven-day
  minimum-release-age policy (#1973).
- **Cockpit launch credentials** - reusable launch material is no longer placed
  in URLs; scoped handoff and transport state keep it out of history, referrer,
  UI, and routine logging surfaces (#1968).

## [2026.7.25] - 2026-07-31 - "Target-native managed session directories"

### Fixed

- **Cockpit managed-session working directories** - The Bridge now honors the
  executor-reported target cwd for host, container, and VM sessions, with
  `/home/agent` as the compatibility fallback for older container/VM inventory.
  Protected daily validation checks the new cwd invariant on the candidate
  phase while retaining upgrade and rollback coverage for immutable baselines.
- **Cockpit Codex live workload** - Gate-owned workspaces can run the bounded
  Codex discovery probe outside a Git checkout without weakening read-only
  sandboxing.

## [2026.7.24] - 2026-07-29 - "Sandbox runtime readiness and setup manifest CLI"

### Added

- **Cockpit provider-aware VM fast start** - Inventory now gates VM
  snapshot/checkpoint, restore, fork, and warm-pool controls from sandbox
  provider capabilities, sends non-cold VM launches through the unified
  `runtime_options` contract, polls operation status to terminal state, and
  records Bridge audit evidence without exposing executor credentials or host
  secret material (#1843).
- **Cockpit sandbox runtime readiness** - Cockpit now consumes sandbox runtime
  contract fixtures for GPU/VFIO posture, Apple Silicon runtime posture, sandbox
  MCP discovery, local container lifecycle fallback availability, and mTLS
  readiness so new sandbox runtime options degrade by advertised capability
  instead of hard-coded runtime assumptions.
- **Cockpit sandbox MCP projection** - Telemetry now renders sandbox MCP
  discovery metadata, and the Bridge exposes a scoped proxy path that requires a
  separate MCP principal token file before forwarding MCP traffic.
- **Setup manifest CLI** - `aiwg setup-generate`, `aiwg setup-validate`, and
  `aiwg setup-run` now expose the `setup.aiwg.io/v1` manifest flow from the CLI,
  with generated starter assets, schema-backed validation, dry-run planning, and
  discovery coverage for installer workflows.

### Changed

- **Codex project-local skills** - Codex deploy now writes project-local addon
  skills to the native `.agents/skills/` path, keeps `.codex/.aiwg/skills/` as
  the indexed artifact tier, and prunes the deprecated `~/.codex/skills/` path
  so slash-command skill listings no longer duplicate AIWG kernel skills.

### Security

- **Sandbox transport posture** - Cockpit surfaces mTLS local-CA readiness,
  bootstrap posture, and compatibility/degraded transport states from the
  sandbox registry without copying executor bearer material into browser state,
  logs, reports, or audit payloads.
- **Local lifecycle fallback policy** - Docker CLI reconnect/destroy fallback is
  now explicitly opt-in for local development, and libvirt reconnect fallback is
  automatic only on Linux unless the operator enables the non-Linux fallback.

## [2026.7.23] - 2026-07-28 - "Complete package manifest publication recovery"

### Fixed

- **Published package allowlist** - recognize the deliberately shipped
  `schemas/`, `setup.aiwg.yaml`, and `vscode-extension/` package roots. The
  signed `v2026.7.22` publication stopped at the tarball supply-chain gate
  before either registry accepted a package; this patch preserves that gate
  while allowing the reviewed package contents to publish.

## [2026.7.22] - 2026-07-28 - "Configurable threat policy and complete capability discovery"

### Added

- **Agentic install, repair, and upgrade flow** - a public
  `setup.aiwg.io/v1` manifest gives any supported provider one canonical,
  copy/pasteable installation contract. It inspects Node/npm and PATH health,
  repairs stale or duplicate published installs with approval, preserves
  source-checkout development mode by default, deploys `all`, builds indices,
  regenerates provider context, and verifies engagement before declaring
  success.
- **Configurable threat-assessment policy** - projects can select `off`,
  `audit`, or `enforce`, use built-in or custom composable profiles, and apply
  isolated policy to issue, pull-request, review, outbound-comment,
  release-note, and handoff surfaces. Typed config, schemas, fail-closed
  validation, deterministic evidence, and narrow attributable risk acceptance
  make the applied rule and action auditable (#1938).
- **Discoverable LLM Wiki operations** - the addon now has a canonical
  operational driver, so capability discovery can route users to its setup,
  ingest, query, and maintenance workflows instead of exposing an inert bundle
  (#1957).

### Changed

- **Starter guidance** - the root and published package READMEs now lead with
  the same agentic installer and manual fallback. Restarting the provider is a
  verified compatibility fallback after indexing and regeneration rather than
  a routine first-run requirement.
- **Complete component discovery coverage** - every shipped framework, addon,
  extension, plugin, and packaged operational component must resolve to an
  indexed driver or an explicit exemption. CI emits a coverage report and
  fails when a component becomes undiscoverable (#1958).
- **Session import lifecycle evidence** - imported provider histories preserve
  origin timelines, terminal lifecycle states, and relocation evidence across
  supported session adapters, with regression fixtures covering the normalized
  contract.

### Fixed

- **Release manifest binding** - signed web-release manifests bind to the exact
  signed-tag commit, preventing a later branch head from being substituted
  during publication.
- **Release CI dependencies** - publish tests install the optional SQLite
  backend without weakening the minimum-release-age policy used by dependency
  gates.
- **Threat-assessment false positives** - negative, quoted, documentation, and
  explicit out-of-scope secret warnings no longer become requested credential
  probing under the balanced profile, while malicious variants remain
  detected (#1922, #1938).

### Security

- **Surface-aware forge-content gates** - one provider-neutral engine now
  assesses untrusted issue, PR, diff-summary, review, release, and handoff
  content before it influences execution or is amplified through maintainer
  communication. Independent repository authorization and platform safeguards
  remain additive (#1938).

## [2026.7.21] - 2026-07-27 - "Portable skills, session intelligence, and conversational guidance"

### Added

- **Secure Agent Skills lifecycle** - AIWG can validate, import, inspect,
  activate, update, deploy, export, diagnose, and uninstall portable Agent
  Skills directories. Local and pinned-Git imports preserve resources without
  executing scripts, bind trust to the exact source and digest, reject unsafe
  paths and collisions, and project provider-compatible bundles with retained
  provenance and AIWG metadata sidecars (#1875-#1881).
- **Cross-provider session intelligence** - the new `aiwg sessions` catalog
  imports normalized, redacted session evidence from Claude Code, Codex,
  Copilot, Cursor, Factory, Hermes, OpenCode, OpenClaw, OpenHuman, Warp,
  Devin Desktop/Windsurf, and a declared generic interchange. A versioned JSON
  CLI covers source discovery, import, list/show, scoped FTS5 search, tagging,
  relocation, reindexing, health, audit, tombstone/restore, and terminal purge
  workflows (#1898).
- **Review-gated session memory** - policy-approved extraction produces cited,
  versioned candidates rather than durable memory. Explicit review, security
  acknowledgment, consumer selection, preview, confirmation, lineage receipts,
  conflict handling, supersession, revocation, and idempotency guard the
  promotion path. Optional semantic backends require a scope-bound preview and
  approval; local lexical search remains the default (#1898, #1935).
- **Line Memory addon** - a small plain-text project memory retains bounded,
  recency-ordered facts with add, list, search, touch, prune, and safe
  project-local configuration commands. Retrieval is deliberately bounded and
  the backing file is never injected wholesale into provider startup context
  (#1922).
- **Agent/operator documentation corpus** - deterministic CLI, provider,
  discovery, onboarding, Node/npm setup, diagnostics, and recovery references
  now have stable IDs under `docs/agents/`, remain in installed and signed
  release reference artifacts, and are excluded from the public end-user site
  (#1937).

### Changed

- **Conversational onboarding** - public getting-started, quickstart, provider,
  and framework journeys now teach the preferred sequence: install AIWG,
  deploy the complete system with `aiwg use all --provider <provider>`, reopen
  the provider, invoke `aiwg-regenerate`, and verify the connected project.
  Agent-owned commands are presented as agent/operator execution detail, with
  explicit approval, outcome, evidence, and recovery expectations (#1937).
- **Session conformance and performance gates** - required CI now installs the
  optional SQLite backend, proves all repository/provider suites ran with zero
  skips, and preserves production-path import, search, metadata, extraction,
  bounded-failure, and memory evidence. Provider support is tied to fixtures,
  limitations, documentation, and executable conformance rather than a
  capability claim alone (#1932).
- **Fortemi shard lifecycle projection** - index exports carry lifecycle,
  mutation, and state-transfer semantics through the current `core-v1`
  producer/consumer receipts, with AIWG pinned to `@fortemi/core@2026.7.14`
  (#1892).

### Fixed

- **Citation edge normalization** - citation sidecar parsing accepts shifted
  and recognized table variants, distinguishes declarations from canonical
  graph edges, and reports edge statistics without conflating the two
  (#1939, #1940).
- **NLP production commands** - the `nlp-prod` addon again ships executable
  modules for new, status, add-step, eval, estimate-cost, optimize, and
  productionize operations; manifest wiring, doctor diagnostics, and
  integration coverage prevent declared commands from disappearing (#1923).
- **Codex skill context budget** - Codex uses the canonical shared
  `.agents/skills/` projection and deployment conformance prevents duplicate
  skill surfaces from exhausting the context budget (#1884).
- **Deterministic CI fixtures** - daemon HTTP tests now ask the operating
  system for an available port, and Git-history peak-day fixtures use a fixed
  timestamp so concurrent processes and UTC midnight cannot cause release-gate
  failures.

### Security

- **Hostile session-content containment** - imported transcript content remains
  inert data through structural and model-backed extraction. Schema, evidence,
  span, scope, Unicode, active-content, and instruction-like checks reject
  unsafe candidates; suspicious accepted candidates require explicit risk
  acknowledgment and are encoded so they cannot alter promoted document
  structure (#1935).
- **Authorized lifecycle and deletion** - workspace/provider scope is enforced
  before session search and snippets. Tombstone is reversible, purge is
  preview-first and terminal only after explicit confirmation and dependent
  disposition, and content-free receipts preserve accountability without
  retaining transcript text or source paths (#1898).

## [2026.7.20] - 2026-07-26 - "Portable project resources and measured discovery"

### Added

- **Measured operational discovery** - a versioned 80-query relevance corpus
  and `aiwg index eval-discovery` benchmark now cover all eight broad
  capability types. The benchmark reports ranking quality, hard-negative
  intrusion, latency, index size, and memory across production and experimental
  retrieval paths; the recorded decision retains lexical discovery until a
  candidate clears the confidence and representation gates (#1819).
- **Provider kernel conformance** - integration coverage now verifies every
  supported provider deploys the full canonical kernel skill inventory and no
  standard skills, keeping the always-visible skill surface aligned across
  Claude, Codex, Copilot, Cursor, Factory, Hermes, OpenClaw, OpenHuman,
  OpenCode, Warp, and Windsurf.
- **Project quickref deployment coverage** - unit tests now lock each supported
  provider to its expected project-local quickref destination.
- **Local media transcription adapters** - media-curator transcription and
  diarization skills now document and provide local adapter scripts, with
  framework, plugin, and quick-reference surfaces kept in sync.

### Changed

- **Portable project artifact resolution** - remaining context, storage,
  configuration, MCPsmith, Toolsmith, update, and project-local extension paths
  resolve through the shared artifact-root model. Status and help output expose
  the resolved root, and migration records honor `AIWG_ARTIFACTS_PATH` (#1857).
- **Model-aware provider bootstrap** - generated guidance assesses non-trivial
  work for bounded decomposition, selects the appropriate worker wrapper,
  enforces provider concurrency caps, and accurately qualifies native,
  compiled, global-only, and unsupported behavior (#1862).
- **Kernel inventory documentation** - architecture and discovery docs now
  report the current 24-skill kernel surface, including routing maps and
  self-maintenance branches.
- **Project-local plugin lifecycle** - standalone packaging, promotion,
  removal, discovery, and update behavior now share validated project-local
  paths and package contracts.
- **Project corpus smoke gates** - real-corpus artifact tests now distinguish
  partial public runtime `.aiwg` state from the full private SDLC corpus, while
  preserving the full-corpus assertions when requirements, planning, security,
  and testing assets are present.
- **Documentation reconciliation** - the release code-to-docs pass refreshed
  eight managed framework and addon documentation copies from their
  authoritative component sources.

## [2026.7.19] - 2026-07-23 - "Complete package documentation and release verification"

### Changed

- **Released Core 2026.7.13 shard boundary** (#1870) — AIWG now pins the
  published `@fortemi/core@2026.7.13` package and public
  `@fortemi/core/aiwg-index-shard` entry point. Blocking receipts cover the
  regenerated `core-v1` archive and a deterministic, lossless
  `2.0.0/full-v1` consumer fixture; full-v1 advertisement remains disabled
  until the independent Fortemi runtime and destination gates close.
- **Full dedicated lightweight CLI README** — `@aiwg/cli` now ships a
  standalone npm-quality README covering distribution choice, signed web
  resources, discovery and lookup, version pinning, caching and offline use,
  the JavaScript API, security, scope boundaries, migration, troubleshooting,
  development, and support. A cross-package regression prevents any published
  AIWG package README from returning to stub-level documentation.
- **Deprecated npm bootstrap tag cleanup** — the npm trusted-publication
  workflow now exposes a maintenance-only path that removes the historical
  `@aiwg/cli@bootstrap` dist-tag using the existing narrowly scoped package
  management token without republishing release artifacts.
- **Dependency-safe Gitea mirror verification** — release verification now
  clean-installs the full, lightweight CLI, and Cockpit tarballs resolved from
  Gitea while leaving third-party dependency resolution on npmjs.org. Generated
  Gitea release notes and operator documentation use the same tarball-URL
  pattern because Gitea's bundled npm registry is a package store, not an
  npmjs proxy.

## [2026.7.18] - 2026-07-23 - "Web-first CLI and packaged Cockpit"

### Changed

- **Zero-configuration lightweight CLI** — installed `@aiwg/cli` binaries and
  its exported CLI API now select the signed `stable` web resource channel for
  `discover` and `show` when no source flags are supplied. The full `aiwg`
  package retains its legacy local-corpus default, and explicit
  `--resource-source` / `--aiwg-version` choices continue to override either
  package default.
- **Bounded cold web fetches** — the total signed release-resource request
  timeout is 60 seconds, accommodating first-run manifest and Fortemi index
  downloads while retaining a finite failure bound.

### Fixed

- **Self-contained Cockpit package** — `@aiwg/cockpit` now builds and includes
  its production React UI during `prepack` from an isolated temporary workspace,
  clears inherited npm dry-run and publish-registry settings before installing
  public build dependencies, atomically stages the result under a cross-process
  lock, includes its MIT license, starts correctly through npm's global binary
  symlink, and handles a missing optional `agentic-mgmt` executor without
  crashing.
- **Complete lightweight CLI package metadata** — `@aiwg/cli` now includes the
  repository MIT license and its README documents the no-flag web workflow.
- **Installed-package regressions** — package tests exercise configuration-free
  CLI binary/API web discovery and lookup, legacy full-package local behavior,
  Cockpit symlink launch and compiled UI serving, missing-executor startup, and
  package allowlists.

## [2026.7.17] - 2026-07-22 - "Portable resources and lightweight CLI"

### Added

- **Relocatable project artifact root** — the CLI now honors `.aiwg-location`
  and `AIWG_ARTIFACTS_PATH` across project indexing, project-local bundles,
  quickrefs, workspace context wiring, local issue state, memory/knowledge
  stores, serve identity config, and related runtime state. `aiwg artifacts
  move --to <path>` moves or renames the artifact root, writes the pointer,
  updates local ignore rules, and reindexes.
- **Project-local bundle search paths** — `projectLocal.searchPaths` in
  `aiwg.config` and `AIWG_PROJECT_LOCAL_PATHS` let operators add custom addon,
  extension, framework, plugin, and provider roots without moving the main
  project corpus.
- **Experimental web-backed `discover`/`show` slice**
  ([#1848](https://github.com/jmagly/aiwg/pull/1848),
  [#1849](https://github.com/jmagly/aiwg/pull/1849),
  [#1850](https://github.com/jmagly/aiwg/pull/1850),
  [#1853](https://github.com/jmagly/aiwg/pull/1853)) —
  `aiwg discover` and `aiwg show` now support `--resource-source` (`local|web|auto`),
  exact-or-channel `--aiwg-version`, and `--offline`; web mode uses signed
  release manifests plus `@fortemi/core` query against the v2 export, while `show`
  caches verified resource bodies for warm offline reads.
- **Supported installed-package API and conformance gate** (#1853) — package
  consumers can import the CLI router and signed resource helpers from `aiwg`
  or `aiwg/resources`. The packed-install regression exercises that public API,
  the real installed CLI, legacy configuration, local packaged resources,
  signed web search/show, and warm offline cache behavior.
- **No-project global bootstrap** (#1872) —
  `aiwg use <framework> --provider <name> --global` installs framework and
  kernel assets into verified provider user paths while generating only
  lightweight context/bootstrap files in the current project. The existing
  `--scope user` behavior remains an additive project-plus-user mirror.
- **CalVer-locked lightweight CLI package** (#1847) — `@aiwg/cli` now packages
  the compiled CLI/API runtime without the bundled corpus, documentation,
  templates, or precomputed local indices. Its version and runtime dependency
  set must exactly match the main `aiwg` package, and both npm registries build,
  publish, and verify it alongside the full and Cockpit distributions.

### Changed

- **Full-package size ceiling** — raised the compressed `aiwg` package budget
  from 22,000 KB to 23,000 KB for the signed web-resource runtime, portability
  support, and precomputed release-discovery assets added in this release. The
  separate file-count, unpacked-size, and Fortemi index budgets remain in place.

### Fixed

- **Concurrent package index generation** — Fortemi prebuilt builds now use a
  cross-process lock and publish complete generations through a staged swap,
  preventing concurrent npm packaging from capturing a missing or partial
  framework index.

## [2026.7.16] - 2026-07-21 - "Workspace context and provider orchestration"

### Added

- **Live-state provenance for operational memory** (#1827) — Fortemi v2
  records can preserve allowlisted tracker/repository observations, classify
  them as fresh, historical, superseded, contradicted, or needs-source, expose
  currentness and live-recheck requirements in query output, and carry the
  contract losslessly through portable Knowledge Shards without serializing
  credentials or URL query material.
- **Cockpit daily Linux operator gate** (#1842) — a single fail-closed command
  now composes protected-executor host/container UAT, explicit authorization
  failures, managed-PTY working-directory and scratch-mutation proof, transient
  and restart recovery, previous-stable/candidate upgrade and rollback hooks,
  scoped cleanup, immutable version evidence, and secret-scanned deterministic
  JSON/Markdown reports. Executor credential-file paths are also removed from
  Bridge error responses. VM and Apple remain visible non-blocking preview tiers.

- **Existing-project context extraction** (#1830) —
  `aiwg regenerate --existing-project` previews or atomically applies a bounded,
  source-attributed project snapshot inside `WORKSPACE.md`, migrates active
  provider roots (including `AGENTS.override.md`), excludes generated framework
  and spillover content, refuses credential/conflict hazards, and emits an exact
  rollback command. A third linked branch skill documents the workflow.

- **Agentic model-wrapper routing and UAT** (#1831) — Steward emits a
  capability-bound, provider-compiled launch envelope for deterministic,
  economy, standard, and premium work; exact capability resolution contributes
  a stable id and packaged provenance; and a repeatable agentic UAT plan covers
  routing, deployment, live subagents, regeneration, and defect handling.
- **External research incorporation audit** — three independently routed model
  wrappers evaluated 1,901 local research records and produced a deduplicated,
  evidence-graded portfolio of 155 candidates for future AIWG work.
- **Explicit regeneration branches** (#1829) — `aiwg regenerate --workspace`
  maintains the canonical context graph while `--full-inject` provides the
  legacy inline compatibility path. The selector skill links to dedicated
  branch skills and conflicting or unknown options fail closed.
- **Canonical cross-provider workspace context** (#1811) — new projects create
  a protected `WORKSPACE.md` graph; provider definitions now declare verified
  loader contracts; `workspace-context audit|migrate|rollback|doctor` provides
  conflict-aware, credential-gated, atomic and reversible legacy migration;
  regeneration, deployment, doctor, and indexing share the same implementation.

- **Process-aware runbook discovery** — procedural Markdown and declarative
  runbooks are indexed as a discrete `runbook` type alongside YAML flows,
  retain their original document/template source type, and participate in
  local, static Fortemi, MCP, fallback, user-graph, and finder discovery.

### Changed

- **Structured operational search metadata** — flows retain their exact
  workflow kind and contribute bounded action, verification, rollback,
  inventory, target, and step language to lexical and embedding inputs.
  Extractor revisions now invalidate stale incremental entries independently
  of the stable index schema version.
- **Testing artifact layout** — durable plans, protocols, and deterministic
  fixtures remain tracked while generated reports, logs, and dashboard state
  move under the ignored `.aiwg/testing/outputs/` directory.

- **Deterministic Fortemi shard conformance refresh** (#1797) — AIWG now pins
  the published `@fortemi/core@2026.7.11` converter. The representative
  `core-v1` fixture is byte-reproducible across independent exports, while the
  immutable receipt continues to prove clean PGlite and Fortemi server
  import/re-export with zero undeclared loss.

### Fixed

- **Cockpit protected-executor authentication** (#1841) — the Bridge now reads
  a mode-restricted token file for centralized authenticated REST/A2A calls,
  preserves upstream 401/403 failures, reloads rotations without restart, and
  proxies PTY WebSocket upgrades so long-lived executor credentials never enter
  browser state or attach URLs.
- **Cockpit transient auto-recovery** (#1763) — the global status now shows
  `Reconnecting…` during Bridge/executor or SSE gaps, retains explicitly marked
  last-known counts, retries with bounded backoff, and refreshes all mounted
  live-data views when the connection returns without a page reload.

- **Release config schema parity** — release steps may now use a
  channel-dependent command without also declaring an unused plain `run`
  command, matching the stable npm dist-tag configuration.
- **Clean-checkout release validation** — release plans now build the CLI
  before integration tests invoke it, avoiding false failures when `dist/` is
  absent from a fresh checkout.
- **Deterministic test resource use** — Vitest now bounds worker concurrency
  and exercises file watching through polling so shared-host inotify limits and
  aggregate database contention do not create false release failures.
- **Canonical SDLC orchestration routing** (#1839) — the orchestration rule,
  kernel/project context templates, core prompt, architecture guidance, and
  new-project output now treat skills and referenced playbooks as authoritative,
  route through `sdlc-quickref` and `aiwg discover` → `aiwg show skill`, and
  describe slash commands as provider adapters rather than Claude-specific
  workflow definitions. Regression coverage prevents command-first guidance
  from returning to the packaged rule and assembled context.
- **Strict Steward route option parsing** (#1834) — value-bearing routing flags
  now reject end-of-input and a following option token with usage status instead
  of consuming another flag as data or emitting a misleading launch envelope.
- **Root context ceiling after workspace adoption** (#1836) — authorized
  existing-project regeneration replaces stale oversized provider roots with
  minimal linked adapters while preserving their bodies under
  `.aiwg/context/providers/`.
- **Characterization test isolation** (#1835) — the mutating `--new` alias
  now runs in a disposable project and explicitly verifies that the repository
  `WORKSPACE.md` state is unchanged.
- **Model-wrapper deployment verification** (#1832, #1833) — `aiwg use`
  validates wrapper identity, role/tier metadata, Codex model/effort pins, and
  Claude semantic aliases instead of accepting filenames alone; Steward now
  rejects missing or type-mismatched capabilities before creating a route.
- **Provider-aware model compilation and authoring** (#1821, #1822, #1823,
  #1824, #1825, #1826) — model audit and resolution now consume the effective
  dynamic catalog; AgentSmith emits compiled Codex TOML; agent, skill, and
  command generators use canonical cheap-first role/tier policy; and Steward
  routes model catalog and escalation questions through the supported CLI.
- **Flow namespace false positives** — workflow indexing now accepts only the
  declared Flow/Workflow/Ops resource families instead of treating every YAML
  document under an `ops.aiwg.io` namespace as a flow.

## [2026.7.15] - 2026-07-20 - "Windows portability fixes"

### Fixed

- **Windows Claude Code hook execution**
  ([jmagly/aiwg#133](https://github.com/jmagly/aiwg/issues/133)) —
  generated hook commands now use forward-slash script paths on every host,
  preventing Claude Code's Windows shell parser from collapsing backslashes
  into invalid `MODULE_NOT_FOUND` paths. Redeployment also repairs existing
  AIWG-managed backslash commands.
- **Windows shared graph index location**
  ([jmagly/aiwg#132](https://github.com/jmagly/aiwg/issues/132)) — shared index
  paths now fall back to Node's cross-platform home-directory resolver when
  `XDG_DATA_HOME` is unset, instead of creating a literal
  `undefined/.local/share` tree inside the project.

## [2026.7.14] - 2026-07-20 - "Provider-aware model routing and Fortemi conformance"

### Added

- **Published Fortemi shard conformance receipt** (#1797) — exact
  `@fortemi/core@2026.7.9` output is preserved unchanged and exercised through
  clean PGlite and Fortemi server import/re-export paths. A digest-pinned
  `core-v1` fixture, strict capability/loss receipt, five zero-mutation failure
  cases, and blocking clean-checkout CI establish the profile-scoped boundary.
- **Additional native model discovery decisions** (#1815) — OpenCode and
  OpenClaw now join Codex with documented non-interactive discovery adapters,
  runtime provenance, normalized results, and classified failure handling.
  Every provider has an executable implemented-or-unsupported decision.
- **Public model-feed decision record** (#1816) — AIWG will not operate a
  hosted/nightly catalog until authoritative entitlement-neutral sources and
  publication safety gates exist; remote feeds remain explicit operator
  configuration and never become a deployment dependency.
- **Provider inventory and dynamic model sources** (#1812, #1813) —
  `aiwg runtime-info --providers` distinguishes configured, deployed,
  detected, available, and active providers with scoped evidence.
  `aiwg models sources|refresh` adds provenance-aware native/public/cache/static
  resolution; Codex uses app-server `model/list`, while deployment remains
  offline and consumes only a fresh cache or committed fallback.
- **Cross-provider model worker wrappers** (#1814) — reasoning, coding, and
  efficiency workers now have exact native, semantic-hint, inherited/global,
  or unsupported output assertions across all eleven providers without
  launching provider sessions.
- **Safe model-management command family** (#1804) — `aiwg models` now supports
  audit, list, resolve, set-default, selected/bulk set, validate, and legacy
  migration operations with typed selectors, JSON/dry-run output, atomic
  writes, provider compilation results, and target-relative project config.
- **Provider-neutral skill model policy** (#1803) — skill `commandHint` now
  carries role/tier/effort intent through both command-generation paths,
  deterministically migrates legacy hints, compiles requested Claude skill
  controls natively, and reports degraded targets without pretend fields.
- **Provider model capability registry and schemas** (#1802, #1805) — a dated
  11-provider registry now records agent, skill, and global child controls,
  identifier syntax, inheritance, fallback, configuration targets, and
  verification methods. Exact model IDs live in a separately refreshable
  catalog with status, observation, and staleness metadata. Versioned schemas
  cover canonical policy, capabilities, catalog mappings, and compatibility
  input.
- **Typed model-policy compiler diagnostics** (#1802, #1805) — provider
  compilation reports `native`, `compiled`, `inherited`, `global-only`,
  `informational`, or `unsupported`, omits unenforceable fields, and emits
  stable diagnostic codes for unsupported surfaces, effort degradation,
  unverified/deprecated overrides, and stale catalogs.
- **Tracker label taxonomy and workflow semantics** (#1789) — project config can
  map stable semantic roles to Gitea, GitHub, and local label names, including
  human/blocking and resume behavior. Read-only validation reports missing,
  duplicate, conflicting, and unavailable labels; issue workflows document
  semantic filtering and transient-label transitions without implicit
  provisioning. `aiwg config validate --project` exposes these diagnostics,
  including optional provider label-catalog availability checks.
- **Actionable address-issues threat preflight** (#1780) — threat reports now
  preserve paragraph-level evidence and emit verdict rationale, threshold
  explanation, operator remediation, conservative-policy context, and a
  ready-to-post cycle-comment payload.
- **Project-local quickrefs** (#1788) — projects can commit
  `.aiwg/quickref.json`, preview deterministic generation with
  `aiwg quickref generate --project --dry-run`, and deploy the resulting
  always-visible orientation skill through provider kernel or emulation paths.
  `aiwg use` refreshes it, ownership markers make stale pruning safe, and
  `aiwg doctor --project-local` validates source and deployment drift.

### Changed

- **Project-dedicated repository authority** — AIWG ordinary commits, release
  tags, and Gitea transport now use three separate project credentials held in
  OpenBao. Repository-local identity is `roctinam`; vault-backed commit and push
  adapters fail closed on fingerprint or authenticated-account mismatch.
- **Observed Codex model routing** (#1185) — bounded live Codex CLI probes
  replaced ChatGPT-incompatible `gpt-5.3-codex` and
  `gpt-5.1-codex-mini` defaults with observed `gpt-5.5` standard and
  `gpt-5.4-mini` economy mappings. Deployed custom agents now receive
  high/medium/low default reasoning effort by semantic role when no explicit
  effort is present; invalid and unavailable pins fail without silent fallback.
- **Provider model conformance matrix** (#1807) — shared semantic fixtures and
  eleven-provider goldens now assert native/degraded output, targets, formats,
  field names, unsupported-key omission, unknown/blocked pins, and skill
  behavior. Normal CI stays fixture-first and cost-free; an explicit,
  no-overwrite live-smoke recorder caps each operator-authorized run at $0.25.
- **Cheap-first canonical model policy** (#1806) — 358 unique agent and
  isolated-skill artifacts are now inventoried once across 741 source/mirror
  files. Governed defaults are 77.2% economy, 18.9% standard, and 3.9%
  allowlisted premium; every premium default has a reviewed risk rationale.
  CI enforces metadata, duplicate consistency, distribution, exact-ID,
  rationale, and representative-evaluation gates.
- **Provider-aware cheap-first model-routing plan** (#1185, #1801–#1807) —
  ADR-015 now separates stable role/tier/effort intent from volatile provider
  model IDs, defines explicit native/degraded compilation semantics, and pairs
  the cross-provider audit with a staged implementation and conformance-test
  plan. Historical model-selection documents now identify unimplemented
  commands and stale assumptions.

### Fixed

- **Vault-backed release tag verification** — the release wrapper now verifies
  with the same ephemeral release-key adapter used to create the tag instead of
  falling through to the repository's intentionally separate commit-signing
  program. Signing probes and tag creation always use batch loopback pinentry
  with the vault-supplied mode-600 passphrase file, so no passphrase dialog can
  appear. The public-key verification gate likewise ignores repository-local
  private-key adapters. Operator instructions use the TPM-backed OpenBao
  AppRole handoff and injected private routing environment.
- **Native Codex custom-agent output** (#1802) — Codex deployment emits valid
  standalone `.codex/agents/*.toml` definitions with required identity and
  instruction fields plus native `model` and `model_reasoning_effort` controls,
  sourced from the refreshable model catalog.
- **Provider-aware model doctor and lint** (#1805) — doctor distinguishes
  enforceable agent policy from unsupported skill policy, counts Codex TOML
  agents, and the agent linter recognizes pinned family IDs without prescribing
  premium solely because an agent can delegate.
- **Numeric model-tier mapping** (#1185, #1805) — runtime Tier 1 maps to
  `economy`, Tier 2 to `standard`, and Tier 3 to `premium`.
- **Pinned model role classification** (#1801) — Codex, Claude Code, and Warp
  deployment transforms plus role-filtered deployment now share one classifier
  for aliases, pinned Claude-family IDs, and provider-qualified IDs. Explicit
  unknown identifiers remain unknown instead of silently collapsing into the
  coding population.

## [2026.7.13] - 2026-07-15 - "Complete provider context and release routing"

This stable release makes aggregated provider context complete across
framework, addon, and extension deployment passes, restores OpenHuman's project
bridge, finishes the provider-neutral vault migration, and refreshes onboarding
and documentation surfaces from the shipped code.

### Added

- **Existing-project regeneration guidance** — onboarding now consistently
  directs upgraded or existing projects through `aiwg regenerate`, while the
  in-agent `/aiwg-regenerate` surface remains available.
- **OpenHuman project bridge coverage** (#1785) — deployment renders the
  project-root `AGENTS.md` context bridge and verifies it in integration tests.
- **Complete rule-corpus regression coverage** (#1784) — unit and integration
  tests prove that framework, addon, and extension passes preserve one complete
  MEDIUM/LOW on-demand index.

### Changed

- **Provider-neutral vault routing** — CI secret fetch, release signing, docs,
  and migration verification use the generic `VAULT_CI_*` contract and routed
  vault variables instead of provider-specific names.
- **Pagenary publisher 2026.7.23** — documentation rendering preserves entities
  in inline markdown and the Fortemi control now renders as an icon popover.
- **OpenHuman deployment documentation** — the quickstart, CLI reference,
  template, and ADR now describe user-global kernel/rule payloads, optional
  native TOML workers, and the automatic project `AGENTS.md` bridge.

### Fixed

- **Multi-pass on-demand rule indexes** (#1784) — rule discovery resolves the
  repository root before enumerating the corpus, preventing addon or extension
  passes from truncating entries written by an earlier deploy pass.
- **OpenHuman full deployment** (#1785) — full deploys now use the provider
  template and render the complete on-demand section into `AGENTS.md`.
- **Research citation resolution** (#1787) — slugged research citations resolve
  correctly in the generated documentation graph.
- **Release tag wrapper drift** — `cut-tag.sh` uses the generic vault fetcher,
  the current fetch spec, and the release-only signing identity required by the
  project signing policy.

## [2026.7.12] - 2026-07-13 - "Cockpit recovery, VM reconnect, and OpenBao CI"

Stale-agent recovery in Cockpit — now extended to VM runtimes — a dedicated
Cockpit documentation section derived from the code, a native corpus-snapshot
command, the migration of CI secrets and release signing to OpenBao, and the
post-audit hardening of the external agent-loop LFD controls.

### Added

- **Cockpit stale-agent recovery** — Inventory and Sessions keep running
  container/Docker/**VM** instances visible even when their agent registration is
  stale, mark them as `agent unreachable`, and expose a **Reconnect** action that
  asks the Bridge to recover the agent.
- **Cockpit VM-runtime Reconnect** (#1778) — VM/QEMU/KVM instances now have a
  recovery path: the Bridge delivers the reconnect SIGHUP through the libvirt
  qemu-guest-agent channel (`virsh qemu-agent-command <domain> guest-exec
pkill -HUP -x agent-client`), the VM counterpart of the container
  `docker exec agent-reconnect` fallback.
- **Dedicated Cockpit documentation section** — `docs/cockpit/` (overview,
  installation, architecture, surfaces, sessions, bridge API, trust & security,
  recovery, development, releases) derived code-to-docs from the Bridge, web UI,
  and companion components, and wired into the docsite nav.
- **`aiwg corpus snapshot`** (#1647) — a native, deterministic corpus-snapshot
  command (full markdown / terminal summary / JSON) backed by a declarative Flow
  playbook, replacing the hand-assembled computed sections in the skill.
- **LFD external-loop control surface** — the external Ralph/agent-loop path
  carries the repaired LFD budget, plateau, exploration-quota, stall-rule,
  hypothesis, holdout-isolated, eval-harness, and VOID-runtime controls across
  CLI, runtime, schema, and CI surfaces.
- **Manual provider verification path** — adds the `ralph:manual-test` runbook
  for bounded live-provider checks against real CLIs.

### Changed

- **CI secrets and release signing moved to OpenBao** — release workflows fetch
  migrated secrets and the GPG release key from an OpenBao vault at CI time via a
  least-privilege AppRole, replacing stored Gitea secrets; the signing identity
  is unchanged for verifiers.
- **Cockpit VS Code shell consumes shell-core** (#1783) — the extension now
  imports the shared shell-core handshake instead of reimplementing it, and gains
  a Windows Credential Manager backend (PasswordVault) that can retrieve tokens
  (the previous `cmdkey` path was write-only).
- **Cockpit qemu/kvm runtime coverage** (#1782) — the header matrix, Home
  coverage banner, and reconnect gating agree on VM-family membership through a
  shared helper, so qemu/kvm instances light `vm ✓`.
- **Cockpit operator documentation** — README, serve guide, and instance-control
  ADRs updated for host-daemon launch, stale-agent states, and recovery; the
  reconnect session-survival caveat is now version-conditional (all session types
  survive on agentic-sandbox 2026.7.8+ agents).
- **Update command** — the CLI and docs now use `npm install -g aiwg@latest`
  instead of the unreliable `npm update -g aiwg` for stable-channel upgrades.
- **`aiwg doctor`** shares the `.gitignore` runtime-path check with the config
  helper so doctor and `aiwg config gitignore --fix` cannot drift.

### Fixed

- **OpenBao CI regressions** — the fetch helper's dry-run no longer requires `jq`
  (the check moved below the pure-awk dry-run branch), and keyfiles are written
  with a trailing newline so OpenSSH-consumed deploy keys are valid.
- **Windows index paths** — the artifact query engine normalizes backslash
  separators before resolving entry paths, so Windows-authored index entries
  resolve on POSIX.
- **`@$AIWG_ROOT/`-prefixed mentions** are now indexed as repo-relative paths, so
  framework skill→rule edges land in the graph index.
- **Container/VM agent recovery path** — the Bridge exposes
  `POST /api/instances/:id/reconnect`, tries executor-owned reconnect endpoints
  first, then falls back to `docker exec <container> agent-reconnect` (containers)
  or the qemu-guest-agent SIGHUP (VMs).
- **LFD resume and budget correctness** — resume restores analytics counters,
  budget-exhausted loops stay guarded, unobservable token/spend limits are
  surfaced rather than treated as zero, and completion-vs-budget stop semantics
  are explicit.
- **Ralph CLI drift** — `aiwg ralph` forwards the six documented LFD flags,
  rejects invalid values, and aligns documented defaults with runtime behavior.

## [2026.7.11] - 2026-07-06 - "Cockpit session stabilization"

This release supersedes `2026.7.10` so the stable tag includes the Cockpit
session-management fixes, docsite deploy timeout hardening, blog backfill, and
CI test-contract correction that landed after the npm tarball recovery tag.

### Added

- **2025 report blog backfill** — adds the August, September, October, and
  November 2025 AIWG report posts to the docs blog corpus.

### Fixed

- **Cockpit session startup and attach stability** — stabilizes host, Docker,
  and QEMU session startup by collapsing duplicate fallback rows, isolating PTY
  socket ownership, preserving control during row replay, bounding session-start
  waits, and starting host runtime sessions through the Bridge.
- **Docsite deploy timeout handling** — bounds docsite deploy SSH and rsync
  connection waits so failed deploy connectivity does not hang indefinitely.
- **Cockpit bridge CI contract** — updates the integration test to expect the
  host launch working directory now intentionally sent by session creation.

## [2026.7.10] - 2026-07-04 - "npm tarball recovery"

Supersedes `2026.7.9` after npmjs.org accepted package metadata and provenance
for the base `aiwg` package while its immutable tarball URL temporarily returned
404 during install checks. This reissues the same release payload with a fresh
package version and verified install target.

### Fixed

- **npmjs.org base package installability** — reissues `aiwg` with a fresh
  immutable package version after `2026.7.9` metadata initially pointed at a
  missing registry tarball object; `@aiwg/cockpit@2026.7.9` remained healthy.

## [2026.7.9] - 2026-07-04 - "Release manifest publish gate"

Supersedes `2026.7.8` after the GitHub npmjs.org publish workflow stopped in
the full test gate before publishing any npm artifacts. This release keeps the
Cockpit merged-console and issue-question workflow changes while relaxing a
stale release-manifest test that assumed the Fortemi preview announcement would
remain the newest release forever.

### Fixed

- **Release manifest regression test** — the Fortemi preview release-notes test
  now asserts that `v2026.7.1-announcement` remains listed in the release
  manifest, not that it is permanently the first entry.

## [2026.7.8] - 2026-07-04 - "Cockpit merged console and issue questions"

This release completes the current Cockpit merged-console slice and tightens the
address-issues workflow so unresolved issue questions remain findable from the
tracker label surface.

### Added

- **Cockpit merged console surfaces** — the Cockpit shell now exposes Bridge
  mission projection, unified event snapshots, telemetry, memory, missions, and
  apps/web compatibility surfaces for the merged operator-console workflow.
- **Issue question tracking label** — address-issues now creates or reuses a
  `question` label when filing unresolved questions in issue comments, then
  removes it once the question has been answered to satisfaction.

### Fixed

- **Pathless Cockpit smoke compatibility** — Cockpit smoke coverage now handles
  Fortemi discover results without filesystem paths by preserving result names
  and using a known release-flow skill path for the library clone check.

## [2026.7.7] - 2026-07-03 - "Pathless discovery package gate"

Supersedes `2026.7.6` after the first tag's npm publish workflow stopped at
the Fortemi Core prebuilt package gate. This release keeps the pathless
discovery and canonical capability index changes while aligning the release
gate with the new `show metadata` path contract.

### Fixed

- **Fortemi prebuilt package gate** — the release smoke test now validates
  pathless discover results by resolving each stable id through
  `aiwg show metadata`, then checking the indexed path from metadata.
- **npm publish follow-up guard** — the GitHub `@next` dist-tag step now waits
  for the publish and verification gates to succeed before trying to tag a
  version on npmjs.org.

## [2026.7.6] - 2026-07-03 - "Pathless discovery and canonical capability index"

This release tightens the AIWG discover/show workflow for agents: discovery
now returns stable capability identifiers instead of file paths, detailed path
metadata moves behind an explicit command, and the framework capability index
stops indexing provider/plugin mirror copies.

### Added

- **Discover metadata lookup** — `aiwg show metadata <id-or-name>` now emits
  the stable discover id, full path set, provenance, and Fortemi Core metadata
  for a discovered artifact.

### Changed

- **Pathless capability discovery** — `aiwg discover` CLI output now fronts a
  stable artifact identifier instead of filesystem paths. `aiwg show` resolves
  those identifiers first while preserving exact path lookup as a secondary,
  backward-compatible parameter.
- **Canonical capability indexing** — the framework capability graph no longer
  indexes provider/plugin mirror copies under `agentic/code/plugins`; discovery
  and Fortemi caches now index the canonical framework/addon/extension source
  set once.
- **Readable discovery text output** — `aiwg discover` now supports
  `--format json|text`, `--pretty`, and `--compact`, and renders default text
  results as numbered, multi-line blocks with explicit `show` follow-up
  commands.

## [2026.7.5] - 2026-07-03 - "Fortemi runtime dependency packaging"

Ships the Fortemi Core runtime dependency in the global npm package so the
default Fortemi-backed discovery path works immediately after install.

### Fixed

- **Fortemi Core runtime dependency** — `@fortemi/core` now ships as a runtime
  dependency, allowing global installs to run `aiwg discover` without manually
  installing `@fortemi/core` beside the CLI.
- **Production package smoke coverage** — the Fortemi prebuilt package gate now
  installs the packed tarball with development dependencies omitted and runs
  `aiwg discover "test"` from that install to catch missing runtime packages.

## [2026.7.4] - 2026-07-03 - "Fortemi discovery release alignment"

Supersedes `2026.7.3` as the artifact-aligned stable release after the first
tag push published `aiwg@2026.7.3` before `main` was rebased onto the latest
remote documentation commit. This release keeps the Fortemi capability
discovery parity fixes and restores package, tag, and `main` consistency.

### Fixed

- **Release artifact alignment** — publishes the Fortemi capability discovery
  parity fix from the current `main` lineage, including the latest Pagenary
  documentation dependency update already present on origin.

## [2026.7.3] - 2026-07-03 - "Fortemi capability discovery parity"

Restores the default AIWG capability discovery contract after the Fortemi Core
backend became the default search path. Framework skills, project-local custom
skills, and quickref-guided discover phrases now resolve through the Fortemi
static cache without requiring `--graph framework` or `--backend local`.

### Fixed

- **Framework capability discovery default** — `aiwg discover` and `aiwg show`
  now use the capability-default graph surface on the Fortemi backend, merging
  framework and project caches instead of searching only the project graph.
- **Canonical skill lookup** — bare `aiwg show skill doc-sync` and
  `aiwg show skill flow-release` resolve canonical framework source skills
  instead of returning ambiguity envelopes caused by plugin mirror copies.
- **Release-flow discoverability** — `flow-release` now declares `release flow`
  and related trigger phrases, and exact trigger matches rank above generic
  substring hits.
- **Project-local custom skill search** — project `.aiwg/skills/.../SKILL.md`
  capabilities are included in the default Fortemi discovery/show surface after
  the project graph is built and synced.

### Added

- **Real-corpus Fortemi parity tests** — the integration matrix now compares
  Fortemi default discovery against local framework discovery over the real AIWG
  corpus by ordered paths, not only idealized fixtures.
- **Project custom capability regression** — tests create a project-local custom
  skill and verify default Fortemi discovery/show can find it.
- **Quickref-guided UAT evidence** — live validation now checks curated
  quickref discover phrases across the core and framework quickref corpus.

### Follow-up

- Filed #1709 to design user/global `~/.aiwg` sidecar capability indices so
  personal custom skills can ride alongside framework and project caches without
  mutating AIWG's packaged framework index.

## [2026.7.2] - 2026-07-03 - "Fortemi Core package gate correction"

Reissues the Fortemi Core index migration preview after the `v2026.7.1`
publish workflow stopped before npm publication. The package contents were
clean, but the publish gate grepped lifecycle output and matched the prepack
log line for the generated local `.aiwg/.index/framework/` cache.

### Fixed

- **Structured `.aiwg/` package exclusion gate** — GitHub and Gitea publish
  workflows now verify `.aiwg/` exclusion from npm's structured
  `npm pack --dry-run --json` file list instead of scanning lifecycle logs.
  The integration test uses the same structured check so generated prepack
  diagnostics cannot produce a false positive.

## [2026.7.1] - 2026-07-03 - "Fortemi Core index migration preview"

Adds an opt-in Fortemi Core static-cache backend for AIWG project indexes while
preserving the existing local `.aiwg/.index` backend as the default and rollback
path. The migration preview targets the newly released
`@fortemi/core@2026.7.0` AIWG index surface without making Fortemi Core a
required runtime dependency for normal discovery/search commands.

### Added

- **Fortemi v2 export contract** — `aiwg index export --format fortemi
--schema-version v2` emits AIWG domain records with search projections, typed
  relationships, privacy locality, source-body chunks, and embedding metadata
  slots for the shared Fortemi semantic path.
- **Fortemi Core static cache preview** — `aiwg index sync --backend
fortemi-core` materializes `.aiwg/.index/fortemi-core/<graph>/` cache files
  that opt-in commands can read explicitly with `--backend fortemi-core`.
- **Valid empty-cache semantics** — a synced Fortemi Core cache with zero items
  is treated as a valid empty index: queries return empty result sets,
  discovery reports a Fortemi static-cache no-match hint, and `show` does not
  fall back to the local AIWG corpus when the backend is explicit.
- **Fortemi-backed query parity** — discovery/show, metadata query,
  fulltext/static semantic/hybrid query, dependency traversal, neighbor
  traversal, set operations, KB/research graph traversal, and `research-query`
  source selection now have no-regression parity fixtures.
- **Prebuilt framework discovery index** — npm packages now build and include
  `prebuilt/fortemi-core/framework/` through `prepack`, with a release gate that
  validates the matrix, tarball contents, manifest checksum, size ceiling, and
  packaged Fortemi Core fallback discovery. The packaged cache is a compact
  metadata/capability projection; source-body fulltext remains a local sync
  behavior.
- **Install-size budget rebased for prebuilt indices** — the package budget now
  accounts for the intentionally bundled Fortemi Core framework index that users
  previously had to build locally, while the Fortemi-specific gate still caps
  the prebuilt export.

### Changed

- **Research query command metadata** — provider command definitions now expose
  `research-query --save` with `Write` permission so command-surface metadata
  matches the CLI and skill documentation.
- **Fortemi boundary docs** — KB/memory storage routing, the Fortemi MCP storage
  backend, and local issue search now explicitly remain separate from the
  default Fortemi Core static index/search backend, with legacy local fallback
  selected through `--backend local`. Related tracker items #1551 and #1508 remain
  non-closing follow-ups for body-level embedding and the provider-neutral
  corpus-to-storage/index boundary; direct Fortemi REST import and
  hardcoded-token patterns stay out of scope.
- **Legacy rollback gate docs** — release and integration notes keep legacy
  backend removal gated on #1691 parity fixtures, valid-empty-cache behavior,
  and `--backend local` rollback evidence.
- **Legacy Fortemi storage wording** — storage docs now mark the `fortemi` MCP
  backend as persistence-only and deprecated for discovery/search routing; the
  Fortemi Core static cache is the documented search path.

### Documentation

- Added the Fortemi index export integration guide, Fortemi migration ADR,
  surface inventory, traceability matrix, completion gate audit, and release
  announcement for the preview.

## [2026.7.0] - 2026-07-01 - "MCP elicitation and native interaction routing"

Adds an MCP `ask-user` interaction tool that can emit protocol-native
elicitation requests when the client supports them, with a markdown fallback
for surfaces that do not. The provider capability matrix now records native
interactive-question support so AIWG can route human-in-the-loop prompts through
the best available UX per provider.

### Added

- **MCP `ask-user` tool** — emits MCP elicitation requests with structured
  schema support and falls back to markdown prompts when elicitation is
  unavailable.
- **Elicitation helper coverage** — unit tests cover protocol-native
  elicitation, markdown fallback behavior, and response normalization.
- **Native UX capability metadata** — provider capability data now advertises
  interactive-question support, with coverage for the native UX interaction
  mapping.

### Changed

- **Codex interaction guidance** — documents the `request_user_input`
  interactive-question mechanism and mode gating so AIWG routing can prefer the
  provider-native path when available.
- **Cockpit console topology ADR** — accepts the merged console topology
  direction for Cockpit session UX.

### Documentation

- Published the June 2026 AIWG progress report and updated the docs manifests.

## [2026.6.13] - 2026-06-30 - "Tiered rules — leaner startup context"

Lands enforcement-tiered rule deployment: rules now declare a canonical
enforcement level, and only CRITICAL/HIGH rules are inlined into each provider's
always-on context while MEDIUM/LOW rules become on-demand (reachable via
`aiwg show rule` and a generated `RULES-ONDEMAND.md` index). Combined with
compression of the largest always-on rule bodies, a full `aiwg use all` Claude
startup drops from ~193K to ~110K tokens — comfortably under the 120K working-
headroom target on the standard Sonnet window. Also extends the Cockpit session
workspace with a read-only observe terminal and persistent instance/session
navigation, and hardens executor enrollment.

### Added

- **Enforcement-tiered rule deployment (#1673)** — every rule now carries a
  canonical `enforcement:` frontmatter level (CRITICAL/HIGH/MEDIUM/LOW). Deploy
  inlines only the always-on CRITICAL/HIGH tier into each provider's rule
  directory; MEDIUM/LOW rules stay on-demand. A CI guard keeps the tiering
  honest. See `.aiwg/architecture/adr-rule-deployment-context-budget.md`.
- **`RULES-ONDEMAND.md` across all providers (#1675)** — the on-demand rule
  index (the MEDIUM/LOW tier, each fetchable via `aiwg show rule <name>`) now
  ships from every provider, not just Claude. File-based providers (codex,
  factory, cursor, copilot, opencode, windsurf, openclaw) write
  `RULES-ONDEMAND.md` into their rule directory; aggregated providers note the
  tier in their bridge file — warp in `WARP.md`, hermes/openhuman in `AGENTS.md`
  (via a `{{ON_DEMAND_RULES}}` template token).
- **Claude startup-context budget in `aiwg doctor` (#1672)** — doctor reports
  the aggregate context Claude Code inlines at session start versus the standard
  Sonnet window with an OK/WARN/OVER verdict. `npm run lint:claude-context --
--startup [--strict]` enforces the budget in CI.
- **Cockpit read-only observe terminal** — observe a running session's terminal
  output read-only, with auto-observe when a session is selected.
- **Cockpit persistent instances + sessions navigation (#1670)** — a persistent
  instances/sessions nav for the session workspace, refreshed on an interval.

### Changed

- **Compressed the largest always-on rule bodies (#1674)** — `anti-laziness`,
  `skill-discovery`, `subagent-scoping`, `rlm-context-management`,
  `cli-secondary`, `citation-policy`, `auto-compact-continue`,
  `provenance-tracking`, `failure-mitigation`, and others were trimmed of
  non-normative illustration (research-quote blocks, metrics dashboards,
  integration YAML, prompt-reinforcement galleries, ASCII diagrams) while
  preserving every FORBIDDEN/REQUIRED directive, rule statement, and enforcement
  level. Component `RULES-INDEX.md` summaries were tightened to one line.
  Detailed material remains reachable via `aiwg show rule`.

### Fixed

- **Protect `RULES-ONDEMAND.md` in rule-dir cleanup (#1675)** — the generated
  on-demand index is now guarded from pruning, symmetric with `RULES-INDEX.md`.
- **Cockpit executor enrollment hardening (#1669, #1670, #1671)** — the executor
  binds to `0.0.0.0` in `cockpit-up` so Docker agents can enroll; the vsock CID
  registry auto-heals before executor start (agentic-sandbox #595); longer
  session-ready wait with all-tier executor wiring; interactive attach retries
  through the PTY-readiness window; the attach URL is built from the instance id
  rather than the resolved agent name.
- **Cockpit session-list robustness** — session lists are de-duplicated by id
  (executor double-registration), ws error/close handling is de-duplicated and a
  keyframe is requested on re-attach, unique instance names per launch avoid
  docker/VM agent-id collisions, and stale stopped-Docker rows are destroyable.

### Documentation

- Reconciled `docs/how-it-works.md` rule-loading sections with the tiered model:
  always-loaded = CRITICAL/HIGH (inlined); on-demand = MEDIUM/LOW (indexed in
  `RULES-ONDEMAND.md`, fetched via `aiwg show rule <name>`).

## [2026.6.12] - 2026-06-28 - "Cockpit VM sessions over vsock"

Validates the Cockpit live VM session path end to end against the
agentic-sandbox vsock transport line, adds a launcher that brings the executor
and Cockpit up together, hardens stale-instance handling, and fixes two
artifact-index edge cases.

### Added

- **`cockpit-up` launcher (#1657)** — `npm run cockpit:up` (and
  `apps/cockpit/scripts/cockpit-up.sh`) ensures both halves of the stack are
  running: it health-checks the agentic-sandbox executor, starts the latest
  sandbox via its `management/dev.sh` if it is down, then brings up the Cockpit
  Bridge and web UI. `--rebuild` forces a fresh web build.
- **`acquire → induct-media` handoff contract (media-curator, research)** — the
  media-curator acquisition flow now emits an explicit, validated handoff to the
  research `induct-media` step so acquired media flows into the research corpus
  without a manual bridge.

### Fixed

- **Cockpit live VM sessions validated over vsock (#561, #1659)** — re-ran the
  Cockpit live matrix against the agentic-sandbox vsock transport line
  (`v2026.6.31`–`v2026.6.34`). The VM target now provisions, enrolls over vsock,
  reaches boot-ready, runs the provider workload, and tears down cleanly — the
  path that previously hung at `bootstrap-pending`. Local evidence output:
  `.aiwg/testing/outputs/cockpit-vm-vsock-2026-06-27.md/.json`.
- **Cockpit treats a stale destroy 404 as already-gone (#1660)** — destroying an
  instance the executor has already reaped no longer surfaces a raw 404; the
  Bridge maps it to an `already_gone` result and refreshes inventory.
- **Artifact index: prefer canonical agents over persona mirrors** — index
  builds now resolve the canonical agent definition rather than a persona mirror
  when both exist, preventing duplicate/incorrect agent records.
- **Artifact index: handle missing graphs in `index build` all-graph mode** — a
  missing graph no longer aborts an all-graph index build.

### Documentation

- Refreshed the Cockpit README agentic-sandbox compatibility notes to record the
  `v2026.6.34` container and VM matrix re-validation.
- Added explicit `aiwg discover` triggers to the media-curator
  `transcribe-media` skill.
- Refreshed the deployed-agent count in `AGENTS.md` to 198.

## [2026.6.11] - 2026-06-23 - "Tiered provider-context bridge"

Shrinks default agent startup context with a tiered provider-context model,
validates the Cockpit live-VM Bridge path end to end, and adds a docsite
Docs Map.

### Added

- **Tiered provider-context bridge (#1651, #1652)** - Generated provider
  bridges (`AGENTS.md` and its provider twins) now render deployed
  capabilities as a Tier 2 quickref capability map instead of a long-form
  deployed-artifact index. Default agent startup context stays small - 93%
  smaller on a 1,000-artifact fixture (106 KiB to 7.4 KiB) - while full Tier 3
  bodies remain reachable through `aiwg discover` / `aiwg show`. A new bridge
  size guard (`tools/lint/context-size-guard.mjs`, `npm run lint:context-sizes`)
  enforces an 8 KiB ceiling on the always-loaded bridge. See
  `docs/context-tier-model.md` and `docs/context-tier-pilot-report.md`.

### Fixed

- **Cockpit live VM matrix provisions through the Bridge (#1658)** - The
  Cockpit live UAT matrix had been posting VM provision requests straight to
  the executor, bypassing the Bridge's SSH-key injection for qemu launches, so
  the VM target failed with "No SSH public key found". Provisioning now routes
  through the Bridge, validating the agentic-sandbox v2 `ssh_key` passthrough
  end to end against a current executor.

### Changed

- **Cockpit Bridge development** - OS-keychain token handshake in shell-core,
  a live host/container/vm UAT matrix, mock-executor A2A parity, and a more
  resilient web UI. (`apps/cockpit` is excluded from the published npm package.)
- **Docsite Docs Map** - Override styling for the pagenary-rendered Docs Map
  (SVG sizing and on-hover node labels).

## [2026.6.10] - 2026-06-22 - "Docsite-clean media research release"

Recovery cut for the `2026.6.9` release line. The `2026.6.9` package reached
the Gitea npm registry before the release tag was corrected, so this patch
release republishes the media/research feature set from the corrected commit
with strict docsite links fixed.

### Fixed

- **Docsite strict-link build is green again** - Agent-loop and LLM Wiki docs
  now use repository URLs for source-tree-only references instead of generated
  docsite-relative links that do not exist in `docs/`.
- **Release tag now points at the corrected source** - `v2026.6.10` includes the
  type-flexible Media Curator work, Research Complete media REF support, and the
  docsite-link repair in one signed release commit.

### Upgrade notes

- **Prefer `2026.6.10` over `2026.6.9`.** The feature surface is the same, but
  `2026.6.10` includes the docsite-link repair in the published package.

## [2026.6.9] - 2026-06-22 - "Type-flexible media curation + research media REF support"

Feature cut for media collections that are not purely music libraries. Media
Curator now starts unknown and mixed collections with an assess-and-plan path,
and Research Complete can induct time-based media into REF artifacts with
timestamp citations.

### Added

- **Type-flexible media routing** - Media Curator documents a generic
  assess-and-plan entry point for arbitrary or mixed media collections before
  selecting discography, acquisition, transcript, tagging, export, or research
  handoff paths.
- **Research media induction** - Research Complete adds an `induct-media` skill
  and `reference-media.md` template for talks, lectures, podcasts, interviews,
  videos, and other time-based sources.
- **Timestamp citation contract** - Citation sidecars, citation guard guidance,
  and source-type metadata now cover media REF artifacts, transcript segment
  hashes, and exact timestamped quotes.
- **Media-curator to research handoff docs** - The integration guide now
  covers acquisition, transcript sidecars, storage policy, and downstream REF
  outputs for time-based media.

### Changed

- **Media Curator docs are no longer music-first only** - Framework overview,
  quickref, and curate skill guidance make music/discography handling a selected
  route rather than the default for every media request.
- **Research source types include audio/video/media** - Source taxonomy and
  tests now recognize time-based media with transcript-aware citation metadata.
- **Doc-sync includes skills and agents as code** - The release doc-sync audit
  treats `agentic/code/**` and repository Markdown as the code-to-doc source of
  truth, then republishes generated component docs.

### Fixed

- **Provider-specific generated guidance is not a substitute for source sync** -
  Filed the Devin/Windsurf provider-copying follow-up as issue #1650 instead
  of manually syncing quickrefs.

### Upgrade notes

- **No action required.** Existing media-curator and research workflows continue
  to work. New `/curate`, `/transcribe-media`, and `/induct-media` guidance is
  available after redeploying the relevant frameworks.

## [2026.6.8] - 2026-06-21 — "@aiwg/cockpit npm README polish"

Maintenance cut to refresh the `@aiwg/cockpit` npm package page after the
trusted-publishing path was validated.

### Changed

- **Cockpit README now matches the npm-facing AIWG style** — the package README
  opens with a centered product block, npm/source badges, quick install commands,
  clear "what it is / what it is not" positioning, troubleshooting, and an
  operator-focused feature summary before the existing architecture and
  validation details.
- **Install guidance points at the supported AIWG path first** — `aiwg use
cockpit` is documented as the recommended install because it keeps
  `@aiwg/cockpit` outside the base footprint while version-locking it to the base
  `aiwg` CLI. Direct `npm i -g @aiwg/cockpit` remains documented for package
  testing.

### Upgrade notes

- **No action required.** Documentation/package-page release; no CLI behavior
  changes.

## [2026.6.7] - 2026-06-21 — "@aiwg/cockpit provenance metadata"

Maintenance cut to validate the new `@aiwg/cockpit` npm trusted-publishing leg
after npm rejected 2026.6.6 with a provenance repository mismatch.

### Fixed

- **`@aiwg/cockpit` declares repository metadata for npm provenance** — the
  package now publishes with `repository.url: https://github.com/jmagly/aiwg`
  and `repository.directory: apps/cockpit`, matching the GitHub Actions source
  identity in the Sigstore provenance bundle while still pointing consumers at
  the subpackage location.
- **Cockpit publishability guard covers provenance metadata** — the
  `cockpit-base-footprint` smoke test now asserts the scoped package's
  repository metadata, so the next missing/empty `repository.url` fails before
  the release tag is pushed.
- **Cockpit lockfile root version is back in lockstep** — the cockpit lockfile
  root metadata now matches the release version.

### Upgrade notes

- **No action required.** Release-pipeline/package-metadata validation cut; no
  CLI behavior changes.

## [2026.6.6] - 2026-06-21 — "Release-pipeline hardening, cont."

Follow-on hardening surfaced while validating 2026.6.5's GitHub-mirror fix.

### Fixed

- **GitHub mirror tag-push is idempotent** — `github-mirror.yml` now tolerates
  an already-existing tag on the mirror (matching the main-push guard), so a
  workflow re-run — or a manual push that races the workflow — proceeds to
  GitHub Release creation instead of failing on "tag already exists."
- **Docsite strict-link build** — the v2026.6.4 and v2026.6.5 announcements
  linked the CHANGELOG via a relative path that resolved outside the docs tree
  and failed the docsite's strict-link check. They now use the absolute GitHub
  URL like every prior announcement.

### Changed

- **Release runbook** — `CLAUDE.md` / `AIWG.md` step 8 no longer instructs a
  manual `git push github`: the Gitea tag push (step 7) triggers the mirror
  workflow, which pushes `main` + the tag to GitHub and creates the Release
  itself. The manual push raced that and is now documented as not-to-do.

### Upgrade notes

- **No action required.** Tooling/release-process release; no CLI changes.

## [2026.6.5] - 2026-06-21 — "Release-pipeline hardening"

A pipeline-fix cut. Two gaps surfaced while cutting 2026.6.4 are closed so
releases publish cleanly and the GitHub mirror actually creates Release pages.

### Fixed

- **`cut-tag.sh` now gates `package-lock.json` version lockstep** (new pre-tag
  check 5/12). The 2026.6.4 prep bumped `package.json`, `marketplace.json`, and
  `apps/cockpit` but not the lockfile, so CI's `check:versions` / `npm ci`
  failed _after_ the tag was pushed and the npm publish never ran. The wrapper
  now catches a stale lockfile before tagging.
- **GitHub mirror creates Release pages again** — `github-mirror.yml` checked
  `secrets.GH_TOKEN`, but the configured Gitea Actions secret is
  `GH_ACCESS_TOKEN`. The name mismatch made the mirror silently skip GitHub
  Release creation (while reporting success) for v2026.6.2, v2026.6.3, and
  v2026.6.4. It now reads `GH_ACCESS_TOKEN`, so stable tags get their GitHub
  Release automatically.

### Upgrade notes

- **No action required.** Maintenance release; no API or CLI surface changes.

## [2026.6.4] - 2026-06-21 — "Project-local deploy parity + safer `aiwg remove`"

A correctness cut. Project-local extension/addon bundles now deploy to **every**
provider the same way they always did for Claude, `aiwg remove` fails cleanly
instead of crashing, and the kernel-skill prune can no longer wipe your skills
directory when it can't find the AIWG root. Plus the npm-publish pipeline is
hardened so a single failing step no longer strands the `@next` channel.

### Why this matters to users

| What changed                                                          | What it gives you                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project-local bundles deploy to Factory & Codex**                   | A `.aiwg/extensions/<id>/` bundle with `agents/` or `rules/` now lands in `.factory/droids` + `.factory/rules` and `.codex/agents` + `.codex/rules`, not just `.claude/`. Previously Factory and Codex silently deployed 0 agents and 0 rules from project-local bundles. (#124)              |
| **`AIWG_ROOT` is no longer required for project-local agent bundles** | Deploying an agent-shadowing bundle without `AIWG_ROOT` set no longer empties your provider's kernel skill directory (e.g. `.claude/skills/`). The CLI injects the root automatically, and the prune now skips rather than deleting everything when the root can't be resolved. (#123)        |
| **`aiwg remove` fails cleanly**                                       | `aiwg remove all --provider X` and `aiwg remove <unknown-id>` no longer crash with a `path argument must be of type string` TypeError. Unknown flags on the upstream path are rejected with a clear message (exit 2); an unknown id reports `Plugin '<id>' is not installed` (exit 1). (#118) |
| **`@next` channel can't be stranded by one bad step**                 | The npm-publish workflow advances `@next` even when an earlier publish step fails, so a partial failure no longer leaves the prerelease channel behind.                                                                                                                                       |

### Fixed

- **Project-local bundles deploy on Factory and Codex (#124)** — `factory.mjs` and `codex.mjs` gained the same `isAddonSource` short-circuit `claude.mjs` already had, so bundle `agents/`/`rules/` deploy to the provider's paths instead of being skipped.
- **Kernel-skill prune is null-safe (#123)** — `computeAllKernelNames` now returns `null` (and validates a stale `AIWG_ROOT`) when no `agentic/code/{frameworks,addons}` tree is locatable, and `pruneStaleAiwgSkills` skips on `null` rather than treating an empty set as "delete every AIWG skill." The `use` CLI also injects `AIWG_ROOT` into the project-local deploy subprocess. `hermes.mjs` guards the null before spreading.
- **`aiwg remove` no longer crashes (#118)** — the plugin-uninstaller CLI constructed the uninstaller with an options object where an `aiwgRoot` string was expected (the source of the TypeError), never forwarded its options to `uninstall()`, and read non-existent result fields. It now uses `createUninstaller()`, forwards `{ force, dryRun, keepProjects }`, reports from `result.errors`/`result.stats`, and rejects unknown flags before doing any work.

### Changed

- **npm-publish hardening (CI)** — advance `@next` even when an earlier publish step fails; publish `@aiwg/cockpit` from `./apps/cockpit` rather than `npm --prefix`; scope the Gitea publish workflow to the Gitea npm registry only.

### Docs

- **Versioning runbook** — added package-ownership + npm-registry runbook to `docs/contributing/versioning.md`.
- **`aiwg remove` reference** — clarified that `--provider`/`--keep-registry` apply only to the project-local revert path, that the upstream uninstaller rejects unknown flags (exit 2), and that an unknown id reports a clean "not installed" error.

### Upgrade notes

- **No action required.** If you previously set `AIWG_ROOT` solely to protect your kernel skills directory when deploying project-local agent bundles, that workaround is no longer necessary (it remains honored if set).

## [2026.6.3] - 2026-06-20 — "Cockpit groundwork → usable operator surface (real-executor proof)"

June's closing cut turns the AIWG Cockpit from beta substrate into a control
plane an operator can actually drive against a **real** agentic-sandbox. The
running board is derived from real A2A tasks, starting a session is a single
explicit picker, the attach view renders a true terminal, and the whole stack
comes up with one command. None of this changes the base `npm i -g aiwg`
footprint — Cockpit remains the opt-in `@aiwg/cockpit` package.

### Why this matters to users

| What changed                                  | What it gives you                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cockpit is usable against real executors**  | The running board derives from real A2A tasks (#1639); Home stays usable against a real v2 executor and degrades the running/approvals panes instead of collapsing to "No stack connected" (#1638). The Bridge defaults off the executor port range and refuses reserved-port collisions.                                                                                                                  |
| **Starting a session is one explicit picker** | A session-start modal (#1640, #1641) is the single home for both the dashboard verb and the Sessions tab: pick instance · runtime · loadout · backend · posture, confirm, attach. It surfaces the **full** loadout catalog via a new Bridge `/api/loadouts` passthrough, guards against silently replacing an attached session, and shows failures inline — no more param-less start that read as a no-op. |
| **The attach view is a real terminal**        | The Sessions pane renders the PTY through xterm.js, so ANSI/VT/tmux redraws are interpreted, not dumped as raw escape bytes.                                                                                                                                                                                                                                                                               |
| **One command brings up the whole stack**     | A canonical one-command dev bring-up harness replaces the ad-hoc `/tmp` rigs, with documented test stages and a contract guard that pins the mock's admin surface to the real v2 divergence.                                                                                                                                                                                                               |
| **Capability injection + lookup are correct** | Picking a skill injects its plain name (discover-first resolves it), not a `/`-prefixed pseudo-command (#1642); `/api/show` resolves by the discovered path so same-named artifacts (e.g. two `aiwg-steward`) no longer 502 — ambiguity is a 4xx now (#1643).                                                                                                                                              |

### Added

- **Cockpit running board from real A2A tasks (#1639, running half)** — the board is derived from the executor's real task surface, not a mock.
- **Session-start picker modal (#1640, #1641)** — instance/runtime/loadout/backend/posture, the single home for both start paths; clobber guard + inline errors.
- **Bridge `/api/loadouts` passthrough (#1641)** — proxies the executor loadout catalog (`/api/v1/loadouts`, v2 `/loadouts`), normalized to `{id,label,description,runtimes}`, so the picker offers the full set rather than echoing the instance's own loadout.
- **One-command dev bring-up harness** — replaces the `/tmp` rigs; plus a dev-stage full-system e2e harness with documented test stages and a mock↔real contract guard.

### Changed

- **Running vs Sessions made legible (#1644)** — each panel opens with a one-line purpose statement (Running = fleet overview board; Sessions = attached workspace) and names the relationship.
- **Release pattern + config-defaults gate formalized** for `@aiwg/cockpit` (sane tested defaults, packaging discipline).

### Fixed

- **Cockpit attach renders via xterm.js**, not raw bytes — escape sequences are interpreted (colors, tmux redraws, titles, bracketed paste).
- **Cockpit Home degrades gracefully** against real v2 executors instead of collapsing to "No stack connected" (#1638); running/approvals panes degrade independently.
- **Bridge port hygiene** — defaults off the executor port range and refuses reserved-port collisions.
- **Capability injection** uses the plain skill name, not a `/` prefix (#1642).
- **`/api/show` resolves by discovered path**; ambiguous same-named artifacts return a 4xx with disambiguation text instead of a 502 (#1643, bridge half — the persona-vs-agent indexing dedup is tracked separately).
- **Deploy-adjacent tests hardened** against `/tmp` and untracked scratch.

### Docs

- **ADR: Cockpit chat-style agent view + output-parsing model (#1645)** — a per-session Terminal↔Chat toggle over the existing observer-default attach, a normalized `ChatEvent` contract, structured-stream-preferred / PTY-parser-fallback sourcing, first-in-scope Claude Code.
- **LFD control-patterns research spike (#1585)** captured under research-planning.
- **Docsite on Pagenary 6.13** — upgraded `@pagenary/publisher` to the self-minifying 6.13 line (roctinam/pagenary#14); dropped the redundant `terser` devDependency; fixed 3 broken doc links so the strict-link validation build passes.
- **Docs Map enabled on docs.aiwg.io** — Pagenary's concept-derived relationship graph (444 nodes / 1,683 edges) is now a navigable view (#33).
- **Refreshed docs.aiwg.io welcome copy** — accurate counts: 200+ agents, 8 frameworks, 29 addons, 11 platforms.

### Upgrade notes

- **No action required.** Cockpit is the opt-in `@aiwg/cockpit` package; the base CLI footprint is unchanged.

## [2026.6.2] - 2026-06-18 — "Cockpit live-proof hardening"

This patch release tightens the AIWG Cockpit live UAT gate so release evidence
must prove a real agentic framework can start inside an agentic-sandbox session
and use AIWG discovery from there.

### Changed

- **Cockpit live matrix proof is stricter.** Provider workloads now must emit
  both `AIWG_COCKPIT_LIVE_OK` and an expected AIWG discovery result
  (`issue-audit` by default). The default prompt asks the running provider to
  use AIWG discovery to choose the capability for auditing open issue state and
  release blockers.
- **Codex live workload command updated.** Cockpit now invokes Codex with
  `codex exec -s read-only`, matching the currently supported Codex CLI syntax.
- **Docs synced from code.** Ran `docs:collect` to publish the current
  code-to-docs component corpus and generated docs manifest.

### Fixed

- Cockpit live reports now record the discovery expectation and fail when the
  provider only proves shell plumbing instead of real AIWG discovery.

### Upgrade notes

- No migration is required.
- The 2026-06-18 host proof passed with Codex in a managed agentic-sandbox
  `tmux` session. Claude launched in the same session but required login, so
  Claude auth-state injection remains a separate follow-up.

## [2026.6.1] - 2026-06-15 — "AIWG Cockpit groundwork (beta), leaner agents & doc accuracy"

A consolidation release on top of 2026.6.0. The headline is the **AIWG Cockpit** — a UX-first control plane over an AIWG install and multi-stack agentic sessions — landing as **beta groundwork**: the registry-bound core, instance-control bridge, Tauri + VS Code shells, local control-surface auth, and the UI contribution model are all in place, with the full operator UX arriving in a later release. Alongside it: the bulk **declarative-Flow migration** and the **cross-stack Mission conductor** are now complete, a fleet-wide **agent-definition debloat** brings every agent under the 16 KB dispatch ceiling, and a **documentation-accuracy pass** reconciles every skill/agent count against source.

### Why this matters to users

| What changed                                                    | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AIWG Cockpit — beta groundwork**                              | The foundation of a UX-first control plane is in place behind an opt-in `@aiwg/cockpit` package: a data-driven core bound to the extension/discover/index registry, instance control over the agentic-sandbox interface, parallel **Tauri desktop + VS Code** shells over one shared core, a declarative **UI contribution model** (screens/actions/workflows/hooks), local control-surface auth (`127.0.0.1` + per-launch token + OS-keychain), and live capability/index refresh without restart. The full operator UX is still in construction (epic #1588) — this release ships the substrate, not the finished surface. |
| **Declarative Flows + cross-stack Missions are complete**       | The bulk `flow-*` → `flow.aiwg.io/v1` migration (#1539) and the cross-stack **Mission conductor** with per-stack executor adapters (#1546) — previewed in 2026.6.0 — are now fully landed. One Mission conductor fans heterogeneous workers across stacks over the `runtime:<name>` convention.                                                                                                                                                                                                                                                                                                                              |
| **Leaner agents — every definition under the dispatch ceiling** | A repo-wide debloat (#1587, #1600) externalizes worked examples and restated rule boilerplate out of agent definitions and adds a hard 16 KB size ceiling enforced by `aiwg doctor`. Oversized definitions were silently failing subagent dispatch with `Prompt is too long` at 0 tokens; every shipped agent is now under the ceiling.                                                                                                                                                                                                                                                                                      |
| **Docs match the code**                                         | A `doc-sync code-to-docs` pass reconciled every skill/agent count across the docs against on-disk source — kernel skills 16/19→**20**, addons 27/28→**29**, per-framework skill/agent counts corrected (research 20→39, security-engineering 7→27, sdlc agents 90/220→93), and three doc-to-doc contradictions resolved.                                                                                                                                                                                                                                                                                                     |
| **Safer context-file regeneration**                             | `aiwg regenerate` now additively installs the `@AIWG.md` hook into operator-owned provider files without clobbering them (#1597, #1579), and `aiwg doctor` flags drift on non-managed twin files.                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Added

- **AIWG Cockpit (beta groundwork) — epic #1588.** Opt-in `@aiwg/cockpit` umbrella package with a base-footprint CI guard (#1593); registry/discover/index-bound data-driven core + Explore (#1592); instance control bound to the agentic-sandbox A2A interface; live session view + running-agents board; local control-surface auth — `127.0.0.1` + Origin + CSRF + per-launch token + OS-keychain handshake (#1595); declarative UI contribution model — screens/actions/workflows/event-hooks (#1591); multi-stack management + approval inbox; parallel **Tauri desktop + VS Code** shells over one registry-bound core (#1594); React + Vite web app; user asset library (clone/import to disk, AIWG sources never overwritten); guided first-run onboarding; rendered-DOM a11y suite + CI integration; Iteration-1 risk-gate PoCs closing the ABM gate (#1590). Full intake→elaboration SDLC track authored under `.aiwg/` (`cockpit-*` / `UC-COCKPIT-*` / `adr-cockpit-*`). Construction continues in a later release.
- **Cross-stack Mission conductor** with per-stack executor adapters (#1546) — completes the Missions surface previewed in 2026.6.0.
- **`release-publication-verify` skill (#1599)** — post-tag release-proof verifier that confirms a tag actually published (npm dist-tag, Gitea/GitHub release artifacts).
- **`aiwg-steward` "Built With AIWG" badge (#1596)** — steward can add a discreet attribution badge to a project README on request.
- **Agent-definition 16 KB size ceiling** enforced by `aiwg doctor` (#1587), with a locked regression test.

### Changed

- **Declarative-Flow migration completed.** The remaining `flow-*` skills are now `flow.aiwg.io/v1` Flows (#1539), discoverable via `aiwg discover` and runnable as orchestration.
- **Fleet-wide agent debloat (#1587, #1600).** Worked examples and restated protocol boilerplate moved out of agent definitions into the discoverable example catalog; `aiwg-steward` reconciled across its dual sources; `rlm-agent` and several SDLC/forensics/marketing/media-curator agents trimmed under the ceiling. Few-shot coverage is preserved via the catalog (anchor-inline + referenced examples).
- **Documentation accuracy.** Skill/agent counts reconciled to source across `cli-reference.md`, `discovery-and-kernel-skills.md`, `architecture-overview.md`, `skills-budget-guide.md`, `how-it-works.md`, the kernel quickrefs, and `CLAUDE.md`/`AIWG.md`. Hermes top-level kernel documented as the global 20-skill set (was a stale "~9"). Release announcements and dated blog posts left as immutable historical records.
- **`package-all-plugins`** scoped to plugin packaging so native-release discovery routes correctly (#1598).
- **Docs site.** Landing + overview reflect all 11 providers (#12997af0); README gains an AIWG hero masthead + badges section; 2026.6.0 blog roundup + "where things are" retrospective ported into the docbase with provenance disclosure.

### Fixed

- **`aiwg regenerate`** additively installs the `@AIWG.md` hook into operator-owned provider files instead of overwriting them (#1597, #1579); a loud warning + `aiwg doctor` drift check covers non-managed twin files (#1579).
- **`aiwg use`** deploys kernel self-maintenance skills as bootstrap slash commands on Claude/Cursor (193547fc); `aiwg-steward` orchestration/loop routing restored inline (#1600).
- **Cockpit:** actions inject into agentic sessions rather than running the Bridge CLI; the React bundle no longer gets trapped in an HTML comment (Vite `</head>` gotcha).
- **Docsite deploy:** corrected the `~` home-path resolver against the remote `$HOME`.
- **OpenCode:** `--help` assertion covers stdout + stderr (opencode 1.17.x routes help to stderr).
- **Repo hygiene:** removed accidentally-committed `WARP.md` backup files.

### Upgrade notes

- **No action required.** All changes are additive or self-healing on the next `aiwg refresh` / `aiwg use`.
- **AIWG Cockpit is beta groundwork** — the opt-in `@aiwg/cockpit` package is not installed by `npm i -g aiwg`; the base CLI footprint is unchanged. The control-plane UX is still in construction (#1588); install it only to follow along with the foundation.

## [2026.6.0] - 2026-06-12 — "OpenHuman provider #11, declarative Flows & cross-stack Missions, research-corpus intelligence"

The June line opens with the biggest surface-area expansion in a while: AIWG inducts **OpenHuman (tinyhumansai)** as deployment provider #11, lands a **declarative YAML Flow** layer with **cross-stack Missions**, and turns the research framework into a genuine corpus-intelligence toolkit (semantic search, citation-graph densification, integrity scanning, vision extraction). Alongside the headline work is a broad round of cross-provider hardening (Cursor, OpenClaw, Warp, Codex, OpenCode) and a discovery layer that now reliably matches full natural-language questions.

### Why this matters to users

| What changed                                       | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenHuman is a first-class provider**            | `aiwg use <framework> --provider openhuman` deploys AIWG to [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) — an OSS personal-AI runtime. Kernel skills install **globally** to `~/.openhuman/skills/` (ungated user scope, the same root OpenHuman's own installer writes to), personas to the workspace `.agents/agents/` for the coding hosts OpenHuman drives, and commands/rules aggregate into an `AGENTS.md` bridge. Verified live: OpenHuman's agent harness scans the deployed `SKILL.md` bundles and event-bus-wires the triggered ones. |
| **Releases and CLI run on declarative Flows**      | `flow-release` (and `flow-architecture-evolution`) are now YAML Flows (`flow.aiwg.io/v1`) with an executor fan-out contract — discoverable directly via `aiwg discover`, runnable as orchestration with intra-step multi-agent panels + synthesis. The release gate sequence lives in `.aiwg/release.config`, so the skill body is portable across CalVer/SemVer projects.                                                                                                                                                                                             |
| **Cross-stack Missions**                           | One Mission conductor fans heterogeneous workers across stacks (e.g. a Claude session dispatching Codex subagents) over the `runtime:<name>` executor convention. `/aiwg-mission` ships AIWG-owned on Codex with no plugin dependency.                                                                                                                                                                                                                                                                                                                                 |
| **Research corpus became searchable + auditable**  | `aiwg index query --semantic` / `--fulltext` (BM25), `aiwg corpus integrity-scan` / `sidecar-lint` / `citation-backfill` / `extract-crossrefs`, provider-neutral scanned-page vision extraction, profile-graph edges + embedding similarity, and a by-source-type registry.                                                                                                                                                                                                                                                                                            |
| **Discovery matches how you actually ask**         | Full natural-language questions ("help me choose the right AIWG framework") now normalize to keyword phrases and match; single-content-token queries no longer dead-end; `discover` is the exclusive agentic-capability surface and induces discover-first on new directives, not just on decline.                                                                                                                                                                                                                                                                     |
| **Public-facing output points at the public repo** | The `aiwg use` version stamp, `aiwg diagnose` bug link, and the entrypoint packaging-bug message now read `github.com/jmagly/aiwg`, sourced from `package.json` (single source of truth) rather than the internal build origin.                                                                                                                                                                                                                                                                                                                                        |

### Added

- **OpenHuman provider induction (#11) — epic #1552.** Platform-enum wiring + `platform-paths.ts` + `PROVIDER_PATHS` (#1555); capability-matrix block + multi-platform doc tables (#1556); legacy deploy provider module (`tools/agents/providers/openhuman.mjs`) completing Tier-1 end-to-end; `aiwg regenerate` + `AGENTS.md` discover-first template (#1557); integration quickstart (#1558). Tier-2 native-harness TOML emission is tracked as opt-in future work (#1559).
- **Declarative YAML Flows.** `flow-release` converted to a `flow.aiwg.io/v1` Flow + wrapper skill (#1539); `workflow.aiwg.io/v1` docs classified as discoverable type `flow` and surfaced in default `aiwg discover` (#1540); wire-compatible Flow aliases (#1536); agentic fan-out step schema + ADR for intra-step multi-agent panel + synthesis (#1547); executor fan-out contract proven on `flow-architecture-evolution` (#1547); inventory/targets made optional for non-iterating Flows.
- **Cross-stack Missions.** Cross-stack dispatch proven on the `runtime:<name>` convention (#1546); AIWG-owned `/aiwg-mission` orchestration command shipped on Codex with no plugin dependency (#1544); steward orchestration/loop routing surface (#1538); external/orchestration loop routing aligned with provider `/workflow` (#1537, #1538).
- **Research corpus intelligence.** Semantic search — embed / `query --semantic` / `similar` / `dedup-report` (#1493); `--fulltext` BM25 lexical body search (#1494); cross-project by-project + project-impact index views (#1495); provider-neutral scanned-page vision extraction (#1507); profile graph edges + embedding similarity (#1501); per-type induction depth audit + frontmatter backfill (#1504); extensible source-type registry + by-source-type view (#1509); corpus integrity / submission-risk scan (#1506); citation-graph densification — `extract-crossrefs` + `citation-backfill` (#1505); sidecar lint & metadata repair (#1503).
- **Fortemi index export.** `aiwg index export --format fortemi --graph project --out <file>` emits a browser-consumable, schema-validated project index for Fortemi React integrations. See `docs/integrations/fortemi-index-export.md`.
- **Security-engineering.** `cargo-supply-chain-audit` skill + discovery routing (#1479).
- **OpenClaw.** AIWG Steward identity injected into `SOUL.md`.

### Changed

- **User-facing CLI URLs are config-driven from `package.json`.** `getVersionInfo()` now exposes `repoUrl` / `homepage` / `issuesUrl`; the version stamp, diagnose bug link, and entrypoint message read from it — at release the version bump is the only edit, and the internal build origin never leaks into user output.
- **`discover` is the exclusive agentic-capability surface (Closes #1545)** and auto-builds the framework index from `$AIWG_ROOT` so deployed commands are findable from user projects (#1541); default discover types include Flows (#1540).
- **`address-issues` is skill-only** — the local-only CLI was removed; the command doc routes to the skill.
- **OpenCode** loads `AIWG.md` directive classification via `instructions[]` and wires deployed rules into `opencode.json` (#1542, #1548); deploys `address-issues` + `issue-audit` as commands (#1549).
- **Codex** ships AIWG-owned `/aiwg-mission` and loads `AIWG.md` via `instructions[]` (#1542, #1544).
- **`@pagenary/publisher`** docsite deploy modernized; agentic-sandbox publishes as a docs tenant at `docs.aiwg.io/agentic-sandbox`, cross-linked from the serve/daemon guides.

### Fixed

- **OpenHuman skills install globally** to `~/.openhuman/skills/` like OpenClaw (was project-scope/trust-gated, leaving the Skills library empty) — `6d64b7ac`, #1553; emit the `AGENTS.md` bridge (#1560); capability-matrix reconciled + process-tree detection parity for `openhuman`.
- **Discovery natural-language matching (#1581):** normalize full-sentence queries to keyword phrases, match single-content-token queries, and a relaxed-overlap fallback for verbose questions.
- **Cursor:** emit rules as native `.mdc` (not `.md`); `cleanupOldRuleFiles` stays `.md`-only to preserve operator `.mdc`.
- **OpenClaw:** commands are aggregated (not native slash commands); discover-first bridge + scope default + skills count delivered.
- **Warp:** `WARP.md` regenerated as a lean discover-first managed bridge (was a 17.5k-line aggregate).
- **AGENTS.md** bridge updates in place via managed markers.
- **`aiwg doctor`** discovery check is global-context-aware (no false index warning); `aiwg list` detects deployed providers instead of hardcoding `.claude/` (#1530); Codex skills deploy to `.agents/skills/` only, ending duplicate slash commands (#1531).
- **CLI output** points at the public `github.com/jmagly/aiwg` (was the internal Gitea origin).

### Upgrade notes

- **OpenHuman operators:** `aiwg use sdlc --provider openhuman` now installs kernel skills to `~/.openhuman/skills/` (global). They're loaded by OpenHuman's agent harness immediately. Note: the BETA "Skills Explorer → Installed" tab reads `~/.openhuman/workflows/`, not `skills/`, so skills won't render there yet — an upstream OpenHuman limitation, not an AIWG deploy issue (tracked in #1560).
- **No action required** for existing providers — all changes are additive or self-healing on the next `aiwg refresh` / `aiwg use`.

## [2026.5.13] - 2026-05-29 — "Deploy-scope fix and stale hook-path heal"

Two deploy-path regressions surfaced after the 2026.5.x stable line: every `aiwg use` was scaffolding a duplicated workspace layout that immediately tripped the legacy detector, and every upgrade from a pre-`be3ee551` install left stale `.js` hook command paths in `.claude/settings.json` that crashed Claude Code's SessionStart hook with `MODULE_NOT_FOUND`. Both are fixed here, along with the `@pagenary/publisher 2026.5.4` adoption that was queued in Unreleased.

### Why this matters to users

| What changed                                                               | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fresh `aiwg use` no longer reports `migration: partial`**                | The six non-SDLC framework manifests (`forensics-complete`, `knowledge-base`, `media-curator`, `media-marketing-kit`, `research-complete`, `security-engineering`) now declare their `memory.creates` scaffolding under the scoped `.aiwg/frameworks/<id>/...` location instead of a parallel top-level `.aiwg/<name>/...` tree. SDLC's documented top-level artifact dirs (`.aiwg/requirements/`, `.aiwg/architecture/`, …) are unchanged. The two divergent `isLegacy` detectors converge on one definition: SDLC top-level + `.aiwg/frameworks/` = intended SDLC layout (not partial); orphan non-SDLC top-level dirs left over from pre-#1516 installs still register so the migration prompt fires once. (Closes #1516.) |
| **`aiwg refresh` heals stale `.js` hook paths in `.claude/settings.json`** | The Claude hooks installer's idempotency check matched by `_aiwg_id` only, so once `aiwg-{session,trace,permissions}.js` was registered in `settings.json` (pre-`be3ee551`, May 10), later refreshes skipped the upgrade and left Claude Code invoking `node .claude/hooks/aiwg-session.js` against a file that no longer exists. The installer now rewrites the `command`, `type`, and `_aiwg_managed` fields on existing AIWG-managed entries when they're out of date and surfaces the rewrite in `result.warnings` so refresh CLI users see what changed. Eliminates the `SessionStart:startup hook error → MODULE_NOT_FOUND at node:internal/modules/cjs/loader:1459` reported on Claude Code 2.1.157.                   |
| **`@pagenary/publisher` bumped `^2026.5.3` → `^2026.5.4`**                 | Picks up the page-renderer frontmatter strip (pagenary#19) — collection blog posts no longer render their YAML frontmatter as visible text above the title on docs.aiwg.io. The collection manifest is unchanged. Adopted via the documented `npm install --min-release-age=0` first-party override per `docs/contributing/versioning.md`. `docs/contributing/publishing-blog-posts.md` updated to drop the now-stale frontmatter-leak caveat.                                                                                                                                                                                                                                                                                |

### Fixed

- **`aiwg use` no longer scaffolds duplicated legacy + scoped workspace layouts (Closes #1516).** Each fresh deploy was creating `.aiwg/forensics/`, `.aiwg/kb/`, `.aiwg/media/`, `.aiwg/marketing/`, `.aiwg/research/`, `.aiwg/security-engineering/` AND the scoped `.aiwg/frameworks/<id>/...` equivalents, then `aiwg status --probe` surfaced `migration.status: "partial"` because the SDLC legacy-dir detector also fired on the canonical SDLC layout that the same deploy emits. Memory.creates paths in the six non-SDLC manifests are now framework-scoped; the workspace-status and framework-detector legacy detectors no longer treat the SDLC canonical layout as "legacy" when `.aiwg/frameworks/` is present; orphan top-level non-SDLC dirs (residue from pre-#1516 installs) continue to be flagged as a migration signal so the prompt fires once and stops.
- **Stale `.js` hook command paths refreshed on `aiwg refresh` (regression on Claude Code 2.1.157).** Pre-`be3ee551` installs (when the package declared `"type": "module"` and hook scripts were `.js`, since renamed to `.cjs`) left settings.json pointing at files that no longer exist after refresh. Claude Code surfaced this on every session start as `SessionStart:startup hook error → Failed with non-blocking status code: node:internal/modules/cjs/loader:1459`. The installer's matched-but-out-of-date branch now rewrites the entry instead of skipping it. Regression test added.

### Changed

- **`@pagenary/publisher` bumped `^2026.5.3` → `^2026.5.4`** (carried from Unreleased — see _Why this matters to users_ above).

### Upgrade notes

- Affected projects with stale `.js` paths in `.claude/settings.json` heal automatically on the next `aiwg refresh` / `aiwg use`. No manual edit required.
- Projects with the duplicated workspace layout from the pre-#1516 deploy bug (any of `.aiwg/{forensics,kb,media,marketing,research,security-engineering}/` present alongside `.aiwg/frameworks/`) will continue to show as flagged by `aiwg status` until the orphan top-level dirs are moved or pruned. The existing template stubs (`forensics/chain-of-custody.md`, `kb/index.md`) carry the only content and can be relocated under `.aiwg/frameworks/<id>/`.

## [2026.5.12] - 2026-05-27 — "Research corpus tooling, engineering blog launch, and release-workflow discipline"

This release lands the bulk of the section9/research-papers tooling merge into the native `research-complete` framework — radar/freshness, profile generation, funder analytics, discovery logging, and a configurable corpus root with a shared parser foundation — and launches the AIWG engineering blog as a single-source-of-truth markdown collection rendered by pagenary 2026.5.3. It also cleans up the Gitea release workflows so the live topology (npmjs.org from GitHub Actions; Gitea owns its own registry mirror only) is reflected in the code.

### Why this matters to users

| What changed                                                     | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Research corpus tooling merged from section9/research-papers** | A radar/freshness subsystem (radar-init/status/report), profile generation (profile-generate, profile-status, `--fm` variant), entity-profile graph analytics (centrality, communities, temporal), funder-network analytics, and discovery-logging + PROF-S curator tooling — all native under `aiwg corpus` / `aiwg index` instead of 26 path-hardcoded scripts. One configurable corpus root + shared parser library. |
| **`aiwg index build` renders corpus markdown views natively**    | by-year/topic/venue/authors/method/model-size/training-pipeline/citation-network plus radar/discovery/funder views are derived from the index in-process — no separate `regenerate_indices.py` step.                                                                                                                                                                                                                    |
| **Index config consolidated into `aiwg.config`**                 | `index.graphs` is now a validated schema field under `.aiwg/aiwg.config`. `.aiwg/.index/` is gitignored by default and `aiwg doctor` checks its freshness.                                                                                                                                                                                                                                                              |
| **Engineering blog source-of-truth at `docs/blog/`**             | One markdown file per post; pagenary 2026.5.3 collection support auto-generates `docs.aiwg.io/blog/index.json` (envelope schema `{title, route, count, generated, posts[]}`) plus `feed.xml` from frontmatter. First post: "How AIWG builds your customized system prompt." Publishing process documented at `docs/contributing/publishing-blog-posts.md`.                                                              |
| **Doc-site CI builds via npm, not a git clone**                  | `docsite-build.yml` / `docsite-deploy.yml` now install `@pagenary/publisher` as a devDependency and run `npx pagenary build:tenants aiwg-docs`; the `GT_ACCESS_TOKEN` clone path is retired and revokable after one clean deploy.                                                                                                                                                                                       |
| **Release-workflow topology clarified**                          | `npm-publish.yml` header + dry-run text now state Gitea-only registry; npmjs.org publishes from GitHub Actions via OIDC. `NPM_TOKEN` documented as a Gitea API token in both Gitea workflows. Operator-rotated the underlying token; first-class fix for #1481.                                                                                                                                                         |

### Added

- **Research-corpus subsystem (epic #1496):**
  - Configurable corpus root + shared parser foundation for radar/discovery/funder parsing (#1497).
  - Radar subsystem: `radar-init` scaffold, `radar-status`, `radar-report`, CLI + skills/template (closes #1498); shared cadence/staleness config extracted.
  - Profile generation: `profile-status` (`find_stale_profiles` port), `profile-generate` (`build_tier1_profiles` port), `profile-generate --fm` (`build_fm_profiles` port), entity-profile template — profile subsystem complete (closes #1502).
  - Corpus authoring templates (reference + citation) (refs #1496).
  - Discovery-logging + PROF-S curator tooling (closes #1499).
  - Entity-profile graph analytics — centrality, communities, temporal (refs #1501; partial).
  - Funder-network analytics (`build_funder_network` port) (closes #1500).
- **Index renderers:** `aiwg index build` renders corpus markdown views natively (#1490 Full A); radar/discovery/funder views (#1492).
- **Engineering blog:** `docs/blog/` collection with frontmatter conventions + first post "How AIWG builds your customized system prompt" (closes #1510); auto-generated manifest + RSS feed via pagenary 2026.5.3 collection support.
- **Publishing process doc:** `docs/contributing/publishing-blog-posts.md` documents the source-of-truth model, frontmatter spec, image placement (`docs/.public/blog/` → `/assets/blog/`), the manifest envelope schema, the publish flow, and the A10–A13 companion roadmap.
- **Doc-site devDependencies:** `@pagenary/publisher` (`^2026.5.3`) and `terser` (`^5.47.1`).

### Changed

- **Index config schema:** `index.graphs` consolidated into `aiwg.config` under a validated schema; `corpus-index-build` config example aligned with `build.py` schema (#1487, #1490, #1491).
- **Doc-site CI** now installs `@pagenary/publisher` from npm and runs `npx pagenary build:tenants aiwg-docs` instead of git-cloning the publisher to `/tmp`; `GT_ACCESS_TOKEN` no longer referenced (#1484, follows the repo rename in #1473).
- **Pagenary devDep advanced** from `2026.5.1` (exact) → `^2026.5.3` (caret) to pick up collection support; first-party adoption via the documented `--min-release-age=0` override per `docs/contributing/versioning.md` (operator-authorized).
- **Blog manifest** is auto-generated by pagenary (envelope object), not hand-maintained; `docs/blog/index.json` removed from source and now lives only as a build artifact at `dist/aiwg-docs/blog/index.json`.
- **`npm-publish.yml`** header + dry-run echo now say Gitea-registry-only; clarifies `NPMJS_TOKEN` is referenced only by the `if: false` legs and is revokable. Closes the docs/text half of #1481.

### Fixed

- **`dist/` build hygiene (#1512):** rebuilt the CLI's `dist/` on a checkout where it had been cleaned/absent; documented the root cause (`.mjs`/JSON/YAML files are _copied_ into `dist/src/` by `build:copy-mjs`, separate from `tsc`). Filed #1513 for a `doctor` guard so a missing build fails loud + actionable next time.
- **`.aiwg/.index/`** is now gitignored by default and excluded from accidental commits; doctor surfaces freshness.

### Known follow-up

- **pagenary#19** — page renderer still shows YAML frontmatter as visible text on docs.aiwg.io (the auto-generated manifest is unaffected). Clean rendering arrives when pagenary lands the render-side strip and ages past `min-release-age`.
- **#1486** — fix 53 pre-existing broken internal doc links and re-enable `strictLinks: true` on `docsite-build`.
- **Epic #1496 remaining clusters** — sidecar lint & metadata repair (#1503), induction quality (#1504), citation-graph densification (#1505), integrity / submission-risk scan (#1506); `needs-infrastructure` items: scanned-page vision extraction (#1507) and Fortemi import (#1508, deferred). Entity-profile graph analytics (#1501) is partial.
- **#1513** — `aiwg doctor` should detect a missing/incomplete `dist/` and emit an actionable error.
- **Provider field-validation cluster** (#1405 / #1407–1415) remains correctly `blocked:field-validation` pending per-provider field reports.

### Tests

Release-prep verification for this line:

```bash
npm run check:versions
npm run typecheck
npm run build:cli
npm test
npm run uat
```

### Migration notes

No breaking changes.

- If you forked AIWG and kept a hand-maintained `docs/blog/index.json`, remove it before building — pagenary 2026.5.3 generates the file into the build output now, and a committed source copy is redundant/stale.
- Co-located post images (`docs/blog/images/*.png`) are _not_ served by pagenary; place blog images under `docs/.public/blog/<file>.png` and reference them via the absolute `/assets/blog/<file>.png` URL. The publishing-process doc covers this.
- Pagenary advanced from `2026.5.1` to `^2026.5.3`. The `min-release-age=7` supply-chain gate was bypassed for the bump per the documented `--min-release-age=0` override since pagenary is first-party (`roctinam/pagenary`).

## [2026.5.11] - 2026-05-25 — "Provider detection, local issue sync, and media transcript prep"

This patch release hardens AIWG's cross-provider workflow plumbing, adds local issue-tracker synchronization paths, and documents the current code-to-docs audit before the next stable tag. It also ships the first concrete time-based media primitive while keeping the larger research handoff work explicit as follow-up scope.

### Why this matters to users

| What changed                              | What it gives you                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Codex-aware provider detection**        | Mixed Claude/Codex workspaces now prefer the active Codex runtime where appropriate, so refresh and regenerate flows target the right provider files.                                      |
| **Local issue sync workflows**            | Projects can import/export local issue stores, run live tracker sync, and document conflict handling without guessing which issue backend is active.                                       |
| **Media transcript sidecars**             | Media-curator can now surface a transcript sidecar workflow for acquired audio/video, including source metadata, hashes, timestamps, and degraded plans when local STT tooling is missing. |
| **Security and supply-chain scaffolding** | Security-engineering gained CI emitters, banned-API scaffolds, DFIR readiness routing, and supply-chain audit documentation.                                                               |
| **Release and docs hygiene**              | Release config now records the broad doc-sync scope for all agentic/code sources plus repository Markdown, and release tags are routed through the dedicated signing wrapper.              |

### Added

- Local issue import/export and live sync workflows, plus documentation for migration, conflicts, backups, and credentials.
- `transcribe-media` media-curator skill with a sample transcript sidecar and discovery coverage.
- Security-engineering cycle-1 scaffolds for banned APIs, sanitizer/fuzzing CI emitters, disclosure tracking, DFIR readiness, and external npm supply-chain audit provenance.
- Community, browser-control, and Omnius integrator documentation surfaces.

### Changed

- Codex provider detection now uses runtime/process markers and mixed-workspace regression coverage for `regenerate`, `refresh`, `steward`, and related provider-selection paths.
- Media-curator docs now describe transcript sidecars and research handoff preparation alongside archive curation.
- Release configuration doc-sync guidance now includes all of `agentic/code/` and all repository Markdown files, reflecting where AIWG capabilities actually live.
- Release tagging is configured to use `tools/release/cut-tag.sh` instead of a raw `git tag` command so the release signing key remains separate from the regular commit key.
- The system-wide `cli-secondary` rule now states that raw CLI commands augment skill workflows; skills remain responsible for orchestration, final formatting, presentation, synthesis, gates, and recovery.
- Claude Code external loop launches now default-disable 1M-context model variants unless `CLAUDE_CODE_DISABLE_1M_CONTEXT` is explicitly set, with docs covering the credit-account tradeoff and opt-in path.
- Project signing-key split is documented in `AGENTS.override.md` and `.aiwg/release-process.md`: regular commits use the host commit key, while annotated release tags use the AIWG release key.

### Fixed

- Channel sync and refresh provider-detection tests were stabilized.
- Docsite deployment now normalizes the deploy root and verifies release artifacts more directly.
- Address-issues and agent-loop paths were hardened, including malicious issue-body handling and stale-window closure auditing.
- Media transcript discovery now routes `transcribe media` to the media-curator skill.

### Known follow-up

- The time-based media research epic remains open for REF templates, timestamp citation policy, citation sidecars, `induct-media`, and quickref/generated-guidance discoverability.
- Cargo/Rust crate supply-chain discovery still routes to npm-specific audit guidance first and remains tracked as follow-up work.
- Provider field-validation claims remain limited to sessions already evidenced in the issue tracker; remaining providers still need real session validation.
- A repo-wide audit is open as #1480 to align docs, quickrefs, skill bodies, and generated guidance with the skill-first CLI augmentation rule.

### Tests

Release-prep verification for this line:

```bash
npm run check:versions
npm run typecheck
npm run build:cli
npm test
npm run uat
```

### Migration notes

No breaking changes. Projects using local issue stores should review `docs/local-issues.md` before enabling live sync so tracker direction, conflict handling, and credential sourcing are explicit.

## [2026.5.10] - 2026-05-19 — "Beginner onboarding wizard + docs"

This patch release adds a guided first-run path for new users and restores the literal meaning of `aiwg use all`.

### Why this matters to users

| What changed                                                          | What it gives you                                                                                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`aiwg wizard` walks first-time setup**                              | Provider choice, profile selection, execution mode, and verification in a single guided flow. JSON output stays plan-only for automation; unattended execution requires `--non-interactive`. |
| **`aiwg use all` deploys the full surface again**                     | The literal meaning is restored. Workspace-aware filtering moves to `aiwg use --workspace-signals` (preview) and `aiwg use --profile <name>` (deploy filtered).                              |
| **`aiwg status --probe --json` reports engagement deterministically** | Distinguishes configured, partially configured, and repair-needed workspaces. Malformed local config returns repair guidance instead of raw parse failures.                                  |
| **Full deploy summary separates native vs discoverable skills**       | The capability index build prints a discoverable-skill count alongside the platform-native count so the budget story is legible.                                                             |
| **Beginner docs refreshed**                                           | Provider handoff, scope and recovery, onboarding validation, share/demo workflows, and current onboarding research.                                                                          |

### Added

- `aiwg wizard` interactive onboarding flow with provider/profile/mode/verification steps.
- Beginner documentation: `docs/beginner-first-success.md`, `docs/beginner-provider-handoff.md`, `docs/beginner-scope-and-recovery.md`, `docs/beginner-onboarding-validation.md`, `docs/beginner-share-demo-assets.md`, `docs/beginner-research-refresh-2026.md`, and `docs/beginner-aiwg-language-map.md`.
- AIWG.md context finalization includes engagement verification guidance without adding generated attribution footers.

### Changed

- `aiwg use all` deploys every framework, addon, and deployable extension by default.
- `aiwg use --workspace-signals` previews a workspace-aware plan; `aiwg use --profile <name>` deploys a filtered profile.
- Skills/commands unification guide describes provider-specific command mirroring without exposing internal tracker references.
- Release navigation manifest includes the current and immediately previous patch release.
- security-auditor agent discipline tightened; rolling `audit.md` rollup added.

### Fixed

- Windows doctor and skill registration hardened against path-handling edge cases.
- Claude provider command-mirror deduplication so wrapper commands don't double-deploy.
- Docsite release deploy verification covers the v2026.5.10 announcement file.

### Tests

- `npm run typecheck`
- `npm run build:cli`
- `npx vitest run --config config/vitest.config.js test/unit/cli/wizard.test.ts`
- `npx vitest run --config config/vitest.config.js test/unit/cli/handlers/use-workspace-filter.test.ts`
- `npm test`

### Migration notes

If you depended on `aiwg use all` deploying only the workspace-aware subset, switch to `aiwg use --profile <name>` or `aiwg use --workspace-signals` followed by an explicit `aiwg use` invocation for the previewed set.

## [2026.5.9] - 2026-05-18 — "Workspace deploy + command surface parity"

This patch release fixes the workspace-aware `aiwg use all` deployment flow and restores operator workflow discoverability across providers after the skills-first pivot.

### Why this matters to users

| What changed                                             | What it gives you                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`aiwg use all` deploys the workspace-aware plan once** | The auto-selected framework/addon plan no longer re-enters the full post-deploy flow for every selected framework. Users avoid repeated capability-index builds, repeated reload messages, and duplicate hook backup lines.                      |
| **Operator skills are mirrored as provider commands**    | Workflows such as `aiwg-setup-project`, `aiwg-update-claude`, and `aiwg-update-agents-md` are copied to each provider's command surface where possible, so slash/command workflows remain locatable even when the canonical artifact is a skill. |
| **Provider command paths were normalized**               | OpenCode and Warp now have explicit command directories in the provider deployment map, and fallback command mirroring places command assets in the closest reasonable provider location.                                                        |
| **Doctor guidance points at workspace-aware deploy**     | `aiwg doctor` and listing guidance steer high-skill-count workspaces toward workspace-aware deployment when provider listing budgets are likely to be exceeded.                                                                                  |

### Changed

- `aiwg use all` now computes the workspace-aware framework/addon/extension plan once and deploys selected source directories directly.
- `aiwg use --workspace-signals --dry-run` reports the same workspace-aware subset that `aiwg use all` uses by default.
- Provider deployment now mirrors command-like operator skills into provider command surfaces across supported providers.
- OpenCode and Warp provider definitions now declare command output directories for mirrored operator workflows.
- The legacy full deployment path remains available with `aiwg use all --no-workspace-signals`.

### Fixed

- Fixed issue #1380: `aiwg use all` appeared to run repeatedly because each selected framework triggered the full framework post-deploy flow.
- Fixed user-reported discoverability gap for `aiwg-setup-project`: the skill is still discoverable via `aiwg discover` / `aiwg show skill`, and the workflow is also mirrored onto command surfaces for command-capable providers.
- Added integration coverage that verifies command mirroring for Codex, OpenCode, Copilot, Warp, and Windsurf provider deployments.

### Tests

- `npm run typecheck`
- `npm run build:cli`
- `npx vitest run --config config/vitest.config.js test/integration/deployment-completeness.test.ts`
- `npx vitest run --config config/vitest.config.js test/integration/use-all-deployment.test.ts`
- `npm test`

### Migration notes

No breaking changes. Existing skills remain the canonical source, and command copies are compatibility mirrors for providers and users that still expect command/slash-command workflows. Use `--no-workspace-signals` to force the pre-existing full deployment behavior.

### Links

- Release announcement: [docs/releases/v2026.5.9-announcement.md](docs/releases/v2026.5.9-announcement.md)

## [2026.5.8] - 2026-05-18 — "Fleet discipline + release hygiene"

This release collects the post-2026.5.7 operational hardening work: fleet behavior policies, provider-aware deployment of behavior artifacts, model-tier routing primitives, repo-access preflight, execution-mode ergonomics, status export, daemon/serve reliability coverage, and install-hygiene fixes that keep optional native dependencies out of the default install tree.

### Why this matters to users

| What changed                             | What it gives you                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fleet discipline rules and behaviors** | `aiwg-fleet` adds quiet-bot and quiet-business-bot behavior bundles; `aiwg-utils` adds escalation discipline, tool quota, quiet mode, and repo-access rules for small-budget unattended bots. |
| **Fleet status export**                  | `aiwg status --export json                                                                                                                                                                    | ndjson` and the documented schema give cockpit tools a stable, pull-based machine/workspace health payload. |
| **Repo-access preflight**                | `aiwg repo-access` and the `respect-repo-access-manifest` rule make repository read-scope assumptions explicit before agents rely on paths they may not be able to inspect.                   |
| **Model-tier routing primitive**         | New provider-neutral model routing types/helpers support Tier 0-3 decisions, escalation rationale, and premium confirmation requirements.                                                     |
| **Context parallelism caps**             | `.aiwg/aiwg.config` can declare provider-scoped max parallel subagent limits; generated `AIWG.md` / `AGENTS.md` surfaces those caps and the RLM CLI respects them.                            |
| **Serve/daemon reliability**             | A2A terminal task observation, PTY bridge resilience coverage, sandbox transport fixtures, and daemon tier-1 tests harden the execution stack without requiring a live sandbox in default CI. |
| **Install hygiene**                      | `better-sqlite3` and `@xenova/transformers` are optional peers instead of default install dependencies; SQLite implementation tests now skip cleanly when the optional peer is absent.        |
| **Docsite release checks**               | Notify/deploy workflows now fail on silent release-doc issues and verify the generated SPA section artifact rather than grepping the shell HTML.                                              |

### Added

- `agentic/code/addons/aiwg-fleet/` — new addon with `quiet-bot` and `quiet-business-bot` behavior bundles plus provider activation docs.
- `agentic/code/addons/aiwg-utils/rules/escalation-discipline.md`, `tool-quota.md`, `quiet-mode.md`, and `respect-repo-access-manifest.md`.
- `docs/fleet/status-export-schema.md` for the versioned fleet status export payload.
- `docs/security/repo-access-manifest.md` for explicit repository read-access declarations.
- `docs/providers/behavior-artifacts.md` for provider behavior-artifact support and emulation.
- `src/models/router.ts` and model route decision types for tiered model-routing policy.
- `src/cli/handlers/repo-access.ts` and `src/policy/repo-access.ts`.
- `src/cli/handlers/execution-mode.ts` for execution-mode inspection.
- `src/providers/capability-matrix.ts` and `agentic/code/providers/capability-matrix.yaml`.
- `src/serve/a2a-terminal-observer.ts` and broad serve/daemon contract, unit, and integration fixtures.
- `agentic/code/frameworks/sdlc-complete/skills/issue-audit/` and the `issue-audit` command.
- `agentic/code/frameworks/research-complete/skills/corpus-index-build/build.py`.

### Changed

- Provider deployment now handles behavior artifacts across supported providers, with OpenClaw native support and documented fallback behavior where native lifecycle hooks are unavailable.
- `aiwg status` now supports fleet export modes and expanded status details for installed frameworks, deployments, recent activity, and health flags.
- `aiwg refresh`, `regenerate`, `steward`, plugin commands, writing validation, doctor, and workspace-status paths were tightened for project-local behavior and managed-marker drift.
- `AIWG.md` / `AGENTS.md` generation now surfaces configured parallelism caps and finalization behavior more explicitly.
- `rlm` honors the configured parallelism default, and `rlm-batch` / `rlm-context-management` docs describe the cap-aware behavior.
- Claude model config now defaults standard Sonnet usage to the standard context variant rather than an extended-context default.
- Package install metadata now treats install-heavy native features as opt-in optional peers.

### Fixed

- `discover` indexes canonical framework skills accurately and has regression coverage for framework skill coverage.
- `doctor` tolerates managed-marker hash drift without false-failing normal refresh paths.
- Serve mission accounting and tool resolution were corrected, including A2A terminal task-state observation.
- Context hook finalization now emits the expected provider files.
- `ci.yml` failure after the install-hygiene change is fixed by skipping only the SQLite backend implementation suite when `better-sqlite3` is absent.
- Docsite deploy verification now checks the generated release section file, and notify-site/docsite workflows fail loudly on missing or failed release-doc outputs.

### Tests

- Full local CI-shaped test after the SQLite optional-peer fix: `npm run test:ci` — passed.
- Latest Gitea CI on `main` after the fix: run `2333` — Test and Build passed.
- New/expanded coverage includes model routing, repo access, provider behavior emulation, capability preflight, status/workspace commands, serve/A2A observer paths, PTY bridge resilience, sandbox transport contract fixtures, RLM parallelism resolution, skill-lint companion CLI rules, package metadata install hygiene, and marketplace/package-lock version lockstep.

### Migration notes

No breaking changes for the base CLI. Install-heavy features that depend on `better-sqlite3` or `@xenova/transformers` now require explicit opt-in installation when used directly; graph-backend factory/error-path tests and docs continue to explain that optional setup path.

### Links

- Release announcement: [docs/releases/v2026.5.8-announcement.md](docs/releases/v2026.5.8-announcement.md)

## [2026.5.7] - 2026-05-15 — "RLM search reliability + internal loop routing"

This release tightens two recently updated automation paths: RLM search now preserves the user's query and covers small source files, while `agent-loop` routes to the in-session loop by default unless the user explicitly asks for the external daemon.

### Why this matters to users

| What changed                                           | What it gives you                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`rlm-search --max-parallel` is parsed as an option** | `aiwg rlm-search "find all references to loop structures" --source docs --max-parallel 4` now keeps the full query instead of treating `4` as the query. Unknown flags now fail fast rather than allowing nearby positional values to overwrite the search text. |
| **RLM prep indexes single-chunk files**                | Small docs and source files are included in the prep manifest and search plan. A source tree with only short files no longer produces an empty or partial RLM search.                                                                                            |
| **Prep reuse is coverage-checked**                     | Existing prep indexes are validated for source, file, manifest, and chunk coverage before reuse. Incomplete or stale prep from older runs is rebuilt automatically.                                                                                              |
| **`agent-loop` defaults to the internal loop**         | Normal `agent-loop` requests stay in the current session. External daemon routing is still available through explicit external-loop commands or explicit user intent.                                                                                            |
| **Build-time version lockstep check**                  | `npm run build:cli` now fails if `package.json`, `package-lock.json`, or `.claude-plugin/marketplace.json` disagree on the release version.                                                                                                                      |

### Changed

- `agentic/code/addons/agent-loop/skills/agent-loop/SKILL.md` — bumped to skill version 3.1.0 and updated routing guidance so internal/in-session iteration is the default path.
- `docs/cli-reference.md` — documents `rlm-search --max-parallel` as an accepted alias, and describes the single-chunk prep and prep-index validation behavior.
- `agentic/code/addons/rlm/skills/rlm-search/SKILL.md` — documents coverage-checked prep reuse and single-chunk indexing.
- `package.json` — `build:cli` now runs `check:versions` before compiling, catching release-version drift early.
- `docs/contributing/versioning.md` and `tools/release/cut-tag.sh` — document the Codex/agent-runtime `HOME` vs operator `GNUPGHOME` signing-key gotcha so release agents can find the AIWG release key.

### Fixed

- `src/rlm/cli.ts` — `rlm-search` recognizes `--max-parallel`; unknown flags now produce a CLI error instead of shifting the query positional.
- `src/rlm/cli.ts` — `rlm-prep` writes manifests and chunk files for sources that fit in one chunk, then indexes them for downstream search.
- `src/rlm/cli.ts` — prep index reuse now checks that every expected source file, manifest, and chunk exists before search.
- `tools/workspace/check-marketplace-version.mjs` — now validates `package-lock.json` top-level and root-package versions in addition to marketplace metadata.
- External loop observability from the prior patch line is included in this release train: external session status can surface captured log output when the daemon path is intentionally used.

### Tests

- `test/uat/rlm-cli.uat.ts` adds regressions for single-chunk manifest creation, single-chunk prep indexing, and `rlm-search --max-parallel 4` query preservation.
- `test/unit/workspace/check-marketplace-version.test.ts` adds regressions for package-lock top-level drift, package-lock root-package drift, marketplace drift, and the allowed pre-release marketplace exception.
- Verified locally with `npm run check:versions`, `npm run test -- test/unit/workspace/check-marketplace-version.test.ts`, `npm run uat -- test/uat/rlm-cli.uat.ts`, and `npm run build:cli`.

### Migration notes

No breaking changes. Existing `rlm-search --parallel N` calls continue to work. `--max-parallel N` is now accepted by both the source skill and CLI. Existing `agent-loop` invocations keep working; only the default routing preference changed so external daemon behavior requires explicit external-loop intent.

### Links

- Release announcement: [docs/releases/v2026.5.7-announcement.md](docs/releases/v2026.5.7-announcement.md)

## [2026.5.6] - 2026-05-14 — "Agent-loop completion inference + auto-compact discipline"

Two behavioral upgrades to make long-running and iterative work survive context pressure and reach measurable completion without operator hand-holding, plus a CI workflow ordering fix that prevents v2026.5.5-style stable-publish regressions.

### Why this matters to users

| What changed                                              | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`agent-loop` infers `--completion` from project state** | Run `agent-loop "fix the failing tests"` without `--completion`. A new `infer-completion-criteria` skill walks five evidence layers — task verb → `CLAUDE.md`/`AGENTS.md`/`AIWG.md` Development sections → package manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, …) → CI config (`.github/workflows/`, `.gitea/workflows/`, GitLab/CircleCI/Jenkins) → `.aiwg/` artifacts (test-strategy, related use cases by ID match, prior progress files) — and proposes a measurable criterion with rationale and confidence level. High-confidence proposals auto-adopt with `--auto-criteria`; otherwise the proposal is surfaced for confirm/edit/abort. Refusal path is explicit: tasks like "make it better" with no derivable measurable gate get a refusal with concrete rephrasing suggestions. |
| **New `auto-compact-continue` rule (HIGH)**               | The answer to "should I keep working?" is always YES — until measurable completion criteria are met or the user redirects. Context pressure, long tool output, and crossing iteration N are not scope questions. The rule codifies the auto-compact-and-continue discipline backed by Anthropic's [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and the [Compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction): write progress files at `.aiwg/working/<task>-progress.md` every 10–15 tool calls (REF-122 aggressive vs passive: 22.7% vs 6% savings), let the platform auto-compact, recover via the AIWG durable substrate (activity log, progress file, git, memory, `CLAUDE.md`/`AGENTS.md`/`AIWG.md`).    |
| **CI: build before tests in `npm-publish.yml`**           | The v2026.5.5 stable publish failed because tests ran before build, and several tests assert on `dist/` output (regression test for #1001). The Gitea workflow now matches `ci.yml`: typecheck → build → test → publish. Without this, the next stable publish would have hit the same failure mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Added

- `agentic/code/addons/agent-loop/skills/infer-completion-criteria/` — new skill (~280 lines). Deterministic 5-layer inference pipeline with structured YAML output (criterion, verification command, rationale, confidence, alternatives, max-iterations suggestion). Documents edge cases for monorepos, multi-language projects, broken-test suites, use-case acceptance criteria, and the refusal path. Wired into `agent-loop/manifest.json` skills array.
- `agentic/code/addons/aiwg-utils/rules/auto-compact-continue.md` — new HIGH rule (~250 lines). Codifies the auto-compact-and-continue discipline with 8 mandatory rules, interaction with `vague-discretion`/`anti-laziness`/`human-authorization`/`instruction-comprehension`/`skill-discovery`/`activity-log`/`context-budget`, recovery protocol after compaction, named exceptions, and platform applicability across all 10 supported providers. (Landed in v2026.5.5's incident-fix commit f87ba48c; called out in this release for visibility since the user-facing impact is felt now that the agent-loop changes pair with it.)
- Two new research references in companion `research-papers` repo:
  - **REF-909** — Anthropic, _Effective Harnesses for Long-Running Agents_ (Nov 2025). Initializer-agent / coding-agent pattern, `claude-progress.txt`, "failed approaches" as load-bearing artifact across context resets.
  - **REF-910** — Anthropic, _Compaction_ (Claude API Documentation, 2026). Auto-compact mechanics, `## Compact Instructions`, what survives compaction.

### Changed

- `agentic/code/addons/agent-loop/skills/agent-loop/SKILL.md` — completion-inference section now delegates to the new `infer-completion-criteria` skill. The previous inline 7-row Node-centric pattern table is demoted to a "last-resort fallback" with explanatory note. Related-skills list adds `infer-completion-criteria` and `agent-loop-ext`.
- `agentic/code/addons/agent-loop/skills/ralph/SKILL.md` — `--completion` is now optional. Phase 1 initialization invokes inference when omitted; high-confidence proposals or `--auto-criteria` adopt silently, otherwise the user is asked via `AskUserQuestion` (per `native-ux-tools`). Loop also writes the resolved criterion and rationale into the loop's progress file per `auto-compact-continue`. New flag: `--no-infer-completion` for explicit-required behavior.
- `agentic/code/addons/agent-loop/skills/agent-loop-ext/SKILL.md` — same `--completion`-optional treatment for the crash-resilient external loop, with TTY-aware confirmation (interactive: confirm; headless/CI: adopt high-confidence proposals, fail fast with diagnostic on low confidence). Proposal persisted to `.aiwg/ralph-external/<run-id>/inferred-completion.yaml` for crash recovery.
- `agentic/code/addons/agent-loop/agents/ralph-verifier.md` — gained a "Companion skill" section documenting that when the criterion was inferred, the verifier can reference the rationale chain from the progress file / inferred-completion.yaml in its verification reports.
- `agentic/code/addons/agent-loop/manifest.json` — added `infer-completion-criteria` to the skills array.
- `agentic/code/addons/aiwg-utils/manifest.json` — added `auto-compact-continue` to the rules array; `RULES-INDEX.md` updated to 21 rules with the new HIGH-tier entry placed at the top of the index.
- `.gitea/workflows/npm-publish.yml` — Build step now runs **before** Run tests, matching `ci.yml`. Several tests assert on `dist/` output (e.g. `test/unit/cli/validate-metadata-import.test.ts` asserts the import path resolves to `dist/src/plugin/metadata-validator.js`); pre-2026.5.6 the workflow ran tests against stale build output and the stable publish at v2026.5.5 hit this. Inline comment cites the v2026.5.5 incident so future contributors understand the ordering constraint.

### Fixed

- Stable npm publish path: tests now run against current `dist/` artifacts. The v2026.5.5 publish failure mode (test references resolving against stale or missing build output) is closed.

### Migration notes

No breaking changes. Existing `agent-loop` / `ralph` / `agent-loop-ext` invocations with explicit `--completion` continue to work unchanged. The new behavior only activates when `--completion` is omitted.

If you want the old hard-error-on-missing-completion behavior, pass `--no-infer-completion`. If you want CI-style fully-automated runs that adopt the inferred criterion without confirmation, pass `--auto-criteria`.

### Companion: research-papers corpus

The AIWG research corpus at `git@git.integrolabs.net:section9/research-papers.git` gained REF-909 and REF-910 as the load-bearing citations for the new `auto-compact-continue` rule. Both are GRADE LOW (vendor documentation) but authoritative for Claude-specific patterns and reflect production experience from the Claude Code team.

### Links

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Anthropic Engineering, Nov 2025
- [Compaction — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction) — Anthropic, 2026
- REF-122 _Active Context Compression_ (Verma, 2026) — already in corpus; the empirical basis for aggressive in-session compression
- Release announcement: [docs/releases/v2026.5.6-announcement.md](docs/releases/v2026.5.6-announcement.md)

## [2026.5.5] - 2026-05-14 — "Cross-provider discover-first parity"

Two user-facing changes plus the deployment-pipeline fix that makes the
discover-first protocol reach all 10 supported providers on every fresh
`aiwg use` invocation. Companion artifact: the Novice-User Adoption study
(Workstreams A-G), landed under `.aiwg/studies/novice-user-adoption/`.

### Why this matters to users

| What changed                                                  | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`aiwg use` warns when invoked from `$HOME` / `/` / `/tmp`** | First-run protection. When `aiwg use sdlc` runs from a directory with no project signals (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `Gemfile`, `build.gradle`, `*.csproj`), AIWG emits a 3-second cancellable warning naming the target directory and pointing at recovery. `AIWG_GLOBAL_INSTALL=1` suppresses the delay; non-cancelled emissions write `warn:no-project-signal` to `.aiwg/activity.log`. Stat-only walk completes in <50ms (CI-enforced). |
| **Discover-first protocol now reaches every provider**        | Before this release, the `skill-discovery` rule (mandates `aiwg discover` before declining a request or improvising a workflow) was deployed only to Claude Code and Cursor. Eight other providers had stale leftover copies or no copy at all. After this release, every provider's `aiwg use` invocation deploys the current rule body to its native rules directory, or — for Warp and Hermes — inlines it into the appropriate aggregation surface (WARP.md and AGENTS.md priming).       |
| **Documented scope-model trade-off (REF-720)**                | `docs/cli-reference.md` and `README.md` now document the project-scope (default) vs user-scope (global install) trade-off side-by-side, citing the REF-720 cross-context-bleed evidence (39% capability drop). ADR-NUA-001 formalizes global install as a first-class supported flow with project-scope remaining the recommended default.                                                                                                                                                    |

### Added

- `src/cli/project-isolation/` — new module (signals.ts, detect.ts, warning.ts, index.ts) wiring the project-isolation warning into `UseHandler.execute()`. 29 unit tests covering per-signal positive cases, walk-depth boundary (MAX_PARENT_DEPTH = 3), Ctrl-C cancellation, env-var suppression, activity-log integration, and a CI-enforced performance gate (<50ms median in a project root).
- `agentic/code/frameworks/sdlc-complete/templates/aiwg-sections/02b-discover-first.md` — new template fragment registered in the aiwg-sections manifest. Ready for downstream wiring once the fragment-based AIWG.md generator returns to the live pipeline.
- `.aiwg/studies/novice-user-adoption/` — full study deliverables across Workstreams A-G (10 baselined documents under `working/`): hookup matrix, read-access audit, wizard design + CW, engagement-surface design + Lee & See trust-calibration analysis, global-install rough-edge inventory, comms drafts, three empirical-question instruments.
- Three new follow-up tracking issues filed and resolved during the study: #1343 (rule deployment), #1346 (Warp aggregation), #1347 (Hermes priming).

### Changed

- `agentic/code/addons/aiwg-utils/manifest.json` — `consolidation.deployIndexOnly` changed from `true` to `false`. Individual rule files (skill-discovery, no-attribution, anti-laziness, etc.) now deploy alongside `RULES-INDEX.md` to every provider's rules directory. Per saved-memory `feedback_parity_no_removal`: always-deploy + adapt — no writer was removed; the deploy set was extended. Closes #1343.
- `tools/warp/setup-warp.mjs` — new `transformRuleToSection()` and `collectAiwgRulePaths()` helpers plus a "## AIWG Rules" aggregation block in `generateAIWGContent()`. Regenerated WARP.md inlines the full aiwg-utils rule bodies (skill-discovery first), turning the previous "0 discover-protocol references" into 101. Closes #1346.
- `tools/agents/providers/hermes.mjs` — `CRITICAL_RULE_DIRECTIVES` extended from Top-6 to Top-7. skill-discovery added as the first directive (governs how the agent interacts with AIWG architecturally). ~1KB compressed, well within the 19KB Hermes AGENTS.md hard cap. Closes #1347.
- `src/mcp/tools/discovery.mjs` — `rule-list` MCP tool description updated to reflect the Top-7 inlining.
- `agentic/code/frameworks/sdlc-complete/templates/copilot/copilot-instructions.md.aiwg-template` — new "Discover-First Protocol (CRITICAL)" section inlined under the AIWG SDLC Framework heading. Copilot reads `.github/copilot-instructions.md` natively, so the inline section reaches Copilot agents at session start.
- `docs/cli-reference.md` — new "Scope models: project vs user (global)" section under `aiwg use` with side-by-side comparison, REF-720 trade-off, and per-provider notes.
- `README.md` — scope-model overview added to "What AIWG Is" with project recommendation, global as first-class supported, REF-720 framing.
- `test/unit/consolidated-rules.test.ts` — 2 tests rewritten to verify the new positive contract (aiwg-utils rules included, skill-discovery in returned set). 53/53 pass.

### Fixed

- `.claude-plugin/marketplace.json` — bumped `metadata.version` from 2026.5.2 → 2026.5.5 to satisfy the PUW-038 (#1139) lockstep check with `package.json`. The marketplace version had drifted across 2026.5.3 and 2026.5.4 releases; this release brings it back into lockstep.
- Stale `.claude/rules/skill-discovery.md` (401 lines) and `.cursor/rules/skill-discovery.md` (334 lines) had drifted from the source-of-truth (400 lines, md5 `93a41b...`). Next `aiwg use` invocation overwrites them with the current source.

### Audit / Documentation

- `.aiwg/studies/novice-user-adoption/working/hookup-matrix.md` — full per-platform discovery-hookup matrix; 10/10 providers structurally parity-fixed across cycles 3 and 4. Field-validation gap (behavioral verification per provider) remains as residual work tracked in #1336.
- Evidence-type taxonomy extension: introduces `deployment-scripted` as an intermediate evidence type between `static-flagged` (file:line reference only) and `scripted` (CI-verifiable behavior). Stronger than static-flagged because it confirms deployment delivers right files to right paths; weaker than full scripted because it does not verify agent behavior on the provider.

### Closed Issues

- #1335 — Workstream B: ship `aiwg use` project-isolation warning
- #1337 — Workstream C: wizard design doc + Cognitive Walkthrough
- #1339 — Workstream E: provider read-access audit
- #1340 — Workstream F: engagement-surface design + trust-calibration framework
- #1341 — Workstream G: 3 empirical questions (informal-but-directional)
- #1343 — Deploy skill-discovery rule to all 8 missing providers
- #1346 — Warp: aggregate aiwg-utils rules into WARP.md
- #1347 — Hermes: surface skill-discovery via MCP + AGENTS.md priming

### Open by Design

- #1336 — Workstream A hookup audit (partial-pass; field-validation sprint required)
- #1338 — Workstream D global-install ADR (awaiting 5-day Discord/Telegram comms window)
- #1342 — Citation-validate sweep (dormant per epic; gated on R-010 mitigation)
- #1344 — Inline discover-first protocol into AIWG.md / WARP.md / copilot-instructions.md (template fragment ready; AIWG.md generator wiring deferred)
- #1345 — Investigate OpenClaw skills-count anomaly

[2026.5.5]: https://git.integrolabs.net/roctinam/aiwg/compare/v2026.5.4...v2026.5.5

## [2026.5.4] - 2026-05-13 — "Hermes parity — full MCP surface"

29 issues (5 epics + 18 stories + 1 hotfix + 5 use cases) closing the
Hermes integration gap. Before this release, Hermes users could reach
only a small fraction of AIWG via MCP — five tools, one a stub. After this
release, Hermes users have feature parity with every other AIWG-supported
provider: 12 core MCP tools always-on, 45+ available via opt-in toolsets,
all 385 standard skills natively discoverable, top-6 CRITICAL rules
inlined into AGENTS.md priming.

### Why this matters to users

| What changed                                          | What it gives you                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standard skills (~385) now reachable from Hermes**  | Earlier AIWG versions deployed standard skills to `~/.hermes/.aiwg/skills/` — a sibling of Hermes's scanned root, invisible to Hermes's `os.walk()`. Moved to `~/.hermes/skills/.aiwg/` (child of scanned root; recursively discovered). Verified against Hermes v0.13.0 `agent/skill_utils.py:478-489`.            |
| **MCP `discover` + `*-list`/`*-show` tool pairs**     | The post-#1212 discoverability surface (skills, commands, rules, agents, templates) is now reachable over MCP. Hermes can semantic-search AIWG capabilities and fetch full bodies on demand without project-context preload.                                                                                        |
| **`mcp_aiwg_command_run`**                            | One tool dispatches to any of the ~94 allow-listed AIWG CLI commands. Replaces the `workflow-run` stub (which returned parsed metadata but never executed). `shell: false` spawn, destructive ops gated behind `confirmed: true`.                                                                                   |
| **8 opt-in subsystem toolsets**                       | `AIWG_MCP_TOOLSETS=memory,kb,research,activity-log,index,ralph,mc,ops` (or `=all`) exposes 45+ additional tools. Default surface stays lean (~2.5K tokens schema) for small-context local Ollama; toolsets scale on demand.                                                                                         |
| **Top-6 CRITICAL rule priming in AGENTS.md**          | The highest-enforcement AIWG rules (no-attribution, anti-laziness, citation-policy, token-security, versioning, ops-safety) are inlined into the generated AGENTS.md as a ~3K-char priming block. The remaining 23 rules reachable on demand via `mcp_aiwg_rule_show`. AGENTS.md stays well under Hermes's 20K cap. |
| **`.hermes.md` thin pointer emitted at project root** | Hermes loads `.hermes.md` first (priority over AGENTS.md per `agent/prompt_builder.py:1417-1456`). The pointer keeps the actual content in AGENTS.md so it stays usable by other providers (Claude Code, Codex, Cursor). Resolves #1239 doc-debt.                                                                   |
| **Curator-protection for AIWG kernel skills**         | Hermes v0.12.0+ Curator archives stale skills on a 7-day cycle. AIWG-deployed kernel skills are now registered in `~/.hermes/skills/.bundled_manifest` so the Curator excludes them (verified at `tools/skill_usage.py:155-176`). Standard skills under `.aiwg/` are already protected by the dot-prefix rule.      |
| **`delegate_task` API hotfix**                        | Earlier versions of the deployer shipped `delegate_task(skip_context_files=True, skip_memory=True)` in the generated AGENTS.md. Those parameters do not exist on Hermes's actual signature — they're hardcoded internally. Replaced with the correct `delegate_task(goal="...", context="...")` form.               |
| **Idempotent skill-path migration helper**            | Existing operators with skills at the legacy path get them automatically cleaned up on the next `aiwg refresh --provider hermes`. Hash-matches before removal so user-authored files are never touched.                                                                                                             |
| **Hermes-quickstart refreshed against v0.13.0**       | All `agent/`, `hermes_cli/`, `tools/mcp_tool.py` file:line references in the quickstart re-verified against the current Hermes release (commit `942adf6`). Previous docs targeted v0.4.0; refs were drifted by hundreds of lines.                                                                                   |
| **CI drift verifier**                                 | `tools/verify-hermes-citations.mjs` walks every Hermes citation in AIWG docs and verifies it against the pinned Hermes version. CI runs on every PR touching Hermes docs. Pin: `HERMES_VERIFIED_VERSION = '0.13.0'`.                                                                                                |

### Added

- **MCP discovery toolset** (`src/mcp/tools/discovery.mjs`): `discover`, `skill-list`/`-show`, `command-list`/`-show`, `rule-list`/`-show`, `agent-show`, `template-list`/`-show`. All read-only, global-allowed. Spawns `aiwg discover --json` / `aiwg show --json` subprocess for parity with CLI behavior.
- **MCP `command-run` tool** (`src/mcp/tools/command-run.mjs`): allow-listed dispatch against `src/extensions/commands/definitions.ts`. `spawn(cmd, args, {shell: false})` — never shell-interpreted. Destructive commands require `confirmed: true`.
- **8 opt-in MCP subsystem toolsets** (`src/mcp/tools/subsystems.mjs`): memory + reflections, kb, provenance + research-store, activity-log, index, ralph (session-id async pattern), mc (Mission Control), ops. Enabled via `AIWG_MCP_TOOLSETS=<csv>` env var or `aiwg mcp serve --toolsets=<csv>` flag. `=all` enables every known toolset.
- **`generateHermesMd()`** in Hermes deployer: emits `.hermes.md` thin pointer at project root.
- **`updateBundledManifest()`** in Hermes deployer: registers AIWG kernel skills with the Curator for archival exclusion. Preserves pre-existing manifest entries.
- **`migrateLegacySkillPath()`** in Hermes deployer: idempotent cleanup of the legacy `~/.hermes/.aiwg/skills/` path after the new path is verified populated.
- **`tools/verify-hermes-citations.mjs`**: drift detector for Hermes source citations in AIWG docs.
- **`.gitea/workflows/hermes-citations.yml`**: CI workflow runs the verifier on PRs touching Hermes docs.
- **17 new unit tests** in `test/unit/mcp/helpers.test.ts` and `test/unit/mcp/subsystems.test.ts`. All MCP tests passing (46/46).
- **SDLC corpus** in `.aiwg/`: architecture sketch (`sketch-hermes-mcp-parity.md`), risk register, test strategy, 5 use cases (`UC-HMP-{001..005}`).

### Changed

- **`paths.skills`** in `tools/agents/providers/hermes.mjs` moved from `~/.hermes/.aiwg/skills/` to `~/.hermes/skills/.aiwg/`.
- **`generateAgentsMd()`** expanded to inline top-6 CRITICAL rule directives (~3K-char priming block, well under Hermes's 19K hard cap; soft warn at 15K). Pointer to `mcp_aiwg_rule_show` for the other 23 rules.
- **`docs/integrations/hermes-quickstart.md`** refreshed against Hermes v0.13.0. Replaced "What's New in v0.4.0" with "Version compatibility" table. File:line refs updated.
- **`docs/providers/hermes-skill-fields.md`** adds a "Curator protection" section.
- **`docs/cli-reference.md`** documents `aiwg mcp serve --toolsets=` flag and the new core tool surface.
- **`CLAUDE.md`** multi-platform table updated for Hermes; special-cases footnote added.

### Deprecated

- **`workflow-run` MCP tool**: was always a stub. Response body now carries `{deprecated: true, replacement: 'mcp_aiwg_command_run', ...}`. Tool kept for back-compat; new code should use `command-run`.

### Fixed

- **Broken `delegate_task` API in generated Hermes AGENTS.md** (`tools/agents/providers/hermes.mjs:117`). The example `delegate_task(skip_context_files=True, skip_memory=True)` referenced parameters that do not exist on Hermes's actual signature. Replaced with `delegate_task(goal="...", context="...")` plus a one-line note. Every Hermes user since the integration shipped was getting broken example code.

### Issues closed

H1 #1305, E1 #1306, E2 #1307, E3 #1308, E4 #1309, E5 #1310, S20 #1311, S1 #1312, S2 #1313, S4 #1314, S3 #1315, S5 #1316, S6 #1317, S7 #1318, S8 #1319, S9 #1320, S21 #1321, S10 #1322, S11 #1323, S12 #1324, S13 #1325, S14 #1326, S15 #1327, S17 #1328, S22 #1329, S23 #1330, S16 #1331, S18 #1332, S19 #1333 (deferred — no trigger in static tool surface).

## [2026.5.3] - 2026-05-13 — "Mini Shai-Hulud — supply-chain hardening complete"

The full v2026.5.3 release. Every signed-release control modeled in the Mini Shai-Hulud planning doc (#1278) is now wired into the publish pipeline and verified end-to-end against a real release cycle. The pre-releases earlier in this line (rc.0, rc.1) were internal pipeline checkpoints; this is the public release the audit was leading up to.

### Why this matters to users

| What changed                                          | What it gives you                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npmjs.org provenance attestation**                  | Every published tarball carries a Sigstore-anchored attestation linking it to a specific GitHub Actions workflow run and source commit. Verify with `npm view aiwg@2026.5.3 --json \| jq .dist.attestations` or `npm audit signatures`.                                                               |
| **Cosign keyless tarball signature**                  | Registry-independent signature over the tarball bytes. Works whether you pulled from npmjs.org, Gitea bundled npm, or any mirror. Verify with `cosign verify-blob`.                                                                                                                                   |
| **CycloneDX SBOM (signed)**                           | Full direct + transitive dep inventory shipped as a release asset and signed with the same Sigstore identity. Feed into Grype/Trivy/Dependency-Track for vulnerability scans.                                                                                                                         |
| **Signed maintainer git tag**                         | Tag is gpg-signed by `AIWG Release Signing <release@aiwg.io>` (fingerprint `FE9272F0BC5781E1DE77FAAA719AB63879E84CE8`, ed25519, expires 2031-05-11). CI refuses to publish any release whose tag does not verify.                                                                                     |
| **6 signed assets on both GitHub and Gitea releases** | Tarball + .sigstore, release manifest + .sigstore, SBOM + .sigstore — mirrored across both registries so verification works regardless of where you got AIWG.                                                                                                                                         |
| **Tarball top-level allowlist**                       | Every release lints what gets included in the published tarball. No surprise files.                                                                                                                                                                                                                   |
| **`npm audit signatures` gate at publish time**       | The publish step itself runs `npm audit signatures` against the dep tree. If a dep's registry signature is invalid, the publish blocks.                                                                                                                                                               |
| **7-day release-age gate**                            | `npm install`/`npm update` against AIWG (and any project that opts in to the same pattern) refuses to resolve dependency versions younger than 7 days. Newly-published malicious versions can no longer enter your lockfile. **Requires npm 11.5+ on your dev machine** — `npm install -g npm@^11.5`. |
| **Dep-source policy lint**                            | `npm run lint:dep-sources` blocks `git+`, `github:`, tarball-URL, `file:`, `link:` dep sources in `package.json` and `package-lock.json`. Runs every CI build.                                                                                                                                        |
| **Pinned CI containers + actions**                    | Every CI workflow pins containers by sha256 digest and actions by 40-char commit SHA. The pin manifest lives in `ci/digests.txt`. No `:latest` anywhere in production paths.                                                                                                                          |

### Adopting the same pattern in your projects

This release ships new skills for downstream users who want to harden their own npm packages the same way:

- `supply-chain-hardening-quickstart` — orchestrates the user-side hardening pass
- `npm-supply-chain-audit` — audits lifecycle scripts, Git dependency sources, publish-token exposure, and verifier docs
- `npm-release-age-gate` — configures and reviews 7-day / 10-day release-age policies
- `supply-chain-trust` — covers signed tags, provenance, tarball signatures, SBOMs, pinning, and broader trust-chain design

See `docs/security/supply-chain-hardening.md` for the end-to-end walkthrough. The release-publisher note is explicit: npm trusted publishing requires npm 11.5.1+ and Node 22.14+; AIWG's release workflow uses Node 24 so the current npm 11.x line is available without a workflow-local npm upgrade.

### Requirements for the supply-chain controls to be effective

- **Consuming AIWG**: Node 20+ stays fine for the CLI. Provenance verification is optional but recommended — `npm install -g npm@^11.5` to enable `npm audit signatures` and the release-age gate to fire on your machine.
- **Contributing to AIWG**: npm 11.5+ on your dev machine. The release-age gate fires on every `npm install`/`npm update` — without it, the protection is missing.
- **Adopting the pattern for your own packages**: Node 22.14+ and npm 11.5.1+ for OIDC trusted publishing on npmjs.org. Or jump straight to Node 24.x, which is what AIWG's CI now runs on.

### References

- `docs/releases/v2026.5.3-announcement.md` — full release announcement
- `docs/security/supply-chain-hardening.md` — apply the same pattern to your own package
- `docs/releases/verifying.md` — verify an AIWG release end-to-end
- `SECURITY.md` — maintainer signing key fingerprint, private reporting channel
- [#1278](https://git.integrolabs.net/roctinam/aiwg/issues/1278) — supply-chain hardening epic (Track A close-out)

## [2026.5.3-rc.1] - 2026-05-12 — "Mini Shai-Hulud — OIDC-only publish path"

Supersedes [2026.5.3-rc.0]. Three CI fixes since rc.0 plus a workflow-deactivation pass to clear the dual-publish race that prevented provenance attestation from landing.

### Fixed in CI

- **Signed-tag verify on tag-push checkout**. `actions/checkout@v4` on tag-push events writes `refs/tags/<tag>` as a commit ref (not the tag object) by default, so `git tag -v` failed with "cannot verify a non-tag object of type commit." Adding `fetch-tags: true` to the checkout produced a refspec collision (both fetches target `refs/tags/<tag>`). Fix: explicit `git fetch +refs/tags/X:refs/tags/X --depth=1` step after checkout (commits `33cf1c77` + `0fa4dd52`).
- **Disabled Gitea-side npmjs.org publish** to clear the race that landed rc.0 without provenance. The Gitea workflow's `NPMJS_TOKEN`-based publish won the race against the GH Actions OIDC path, leaving npmjs.org's `aiwg@2026.5.3-rc.0` without a provenance attestation. rc.1 ships with the four Gitea npmjs.org publish/affirm steps `if: false`-gated and the GH Actions OIDC workflow as the sole publisher. NPMJS_TOKEN stays in Gitea (unused) pending operator revocation after rc.1 verifies clean.

### What rc.1 verifies

Same pipeline as rc.0 plus the fixes above:

- Cryptographically signed git tag (#1299 / A9) — verified
- OIDC trusted publishing on npmjs.org with provenance attestation (#1283 / A5) — **now actually exercised**
- Cosign keyless tarball signing with `.sigstore` bundles (#1287 / A8) — fires from the GH Actions workflow
- CycloneDX SBOM via syft (#1288 / A13) — fires from the GH Actions workflow
- `npm audit signatures` gate (#1288 / A12) — green at publish time
- Tarball top-level allowlist (#1288 / A11) — green
- 7-day release-age gate (#1290 / A15) — enforced via npm 11.5+
- Dep-source policy lint (#1300 / A20) — green

Operator follow-ups (now unblocked): revoke NPMJS_TOKEN on Gitea + npmjs.org once rc.1 lands clean; delete the `if: false`-gated blocks in a future commit.

## [2026.5.3-rc.0] - 2026-05-12 — "Mini Shai-Hulud supply-chain hardening — Track A complete (no provenance)"

First end-to-end pre-release exercising the new supply-chain pipeline. Track A of the Mini Shai-Hulud hardening campaign (#1278) ships complete across this release: 13 issues across 8 waves landed since v2026.5.2. Wave 9 (user-facing capabilities — Track B) ships in v2026.5.3 stable.

This rc.0 is the first AIWG release published under the new flow: cryptographically signed git tag (#1299), CI verify gate before any publish step, OIDC trusted publishing on npmjs.org with provenance attestation (#1283), cosign keyless tarball signing with `.sigstore` bundles attached to both registries (#1287), CycloneDX SBOM generation (#1288 / A13), `npm audit signatures` gate (#1288 / A12), tarball top-level allowlist (#1288 / A11), 7-day release-age gate (#1290), and dep-source policy lint (#1300). The full risk-closure tally is 9 of 10 modeled scenarios fully closed; the remaining one (S9) is deferred to a separate AI-runtime-boundary threat model per planning doc § Out of Scope.

### Highlights

| What changed                                | Why you care                                                                                                                                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signed tags + cosign tarball signatures** | Every release artifact is verifiable offline against a maintainer key + Sigstore transparency log. Consumers verify with `cosign verify-blob` per `docs/releases/verifying.md`.                                                                                             |
| **npm provenance attestation**              | npmjs.org publishes carry a provenance attestation linking the tarball to the GitHub Actions workflow run + source commit SHA. Verify with `npm view aiwg@<v> --json \| jq .dist.attestations`.                                                                             |
| **6 signed release assets per release**     | Tarball, tarball .sigstore, release-manifest.json, manifest .sigstore, CycloneDX SBOM, SBOM .sigstore — present on both GitHub and Gitea releases.                                                                                                                          |
| **Release-age gate**                        | npm refuses to resolve any dependency version published less than 7 days ago. Newly-published malicious versions can no longer enter the lockfile during contributor `npm install`/`npm update`. Requires npm 11.5+ — `npm install -g npm@^11.5` once on every dev machine. |
| **Dep-source lint**                         | `npm run lint:dep-sources` blocks `git+`, `github:`, tarball-URL, `file:`, `link:` dependency sources in `package.json` and `package-lock.json` — every CI run, not just at publish time.                                                                                   |
| **Removed postinstall lifecycle hook**      | The script was benign, but the _capability_ was the Shai-Hulud propagation primitive. `aiwg doctor` now handles the PATH-check UX.                                                                                                                                          |

### Security

- **PR-trigger workflow audit + same-repo guards** (#1289 — Wave 8 of #1278). Audit finding F7 / threat scenario S2 (workflow injection / fork-PR secret extraction) called for an audit of every `.gitea/workflows/` workflow that triggers on `pull_request`. Primary-source review of the Gitea source code at [`models/secret/secret.go` `GetSecretsOfTask`](https://github.com/go-gitea/gitea/blob/main/models/secret/secret.go) lines 160-165 settled the open question from #1284's audit notes: user-defined secrets (`NPM_TOKEN`, `NPMJS_TOKEN`, `GT_ACCESS_TOKEN`) are NOT exposed to fork PRs by default in current Gitea — only the auto-issued `GITHUB_TOKEN`/`GITEA_TOKEN` per-run token is, and that token is further clamped by `models/actions/token_permissions.go` `restrictCrossRepoAccess`. The audit walked the five PR-triggered workflows: `docsite-build.yml` (fork-PR guard from #1284 already in place; comment updated to reference this audit), `skill-lint-pr.yml` (only references the auto-issued per-run token, not a user secret; security analysis documented inline at top of file so future reviewers don't re-litigate it), `metadata-validation.yml` (no secret references; confirmed PR-safe), `ci.yml` (no secret references; install-script surface mitigated by A15 #1290 release-age gate and A20 #1300 dep-source lint), `conformance.yml` (label-gated via `conformance:full` for PR runs; verified working). A new "PR-trigger workflow hardening" section in `.gitea/workflows/README.md` documents the reusable guard snippet (two variants — fork-PR guard `if: ${{ gitea.event.pull_request.head.repo.fork != true }}` and same-repo guard `if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}`), explains why step-level guards are preferred over job-level (preserves fork-PR validation value), and explains why `pull_request_target` is not the right answer here. Per-workflow disposition matrix + alternatives (blanket no-secrets rule, `pull_request_target`, manual `/safe-to-test` label gate, dedicated PR-runner pool) recorded in `.aiwg/architecture/adr-pr-trigger-hardening.md`. Criticality is informational + defense-in-depth: Gitea's runtime already does the right thing; the guard on `docsite-build.yml` survives the runtime-regression scenario, and the documentation makes the secret-handling intent local-and-visible in each workflow rather than implicit-and-global. No workflow logic changed beyond the docsite comment update; the surface of `grep -n "secrets\." .gitea/workflows/*.yml` is unchanged.
- **Release-age gate on dep resolution** (#1290 — Wave 7 of #1278). New `.npmrc` at repo root sets `min-release-age=7`: npm refuses to resolve any dependency version published less than 7 days ago into the lockfile. Closes the brand-new-malicious-publish-window attack class (the same Mini Shai-Hulud pattern that triggered the rest of #1278) — a freshly published malicious version of a transitive dep can no longer enter AIWG's tree during a contributor's `npm install <pkg>` or `npm update`; the gate forces it to survive 7 days of public exposure first, giving npm, the maintainer, and the security community time to notice and yank. The 10-day high-sensitivity profile is documented as an `AIWG_MIN_RELEASE_AGE_HIGH=10` env-var override pattern for publish workflows + major version bumps. `min-release-age` requires npm 11.5+ — earlier versions silently ignore the config — so contributor docs (`docs/contributing/versioning.md` § Release-age policy) make the requirement explicit, and both publish workflows (`.gitea/workflows/npm-publish.yml`, `.github/workflows/npm-publish.yml`) now run `npm install -g npm@^11.5` before `npm ci` as defense-in-depth (CI's `npm ci` against a locked tree is a no-op for the gate, but publish is the most security-sensitive moment AIWG has and the upgrade costs ~5s). The release-age gate is the seventh and final Wave 7 control of the supply-chain hardening campaign; the workspace-migration spike (#1301 / A21) closed as a no-op with the ADR at `.aiwg/architecture/adr-pnpm-workspace-migration.md` recording why `.npmrc` is the right shape over `pnpm-workspace.yaml minimumReleaseAge` given AIWG's current monorepo state. Threat-model effect of either shape is equivalent — both block the same attack class — but the `.npmrc` path costs zero workflow migration and zero refactoring of `src/serve/executor-registry.ts`'s ajv createRequire pattern. Contributors: run `npm install -g npm@^11.5` once on every dev machine. Operators: the gate is silently ignored by older npm but the threat model isn't degraded (existing `npm ci` paths weren't the attack surface — lockfile-regeneration was). Companion docs updated: `docs/contributing/dependency-sources.md` § Lockfile regeneration + the release-age gate notes the interaction with A20.
- **Publish-time evidence — tarball audit, audit signatures, SBOM** (#1288 — Wave 6 of #1278). Three publish-time CI gates land together: A11 (tarball top-level allowlist), A12 (`npm audit signatures` gate), and A13 (CycloneDX SBOM via syft). A11 catches the Mini Shai-Hulud injection class where an attacker pushes a commit that adds a new file at the tarball ROOT (`router_init.js`, `prepare.sh`); without A11, A8's cosign signature would happily sign the tampered artifact because A8 attests "this came from our workflow," not "this matches a known structure." A new scanner at `tools/lint/tarball-audit.mjs` runs `npm pack --dry-run --json`, extracts unique top-level entries, and diffs against `ci/expected-tarball-top-level.txt` (12 entries: `agentic`, `apps`, `bin`, `CLAUDE.md`, `dist`, `LICENSE`, `man`, `package.json`, `plugins`, `README.md`, `templates`, `tools`). A12 closes the upstream-package-compromise gap A20 (#1300) couldn't reach: another scanner at `tools/lint/audit-signatures.mjs` runs `npm audit signatures --json` and cross-references failures against a time-bounded waiver file at `ci/npm-audit-signatures-waivers.yaml` — "invalid" signatures are never waiveable (tampering signal); "missing" signatures are waiveable with a non-expired entry; expired waivers fail. Current state: zero waivers, all 377 packages have verified registry signatures. A13 adds CycloneDX SBOM generation via syft v1.18.0 — chosen over `@cyclonedx/cyclonedx-npm` because it's a single Go binary with zero npm-dep-graph impact (the npm alternative would add a multi-dep build tool to a workflow whose entire point is reducing dep surface). syft is installed from a tag-pinned raw GitHub URL (`raw.githubusercontent.com/anchore/syft/v1.18.0/install.sh`) with the install script's SHA-256 logged on every CI run for drift detection; strict-SHA enforcement is opt-in via a commented `ENFORCE_INSTALL_SHA` block the operator fills after the first verified run. SBOM is signed with the same keyless cosign OIDC identity that signs the tarball and manifest, producing `aiwg-X.Y.Z.cdx.json.sigstore`. All wired into `.gitea/workflows/npm-publish.yml` (both pre-release and stable jobs, before any publish step), `.github/workflows/npm-publish.yml` (same), AND `.gitea/workflows/ci.yml` for A12 only (so signature regressions surface on every push, not just at publish time). `.gitea/workflows/upload-release-sigs.yml` extended to mirror the two new SBOM assets to the Gitea release alongside the existing four — six release assets total per release going forward. Consumer-facing SBOM verification documented in `docs/releases/verifying.md` with the same `cosign verify-blob` invocation pattern as the tarball signature, plus SCA-scanner integration examples (Grype, Trivy, Dependency-Track). ADR at `.aiwg/architecture/adr-publish-time-evidence.md` documents rationale, alternatives (exact-file-list manifest, hard-fail-no-waivers, `@cyclonedx/cyclonedx-npm`, `anchore/sbom-action`), and trade-offs (syft install-script pinning model, A12 waiver expiry semantics, A11 maintenance touch frequency).
- **Cosign keyless tarball signing on every release** (#1287 — Wave 5 of #1278). Audit finding F8 / threat scenario S4 (mid-flight tarball replacement on a mirror) called for an artifact-level, registry-independent signature alongside the npm provenance attestation (#1283 / A5 — which only travels with npmjs.org metadata) and the signed git tag (#1299 / A9 — which proves who tagged, not what was built). Wave 5's A8 closes the gap: after `npm publish --provenance` succeeds, `.github/workflows/npm-publish.yml` now installs cosign v2.6.1 via `sigstore/cosign-installer@v3.10.1` (SHA-pinned `7e8b541eb2…` in `ci/digests.txt`) and runs `cosign sign-blob --bundle` against the published tarball using the workflow's ambient GitHub Actions OIDC token. The bundle format produces a single self-contained `.sigstore` file carrying signature + Fulcio short-lived cert + Rekor transparency-log entry, verifiable offline against the public Sigstore log. A `release-manifest.json` containing tarball SHA-256, version, tag object SHA, commit SHA, and workflow run URL is also signed, providing an audit bridge between the published artifact and this CI run. All four assets (tarball, tarball `.sigstore`, manifest, manifest `.sigstore`) land on the GitHub release via the workflow's ephemeral `GITHUB_TOKEN`. A new manual operator workflow at `.gitea/workflows/upload-release-sigs.yml` (`workflow_dispatch` with a tag input) mirrors the four assets to the Gitea release using `gh release download` against the public GitHub mirror (no GH auth) plus the existing `NPM_TOKEN` for the Gitea release-asset API — no new write token required, deliberately avoiding the token-surface expansion the alternative auto-mirror would have caused. Consumer-facing verification documented in `docs/releases/verifying.md` (now covers all three controls: provenance, signed tag, cosign signature). Release runbook in `docs/contributing/versioning.md` documents the one-command post-release sig-mirror ritual. ADR at `.aiwg/architecture/adr-tarball-cosign-signing.md`. The cosign signature is registry-independent — verifies the same way regardless of which registry the tarball came from, closing the long-standing "Gitea-bundled-npm install has no provenance chain" gap that #1286 (A10) could only address with operator-hygiene controls. Forward-going only: releases before the first A8 publish do not carry `.sigstore` bundles.
- **npmjs.org publishing moves to GitHub Actions with OIDC trusted publishing + provenance** (#1283 / spike #1295 — Wave 4 of #1278). The audit (finding F2, threat-model scenario S1 — release-key compromise) called for retiring the long-lived `NPMJS_TOKEN` in favor of npm trusted publishing. As of 2026-05-12 the [npm trusted-publishers documentation](https://docs.npmjs.com/trusted-publishers) lists GitHub Actions and GitLab CI/CD as supported providers — Gitea Actions is not in the matrix, and the runtime requires Node 22.14.0+ and npm 11.5.1+ regardless of provider. Spike #1295 picked the GH-Actions path on the existing public mirror (`github.com/jmagly/aiwg`); this commit ships the new workflow. New file `.github/workflows/npm-publish.yml` triggers on tag push to the mirror, sets `permissions: id-token: write` to enable OIDC negotiation against npmjs.org, runs `tools/ci/verify-signed-tag.sh` (#1299 / A9) as the same hard cryptographic gate as the Gitea workflows use, builds and tests, runs `npm publish --provenance --access public`, then verifies the provenance attestation actually landed (`npm view aiwg@<v> --json | jq .dist.attestations` must be non-null — catches the failure mode where publish succeeds but provenance silently doesn't emit), and finally verifies the dist-tag points at the new version. The workflow container is `node:22@sha256:62e4daa6…` (22.22.2-bookworm) per the pinning policy; `actions/setup-node@49933ea5…` (v4.4.0) is the new SHA pin. Both pins land in `ci/digests.txt`. The Gitea-side `.gitea/workflows/npm-publish.yml` keeps both legs operational during the transition with deprecation-comment blocks documenting the phase-out. Operator removes the Gitea-side npmjs.org publish steps + revokes `NPMJS_TOKEN` after the first verified OIDC release on the GH mirror. Consumer-facing verification procedure (provenance + signed-tag) at `docs/releases/verifying.md`. ADR at `.aiwg/architecture/adr-npmjs-org-via-github-actions.md`. Pairs with #1286 (A10 — Gitea compensating controls) which governs the Gitea-registry leg that stays on Gitea Actions.
- **Gitea release-gate compensating controls** (#1286 — Wave 4 of #1278). Gitea Actions ignores the `environment:` keyword (see [docs.gitea.com/usage/actions/comparison](https://docs.gitea.com/usage/actions/comparison)) so the GitHub-Actions-style deployment-protection-rule surface is unavailable for the Gitea-side publish flow. Audit finding F6 asked for a bundle of compensating controls. What lands here is the bundle's "release-record + operator hygiene" half: `gitea-release.yml` now embeds a permanent approval record (`Approved by: <github.actor>` + UTC timestamp) into every Gitea release body, sitting next to the artifacts where any consumer can audit it; `.gitea/workflows/README.md` gains a "Release-secret policy" section documenting `NPM_TOKEN` (Gitea API token, `gta_…`) vs `NPMJS_TOKEN` (npmjs.org token, being phased out by #1283) vs `GT_ACCESS_TOKEN` (docsite-only); and `docs/contributing/secret-rotation.md` documents the quarterly Gitea `NPM_TOKEN` rotation procedure with emergency triggers (maintainer offboarding, suspected runner compromise, audit-log anomaly) and a verify-on-pre-release-tag-push pattern that revokes the old token only after the new one succeeds. The bundle's hard gate is A9's signed-tag verify (#1299, already shipped) — that's the cryptographic anchor this layers on top of. A dedicated publish runner was scoped into A10 but deferred to operator scheduling. ADR at `.aiwg/architecture/adr-gitea-release-compensating-controls.md`.
- **Signed-tag verification gate on release-bearing workflows** (#1299 — Wave 3 of #1278). Every release-tag push must now cryptographically verify against a maintainer public key published in the repo before any publish/release-creation step runs. The gate is implemented as `tools/ci/verify-signed-tag.sh` and wired into `.gitea/workflows/npm-publish.yml` (both pre-release and stable publish jobs) and `.gitea/workflows/gitea-release.yml`. Supports both GPG (`.gitea/keys/maintainers.asc`) and SSH allowed-signers (`.gitea/allowed_signers`) — operator picks; both can co-exist. Closes scenario S2 (workflow injection) and provides the cryptographic anchor that #1286 (A10 — compensating controls) and #1283 (A5 — trusted publishing) build on in Wave 4. Operator-side setup (key generation + publication + first signed-tag verification end-to-end) is documented in `docs/contributing/versioning.md` and tracked as the remaining open item on #1299 until the first signed-tag release lands. ADR at `.aiwg/architecture/adr-signed-tag-verify.md`. Historical tags (`v2026.5.2` and earlier) are not retroactively signed — the gate is forward-going only.
- **Dependency source policy lints unexpected git/tarball/exotic deps** (#1300 — Wave 2 of #1278). New CI step (`npm run lint:dep-sources`, wired into `.gitea/workflows/ci.yml` after `npm ci`) scans `package.json` (direct + dev + optional + peer deps) and `package-lock.json` (transitive `resolved` URLs) for six forbidden source patterns — `git+*`, `git://`, `github:owner/repo`, `file:`, `link:`, and non-registry tarball URLs — and fails the build on any match unless the source is on an explicit committed allowlist at `ci/dep-source-allowlist.yaml`. Closes the Mini Shai-Hulud dep-injection vector (control C22, threat-model scenario S5 dep-injection variant) where a single `optionalDependencies` `git+` entry triggers arbitrary `prepare`-script execution at install time with secrets in scope. Implementation is a 250-line standalone Node script (`tools/lint/dep-source.mjs`) with one dep — adding a third-party validator framework to a control whose purpose is reducing dep surface would be self-defeating. Initial allowlist is empty (the survey at implementation time confirmed AIWG has zero exotic dep sources). ADR at `.aiwg/architecture/adr-dep-source-policy.md`; contributor doc at `docs/contributing/dependency-sources.md`. If/when #1301 (A21 pnpm spike) lands, the lockfile scan re-points at `pnpm-lock.yaml` and the lint stays in place as defense-in-depth alongside pnpm's native `blockExoticSubdeps`.
- **Pinned CI containers and actions by immutable digest/SHA** (#1281, #1282 — Wave 2 of #1278). Every `container:` and `uses:` reference in `.gitea/workflows/` now uses `@sha256:<digest>` or `@<40-char-commit-SHA>` with a trailing version comment, eliminating the tag-repointing attack surface (audit findings F3 + F5; threat-model scenario S5 — builder image hijack / action-repo compromise → CI RCE with secrets in scope). Pin manifest at `ci/digests.txt` tracks resolved version, pin date, and update rationale per row; policy + bump procedure documented at `.gitea/workflows/README.md`. Current pins: `node:20@sha256:8f693eaa…` (resolves to 20.20.2), `actions/checkout@34e11487…` (v4.3.1), `actions/upload-artifact@ea165f8d…` (v4.6.2). Closes the `dev-idempotent-builds.md` rule 2 + rule 4 violations.
- **Removed `scripts.postinstall` lifecycle hook from `package.json`** (#1279). The postinstall script body was benign — it printed PATH-setup guidance after `npm install -g aiwg` — but the _capability_ is the highest-residual-risk supply-chain primitive in the audit (finding F1, threat scenario S3, Aikido report 2026-05-12). Had AIWG ever been compromised, the hook would have executed arbitrary attacker code on every install machine before any operator interaction, matching the worm-propagation profile that Shai-Hulud used in March 2026. `bin/postinstall.mjs` has been deleted from the published tarball. The PATH-guidance UX migrated to two surfaces: `aiwg doctor` now runs a PATH sub-step on every invocation and prints the same shell-specific `export PATH` guidance when the binary isn't reachable, and `README.md` gains an "Installation Troubleshooting" section near the top documenting `which aiwg`, the `npm config get prefix` line, and the `npx aiwg` fallback. ADR at `.aiwg/architecture/adr-postinstall-removal.md`.
- **Added `SECURITY.md`** with a documented private reporting channel (`security@integrolabs.net`), Gitea-advisory fallback, response SLA (24h ack / 7d assessment / 90d coordinated disclosure), in-scope / out-of-scope clarification, and safe-harbor language for good-faith researchers. Closes a long-standing operational gap surfaced by the May 2026 Mini Shai-Hulud supply-chain hardening audit (#1285). The project-scoped PGP/age key is queued for follow-up — until it's published under `.github/keys/`, reports are accepted in plain text from a maintainer-controlled address that can negotiate encrypted follow-up.
- **Removed `continue-on-error: true` from stable-publish test step** (#1280). Test failures now block stable publish — previously a regression that broke tests would still ship to npmjs.org. Surfaced a real CLI cold-start drift (`aiwg --version` 134ms → 245ms isolated since 2026-04-22) which has been the masked failure under the now-removed suppression; perf budgets in `test/integration/cli-perf.test.ts` raised to accommodate parallel-load measurements (`--version` 150→800ms, `help` 300→750ms) with #1302 tracking the underlying optimization work.
- **Removed `GT_ACCESS_TOKEN`-in-URL antipattern from `docsite-build.yml` and `docsite-deploy.yml`** (#1284). The previous `git clone https://token:${GT_ACCESS_TOKEN}@...` pattern exposed the token in process arguments visible to `ps`, core dumps, and error output. Replaced with the credential-helper pattern — token lives in a transient `mktemp` file (mode 600, `trap`-cleaned on exit) consumed by `git credential.helper=store`. Added defense-in-depth: `docsite-build.yml` skips the dbbuilder clone for fork-PR events, since Gitea's secret-exposure semantics for fork pull_requests are version-dependent and not currently verified for the running instance (#1289 / A14 will close that question).

## [2026.5.2] - 2026-05-11 — Tester-report sweep, kernel issue/PR skills, config-driven release flow

A multi-commit fix sweep driven by an external tester report (sebuh-infsol via jmagly/aiwg#108–#112). What landed: every CLI bug the tester surfaced is fixed; the discovery-kernel surface now has doctor checks; issue/PR filing guidance is both in `docs/` for humans and in always-loaded kernel skills for agents; the release process itself is now config-driven via `.aiwg/release.config` and the `flow-release` skill.

### Highlights

| What changed                                | Why you care                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`aiwg steward` works end-to-end**         | Both the path resolution bug (#1261) and the schema mismatch (#1262) are fixed. Capability routing is finally usable.                                                                                                                                                                                          |
| **Kernel skills get Claude command stubs**  | `/aiwg-refresh`, `/aiwg-regenerate`, `/aiwg-doctor`, `/aiwg-status`, `/aiwg-help` deploy as `.claude/commands/` entries (#1263). The slash-form is now deterministic instead of churning through agent dialog.                                                                                                 |
| **`aiwg regenerate` is a real CLI command** | Context-only regen of `AIWG.md` + `AGENTS.md` without redeploying frameworks. Faster than `aiwg refresh` when you just need to fix context drift (#1266).                                                                                                                                                      |
| **`aiwg-issue` + `aiwg-pr` kernel skills**  | Filing guidance is always-loaded in your agent context. Templates land in `.gitea/ISSUE_TEMPLATE/` + `.github/ISSUE_TEMPLATE/`. (#1269)                                                                                                                                                                        |
| **`flow-release` orchestration**            | Config-driven release flow consumes `.aiwg/release.config`. Six gates: build/test, CI green, doc-sync, CHANGELOG, README freshness, tag/push, post-release. AIWG itself dogfoods this on 2026.5.2.                                                                                                             |
| **Doctor discovery-availability gate**      | `aiwg doctor` now smoke-probes `discover`, `show`, `index`, `runtime-info` and warns when any is broken (#1264(g)).                                                                                                                                                                                            |
| **Six other CLI fixes**                     | `runtime-info --discover` ENOENT, `aiwg new --help` no longer scaffolds as a side effect, `aiwg catalog` JSON files now ship in `dist/`, three import-path fixes across `workspace-migrate`/`optimize-prompt`/`diversify-content`, doctor doesn't recommend the unimplemented `install-skill-seekers` (#1264). |

### Added

- **`src/cli/handlers/regenerate.ts`** — new CLI handler. `aiwg regenerate [--provider <name>] [--dry-run] [--force] [--no-aiwg-md] [--no-agents-md]`. Invokes the canonical context pipeline (`src/smiths/context-pipeline/`) without redeploying frameworks. Registered in `handlers/index.ts` and the command extension catalog.
- **`agentic/code/addons/aiwg-utils/skills/aiwg-issue/SKILL.md`** — kernel skill for filing issues. Covers template selection, environment capture, duplicate detection, the cross-tracker import flow, and anti-patterns.
- **`agentic/code/addons/aiwg-utils/skills/aiwg-pr/SKILL.md`** — kernel skill for opening PRs. Covers delivery-policy compliance (direct vs feature-branch vs pr-required), the no-attribution rule, the verification gate, CI-green-before-done.
- **`agentic/code/addons/aiwg-utils/skills/steward-prep-delivery/`** — non-kernel skill plus `find-duplicates.sh` helper that searches the AIWG capability index AND the configured Gitea tracker for likely duplicates before filing.
- **`agentic/code/frameworks/sdlc-complete/skills/flow-release/SKILL.md`** — config-driven release orchestration skill. Reads `.aiwg/release.config` and walks gates in order with hard-stop semantics. Owned by the Deployment Manager agent.
- **`agentic/code/frameworks/sdlc-complete/schemas/flows/release-config.yaml`** — JSON Schema for `release.config`. Six gate shapes: steps, invoke_skill, tracker, artifacts, review_diff, actions.
- **`.aiwg/release.config`** — AIWG's own release rules. Seven gates: local-build-test, ci-green, doc-sync, changelog-and-announcement, readme-freshness, release, post-release.
- **`.gitea/ISSUE_TEMPLATE/{bug-report,feature-request,tester-report,imported-report}.md`** and **`.gitea/pull_request_template.md`** — Gitea-native templates with delivery-policy and no-attribution callouts. Mirrored to `.github/` for the public mirror.
- **`docs/contributing/filing-issues.md`** and **`docs/contributing/filing-pull-requests.md`** — human-readable guides matching the kernel skills.
- **`src/cli/find-package-root.ts`** — shared helper that walks up to AIWG's `package.json`, fixing path resolution in `steward.ts` and `providers/capability-matrix.ts` regardless of compiled vs source layout (#1261).
- **`agentic/code/addons/aiwg-utils/skills/aiwg-refresh/run.sh`** and **`aiwg-regenerate/run.sh`** — script entrypoints for kernel skills, with matching `script:` frontmatter blocks. `aiwg run skill aiwg-refresh -- <flags>` now works deterministically across platforms.
- **Discovery-availability doctor checks** — four new probes in `tools/cli/doctor.mjs` for `discover`, `show`, `index`, `runtime-info` (#1264(g)).
- **`.aiwg/aiwg.config` `delivery` block** is now read by `flow-release` to determine commit pattern (existing semantics, now documented in `aiwg-pr` skill body).

### Changed

- **`src/cli/handlers/steward.ts`** — rewrote to import canonical types from `src/providers/capability-matrix.ts` and render the actual `native_features` + `emulation` YAML schema. Feature names accept hyphenated and underscored forms (#1262).
- **`src/providers/capability-matrix.ts`** — path resolver now uses `findPackageRoot()` instead of a fixed-depth `..` walk (#1261).
- **`src/cli/handlers/use.ts`** — extended the Claude command translation pass to deploy kernel-skill stubs for `aiwg-issue`, `aiwg-pr`, and the existing kernel set (#1263).
- **`src/smiths/context-pipeline/aiwg-md.ts`** — strips `@AIWG.md` self-include directives when copying CLAUDE.md → AIWG.md. AIWG.md is the destination of that include; the directive must not survive as a self-reference (#1268). Test updated in lockstep.
- **`src/smiths/toolsmith/runtime-discovery.mjs`** — `#writeCatalog` now `mkdir -p`s the parent dir before writing `runtime.json`. Fixes the ENOENT on a fresh project (#1264(b)).
- **`tools/cli/doctor.mjs`** — replaced the `aiwg install-skill-seekers` recommendation (command never existed) with a pointer to the `skill-factory` addon. Underlying integration is intact via the `doc-intelligence` + `skill-factory` addons from `dca02db1` (#1270 audit closed as not-a-regression).
- **`tools/cli/workspace-migrate.mjs`**, **`tools/cli/optimize-prompt.mjs`**, **`tools/cli/diversify-content.mjs`** — fixed `dist/plugin/` and `dist/writing/` import paths to use `dist/src/plugin/` and `dist/src/writing/` per tsc's `rootDir=.` layout (#1264(e)).
- **`tools/install/new-project.mjs`** — `aiwg new <name> --help` is now side-effect-free; previously scaffolded a project as a side effect of help probing (#1264(f)).
- **`package.json`** build script — `build:copy-mjs` now copies `.json` files too, so `aiwg catalog` data ships in `dist/` (#1264(d)).
- **`agentic/code/addons/aiwg-utils/skills/aiwg-refresh/SKILL.md`** and **`aiwg-regenerate/SKILL.md`** — added `script:` frontmatter and a guardrail directive instructing agent-mediated invocations to defer to the deterministic CLI rather than running multi-step probes.
- **`agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md`** — kernel-skill list updated to include `aiwg-issue`, `aiwg-pr`, `aiwg-regenerate`.
- **`agentic/code/frameworks/sdlc-complete/agents/deployment-manager.md`** — surfaces `flow-release` as the primary release skill ahead of the broader deployment-readiness procedure.
- **`CLAUDE.md`** — CLI command count corrected (~85 → ~94); self-maintenance kernel-skill count corrected (6 → 9); Release Checklist now points at `flow-release` as the canonical driver.
- **`CONTRIBUTING.md`** — links to the new `docs/contributing/filing-issues.md` and `filing-pull-requests.md` guides.

### Fixed

See "Highlights" above. Eight discrete bugs from the tester report; all fixed with regression tests where applicable.

### Closed

- **#1261** AIWG_ROOT path resolution
- **#1262** steward capability matrix schema mismatch
- **#1263** kernel skills lack Claude command stubs
- **#1264** discovery / runtime-info / install-skill-seekers / catalog / migrate-workspace / aiwg-new sub-bugs (sub-item (g) doctor-invariant moved to a follow-up; #1271 tracks the deferred AIWG.md template-selection audit)
- **#1265** imported steward report — closed as duplicate of #1261 + #1262
- **#1266** aiwg-regenerate CLI subcommand + script entrypoint
- **#1267** interactive /aiwg-refresh churn
- **#1268** AIWG.md self-reference (deferred template-selection half tracked in #1271)
- **#1269** PR + Issue templates and contributor guidance
- **#1270** Skill Seekers regression — closed as not-a-regression (integration is intact as `doc-intelligence` + `skill-factory` addons)

Imported from `jmagly/aiwg`: #108, #109, #110, #111, #112 — all closed on the source tracker with thank-you comments to `@sebuh-infsol`.

[2026.5.2]: https://git.integrolabs.net/roctinam/aiwg/compare/v2026.5.1...v2026.5.2

## [2026.5.1] - 2026-05-11 — Hotfix: `aiwg doctor` cannot find `src/channel/manager.mjs` on installed users

A user-reported bug landed within hours of 2026.5.0 cutting: `aiwg --version` and `aiwg --help` worked, but `aiwg doctor` failed on a fresh `npm install -g aiwg` with `Cannot find module 'src/channel/manager.mjs'`. Root cause: three scripts under `tools/cli/` imported from `../../src/channel/manager.mjs` (the source tree), but the npm package only ships `dist/`, not `src/`. Local dev worked because both directories existed; npm-installed users only had `dist/`.

### Fixed

- **`tools/cli/doctor.mjs`** — import changed from `../../src/channel/manager.mjs` → `../../dist/src/channel/manager.mjs` with a comment explaining the npm-package layout. `aiwg doctor` now works on npm-installed AIWG.
- **`tools/cli/version.mjs`** — same fix. (Not user-facing for `aiwg --version` because that path is special-cased in `bin/aiwg.mjs`, but `aiwg sync` invokes this script.)
- **`tools/cli/update.mjs`** — same fix.
- **`tools/cli/validate-writing.mjs`** — replaced the `NODE_ENV === 'production'` gate (which didn't fire on `npm install -g aiwg` because NODE_ENV isn't set) with an `existsSync(distPath)` check that prefers `dist/` when available and falls back to `src/` for dev. Same class of bug as the three above.

### Audit

Other `tools/` scripts that import from `src/` were audited; the following already have correct fallback logic and were not affected:

- `tools/writing/writing-validator.mjs` — try/catch fallback dist → src
- `tools/plugin/plugin-installer-cli.mjs`, `plugin-uninstaller-cli.mjs`, `plugin-status-cli.mjs` — `existsSync(distPath)` || `srcPath`
- `tools/writing/expand-patterns.mjs` — dev-only script not invoked by the CLI

A `_resolve-impl.mjs` shared helper to standardize this resolution across all `tools/` scripts is queued as a follow-up.

## [2026.5.0] - 2026-05-11 — "Project-Local + Kernel-Pivot Maturity"

The 2026.5.0 stable tag. The 2026.4.0 stable tag was never cut — the rc series stopped at `v2026.4.0-rc.33` and rolled forward to `v2026.5.0-rc.1`. Everything from both rc lines, plus the 41 rc cuts of the 2026.5.0 series, is folded into 2026.5.0 stable. There is no `v2026.4.0` git tag and `npm install aiwg@2026.4.0` will not resolve.

### Highlights

| What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why you care                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Discover-first protocol enforcement** (#1249) — Rule 1.5 in `skill-discovery.md` mandates `aiwg discover` BEFORE filesystem search for any AIWG-keyword query. Top-banner Discover-First Protocol on every provider's deployed `RULES-INDEX.md`. All 9 framework quickref descriptions rewritten with explicit `AUTO-INVOKE when user mentions: <triggers>` phrasing. `aiwg-finder` subagent documented as preferred routing when delegation is available.                                                                                                                                                                                   | The discoverability system stops being an "available option" agents skip in favor of fast grep. Driven by real Factory-droid user feedback.                                                                                                                                                                                                                                                            |
| **Hermes integration audit complete** (#1239-#1244, source-verified against Hermes Agent v0.4.0+ at HEAD) — AGENTS.md → 579-byte thin pointer (down from 30 KB+), `.hermes.md` twin gets MCP-specific suffix, `aiwg-orchestrate` skill auto-installs on first deploy, `hermes mcp add` (not `install`), first-match-wins context loading documented, `/reload-skills` / `/reload-mcp` slash commands replace restart guidance, 20K-char `CONTEXT_FILE_MAX_CHARS` cap surfaced. Hermes Capabilities Reference catalogs `/kanban`, `/handoff`, ACP adapter, `/agents`, `/goal`, `/cron`, `/snapshot`, `/background`, gateway platforms, plugins. | Hermes users get an integration that actually matches the upstream code, with every claim citing a Hermes source file/line.                                                                                                                                                                                                                                                                            |
| **Per-platform session reload notice** (#1240) — Every `aiwg use` ends with a "Session reload required:" section naming action + rationale + symptom per provider. Steward agent's Post-Deploy Session Reload table covers all 10 platforms.                                                                                                                                                                                                                                                                                                                                                                                                   | The "Agent type 'X' not found" symptom when a session predates the deploy is now diagnosed at the source — no more chasing imaginary subagent-isolation bugs.                                                                                                                                                                                                                                          |
| **AGENTS.md becomes a thin pointer to AIWG.md** (#1239) — `buildAgentsMd` no longer inlines a 192-entry link-index of every deployed agent. Replaced with a 579-byte thin pointer that references AIWG.md and `aiwg discover` / `aiwg show`. Eliminates four warning classes across all 10 AGENTS.md providers.                                                                                                                                                                                                                                                                                                                                | Codex's 32 KB AGENTS.md cap stops being a constraint; auto-split and per-entry sanitizer warnings go to zero.                                                                                                                                                                                                                                                                                          |
| **`aiwg-regenerate` promoted to kernel skill** (#1245) — kernel set grows from 9 to 10 self-maintenance ops. Natural-language invocation works for "regenerate my CLAUDE.md" without `aiwg discover` round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                               | Operational maintenance task gets first-class always-loaded surface, matching the precedent set for `steward`, `aiwg-doctor`, `aiwg-refresh`, etc.                                                                                                                                                                                                                                                     |
| **Publish pipeline fixes** (#1246, #1247) — `.gitea/workflows/gitea-release.yml` rewritten with `jq -n` JSON construction + explicit HTTP-code handling (replaces a silently-failing inline-escaped curl that hadn't created a Gitea Release object since rc.27). `.gitea/workflows/npm-publish.yml` gets `set -o pipefail` + `defaults.run.shell: bash` + refined error-pattern allowlist (replaces a silently-failing pipeline that hadn't pushed to npmjs.org since rc.27). Operator's `NPMJS_TOKEN` rotation closed the loop.                                                                                                              | Every future rc tag actually creates a Gitea Release and publishes to public npmjs.org. CI no longer reports green for silent failures.                                                                                                                                                                                                                                                                |
| **Architecture overview docs with 8 mermaid diagrams** (#1248) — new canonical `docs/architecture-overview.md` (visual entry point), cross-referenced from `docs/how-it-works.md`, `docs/discovery-and-kernel-skills.md`, `docs/integrations/hermes-quickstart.md`, and README. Image placeholders at `docs/architecture-overview/images/` ready for polished Gemini-generated illustrations (three prompt-set aesthetics: illustrated computing iconography, monospace/terminal, editorial).                                                                                                                                                  | Visual mental model for AIWG's architecture, deploy flow, kernel-vs-standard model, and discovery system finally exists in the docs.                                                                                                                                                                                                                                                                   |
| **Index includes `agentic/code/extensions` + nearest-ancestor type detection** (#1221) — `aiwg discover` and `aiwg show` now surface skills/rules/templates from `agentic/code/extensions/{sys,net,it,sec,stream,dev}` alongside frameworks and addons. `inferType()` reclassified ~380 mistyped artifacts (templates 27→393, +14 commands, +9 hooks, +6 behaviors). Top-level `agentic/code/behaviors/` added to scanDirs.                                                                                                                                                                                                                    | Discovery is honest about what exists. Templates, behaviors, hooks, and the elaboration-stage docs in research-complete are no longer silent `document` entries.                                                                                                                                                                                                                                       |
| **`aiwg use all` deploys frameworks + addons + extensions** (#1222) — extensions are deployed alongside addons; single-extension installs work via `aiwg use <name>`; advisory and unknown-target text honestly describe what `all` does.                                                                                                                                                                                                                                                                                                                                                                                                      | Operators get every capability bundle the corpus ships, not just frameworks + addons.                                                                                                                                                                                                                                                                                                                  |
| **`aiwg discover` / `aiwg show` UX hints on empty results** (#1221) — JSON envelope includes a `hint` field when the framework index is missing or the phrase scores nothing; `aiwg show` falls back to a corpus scan with an "uninstalled" banner.                                                                                                                                                                                                                                                                                                                                                                                            | Agents stop concluding "AIWG doesn't have a skill for that" when the real problem is an unbuilt index.                                                                                                                                                                                                                                                                                                 |
| **Test cleanup: ralph→agent-loop module-resolution drift** (#1210) — 2 stranded vitest `.mjs` files renamed to `.ts` (28 tests now run under `npm test`); `npm run test:node` runs the 14 node:test files in `tools/ralph-external/` and `test/unit/ralph/`.                                                                                                                                                                                                                                                                                                                                                                                   | `npx vitest run` no longer trips on misplaced `.mjs` files. Test runners are explicit and contributor-discoverable.                                                                                                                                                                                                                                                                                    |
| **4 colliding agent renames at framework source** (#1211) — forensics+research `acquisition-agent`, ops `deployment-manager`, marketing `project-manager`, media-curator `quality-assessor` — renamed with framework prefixes; SDLC keeps the canonical names. Cross-references, manifests, READMEs, plugin packager output all updated.                                                                                                                                                                                                                                                                                                       | Operators with multiple frameworks installed no longer hit "first-installed wins" silent muting. Both forks of `acquisition-agent` coexist.                                                                                                                                                                                                                                                            |
| **Sandbox tab tmux cheatsheet** (#1166) — collapsible cheatsheet panel in the `aiwg serve` Sandbox tab's PaneStack with localStorage-persisted toggle. Detach row visually highlighted.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Operators dropped into a tmux session via the sandbox attach flow stop reaching for Ctrl-C when they want to detach.                                                                                                                                                                                                                                                                                   |
| **Cross-provider parity Phase 2 verifications** (#1089, #1159, #1160, #1162, #1163, #1164) — Cursor/Copilot/Warp/Windsurf user-scope deploys documented as **Non-applicable** (in-app settings or cloud-sync mechanisms, not filesystem discovery); Factory verified inline.                                                                                                                                                                                                                                                                                                                                                                   | Operators get clear disposition per provider: harmless mirror at the documented paths but use the provider-native customization mechanism for cross-project work.                                                                                                                                                                                                                                      |
| **3 closed sweeps: skill listing budget, no-copy standard skills, v2026.4.0 release gap** (#1147, #1217, #1142) — kernel pivot resolved the 425-truncation budget issue (`aiwg doctor` now reports 0.10× budget); no-copy default verified; CHANGELOG honest about 2026.4.0 never cutting as stable.                                                                                                                                                                                                                                                                                                                                           | Loose ends from the kernel-pivot epic tied off.                                                                                                                                                                                                                                                                                                                                                        |
| **Claude Code plugin parity for all 8 frameworks** (#1152) — 6 new plugins: `forensics`, `security-engineering`, `research`, `media-curator`, `ops`, `knowledge-base`. Marketplace grew from 7 to 13.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every framework now installs via `/plugin install <name>@aiwg`, not just `sdlc` and `marketing`. Closes the framework→plugin distribution gap.                                                                                                                                                                                                                                                         |
| **Project-local artifact lifecycle (epic #1033)** — full `new-bundle` → `use` → `doctor` → `remove` → `promote` chain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Customize AIWG per project without forking. Bundles graduate to upstream by hash-verified copy (no rewrite) thanks to the identical-form portability invariant ([ADR #1038](.aiwg/architecture/adr-identical-form-portability.md)).                                                                                                                                                                    |
| **`aiwg new-bundle` scaffolding** (#1050)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One command produces a valid manifest + starter artifact + README under `.aiwg/{type}/{name}/`. Aliases: `new-extension`, `new-addon`, `new-framework`, `new-plugin`.                                                                                                                                                                                                                                  |
| **`aiwg promote` graduation** (#1037)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Move a project-local bundle to upstream or a private corpus path. SHA-256 verified copy with rollback on mismatch. `--dry-run`, `--cleanup`, `--force`.                                                                                                                                                                                                                                                |
| **`aiwg remove` is project-local-aware** (#1037)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Reverts deployed files using artifact-hash detection (pristine / mutated / missing / replaced). Source under `.aiwg/<type>/<name>/` is **never** deleted — `--force` only overrides the case-2 mutation prompt.                                                                                                                                                                                        |
| **`aiwg doctor --project-local`** (#1037)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Per-type counts, validation errors, shadows (informational vs blocking), drift detection, provider deployment matrix.                                                                                                                                                                                                                                                                                  |
| **Activity log for project-local lifecycle** (#1037)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 12 design events emitted across deploy/shadow/remove/promote paths to `.aiwg/activity.log` for post-hoc audit.                                                                                                                                                                                                                                                                                         |
| **Comprehensive customization docs** (#1051, #1052)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | New Path A/B/C structure (project-local / fork / corpus), quickstart, lifecycle reference, troubleshooting, from-fork migration, type disambiguation. Old `.aiwg/.project/` docs replaced with redirects.                                                                                                                                                                                              |
| **Corpus architecture & `@$AIWG_ROOT/`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Skills link into the corpus rather than restating it. Token resolves correctly in dev, npm, and custom installs. 1,400+ broken refs fixed.                                                                                                                                                                                                                                                             |
| **Composite skills**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Thin skills = links + minimal framing. Agent follows refs as deep as the task requires. Context efficiency by design.                                                                                                                                                                                                                                                                                  |
| **aiwg-dev addon**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `link-check`, `validate-component`, `dev-doctor` section 4, and `devkit-*` scaffolding skills.                                                                                                                                                                                                                                                                                                         |
| **Skills as canonical type**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | SKILL.md is the source. Commands generated at deploy time. `aiwg add-command` deprecated.                                                                                                                                                                                                                                                                                                              |
| **Daemon — fully operational**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Web UI, YAML profiles, scheduled tasks, Telegram multi-room, autonomous engine, cross-session memory, Docker.                                                                                                                                                                                                                                                                                          |
| **Mission Control**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Parallel agent loops as background missions with live dashboard.                                                                                                                                                                                                                                                                                                                                       |
| **Behaviors — 5th artifact type**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Subscribe to system events, react automatically. Deployed to OpenClaw.                                                                                                                                                                                                                                                                                                                                 |
| **Provider-watcher**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Scheduled provider update detection with automatic PR creation.                                                                                                                                                                                                                                                                                                                                        |
| **SOUL.md agent identity**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Persistent character for agents: worldview, opinions, reasoning traits.                                                                                                                                                                                                                                                                                                                                |
| **Remote install system**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Install frameworks without cloning the repo.                                                                                                                                                                                                                                                                                                                                                           |
| **Project-level `aiwg.config`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Per-project provider registry, deployment manifest, run scripts.                                                                                                                                                                                                                                                                                                                                       |
| **`aiwg sync`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Update + redeploy + health check in one command.                                                                                                                                                                                                                                                                                                                                                       |
| **OpenClaw (10th platform)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | First with native behaviors support.                                                                                                                                                                                                                                                                                                                                                                   |
| **Hermes as first-class platform**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Full deployment target, 96 skills, token-optimized templates.                                                                                                                                                                                                                                                                                                                                          |
| **Copilot & Windsurf overhauls**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Copilot: `.agent.md`/`.prompt.md`/`.instructions.md`. Windsurf: `.windsurf/rules/` with `trigger: always_on`.                                                                                                                                                                                                                                                                                          |
| **ops-complete framework**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | YAML-native ops framework with `sys`, `it`, `dev`, `stream` extensions.                                                                                                                                                                                                                                                                                                                                |
| **RLM enhancements**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `quality_gate`, `preferred_model`, `chunking_strategy`, `batch_size`. Three new examples.                                                                                                                                                                                                                                                                                                              |
| **Composable RULES-INDEX**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Components own their rules indexes. CLI assembles at deploy time.                                                                                                                                                                                                                                                                                                                                      |
| **15-article getting-started series**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Scenario-based guides in user vocabulary.                                                                                                                                                                                                                                                                                                                                                              |
| **aiwg-guide contextual help skill**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Auto-activates when users ask how to use AIWG.                                                                                                                                                                                                                                                                                                                                                         |
| **AIWG.md hook file**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | AIWG context decoupled from CLAUDE.md. Toggleable without reinstalling.                                                                                                                                                                                                                                                                                                                                |
| **CLI UI modernization**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared display module, brand mark `◆`, quiet/JSON mode. Consistent across all 53 commands.                                                                                                                                                                                                                                                                                                             |
| **Quality & metrics modules**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Token tracking, budget management, quality scoring, A/B feedback testing — 4 modules, full unit test coverage.                                                                                                                                                                                                                                                                                         |
| **Model evaluation suite**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Evaluate local/cloud models across 6 dimensions. Backed by `@matric/eval-client`.                                                                                                                                                                                                                                                                                                                      |
| **`aiwg ralph --attach` / `ralph-attach`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Stay attached to or re-attach to any running agent loop's output from any terminal.                                                                                                                                                                                                                                                                                                                    |
| **MCP sidecar docs (all 8 providers)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Full integration guides, minimal + full config templates, quickstart sections for every provider.                                                                                                                                                                                                                                                                                                      |
| **VS Code extension**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `@aiwg` Copilot chat participant, MCP auto-config, status bar, sidebar tree. Phase 1 + 2. (#623)                                                                                                                                                                                                                                                                                                       |
| **Daemon platform tiers**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tier 1 (native headless), Tier 2 (PTY adapter), Tier 3 (unsupported). In capability matrix.                                                                                                                                                                                                                                                                                                            |
| **PTY adapter**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `aiwg daemon pty start/list/stop` — bridge Tier 1 TUIs over pseudo-terminal. `node-pty` optional. (#656)                                                                                                                                                                                                                                                                                               |
| **Contract syntax for skills**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `requires:`/`ensures:`/`errors:`/`invariants:` + `contract-manifest` + `contract-validate`. (#644)                                                                                                                                                                                                                                                                                                     |
| **`issue-planner` + `induct-research` skills**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Research-grounded backlog generation. Human approval gate. Research routing to Gitea/GitHub/Jira.                                                                                                                                                                                                                                                                                                      |
| **`human-authorization` rule**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Recommendation ≠ authorization. Agents confirm before high-stakes implied actions. HIGH. (#655)                                                                                                                                                                                                                                                                                                        |
| **5 OpenProse antipattern rules**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `god-session`, `vague-discretion`, `context-bloat`, `parallel-then-synthesize`, `implicit-dependencies`. aiwg-utils: 7 → 13 rules. (#648)                                                                                                                                                                                                                                                              |
| **prose-integration addon complete**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `prose-detect` + `prose-install` + `prose-resolution`. 7-skill count. Centralized detection. (#649)                                                                                                                                                                                                                                                                                                    |
| **`[all]` platforms token**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `platforms: [all]` replaced at deploy time. No more hardcoded provider lists. (#651–#653)                                                                                                                                                                                                                                                                                                              |
| **agentic-installer addon**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `setup.aiwg.io/v1` SetupManifest YAML language. Script-first installation: 11 cross-platform templates, 3 skills, 1 agent, 2 rules. (#663–#667)                                                                                                                                                                                                                                                        |
| **`aiwg-ci-safety` rule (aiwg-dev)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Agents may not touch `.gitea/workflows/` without human authorization. CI templates for users live in `agentic/code/frameworks/*/ci/`, never in forge dirs. HIGH.                                                                                                                                                                                                                                       |
| **Skill namespace strategy**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `aiwg-{name}` slug prefix + `aiwg/` subdirectory + `namespace: aiwg` frontmatter — three-layer collision prevention. Collision detection in `use`, `doctor`, `validate-metadata`. All 10 platforms covered.                                                                                                                                                                                            |
| **`aiwg serve`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Local HTTP server for the AIWG web dashboard. WebSocket PTY bridge streams live terminal output directly to the browser.                                                                                                                                                                                                                                                                               |
| **Mission Control Web UI**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | React app with xterm.js terminal viewer, telemetry dashboard, and fortemi-react panel.                                                                                                                                                                                                                                                                                                                 |
| **Artifact index: typed edges & filename-metadata**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Cross-graph set queries (`union`/`intersection`/`difference`), citation sidecar parser, typed edge extraction. Filename-metadata node strategy derives metadata from filename regex without reading file content.                                                                                                                                                                                      |
| **`no-time-estimates` rule**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agent-oriented estimation: scope count, agent count, parallelism map, pass estimate. No wall-clock figures. HIGH.                                                                                                                                                                                                                                                                                      |
| **Graph backends guide**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Documentation for pluggable graph storage backends in `docs/development/`.                                                                                                                                                                                                                                                                                                                             |
| **Specification-complete layer (Layer 3 + 4)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Elaboration now produces behavioral specs (sequence diagrams, state machines, decision tables, interface contracts) and pseudo-code specs — making construction-phase code generation a translation task, not a design task. 6 new templates, deepened gate criteria, new `/flow-use-case-realization` orchestration, 6-layer traceability enforcement.                                                |
| **Semantic memory kernel**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | New `semantic-memory` addon (`core: true, autoInstall: true`) with 5 kernel skills (`memory-ingest`, `memory-lint`, `memory-query-capture`, `memory-log-append`, `memory-log-render`) and a JSON Lines event schema. Any consumer declaring a `memory.topology` contract gets durable ingest/lint/log/query-capture for free. Replaces domain-scoped implementations across 4 frameworks. Per ADR-021. |
| **`MemoryTopology` contract**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | New `memory.topology` field in `manifest.json` with TypeScript types in `src/extensions/types.ts`. Four `crossRefStyle` values supported: `at-mention`, `wikilink`, `markdown-link`, `yaml-ref`. Declared in sdlc-complete, research-complete, forensics-complete, media-curator. Validated by `aiwg doctor`.                                                                                          |
| **Kernel delegation pattern**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Five existing skills (`induct-research`, `intake-from-codebase`, `workspace-health`, `corpus-health`, `cleanup-audit`) now delegate mechanical work to `memory-ingest`/`memory-lint`. No UX change; adds provenance logging, contradiction detection, graph-native cross-references. Per ADR-021 D5.                                                                                                   |
| **`llm-wiki` addon**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Thin topology on top of the semantic memory kernel. 5 page templates (book-companion, personal, research-deep-dive, business-team, generic), Obsidian integration docs, `crossRefStyle: wikilink`. Pick a profile during `aiwg use llm-wiki` via interactive picker or `--profile <name>`.                                                                                                             |
| **`aiwg doctor` topology validation**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | New `MetadataValidator.validateMemoryTopology()` method validates 6 required fields, `crossRefStyle` enum, `.aiwg/` namespace convention, `derivedPages` shape, and array types for `lintRules`/`ingestRequires`. Flags common addon-author mistakes before deploy.                                                                                                                                    |
| **Training framework → marketplace plugin**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The `training-complete` framework moved out of main aiwg into a standalone repo at [`jmagly/aiwg-training`](https://github.com/jmagly/aiwg-training). Install via `/plugin install training@aiwg` or `aiwg use training`. Optional Python runtime (`aiwg-training` CLI) for batch operations — post-install hook prompts on Python 3.10+ detection. Main aiwg shrinks by ~20K lines.                   |
| **ADR-021 & ADR-022**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Two architectural decisions accepted: ADR-021 locks the semantic memory kernel architecture (6 decisions), ADR-022 locks the training framework architecture (10 decisions). Open questions resolved on both.                                                                                                                                                                                          |
| **`aiwg session`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | One command launches a fully-prepared agentic session: version check, doctor, auto-repair, deployment verification, optional MCP injection, then provider launch or IDE instructions. Self-healing by default.                                                                                                                                                                                         |
| **`aiwg feedback`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | File GitHub issues from the CLI without leaving the terminal. System context collected automatically. Routes through `gh` CLI → browser URL → stdout.                                                                                                                                                                                                                                                  |
| **`aiwg serve` WebSocket fix**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sandbox connections were silently 404-ing. Fixed with native Node.js upgrade router + `ws` package. `ws` now auto-installs on first use.                                                                                                                                                                                                                                                               |
| **ADR template: 5 new sections**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source verification & claim tracking, implementation sketch, concurrency/shared state model, testing strategy, multi-level Definition of Done.                                                                                                                                                                                                                                                         |

### Added

- **Kernel-dir pruning of legacy skill deploys** (steward audit follow-up). The kernel-pivot routing in rc.10 — rc.12 left pre-pivot standard skill directories sitting in the platform-native skills dir (`.claude/skills/` etc.) because the deployer never pruned them. Operators upgrading from rc.10 saw 400+ skills in `.claude/skills/` instead of the intended 9 kernel quickrefs, so the platform's skill-listing budget alarm stayed red. `deploySkillsWithKernelRouting()` now scans the kernel destination after deploying and removes any legacy skill directory whose name now belongs to the standard tier — user-authored skills with names not in either deploy list are preserved untouched. Live verification: `.claude/skills/` 402 → 10 entries; `aiwg doctor` Claude Code Skill Budget went from `EXCEEDS OVERRIDE 1.84×` to `OK 0.07×` (449 tokens vs 6,250 budget — 27× under).
- **Doctor budget check now reads the kernel tier**. `aiwg doctor` was checking `provider.paths.skills` (which since the kernel pivot routes to `<provider>/.aiwg/skills/`, the index-discoverable tier hidden from the platform) and reporting a budget overage that didn't reflect what the platform actually scans. Now reads `provider.kernelSkillsPath` first, falls back to `paths.skills` for providers that don't have a kernel split. All 9 provider modules export `kernelSkillsPath` from their default-export blocks (one provider was missing it from the default export — fixed).
- **Quickref skills standardized as discovery primers, not skill enumerations**. All 9 kernel quickrefs (`sdlc-quickref`, `aiwg-utils-quickref`, and the 7 framework-specific ones) rewritten to a consistent template:

  1. **Capability domains** — categorical buckets explaining the framework's surface
  2. **Curated discovery phrases** — pre-validated `aiwg discover "<phrase>"` commands per domain, each tested to surface the target skill in the top-3 ranked results (with example scores like `→ flow-deploy-to-production (score 0.51)`, `→ verify-citations (score 1.00)`)
  3. **Mental model + artifact directory layout**
  4. **Anti-pattern guard**: explicit "do not enumerate skills from memory; run `aiwg discover --type skill --limit 20 \"<area>\"` instead"

  This flips the quickrefs' role from skill-table reference to discovery primer. The agent learns which phrasings work — phrases curated and validated by AIWG maintainers, encoded directly into the kernel layer. Rather than enumerating ever-growing skill catalogs, the kernel teaches _how to find_ them. Phrases were validated against the live discovery scorer; failed phrases were iterated until they surface the correct top result, or omitted when the underlying skill needs richer trigger declarations downstream.

  Net effect: each quickref stays tight even as frameworks grow (no list maintenance), and discovery becomes habit rather than fallback. The pattern induces every agent loop through the index instead of going from memory.

- **`aiwg discover` promoted to a first-class top-level command**. Previously `aiwg index discover` (subcommand of `aiwg index`); the new surface is `aiwg discover "<phrase>" [--limit N] [--type skill,agent,...] [--json]`. Discovery is the operator surface for finding AIWG skills, agents, commands, and rules by capability — it leverages the artifact index machinery but exists as its own verb so agents don't conflate it with the project's general-purpose graph indices (project / codebase / framework / user-defined). Same scoring (4× trigger boost, 2× capability) and same JSON schema as before. The legacy `aiwg index discover` path still works; the kernel quickrefs and the `skill-discovery` rule have been updated to use `aiwg discover`.
- **Skill-only `.aiwg/` path move ported to all 9 remaining providers** (#1216). Kernel-vs-standard skill routing now applies uniformly across the AIWG fleet:

  | Provider       | Standard skills             | Kernel skills              |
  | -------------- | --------------------------- | -------------------------- |
  | Claude Code    | `.claude/.aiwg/skills/`     | `.claude/skills/`          |
  | Cursor         | `.cursor/.aiwg/skills/`     | `.cursor/skills/`          |
  | Factory AI     | `.factory/.aiwg/skills/`    | `.factory/skills/`         |
  | GitHub Copilot | `.github/.aiwg/skills/`     | `.github/skills/`          |
  | OpenCode       | `.opencode/.aiwg/skill/`    | `.opencode/skill/`         |
  | Warp           | `.warp/.aiwg/skills/`       | `.warp/skills/`            |
  | Windsurf       | `.windsurf/.aiwg/skills/`   | `.windsurf/skills/`        |
  | OpenClaw       | `~/.openclaw/.aiwg/skills/` | `~/.openclaw/skills/aiwg/` |
  | Hermes         | `~/.hermes/.aiwg/skills/`   | `~/.hermes/skills/`        |
  | Codex          | `.codex/.aiwg/skills/`      | `.codex/skills/`           |

  All 6 standard providers verified live: each ships **9 kernel skills + 391 standard skills** (vs the prior flat 400). OpenClaw's 150-skill hard cap is comfortably cleared regardless of how many frameworks are installed. New `deploySkillsWithKernelRouting()` helper in `base.mjs` factors the partition logic so each provider's `deploySkills` is now ~3 lines. PROVIDER_PATHS in `use.ts` and PROVIDER_DEPLOY_DIRS in `aiwg-config.ts` updated to mirror. 7 integration test files re-pointed at the new layout. Codex's home-dir script-delegated path (per #766) preserves its existing `~/.codex/skills/` deploy unchanged — kernel routing for that surface waits for #766.

- **`skill-discovery` HIGH framing rule** (#1215). Closes the kernel-pivot loop: tells agents that most AIWG skills are NOT in their context (they live at `<provider-dir>/.aiwg/skills/`, reachable only through the artifact index) and **mandates** an `aiwg index discover "<paraphrased need>"` query before declining "AIWG can't do that" or improvising a custom workflow. Names exceptions (user named a specific skill, capability is clearly out of scope, query already done in session) and requires the agent to surface the top match (or top-3) to the user so the discovery is auditable. Layers cleanly with `research-before-decision` (technical research) and `instruction-comprehension` (parsing the actual need). aiwg-utils rule count 19 → 20. Deploys via the standard rules-index pipeline.
- **Kernel quickrefs for the remaining 7 frameworks** (#1213). Each shipped framework now has a `kernel: true` directory skill: `forensics-quickref`, `research-quickref`, `media-curator-quickref`, `marketing-quickref`, `ops-quickref`, `security-engineering-quickref`, `knowledge-base-quickref`. Each lists the framework's high-traffic skills with one-liners, names the artifact-directory layout, sketches the workflow phase model, and ends with a "don't enumerate from memory — query the index" guard. Total kernel-resident skill count after this lands: **9** (8 framework quickrefs + `aiwg-utils-quickref`), well under OpenClaw's 150-skill floor and Claude Code's 25%-of-context budget regardless of how many frameworks are installed. Previously-flat 393-skill listing is now 9 visible kernel skills + 392 index-discoverable skills hidden under `.claude/.aiwg/skills/`.

  Side effects: `forensics-complete/manifest.json` `total_skills` bumped 19 → 20 (the new quickref counts in the framework's metadata). Use-handler's post-deploy `buildIndex` call now pre-flights for `agentic/code/frameworks/` existence so test fixtures and npm-install deploys (no source tree present) don't trip on the index-builder's hard-exit on missing scan dirs.

- **`aiwg index discover` capability-search subcommand** (#1214). Token-tight ranked lookup over the framework artifact index. Default surface targets AIWG kinds (`skill`/`agent`/`command`/`rule`); `--type` narrows it. Output names the top trigger phrase responsible for each match plus the entry's capability description. JSON mode (`--json`) emits a stable schema (path/type/title/score/triggers/capability/kernel) for programmatic agent consumption. Examples: `aiwg index discover "create intake"` → ranks the marketing intake variants and `intake-from-codebase`; `aiwg index discover "deploy production"` → ranks `flow-deploy-to-production` first (score 0.51).

  Wiring: `extractTriggers()` parses the `## Triggers` section into structured phrases; `extractCapability()` pulls the frontmatter `description` (falling back to the first body paragraph); both are filled in for skills/agents/commands/rules during `buildIndex`. `inferType()` now classifies these four AIWG kinds from source path layout, so artifacts under `agentic/code/{frameworks,addons}/<name>/{skills,agents,commands,rules}/` always land with the right type. The scorer adds a 4× weight on trigger phrase matches and 2× on capability matches; multi-token queries require ≥50% token overlap to surface partial matches (gibberish queries return zero results).

  `aiwg use` runs `buildIndex({ graph: 'framework' })` post-deploy as a best-effort rebuild so `discover` always queries fresh data without the operator running anything explicit. Pre-existing query/stats/deps subcommands unchanged. 10 new tests in `test/unit/artifacts/discover.test.ts`.

- **Kernel-skill routing & first two quickrefs** (epic [#1212](https://git.integrolabs.net/roctinam/aiwg/issues/1212)). Pivot from bulk skill deploy to kernel + index-driven discovery, side-stepping the agentic platforms' flat-namespace skill-listing budgets (Claude Code: 25% of context; OpenClaw: 150-skill hard cap; etc.). Skills now route to one of two destinations on `aiwg use --provider claude`:
  - **Standard skills** → `.claude/.aiwg/skills/` (sequestered, discoverable through the artifact index, not the platform's flat listing)
  - **Kernel skills** (`kernel: true` frontmatter) → `.claude/skills/` (platform-native, always-loaded). Reserved for the small set of always-on framing/reference skills.

  Two kernel quickrefs ship in this cut: `sdlc-quickref` (in `sdlc-complete`) and `aiwg-utils-quickref` (in `aiwg-utils` addon). Each acts as a directory + usage quick reference: lists the framework's most-reached-for skills with one-liners, points at the index for the rest, includes anti-pattern guards against enumerating from memory. Remaining 7 framework quickrefs tracked as #1213; `aiwg index discover` capability-search subcommand as #1214; `skill-discovery` framing rule as #1215; port to other 9 providers as #1216.

  New helper `isKernelSkill()` in `tools/agents/providers/base.mjs`. Claude provider's `deploySkills()` partitions and routes via `kernelSkillsPath`. Research backing the design at `.aiwg/research/findings/skill-budget-landscape-2026-05.md` (provider survey), `.aiwg/research/findings/zero-server-index-tech-2026-05.md` (FTS5 / sqlite-vec / hnswlib trade-off table), `.aiwg/architecture/audit-index-subsystem-2026-05.md` (existing index subsystem audit, 450-LOC implementation path).

- **`PROF-*` node IDs in citation-sidecar parser** (#105). `src/artifacts/citation-parser.ts` accepts `PROF-[POFG]-[a-z0-9-]+` (`PROF-P-` people, `PROF-O-` orgs, `PROF-F-` funders, `PROF-G-` groups) alongside `REF-\d+` at all three call sites: `extractRefsFromTable`, `parseCitationSidecar` (frontmatter `ref` validation), and `buildRefToPathMap` (indexer node-id mapping). Centralized into module-level `NODE_ID_PATTERN` (anywhere-match `/g`) and `NODE_ID_FULL` (anchored validator) so the regex can't drift across sites; new `isNodeId(value)` typed predicate exported for downstream consumers. Purely additive — both ID spaces are unambiguous and prefixed, so no fixture or codepath collides. Unblocks research-corpus projects building entity-profile graphs (`profile→REF` edges natively traversable via `aiwg index neighbors`). 7 new unit + integration tests covering all four type codes, malformed-shape rejection, and a `buildIndex` round-trip with a `PROF-P-marks-samuel-edges.md` sidecar producing `cites` edges to `REF-803` / `REF-779`.
- **Claude Code plugin builds for the 6 missing frameworks** (#1152). New plugins: `forensics` (13 agents, 19 skills from `forensics-complete`), `security-engineering` (2 agents, 7 skills), `research` (8 agents, 20 skills from `research-complete`), `media-curator` (6 agents, 18 skills), `ops` (12 agents, 2 flat skills from `ops-complete`), `knowledge-base` (2 skills). Each plugin gets a `PLUGIN_CONFIGS` entry in `tools/plugin/package-plugins.mjs`, a generated `plugins/<name>/` directory with `.claude-plugin/plugin.json` (CalVer `2026.5.0`) and `README.md`, plus a `marketplace.json` entry. Marketplace coverage went from 7 plugins to 13. Plugin name `security-engineering` chosen over `security` to avoid collision with the `addons/security/` addon. Source-to-plugin payload verified 1:1 against `agentic/code/frameworks/<src>/{agents,skills}`.
- **Project-local lifecycle — Phase 1: Activity log** (#1037 Phase 1). New `src/extensions/project-local-activity.ts` emits inline lifecycle events at per-bundle, per-provider granularity that the generic post-command hook can't capture. Wraps the storage adapter; non-blocking writes (failures logged to stderr, never break the underlying op). Encodes 12 design events (`discover`, `deploy`, `deploy-failed`, `conflict`, `shadow-acknowledged`, `shadow-refused`, `remove`, `remove-mutated`, `remove-conflict`, `remove-force`, `promote`, `promote-failed`) using the frozen `ACTIVITY_OPERATIONS` enum (`deploy`/`delete`/`promote`/`query`) with the design event name as the summary prefix — no breaking change to the rule. `emitDiscoverEventsDeduped()` provides noise control for read-only operations: dedupe by `(name, type)` against the recent log tail. Wired into `deployProjectLocalBundles` for shadow resolutions and per-provider deploy success/failure events. 6 new unit tests.
- **Project-local lifecycle — Phase 2: project-local-aware `aiwg remove`** (#1037 Phase 2). New `src/extensions/project-local-remove.ts` implements cases 1–6 from the [#1048 design](.aiwg/architecture/design-aiwg-remove-revert.md): pristine (delete), mutated (refuse + prompt; `--force` overrides), missing (silent success), replaced (refuse — never destroy another bundle's deploy, even with `--force`), permission-denied (partial revert with registry preserved per-provider), source-deleted-before-remove (revert from registry hashes anyway). Source under `.aiwg/<type>/<name>/` is **never** deleted — load-bearing invariant. Detection uses a new `InstalledEntry.artifactHashes` field recorded at deploy time by `hashBundleArtifacts()`; older entries without hashes fall back to "unhashed" (same refuse-by-default behavior as case 2). Routing: `removeHandler` in `subcommands.ts` detects project-local entries in `installed` and routes to the new handler; non-matching ids fall through to the existing plugin-uninstaller path. CLI flags: `--force`, `--dry-run`, `--provider <p>`, `--keep-registry`. 15 new unit tests.
- **Project-local lifecycle — Phase 3: `aiwg doctor` project-local section** (#1037 Phase 3). New `src/extensions/project-local-doctor.ts` builds the section per the [#1049 design](.aiwg/architecture/design-doctor-log-promote.md). Reports: per-type counts with bundle-id listing, validation errors (top 10 inline + "+N more"), active shadows (informational ⚠ for non-safety, !! for acknowledged), denylist violations (✗), drift (hash deployed file vs registered `artifactHashes`), provider deployment matrix from installed entries. New flags: `aiwg doctor --project-local` (this section only), `--quiet` (suppress informational subsections). Section fully suppressed when no project-local content exists. Doctor exits 0 unless validation errors / denylist violations / drift are present — shadows alone do not fail doctor by design. 8 new unit tests.
- **Project-local lifecycle — Phase 4+5: `aiwg promote` graduation** (#1037 Phases 4+5). New `src/extensions/project-local-promote.ts` operationalizes the identical-form portability invariant ([ADR #1038](.aiwg/architecture/adr-identical-form-portability.md)). CLI: `aiwg promote <name> [--to upstream|corpus <path>] [--dry-run] [--cleanup] [--force]`. Pre-flight: bundle exists, destination doesn't already exist (refuses overwrite), no `@.aiwg/` references that would dangle (refuse without `--force`). Operation: SHA-256 snapshot of every source file → recursive copy → re-hash every destination file → roll back (delete dest) on any mismatch → registry source flips from `'project-local'` to `'bundled'` (or `'corpus'`) → emits `promote` (or `promote-failed`) to activity log. `--cleanup` removes the `.aiwg/<type>/<name>/` source after a successful copy. 10 new unit tests. New `promoteHandler` in `subcommands.ts`; new `promoteCommand` in `commands/definitions.ts`.
- **`aiwg new-bundle` scaffolding** (#1050). New `src/extensions/project-local-scaffold.ts` creates a complete `.aiwg/<type>/<name>/` bundle in one command: valid manifest (validates against `BundleManifestSchema` out of the box), starter artifact (`--starter skill|rule|agent|minimal`), and README that includes the identical-form portability reminder + `aiwg promote` walkthrough. Aliases: `new-extension`, `new-addon`, `new-framework`, `new-plugin` infer `--type` from invocation. Type-specific stubs: `src/.gitkeep` for framework, `payload/.gitkeep` for plugin. Refuses to overwrite existing bundles. 11 new unit tests.
- **Test matrix for project-local lifecycle** (#1046). New `.aiwg/testing/test-strategy-project-local.md` maps every #1046 matrix row to its owning test file with status. New `test/unit/extensions/project-local.test.ts` (9 cross-cutting tests: D-8 path-traversal at schema layer, D-9 unicode names, C-2 three-way collision, C-3 cross-type id collision). New `test/integration/project-local-deploy.test.ts` (6 tests against real `deploy-agents.mjs`: per-type provider paths claude+cursor, `--dry-run` no-write, multi-provider sequential, source preservation, idempotent re-run). New `test/uat/project-local-flow.uat.ts` (UAT round-trip + safety-critical shadow refusal). Wired into `config/vitest.uat.config.js`.
- **Design — `aiwg remove` revert semantics** (#1048). New `.aiwg/architecture/design-aiwg-remove-revert.md` specifies the per-case behavior table (cases 1–7) for `aiwg remove` against project-local artifacts when deployed files are not in pristine state. `--force` invariants are narrowly scoped: skip case-2 prompt only; never deletes source under `.aiwg/<type>/<name>/`; does not authorize destroying another bundle's deploy or bypassing OS permission errors. Specifies `artifactHashes` registry shape for hash-based detection. Per-case activity log entries enumerated.
- **Design — Doctor + activity-log + `aiwg promote`** (#1049). New `.aiwg/architecture/design-doctor-log-promote.md` covers three operational concerns: doctor section additions (per-type counts, validation, shadows informational vs blocking, drift detection, provider matrix), activity log schema (12 events with summary shape, non-blocking writes, discover dedupe), and `aiwg promote` CLI surface (hash-verified copy with rollback, `--dry-run`/`--cleanup`/`--force`, registry source-flip).
- **Customization docs — Path A/B/C structure** (#1051). `docs/customization/README.md` restructured: Path A (project-local, recommended for most users), Path B (fork, for upstream contributions), Path C (corpus, cross-project sharing). New `docs/customization/project-local-quickstart.md` (5-minute first bundle), `project-local-lifecycle.md` (full operator surface), `project-local-troubleshooting.md` (manifest validation, shadow warnings, drift detection, remove/promote failures, activity log issues), `from-fork-to-project-local.md` (per-category migration guide for operators currently maintaining a fork). New `examples/project-local/README.md`.
- **Disambiguation doc — extensions vs addons vs frameworks vs plugins** (#1052). New `docs/customization/extensions-vs-addons-vs-frameworks-vs-plugins.md`: one-sentence definitions, comparison table, decision tree, plugin-vs-content distinction, graduation paths, cross-references to ADRs and the manifest schema.
- **CLI reference updates** for new commands. `docs/cli-reference.md` gains full entries for `new-bundle` and `promote`; `remove` rewritten for project-local routing (`--force`/`--dry-run`/`--provider`/`--keep-registry` flags, source preservation invariant, activity log emissions); `doctor` updated with `--project-local` and `--quiet` flags + project-local section description.
- **Project-local artifact discovery — read-only scan + manifest validation** (#1034, epic #1033). New `src/extensions/manifest.ts` ships the unified `BundleManifestSchema` (Zod) per the #1044 design — discriminated nested config (`addonConfig`, `frameworkConfig`, `extensionConfig`, `pluginConfig`), strict validation rejects unknown top-level keys, DoS limits (64 KB manifest, 200 bundles, 50 keywords, 20 overrides), `safety-critical`/`overrides` fields per #1041, forward-compat `manifestVersion: '1'` discriminator. New `src/extensions/project-local-discovery.ts` scans `.aiwg/{extensions,addons,frameworks,plugins}/<name>/manifest.json`, validates each, returns structured bundles + per-manifest errors. Symlinked bundle dirs refused unless `--allow-symlinks` (#1042 T3); legacy `.aiwg/frameworks/registry.json` naturally ignored (only directories with `manifest.json` are bundles); case-insensitive id collisions within a type are refused (NFR-PL-6). Wired into `aiwg list`: project-local bundles surface in the standard output with `[project]` source label; new `aiwg list --project-local` filters to project-local-only with per-type counts and validation-error display. Read-only — no deployment side effects (deploy lands in #1035). 34 new unit tests (manifest schema + scanner). Tests pass; tsc clean; no regressions across 801 suite.
- **Skill quality system — `aiwg skill-lint` + sticky PR comment** (#1015 Phases C–D). New `aiwg skill-lint <path...> [--rubric strict|standard|lenient] [--json]` CLI scores SKILL.md files against a four-dimension rubric (Schema 40%, Description 20%, Discoverability 20%, Body 20%). Three thresholds: lenient ≥40, standard ≥60, strict ≥80. Companion CI workflow `.gitea/workflows/skill-lint-pr.yml` runs the linter on changed SKILL.md files in PRs and posts a single sticky comment with per-dimension scores via the Gitea API directly — no third-party action dependency. Rubric documented in `docs/skills/quality-rubric.md`.
- **SKILL.md frontmatter linter + CI gate** (#1014). New `tools/linters/skill-frontmatter-linter.mjs` validates SKILL.md YAML frontmatter (parse + required `name`/`namespace`/`description`/`platforms`). New `validate-skill-frontmatter` job in `.gitea/workflows/metadata-validation.yml` runs it against the entire `agentic/code/` corpus on every PR. Surfaced and gated 317 pre-existing violations cleaned up under #1015 Phase A.
- **`aiwg validate-metadata` now picks up SKILL.md** (#1015 Phase B). `MetadataValidator.findManifestFiles` extended to match `SKILL.md` alongside `manifest.md`/`BEHAVIOR.md`. Routing dispatches by filename: SKILL.md goes through a new `validateSkillManifest` method using `SkillFrontmatterSchema` (encapsulated per artifact type — no inline `if isFooFile` branching). Adding a new artifact type is now an additive change.
- **Schema additions to `SkillFrontmatterSchema`** (#1015 Phase B): `triggers`, `aliases`, `deprecated_names` are now declared (were silently passing through `passthrough()`).
- **ADR — SKILL.md frontmatter schema policy** (#1015 Phase B). `.aiwg/architecture/adr-skill-md-frontmatter-schema.md` codifies the policy: `name`/`namespace`/`description`/`platforms` required; `user-invocable: true` required for slash-invocable skills; `triggers`/`aliases`/`commandHint` recommended.
- **Project repo topology in `.aiwg/aiwg.config`** (#994). New `remotes` block declares `primary` (CI/issues/PRs), `issue_tracker`, `ci`, and `secondary[]` (mirrors with `push_on_release` flag). `resolveRemotes()` helper applies defaults — when absent, `origin` is treated as primary, fully back-compat. `aiwg doctor` validates that every named remote exists in `git remote`. Closes a class of "agent guessed wrong" failures for projects running on Gitea/GitLab/internal GitHub with a public mirror.
- **`resolveRemoteProvider(url)` helper** (#997). Returns `'github' | 'gitlab' | 'gitea' | 'unknown'` from a remote URL. Self-hosted instances without a tell-tale hostname return `'unknown'` so callers ask the operator instead of guessing.
- **Delivery / repo-control policy in `.aiwg/aiwg.config`** (#995). New `delivery` block declares `mode` (direct / feature-branch / pr-required), `default_branch`, `branch_naming.prefix_by_type`, `merge_style`, `delete_branch_on_merge`, `force_push_policy`, `require_ci_green`, `require_signed_commits`, `auto_close_issues`, `issue_comment_on_cycle`. `resolveDelivery()` applies conservative defaults that match what AIWG agents do today — no regression for existing projects. `aiwg doctor` enum-validates and best-effort checks `default_branch` exists in git.
- **Repo topology emitted into `AIWG.md` / `AGENTS.md`** (#998). `aiwg use` now interpolates a `## Repo Topology` section into the Claude hook file and every template-based provider (codex / cursor / factory / hermes / opencode). Agents see primary/secondary remote URLs at session start without reading `.aiwg/aiwg.config` directly. Empty when no `remotes` block configured.
- **`aiwg config show --project [--json]`** (#999). New CLI surface for inspecting the resolved project config: providers, installed frameworks, and the resolved remotes topology (with URLs resolved via `git remote get-url`). `--json` flag for CI scripts. Errors with `ERR_NO_PROJECT_CONFIG` and a helpful hint when `.aiwg/aiwg.config` is absent.
- **`aiwg config get|set --project <key> [<value>]`** (#1006). Read and write the project config from the CLI without hand-editing JSON. Dotted paths (`delivery.mode`, `remotes.primary`). Enum validation on `set` for `delivery.mode` / `delivery.merge_style` / `delivery.force_push_policy` rejects unknown values with a clear hint listing allowed members. Boolean coercion for the five `delivery.*` boolean fields. Read-modify-write preserves unrelated fields via `writeAiwgConfig()` (atomic, secret-safe).
- **Intake-wizard delivery-policy question** (#1005). `/intake-wizard` now asks "How does your team ship code?" with three preset answers (`direct` / `feature-branch` / `pr-required`) plus an advanced sub-flow for `merge_style`, `force_push_policy`, `require_signed_commits`. `default_branch` derived from `git symbolic-ref HEAD` — handles `master → main` migrations gracefully.
- **`@$AIWG_ROOT/` token system** — install-path token for all AIWG corpus refs; resolves to repo root (dev), `$(npm root -g)/aiwg` (npm), or `$AIWG_ROOT` env var (custom); any env var usable as `@$TOKEN/path`; `.env` support; 1,099 bare refs migrated across corpus
- **`.aiwg/` reference contract** — normalized path allowlist derived from `memory.creates` in manifests; Tier 1 (always present) and Tier 2 (framework-specific) documented; `validate-component` and `dev-doctor` enforce dynamically; `memory` field added to all manifests (#632, #633)
- **aiwg-dev addon** — full developer toolkit: `validate-component` (PASS/WARN/FAIL link classification), `dev-doctor` (Section 4 subchecks for `.aiwg/`, bare refs, `.claude/` refs), `link-check` skill (per-file/corpus/`--fix`/`--report`/`--fail-on-warn`), `devkit-*` scaffolding skills (#634–#636)
- **No-escape rule** — all `@<path>` patterns processed regardless of backtick/code-block context; documented in `aiwg-dir-reference-contract.md` and `corpus-navigation-guide.md` (#635)
- **Corpus navigation guide** (`docs/development/corpus-navigation-guide.md`) — mental model, thin skill principle, composite skill pattern, reference tiers, ordering/grouping, anti-patterns
- **318 `.claude/` refs migrated** — all `.claude/commands/`, `.claude/rules/`, `.claude/agents/` refs in `agentic/code/` replaced with `@$AIWG_ROOT/` corpus paths; skills now compose correctly via links (#638)
- **`aiwg sync`** — update + redeploy + health check; `--dry-run`, `--quiet`, `--skip-update`, `--provider`, `--channel`, `--frameworks` flags (#482)
- **Mission Control (`aiwg mc`)** — 9 subcommands: `start`, `dispatch`, `status`, `watch`, `abort`, `pause`, `resume`, `stop`, `list`; JSONL event log; persistent sessions; `--drain` on stop (#483)
- **AIWG Steward agent** — installation custodian; DETECT→BASELINE→CHECK→PLAN→CONFIRM→EXECUTE→VERIFY→REPORT logic (#481)
- **MC Conductor agent** — live orchestrator inside Mission Control sessions (#483)
- **Provider-watcher** (`tools/daemon/`) — scheduled provider update detection, task execution, automatic PR creation (#615)
- **Cross-session daemon memory** (`#608`) — episodic + semantic + working memory tiers persisting across daemon restarts; `MemoryManager` with TTL-based eviction and cross-session retrieval
- **Daemon — fully operational** — web UI (localhost:7474), YAML profiles, scheduled task runner, multi-room Telegram, autonomous engine with safety constraints, Docker containerization (#520–#534)
- **Behaviors** — BEHAVIOR.md format spec, `hooks:`/`triggers:`/`inputs:`/`scripts/`; framework source dirs; `aiwg add-behavior` scaffolding; OpenClaw deployment (#540–#543)
- **OpenClaw** — 10th platform; agents/commands/skills/rules/behaviors to `~/.openclaw/`; ClawHub publication documented (#535)
- **SOUL.md system** — `soul-create`, `soul-validate`, `soul-enable`, `soul-disable`, `soul-status`, `soul-enhance`, `soul-apply`, `soul-blend`; four pre-built SDLC souls (#437, #438)
- **AIWG.md hook file** — decoupled context injection; `hook-enable`/`hook-disable`/`hook-regenerate`/`migrate-hook`; multi-provider equivalents (#439–#446)
- **Remote install system** — install frameworks, addons, extensions from registry without cloning (#557)
- **Project-level `aiwg.config`** — provider registry, deployment manifest, `aiwg run` scripts; XDG-compliant resolution (#621)
- **aiwg-guide skill** (`agentic/code/addons/aiwg-utils/skills/aiwg-guide/`) — contextual help skill; auto-activates on AIWG usage questions; covers all 50 commands and 9 providers (#616)
- **Concierge agent** (`tools/daemon/`) — persistent front-facing agent for daemon interactions; intent router and response translator
- **Skills as canonical extension type** — `SourceExtensionType`/`DeploymentExtensionType` aliases; `CommandHint` interface; `SkillMetadata` expanded; skill-command translator; 56 command definitions converted; provider classification; `aiwg add-command` deprecation (#546–#552, #555, #538)
- **Hermes as full platform** — `--provider hermes`; 96 skills declare compatibility; token-optimized AGENTS.md; 5-tool MCP whitelist; `hermes-quickstart.md`
- **Copilot provider overhaul** — `.agent.md`, `.prompt.md`, `.instructions.md` with `applyTo` globs; `aiwg mcp install copilot` generates `.vscode/mcp.json` (#577–#580)
- **Windsurf provider update** — `.windsurf/rules/` with `trigger: always_on`; dual skill deploy (#574–#576)
- **ops-complete framework** — Kubernetes-inspired envelope; 6 JSON Schema kinds; 4 rules, 2 agents, 3 templates, 2 skills; `sys`/`it`/`dev`/`stream` extensions (#491)
- **Composable RULES-INDEX hierarchy** — component-owned indexes assembled at deploy time (#496–#500)
- **RLM enhancements** — `quality_gate`, `preferred_model`, `chunking_strategy`, `batch_size`; `rlm-self-refine`, `rlm-divide-conquer`, `rlm-filter-recurse` examples; 6 antipatterns documented (#618–#620)
- **Prose-integration addon** — OpenProse program integration; `prose-setup`, `prose-reader`, `prose-run`, `prose-validate`, `forme-manifest`; `prose-bridge` rule (#619, #620)
- **Getting-started guide series** — 15 scenario-based articles in `docs/getting-started/`
- **CLI shared display module** (`src/cli/ui.ts`) — chalk/ora/cli-table3; brand mark `◆`; TTY/CI-aware degradation; quiet/JSON mode
- **User-level config subsystem** — `aiwg config get|set|list|validate|reset|path`; XDG resolution (#545)
- **Skills CLI subsystem** — `aiwg skills list|search|install|info`; local/clawhub/openclaw adapters (#539)
- **Domain grounding agents** — security, performance, compliance, technology grounding agents; 40% domain accuracy improvement (#184)
- **Agent constraint learning** — persistent domain rules learned from reviewer corrections (#146)
- **Agent-loop rename** — `ralph-loop` → `agent-loop`; loop taxonomy; `al:` shortcut (#558)
- **YAML metalanguage schemas** — flow, agent, rule, skill JSON Schema definitions (#447)
- **Verbalized sampling addon** — diversity-tuning skill, content-diversifier agent, 3 strategies (#20)
- **README overhaul** — 90+ research citations, six-component deep dive, platform entries (#501)
- **Provider alignment audits** — full audits for all 11 platforms (#560–#569)
- **Self-maintenance rule** (`agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md`) — CLI-first maintenance principle; pre-flight trigger table for long orchestration sessions; NL pattern translations; proactive AIWG.md guidance (#484)
- **Hermes MCP sidecar architecture** — MCP sidecar (#449); minimal 5-tool whitelist (~3,000 token schema vs 12,000+ full surface) (#451); `delegate_task` pattern (~200 tokens vs 3,000–8,000 direct) (#452); Hermes platform frontmatter on skills (#453); token-optimized AGENTS.md template (#450)
- **Token metrics modules** — token-per-artifact-line tracking (#173), token budget management with 70/30 split (#144), pattern-based quality scoring with JSON patterns per artifact type (#192), feedback A/B testing infrastructure (#148); unit tests for all four modules
- **Model evaluation suite** (`tools/eval/`) — configurable eval framework for local and cloud models; 6 dimensions, 9 initial test cases; Markdown and JSON reports; backed by `@matric/eval-client` from Gitea npm registry; standard benchmark scores included when `matric-eval` binary is present (#433, #488)
- **`native-ux-tools` rule** — agents must prefer platform-native interaction tools; platform capability matrix for all 8 providers; fallback to formatted markdown (#448)
- **Local/Ollama provider** — first-class provider with local model support documentation and catalog entries (#434)
- **Hybrid artifact addressing** (#187) — hybrid system combining file path and semantic URN addressing; `@path`, `@?"query"`, `@#tags`, `@phase:type`; sub-100ms in-memory index
- **`aiwg index` enhancements** — flexible graph types, deploy next-steps guidance, verbose mode (#426)
- **Community model testing guide** — contribution guide for community model testing (#435)
- **Diagram generation rule elevated** — `diagram-generation` promoted to standard utility rule (#430)
- **Complete docset enforcement** (#429) — rule enforcing full documentation artifact generation per release
- **Claude Code `@`-link best practices** (#427) — guidance for `@`-link usage in agent memory contexts
- **MCP sidecar integration docs for all 8 providers** (#503–#510) — full integration guides at `docs/integrations/{provider}-mcp-sidecar.md`; minimal + full config templates for cursor, opencode, warp, windsurf; sidecar section appended to all 8 provider quickstart guides
- **`aiwg mcp install windsurf` and `aiwg mcp install warp`** — two install targets added; generate `~/.codeium/windsurf/mcp_config.json` and `~/.warp/mcp.json`
- **`aiwg ralph --attach`** — stay attached to an agent loop's output after launch; streams live to stdout; Ctrl+C detaches without stopping the loop
- **`aiwg ralph-attach [--loop-id <id>]`** — re-attach to any running agent loop's output stream from any terminal session
- **`.gitignore` advisory** (#553) — `aiwg use` and `aiwg new` advise `.gitignore` patterns for AIWG runtime directories (`.aiwg/working/`, `.aiwg/ralph/`, `.claude/`, etc.)
- **MCP config injection** (#554) — `aiwg config` can inject MCP server configurations into supported providers
- **Claude Code reference expansion** (#570–#573) — Agent Teams, scheduled agents, remote triggers, and worktree isolation documented in depth; `subagent_type` catalog audited against Claude Code built-in types
- **Test fixtures refactor** (#614) — hardcoded model names extracted into shared fixtures across test suites
- **VS Code extension** — `vscode-extension/` directory; `@aiwg` Copilot chat participant with `/deploy`, `/status`, `/skill`, `/pipeline`, `/eval`, `/productionize` routing; MCP auto-config (idempotent `.vscode/mcp.json` writer); status bar showing installed frameworks + providers; sidebar tree views (Status, Frameworks, Scripts); bundled JSON Schema for `aiwg.config.json` (autocomplete + inline validation); brand assets (favicon, logo, 128×128 marketplace icon, activity bar icon) (#623)
- **Daemon platform tier classification** — Tier 1 (native headless: claude-code, opencode, warp, openclaw, codex), Tier 2 (PTY adapter secondary: claude-code + codex), Tier 3 (unsupported — IDE/display server required: copilot, factory, cursor, windsurf); `daemon_tier` and `daemon_pty_adapter` fields in capability matrix; `getDaemonTier()` and `daemonCapableProviders()` TypeScript helpers (#656)
- **PTY adapter** (`tools/daemon/pty-adapter.mjs`) — bridge any Tier 1 platform TUI over a pseudo-terminal using `node-pty`; `aiwg daemon pty start <platform>`, `pty list`, `pty stop <session-id>`; session state persisted to `.aiwg/daemon/pty/<sessionId>.json`; `node-pty` added as `optionalDependency` with graceful fallback error (#656)
- **Contract syntax for skills** — `requires:`, `ensures:`, `errors:`, `invariants:` contract fields on SKILL.md files; `contract-manifest` skill generates human-readable chain manifests with data-flow wiring analysis and optional Mermaid diagram; `contract-validate` skill gives pass/fail verdict on skill chains at wiring time, catching missing dependencies before runtime; `--strict` and `--external` flags (#644)
- **`issue-planner` skill** (sdlc-complete) — research-grounded SDLC issue planning; dispatches parallel research agents (best practices, current research, vendor docs), generates full SDLC doc corpus with gate checks, produces prioritized dependency-ordered issue backlog, requires human approval before filing, outputs `address-issues` invocation instructions
- **`induct-research` skill** (research-complete) — research analogue of `address-issues`; accepts any target (file, directory, URI, issue reference), classifies and analyzes sources in parallel, routes filing to Gitea MCP / GitHub CLI / Jira REST / Codehound; `--induct-research` flag on `issue-planner` collects references found during parallel research and files structured induction tasks; supports `AIWG_RESEARCH_REPO` env var
- **`human-authorization` rule** (HIGH, aiwg-utils) — agents must seek explicit human authorization before irreversible or high-stakes actions implied by findings; Rule 1: recommendation ≠ authorization; five enforceable rules with agent authoring guidance (#655)
- **OpenProse antipattern rules** (aiwg-utils) — 5 rules derived from OpenProse research (#617): `god-session` (HIGH: >7 responsibilities → decompose), `vague-discretion` (HIGH: gate conditions must be concrete and measurable), `context-bloat` (MEDIUM: pass file paths not contents), `parallel-then-synthesize` (MEDIUM: parallelism is wrong when tasks aren't independent), `implicit-dependencies` (MEDIUM: sub-agents start clean; pass all context explicitly); aiwg-utils grows from 7 to 13 rules (#648)
- **`prose-detect` skill** (prose-integration) — centralized OpenProse installation detector; 7-signal priority chain: env var → AIWG config → AIWG-local install → project plugin manifest → user home → global CLI → not found; `autoDetect: true` in manifest (#649, #650)
- **`prose-install` skill** (prose-integration) — install OpenProse with user confirmation; `npx` → `git clone` fallback
- **`prose-resolution` rule** (prose-integration) — canonical path resolution protocol; all prose skills delegate detection to `prose-detect` rather than hardcoding paths
- **prose-integration addon completion** — `prose-detect` + `prose-install` + `prose-resolution` + `docs/integration-guide.md`; Step 0 detection centralized across all prose skills (`prose-run`, `prose-validate`, `forme-manifest`, `prose-reader`); contract fields on all skills; 7-skill count (#649)
- **`[all]` platforms token** — `platforms: [all]` in agent `.md` files replaced with the target platform at deploy time; `injectPlatform` option in base deployer; 5 grounding/diversifier agents converted from hardcoded lists to `[all]` (#651, #652, #653)
- **OpenProse research review report** (`docs/reports/openprose-review.md`) — basis for 5 new antipattern rules (#617)
- **agentic-installer addon** — `setup.aiwg.io/v1` SetupManifest YAML language for cross-platform, script-first installation workflows; JSON Schema covering all 7 step types (`script`, `detect`, `ask`, `verify`, `agentic`, `platform-route`, `chain`), platform matrix, params, prerequisites, recovery procedures, and briefing; `installer-agent` specialized persona; 3 skills: `setup-generate` (discover project, assemble manifest + scripts), `setup-run` (execute manifest with platform detection, param collection, 6-phase flow, dry-run, recovery confirmation), `setup-validate` (schema + reference + consistency + agentic-step audit); 11 cross-platform script templates (clone, install-deps for ubuntu/fedora/macos/windows, configure, verify, reset, hub-chain); lib helpers (`detect.sh`, `params.sh`, `verify.sh`, `detect.ps1`); rules: `installer-safety` (7 mandatory behaviors) + `installer-authoring` (5 rules); script-first design — `type: agentic` is exception handling only (#663–#667)
- **`aiwg-ci-safety` rule** (HIGH, aiwg-dev) — agents may never modify `.gitea/workflows/` without explicit human authorization; CI templates for user projects live in `agentic/code/frameworks/*/ci/` (inert source data, not AIWG's own CI); Gitea is the authoritative CI forge; GitHub is publish-only mirror; no agentic self-modification of CI pipelines; includes per-action allowed/forbidden table; `skill-placement.md` and `addon-boundaries.md` updated with CI template disambiguation sections
- **Skill namespace strategy** — ADR-driven three-layer system: `aiwg-{name}` slug prefix (universal collision prevention), `aiwg/` subdirectory (structural isolation), `namespace: aiwg` frontmatter (MCP alignment); collision detection wired into `use`, `doctor`, and `validate-metadata`; per-platform deployment adapters for all 10 platforms (#695–#704)
- **`aiwg serve`** — local HTTP server for AIWG web dashboard; WebSocket PTY stream bridge delivers live terminal output to the browser (#serve)
- **Mission Control Web UI** — React app with xterm.js terminal viewer, telemetry dashboard, fortemi-react panel (#web)
- **Artifact index: typed edges & filename-metadata** — cross-graph set queries (`union`, `intersection`, `difference`); citation sidecar parser; typed edge extraction; filename-metadata node strategy derives metadata from filename regex without reading file content; `MetadataSupplementConfig` enriches nodes from sidecar files (#723)
- **`no-time-estimates` rule** (HIGH, aiwg-utils) — agents must express effort in agent-oriented units: scope count (atomic deliverables), agent count and roles, parallelism map (parallel vs sequential batches), pass estimate (iterations to quality gate); wall-clock estimates (`N days/hours/weeks`, "expected duration", "this should be quick") are prohibited (#708)
- **Graph backends guide** (`docs/development/graph-backends.md`) — documentation for pluggable graph storage backends
- **Specification-complete layer (Layer 3 + Layer 4)** — 6 new behavioral specification templates (`state-machine-spec` DES-SM, `decision-table` DES-DT, `activity-diagram-spec` DES-ACT, `method-interface-contract` DES-MIC, `data-flow-spec` DES-DFS, `pseudocode-spec` DES-PSC) in `analysis-design/`; `flow-use-case-realization` orchestration command for multi-agent behavioral spec generation with 4-reviewer parallel review; ABM gate deepened with sections 3a (behavioral specs ≥80% coverage) and 8a (pseudo-code specs for first iteration); `check-traceability` rewritten for 6-layer enforcement (UC ↔ BS ↔ IC ↔ PC ↔ code ↔ tests) with orphan detection, `--fix` mode, and coverage metrics; `sdlc-accelerate` Phase 3 updated; 8 new `.aiwg/` artifact directories in framework manifest (#740–#746)
- **`agentic/code/addons/semantic-memory/`** — kernel addon: `memory-ingest`, `memory-lint`, `memory-query-capture`, `memory-log-append`, `memory-log-render` skills; `memory-log-event` JSON Lines schema with 10 op types (5 kernel + 5 training-specific); `core: true, autoInstall: true` (#823, #826, #827, #828, #829)
- **`agentic/code/addons/llm-wiki/`** — wiki addon with 5 profile templates (book-companion, personal, research-deep-dive, business-team, generic), schemas/page-schema, Obsidian integration docs, and `crossRefStyle: wikilink` topology; depends on semantic-memory kernel (#831)
- **`MemoryTopology` + `CrossRefStyle` TypeScript types** — in `src/extensions/types.ts`; extends `MemoryFootprint` with optional `topology` field; declared in all 4 consumer framework manifests (sdlc-complete, research-complete, forensics-complete, media-curator) (#825)
- **Profile picker for addons with multiple templates** — `aiwg use <addon>` detects `templates[]` array in plugin manifest, prompts user interactively (TTY) or reads `--profile <name>` flag, writes chosen selection to `.aiwg/<namespace>/config.json`
- **`validateMemoryTopology()` method** — in `MetadataValidator` at `src/plugin/metadata-validator.ts`; validates 6 required topology fields, `crossRefStyle` enum membership, `.aiwg/` namespace convention, non-empty `derivedPages`, array types for `lintRules`/`ingestRequires`
- **Kernel delegation sections** — `induct-research`, `intake-from-codebase`, `workspace-health`, `corpus-health`, `cleanup-audit` SKILL.md files gain a "Kernel Delegation" section documenting how they call `memory-ingest`/`memory-lint` under the hood while preserving their public UX (#830)
- **ADR-021** — Semantic Memory Kernel Architecture at `.aiwg/architecture/decisions/ADR-021-semantic-memory-kernel.md`; locks 6 decisions (location, interface, schema location, consumer ID resolution, backward compatibility, log format) (#824)
- **ADR-022** — AI Training Framework at `.aiwg/architecture/decisions/ADR-022-training-framework.md`; locks 10 decisions for the training-data pipeline; framework subsequently extracted to standalone repo (#822)
- **`training` marketplace plugin entry** — in `.claude-plugin/marketplace.json`, external source pointing at `jmagly/aiwg-training`; installable via `/plugin install training@aiwg` or `aiwg use training`
- **`docs/extensions/extension-types.md` MemoryTopology section** — documents the new contract with field table, `CrossRefStyle` enum table, and research-complete example
- **`aiwg session`** — self-healing session launcher; 5-step pre-flight: version check → `aiwg doctor` → deployment check → optional MCP inject → provider launch; `mcp` subcommand injects configured servers first; `--provider <p>` overrides provider; `--no-repair` skips auto-repair; repair escalates sync → npm reinstall → `aiwg feedback` escape hatch; IDE providers (cursor, windsurf, copilot, etc.) receive identical pre-flight then print start instructions instead of spawning a binary (#885)
- **`aiwg feedback`** — GitHub issue submitter; collects system context automatically (aiwg version, Node.js, OS, arch, provider, installed frameworks, shell); `--type bug|feature|doc|other`, `--title`, `--body`, `--no-context` flags; submission via `gh issue create --repo jmagly/aiwg` → browser URL pre-fill → stdout fallback; `report` alias; interactive prompts when TTY; surfaces from `aiwg doctor` on unresolvable issues (#885)
- **Session and feedback skills** — `agentic/code/addons/aiwg-utils/skills/session/SKILL.md` and `agentic/code/addons/aiwg-utils/skills/feedback/SKILL.md`; trigger patterns, examples, and clarification prompts for natural-language invocation across all providers (#885)
- **ADR template: Source Verification & Claim Tracking section** — table of Claim / Source / Verified / Date; unverified claims checklist blocks L2 acceptance (#863)
- **ADR template: Implementation Sketch section** — annotated code block, key integration points, known sharp edges (Phase 3) (#854)
- **ADR template: Concurrency and Shared State Model section** — concurrency model declaration, shared mutable state inventory, race conditions and mitigations, explicit out-of-scope (Phase 3) (#856)
- **ADR template: Testing Strategy section** — 5 layers: unit, integration, contract, performance, regression guard (Phase 3) (#858)
- **ADR template: Definition of Done section** — 5-level table L1 Proposed → L5 Verified; blocking-items checklist (Phase 3) (#860)

### Removed

- **Legacy `.aiwg/frameworks/registry.json` migration plumbing** (supersedes #1047 + #1054). The migration helpers (`migrateLegacyRegistry`, `checkLegacyRegistry`, `cleanupLegacyRegistry`, `hasElapsedMinorVersions`) and the `aiwg doctor` legacy-registry check were added on the assumption of external users with pre-#1040 installs. No such users exist — the only file in the wild was this repo's own dogfooding artifact. Removed: ~150 lines from `src/config/aiwg-config.ts`, the call from `aiwg init`, the wire-up from `aiwg refresh` (added in #1054 then immediately ripped out), the doctor check, the test block in `aiwg-config.test.ts`. Future fresh installs start on the unified `aiwg.config.installed` registry directly.
- **`agentic/code/frameworks/training-complete/`** (91 files, ~18K lines) — extracted to standalone repo at [`jmagly/aiwg-training`](https://github.com/jmagly/aiwg-training). History preserved via `git subtree split` (8 commits). Users on the training workflow install via `/plugin install training@aiwg`. Existing `.aiwg/training/` artifacts remain forward-compatible via the `memory.topology` contract.

### Changed

- **BEHAVIOR.md canonical shape — `metadata.scope` / `metadata.triggers`** (#1025). Three layers (files, daemon loader, validator) had diverged into three different shapes for the same data. Standardized on nested `metadata.*`. Daemon `behavior-loader.mjs` now reads `meta.metadata?.scope` and `meta.metadata?.triggers` (plural); replaced its homegrown YAML parser with `js-yaml` so it can actually represent nested mappings. Validator tightened to require `metadata.triggers` (dropped singular-trigger acceptance). All 7 BEHAVIOR.md files (6 from #1025, 1 lowercase `concierge.behavior.md` caught by #1018's CI run) updated to canonical shape.
- **`aiwg sync` renamed to `aiwg refresh`** (#932). The new name better matches the operation's semantics (re-deploy + health check, not a directional sync). `aiwg sync` continues to work as a deprecated alias and emits a runtime warning. Canonical docs (`CLAUDE.md`, `AIWG.md`, `docs/cli-reference.md`, agent playbooks, self-maintenance rule and templates) now use `aiwg refresh`. Removal target: after the 2026.5.x stable line; the alias will be removed in 2026.6.0.
- **Skill consumers respect resolved remotes** (#997). `commit-and-push`, `issue-create`, `issue-list`, `pr-review` SKILL.md prose updated to consult `resolveRemotes()` / `resolveRemoteProvider()` with explicit precedence: `--provider` flag > resolved `remotes.issue_tracker` URL host > legacy `.aiwg/config.yaml` ticketing > `CLAUDE.md` block > `local`. Self-hosted instances classified as `'unknown'` prompt the operator rather than guessing.
- **Skill consumers respect resolved delivery policy** (#1007). Same skills updated to consult `resolveDelivery()` for `mode` (controls branch creation + PR opening), `force_push_policy`, `require_signed_commits`, `branch_naming`, `merge_style`, `delete_branch_on_merge`, `require_ci_green`, `auto_close_issues`, `issue_comment_on_cycle`. Defaults preserve today's behavior.
- **`aiwg index build --help`** — now shows full usage including `--scope`, `--all`, user-defined graph usage, and `defaultBuild` semantics; `--graph` description updated to mention user-defined names (#660)
- **`docs/cli-reference.md` index section** — documents user-defined graphs (`index.graphs` config schema), `defaultBuild` behavior, doc-only repo example, and `--all` flag (#660)
- **`aiwg add-command`** — deprecated; `aiwg add-skill` is the replacement
- **All CLI commands** — consistent output via shared `ui.ts` module
- **`aiwg use` post-deploy guidance** — `<provider>/<framework>` keys; platform-appropriate next steps
- **Command count** — 50 → 55 (`behavior`, `daemon-init`, `ralph-attach`, `session`, `feedback` added)
- **`aiwg doctor` recovery output** — now surfaces `aiwg session --no-repair`, `aiwg sync`, and `aiwg feedback --type bug` as concrete recovery options when health checks fail
- **`aiwg serve` install hint** — updated to include `ws` (`npm install hono @hono/node-server ws`)
- **`tools/eval` — matric-eval dependency** (#488) — `EvalRunner` renamed to `AiwgEvalRunner` (composes `MatricEvalClient`); `EvalRunner` kept as backward-compat alias; `tools/eval/.npmrc` scopes `@matric` packages to Gitea registry
- **`aiwg use` output** — modern clean progress UI replacing legacy verbose output (#428)
- **`aiwg index stats`** — `--graph` flag now optional; flexible graph type support (#425, #426)
- **`aiwg index`** — deploy next-steps guidance added to post-build output; verbose mode flag
- **`CommandCategory` type** — extended with `'orchestration'` (Mission Control), `'config'`, `'ops'`, and `'daemon'` variants; CLI handler index updated with `skillsHandler`, `configHandler`, `opsHandler`
- **BEHAVIOR.md platform lists** — all 6 behaviors updated to the full Tier 1 daemon set `[claude-code, opencode, warp, openclaw, codex]`; `cursor` removed from concierge (Tier 3 — VS Code extension host required) (#654, #656)
- **aiwg-utils rule count** — 7 → 13 rules (added `human-authorization` + 5 OpenProse antipatterns)
- **aiwg-utils rule count** — 13 → 14 rules (added `no-time-estimates`)
- **CI enforcement** — "CI Green Before Done" added as HIGH enforcement rule in `CLAUDE.md`
- **`test:ci` simplified** — single `vitest run` covering unit + integration + characterization + smoke; UAT config kept separate
- **Framework count** — 6 → 5 locally (training-complete extracted to marketplace). Still 6 total if the marketplace plugin is counted.
- **Addon count** — 21 → 23 (+ `semantic-memory`, + `llm-wiki`)
- **`memory.topology` added to 4 framework manifests** — sdlc-complete, research-complete, forensics-complete, media-curator each declare their topology contract (#825)
- **`memory-log-event` schema extended** — 5 new training-specific op types (`format-convert`, `decontamination-check`, `preference-generate`, `synthetic-generate`, `dataset-version`); no breaking changes to existing kernel ops (#834)
- **Default consumer addon behavior** — when Fortemi is absent, `aiwg index` serves as the graph fallback (ADR-021 D3)
- **`.claude-plugin/marketplace.json` version** — bumped from stale `2024.12.4` to `2026.4.0` across marketplace metadata and all plugin entries

### Fixed

- **Cross-framework agent/command/skill filename collisions no longer overwrite silently** (#1169). When two AIWG frameworks ship a file with the same filename but different content (e.g., `forensics-complete` and `research-complete` both ship `agents/acquisition-agent.md`), the second deploy used to clobber the first with no signal. `tools/agents/providers/base.mjs deployFiles()` now records the framework slug per managed file in the `.aiwg-manifest.json` sidecar and detects two collision modes: **within-batch** (two source files in one deploy call) and **cross-batch** (a new deploy hits an existing sidecar entry from a different framework). Default is skip-with-loud-warning; `--force` is the explicit override (last-wins, sidecar updates owner). Identical-content cases still skip silently as `duplicate-identical`. New `extractFrameworkSlug()` helper exported. ADR at `.aiwg/architecture/adr-cross-framework-collision-guard.md` covers the design and defers source rename of the four documented collisions to [#1211](https://git.integrolabs.net/roctinam/aiwg/issues/1211) for 2026.5.1. 10 new unit tests in `test/unit/agents/cross-framework-collision.test.mjs`.
- **Claude Code `settings.json` hooks field shape** (#107). `aiwg use --provider claude` (and the CLI extension hook auto-registration introduced in #480) wrote the `hooks` field as an array of `{matcher, hooks}` objects. Claude Code requires an object keyed by event name with matcher-group arrays as values — the array shape was silently ignored and surfaced as `"hooks" must be an object mapping event names to matcher arrays; received array. This field was ignored.` from `/doctor`. Fixed in both writers (`src/extensions/claude-hooks-installer.ts` and `src/cli/cli-extension-loader.ts`). Already-broken settings heal in place: a legacy array-shaped `hooks` field is migrated to the object form on read; operator-authored entries are preserved; the AIWG-marker detector recognizes both shapes so backups are not double-created during migration. Run `aiwg refresh` (or any `aiwg use --provider claude`) once after upgrading to convert existing installs. 19 new/updated unit tests across the two installer modules.
- **Managed-marker no longer breaks Claude Code agent discovery** (#1059). `addManagedMarker()` in `tools/agents/providers/base.mjs` prepended `<!-- aiwg:managed v... ... -->` as line 1 of every deployed `.md` file, which shifted YAML frontmatter to line 2 and made all 189 deployed agents invisible to Claude Code's Task tool (`subagent_type` resolver). The marker now lives **inside** the frontmatter as a YAML comment (`# aiwg:managed v... ...`), keeping `---` on line 1 where the parser expects it. Files without frontmatter retain the legacy HTML-comment-at-top form (no parser to break). `MANAGED_MARKER_RE` matches both forms so legacy-marker files are still recognized as already-managed and don't get a second marker. Same fix benefits Codex / Copilot / Cursor / Factory / OpenCode / Warp / Windsurf / OpenClaw — every provider that loads agents from frontmatter. After upgrading, run `aiwg refresh` to redeploy.
- **`aiwg doctor` no longer false-positives on framework workspace dirs** (#1058). `src/extensions/project-local-discovery.ts` treated every directory under `.aiwg/{extensions,addons,frameworks,plugins}/` as a candidate bundle and emitted a "manifest.json absent" error for any directory without one. That tripped on the 7 framework workspace dirs (`archive/`/`projects/`/`repo/`/`working/`) created by `initializeFrameworkWorkspace()` under the same path namespace, producing `Validation: ✗ 7 errors` on every clean project. The scanner now silently skips directories without `manifest.json` — same "absent = not a bundle" semantics already applied to non-directory entries. `loadAndValidateManifest()` keeps its strict semantics for direct callers.
- **Factory provider now transforms SKILL.md frontmatter on deploy** (#1056). `tools/agents/providers/factory.mjs` previously copied `SKILL.md` verbatim, so deployed `.factory/skills/*/SKILL.md` retained Claude-native tool names (`Bash`, `Write`, `MultiEdit`) and bare model shorthand (`opus`/`sonnet`/`haiku`) inside `commandHint`. New `transformSkillFrontmatter()` rewrites indented `commandHint.allowedTools` and `commandHint.model`; new `mapAllowedToolsString()` tokenizer respects allowlist parens (`Bash(git *, gh *)` → `Execute(git *, gh *)`). `deploySkillDir()` in `base.mjs` now accepts an optional `transformSkillMd` callback so other providers can adopt the same pattern. 3 new regression tests in `test/integration/factory-deployment.test.ts`.
- **`aiwg doctor` is now provider-aware** (#1057). Doctor previously hardcoded `.claude/agents` and `.claude/commands`, so projects deployed to Factory/Codex/Cursor/Copilot/etc. saw "No agents deployed" even when their provider directories were fully populated. New `--provider <name>` and `--all-providers` flags; auto-detection scans `.factory/droids`, `.codex/agents`, `.cursor/agents`, `.github/agents`, `.opencode/agent`, `.warp/agents`, `.windsurf/agents`, plus root `AGENTS.md`. Per-provider checks resolve paths from each provider module's exported `paths.{agents,commands}` instead of literal `.claude/*` strings; output now reads "Factory Agents", "Codex Agents", etc. 3 new regression tests in `test/unit/cli/doctor.test.ts`; CLI reference updated.
- **`Test` and `Build` jobs in `ci.yml` no longer fail on sharp native build** (#1018). Both jobs used `npm ci --omit=optional` with a comment claiming the flag skipped sharp. It didn't. Sharp is a hard dep of `@xenova/transformers` (devDep); the flag actually skipped sharp's _own_ `optionalDependency` on the prebuilt `@img/sharp-libvips-linux-x64` binary, forcing a from-source gyp build that needed `libvips-dev` headers. Plain `npm ci` resolves sharp's prebuilt cleanly. Other workflows already used plain `npm ci`; only `ci.yml` carried the inherited workaround.
- **Five broken SKILL.md frontmatter files** (#1013). `argumentHint` values in 4 ralph skills (`ralph`, `ralph-status`, `ralph-abort`, `ralph-resume`) contained unquoted brackets and trailing tokens that failed strict YAML parse. Quoted as single-quoted scalars. `eval-report/SKILL.md` was missing the required `name:` field — added.
- **All 59 invalid YAML frontmatter files across SKILL.md corpus** (#1015 Phase A.1). Same bug class as #1013, found by a corpus-wide audit using the new linter. Fixed in three per-component PRs across uat-mcp, prose-integration, rlm, media-curator (9 files), media-marketing-kit (19 files), and sdlc-complete (31 files).
- **All 308 SKILL.md files missing `name:` field** (#1015 Phase A.2). Mechanical backfill from parent directory name across aiwg-utils, aiwg-dev, aiwg-evals, forensics-complete, guided-implementation, nlp-prod, research-complete, voice-framework, and the components from A.1. Source corpus (`agentic/code/`) is now 410/410 clean against the linter.
- **`aiwg validate-metadata`'s recursive walker now sees SKILL.md** (#1014). Previously hardcoded to match only `manifest.md`/`BEHAVIOR.md`, so SKILL.md was invisible to directory-mode validation even though the validator demanded `metadata.*` fields the files didn't have.
- **`aiwg ops init` no longer creates nested ops workspaces** (#935). `initWorkspace()` walks up from the target home looking for `OpsInventory.yaml` and refuses with a clear error and a suggested sibling path if it finds one in an ancestor.
- **`aiwg validate-metadata` no longer crashes with `ERR_MODULE_NOT_FOUND`** (#1001). Import path drift in `tools/cli/validate-metadata.mjs:11` — was importing `../../dist/plugin/metadata-validator.js`, but the TS build emits to `../../dist/src/plugin/metadata-validator.js`. One-line fix plus a regression test that parses the import statement and asserts it resolves to a real file on disk.
- **`aiwg use all` rule count off-by-many** — `countDeployedArtifacts` was counting `.md` files in the rules directory; with `deployIndexOnly: true`, only `RULES-INDEX.md` exists on disk, so it always returned 1; replaced with `countRules()` that parses `(N rules — ...)` section headers in RULES-INDEX files and sums across all indexes
- **`aiwg index build` hard-error on docs-only repos** — `codebase` graph (defaultBuild, scans `src/test/tools`) now skips with a warning when those directories don't exist; only errors when `--graph codebase` is explicitly requested (#658)
- **User-defined graphs not recognized via `--graph`** — `loadUserGraphConfigs` used `require()` which is undefined in ESM; replaced with static `import`; user graphs in `.aiwg/config.yaml` now load and validate correctly (#659)
- **`sdlc-accelerate` handler** — "No handler found" error; `SdlcAccelerateHandler` implemented
- **External agent loop startup crash** — `SemanticMemory` constructors received objects instead of path strings; loops always dead on arrival
- **`--dangerous` flag position** — was appended after prompt; moved before so it is treated as CLI flag
- **Codex model IDs** — `gpt-5.3-codex` aliases now map to gpt-5.4 canonical IDs (#590)
- **OpenCode 1.0.x adapter** — event-stream parsing updated; silent output drop fixed
- **Factory command injection** — `$ARGUMENTS` now injected at deploy time (#454)
- **`aiwg doctor` AIWG_ROOT resolution** — resolved from script location, not hardcoded path
- **`aiwg index` without `--graph`** — multi-graph architecture; stats/query/deps now work without flag (#425)
- **`ralph-external`, `ralph-memory`, `ralph-config` handlers** — three CLI commands had no registered handlers; all implemented
- **`aiwg use sdlc --provider hermes`** — unknown provider error; Hermes provider added
- **`commit-and-push`** — oversized prompt trimmed; local model documentation added (#436)
- **`sync.ts` unused variable warnings** — removed unused `providerResult` and `versionResult` assignments
- **Incorrect provider configs** — Hermes was listed as a spawnable binary (it is not; it is model-series-only accessible via Ollama or MCP); OpenCode's `promptPrefix` was missing `['run']`, causing invocations without the required subcommand
- **`CommandCategory` type** — added `'daemon'` variant; fixed missing categories in help order
- **`new-project` in skills catalog** — was not registered in `skills.manifest.json`; now correctly discoverable via `aiwg skills list`
- **OpenCode deployment** — stop deploying agents and commands to non-existent `.opencode/agent/` and `.opencode/command/` directories (#705)
- **Windsurf skill deployment** — implement native skill deployment; remove experimental label (#703)
- **Platform-resolver stale entries** — Factory, Warp, and Copilot corrected from one-level/unknown to deep-recursion per source-confirmed research (#702, #704)
- **CI test scope** — `test:ci` widened to run all non-inference tests (characterization, integration, smoke); only live inference UATs excluded; removed redundant "Full Test Visibility" CI job; `package-lock.json` synced
- **Manifest skill arrays** — 34 aiwg-utils skills and 7 RLM skills migrated from `commands[]` to `skills[]` in `manifest.json` (#706, #707)
- **Agent-loop addon** — renamed from `ralph/`; 5 missing skills registered; Wiggum terminology removed; `al`/`agent-loop` aliases added (#705)
- **Gitea reference leakage in user-facing docs** — `README.md` + `docs/install/non-interactive.md` + `docs/project-local/overview.md` + `docs/daemon-guide.md` pointed at internal `git.integrolabs.net` URLs; replaced with public `github.com/jmagly/*` equivalents. Internal CI documentation (`docs/contributing/ci-cd-secrets.md`, `docs/frameworks/sdlc-complete/token-security.md`) retains Gitea references as intended — that's where the CI runs.
- **`aiwg serve` WebSocket 404** — `createNodeWebSocket` does not exist in `@hono/node-server` v1.19.14; `try/catch` silently swallowed the import failure leaving `upgradeWebSocket = null`; all `/ws/sandbox/:id` connections returned 404; replaced with `setupWebSockets()` using native Node.js `upgrade` event + `ws` package `WebSocketServer({ noServer: true })` (#851)
- **`ws` package not installed for `aiwg serve`** — `ws` added to `optionalDependencies` and to the auto-install list run on first `aiwg serve` launch

### Internal

- New unit tests: 7 for `aiwg skill-lint` rubric (perfect/stub/no-triggers/agent-only/broken-YAML fixtures + threshold modes). Behavior-loader and concierge integration tests updated for canonical metadata.* shape.
- `.agents/` deployment directory is now gitignored, mirroring `.claude/` and `.codex/` (#949). 395 generated files removed from the index; regenerable via `aiwg use`.

[Unreleased]: https://github.com/jmagly/aiwg/compare/v2026.8.26...HEAD
[2026.8.26]: https://github.com/jmagly/aiwg/compare/v2026.8.25...v2026.8.26
[2026.8.25]: https://github.com/jmagly/aiwg/compare/v2026.8.20...v2026.8.25
[2026.8.20]: https://github.com/jmagly/aiwg/compare/v2026.8.19...v2026.8.20
[2026.8.10]: https://github.com/jmagly/aiwg/compare/v2026.8.9...v2026.8.10
[2026.6.2]: https://github.com/jmagly/aiwg/compare/v2026.6.1...v2026.6.2
[2026.6.1]: https://github.com/jmagly/aiwg/compare/v2026.6.0...v2026.6.1
[2026.6.0]: https://github.com/jmagly/aiwg/compare/v2026.5.13...v2026.6.0

## [2026.3.2] - 2026-03-04 – Service Release

| What changed                       | Why you care                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **`--use-dev` delegates full CLI** | `aiwg` commands now run from local build — not just framework content, but all subcommands including `aiwg index` |
| **`aiwg index` multi-graph fixes** | `stats`, `query`, `deps` without `--graph` now work correctly across project + codebase graphs                    |
| **`--graph` flag documented**      | CLI reference updated with multi-graph architecture, `framework` graph usage, and new output format               |

### Fixed

- **`aiwg index stats` without `--graph`** failed with "No artifact index found" because `indexExists()` checked the legacy `.aiwg/.index/metadata.json` root path; all three stats/query/deps commands now check graph subdirectories first with legacy fallback
- **`aiwg index query` without `--graph`** same legacy-path bug — now searches across `project` + `codebase` graphs combined
- **`aiwg index deps` without `--graph`** same legacy-path bug — now merges dependency graphs from all project-local graphs
- **`--use-dev` only changed framework content source** — CLI commands still ran npm-installed code; now the entry point delegates all subcommands to the dev repo's `src/cli/facade.mjs`
- **`--use-dev` always pointed at npm package root** — now accepts an explicit path argument (`aiwg --use-dev /path/to/repo` or `aiwg --use-dev .`)

### Changed

- `aiwg index stats` without `--graph`: human-readable output shows each graph with a section header; JSON mode returns object keyed by graph name
- `aiwg index query` without `--graph`: searches across all project-local graphs, returns merged results
- `aiwg index deps` without `--graph`: merges dependency graphs from all project-local graphs before traversal
- `switchToDev()` validates that `src/cli/facade.mjs` exists in the target repo and prints CLI source path in confirmation output

### Added

- **Framework graph** (`--graph framework`): `aiwg index build --graph framework` indexes `agentic/code/` + `docs/` (1,625 artifacts); stored in `.aiwg/.index/framework/`
- **Multi-graph architecture documented** in `docs/cli-reference.md` — graph types table, `--graph` flag on all index subcommands, output structure, examples

---

## [2026.3.1] - 2026-03-03 – "Discovery & Durability" Release

| What changed                        | Why you care                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`aiwg index` subsystem**          | Agents can search, query deps, and inspect stats across `.aiwg/` artifacts                      |
| **Forensics agent gap-fills**       | 6 agents and 3 commands rewritten with full operational detail; 660-line integration test suite |
| **Color Palette addon**             | Standalone addon for accessible color palette generation with WCAG contrast checking            |
| **Ralph external crash resilience** | SnapshotManager API fixed, state cleanup, e2e tests with real process spawning                  |
| **`.aiwg/` tracked in git**         | Project artifacts version-controlled, excluded from npm/edge deploys                            |
| **Documentation accuracy sweep**    | 7 drift items fixed: agent counts, command totals, skill manifest gaps, Copilot path mismatch   |
| **`--model` blanket override**      | `aiwg use sdlc --model sonnet` overrides all agent model selections                             |
| **`--use-dev` testing flag**        | Point CLI at local repo checkout for framework development                                      |

### Added

- **`aiwg index` subsystem** — `build`, `query`, `deps`, `stats` subcommands for artifact discovery with multi-graph architecture, incremental builds, and JSON output
- **`artifact-discovery` rule** — agents must query the index before phase work and check deps before modifying artifacts
- **`artifact-lookup` skill** — natural language artifact search via `aiwg index` CLI
- **`aiwg cleanup-audit` command** — dead code analysis with `dead-code-analyzer` agent and `cleanup-audit` skill
- **`--model` blanket override** — `aiwg use sdlc --model sonnet` sets all agent model selections in one flag
- **`--use-dev` flag** — `aiwg --use-dev` points CLI at local repo for development testing
- **Color Palette addon** (`agentic/code/addons/color-palette/`) — 3 skills (color-palette, color-accessibility, color-trends), 2 templates, 1 rule
- **`.aiwg/` git tracking** — project artifacts version-controlled with npm/edge exclusion gates
- **Forensics integration tests** — 660-line test suite validating agent structure, manifest integrity, skill completeness, and cross-references
- **Ralph external e2e tests** — real process spawn tests with stub CLI and provider adapter fixtures
- **How AIWG Works guide** (`docs/how-it-works.md`) — plain-language explainer with research-grounded memory section
- **Mobile responsive CSS** for docsite template

### Changed

- **Forensics agents** — 6 agents rewritten with full operational procedures: acquisition-agent, container-analyst, log-analyst, network-analyst, persistence-hunter, triage-agent (#381-391)
- **Forensics commands** — 3 commands expanded: forensics-acquire, forensics-investigate, forensics-triage
- **Forensics skills** — 3 skills updated: container-forensics, evidence-preservation, log-analysis
- **Skills manifest** — added 12 missing entries (code-chunker, decompose-file, issue-driven-ralph, 9 regression-* skills); 20 → 32 total
- **Skill inventory** — SDLC skills 12 → 32 listed, total 53 → 75
- **CLAUDE.md** — command count 44 → 47, Ralph category 4 → 7, added ralph-external/memory/config
- **cli-reference.md** — agent count 35+ → 90, Ralph category 4 → 7, total 44 → 47
- **SDLC README** — agent count 70+ → 90
- **Multi-graph index architecture** — content type graphs, dependency graphs, incremental build support
- **`traceability-check` skill** — updated to use `aiwg index` for artifact lookup

### Fixed

- **`platform-paths.ts`** — Copilot commands path `.github/commands` → `.github/agents` to match JS provider behavior
- **Ralph external SnapshotManager** — API mismatch causing fatal path error during loop execution
- **Agent loop state cleanup** — completed loops now clean up state files automatically
- **Unused `basename` import** in ralph-launcher removed
- **CI `.aiwg/` exclusion** — added gates to build-plugins, ci, and npm-publish workflows

---

## [2026.3.0] - 2026-03-01 – "Model Sync" Service Release

| What changed                                  | Why you care                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Factory provider model IDs fixed**          | `aiwg use sdlc --provider factory` now deploys valid model IDs that Factory can resolve                                             |
| **All provider model configs updated to 4.6** | Claude, Factory, Windsurf, and shorthand mappings now reference `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| **Factory shorthand decoupled**               | `mapModel()` prefers `factory_shorthand` over shared `shorthand`, preventing future cross-provider drift                            |

### Fixed

- **`factory.mjs` DEFAULT_FACTORY_MODELS** — removed invalid `anthropic/` prefix and updated stale model IDs (`anthropic/claude-opus-4-20250514` → `claude-opus-4-6`, etc.) (Fixes #410)
- **`base.mjs` loadModelConfig() fallback** — replaced invalid IDs (`claude-opus-4-1-20250805`, `claude-haiku-3-5`) with current Factory-compatible IDs
- **`models.json` factory section** — updated from stale `claude-haiku-3-5` / `claude-opus-4-5-20251101` to current model IDs
- **`models.json` shorthand section** — updated shared shorthand mappings to current model IDs

### Changed

- **`models.json` claude + windsurf sections** — updated to Claude 4.6 model family
- **`factory.mjs` mapModel()** — now prefers `factory_shorthand` config key over shared `shorthand` for Factory-specific model resolution

---

## [2026.2.15] - 2026-02-28 – "Doc Site" Release

| What changed                    | Why you care                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **docs.aiwg.io CI/CD pipeline** | Doc site builds and deploys automatically on every release tag via Gitea Actions                                   |
| **Doc site build validation**   | PRs and pushes that touch `docs/` trigger build checks to catch broken links early                                 |
| **Broken link remediation**     | 25 doc files fixed — relative links to source files replaced with absolute URLs that resolve on the published site |
| **Welcome page refresh**        | Landing page now showcases all 5 frameworks, 5 addons, and 8 platform targets                                      |

### Added

- **`docsite-build.yml` workflow** — validates doc site builds on push/PR to main/develop when `docs/**` changes; uses dbbuilder publisher with `strictLinks: true` for broken link detection
- **`docsite-deploy.yml` workflow** — builds and deploys doc site to docs.aiwg.io on `v*` tag push via SSH/rsync to integro-dev-004; includes build verification, SSH key management, and post-deploy checks
- **Reliability Patterns section** on welcome page — Agent Loop, Ensemble Validation, @-Mention Traceability
- **CLI Reference** quick link on welcome page

### Changed

- **Welcome page** — expanded from 3 pillars to full framework/addon showcase (SDLC Complete, Forensics Complete, Research Complete, Media/Marketing Kit, Media Curator, RLM, Voice Framework, Testing Quality, Writing Quality, UAT-MCP)
- **25 doc files** — replaced broken relative links (`../../agentic/`, `../../tools/`, `../../CHANGELOG.md`) with absolute GitHub URLs and `aiwg.io/changelog`
- **`docs/getting-started/prerequisites.md`** — fixed "Continue to Quick Start" link to point to `docs/quickstart.md`
- **`docs/overrides/index.html`** — converted search shortcut from `<span>` to accessible `<button>` element
- **`docs/overrides/styles.css`** — added `.shortcut-btn` styles for status bar interactivity
- **`docs/config.json`** — updated lead copy, expanded pillars to per-framework descriptions, added CLI Reference quick link

### Fixed

- **Root-level doc pages** — cleaned up and moved legal pages to proper locations

---

## [2026.2.14] - 2026-02-28 – "Forensics & Manageability" Release

| What changed                                   | Why you care                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Forensics-complete DFIR framework**          | Full digital forensics lifecycle — 13 agents, 9 commands, 10 skills, Sigma hunting, evidence chain-of-custody            |
| **Codebase manageability tooling (#402-#407)** | Rules, commands, and skills to keep agent-generated code within context window limits                                    |
| **17 specialist agents + team compositions**   | Cloud platform experts (AWS/Azure/GCP), framework specialists (React, Django, Spring Boot), and 7 pre-built team configs |
| **UAT-MCP toolkit addon**                      | MCP-powered user acceptance testing with coverage tracking and structured test plans                                     |
| **Model optimization & prompting guides**      | 8 new documentation guides covering Claude, GPT, local models, hybrid architectures, and prompting techniques            |

### Added

- **Forensics-complete framework** (`agentic/code/frameworks/forensics-complete/`) — 13 DFIR agents (acquisition, memory, network, log, cloud, container, IOC, persistence, timeline, triage, recon, reporting, orchestrator), 9 investigation commands, 10 skills (linux-forensics, cloud-forensics, container-forensics, memory-forensics, evidence-preservation, sigma-hunting, ioc-extraction, log-analysis, supply-chain-forensics, target-profiling), 8 Sigma rule templates, 7 investigation templates, 4 enforcement rules (evidence-integrity, non-destructive, red-flag-escalation, volatility-order), 5 YAML schemas
- **Agent-friendly-code rule** (`rules/agent-friendly-code.md`) — quantitative thresholds (300 LOC warning, 500 error per file; 30/50 lines per function; 3/4 nesting depth) and 6 qualitative patterns for agent-processable code structure (#402)
- **Agent-generation-guardrails rule** (`rules/agent-generation-guardrails.md`) — runtime guardrails preventing agents from creating or enlarging files beyond agent-friendly limits; checks file size before writing (#405)
- **`/codebase-health` command** — scans source code, reports agent-readiness score (0-100), file size distribution, anti-pattern detection, actionable recommendations; supports text/JSON/markdown output and CI mode (#403)
- **`/complexity-gate` command** — CI-friendly pass/fail complexity enforcement with baseline mode for incremental adoption, `--changed-only` for pre-commit hooks, JSON output for pipeline parsing (#406)
- **`/decompose-file` skill** — guided source code splitting with dependency analysis, import rewiring, and test verification; 5-step workflow (Analyze → Plan → Execute → Rewire → Verify) (#404)
- **`/code-chunker` skill** — navigable structural maps of large files with function/class/block depth levels, map/JSON/tree output formats, and section-level navigation (#407)
- **17 specialist agents** — AI/ML Engineer, AWS/Azure/GCP Specialists, Blockchain Developer, Compliance Checker, Cost Optimizer, Data Engineer, Django Expert, Frontend Specialist, Kubernetes Expert, Migration Planner, Mobile Developer, Multi-Cloud Strategist, React Expert, Spring Boot Expert, Technical Debt Analyst
- **7 team compositions** (`teams/`) — pre-built agent team configurations for API development, full-stack, greenfield, maintenance, migration, and security review scenarios with role assignments and coordination patterns
- **UAT-MCP toolkit addon** (`agentic/code/addons/uat-mcp/`) — 2 agents (uat-planner, uat-executor), 3 commands (uat-generate, uat-execute, uat-report), 1 skill (uat-mode), 3 YAML schemas (uat-plan, uat-result, uat-coverage), 4 templates
- **Model optimization guides** (`docs/models/`) — Claude optimization, GPT optimization, local models, hybrid architectures
- **Prompting technique guides** (`docs/prompting/`) — chain-of-thought, context optimization, few-shot learning, role-based prompting

### Changed

- **README.md** — added forensics-complete and UAT-MCP to frameworks/addons tables; updated agent count to 85+; updated command count to 75+; updated CLI reference link to 42 commands; added codebase health examples to "See It In Action"
- **CLAUDE.md** — added forensics-complete to repository structure and key references
- **Rules manifest** — updated to 33 rules total (added agent-friendly-code and agent-generation-guardrails)
- **RULES-INDEX.md** — updated to 33 rules across 3 tiers (added 2 new SDLC HIGH rules)

### Fixed

- **README percentage claims** — removed hard percentage claims that lacked citation backing

---

## [2026.2.13] - 2026-02-26

| What changed                         | Why you care                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Site deploy on tag push (#355)**   | Pushing a version tag now auto-triggers an aiwg.io rebuild so the marketing site stays current |
| **Skill/command name collision fix** | Providers now prefer skills over commands when both share a name, preventing silent overwrites |

### Added

- **`notify-site.yml` workflow** — dispatches `aiwg.io` deploy on `v*` tag push, passing version and tag inputs via `AIWG_IO_DISPATCH_TOKEN`

### Fixed

- **Provider name collisions** — skill definitions now take precedence over commands when names collide during deployment

---

## [2026.2.12] - 2026-02-26 – "Doc Sync & Accelerate" Release

| What changed                             | Why you care                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **`aiwg doc-sync` command (#41)**        | Detect and fix documentation-code drift with 8 parallel auditors, cross-reference checks, and auto-fix patterns |
| **`aiwg sdlc-accelerate` command (#42)** | End-to-end SDLC ramp-up from idea to construction-ready with state machine pipeline and resume support          |
| **2 new skills**                         | `doc-sync` and `sdlc-accelerate` registered in skills manifest with trigger phrases                             |
| **Accelerate state schema**              | YAML-defined state machine for pipeline phase tracking with gate results                                        |
| **Construction Ready Brief template**    | Handoff artifact template for construction-ready projects                                                       |
| **Doc-sync auditor templates**           | Task definitions for 8 domain auditors and 4 cross-reference checks                                             |
| **Auto-fix patterns**                    | Concrete fix patterns for 5 auto-fixable drift categories with safety checks                                    |
| **24 integration tests**                 | Full test coverage for sdlc-accelerate entry points, phase resume, gate handling, state management, dry-run     |
| **HashiCorp references removed**         | All vendor-specific HashiCorp/Terraform/Vault references replaced with generic equivalents across 16 files      |
| **CLI reference accuracy**               | Command counts, categories, and totals corrected to match actual 42-command inventory                           |

### Added

- **`doc-sync` command** — bidirectional documentation-code synchronization with `code-to-docs`, `docs-to-code`, and `full` directions, parallel auditor dispatch, incremental scanning, and auto-fix with Ralph refinement
- **`sdlc-accelerate` command** — orchestrates intake → LOM gate → elaboration → ABM gate → construction prep → brief generation with `--from-codebase`, `--resume`, `--skip-to`, and `--dry-run` switches
- **`doc-sync` skill** (`agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md`) — natural language trigger for documentation drift detection
- **`sdlc-accelerate` skill** (`agentic/code/frameworks/sdlc-complete/skills/sdlc-accelerate/SKILL.md`) — natural language trigger for SDLC pipeline acceleration
- **Accelerate state schema** (`agentic/code/frameworks/sdlc-complete/schemas/flows/accelerate-state.yaml`) — defines phase lifecycle, gate results, and decision tracking
- **Construction Ready Brief template** (`agentic/code/frameworks/sdlc-complete/templates/management/construction-ready-brief-template.md`) — structured handoff template with architecture, iteration plan, and risk sections
- **Auditor task templates** (`agentic/code/frameworks/sdlc-complete/templates/doc-sync/auditor-tasks.md`) — 8 Wave 1 domain auditors (cli-ref, extension-type, provider, skill, agent, config, readme, changelog) and 4 Wave 2 cross-reference checks
- **Auto-fix patterns** (`agentic/code/frameworks/sdlc-complete/templates/doc-sync/auto-fix-patterns.md`) — fix patterns for numeric claims, table entries, argument hints, broken links, and broken @-mentions
- **Integration tests** (`test/integration/sdlc-accelerate.test.ts`) — 24 tests covering command definition, entry point detection, phase resume, gate handling, state file management, and dry-run behavior

### Changed

- **Skills manifest** updated with `doc-sync` and `sdlc-accelerate` entries including trigger phrases
- **Skill inventory** (`docs/development/skill-inventory.md`) updated: SDLC Framework Skills count 8→10, total 53→55
- **CLI reference** (`docs/cli-reference.md`) corrected: Ralph commands 7→4, added Metrics (3), Documentation (1), SDLC Orchestration (1), Reproducibility (4) categories, total 36→42
- **CLAUDE.md** updated with doc-sync and sdlc-accelerate in CLI quick reference

### Fixed

- **HashiCorp vendor lock-in** — replaced all HashiCorp-specific references (Terraform, Vault, Consul, Packer) with generic equivalents across 16 files including agent definitions, security templates, deployment templates, legal templates, and toolsmith configs
- **CLI reference command counts** — total command count corrected from stale "40" to actual "42"; Ralph category corrected from 7 non-existent commands to actual 4
- **Duplicate plugin agents** — synced `plugins/sdlc/agents/` with framework source for cloud-architect, devops-engineer, and security-auditor

---

## [2026.2.11] - 2026-02-24 – "Service Verify"

Maintenance release: CI improvements for auto-creating Gitea releases on tag push, Codex SKILL.md YAML fixes.

---

## [2026.2.10] - 2026-02-22 – "Alt Platform Service"

Maintenance release: tracked agent sources for CI, alternative platform service verification.

---

## [2026.2.9] - 2026-02-15 – "Manifest Native" Release

| What changed                                  | Why you care                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Provider normalization complete**           | All 8 providers now discover framework artifacts via manifests rather than provider-specific hardcoding                    |
| **Codex parity for research + media-curator** | Codex prompt and skill deployment now includes new framework components through the same discovery path as other providers |
| **Automatic framework onboarding**            | Adding a framework with a valid `manifest.json` is now enough for CLI discovery/deployment in provider flows               |
| **Less manual curation**                      | Provider modules were simplified and centralized around shared manifest-aware utilities                                    |

### Added

- `agentic/code/frameworks/research-complete/manifest.json` for explicit framework metadata and artifact entrypoints
- Manifest-driven framework discovery and mode resolution in shared provider utilities (`discoverFrameworks`, `getFrameworksForMode`, `collectFrameworkArtifacts`)
- Coverage updates in deployment tests to validate new framework/provider artifact paths and install behavior

### Changed

- Provider deployment logic normalized across Claude, Codex, Copilot, Cursor, Factory, OpenCode, Warp, and Windsurf
- Codex command prompt deployment now discovers framework command directories from framework manifests/mode selection
- Codex skill deployment now discovers framework skills from framework manifests/mode selection
- CLI/provider deployment plumbing refactored to reduce duplicated framework routing code

### Fixed

- Missing Codex deployment coverage for newly added framework components (research and media-curator)
- Gaps where framework additions required manual provider-by-provider updates instead of manifest-driven discovery

## [2026.2.8] - 2026-02-14 – "Full Catalog" Release

| What changed                       | Why you care                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`aiwg use media-curator`**       | Media Curator framework now deployable as a standalone CLI target across all 8 providers                 |
| **`aiwg use research`**            | Research Complete framework now deployable as a standalone CLI target across all 8 providers             |
| **Complete provider list in help** | All 8 providers (claude, copilot, factory, codex, cursor, opencode, warp, windsurf) shown in `aiwg help` |
| **Documentation audit**            | Stale agent counts, deprecated CLI syntax, missing framework references all fixed                        |

### Added

- **`aiwg use media-curator`** — deploy Media Curator framework (6 agents, 9 commands, 9 skills) to any provider
- **`aiwg use research`** — deploy Research Complete framework (8 agents, 10 commands) to any provider
- Deployment blocks added to all 8 provider modules (claude, codex, copilot, cursor, factory, opencode, warp, windsurf)
- Workspace initialization for media-curator and research-complete in `base.mjs`
- Both frameworks included in `aiwg use all`

### Changed

- **Help text** updated with complete provider list — all 8 providers now shown (previously only 4)
- **`VALID_FRAMEWORKS`** expanded: `sdlc, marketing, media-curator, research, writing, general, all`
- **`help-generator.ts`** synced with `help.ts` for consistent provider display
- Updated `deploy-agents.mjs` mode documentation with new framework entries

### Fixed

- **Documentation audit** — updated README, CLAUDE.md, USAGE_GUIDE, sdlc-complete/README, development guide, and extensions overview:
  - Agent counts corrected from "50+" to "70+"
  - Deprecated `aiwg -deploy-agents` syntax replaced with `aiwg use` commands
  - Added media-curator and research-complete to framework tables and references
  - Platform count updated from 4 to 8
- **CalVer filename** — renamed `v2026.01.3-announcement.md` to `v2026.1.3-announcement.md` (no leading zeros)
- **Characterization test** — updated to match new provider format in help output

---

## [2026.2.7] - 2026-02-14 – "Media Curator" Release

| What changed                    | Why you care                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **New media-curator framework** | Complete framework for AI-powered media archive management — 31 files across agents, commands, and skills         |
| **6 specialized agents**        | Discography analysis, source discovery, acquisition, quality assessment, metadata curation, completeness tracking |
| **9 commands + 9 skills**       | Full pipeline from artist analysis through multi-platform export                                                  |
| **Field-tested patterns**       | GAP-NOTE.md, opustags preference, production-context classification — proven on 94GB prototype                    |

### Added

**Media Curator Framework** (`agentic/code/frameworks/media-curator/`) — complete framework for intelligent media archive management:

- **6 agents**: discography-analyst, source-discoverer, acquisition-manager, quality-assessor, metadata-curator, completeness-tracker
- **9 commands**: analyze-artist, find-sources, acquire, tag-collection, check-completeness, assemble, curate, export, verify-archive
- **9 skills**: youtube-acquisition, archive-acquisition, audio-extraction, quality-filtering, metadata-tagging, cover-art-embedding, gap-documentation, integrity-verification, provenance-tracking
- **Config**: `defaults.yaml` with quality thresholds, acquisition settings, and 5 export profiles (Plex, Jellyfin, MPD, mobile, archival)
- **Docs**: overview, standards reference, user guide

Key capabilities:

- Multi-source acquisition (YouTube, Internet Archive, Bandcamp)
- Quality filtering with configurable accept/reject criteria
- MusicBrainz/Discogs metadata integration with opustags
- GAP-NOTE.md pattern for documenting and tracking missing content
- W3C PROV/PREMIS-compliant archive integrity verification
- Completeness scoring with gap analysis
- Multi-platform export for Plex, Jellyfin, MPD, mobile, and archival

Field-tested on Twenty One Pilots discography (1,109 files, 94GB).

Closes #75, #76, #77, #78, #79, #80, #81, #82, #83, #253

---

## [2026.2.6] - 2026-02-14

### Fixed

- Stabilize deployment-registration idempotency test on Node 18 — assertion now checks for no duplicate IDs rather than exact scan order equality

---

## [2026.2.5] - 2026-02-14 – "Lean Rules" Release

| What changed                      | Why you care                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| **Consolidated rules deployment** | Single `RULES-INDEX.md` replaces 31 individual rule files — ~95% context reduction |
| **Automatic cleanup**             | Old individually-deployed rule files removed on redeploy                           |
| **All 8 providers**               | Claude, Codex, Factory, Copilot, Cursor, OpenCode, Warp, Windsurf all updated      |

### Changed

**Consolidated Rules Deployment** (#334, #335-#341):

- Rules now deploy as a single `RULES-INDEX.md` file instead of 31 individual rule files
- ~95% context reduction: ~200-line index replaces ~9,321 lines of bulk content
- Index contains 2-3 sentence summaries per rule with @-links to full rule files
- Rules organized by tier (core/sdlc/research) and enforcement level (critical/high/medium)
- Quick Reference table maps 11 task types to relevant rules
- Old individually-deployed rule files are automatically cleaned up on redeploy
- All 8 providers updated: Claude, Codex, Factory, Copilot, Cursor, OpenCode, Warp, Windsurf
- Rules manifest bumped to v2.0.0 with consolidation metadata
- Fallback: if RULES-INDEX.md is missing, providers fall back to individual file deployment

### Added

- `RULES-INDEX.md` — consolidated rules index with summaries and @-links for all 31 rules
- 6 new functions in `base.mjs`: `loadRulesManifest`, `groupRulesByTier`, `groupByEnforcement`, `getRulesIndexPath`, `generateConsolidatedRulesContent`, `cleanupOldRuleFiles`
- 31 unit tests for consolidated rules functions
- 7 integration tests for consolidated rules deployment and cleanup

**Migration**: Run `aiwg use sdlc` (or your framework) to redeploy. Old individual rule files in target directories are automatically replaced.

---

## [2026.2.4] - 2026-02-09 – "Issue Thread" Release

| What changed                         | Why you care                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **`/address-issues` command**        | Issue-thread-driven agent loops with 2-way human-AI collaboration via issue comments     |
| **Context window budget**            | Configure `AIWG_CONTEXT_WINDOW` to control parallel subagent limits on local/GPU systems |
| **`--interactive` and `--guidance`** | Standard AIWG parameters for discovery prompts and upfront direction                     |

### Added

**Issue-Driven Agent Loop** (#333):

- New `/address-issues` command for systematically working through open issues using issue threads as the collaboration surface
- 3-step cycle protocol per issue: work → post structured status comment → scan thread for human feedback
- Thread scanning classifies human comments (feedback, question, approval, correction) and responds substantively
- Multi-issue strategies: sequential (default), batched (related issues), parallel (independent)
- `--interactive` mode: discovery questions before starting, pause between issues for go/no-go
- `--guidance` mode: upfront text direction to tailor prioritization without interactive prompts
- `--branch-per-issue`, `--max-cycles`, `--filter`, `--all-open`, `--provider` parameters
- Issue tracker support: Gitea (MCP tools) and GitHub (`gh` CLI)
- New skill at `agentic/code/frameworks/sdlc-complete/skills/issue-driven-ralph/SKILL.md`
- New command at `agentic/code/frameworks/sdlc-complete/commands/address-issues.md`
- Natural language triggers: "address the open issues", "tackle issue 17", "work on the bug backlog", etc.
- 12 NL phrase mappings added to `docs/simple-language-translations.md`
- Design document at `.aiwg/planning/issue-driven-ralph-loop-design.md`

**Context Window Budget Configuration**:

- New `context-budget.md` rule in `agentic/code/addons/aiwg-utils/rules/` (deploys to all 8 platforms)
- Users set `AIWG_CONTEXT_WINDOW: <tokens>` in CLAUDE.md team directives to declare context budget
- Parallel subagent limits auto-scale: `max_parallel = max(1, floor(context_window / 50000))` capped at 20
- Lookup table: ≤64k→1-2 agents, 65-128k→2-4, 129-256k→4-8, 257-512k→8-12, >512k→12-20
- Compaction guidance: tighter budgets prefer sequential batches, smaller subagent tasks
- Updated `subagent-scoping.md` Rule 7 to reference context budget instead of hardcoded values
- Commented-out `AIWG_CONTEXT_WINDOW` directive added to CLAUDE.md team directives section

---

## [2026.2.3] - 2026-02-09 – "Deep Context" Release

| What changed              | Why you care                                                    |
| ------------------------- | --------------------------------------------------------------- |
| **RLM addon**             | Process 10M+ tokens through recursive sub-agent decomposition   |
| **Daemon mode**           | Background file watching, cron scheduling, IPC, tmux management |
| **Messaging subsystem**   | Bidirectional Slack, Discord, and Telegram bot integration      |
| **CLI addon support**     | `aiwg use rlm` — addons are now first-class CLI targets         |
| **Copilot RLM artifacts** | RLM agents, skills, and rules deploy to GitHub Copilot          |

### Added

**RLM Addon — Recursive Language Model Processing** (#321, #322-#329, #331):

- New addon at `agentic/code/addons/rlm/` implementing recursive context decomposition based on REF-089 (Zhang et al., 2026)
- 4 RLM agents: `rlm-orchestrator`, `rlm-chunk-processor`, `rlm-aggregator`, `rlm-quality-validator`
- 3 RLM commands: `/rlm-query`, `/rlm-batch`, `/rlm-status`
- 1 RLM skill: `rlm-mode` — detects large-scale operations and routes to RLM processing
- 2 RLM rules: `rlm-context-management`, `rlm-subagent-scoping`
- 5 RLM schemas: `rlm-config.yaml`, `rlm-chunk.yaml`, `rlm-result.yaml`, `rlm-cost.yaml`, `rlm-manifest.yaml`
- 2 RLM docs: `README.md`, `rlm-patterns.md`
- Deploy via `aiwg use rlm` or included automatically with `aiwg use sdlc` bundled addons
- GitHub Copilot deployment: `.github/agents/rlm-*.yaml`, `.github/skills/rlm-mode/`, `.github/copilot-rules/rlm-context-management.md`

**Daemon Mode** (#312):

- Background daemon with file watching and cron-based task scheduling
- IPC client/server for inter-process communication between daemon and CLI
- Agent supervisor for managing long-running agent processes
- Task store for persistent task queue management
- REPL chat for interactive daemon sessions
- Tmux manager for terminal multiplexing integration
- Automation engine for event-driven workflow triggers
- Full documentation at `docs/daemon-guide.md`

**Messaging Subsystem** (#313):

- Bidirectional chat handler supporting two-way conversations with AI agents
- Slack, Discord, and Telegram bot adapters with unified interface
- Base adapter improvements for consistent message handling across platforms
- Hub chat wiring for routing messages between adapters and agents
- Typed message system with structured message types
- Full documentation at `docs/messaging-guide.md`

**CLI Addon Support** (#328):

- `aiwg use rlm` — addons are now first-class targets alongside frameworks
- `VALID_ADDONS` and `ADDON_PATHS` constants in use handler for addon discovery
- Updated CLI help text, command definitions, and extension metadata
- Updated characterization tests for addon-aware error messages

### Fixed

- **Characterization test assertions** — Updated CLI router tests to match addon-aware error messages ("Framework or addon name required", "Unknown target")

---

## [2026.2.2] - 2026-02-08

### Fixed

- **glob dependency** - Updated from 11.x to 13.x to resolve deprecation warning and security vulnerabilities
- **Automated npm publishing** - CI now publishes to both Gitea and public npmjs.org on tag push using separate `NPMJS_TOKEN` secret (granular access token bypasses 2FA)

---

## [2026.2.0] - 2026-02-08 – "Universal Deploy" Release

| What changed                    | Why you care                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| **Universal deployment**        | All 8 providers now receive all 4 artifact types (agents, commands, skills, rules) |
| **External agent loop**         | Crash-resilient iterative task execution across sessions (6-8 hours)               |
| **Research framework**          | 8 specialized research agents, 10 commands, 8 templates                            |
| **Rules as artifact type**      | Deployable enforcement rules propagate to all platforms                            |
| **Agent persistence**           | Anti-laziness detection, HITL gates, cross-loop learning                           |
| **Regression testing**          | Automated regression detection integrated across SDLC                              |
| **Unified extension system**    | Complete Phase 4 with hooks, dynamic discovery, registry                           |
| **GitHub Copilot full support** | Rules and skills deploy alongside agents and commands                              |
| **Test consolidation**          | 31.7% test reduction (3,837 → 2,619) with zero coverage loss                       |
| **Research-first rules**        | Agents must research before decisions, parse instructions before acting            |

### Added

**Universal Deployment Architecture**:

- All 8 providers (Claude, Codex, Copilot, Cursor, Factory, OpenCode, Warp, Windsurf) now receive all 4 artifact types
- 32 provider × artifact combinations supported with per-provider support levels (`native`, `conventional`, `aggregated`)
- Provider implementations refactored for consistent deploy paths across `tools/agents/providers/*.mjs`
- ADR documented at `.aiwg/architecture/adr-universal-provider-deployment.md`

**Rules as Deployable Artifact Type**:

- Rules are now a first-class deployable artifact alongside agents, commands, and skills
- Core enforcement rules (no-attribution, token-security, versioning, citation-policy, anti-laziness, executable-feedback, failure-mitigation) deploy to all providers
- Content-injection platforms (Copilot, Windsurf) receive rules injected into their context files
- Discrete-file platforms (Claude, Codex, Cursor, Factory, OpenCode, Warp) receive individual rule files

**Zero AI Attribution Enforcement**:

- New `no-attribution.md` rule enforced across all 8 platforms
- No `Co-Authored-By`, `Generated with`, or tool branding in any output
- `aiwg use` and `aiwg regenerate` include no-attribution conventions for every platform

**GitHub Copilot Full Integration**:

- Rules deployed to `.github/copilot-rules/` directory
- Skills deployed to `.github/skills/` directory
- Commands converted to YAML agent format in `.github/agents/`
- Complete parity with other providers

**Research-First and Instruction-Following Rules**:

- `research-before-decision.md` - HIGH enforcement rule requiring research before technical decisions
- `instruction-comprehension.md` - HIGH enforcement rule requiring instruction parsing before acting
- 7th thought type added to thought protocol: Research 🔬
- NL router updated with research, planning, and clarification routing patterns
- Simple language translations document at `docs/simple-language-translations.md`

**External Agent Loop - Crash-Resilient Task Execution**:

- **`/ralph-external` command** - External supervisor for long-running sessions (6-8 hours)
  - Wraps Claude Code sessions with crash recovery and cross-session persistence
  - Pre/post session snapshots capture git status, .aiwg state, file hashes
  - Periodic checkpoints during session (configurable interval, default 30 min)
  - Two-phase state assessment: Orient → Generate continuation prompts
  - Comprehensive output capture: stdout, stderr, session transcript, parsed events
- **`/ralph-external-status`** and **`/ralph-external-abort`** commands
- **4-layer intelligent control system** (Epic #26):
  - Layer 1: Loop Lifecycle (initialization, iteration, termination)
  - Layer 2: Intelligent Control (memory, analytics, early stopping, best output)
  - Layer 3: Cross-Task Learning (similar task detection, strategy transfer)
  - Layer 4: Multi-Loop Management (concurrent loops, dashboard, monitoring)
- **Multi-provider support** with `--provider` flag (claude, codex)
  - Provider adapter pattern with capability-based degradation
  - Model mapping: opus→gpt-5.3-codex, sonnet→codex-mini-latest, haiku→gpt-5-codex-mini
- **Research-backed options** (REF-015, REF-021):
  - `--memory <n|preset>` - Memory capacity with presets: simple(1), moderate(3), complex(5), maximum(10)
  - `--cross-task` / `--no-cross-task` - Cross-task learning from past loops
  - `--no-analytics`, `--no-best-output`, `--no-early-stopping`
- **Multi-loop state management** with monitoring dashboard
- **Security and safety guide** at `docs/ralph-external/security-safety.md`
- State directory: `.aiwg/ralph-external/` with full iteration history

**Research Framework**:

- 8 specialized research agents (Quality Assessor, Citation Verifier, Writing Validator, Prompt Optimizer, Content Diversifier, etc.)
- 10 research commands (`/verify-citations`, `/grade-report`, `/citation-check`, `/corpus-health`, etc.)
- 8 research templates (frontmatter, quality assessment, evidence review)
- GRADE evidence quality assessment workflow
- W3C PROV-compliant provenance tracking with `prov-record.yaml` schema
- Citation verification workflow ensuring no fabricated references
- Research corpus with papers, findings, and topic syntheses

**Agent Persistence and Anti-Laziness**:

- HITL gate integration with comprehensive test suite
- Cross-loop learning between Ralph iterations
- Laziness Detection agent analyzing actions for test deletion, skip patterns, feature removal
- Recovery Orchestrator coordinating PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE protocol
- Progress Tracker monitoring iterative task progress with regression detection
- Prompt Reinforcement Agent injecting anti-laziness directives at strategic points
- Avoidance pattern catalog at `agentic/code/addons/persistence/patterns/avoidance-catalog.yaml`

**Regression Testing Capability**:

- Regression Analyst agent for detecting behavioral changes between versions
- Advanced regression detection skills
- Integration across SDLC commands for continuous regression monitoring
- Automation and cross-task learning for regression patterns

**Unified Extension System (Phase 4)**:

- Complete implementation of unified extension registry (`src/extensions/registry.ts`)
- All 10 extension types: agent, command, skill, hook, tool, mcp-server, framework, addon, template, prompt
- Dynamic discovery and capability-based semantic search
- Hooks as first-class extension type with lifecycle event handling
- 40 CLI commands with full TypeScript type definitions
- Legacy router removed in favor of unified command dispatch

**Thought Protocols and Agent Enhancements**:

- 7 thought types standardized: Goal 🎯, Research 🔬, Progress 📊, Extraction 🔍, Reasoning 💭, Exception ⚠️, Synthesis ✅
- Few-shot examples required for all agent definitions (2-3 per agent)
- New specialized agents: Regression Analyst, Laziness Detector, Recovery Orchestrator, Progress Tracker, Prompt Reinforcement Agent
- Memory frontmatter for Claude Code feature adoption
- Agent persistence integration with reflection memory

**Schema and Framework Wiring**:

- 67 schemas moved from `.aiwg/` to `agentic/code/` (framework source, not project output)
- 43/43 schema coverage achieved across all SDLC components
- Cost and reproducibility schemas wired to CLI commands
- Reflexion episodic memory wired into Ralph addon
- Tree-of-Thought architecture pattern implementation
- Executable feedback loop pattern implementation

**Documentation**:

- AIWG Development Guide at `docs/development/aiwg-development-guide.md`
- Claude Code features analysis and reference documentation
- Hook patterns, disk output conventions, and skills unification docs
- Comprehensive Epic #26 Ralph documentation
- Integration guides updated for all 8 providers
- Simple language translations for natural language routing

### Changed

- **Model configurations** updated to latest versions across all providers
- **Framework registry tracking** - `.aiwg/frameworks/` now tracked for installation state
- **AIWG framework context** - Added dogfooding explanation to CLAUDE.md
- **Ralph addon** reorganized: Ralph-specific components moved from `sdlc-complete` to dedicated `ralph` addon
- **NL router** expanded with research, planning, and clarification routing patterns
- **Thought protocol** expanded from 6 to 7 thought types (added Research 🔬)
- **Rules manifest** expanded with 2 new core-tier HIGH-enforcement rules

### Fixed

- **Ralph-external race condition** - Async provider registration now properly awaited before `createProvider()` calls
- **TypeScript compilation errors** - All Platform record types updated with `opencode` and `warp` entries
- **Docker CI compatibility** - Skip tsx-dependent integration tests in Docker environment
- **CLI flag parsing** - Resolved test failures for command-line argument handling
- **Flaky timing tests** - Relaxed duration assertions in workspace-migrator and security-validator tests
- **Agent deduplication** - Check agent IDs instead of registry size for proper dedup detection
- **REF number collisions** - Fixed duplicate research reference numbering
- **`.aiwg/` boundary documentation** - Clarified framework source vs project output distinction

### Removed

- **Markdown lint CI job** - Removed from Gitea CI pipeline (was non-blocking, framework content never conforms to strict lint rules)
- **Legacy CLI router** - Replaced by unified extension system
- **Priority command filtering** - All commands from core addons deploy without filtering

### Refactored

- **Test suite consolidation** - Reduced from ~3,837 to ~2,619 tests (31.7% reduction) with zero coverage loss using `for`/`forEach` inside single `it()` blocks instead of `test.each`/`it.each`
- **158 research issues filed** and classified for tracking implementation work
- **Schema organization** - All schemas now live in framework source (`agentic/code/`) not project output (`.aiwg/`)

---

## [2026.1.7] - 2026-01-14 – "Deploy All Commands" Release

| What changed                   | Why you care                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------- |
| **Removed priority filtering** | ALL commands now deploy (not just a curated subset)                             |
| **aiwg-utils commands work**   | `aiwg-regenerate*`, `devkit-*`, `mention-*` commands now deploy to Codex/Cursor |

### Fixed

**Command Deployment**:

- Removed `PRIORITY_COMMANDS` filtering from `deploy-prompts-codex.mjs`
- Removed `PRIORITY_COMMANDS` filtering from `deploy-rules-cursor.mjs`
- Core addons (with `core: true` or `autoInstall: true`) now deploy ALL commands
- The `aiwg-utils` addon now deploys all 30 commands including:
  - `aiwg-regenerate*` (context regeneration)
  - `devkit-*` (scaffolding)
  - `mention-*` (traceability)
  - `workspace-*` (maintenance)

---

## [2026.1.6] - 2026-01-14 – "Complete Addon Discovery" Release

| What changed                 | Why you care                                                  |
| ---------------------------- | ------------------------------------------------------------- |
| **Complete addon discovery** | ALL deployment scripts now discover addons dynamically        |
| **Codex commands fixed**     | `~/.codex/prompts/` now includes Ralph and all addon commands |
| **Cursor rules fixed**       | `.cursor/rules/` now includes addon commands                  |
| **Warp/Windsurf fixed**      | WARP.md and standalone scripts include all addons             |
| **Versioning docs**          | Clear CalVer documentation prevents npm update failures       |

### Fixed

**Complete Addon Discovery Across All Tools**:

- `tools/commands/deploy-prompts-codex.mjs` - Codex prompts now discover addon commands
- `tools/rules/deploy-rules-cursor.mjs` - Cursor rules now discover addon commands
- `tools/warp/setup-warp.mjs` - Warp WARP.md now includes addon agents/commands
- `tools/agents/deploy-windsurf.mjs` - Standalone Windsurf script now discovers addons

### Added

**Versioning Documentation**:

- `docs/contributing/versioning.md` - Comprehensive CalVer guide
- `.claude/rules/versioning.md` - AI agent enforcement rules
- Updated CLAUDE.md with correct version format examples

**CalVer Format**: `YYYY.M.PATCH` (no leading zeros!)

- Correct: `2026.1.6`, `2026.12.0`
- Wrong: `2026.01.6` (npm rejects leading zeros)

---

## [2026.1.5] - 2026-01-14 – "Dynamic Addon Discovery" Release

| What changed                | Why you care                                                  |
| --------------------------- | ------------------------------------------------------------- |
| **Dynamic addon discovery** | All providers now automatically pick up new addons like Ralph |
| **No more hardcoded paths** | New addons work across all 8 providers without code changes   |
| **Ralph addon support**     | Agent loop agents, commands, and skills now deploy everywhere |

### Fixed

**Addon Discovery for All Providers** (Issue #22):

- **Dynamic Addon Discovery** - All providers now automatically discover and deploy all addons
  - Previously, providers hardcoded specific addons (writing-quality, aiwg-utils)
  - New addons like Ralph were not deployed because they weren't in the hardcoded list
  - Now uses `getAddonAgentFiles()`, `getAddonCommandFiles()`, `getAddonSkillDirs()` from base.mjs

- **Updated Providers**:
  - `claude.mjs` - Now discovers all addons dynamically
  - `codex.mjs` - Now discovers all addons dynamically
  - `copilot.mjs` - Now discovers all addons dynamically
  - `opencode.mjs` - Now discovers all addons dynamically
  - `factory.mjs` - Now discovers all addons dynamically
  - `windsurf.mjs` - Now discovers all addons dynamically

### Added

**Addon Discovery Functions in base.mjs**:

- `discoverAddons(srcRoot)` - Discovers all addons from `agentic/code/addons/` with manifests
- `getAddonAgentFiles(srcRoot, excludeAddons)` - Gets all agent files from all addons
- `getAddonCommandFiles(srcRoot, excludeAddons)` - Gets all command files from all addons
- `getAddonSkillDirs(srcRoot, excludeAddons)` - Gets all skill directories from all addons
- `getAddonFiles(srcRoot, options)` - Combined function for all addon files

### Addons Now Auto-Discovered

All addons in `agentic/code/addons/` are now automatically deployed:

- aiwg-evals, aiwg-hooks, aiwg-utils
- context-curator, testing-quality, voice-framework, writing-quality
- guided-implementation, ralph, droid-bridge, star-prompt

---

## [2026.01.4] - 2026-01-14 – "Provider File Locations Fix" Release

| What changed                        | Why you care                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| **Provider deployment fixes**       | `aiwg use --provider X` now correctly places files in provider-specific directories |
| **Codex home directory paths**      | Codex prompts/skills deploy to `~/.codex/` (home) not project directory             |
| **Cursor rules location**           | Cursor rules now deploy to `.cursor/rules/` not project root                        |
| **CLI addon provider pass-through** | `--provider` flag now correctly propagates to addon deployments                     |
| **Dead code removal**               | Removed 115 lines of unreachable Windsurf code from deploy-agents.mjs               |
| **Comprehensive test suite**        | New `provider-file-locations.test.ts` validates all 8 providers                     |

### Fixed

**Provider File Location Issues** (Issue #21):

- **CLI `handleUse()`** - Now passes `--provider` to addon deployments (aiwg-utils, ralph)
  - Previously, addons always deployed to Claude Code format regardless of `--provider`
  - Now correctly creates provider-specific directories (`.codex/`, `.factory/`, etc.)

- **Codex Provider** - Fixed command/skill deployment paths
  - Prompts now deploy to `~/.codex/prompts/` (home directory)
  - Skills now deploy to `~/.codex/skills/` (home directory)
  - Previously incorrectly deployed to project directory

- **Cursor Provider** - Fixed rules deployment path
  - Rules now deploy to `<project>/.cursor/rules/`
  - Previously deployed `.mdc` files directly to project root
  - Script now treats `--target` as project root and appends `.cursor/rules/`

- **Dead Code Removal** - Removed unreachable Windsurf code from `deploy-agents.mjs`
  - 115 lines of code that checked `if (provider === 'windsurf')` never executed
  - Provider was an object, not a string, so condition was always false

### Added

**Provider Deployment Test Suite**:

- New `test/integration/provider-file-locations.test.ts`
  - Tests all 8 providers: claude, codex, factory, copilot, cursor, opencode, warp, windsurf
  - Validates correct directory creation for each provider
  - Validates no forbidden paths (e.g., no `.claude/` when using codex)
  - Validates correct file extensions per provider
  - Tests `aiwg use --provider` CLI integration

### Provider File Locations Reference

| Provider | Project Directories                                       | Home Directories                        | Root Files                    |
| -------- | --------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| Claude   | `.claude/agents/`, `.claude/commands/`, `.claude/skills/` | -                                       | -                             |
| Codex    | `.codex/agents/`                                          | `~/.codex/prompts/`, `~/.codex/skills/` | -                             |
| Factory  | `.factory/droids/`, `.factory/commands/`                  | -                                       | -                             |
| Copilot  | `.github/agents/`                                         | -                                       | -                             |
| Cursor   | `.cursor/rules/`                                          | -                                       | -                             |
| OpenCode | `.opencode/agent/`, `.opencode/command/`                  | -                                       | -                             |
| Warp     | -                                                         | -                                       | `WARP.md`                     |
| Windsurf | `.windsurf/workflows/`                                    | -                                       | `AGENTS.md`, `.windsurfrules` |

---

## [2026.01.3] - 2026-01-13 – "Agent Loop & Issue Management" Release

| What changed                   | Why you care                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------- |
| **Agent Loop**                 | Iterative AI task execution - "iteration beats perfection" methodology           |
| **--interactive & --guidance** | All commands now support interactive mode and custom guidance                    |
| Unified issue management       | Create, update, list, sync issues across Gitea/GitHub/Jira/Linear or local files |
| Issue auto-sync                | Commits with "Fixes #X" automatically update and close issues                    |
| Token security patterns        | Secure token loading via env vars and files, never direct access                 |
| Vendor-specific regenerate     | 30-40% smaller context files, only loads relevant platform commands              |
| Man page support               | `man aiwg` works after npm global install                                        |

### Added

**Agent Loop - Iterative AI Task Execution**:

- **`/ralph` command** - Execute tasks iteratively until completion criteria met
  - Parse task definition and verification criteria
  - Execute → Verify → Learn → Iterate cycle
  - Errors become learning data, not session-ending failures
  - Configurable max iterations and timeout
- **`/ralph-status`** - Check status of current or previous agent loop
- **`/ralph-resume`** - Resume interrupted loop from last checkpoint
- **`/ralph-abort`** - Abort running loop and optionally revert changes
- **Ralph addon** (`agentic/code/addons/ralph/`):
  - Complete methodology documentation
  - Loop state persistence in `.aiwg/ralph/`
  - Completion reports with iteration history
- **Natural language triggers**: "ralph this", "loop until", "keep trying until"
- Philosophy: "Iteration beats perfection" - inspired by iterative agent loop methodology

**Command Enhancements**:

- **`--interactive` flag** - All commands now support interactive mode
  - Asks clarifying questions before execution
  - Validates assumptions with user
  - Gathers preferences for ambiguous choices
- **`--guidance <text>` flag** - Provide custom guidance to tailor command behavior
  - Pass project-specific context
  - Override default behaviors
  - Focus on specific aspects of the task
- **Man page** - `man aiwg` now works after `npm install -g aiwg`

**Gap Analysis & Guided Implementation**:

- **`/gap-analysis` command** - Unified gap analysis with natural language routing
- **Guided implementation addon** (`agentic/code/addons/guided-implementation/`):
  - Iteration control for complex implementations
  - Step-by-step guidance with checkpoints
  - REF-004 MAGIS reference integration

**Droid Bridge MCP Integration**:

- **`droid-bridge` addon** - MCP integration for Claude Desktop and other MCP clients
- Bridge between agentic framework and MCP protocol
- Enables AIWG agents in MCP-compatible environments

**Issue Management System** (Issues #16, #17):

- **`/issue-create`** - Create issues with multi-provider support:
  - Gitea (MCP tools), GitHub (gh CLI), Jira (REST API), Linear (GraphQL)
  - Local fallback to `.aiwg/issues/` when no provider configured
  - Config via `.aiwg/config.yaml` or CLAUDE.md
- **`/issue-update`** - Update issue status, assignee, labels, add comments
- **`/issue-list`** - List and filter issues by status, label, assignee
- **`/issue-sync`** - Detect issue refs in commits ("Fixes #X", "Closes #X")
- **`/issue-close`** - Close issues with completion summary
- **`/issue-comment`** - Add structured comments using templates
- **Issue comment templates**:
  - `task-completed.md` - Completion summary with deliverables
  - `feedback-needed.md` - Request review with specific questions
  - `blocker-found.md` - Blocker notification with impact assessment
  - `progress-update.md` - Status update with metrics
- **`issue-auto-sync` skill** - Post-commit automation for issue updates

**Token Security** (Issue #18):

- **Security addon** (`agentic/code/addons/security/`):
  - `secure-token-load.md` - Patterns for secure token loading
  - Single-line, heredoc, and environment variable patterns
- **Token loading priority**: Environment variables → Secure files → Vault
- **Token security rules** (`.claude/rules/token-security.md`):
  - Never hard-code tokens
  - Never pass tokens as command arguments
  - Use heredoc for multi-line operations
  - Enforce file permissions (mode 600)
- Updated DevOps Engineer and Security Auditor agents with security guidance
- Comprehensive documentation at `docs/token-security.md`

**Vendor-Specific Regenerate** (Issue #19):

- **Vendor detection** (`docs/vendor-detection.md`):
  - Claude Code: CLAUDE.md, .claude/ directory
  - GitHub Copilot: copilot-instructions.md, .github/agents/
  - Cursor: .cursor/ directory
  - Windsurf: WARP.md
- **Regenerate base template** (`templates/regenerate-base.md`):
  - Common structure for all regenerate commands
  - Vendor-specific section placeholders
- **Context reduction**: 30-40% smaller files by platform filtering
- Only inline ~15-20 most-used commands/agents per vendor
- Full catalogs linked instead of inlined

**Star Prompt Addon** (Issue #14):

- **`star-prompt` addon** (`agentic/code/addons/star-prompt/`):
  - Tasteful "Yes, star the repo" / "No thanks" prompt
  - Auto-star via `gh api -X PUT /user/starred/jmagly/ai-writing-guide`
  - Fallback to manual link if gh CLI unavailable
- Integrated into all intake and regenerate commands
- Non-intrusive, shown only once per command

### Changed

- Consolidated `/ticket-*` commands to `/issue-*` for git ecosystem consistency
- Renamed `ticketing-config.md` to `issue-tracking-config.md`
- Changed `.aiwg/tickets/` to `.aiwg/issues/` for local tracking
- Updated command manifests with new issue commands

### Fixed

- Standardized terminology across SDLC framework (issue vs ticket)

---

## [2026.01.0] - 2026-01-07 – "CalVer Migration" Release

| What changed        | Why you care                                              |
| ------------------- | --------------------------------------------------------- |
| CalVer versioning   | Version now reflects release date (YYYY.M.PATCH)          |
| Addon directory fix | Claude provider correctly handles addon-style directories |

### Changed

- **CalVer versioning**: Migrated from SemVer (0.x.x, 2024.12.x) to pure CalVer (2026.01.x)
- Version format: `YYYY.M.PATCH` where PATCH resets each month (no leading zeros)

### Fixed

- **Addon directory deployment**: Claude provider now supports addon-style directory structures during deployment

---

## [2024.12.5] - 2025-12-13 – "Flexible Models & Terminal Docs" Release

| What changed             | Why you care                                                 |
| ------------------------ | ------------------------------------------------------------ |
| Terminal docs site       | CLI-style documentation with full-text search and themes     |
| Smithing Framework       | Create agents, skills, commands, and MCP servers dynamically |
| Windsurf provider        | Deploy to Windsurf IDE                                       |
| Flexible model selection | Override models per tier when deploying agents               |
| Filter-based deployment  | Deploy only specific agents by pattern or role               |
| Persistent model config  | Save model preferences for future deployments                |

### Added

**Terminal Documentation Site**:

- **CLI-style console** - Search and navigate via command input
- **Full-text search** - Search all documentation content with highlighting via dbbuilder integration
- **Log entry format** - Content displayed as categorized terminal log entries
- **Three themes** - Dark, Light (OS/2 Warp inspired cream palette), and Matrix
- **Clickable search results** - All results displayed as navigable links
- **Keyboard shortcuts** - `?` help, `/` search, `t` theme, `gg` top, `G` bottom
- Console commands: `help`, `search <query>`, `theme`, `clear`, `home`

**Smithing Framework** (Preview):

- **ToolSmith** - Create MCP tools from specifications
- **MCPSmith** - Build complete MCP servers with Docker support
- **AgentSmith** - Generate specialized agents from descriptions
- **SkillSmith** - Create Claude Code skills
- **CommandSmith** - Build slash commands
- Located in `agentic/code/frameworks/sdlc-complete/agents/smiths/`

**Windsurf Provider**:

- New experimental provider for Windsurf IDE
- `aiwg use sdlc --provider windsurf`
- Provider modularization refactor for cleaner multi-provider architecture

**Flexible Model Selection** (PR #73):

- **`--reasoning-model <name>`** - Override model for opus-tier agents (architecture, analysis)
- **`--coding-model <name>`** - Override model for sonnet-tier agents (implementation, review)
- **`--efficiency-model <name>`** - Override model for haiku-tier agents (simple tasks)
- Works with `aiwg use` command for all providers

**Filter-Based Deployment**:

- **`--filter <pattern>`** - Deploy only agents matching glob pattern (e.g., `*architect*`)
- **`--filter-role <role>`** - Deploy only agents of specified role: `reasoning`, `coding`, `efficiency`
- Enables surgical updates to specific agent subsets

**Model Persistence**:

- **`--save`** - Save model configuration to project `models.json`
- **`--save-user`** - Save to user-level `~/.config/aiwg/models.json`
- Configurations apply to future deployments automatically

**Documentation Updates**:

- `docs/CLI_USAGE.md` - Full model selection, filter, and save flag documentation
- `docs/configuration/model-configuration.md` - Updated with filter and persistence examples
- `README.md` - Added collapsible model selection section

### Fixed

- **Dry-run flag in ensureDir** - Directory creation now respects `--dry-run` across all providers
- **Skill deployment test** - Fixed test to use Claude provider (Factory doesn't support skills)
- **Search auto-navigation** - Fixed search jumping to first result instead of showing clickable results list
- **Deep linking** - Fixed hash-based navigation requiring missing DOM element

### Changed

- Updated `/aiwg-refresh` command to support model selection and filter flags
- Command syntax standardized to use `aiwg use` instead of legacy `-deploy-agents`

---

## [2024.12.4] - 2025-12-12 – "Universal Providers" Release

| What changed              | Why you care                                                  |
| ------------------------- | ------------------------------------------------------------- |
| 5 new providers           | Deploy to Claude, Factory, OpenAI, Cursor, Copilot, OpenCode  |
| `/aiwg-refresh` command   | Update frameworks in-session without leaving Claude Code      |
| Testing-quality addon     | TDD enforcement, mutation testing, flaky detection (6 skills) |
| Live provider tests       | All providers validated with real CLI integration tests       |
| Testing requirements docs | Clear guidance on when full regression testing is required    |

### Added

**Multi-Provider Support** (PRs #62, #63, #64, #65):

- **OpenAI Codex CLI** - Full integration with `.codex/agents/` deployment
- **Cursor IDE** - Native `.cursor/rules/*.mdc` format with AGENTS.md
- **OpenCode** - `.opencode/agent/` structure with AGENTS.md
- **GitHub Copilot** - `.github/agents/*.yaml` with `copilot-instructions.md`
- All providers now deploy agents, commands, and skills consistently
- Platform documentation for each provider in `docs/integrations/`

**In-Session Update Command** (PR #69):

- **`/aiwg-refresh`** - Update AIWG CLI and redeploy frameworks without leaving session
  - `--update-cli` - Update the AIWG CLI itself
  - `--all` / `--sdlc` / `--marketing` / `--utils` - Redeploy specific frameworks
  - `--provider` - Target specific provider
  - `--dry-run` - Preview changes without applying

**Testing-Quality Addon** (PR #68):

- 6 new skills for test enforcement:
  - `tdd-enforce` - Pre-commit hooks + CI coverage gates
  - `mutation-test` - Validate tests beyond coverage (Stryker/PITest)
  - `flaky-detect` - Identify unreliable tests from CI history
  - `flaky-fix` - Pattern-based auto-repair
  - `generate-factory` - Auto-generate test data factories
  - `test-sync` - Detect orphaned tests, missing tests
- Research foundation: Kent Beck (TDD), Google Testing Blog, FlaKat, UTRefactor
- `/setup-tdd` command for project TDD configuration

**Testing Infrastructure** (PRs #66, #67):

- Live CLI integration tests for all providers (Claude, Factory, OpenAI, Cursor, Copilot)
- Factory AI deployment integration tests with real droid validation
- Provider validation matrix in CI

**Documentation**:

- `docs/contributing/testing-requirements.md` - When full regression testing is required
- `docs/development/file-placement-guide.md` - Where to put different file types
- External research references to testing framework
- GitHub Copilot quickstart guide

### Fixed

- **Factory agent mapping** - Correct agent names and tool assignments for Factory droids
- **Codex integration tests** - Resolved test failures in OpenAI provider

### Changed

- Removed `aiwg demo` command in favor of comprehensive documentation
- Testing now enforced as first-class requirement across SDLC framework

---

## [2024.12.3] - 2025-12-11 – "It Just Works" Release

| What changed                     | Why you care                               |
| -------------------------------- | ------------------------------------------ |
| `aiwg doctor` command            | Diagnose installation issues instantly     |
| npm discoverability + badges     | Actually shows up when you search npm      |
| MCP server works from any folder | No more ".aiwg not found" errors           |
| PATH warning on install          | Know immediately if setup needs fixing     |
| Windows + cross-platform fixes   | Works on Windows out of the box            |
| Team directives preserved        | No more lost custom rules on regenerate    |
| GitHub Pages docs                | Temporary landing page while aiwg.io loads |
| @-mention traceability wiring    | Agents navigate codebase via logical paths |
| Workspace cleanup commands       | Prune stale files, archive completed plans |

### Added

- **`aiwg doctor`** - Health check command that diagnoses installation issues and provides fix suggestions
- **Postinstall PATH check** - Friendly warning with shell-specific fix instructions if `aiwg` isn't in PATH
- **GitHub Pages** - Temporary documentation at https://jmagly.github.io/ai-writing-guide
- **@-mention traceability** - Wired cross-references in 14 key files (source→test→requirements→architecture)
- **`/workspace-prune-working`** - Clean up `.aiwg/working/` by promoting, archiving, or deleting stale files
- **`/workspace-realign`** - Sync documentation with codebase changes, archive completed plans

### Changed

- **npm keywords** - Added 14 discoverable keywords (aiwg, agentic-ai, mcp-server, claude-skills, etc.)
- **npm description** - Clear, searchable description
- **README hero section** - Install command front and center
- **MCP server** - Auto-finds project root from any subdirectory (walks up looking for `.aiwg/`)

### Fixed

- **Windows paths** - Replaced string concatenation with `path.join()` throughout
- **CI matrix** - Added Windows runner to GitHub Actions
- **Team directives** - `/aiwg-regenerate-claude` preserves content below `<!-- TEAM DIRECTIVES -->`

---

## [2024.12.2] - 2025-12-10

### Skill Seekers Integration & Usability Improvements

This release adds **Skill Seekers community integration** with two new addons, **workspace health guidance** for transition points, and **standardized command usability** across all flow commands.

#### Added

**Skill Seekers Integration** (PRs #206, #207, #208 to Skill Seekers repo):

- **doc-intelligence addon** (`agentic/code/addons/doc-intelligence/`):
  - Intelligent documentation analysis and generation
  - Cross-repository knowledge synthesis
  - Documentation gap detection and remediation
  - Integrates with Skill Seekers community marketplace
- **skill-factory addon** (`agentic/code/addons/skill-factory/`):
  - Automated skill generation from natural language descriptions
  - Skill template scaffolding and validation
  - Multi-platform skill deployment (Claude, Factory, OpenAI)
- **SDLC Extensions for Skill Seekers**:
  - `skill-seekers-integration` extension with 5 specialized agents
  - Community skill discovery and curation workflows
  - Attribution and licensing compliance automation
- Attribution added to README.md and addon.json files

**Workspace Health Skill** (`aiwg-utils/skills/workspace-health/`):

- Natural language triggers: "check workspace health", "workspace status", "is my workspace aligned"
- Assesses `.aiwg/working/` directory health (stale files, large artifacts)
- Validates documentation alignment with codebase
- Checks artifact freshness and completeness
- Provides actionable recommendations without auto-executing
- Designed for use at phase transitions and after intensive processes

**Post-Completion Guidance**:

- Added "Post-Completion" section to 9 major flow commands:
  - `flow-concept-to-inception`
  - `flow-inception-to-elaboration`
  - `flow-elaboration-to-construction`
  - `flow-construction-to-transition`
  - `flow-delivery-track`
  - `flow-iteration-dual-track`
  - `flow-gate-check`
  - `flow-deploy-to-production`
  - `flow-hypercare-monitoring`
- Recommends workspace health check after workflow completion
- Suggests follow-up actions based on workflow context
- Template: `templates/flow-patterns/post-completion-template.md`

#### Changed

**Command Usability Standardization**:

- Added `--interactive` and `--guidance` parameters to 28 commands:
  - All intake commands (intake-wizard, intake-start, intake-from-codebase, etc.)
  - All flow commands (phase transitions, reviews, deployments)
  - Marketing commands (campaign-kickoff, creative-brief, etc.)
  - Gate and validation commands
- Consistent parameter documentation in frontmatter `argument-hint`
- Added "Optional Parameters" section to command bodies

**Multi-Provider Skill Deployment**:

- Skills now deploy successfully to Factory AI (previously Claude-only)
- Updated smoke tests to verify Factory skill deployment
- `--deploy-skills` works with `--provider factory`

#### Fixed

**Test Suite**:

- Fixed `cli-install.test.ts` smoke test for multi-provider skill deployment
- Test now verifies successful Factory deployment instead of expecting warning

---

## [2024.12.1] - 2025-12-10

### Production-Grade Reliability & Extensibility Release

This is a major release introducing **production-grade reliability patterns** based on academic research, the **AIWG Development Kit** for framework extensibility, **MCP Server** for Model Context Protocol integration, and **CLAUDE.md modernization** with path-scoped rules. Context loading is reduced by 87% for base sessions.

#### Added

**Research Integration** (REF-001, REF-002, REF-003):

- **REF-001**: Bandara et al. (2025) "Production-Grade Agentic AI Workflows" - 9 best practices:
  - BP-1: Direct tool calls over MCP for determinism
  - BP-3: One agent, one responsibility principle
  - BP-4: Single-responsibility agents
  - BP-5: Externalized prompts in version control
  - BP-6: Multi-model consortium for high-stakes outputs
- **REF-002**: Roig (2025) "How Do LLMs Fail In Agentic Scenarios?" - 4 failure archetypes:
  - Archetype 1: Premature Action Without Grounding
  - Archetype 2: Over-Helpfulness Under Uncertainty
  - Archetype 3: Distractor-Induced Context Pollution
  - Archetype 4: Fragile Execution Under Load
  - Key finding: Recovery capability > model size for success
- **REF-003**: MCP 2025-11-25 specification research and integration patterns
- Research references in `docs/references/` for traceable guidance

**AIWG Development Kit** (PR #57, #58):

- Three-tier plugin taxonomy: Frameworks (50+ agents) → Extensions (5-20 agents) → Addons (1-10 agents)
- CLI scaffolding commands:
  - `aiwg scaffold-addon <name>` - Create new addon package
  - `aiwg scaffold-extension <name> --for <framework>` - Create framework extension
  - `aiwg scaffold-framework <name>` - Create complete framework
  - `aiwg add-agent|add-command|add-skill|add-template` - Add components to packages
  - `aiwg validate <path> [--fix]` - Validate package structure
- In-session commands with AI guidance:
  - `/devkit-create-addon`, `/devkit-create-extension`, `/devkit-create-framework`
  - `/devkit-create-agent`, `/devkit-create-command`, `/devkit-create-skill`
  - `/devkit-validate`, `/devkit-test`
- Agent templates: simple (sonnet), complex (sonnet+search), orchestrator (opus+Task)
- Command templates: utility, transformation, orchestration
- Comprehensive documentation: `docs/development/devkit-overview.md`

**Production-Grade Reliability Patterns**:

- **Reliability prompts** in `aiwg-utils/prompts/reliability/`:
  - `decomposition.md` - Task breakdown using 7±2 cognitive rule
  - `parallel-hints.md` - Concurrent execution patterns
  - `resilience.md` - PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE protocol
- **Core prompts** in `aiwg-utils/prompts/core/`:
  - `orchestrator.md` - Workflow orchestration guidance
  - `multi-agent-pattern.md` - Primary→Reviewers→Synthesizer pattern
  - `consortium-pattern.md` - Multi-model validation for uncertain outputs
- **New agents**:
  - `consortium-coordinator` - Coordinates multi-agent consensus decisions
  - `self-debug` - Diagnoses and recovers from agent failures
  - `aiwg-developer` - AIWG development assistance with taxonomy knowledge
  - `context-curator` - Pre-filters context, removes distractors (Archetype 3)

**New Addons**:

- **aiwg-hooks** - Claude Code hook templates for workflow tracing:
  - `aiwg-trace.js` - Captures SubagentStart/SubagentStop events
  - JSONL trace format for debugging, performance analysis, audit
  - `trace-viewer.mjs` - View traces as tree/timeline/JSON
- **aiwg-evals** - Automated agent quality assessment:
  - Archetype tests: grounding-test, substitution-test, distractor-test, recovery-test
  - Performance tests: parallel-test, latency-test, token-test
  - Quality tests: output-format, tool-usage, scope-adherence
  - CI integration workflow template
  - Quality reports with trend tracking
- **context-curator** - Distractor filtering for Archetype 3 prevention:
  - Context classification: RELEVANT/PERIPHERAL/DISTRACTOR
  - Scope enforcement rules
  - `.claude/rules/` deployment for runtime guidance

**@-Mention Conventions & Wiring**:

- 5 new commands for artifact traceability:
  - `/mention-wire` - Analyze codebase and inject @-mentions
  - `/mention-validate` - Validate all @-mentions resolve to existing files
  - `/mention-report` - Generate traceability report from @-mentions
  - `/mention-lint` - Lint @-mentions for style consistency
  - `/mention-conventions` - Display naming conventions and placement rules
- Standardized mention patterns in `registry.json`:
  - Requirements: `@.aiwg/requirements/UC-{NNN}-{slug}.md`
  - Architecture: `@.aiwg/architecture/adrs/ADR-{NNN}-{slug}.md`
  - Security: `@.aiwg/security/TM-{NNN}.md`
  - Testing: `@.aiwg/testing/test-cases/TC-{NNN}.md`
- Guidelines: `docs/guides/mention-conventions.md`

**Workspace Maintenance Commands** in aiwg-utils:

- `/workspace-realign` - Sync `.aiwg/` docs with code changes:
  - Analyzes git history since last alignment
  - Archives stale documents, flags missing docs
- `/workspace-prune-working` - Clean `.aiwg/working/` directory:
  - Promotes finalized docs to permanent locations
  - Archives useful historical content
  - Deletes truly temporary files
- `/workspace-reset` - Complete `.aiwg/` wipe with safety features:
  - Backup creation, selective preservation (intake, team)
  - Requires confirmation (`RESET`) or `--force`

**Framework-Scoped Workspace Structure** (PR #54):

- Multi-framework coexistence in same project:
  - Marketing can read SDLC artifacts (feature specs) for launch content
  - Each framework maintains isolated write scope
- Target structure:
  ```
  .aiwg/
  ├── frameworks/
  │   ├── sdlc-complete/     # SDLC artifacts
  │   └── media-marketing-kit/  # Marketing artifacts
  └── shared/                 # Cross-framework resources
  ```
- Rollback CLI improvements for finding backups
- Assessment reports and working artifacts

**Skills System Expansion**:

- 6 new skills in aiwg-utils:
  - `claims-validator` - Validates factual claims in content
  - `config-validator` - Validates AIWG configuration files
  - `nl-router` - Natural language command routing
  - `parallel-dispatch` - Parallel agent coordination
  - `project-awareness` - Project context detection
  - `template-engine` - Template rendering and variable substitution
  - `artifact-metadata` - Artifact metadata extraction

**npm Package Distribution** (PR #55):

- Published to npm as `aiwg` package
- Global installation: `npm install -g aiwg`
- Package includes: bin/, src/, tools/, agentic/, docs/, core/
- Semantic versioning: 2024.12.1
- Automated publish workflow via GitHub Actions

**MCP Server Implementation** (Phase 1):

- Complete MCP server following 2025-11-25 specification (`src/mcp/server.mjs`)
- 5 MCP tools:
  - `workflow-run` - Execute AIWG workflows with automatic prompt integration
  - `artifact-read` - Read artifacts from `.aiwg/` directory
  - `artifact-write` - Write artifacts to `.aiwg/` directory
  - `template-render` - Render AIWG templates with variable substitution
  - `agent-list` - List available AIWG agents by framework
- 3 MCP resources:
  - `aiwg://prompts/catalog` - Prompts catalog
  - `aiwg://templates/catalog` - Templates catalog
  - `aiwg://agents/catalog` - Agents catalog
  - Dynamic URI templates for specific items
- 3 MCP prompts (automatically integrated into workflow-run):
  - `decompose-task` - Break complex tasks into manageable subtasks
  - `parallel-execution` - Identify parallelizable work
  - `recovery-protocol` - PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE error handling
- Workflow metadata with complexity analysis and step descriptions
- MCP CLI commands: `aiwg mcp serve`, `aiwg mcp install`, `aiwg mcp info`
- Comprehensive test suite: 13 tests covering all MCP functionality
- Test fixture project (`test/fixtures/mcp-test-project/`) for validation

**CLAUDE.md Modernization**:

- New modular CLAUDE.md structure (134 lines vs 1,018 - **87% reduction**)
- Path-scoped rules in `.claude/rules/`:
  - `sdlc-orchestration.md` - Loaded when working in `.aiwg/**`
  - `voice-framework.md` - Loaded when working in `**/*.md`
  - `development.md` - Loaded when working in `src/**`, `test/**`
  - `agent-deployment.md` - Loaded when working in `.claude/agents/**`
- Reference documentation in `docs/reference/`:
  - `ORCHESTRATOR_GUIDE.md` - Full orchestration reference (on-demand via @-mentions)
- Context loading follows Anthropic best practices for token efficiency

**Centralized Registry**:

- `agentic/code/config/registry.json` - Single source of truth for:
  - AIWG path resolution (eliminates duplication across 20+ commands)
  - Natural language pattern mappings (70+ phrases → flow commands)
  - Artifact path definitions
  - Provider-specific configurations (Claude, Factory, OpenAI, Warp)
  - @-mention patterns for traceability

**MCP Research & Documentation**:

- `docs/references/REF-003-mcp-specification-2025.md` - MCP 2025-11-25 research
- Updated platform adapter specification with MCP-first architecture

#### Changed

**Agent Design Philosophy** (from research):

- Agents now follow "10 Golden Rules" from Agent Design Bible:
  - Rule 1: Ground before acting (Archetype 1 prevention)
  - Rule 2: Escalate uncertainty (Archetype 2 prevention)
  - Rule 3: Scope context (Archetype 3 prevention)
  - Rule 4: Decompose tasks (Archetype 4 prevention)
  - Rule 5-10: Single responsibility, external prompts, tool discipline, etc.
- Agent linter validates rules compliance

**Command Updates**:

- `/aiwg-regenerate-claude` now generates modular structure by default
  - `--legacy` flag available for old monolithic format
  - Reports context reduction metrics in output
  - Generates `.claude/rules/` files based on detected frameworks

**Context Loading Strategy**:

- Base context: 134 lines (always loaded)
- SDLC context: +180 lines (loaded only when working in `.aiwg/`)
- Voice context: +75 lines (loaded only when working in `**/*.md`)
- Dev context: +85 lines (loaded only when working in `src/`, `test/`)
- Detailed docs: On-demand via `@docs/reference/` mentions

**Addon Structure Migration** (PR #50):

- Writing Quality migrated to addon structure (`agentic/code/addons/writing-quality/`)
- Clear addon taxonomy established (Frameworks, Addons, Extensions)
- Plugin management CLI commands added

**Dependencies**:

- Added `@modelcontextprotocol/sdk` ^1.24.0 (MCP server)
- Added `zod` ^3.25.0 (schema validation)

#### Fixed

**MCP Server**:

- Prompt argsSchema type handling (MCP passes all args as strings)
- `mcp install --dry-run` flag parsing

**Documentation**:

- Updated CLAUDE.md to follow 100-200 line best practice
- Removed redundant orchestration guidance from multiple locations
- Consolidated natural language translations into registry
- Removed inflated metrics and unimplemented feature claims from README
- Removed internal project status and roadmap from public README

**CLI Tooling**:

- `aiwg -update` now refreshes shell aliases properly
- Rollback CLI finds backups in both workspace and project locations
- Fixed skills not deploying for voice-framework, SDLC, and MMK frameworks
- Fixed metadata-validation workflow to skip gitignored directories

**Tests**:

- Comprehensive test remediation for SDLC framework and writing modules
- TypeScript unused variable errors resolved across codebase
- Added CLI installation smoke tests

### Migration Guide

**For Existing Projects (CLAUDE.md Modernization):**

The new modular CLAUDE.md structure is opt-in. Existing monolithic CLAUDE.md files continue to work. To migrate:

1. Backup your current CLAUDE.md (preserved automatically by regenerate command)
2. Run `/aiwg-regenerate-claude` to generate modular structure
3. Review generated `.claude/rules/` files
4. Add team-specific content below `<!-- TEAM DIRECTIVES -->` marker

**For Production-Grade Patterns:**

1. Update AIWG installation:

   ```bash
   aiwg -update  # Or: aiwg -reinstall for clean install
   ```

2. Deploy new addons:

   ```bash
   aiwg use all  # Deploys all frameworks + new addons
   ```

3. Import reliability prompts in your CLAUDE.md:
   ```markdown
   See @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/reliability/resilience.md
   ```

**For Development Kit:**

Use scaffolding commands to create new packages:

```bash
aiwg scaffold-addon my-utils --description "My custom utilities"
aiwg add-agent code-helper --to my-utils --template simple
```

Or in-session with AI guidance:

```bash
/devkit-create-addon my-utils --interactive
```

**For MCP Integration:**

```bash
# Start MCP server
aiwg mcp serve

# Or install config for your client
aiwg mcp install claude  # For Claude Desktop
aiwg mcp install cursor  # For Cursor IDE

# View MCP info
aiwg mcp info
```

**For @-Mention Traceability:**

1. Wire mentions into existing artifacts:

   ```bash
   /mention-wire --target .aiwg/requirements/
   ```

2. Validate all mentions resolve:
   ```bash
   /mention-validate
   ```

---

## [0.9.1] - 2025-12-08

### Voice Framework & Skills System Release

This release introduces the **Voice Framework** addon and comprehensive **Skills system** across all frameworks. The CLI tooling has been updated to deploy skills automatically with framework installations.

#### Added

**Voice Framework Addon** (PR #52):

- 4 built-in voice profiles for consistent, authentic writing:
  - `technical-authority` - Direct, precise, confident (API docs, architecture)
  - `friendly-explainer` - Approachable, encouraging (tutorials, onboarding)
  - `executive-brief` - Concise, outcome-focused (business cases, reports)
  - `casual-conversational` - Relaxed, personal (blogs, newsletters)
- 4 voice skills:
  - `voice-apply` - Transform content to match a specified voice profile
  - `voice-create` - Generate new profiles from descriptions or examples
  - `voice-blend` - Combine multiple profiles with weighted ratios
  - `voice-analyze` - Analyze content's current voice characteristics
- YAML voice profile schema with tone, vocabulary, structure, perspective settings
- Project-specific voice profiles via `.aiwg/voices/`

**Skills System** (PR #51):

- Claude Code Skills support across all frameworks (SKILL.md format)
- 29 total skills deployed with `aiwg use all`:
  - 1 writing-quality skill (ai-pattern-detection)
  - 6 aiwg-utils skills (config-validator, project-awareness, etc.)
  - 4 voice-framework skills (voice-apply, voice-create, voice-blend, voice-analyze)
  - 10 SDLC framework skills (project-health, artifact-indexer, etc.)
  - 8 MMK framework skills (campaign-tracker, content-scheduler, etc.)
- Skills auto-deploy with `aiwg use <framework>`

**CLI Improvements**:

- New `aiwg use writing` command for Writing Quality + Voice Framework
- `--deploy-skills` flag for explicit skill deployment
- Skills deployment by mode: general, writing, sdlc, marketing, both, all
- Dry-run support for skill deployment testing

**Test Coverage**:

- `test/unit/cli/skill-deployer.test.ts` - 20 tests for skill deployment
- `test/unit/writing/voice-profile.test.ts` - 16 tests for voice profiles
- Integration tests for deploy-agents.mjs skill deployment

#### Changed

**Documentation Updates**:

- Updated all quickstart guides with Voice Framework sections
- Added voice profile usage to CLI_USAGE.md
- Updated integration quickstarts (Claude Code, Warp Terminal)
- Added Voice Framework integration to writing-quality addon README

**Deprecations**:

- `validation/banned-patterns.md` deprecated in favor of voice profiles
- Pattern-avoidance approach replaced by positive voice definition

#### Fixed

**CLI Tooling**:

- Fixed skills not deploying for voice-framework, SDLC, and MMK frameworks
- Fixed mode filtering for skill deployment
- Added provider restriction messaging (skills Claude-only currently)

### Migration Guide

**From banned-patterns to Voice Framework:**

1. Deploy the writing framework:

   ```bash
   aiwg use writing
   ```

2. Replace pattern avoidance with voice profiles:

   ```text
   # Before (pattern avoidance)
   "Write this avoiding AI patterns like 'delve into', 'it's important to note'"

   # After (voice definition)
   "Write this in technical-authority voice"
   ```

3. Create custom voice profiles for your project:
   ```yaml
   # .aiwg/voices/my-brand.yaml
   name: my-brand
   description: Our brand voice
   tone:
     formality: 0.5
     confidence: 0.8
   ```

---
