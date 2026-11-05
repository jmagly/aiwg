# Flue (experimental)

Ask your coding assistant:

> Add only the SDLC framework and the voice framework to my Flue app.

Then give the running Flue app a concrete task:

> Review this change: `export const add = (a, b) => a - b;`. Discover the AIWG
> SDLC quickref, show its governing rules, activate the skill, ask Code Reviewer
> to assess the change, and save the review at reviews/example.md.

Start with the [Node example](../../examples/flue-node/README.md), or ask your
assistant to add the same imports to an existing app. From the app directory:

```sh
aiwg use sdlc --provider flue --declare
aiwg use voice-framework --provider flue --declare
aiwg refresh
```

Deploy AIWG before starting the example: generated modules and skills are
deliberately absent from its source. For the example, then run `npm ci` and
`npm run dev`. Set `FLUE_MODEL` in the environment to choose a model; its default
is `openrouter/anthropic/claude-haiku-4.5`. Supply model credentials through your
environment. AIWG does not store them.

Verified versions: **Flue 2.3.0, Pi 1.4.0, Node >= 22.19.0**. The example
lockfile preserves the tested dependency graph. Use Node 24 when also running
the AIWG CLI, which requires Node >= 24.

| Supported in this slice | Outside this slice |
|---|---|
| Node app target; Cloudflare (local emulation and one manual deployed run) | Cloudflare Sandbox and Containers |
| `aiwg_discover`, `aiwg_show`, `aiwg_artifact_write` and [remote MCP](flue-remote.md) | Multi-tenant MCP hosting |
| Manifest-selected specialists and package imports | Sandboxes and approval hooks |
| Explicitly mounted AIWG skills and SQLite state | User scope |

The example explicitly mounts the deployed `sdlc-quickref` with `useSkill`.
Flue's automatic workspace skill discovery requires a sandbox; this example
uses no sandbox. Its tools and specialists are ordinary app imports.

For Node apps using Flue 2.3.0, the provider deploys each selected bundle’s full skill set
into `.agents/skills`, composes WORKSPACE.md and AIWG.md into cwd `AGENTS.md`
with inline core rules, and supplies a conventional `db.ts` selecting SQLite at
`.flue-state/state.db` relative to the project root, regardless of the process
working directory. It adds `.flue-state/` to `.gitignore` and writes
`src/aiwg/tools.ts`, `src/aiwg/skills.ts` and `src/aiwg/specialists.ts`.
`aiwg-utils` is opt-in for Flue; framework deployments do not include addons.
Bundle manifests select specialists (SDLC supplies Code Reviewer and Test Engineer).
The skill module exports each skill, a bundle array such as `sdlcSkills` or
`voiceFrameworkSkills`, and `useAiwgSkills(...bundles)` to mount those arrays.

The commands above declare intent in `installed.<bundle>.deployedTo.flue`.
A pending entry is `{ "deployedTo": { "flue": {} } }`. Refresh and update deploy
only the providers declared for each bundle. Drop an entry by hand, or run
`aiwg remove voice-framework --provider flue --declare`, then refresh to prune
its unchanged files in index mode (the default). `--copy-all` (also accepted
with `--declare`) records `copy: true` for that bundle and provider; update and
refresh retain that mode and update unchanged copies in place. Dropped bundles
are kept in copy mode; run `aiwg remove <bundle>` to delete them. A later
`aiwg use` without the flag records index mode. Operator edits are kept and
reported in both modes. Use `--dry-run`
on update or refresh to review the per-provider add and remove plan. Ordinary
bundle removal regenerates shared imports for the remaining deployed bundles.
Reviewed resident memory stays in its maintained `WORKSPACE.md` projection;
it is excluded from the inline `AGENTS.md` copy.

```sh
aiwg use sdlc --provider flue --scope project
aiwg remove sdlc
```

## Package mode

> Add the SDLC and voice bundles to this Flue app using `@aiwg/flue` package
> imports. Keep the skills out of the project tree, and preserve that choice
> when I update or refresh AIWG.

> Mount the SDLC quickref and Code Reviewer. Use the model selected by this app
> and the local AIWG tools. Tell me which tool import is missing if setup is incomplete.

