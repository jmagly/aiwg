<div align="center">

<a href="https://aiwg.io"><img src="https://aiwg.io/assets/badges/aiwg-hero-dark.png" alt="AIWG — multi-agent AI framework · one source of truth · 10 platforms" width="680"></a>

# @aiwg/cli

Paid web resources support passwordless login through `aiwg auth login` (or
`--device` for headless use), `aiwg auth status`, and `aiwg auth logout`.
Tokens are held in the native operating-system credential store. The mode-0600
file fallback is disabled unless explicitly selected and allowed.

**The agent-optimized execution layer for AIWG**

AIWG skills and agents use this CLI to perform common operations with
predictable, structured calls instead of spending context on shell discovery,
filesystem traversal, command reconstruction, and repeated tool output.

New to AIWG? Install the full `aiwg` package and let the agentic installer
connect the complete system. `@aiwg/cli` is the smaller execution layer for
agents, CI, and web-backed installations.

```text
Install or repair AIWG for this project by following
https://aiwg.io/setup.aiwg.yaml
Explain the plan before changing anything, preserve my existing work, and ask
me only for choices you cannot safely determine.
```

The equivalent manual path is three steps:

```bash
npm install --global aiwg
cd /path/to/your/project
aiwg use all --provider <provider>
```

The final command deploys, refreshes indices and project context, verifies the
provider wiring, and reports one result. Standalone index, regenerate, status,
and doctor commands remain advanced maintenance and recovery tools.

