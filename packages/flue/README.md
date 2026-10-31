# @aiwg/flue

> Add SDLC skills and a Code Reviewer to my Flue app using package imports.
> Use my app model and show which tool import is needed if a capability is missing.

MIT bundle skills, specialist factories and remote/Node MCP helpers for Flue
2.3.x. Peers are `@flue/runtime: 2.3.x`, `@modelcontextprotocol/client: 2.0.0`,
and `valibot: ^1.1.0`. Install alongside your own Flue toolchain.

```sh
npm install @aiwg/flue @flue/runtime@2.3.0 @modelcontextprotocol/client@2.0.0 'valibot@^1.1.0'
aiwg use sdlc --provider flue --package
```

```ts
import quickref from '@aiwg/flue/skills/sdlc-quickref/SKILL.md';
import { codeReviewer } from '@aiwg/flue/specialists';
import { createAiwgTools } from '@aiwg/flue/tools/node';
import { createAiwgConnection } from '@aiwg/flue/tools';
```

Pass `{ model, tools: Object.values(createAiwgTools()) }` or
`{ model, connection: createAiwgConnection({ url, token }) }` to `codeReviewer`.
Use Flue's `useSkill` and `useSubagent` hooks to mount the results. The specialist
mounts those tools in its own render. Omitting `model` inherits the app model.

The package ships no third-party code. Node tools reuse the canonical AIWG
stdio adapter and import the declared MCP client and Valibot peers directly. Install
the `aiwg` CLI separately. Remote tools require an authenticated project-bound
HTTP server; no Node built-ins are imported by the remote export.

[Full setup and package-mode guide](https://github.com/jmagly/aiwg/blob/main/docs/providers/flue.md)