Install `@aiwg/flue` alongside your app's `@flue/runtime@2.3.0` and Flue build
plugin. The MIT package declares peers `@flue/runtime: 2.3.x`,
`@modelcontextprotocol/client: 2.3.0`, `valibot: ^1.1.0`, and
`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at `~1.4.0`.
Flue 2.3.0 fails to load with pi 1.5.0 (`does not provide an export named
'Type'`), so the pi peers keep a fresh install on 1.4.x. Vite and
other build dependencies belong to the app. The first npm publication requires
an operator bootstrap; later releases follow the normal trusted publishing path.

Add these overrides to your app's `package.json` before installing:

```json
{
  "overrides": {
    "@modelcontextprotocol/client": "$@modelcontextprotocol/client",
    "@modelcontextprotocol/sdk": "1.32.0",
    "@modelcontextprotocol/server": "2.3.0"
  }
}
```

Flue 2.3.0 still pins the older client, which has a published denial-of-service advisory.

```sh
npm install @aiwg/flue @flue/runtime@2.3.0 @modelcontextprotocol/client@2.3.0 'valibot@^1.1.0'
aiwg use sdlc --provider flue --package
aiwg use voice-framework --provider flue --package
```

These commands run headlessly. `src/aiwg/skills.ts` uses static imports such as
`@aiwg/flue/skills/sdlc-quickref/SKILL.md` and exports the same per-skill values,
bundle arrays and mounting helper as copy mode. No skill files are copied.
On Node, generated `tools.ts` re-exports `@aiwg/flue/tools/node`, so app modules use
the peer-owned Node adapters rather than importing adapter dependencies directly.
`installed.<bundle>.deployedTo.flue.package: true` retains package mode through
`aiwg update` and `aiwg refresh`; `--declare --package` also supports pending intent.
Only framework and eligible addon skills are published. Project-local bundles
and extensions use workspace copies. A shared skill name uses the first canonical
framework in inventory order (frameworks precede addons).

Apps can import directly too:

```ts
import { useModel, useSkill, useSubagent, useTool } from '@flue/runtime';
import quickref from '@aiwg/flue/skills/sdlc-quickref/SKILL.md';
import { codeReviewer, sdlcSpecialists } from '@aiwg/flue/specialists';
import { createAiwgTools } from '@aiwg/flue/tools/node';

