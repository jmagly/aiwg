# Flue (experimental)

The Flue provider targets Node apps using Flue 2.3.0. It deploys kernel skills
into `.agents/skills`, composes WORKSPACE.md and AIWG.md into cwd `AGENTS.md`
with inline core rules, and supplies a conventional `db.ts` selecting SQLite at
`.flue-state/state.db` relative to the project root, regardless of the process
working directory. It adds `.flue-state/` to `.gitignore` and writes
`src/aiwg/tools.ts` plus `src/aiwg/specialists.ts`.

```sh
aiwg use sdlc --provider flue --scope project
aiwg remove sdlc
```

Operator content outside the AIWG context markers survives redeployment.
Existing database modules are reported and preserved, including `db.ts`.
Review an existing module to ensure it selects durable storage. Generated files
have ownership receipts; removal restores their verified original bytes and
preserves files edited after deployment.

Flue discovers `db.ts` in `.flue/`, then `src/`, then the project root. AIWG
uses `.flue/` when present, otherwise `src/`, which the generated modules
establish in an empty project, without evaluating application configuration.
For an existing root-level app/database, configure explicit `app`/`db` entry
paths before adding `src/`, or move the operator modules into `src/`.
If the app sets an explicit `db` path in `flue.config.ts`, keep that operator
module and review its storage setting. State stays outside `.flue/` because
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
State is app-owned and survives `aiwg remove`.

The generated tools expose discovery, governing-rule drill-ins and contained
artifact writes through the in-process MCP stdio client. The specialists are
exactly **Code Reviewer** and **Test Engineer**, generated from canonical
sdlc-complete agent bodies with the shared bound-rule transform. Each mounts
only those three AIWG tools. The fixed exported `FLUE_SPECIALISTS` list in
`tools/agents/providers/flue-specialists.mjs` owns this roster.

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
