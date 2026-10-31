# Flue (experimental)

The Flue provider targets Node apps using Flue 2.3.0. It deploys kernel skills
into `.agents/skills`, composes WORKSPACE.md and AIWG.md into cwd `AGENTS.md`
with inline core rules, and supplies a conventional `db.ts` selecting SQLite at
`.flue-state/state.db` relative to the project root, regardless of the process
working directory. It adds `.flue-state/` to `.gitignore`.

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
uses the existing source layout without evaluating application configuration.
If the app sets an explicit `db` path in `flue.config.ts`, keep that operator
module and review its storage setting. State stays outside `.flue/` because
Flue treats that directory as a source root ahead of `src/`. Deployment preserves
source discovery and does not start the app or create the database directory.

Run only one live owner per conversation on Node. SQLite survives process
restarts on the same host; runtime recovery and abort behavior belong to the
separate Flue runtime slice. This deployment does not install tools, delegates,
a sandbox, approval hooks, or MCP transport. Flue is an app target and has no
AIWG worker CLI registration. User scope is unsupported.

The installed 2.3.0 contracts are `@flue/runtime/docs/guide/database.md`,
`@flue/runtime/dist/config.mjs` (source and entry discovery), and the skill
frontmatter parser in `@flue/runtime/dist/result-e-IUH4HT.mjs`. Skill names must
match their directory, use lowercase alphanumeric segments separated by single
hyphens, and be at most 64 characters. Descriptions must be nonempty and at
most 1024 characters. AIWG uses its existing skill copy and platform transforms.