export function Assistant() {
  const model = process.env.FLUE_MODEL!;
  useModel(model);
  const tools = Object.values(createAiwgTools());
  for (const tool of tools) useTool(tool);
  useSkill(quickref);
  useSubagent(codeReviewer({ model, tools }));
  // Or mount every specialist in the selected bundle:
  // for (const specialist of sdlcSpecialists({ model, tools })) useSubagent(specialist);
  return 'Review the supplied change using the SDLC rules.';
}
```

Factories bind the actual tools the delegate mounts. Missing capabilities throw
before mounting and name both the missing tool and the supplying export.
The package contains no model IDs; omitting `model` inherits the app model.
The Node export reuses the workspace tools template and resolves its adapters
from Flue 2.3.x's own dependency graph, including nested dependency layouts.
It requires a separately installed `aiwg` executable for stdio calls.

For remote tools use `createAiwgConnection({ url, token })` from
`@aiwg/flue/tools`, mount it with `useMcpConnection(connection)`, and pass
`{ model, connection }` to the specialist factory. The helper accepts a token
resolver for rotation. Its explicit default tools are `discover`, `skill-show`
and `artifact-write`; adapted names are `mcp__aiwg__discover`,
`mcp__aiwg__skill-show` and `mcp__aiwg__artifact-write`.
The remote helper has no Node imports. See [remote setup](flue-remote.md).
See the Cloudflare target below for Worker bindings and emulation qualification.

Call remote specialist factories inside the root agent render. Flue 2.3.0
rejects `useMcpConnection` inside subagents, so the factory prepares adapted
tools with `createMcpConnection` in root `useAgentStart` hooks, mounts those
definitions in the delegate, and closes on `useAgentFinish` or cancellation.
Delivery-scoped bindings survive rerenders and isolate conversations.
Custom finish-hook continuations with remote specialists are unsupported in
this slice; normal completion, follow-up submissions, and abort are qualified.

## Cloudflare target

> Add AIWG to my Cloudflare Flue app using package mode. Mount the SDLC
> quickref and Code Reviewer. Use Worker bindings for the remote AIWG URL and
> token, and save artifacts in the remote server's bound project.

> Run the Cloudflare example locally in workerd. Verify skill activation,
> specialist delegation, remote discovery/show/write, restart/resume and abort.

Start with the [Cloudflare example](../../examples/flue-cloudflare/README.md).
Declare `target: 'cloudflare'` in `flue.config.*`, then run from its copy:

```sh
aiwg use sdlc --provider flue --package
npm ci
npm run dev
npm run build
```

| Target | Support | Deployed result |
|---|---|---|
| Node | Supported; SQLite, local stdio or remote tools | Existing Node runtime coverage |
| Cloudflare | Emulation-qualified in workerd; validated by one manual deployed run | 7/7 cases on Cloudflare (2026-11-01, manual run) |

The static config declaration switches AIWG generation: no `db.ts`, no stdio
tools, and `src/aiwg/tools.ts` exposes `aiwgConnection()`. Call it inside the
agent render and mount the returned connection with `useMcpConnection`.
Package mode uses `@aiwg/flue/tools`; copy mode generates an equivalent portable
connection. Both read `AIWG_MCP_URL` and `AIWG_MCP_TOKEN` from Worker bindings via
`getCloudflareContext()`, with an explicit error if either binding is absent.
A bare `wrangler.jsonc` prints a warning and retains Node generation.

The [remote setup guide](flue-remote.md) owns listener authentication and project
binding. Local tests generate an ignored `.dev.vars` file with a random token.
The Worker never writes AIWG artifacts locally. Keep `nodejs_compat`, a
compatibility date, `new_sqlite_classes` migrations and a pinned `agentName` as
shown in the example. Durable Object SQLite holds conversation state. Flue's
Vite plugin precedes `cloudflare({ config: flueWorkerConfig() })`.

**Emulation:** the release-slow suite uses the locked Cloudflare example and a local
scripted model. It checks build, packaged skill import/listing/activation,
specialist execution, exact remote results and artifact placement, process
restart/resume of the same Durable Object conversation, mid-run abort, and
clear wrong-token failure. Provision the example before running; missing dependencies
fail with a provisioning command:

```sh
npm ci --prefix examples/flue-cloudflare --no-audit --no-fund
NO_UPDATE_NOTIFIER=1 nice -n 19 npm run test:release-slow -- flue-cloudflare-e2e
```

`AIWG_FLUE_CF_DEPENDENCIES` can instead name a provisioned locked project;
the suite resolves its `node_modules`. Both paths use temporary HOME/config/state,
a 60 s workerd startup cap, and 300 s lifecycle tests for slower hosted runners.

**Deployed validation (2026-11-01, one manual run on titan):** 7/7 cases passed
against a real Worker on `workers.dev` with `@flue/runtime` 2.3.0, Wrangler
4.152.0 and workerd 1.20261019.1: build, packaged skill, specialist, remote
discover/show/write into the D9 project, restart/resume by redeploy, abort and
wrong token. The Worker served 47 invocations, all `ok`, with at most 17 ms CPU
each (median 1 ms) and at most 6.2 s wall time. Teardown deleted the Worker and
closed the tunnel. Emulation and deployed results are separate checks.

Deployed specifics found by this run:
- The quick tunnel forwards a public Host header; the check passes
  `--http-host-header 127.0.0.1:<port>` so the D9 listener's Host/Origin guard
  stays unchanged. A real deployment should instead start
  `aiwg mcp serve --transport http` with `--allowed-host <public hostname>`.
- Deployed settlements report only `internal_error`; the cause (for example
  `Server returned 401`) is in the Worker log for the same submission id
  (`wrangler tail`).
- A secret rotation reaches the edge gradually and live Durable Objects can keep
  the previous version, so the check waits until fresh objects run the new version.

The deployed counterpart is **manual only and never automatic**. It is excluded
from default/release-slow selection, workflows and `cut-tag.sh`. Its dedicated
`config/vitest.flue-cloudflare-deployed.config.js` is registered only as an
unavailable manual config, following the live UAT convention. Only the explicit
npm script starts it; the script and config both refuse without all three inputs.

Prerequisites: built AIWG CLI, the provisioned locked Cloudflare example (or
`AIWG_FLUE_CF_DEPENDENCIES` pointing at its dependencies), `cloudflared` on PATH
(or `AIWG_CLOUDFLARED` naming its executable), Cloudflare account ID, and an API
token with **Account › Workers Scripts Edit** plus **Account Settings Read**.
Supply credentials through the operator's environment; never put them in the
repository or command arguments. With `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` already exported, explicitly authorize one run:

```sh
AIWG_FLUE_CF_DEPLOY=1 NO_UPDATE_NOTIFIER=1 nice -n 19 npm run test:flue-cloudflare-deployed
```

The check copies the app and packed `@aiwg/flue` into temporary directories,
uses package mode and the same keyless scripted model as local workerd tests,
starts a token-protected D9 HTTP listener bound to a temporary project on
127.0.0.1, and exposes it through a bounded-wait `cloudflared` quick tunnel.
It uses the example's Wrangler with a random `aiwg-flue-check-<random>` name.
`AIWG_MCP_URL` and `AIWG_MCP_TOKEN` are set only with `wrangler secret put` via
stdin. Captured diagnostics are redacted and Wrangler disk logging is disabled.

All seven local cases are shared with the deployed suite. For restart/resume
and persisted abort, the deployed check **redeploys the same built script under
the same Worker name**; it cannot restart a remote workerd process. No case is
skipped. This checks state across deployment, rather than an operator-controlled
remote process restart.

Teardown runs on failure and SIGINT/SIGTERM: delete the Worker, stop the tunnel
and server, and remove app/server temporary directories. A teardown summary
prints an exact manual cleanup command if deletion fails. A separate temporary
results directory is intentionally retained: its printed `results.json` records
per-case pass/fail, timings, versions, the restart method and cleanup outcomes,
without secrets. Cases blocked by setup/interruption are recorded as failures
with a reason. Retain that JSON when recording an actual deployed result, then
remove the results directory when finished.

Local timings do not establish compliance with Cloudflare's default 30 s
active-CPU budget per invocation; the deployed run above measured at most 17 ms. Workers cannot spawn stdio children.
Filesystem tools require Cloudflare Sandbox or Computer; this example uses
neither. Flue's remote adapter supplies tools only, without MCP resources,
prompts or elicitation. No Cloudflare account is needed for these local tests.

## Node state and ownership

Operator content outside the AIWG context markers survives redeployment.
Existing database modules are reported and preserved, including `db.ts`.
Review an existing module to ensure it selects durable storage. Generated files
have ownership receipts; removal restores their verified original bytes and
preserves files edited after deployment.

The existing provider transformation-receipt schema also exposes
`#/$defs/deploymentManifest` for `.aiwg-manifest.json` ownership sidecars.
It validates optional `managed[*].filePreimage` snapshots while accepting
legacy entries without snapshots; transformation receipts retain their shape.