[![npm version](https://img.shields.io/npm/v/%40aiwg%2Fcli/latest?label=%40aiwg%2Fcli&color=CB3837&logo=npm&style=flat-square)](https://www.npmjs.com/package/@aiwg/cli)
[![npm downloads](https://img.shields.io/npm/dm/%40aiwg%2Fcli?color=CB3837&logo=npm&style=flat-square)](https://www.npmjs.com/package/@aiwg/cli)
[![full distribution](https://img.shields.io/npm/v/aiwg/latest?label=aiwg&color=CB3837&logo=npm&style=flat-square)](https://www.npmjs.com/package/aiwg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://github.com/jmagly/aiwg/blob/main/LICENSE)
[![Node Version](https://img.shields.io/badge/node-%E2%89%A524-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Signed Resources](https://img.shields.io/badge/resources-signed-00a67d?style=flat-square)](https://releases.aiwg.io/)

[**Quick Start**](#quick-start) · [**Agentic Model**](#the-agentic-use-model) · [**Token Economy**](#why-this-reduces-agent-token-use) · [**How It Works**](#how-it-works) · [**Security**](#security-model) · [**Troubleshooting**](#installation-troubleshooting)

</div>

---

## What This Package Is

`@aiwg/cli` is the small executable runtime beneath AIWG's skills, agents,
rules, and workflows. It is primarily an **agent tool**, even though an
operator can run it from a terminal.

The important product surface is not a long list of commands. The important
surface is the AIWG capability graph:

- skills carry task-specific instructions, gates, preservation logic, and
  recovery guidance;
- agents supply roles, judgment, and orchestration;
- rules supply policy that remains in force across tasks;
- the CLI supplies deterministic lookup, validation, deployment, health,
  indexing, configuration, and execution primitives;
- signed web releases let the runtime reach the capability graph without
  bundling the complete corpus into this npm package.

An agent should normally enter through a skill or an AIWG agent and let that
resource call `aiwg` when an imperative operation is needed. This keeps the
reasoning layer focused on the user's objective while the CLI handles the
mechanical work.

The package includes the `aiwg` executable, its routing and validation runtime,
the Fortemi Core query client, signed web-release verification, verified
caching, and provider metadata needed by agentic integrations. It intentionally
does not carry the complete `agentic/code` source tree, project artifacts, or
Cockpit.

In practice, this means an agent can:

1. identify the narrow AIWG capability that matches the request;
2. retrieve only that skill or agent definition;
3. follow its gates and call the CLI steps it specifies;
4. consume stable structured output instead of parsing exploratory shell
   transcripts;
5. leave the project with fewer temporary files, copied resources, and
   provider-specific assumptions.

Signed resources are available from
[`releases.aiwg.io`](https://releases.aiwg.io/). A clean installation can use
the published capability graph without first copying the full framework corpus
into every project.

## The Agentic Use Model

AIWG follows a skills-first hierarchy:

```text
user intent
    |
    v
AIWG skill or agent
    |  task knowledge, policy, gates, recovery
    v
small CLI operation
    |  deterministic lookup, validation, mutation, or status
    v
structured result
    |
    v
agent judgment and user-facing outcome
```

The preferred routing order is:

1. **Use an already available AIWG skill or agent.** This is the cheapest and
   best-primed route. The resource already knows the relevant workflow and
   calls the CLI only where needed.
2. **Discover the right AIWG capability.** If the resource is not already in
   context, the agent performs an indexed lookup and retrieves the single best
   match. It does not recursively browse provider directories or read the
   whole corpus.
3. **Use a raw CLI command only for a basic operator operation, for discovery
   and status, or as a step inside a skill.** Raw action commands lack the
   task-specific priming carried by skills.

This distinction matters. Running an action command directly may perform the
mechanical operation, but the paired skill also explains preconditions,
preservation requirements, review gates, failure recovery, and what evidence
must be retained. The skill is the workflow; the CLI is its execution
substrate.

Examples of the intended pairing:

| Intent | Preferred agentic entry | CLI role |
|---|---|---|
| Deploy an AIWG framework | `use` skill | Calls `aiwg use` with validated provider and project context |
| Diagnose an installation | `aiwg-doctor` skill | Calls `aiwg doctor`, interprets failures, and guides remediation |
| Refresh an installation | `aiwg-refresh` skill | Previews and invokes refresh safely |
| Regenerate provider context | `aiwg-regenerate` skill family | Preserves operator content while invoking regeneration |
| Find a specialized workflow | AIWG capability discovery | Queries the precomputed index and retrieves one matching resource |
| Run an executable skill | The selected skill | Dispatches its declared script through the runtime registry |

Operators can still use `aiwg use` and `aiwg doctor` directly for basic setup
and diagnostics. Agentic systems should prefer the paired skills because they
carry the context that a bare command cannot.

## Why This Reduces Agent Token Use

General-purpose shell access is flexible, but flexibility is expensive for an
agent. Without a purpose-built interface, a session often has to:

- determine where a package was installed;
- enumerate directories and guess which provider copy is authoritative;
- search hundreds or thousands of files;
- read several near-matching documents before finding the right one;
- reconstruct command syntax from help text;
- parse prose-oriented terminal output;
- rediscover safety checks and recovery steps;
- repeat the same investigation in every project or new session.

Each step adds tool calls and returns text that competes with the actual task
for context. Recursive listings and broad text searches are especially costly:
they describe the storage layout instead of answering the user's intent.

AIWG changes that interaction:

```text
traditional shell-oriented path

locate install
  -> list directories
  -> search filenames
  -> grep many documents
  -> read several candidates
  -> infer the workflow
  -> reconstruct command flags
  -> parse terminal output

AIWG agentic path

intent
  -> indexed capability selection
  -> one relevant skill or agent
  -> bounded CLI operation
  -> structured result
```

The token advantage comes from reducing irrelevant material, not from hiding
important instructions:

- **Precomputed indices replace broad filesystem searches.** The agent asks by
  intent and receives ranked capability metadata.
- **Selective retrieval replaces corpus loading.** Only the chosen skill,
  agent, command, or rule enters context.
- **Skills preserve procedural knowledge.** Sessions do not have to regenerate
  the same checklist, safety gates, and recovery process from first
  principles.
- **Structured output reduces parsing.** Machine-facing operations can return
  stable fields rather than decorated terminal prose.
- **Stable identifiers reduce rediscovery.** Agents can pass capability IDs
  and names between workers without passing installation-specific paths.
- **Provider abstraction reduces branching.** The runtime handles supported
  provider paths and configuration so each skill does not need a separate
  shell recipe for every agentic platform.
- **Signed web resources reduce setup narration.** An agent does not need to
  clone or explain a large local corpus before it can retrieve guidance.

No fixed token-saving percentage is promised: savings depend on the task,
provider, and whether the needed skill is already loaded. The design goal is
measurable in simpler terms—fewer exploratory calls, less unrelated output,
smaller context payloads, and less duplicated procedural reasoning.

## Choose the Right AIWG Distribution

AIWG publishes three packages in exact CalVer lockstep:

| Package | Best for | Resource model | Install |
|---|---|---|---|
| `@aiwg/cli` | Agentic runtimes, web-connected sessions, CI, and lightweight global use | Signed release host by default | `npm i -g @aiwg/cli` |
| `aiwg` | Full local operation, framework deployment, authoring, offline-first projects | Bundled local corpus by default; web mode optional | `npm i -g aiwg` |
| `@aiwg/cockpit` | Optional local control plane and operator UI | Installed separately or through the full CLI | `npm i -g @aiwg/cockpit` |
| `@aiwg/flue` | Flue app skills, specialists and MCP helpers | Installed in a Flue app | `npm install @aiwg/flue` |

Choose `@aiwg/cli` when AIWG skills and agents need a small, globally available
execution layer and can obtain resources from the signed web release. Choose
`aiwg` when local authoring, the full bundled corpus, or completely cold
offline operation is required.

For a first installation, an uncertain environment, or a machine with an old
or broken AIWG setup, use the full `aiwg` package and the
[agentic installer manifest](https://aiwg.io/setup.aiwg.yaml).
The flow detects development checkouts and preserves development mode unless
the user explicitly approves switching to the published package.

Both CLI packages expose the same `aiwg` executable name. Install one globally
at a time unless you deliberately manage separate npm prefixes.

## Quick Start

### Install

```bash
npm install --global @aiwg/cli
aiwg --version
aiwg doctor
```

AIWG uses npm-compatible Calendar Versioning:

```text
YYYY.M.PATCH
```

The lightweight package version always matches the corresponding full `aiwg`
release exactly.

For a basic operator-managed framework deployment, invoke the `use` skill in
your agentic environment. It validates the target and calls the equivalent
`aiwg use` operation. If you are intentionally working at a terminal, the
direct form is:

```bash
aiwg use <framework-or-addon>
```

Run `aiwg doctor` after installation or deployment. In an agent session,
prefer the `aiwg-doctor` skill so the result is interpreted and remediated
rather than merely printed.

Agents do not need to memorize the remaining command surface. AIWG discovery
finds the relevant skill, and the skill supplies the right CLI step. Operators
who need the complete syntax and examples can use the
[AIWG CLI reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md).

## How It Works

```text
operator or agent
       |
       | aiwg discover / aiwg show
       v
@aiwg/cli command router
       |
       | signed channel manifest
       v
releases.aiwg.io/resources/channels/stable.json
       |
       | immutable release manifest + detached Ed25519 signature
       v
releases.aiwg.io/resources/<version>/
       |
       +-- precomputed Fortemi Core search index
       +-- immutable raw resource files
       +-- linked discovery pages and manifests
       |
       v
verified local cache
```

The first request for a release normally downloads:

1. the signed channel metadata;
2. the immutable release manifest and signature;
3. the precomputed Fortemi Core index and its committed metadata;
4. requested raw resource bodies as `show` needs them.

Every release descriptor includes a byte size and SHA-256 digest. Channel and
release metadata are verified with the public key embedded in the package.
Channel sequence checks reject rollback and same-sequence equivocation. Raw
files are accepted only when they match a descriptor committed by the verified
manifest.

The cache is a performance and offline facility, not a substitute trust root.
Cached generations are revalidated before use.

## Why Web-First

Traditional AIWG installations carry the complete corpus so deployment and
local authoring work anywhere. That remains valuable, but it is unnecessary
for many agent sessions.

The lightweight model provides:

- **smaller distribution footprint** — executable runtime rather than the full
  framework tree;
- **no project deployment requirement** — discovery works in an empty
  directory;
- **version selection per call** — use stable, another signed channel, or an
  exact CalVer release;
- **consistent search behavior** — the CLI downloads the precomputed index and
  queries it through Fortemi Core;
- **browser and chat interoperability** — the same release tree also exposes
  linked discovery pages for web-connected agents that cannot run the CLI;
- **verified caching** — warm reads remain available offline without accepting
  uncommitted bytes.

This is not a hosted command-execution service. Search and resource delivery
move to the web; project mutation and provider deployment remain local
operations.

## How Skills and Agents Use the Runtime

The CLI is deliberately narrow at the point where it meets an agent. A skill
should ask it to do one bounded thing, verify the result, and return control to
the reasoning layer.

### Capability selection

Most AIWG capabilities are not loaded into every prompt. Loading hundreds of
skills would consume context before the user's task even began. Instead, AIWG
keeps a small kernel available and retrieves specialized capabilities on
demand.

The runtime queries a precomputed Fortemi Core index using the user's intent.
It returns ranked metadata rather than dumping files. The agent selects the
best candidate and retrieves that resource alone.

This mechanism is exposed through `discover` and `show`, but those names are
implementation details for most users. The practical behavior is:

```text
"prepare a production rollback"
        |
        v
ranked AIWG capabilities
        |
        v
one selected deployment skill
        |
        v
skill-directed checks and execution
```

Stable IDs make the result portable between a conductor and sub-agents. A
worker receives the capability identity and body it needs, not a transcript of
the conductor's directory search.

### Execution through skills

Skills use CLI operations for mechanics such as:

- validating installation and workspace health;
- deploying a framework or addon to supported providers;
- resolving project and user configuration;
- maintaining indexes and normalized metadata;
- running a script declared by a skill;
- generating or refreshing provider adapters;
- moving or validating the configured AIWG data store;
- producing structured status and evidence;
- selecting a signed resource version for reproducible work.

The skill remains responsible for sequencing and interpretation. For example,
a deployment skill may:

1. inspect provider support;
2. validate the requested framework;
3. preview changes;
4. call the deployment primitive;
5. verify generated files;
6. explain any provider-specific follow-up.

A bare deployment command would perform only part of that workflow. Keeping the
orchestration in the skill makes behavior reviewable and lets AIWG improve the
workflow without teaching every agent a new shell recipe.

### Structured subprocess behavior

Agent integrations should prefer machine-readable output when they need to
consume results programmatically. Stable fields are cheaper and safer to parse
than ANSI-decorated tables or prose intended for a person.

Good agent-facing calls have these properties:

- explicit working directory;
- bounded timeout or abort signal;
- nonzero exit treated as a failure;
- structured output where available;
- no shell interpolation of untrusted user text;
- exact resource version when reproducibility matters;
- the smallest output needed for the next decision.

The CLI's command router is also exported for integrations that need in-process
execution. That API exists to support agent runtimes and AIWG tooling; this
README intentionally does not duplicate the full programming reference.

### Recovery and diagnosis

When an operation fails, the agent should not immediately improvise a sequence
of destructive shell commands. It should route through the relevant AIWG
health or recovery skill.

The `aiwg-doctor` skill wraps `aiwg doctor` with interpretation and remediation
guidance. It can distinguish installation damage, missing package content,
provider deployment drift, bad configuration, and unavailable optional
features. That distinction prevents an agent from treating every missing file
as a reason to reinstall or overwrite project state.

Similarly, refresh and regeneration skills preserve operator-authored content
and use dry-run or transactional behavior where the workflow requires it.
Those safeguards live above the raw command and are a core reason to keep
agents skill-first.

## When Direct CLI Use Is Appropriate

Direct CLI use remains useful in a few bounded situations:

- an operator is installing AIWG and runs `aiwg doctor`;
- an operator intentionally deploys a known framework with `aiwg use`;
- an agent performs capability discovery or retrieves a selected resource;
- a skill calls its documented CLI step;
- CI invokes a deterministic validation command;
- a maintainer is debugging the runtime itself.

Direct CLI use is usually the wrong starting point when the task is expressed
as a goal such as "review this architecture," "prepare a release," "investigate
this incident," or "build a research corpus." Those are capability requests.
The agent should select the corresponding AIWG skill or agent and let that
resource decide which CLI operations are needed.

This README therefore documents the operating model, package boundary, trust
model, and troubleshooting path instead of duplicating every command and flag.
The complete operator reference is maintained at:

**[AIWG CLI Reference — every command and example](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md)**

Keeping the command catalog in one canonical location prevents package
documentation from drifting as the runtime grows.

## Agent Integration Guidance

An agent harness integrating AIWG should establish a few simple policies.

### Prefer semantic intent over filenames

Ask for the capability in the user's language. Do not guess that a workflow
must live under a particular framework directory. The same intent may be
served by a framework skill, an addon skill, an agent, or a project-local
extension.

### Load the minimum relevant resource

Retrieve the selected skill or agent body, plus any directly referenced rule
needed to execute it. Avoid loading an entire framework merely because one
skill belongs to it. This is the primary context-management advantage of the
web-first package.

### Keep paths out of inter-agent contracts

Pass stable capability IDs, names, release versions, and structured results.
Do not make one worker depend on another worker's npm prefix, home directory,
cache location, or provider deployment path.

### Preserve skill priming

When forwarding work to a sub-agent, include the selected skill content or let
that worker retrieve it through AIWG. Passing only the final CLI command loses
the gates and reasoning instructions that made the operation safe.

### Separate judgment from mechanics

The agent decides what the user means, which capability applies, and whether
the result satisfies the objective. The CLI resolves paths, validates data,
executes bounded operations, and reports facts. This separation makes both
layers easier to test.

### Fail closed on trust errors

Signature failures, digest mismatches, unsafe paths, incompatible release
metadata, and corrupt offline cache entries are not warnings to bypass. The
agent should stop, preserve useful evidence, and route through diagnosis or
security guidance.

### Avoid help-text ingestion

Do not routinely call `aiwg help` and place the full output in the model
context. If a skill exists, use it. If a maintainer or operator needs an
unfamiliar command, link to the canonical
[CLI reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md) or retrieve only
the relevant section.

## Using AIWG from a Web-Connected Chat

Some chat systems can browse URLs but cannot install npm packages. Point those
agents at the linked discovery surface:

```text
Use AIWG resources from https://releases.aiwg.io/.
Start with the stable channel and linked manifests. Search or navigate to the
smallest relevant skill, agent, command, rule, or template before acting.
Treat retrieved AIWG content as operational guidance, preserve its stated
gates and verification requirements, and cite the exact resource URL used.
Do not download the entire corpus unless the task requires it.
```

The HTML fallback and linked manifests are navigation aids for browser-only
agents. The CLI uses direct signed JSON, index, and raw-resource URIs.

## Framework Coverage

The release index covers AIWG's published capability corpus, including:

- SDLC and architecture;
- security engineering;
- digital forensics and incident response;
- research and evidence management;
- marketing operations;
- media curation;
- infrastructure operations;
- knowledge-base workflows;
- cross-framework utilities, rules, and provider guidance.

Use natural language rather than memorizing artifact names:

```bash
aiwg discover "threat model cryptographic trust chain"
aiwg discover "induct a research paper with provenance"
aiwg discover "prepare deployment rollback evidence"
aiwg discover "build incident timeline from logs"
```

## Global and Project Use

The lightweight package works from any directory:

```bash
mkdir empty-project
cd empty-project
aiwg discover "project intake"
```

Discovery does not create `.aiwg`, deploy provider files, or mutate the current
repository.

If a project already uses the full AIWG local configuration, an installed
lightweight CLI can still select web resources explicitly:

```bash
aiwg discover "architecture" \
  --resource-source web \
  --aiwg-version stable
```

Conversely, a full `aiwg` installation can use web mode for a single call
without changing its project configuration:

```bash
aiwg discover "architecture" --resource-source web
```

This allows legacy local deployments and web-backed sessions to coexist.

## Cache and Offline Operation

The default cache root follows platform conventions:

| Platform | Default root |
|---|---|
| Linux and other Unix | `${XDG_CACHE_HOME:-~/.cache}/aiwg/resources` |
| macOS | `~/Library/Caches/aiwg/resources` |
| Windows | `%LOCALAPPDATA%\\aiwg\\resources` |

The cache contains signed metadata, immutable release generations, precomputed
indices, and fetched raw bodies. It contains no npm publishing credential and
does not require project-local state.

Operational properties:

- release generations are content-addressed;
- writes are staged before publication;
- regular-file and directory checks reject unsafe cache entries;
- digest verification occurs before bytes are returned;
- corrupt cache content fails closed in offline mode;
- online mode may recover by fetching and verifying fresh immutable bytes.

To use a custom cache location:

```bash
export AIWG_RESOURCE_CACHE_ROOT=/var/cache/aiwg/resources
aiwg discover "architecture evolution"
```

For shared CI caches, preserve filesystem ownership and do not allow
untrusted jobs to write into a cache consumed by privileged jobs.

## Configuration

Most users need no configuration. The defaults are:

```text
resource source: web
release selector: stable
release origin:  https://releases.aiwg.io
query backend:   fortemi-core
```

Command-line flags are the preferred way to make per-call choices.

Advanced environment settings:

| Variable | Purpose |
|---|---|
| `AIWG_RESOURCE_BASE_URL` | Override the clean HTTPS release origin |
| `AIWG_RESOURCE_CACHE_ROOT` | Override cache location |
| `AIWG_RESOURCE_TRUST_ROOT_FILE` | Load a nonempty public PEM trust root |
| `XDG_CACHE_HOME` | Standard cache root override |
| `AIWG_LOG_LEVEL` | CLI logging level |
| `NO_UPDATE_NOTIFIER` | Disable update notices in automation |

`AIWG_RESOURCE_ALLOW_INSECURE_LOOPBACK_HTTP=1` is a test/development escape
hatch. Insecure HTTP remains restricted to loopback. Production release origins
must use HTTPS.

Do not point the CLI at an arbitrary resource server and assume it is trusted.
A custom server must publish manifests and signatures compatible with the
configured public trust root.

## Security Model

The web distribution is designed to fail closed.

### Signed channels

Mutable channel names resolve through detached Ed25519 signatures and monotonic
sequence numbers. The CLI rejects:

- invalid signatures;
- sequence rollback;
- conflicting data for an already observed sequence;
- channel metadata bound to another release manifest.

### Immutable releases

Each release has a signed manifest that commits to every supported resource by
path, size, and SHA-256 digest. Exact-version selection avoids mutable channel
movement entirely.

### Raw resources

`show` fetches only safe relative paths under `raw/` that are present in the
verified manifest. Arbitrary URL fetches, path traversal, absolute paths, and
uncommitted files are rejected.

### Network policy

- HTTPS is mandatory for production origins.
- Redirects are rejected for signed resource fetches.
- Metadata, indices, signatures, and raw resources have fixed size limits.
- Requests have a finite timeout.
- Offline mode performs no network recovery.

### npm supply chain

AIWG publishes `@aiwg/cli` from GitHub Actions using npm trusted publishing and
OIDC provenance. Inspect the current release:

```bash
npm view @aiwg/cli@latest dist.attestations --json
npm view @aiwg/cli@latest dist.integrity
```

Versions are CalVer-locked to the full `aiwg` package and release workflows
verify that the package metadata, executable, declarations, license, and README
are present.

Consumer verification guidance:

- [Release verification](https://github.com/jmagly/aiwg/blob/main/docs/releases/verifying.md)
- [Supply-chain overview](https://github.com/jmagly/aiwg/blob/main/docs/security/supply-chain-overview.md)
- [Security policy](https://github.com/jmagly/aiwg/blob/main/SECURITY.md)

## Current Scope and Limitations

The lightweight package is an agentic execution and resource-access layer. Its
web-backed path provides production support for capability selection, resource
retrieval, signed release selection, verification, caching, and warm offline
reads.

It does not turn every AIWG action into a hosted service. Operations that
modify a project still run locally under the operator's permissions. A skill
may direct the CLI to write project artifacts or provider adapters, but the
release host never receives authority to mutate the project.

The lightweight package includes a bounded local runtime for packaging and
installing external addon-shaped bundles. It does not include AIWG's full
framework corpus. A project-local wrapper under `.aiwg/plugins/<id>/` can be
packaged from either its id or its path:

```bash
aiwg package-plugin my-plugin --provider all
aiwg package-plugin .aiwg/plugins/my-plugin --provider all
```

External bundles have an explicit installation choice:

```bash
# Project-local (default): deploy provider artifacts into this project and
# refresh the project artifact + Fortemi indices.
aiwg use my-plugin --provider claude --scope project

# Global: install the wrapper under ~/.aiwg, deploy to the provider's
# supported user paths, and refresh the shared user artifact + Fortemi indices.
aiwg use my-plugin --provider claude --global
```

`--scope user` remains the additive compatibility form: it leaves the
project deployment in place and mirrors supported artifacts to user scope.
`--global` is the no-project-provider-artifacts form. Providers differ in
their native user-level surfaces, so unsupported combinations fail with an
explicit provider-contract error instead of silently deploying zero files.

Some skills require the full local corpus, source templates, or authoring
assets. When a selected workflow reports that requirement, install the full
distribution:

```bash
npm uninstall --global @aiwg/cli
npm install --global aiwg

aiwg doctor
```

The package exposes the shared runtime, so help output may mention operations
whose complete inputs exist only in the full distribution. Agents should treat
an explicit "local corpus required" result as a package-boundary signal, not as
an invitation to search random filesystem locations.

## Common Agentic Patterns

### Turn a broad request into one bounded workflow

A user may ask, "Can you prepare this service for production?" The agent should
not start by enumerating every deployment command. It should:

1. classify the request as an SDLC/deployment capability;
2. select the relevant AIWG skill;
3. read the skill's prerequisites and evidence requirements;
4. invoke only the CLI operations called for by that skill;
5. return the outcome and unresolved gates to the user.

This pattern keeps the conversation about production readiness rather than
about command syntax.

### Hand work to a specialized agent

A conductor may discover that an architecture decision requires a security
review. It can pass the selected security skill and the relevant project
artifact to a security agent. It does not need to pass a recursive listing of
AIWG's security framework or explain where npm installed it.

The receiving agent works from the same signed capability identity and can use
the CLI for any deterministic checks specified by the skill.

### Diagnose before repairing

When AIWG appears broken, invoke the `aiwg-doctor` skill. The skill runs the
health primitive, classifies the finding, and chooses a remediation path. This
is less error-prone than having every agent invent an npm reinstall, delete
provider directories, or rewrite configuration on the first failure.

For a person at a terminal, the basic entry remains:

```bash
aiwg doctor
```

### Deploy through the `use` skill

The `use` skill is the normal agentic entry for framework and addon deployment.
It knows how to validate the requested bundle and supported provider before
calling the CLI. A human who already knows the exact target may use:

```bash
aiwg use <framework-or-addon>
```

The skill-first route is preferred because deployment can involve provider
capabilities, project-local customizations, stale-file handling, and
post-deployment checks that are not conveyed by the command name alone.

### Pin a capability graph for reproducible work

Long-running missions, release audits, and regulated workflows may bind the
runtime to an exact AIWG CalVer. Every worker can then retrieve capabilities
from the same immutable release instead of following a channel that may move
during the job.

The version belongs in mission or CI configuration. Individual agents should
inherit it rather than independently selecting different versions.

### Warm resources before network isolation

An online preparation step can retrieve the small set of skills, rules, and
indices needed by a later isolated job. Offline execution then uses only
previously verified cache generations and fails closed if required bytes are
missing.

This is preferable to copying the entire framework corpus into every isolated
worker. It keeps the payload task-specific and leaves a clear record of which
AIWG release supplied the guidance.

### Use the web surface when the agent cannot run tools

Browser-only chat agents can navigate the linked release manifests and HTML
fallback pages at `releases.aiwg.io`. Tool-capable agents should use the CLI
because it verifies signatures, digests, channel sequence, and cache state
automatically.

Both paths expose the same capability graph. The difference is the access
mechanism, not a separate set of AIWG instructions.

## Installation Troubleshooting

### Requirements

- Node.js 24 or newer;
- npm or another package manager capable of installing npm packages;
- HTTPS access to npmjs.org for installation;
- HTTPS access to `releases.aiwg.io` for cold web-resource reads.

Confirm versions:

```bash
node --version
npm --version
```

### `aiwg` command not found

Check the npm global prefix:

```bash
npm config get prefix
which aiwg
```

Add the prefix's `bin` directory to your shell `PATH`, or use:

```bash
npx --package @aiwg/cli aiwg --version
```

### npm `EACCES`

Do not default to `sudo npm install -g`. Prefer a user-owned Node installation
through a version manager, or configure a user-owned npm prefix:

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
npm install --global @aiwg/cli
```

Persist the `PATH` update in the shell startup file appropriate for your
system.

### First discovery is slower than later calls

A cold install downloads and verifies release metadata plus the precomputed
Fortemi index. Later calls use the verified cache. The request remains bounded
by a finite timeout.

If a first request fails:

```bash
curl -I https://releases.aiwg.io/
aiwg discover "architecture evolution" --aiwg-version stable
```

Check proxy, DNS, TLS interception, and firewall policy. Do not disable
signature verification to work around a network problem.

### Cold offline failure

This is expected:

```text
AIWG resource channel stable is not cached; offline mode cannot fetch it
```

Run the command once online without `--offline`, then repeat offline.

### Corrupt cache failure

Offline mode refuses corrupt data. Reconnect and rerun the command online so
the CLI can fetch a fresh, verified immutable generation. If diagnosing the
cache manually, preserve it first when the failure may indicate filesystem
tampering.

### Local source not found

`@aiwg/cli` does not ship the local corpus. Remove
`--resource-source local`, select `web`, configure a legitimate local AIWG
root, or install the full `aiwg` package.

### Web backend error

Web discovery requires the Fortemi Core backend:

```bash
aiwg discover "architecture" \
  --resource-source web \
  --backend fortemi-core
```

The local backend remains available only with local resources.

### Wrong package is providing `aiwg`

```bash
which aiwg
npm list --global --depth=0 | grep aiwg
aiwg --version
```

If both `aiwg` and `@aiwg/cli` were installed into the same prefix, the most
recent install owns the shared executable link. Remove both, then install the
distribution you intend to use.

### Bundled setup requires the full package

`aiwg use all` and named framework setup such as `aiwg use sdlc` need the
framework and addon sources included in `aiwg`. The lightweight `@aiwg/cli`
package supports signed web lookup and external project-local bundle deployment;
web lookup does not download a complete source tree for bundled setup.

If setup reports that the full package is required, replace the lightweight
global installation and rerun setup with your provider:

```bash
npm uninstall -g @aiwg/cli
npm install -g aiwg
aiwg use all --provider pi
```

Older CLI versions can instead report `ENOENT` while scanning
`@aiwg/cli/agentic/code/addons`. The same recovery applies. Existing project
files are retained; the prerequisite check now stops before deployment or
project initialization, including in dry-run mode.

## Migrating Between Distributions

From full AIWG to the lightweight package:

```bash
npm uninstall --global aiwg
npm install --global @aiwg/cli
aiwg discover "architecture evolution"
```

Existing project files are not removed. The new executable defaults discovery
to web resources.

From the lightweight package to full AIWG:

```bash
npm uninstall --global @aiwg/cli
npm install --global aiwg
aiwg doctor
```

The full package defaults to its bundled local corpus. You can still request
web resources per call:

```bash
aiwg discover "architecture evolution" --resource-source web
```

## Versioning and Releases

`@aiwg/cli` follows the exact version of the main AIWG release:

```text
aiwg@2026.7.19
@aiwg/cli@2026.7.19
@aiwg/cockpit@2026.7.19
```

Stable releases use npm's `latest` tag. Pre-release channels may use `next` or
another documented release tag. Historical package versions remain
installable by exact CalVer:

```bash
npm install --global @aiwg/cli@2026.7.19
```

The npm package version and selected resource version are separate choices:

```bash
# Install a known CLI runtime.
npm install --global @aiwg/cli@2026.7.19

# Select signed resources for one command.
aiwg discover "architecture" --aiwg-version 2026.7.19
```

Compatibility metadata in newer signed manifests allows the CLI to fail
clearly when a resource release is known to be incompatible with the installed
runtime.

Release surfaces:

- [npm package](https://www.npmjs.com/package/@aiwg/cli)
- [GitHub releases](https://github.com/jmagly/aiwg/releases)
- [signed resource host](https://releases.aiwg.io/)
- [release announcements](https://github.com/jmagly/aiwg/tree/main/docs/releases)

## Development

`@aiwg/cli` is built from the main AIWG repository. It is not maintained as an
independent source fork.

```bash
git clone https://github.com/jmagly/aiwg.git
cd aiwg
npm ci
npm run build:cli
npm run package:cli
```

The staged package is written to:

```text
dist/packages/cli/
```

Inspect the exact tarball:

```bash
npm pack ./dist/packages/cli --dry-run
```

Relevant validation:

```bash
npm run check:versions
npm run build:cli
npm run package:cli
npx vitest run --config config/vitest.config.js \
  test/integration/cli-package-webmode.test.ts
```

Package invariants include:

- CalVer lockstep with `aiwg`;
- runtime dependency lockstep with `aiwg`;
- no bundled `agentic/`, `docs/`, templates, tools, or application trees;
- executable, license, API declarations, provider metadata, and this dedicated
  README present in the tarball;
- configuration-free signed web discovery and `show`;
- warm offline behavior;
- bounded package size.

## Documentation

- [Complete AIWG CLI reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md)
- [AIWG documentation](https://docs.aiwg.io/)
- [AIWG project README](https://github.com/jmagly/aiwg#readme)
- [Web-backed resources guide](https://github.com/jmagly/aiwg/blob/main/docs/install/web-backed-resources.md)
- [Release verification](https://github.com/jmagly/aiwg/blob/main/docs/releases/verifying.md)
- [Supply-chain overview](https://github.com/jmagly/aiwg/blob/main/docs/security/supply-chain-overview.md)
- [Agentic install runbook](https://github.com/jmagly/aiwg/blob/main/docs/agentic-install-runbook.md)

## Community and Support

- [GitHub issues](https://github.com/jmagly/aiwg/issues)
- [Discussions](https://github.com/jmagly/aiwg/discussions)
- [Discord](https://discord.gg/BuAusFMxdA)
- [Telegram](https://t.me/+oJg9w2lE6A5lOGFh)
- [AIWG website](https://aiwg.io)

For a security vulnerability, follow
[`SECURITY.md`](https://github.com/jmagly/aiwg/blob/main/SECURITY.md) rather than
opening a public issue.

## License

AIWG-authored code is MIT licensed. See the
[AIWG license](https://github.com/jmagly/aiwg/blob/main/LICENSE).

Runtime dependencies retain their own licenses. Every published tarball
includes `LICENSE` and `THIRD_PARTY_NOTICES.md`; the latter identifies the
reviewed Fortemi and Bytecask AGPL boundary, corresponding source links, and
commands for inspecting the versions npm resolved.
