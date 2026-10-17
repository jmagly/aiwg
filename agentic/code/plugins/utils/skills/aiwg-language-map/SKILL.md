---
name: aiwg-language-map
namespace: aiwg
platforms: [all]
kernel: true
description: AIWG addons + extensions language map — categories, curated discover phrases, and per-bundle pointers covering everything beyond the framework quickrefs
---

# AIWG Language Map — Addons + Extensions

This is your always-loaded directory for the AIWG **addon and extension** surface. It's the orientation layer for the ~214 skills that live outside the 8 frameworks. Frameworks have their own per-framework quickrefs (`sdlc-quickref`, `forensics-quickref`, etc.); this map covers everything else: addons (utilities, loops, voice, testing, etc.) and ops extensions (sys/net/sec/dev/it/stream).

## How to use this map

1. Identify which **capability domain** below the user's need belongs to
2. Pick a **curated phrase** from that domain
3. Run `aiwg discover "<phrase>"` and surface the top match (or top-3) to the user
4. Fetch the body with `aiwg show skill <name>` — never `find` / `ls` / `Read` on storage paths

If a phrase doesn't fit the user's exact need, paraphrase. `aiwg discover` is forgiving with natural language.

**The discover→show pattern is mandatory.** See `aiwg-utils-quickref` for the canonical pipeline and `skill-discovery` HIGH rule for enforcement.

## Map layout

The map has two sections:

- **Addon capability domains** — user-need clusters (memory, loops, voice, etc.) routed to addons
- **Extension domains** — operational scopes (sys, net, sec, etc.) for `ops-complete`

Each section opens with an explicit `aiwg discover "<phrase>"` example. Table rows underneath show **bare phrases** — pass them straight to `aiwg discover` (the verb is implied by the section header). Phrases have been verified against the index; each surfaces the listed bundle in the top results.

---

## Addon capability domains

### Dataset intelligence, indexing & provenance

When a user points AIWG at files, an API, a corpus, or another dataset and asks
for search, indexing, traceability, provenance, lineage, synchronization, or
safe retirement—even when they do not know those terms.

Example: `aiwg discover "make this searchable"`. Phrases below pass straight to
`aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Start from only a source and outcome | `use this data` | dataset-intelligence |
| Recommend custom indexing safely | `make this searchable` | dataset-intelligence |
| Add evidence-bearing traceability | `trace this dataset` | dataset-intelligence |
| Explain record or field lineage | `where did this record come from` | dataset-intelligence |
| Verify freshness and provenance | `verify this dataset` | dataset-intelligence |
| Resume an incremental source | `sync this source` | dataset-intelligence |
| Retire data and derived artifacts safely | `retire this dataset` | dataset-intelligence |

The same governed intake and handoff envelopes serve SDLC, research,
knowledge-base, media, marketing, ops, and project-local bundles. All execution
delegates to `aiwg dataset`; the addon does not create a shadow runtime.

### Schemas & data contracts

When the user describes a record, configuration file, event, API payload,
message, import/export, or other structured data—even when they do not know to
ask for a schema.

Example: `aiwg discover "define data shape"`. Phrases below pass straight to
`aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Decide whether structured data needs a contract | `define data shape` | schema-governance |
| Explain schemas and continue examples-first | `why do I need a schema` | schema-governance |
| Author and register a canonical schema | `create a schema` | schema-governance |
| Evolve an existing contract safely | `change an existing schema` | schema-governance |
| Review correctness and readiness | `review a data contract` | schema-governance |

The SDLC discovery track invokes this addon automatically for persistent or
exchanged data. Users should describe the data need; they need not choose a
dialect, identifier, lifecycle, or compatibility policy themselves.

### Loops & iteration

When the user needs an iterative coding loop, recursive context decomposition, eval gates, or guided autonomous implementation.