Flue discovers `db.ts` in `.flue/`, then `src/`, then the project root. AIWG
uses `.flue/` when present, otherwise `src/`, which the generated modules
establish in an empty project, without evaluating application configuration.
For an existing root-level app/database, configure explicit `app`/`db` entry
paths before adding `src/`, or move the operator modules into `src/`.
If a static top-level `db:` property appears in the selected `flue.config.*`, AIWG warns and leaves
database generation and ignore rules to the operator. It reads the config as
text without evaluating it; review that module's storage setting. The first
existing config wins in `.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, `.cts` order,
matching Flue 2.3.0's `@flue/runtime/dist/config.mjs:91–98,106–117`.
State stays outside `.flue/` because
Flue treats that directory as a source root ahead of `src/`. Apps already using
`src/` or `.flue/` retain source discovery. Deployment does not start the app
or create the database directory.

Run only one live owner per conversation on Node. SQLite survives process
restarts on the same host. Reuse the same agent identity and conversation id
with `init(Agent, { id })`; `read(receipt)` reattaches to a durable result.
`handle.abort()` requests durable cancellation; cancelling a read only stops
observation. An aborted tool acknowledgement can leave an external effect in
place: read the effect back and reconcile before retrying. Submission leases
fence competing claims; this is not support for active-active app owners.
The smoke dispatches from a second process on the same conversation and checks
that its submission stays queued without an owner or model call while the
original lease remains live. Flue 2.3.0 admits and wakes dispatches in
`@flue/runtime/dist/builtin-providers-C5FpT9g1.mjs:1288–1323`; the same-session
ordering guard is `@flue/runtime/dist/sql-agent-execution-store-LqbFqydc.mjs:455–473`.
Rival admission can also replace the conversation producer and fence the old
writer (`@flue/runtime/dist/conversation-stream-store-CXrgv-b0.mjs:5768–5795`).
The dispatch competition uses a separate disposable store from the abort and
reconciliation checks; it does not establish safe concurrent app ownership.
State is app-owned and survives `aiwg remove`.
Use a production Node build or `flue run` to check restart behavior; Vite's
development database is disposable. Keep the same project, agent identity,
conversation id and state database when restarting.

The generated tools expose discovery, governing-rule drill-ins and contained
artifact writes through the in-process MCP stdio client. The specialists are
exactly **Code Reviewer** and **Test Engineer**, generated from canonical
sdlc-complete agent bodies with the shared bound-rule transform. Each mounts
only those three AIWG tools. The fixed exported `FLUE_SPECIALISTS` list in
`tools/agents/providers/flue-specialists.mjs` owns this roster.

AIWG artifacts land in the project's AIWG artifact store (`.aiwg/`), for example `.aiwg/reviews/example.md`, rather than the project root.

Mount them in an app agent after its `useModel` declaration:

```ts
import { useAiwgSpecialists } from './aiwg/specialists.ts';

