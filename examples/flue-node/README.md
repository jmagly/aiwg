# Flue Node example

Ask your coding assistant:

> Add AIWG to my Flue app and give it a code reviewer. Use this Node example,
> keep conversation state across restarts, and save the review as an artifact.

Copy this directory into your own project. The same agent supports **copy mode
and package mode**. Deploy AIWG from the copied directory before starting the
app; generated skills, context, database module, tools, and specialists are
deliberately absent. For copy mode:

```sh
aiwg use sdlc --provider flue
npm ci
npm run dev
```

For package mode, install the locked toolchain first, then add `@aiwg/flue`
matching `aiwg --version` (replace `<aiwg-version>`):

```sh
npm ci
npm install @aiwg/flue@<aiwg-version> @flue/runtime@2.3.0 @modelcontextprotocol/client@2.0.0 'valibot@^1.1.0'
aiwg use sdlc --provider flue --package
npm run dev
```

The agent imports `sdlcQuickref` from generated `src/aiwg/skills.ts`. Copy mode
uses a static import from `.agents/skills`; package mode uses
`import sdlcQuickref from '@aiwg/flue/skills/sdlc-quickref/SKILL.md';` without
creating local skill files. No agent edits are needed when switching modes.
See [package mode](../../docs/providers/flue.md#package-mode) for details.

Verified with Flue 2.3.0, Pi 1.4.0, and Node >= 22.19.0. The lockfile preserves
the tested lab graph. AIWG itself requires Node >= 24, so use Node 24 to run
both AIWG and this example. Keep AIWG on PATH for the tools' local MCP child.
Run the app from its project root. Provide your model provider's credentials
through your environment; no credential files are included. Set `FLUE_MODEL`
to change the default `openrouter/anthropic/claude-haiku-4.5`.

Then ask the running app:

> Review this change: `export const add = (a, b) => a - b;`. Discover the AIWG
> SDLC quickref, show its governing rules, activate it, ask Code Reviewer to
> assess the change, and save the review at reviews/example.md.

AIWG artifacts land in the project's AIWG artifact store (`.aiwg/`), for example `.aiwg/reviews/example.md`, rather than the project root.

The app exposes `/agents/assistant`. Reuse the same conversation id for a
follow-up. Production Node uses the deployed `src/db.ts` and
`.flue-state/state.db`. Keep one live owner per conversation. `vite` development
storage is disposable; use the production build or `flue run` for restart checks.

```sh
npm run build
npm start
# Or run one conversation locally (this makes a model call):
./node_modules/.bin/flue run src/agents/assistant.ts --id aiwg-review --message \
  'Review this change: export const add = (a, b) => a - b;. Discover sdlc-quickref, show its rules, activate it, delegate to code-reviewer, and write reviews/example.md with aiwg_artifact_write.'
```

`aiwg remove sdlc` removes unchanged generated files and keeps this example's
files and conversation state. Reinstall AIWG before running the app again.

This slice supports the Node target, three AIWG tools, Code Reviewer and Test
Engineer, and SQLite state. For Cloudflare and remote MCP, see the
[Cloudflare example](../flue-cloudflare/README.md). Sandboxes, approval hooks,
and user scope are outside this example.
See the [Flue guide](../../docs/providers/flue.md) for scope and cancellation.

Maintainers can run the real-runtime offline test after provisioning these
dependencies: `TMPDIR=/var/tmp npm run test:release-slow -- flue-node-e2e`.
It uses a scripted provider and never calls a model service.