Example: `aiwg discover "ralph loop"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Iterative AI coding loop (Ralph) | `ralph loop` | agent-loop |
| Loop status / abort / resume / attach | `ralph attach` (or `ralph abort` / `ralph resume` / `ralph status`) | agent-loop |
| External crash-resilient loop variant | `ralph external loop` | agent-loop |
| Recursive decomposition of a huge corpus | `rlm query` | rlm |
| RLM batch processing with parallel sub-agents | `rlm batch fan-out` | rlm |
| Bounded autonomous issue-to-code | `guided implementation` | guided-implementation |
| Inner generator/critic eval loop in a pipeline | `eval loop` | nlp-prod |
| KAMI-based agent quality eval framework | `agent quality eval` | aiwg-evals |

### Session history and exploration

Use `aiwg discover "spelunk session data"` to find catalog exploration. Useful
phrases include `search past conversations`, `trace session tool calls`,
`compare provider sessions`, and `harvest session decisions`. `session-explore`
handles search, timelines, analytics, citations and coverage; `session-harvest`
handles candidate review and promotion. `session-analyst` and the
`session-investigation` flow compose bounded evidence collection and synthesis.
The singular `session` launcher and cost-history telemetry serve different needs.

### Memory & state

When the user needs persistent agent memory, semantic ingestion, or context curation.

Example: `aiwg discover "memory ingest"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Semantic memory ingest | `memory ingest` | semantic-memory |
| Lint memory entries | `semantic memory lint` | semantic-memory |
| Capture / query memory | `memory query` | semantic-memory |
| Filter context to remove distractors | `filter distractors from context` | context-curator |

> `llm-wiki` has a first-class discoverable driver for profile selection and
> activation; its topology composes with the knowledge-base framework and
> semantic-memory drivers. `auto-memory` remains a template bundle pending its
> own operational driver.

### Voice & writing quality

When the user is producing or reviewing prose and needs voice consistency, AI-pattern detection, or related text quality work.

Example: `aiwg discover "apply voice profile"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Apply a voice profile to existing content | `apply voice profile` | voice-framework |
| Create a new voice profile | `create voice profile` | voice-framework |
| Blend two voices | `blend voice profiles` | voice-framework |
| Analyze content's current voice | `analyze voice` | voice-framework |
| Detect AI-pattern artifacts in writing | `ai pattern detection` | writing-quality |
| Improve output diversity (verbalized sampling) | `verbalized sampling` | verbalized-sampling |

### NLP & inference pipelines

When the user is building or optimizing LLM inference systems.

Example: `aiwg discover "pipeline architect"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| LLM inference pipeline architecture | `pipeline architect` | nlp-prod |
| Pipeline pattern selection | `pipeline pattern` | nlp-prod |
| Cost optimizer for LLM workloads | `llm cost optimizer` | nlp-prod |
| Eval-loop generator/critic | `eval loop` | nlp-prod |
| Productionize an inference pipeline | `pipeline productionize` | nlp-prod |
| Prompt engineering | `prompt engineer` | nlp-prod |
| Agentic or bounded classification | `agentic classification` | decision-engine (opt-in) |
| Jev decision engine | `Jev decision engine` | decision-engine (opt-in) |
| Reduce frontier tokens with bounded decisions | `classify to reduce frontier tokens` | decision-engine (opt-in) |
| Offload a yes/no, pick-one, or 1-N decision to Jev | `offload decisions to jev` | decision-engine (opt-in) |
| Set up Jev with a token | `set up jev` | decision-engine (opt-in) |
| Questions sharing authorized state | `shared-state batching` | decision-engine (opt-in) |
| Offline decision fixtures and readiness plans | `decision playground` | decision-engine (opt-in) |

`decision-engine` requires explicit installation: `aiwg use decision-engine`.
It is excluded from bulk installs. Discover `decision-offload` for
single-question offload via `aiwg decision ask` (enabled by
`aiwg decision setup jev`); discover `decision-evaluate` for pinned
classification requests; evaluation requires `AIWG_DECISION_ENABLED=1` plus
an explicit backend binding and approved projection for live egress. Library
batching also needs host policies; discovering the skill does not enable it.
Discover `decision-playground` to list and run offline recorded fixtures without
credentials or inference. Its `live-plan` command only reports readiness; live
evaluation requires the separate explicit opt-in and host configuration.
These phrases use deterministic discovery and require no model inference.

### Documentation intelligence

When the user is scraping, extracting, or analyzing documentation as a corpus.

Example: `aiwg discover "doc analyst"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Coordinate doc analysis (master orchestrator) | `doc analyst` | doc-intelligence |
| Scrape documentation sites | `doc scraper` | doc-intelligence |
| Extract from PDFs | `pdf extractor` | doc-intelligence |
| Run an OpenProse program | `prose run` | prose-integration |
| Validate / parse a Prose program | `prose validate` | prose-integration |

### Testing & quality

When the user needs test enforcement, UAT, or quality automation.

Example: `aiwg discover "tdd enforce"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| TDD enforcement / test gates | `tdd enforce` | testing-quality |
| Mutation testing analyst | `mutation analyst` | sdlc-complete (agent) |
| Mutation test runner | `mutation test` | testing-quality |
| UAT plan generation via MCP | `uat plan` | uat-mcp |
| UAT execution via MCP | `uat execute` | uat-mcp |

### Skill / extension authoring