// Inside the app agent: inherit the app model and effort.
useAiwgSpecialists();
// Or provide a trusted operator model pin for one delegate:
// useAiwgSpecialists({ codeReviewer: 'provider/model' });
```

There is no new persisted configuration family. The exported `codeReviewer`
and `testEngineer` definitions can also be mounted individually with
`useSubagent`. Operator-edited modules are kept and reported on redeploy and
removal; unchanged generated modules refresh and are removed through receipts.
Use no `local()` sandbox for this slice: delegates inherit any parent sandbox.
Flue supplies no approval API; AIWG tools enforce their own artifact scope.
Flue is an app target with no AIWG worker CLI registration. User scope is
unsupported.

The installed 2.3.0 contracts are `@flue/runtime/docs/guide/database.md`,
`@flue/runtime/dist/config.mjs` (source and entry discovery), and the skill
frontmatter parser in `@flue/runtime/dist/result-e-IUH4HT.mjs`. Skill names must
match their directory, use lowercase alphanumeric segments separated by single
hyphens, and be at most 64 characters. Descriptions must be nonempty and at
most 1024 characters. AIWG uses its existing skill copy and platform transforms.

Offline runtime verification (no installs or model service):

```sh
TMPDIR=/var/tmp node tools/testing/flue-lab-smoke.mjs --lab /path/to/flue-lab
```

The runner copies only package manifests and dependencies, excluding `.cache`,
into `os.tmpdir()` + `mkdtemp`, then deploys the modules there. Independent
processes test both curated task delegates, transcript/id survival, a rival lease
claim, abort mid AIWG tool,
restart reconciliation without replay, and absence of `node_modules/.cache`.
The synthetic MCP effect writes before acknowledgement, making cancellation's
uncertain effect observable. The original lab and model environment stay untouched.

Fake-provider injection is verified against installed executable source:
`@flue/runtime/dist/providers-DfEK_EsA.mjs:11–23` accepts a Pi provider via
`setProvider`; `@earendil-works/pi-ai/dist/providers/faux.js:482–494` builds the
keyless scripted provider using `createProvider` with local stream functions.
`@flue/runtime/dist/node/index.mjs:392–405` accepts an explicit provider list;
the smoke calls `setProvider(fake.provider)` and `start({ providers: [] })`
to avoid registering external providers. Lease claims are guarded by SQL in
`@flue/runtime/dist/sql-agent-execution-store-LqbFqydc.mjs:455–473`.
These are Flue 2.3.0 / Pi 1.4.0 contracts; keep the lab lockfile when testing.

The example's offline end-to-end test is in the release-slow lane. Provision
`examples/flue-node` dependencies with `npm ci --prefix examples/flue-node`
before running it, or point
`AIWG_FLUE_DEPENDENCIES` at an existing locked project. It copies dependencies
into a temporary project, uses `setProvider` with Pi's keyless scripted provider,
and runs public deploy/remove, skill activation, delegation, artifact writing,
restart, abort, effect reconciliation, and the shared durability checks (including
owner and dispatch fencing and absence of `node_modules/.cache`) without a model service.
For the complete release-slow lane, also provision `examples/flue-cloudflare`
with `npm ci --prefix examples/flue-cloudflare --no-audit --no-fund`:

```sh
TMPDIR=/var/tmp npm run test:release-slow -- flue-node-e2e
```
