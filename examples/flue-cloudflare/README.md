# Flue Cloudflare example

Ask your coding assistant:

> Add AIWG to my Cloudflare Flue app using the package imports. Mount the SDLC
> quickref and Code Reviewer, connect remote AIWG tools through Worker bindings,
> and keep conversation state in Durable Object SQLite.

Copy this directory into your project. Run **`aiwg use sdlc --provider flue
--package` first**, from the copied directory. Generated skills, context, tools
and specialists are deliberately absent. The app imports a packaged skill and
specialist and the generated remote connection; it requires no local MCP child.
The first `@aiwg/flue` publication requires operator bootstrap; maintainers test
the locally packed package before publication.

```sh
aiwg use sdlc --provider flue --package
npm ci
npm run dev
```

Verified toolchain: `@flue/cli`, `@flue/runtime`, `@flue/vite` **2.3.0**,
`@cloudflare/vite-plugin` **1.65.0**, Wrangler **4.152.0** (workerd
**1.20261019.1**), Vite **8.3.5**, Hono **4.13.13**, Node **24**.
The lockfile was generated offline from the pinned lab graph and local AIWG
package metadata; publication integrity for `@aiwg/flue` is pending bootstrap.
No dependency installation is part of the emulation suite.

Start the [dedicated MCP listener](../../docs/providers/flue-remote.md) bound to
one project. Put `AIWG_MCP_URL` and `AIWG_MCP_TOKEN` in a local **`.dev.vars`**
file, which is ignored by git. For local emulation, the URL can be
`http://127.0.0.1:3100/mcp`; supply the generated listener token privately.
Set `FLUE_MODEL` and the model provider's bindings there for an interactive run.
The example defaults to `openrouter/anthropic/claude-haiku-4.5`; the tests replace
it with a keyless scripted model and make no model service calls.
Never commit `.dev.vars`, embed tokens in source, or put them in command arguments.

Then ask the running app:

> Review `export const add = (a, b) => a - b;`. Discover sdlc-quickref, show its
> governing rules, activate it, delegate to code-reviewer, and save the findings
> at reviews/cloudflare.md through the remote artifact-write tool.

The app exposes `/agents/assistant`. Reuse the same conversation id for a
follow-up. Artifacts belong to the MCP server's bound project, for example
`.aiwg/reviews/cloudflare.md`. The Worker uses no local artifact filesystem.
`vite dev` runs in workerd; `.wrangler/` holds local Durable Object state.

```sh
npm run build
npm run preview
```

`flue()` must precede `cloudflare({ config: flueWorkerConfig() })`. No `db.ts`
is generated: each agent's Durable Object owns its SQLite state. The
`aiwg-assistant` `agentName` pin preserves storage identity across function
renames. Add agents with append-only `new_sqlite_classes` migrations; changing
an existing identity requires a rename or deletion migration. `nodejs_compat`
and a compatibility date are required.

Emulation qualification covers build, packaged skill listing/activation,
specialist delegation, remote discovery/show/write, restart/resume, abort and
invalid-token failure. Deployed validation is **pending an operator token**;
this round performs no Cloudflare deployment. Active CPU limits on Cloudflare
are 30 seconds per invocation by default; local wall timings do not qualify
that production quota. Stdio/process spawning and local filesystem tools are
unsupported here; neither Cloudflare Sandbox nor Computer is configured.
Resources, prompts and elicitation are not adapted by Flue's MCP tool client.

Maintainers run the release-slow suite against a pre-provisioned locked lab:

```sh
AIWG_FLUE_CF_DEPENDENCIES=/path/to/flue-lab-cf \
  nice -n 19 npm run test:release-slow -- flue-cloudflare-e2e
```

The suite packs `@aiwg/flue`, copies dependencies and this example into
`os.tmpdir()` + `mkdtemp`, generates `.dev.vars` and a D9 token, and restarts
workerd with the same local state. It skips only when that variable is unset;
an invalid or incompatible provisioned graph fails. All HOME/config/state paths
are temporary. See the [Flue guide](../../docs/providers/flue.md).
