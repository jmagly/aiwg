# Flue (experimental)

Ask your coding assistant:

> Add AIWG to my Flue app and give it a code reviewer. Keep conversation state
> across restarts and save the review as an artifact.

Then give the running Flue app a concrete task:

> Review this change: `export const add = (a, b) => a - b;`. Discover the AIWG
> SDLC quickref, show its governing rules, activate the skill, ask Code Reviewer
> to assess the change, and save the review at reviews/example.md.

Start with the [Node example](../../examples/flue-node/README.md), or ask your
assistant to add the same imports to an existing app. From the app directory:

```sh
aiwg use sdlc --provider flue
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
| Node app target | Cloudflare |
| `aiwg_discover`, `aiwg_show`, `aiwg_artifact_write` | A network MCP gateway |
| Code Reviewer and Test Engineer | Sandboxes and approval hooks |
| Explicitly mounted AIWG skills and SQLite state | User scope and the `@aiwg/flue` package import |

The example explicitly mounts the deployed `sdlc-quickref` with `useSkill`.
Flue's automatic workspace skill discovery requires a sandbox; this example
uses no sandbox. Its tools and specialists are ordinary app imports.

The Flue provider targets Node apps using Flue 2.3.0. It deploys kernel skills
into `.agents/skills`, composes WORKSPACE.md and AIWG.md into cwd `AGENTS.md`
with inline core rules, and supplies a conventional `db.ts` selecting SQLite at
`.flue-state/state.db` relative to the project root, regardless of the process
working directory. It adds `.flue-state/` to `.gitignore` and writes
`src/aiwg/tools.ts` plus `src/aiwg/specialists.ts`.
Reviewed resident memory stays in its maintained `WORKSPACE.md` projection;
it is excluded from the inline `AGENTS.md` copy.

```sh
aiwg use sdlc --provider flue --scope project
aiwg remove sdlc
```

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
`examples/flue-node` dependencies from its lockfile before running it, or point
`AIWG_FLUE_DEPENDENCIES` at an existing locked project. It copies dependencies
into a temporary project, uses `setProvider` with Pi's keyless scripted provider,
and runs public deploy/remove, skill activation, delegation, artifact writing,
restart, abort, effect reconciliation, and the shared durability checks (including
owner and dispatch fencing and absence of `node_modules/.cache`) without a model service:

```sh
TMPDIR=/var/tmp npm run test:release-slow -- flue-node-e2e
```