When the user is building new AIWG content (skills, addons, framework changes).

Example: `aiwg discover "skill architect"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| End-to-end skill creation orchestrator | `skill architect` | skill-factory |
| Build a skill | `skill builder` | skill-factory |
| Enhance / validate / package a skill | `skill packager` | skill-factory |
| Validate an AIWG addon | `validate addon` | aiwg-dev |
| Validate a framework component | `validate component` | aiwg-dev |
| AIWG devkit build helpers | `devkit build` | aiwg-dev |
| Link-check across docs | `link check` | aiwg-dev |

### Color & UX

When the user needs color theory or palette tooling.

Example: `aiwg discover "color palette"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Generate or review a color palette | `color palette` | color-palette |
| Color theory fundamentals reference | `color theory` | color-palette |
| Accessibility / contrast review | `color accessibility` | color-palette |

### Daemon & background work

When the user needs persistent sessions or background orchestration.

Example: `aiwg discover "daemon init"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Concierge daemon entry / init | `daemon init` | aiwg-utils |
| Concierge agent (front-of-house) | `concierge daemon` | daemon |
| Mission Control (background mission orchestrator) | `mc dispatch` | agent-loop |
| Star-prompt for repo recommendations | `star prompt` | star-prompt |

### Setup & installer

When the user is bootstrapping a project or installing AIWG itself.

Example: `aiwg discover "setup manifest generate"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| Generate a reproducible installer manifest | `setup manifest generate` | agentic-installer |
| Validate / run a setup manifest | `setup manifest validate run` | agentic-installer |

### Hooks & integration

When the user needs platform-level lifecycle hooks, HITL gates, or external bridges.

Example: `aiwg discover "hitl patterns"`. Phrases below pass straight to `aiwg discover`.

| Need | Phrase | Bundle |
|---|---|---|
| HITL gate patterns (rule) | `hitl patterns` | sdlc-complete (rule) |
| HITL gates (rule, ensemble review) | `hitl gates` | sdlc-complete (rule) |
| Factory AI compat agent | `factory compat` | sdlc-complete (agent) |

> `aiwg-hooks`, `agent-persistence`, and `droid-bridge` now expose
> discoverable activation drivers. Their low-level hooks, HITL gates, and MCP
> server remain implementation artifacts reached through those drivers.

### Core meta-utilities

For everything else AIWG-internal — context regeneration, workspace management, index/query, validation, and project-status surfaces — see `aiwg-utils-quickref`. It's already loaded; this map points back at it.

---

## Extension domains (ops-complete)

Operational extensions live under `agentic/code/extensions/<domain>/` and extend `ops-complete`. They carry both skills AND rules. The framework-level `ops-quickref` lists the high-level extension model; this section gives you direct phrases.

Each block opens with one explicit `aiwg discover` example; remaining phrases are bare — pass straight to `aiwg discover`.

### sys — per-host operations

Hardware, OS, boot chains, fleet host documentation, immutable bases, hardware safety procedures.

```
aiwg discover "sys host profile"   # → sys-host-profiler agent (1.00)
sys host audit                     # → sys-host-audit skill
luks tpm dual phase                # → sec-luks-dual-phase rule (sys+sec border)
sys host independence              # → sys-host-independence rule
```

### net — network operations

VLANs, DNS, firewalls, Cloudflare tunnels, UniFi config, network state authority, cert expiry gates, tunnel safety.

```
aiwg discover "vlan audit"   # → net-vlan-audit (1.00)
net dns check                # → net-dns-check skill
net change blast radius      # → net-change-blast-radius rule
tunnel safety                # → net-tunnel-safety rule
net state authority          # → net-state-authority rule
```

### sec — security operations

PKI, LUKS, TPM2, YubiKey, SSH CA, access auditing, cert expiry gates, key material handling.

```
aiwg discover "sec cert scan"   # → sec-cert-scan
sec access snapshot             # → sec-access-snapshot
sec access audit frequency      # → sec-access-audit-frequency rule
sec cert expiry gate            # → sec-cert-expiry-gates rule
key material handling           # → sec-key-material-handling rule
sec luks dual phase             # → sec-luks-dual-phase rule
```

### dev — CI/CD and build automation

Pipeline safety, idempotent builds, secret hygiene, self-contained CI builders.

```
aiwg discover "pipeline safety ci"   # → dev-pipeline-safety rule
idempotent build                     # → dev-idempotent-builds rule
ci secret hygiene                    # → dev-secret-hygiene rule
self contained ci builder            # → dev-ci-self-contained rule
```

### it — IT ops, CMDB, asset management

Asset registry, service deployments, disaster recovery, change control, asset authority, DR validation.

```
aiwg discover "it asset sync"   # → it-asset-sync skill (0.81)
it asset authority              # → it-asset-authority rule
it service health               # → it-service-health rule
it dr validation                # → it-dr-validation rule
it change control               # → it-change-control rule
```

### stream — streaming media operations

Transcoders, restreaming, platform integrations, stream pipeline gates.

```
aiwg discover "stream deploy"   # → stream-deploy skill
stream pipeline gates           # → stream-pipeline-gates rule
stream safety                   # → stream-safety rule
```

### api-adapter — external API integrations

Reserved for external API adapter scaffolding. Currently a placeholder bundle with no skills or rules; phrases will appear as adapters are added.

---

## Categories at a glance (cheat sheet)

When you don't know which domain a need falls into:

| If the user mentions... | Look in... |
|---|---|
| "loop", "iterate", "ralph", "recursive", "decompose huge file" | Loops & iteration |
| "remember", "memory", "context", "wiki", "ingest" | Memory & state |
| "voice", "writing style", "AI pattern", "diversity", "samples" | Voice & writing quality |
| "inference", "pipeline cost", "model selection" | NLP & inference pipelines |
| "documentation scrape", "extract from PDF", "Prose program" | Documentation intelligence |
| "test enforcement", "TDD", "UAT", "MCP test" | Testing & quality |
| "build a skill", "scaffold addon", "framework dev" | Skill / extension authoring |
| "color", "palette", "contrast", "WCAG" | Color & UX |
| "daemon", "background mission", "mission control" | Daemon & background work |
| "installer", "setup manifest", "bootstrap" | Setup & installer |
| "hooks", "permissions", "session", "droid", "HITL" | Hooks & integration |
| "host", "BIOS", "boot chain", "OS install" | Extensions / sys |
| "VLAN", "DNS", "firewall", "tunnel" | Extensions / net |
| "cert", "LUKS", "YubiKey", "PKI", "access audit" | Extensions / sec |
| "CI", "pipeline", "build", "secret in workflow" | Extensions / dev |
| "CMDB", "asset", "DR", "service deploy", "change control" | Extensions / it |
| "transcoder", "restream", "live broadcast" | Extensions / stream |

---

## Project-local extensions (pilot → promote)

Addons, extensions, and frameworks don't all have to come from upstream. Users can pilot content bundles per-project under `.aiwg/{extensions,addons,frameworks}/<name>/`, validate them, then promote to upstream when mature. Use `.aiwg/plugins/<name>/` only when wrapping a bundle for marketplace delivery. Curated phrases:

```bash
aiwg new-bundle <name>                         # scaffold; auto-builds project graph
aiwg new-extension <name> --starter rule       # extension with starter rule
aiwg new-addon <name>                          # addon
aiwg new-framework <name>                      # framework
aiwg new-plugin <name>                         # marketplace delivery wrapper
aiwg new-bundle <name> --dry-run               # preview without writing
aiwg list --project-local                      # inventory + validation status
aiwg doctor --project-local                    # health check (counts, drift, shadows)
aiwg use <name>                                # deploy single project-local bundle
aiwg promote <name>                            # graduate to upstream (hash-verified)
aiwg promote <name> --to corpus <path>         # promote to private corpus instead
aiwg promote <name> --dry-run                  # preview promotion
```

After scaffolding, the bundle is immediately discoverable via `aiwg discover "<name>"` — the project graph is rebuilt automatically. No manual `aiwg index build --graph project` step needed.

## When this map doesn't have a phrase that fits

**Don't enumerate from memory.** Run `aiwg discover` with the user's natural-language phrasing — the index is forgiving. If you get zero results, try:

1. A broader phrase (e.g., drop a noun)
2. A different vocabulary (e.g., "deploy" vs "publish" vs "release")
3. `aiwg index stats --graph framework` to confirm the index is built and populated
4. Check whether the bundle is even installed via `aiwg list`
5. If the workspace has project-local bundles, also check `aiwg index stats --graph project`

If after that the capability genuinely doesn't exist, you can tell the user honestly — but only after the search ran and came up empty. The `skill-discovery` HIGH rule mandates the search before declining.

## See also

- `aiwg-utils-quickref` — core meta-utility surface and the canonical discover→show pipeline
- Per-framework quickrefs: `sdlc-quickref`, `forensics-quickref`, `research-quickref`, `media-curator-quickref`, `marketing-quickref`, `ops-quickref`, `security-engineering-quickref`, `knowledge-base-quickref`
- `skill-discovery` HIGH rule — discovery is mandatory before declining or improvising
