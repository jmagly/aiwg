# @aiwg/flue

> Add SDLC skills and a Code Reviewer to my Flue app using package imports.
> Use my app model and show which tool import is needed if a capability is missing.

MIT bundle skills, specialist factories and remote/Node MCP helpers for Flue
2.3.x. Peers are `@flue/runtime: 2.3.x`, `@modelcontextprotocol/client: 2.3.0`,
`valibot: ^1.1.0`, and `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`
at `~1.4.0`. Flue 2.3.0 does not load with pi 1.5.0, so the pi peers keep a fresh
install on 1.4.x. Install alongside your own Flue toolchain.

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
Call a remote specialist factory inside the root agent render: it prepares
the remote tools in `useAgentStart`, then mounts adapted definitions in the
delegate, since Flue rejects subagent `useMcpConnection` calls. Connections
close on `useAgentFinish` or cancellation. Custom finish-hook continuations
with remote specialists are unsupported in this slice.

The package ships no third-party code. Node tools reuse the canonical AIWG
stdio adapter and import the declared MCP client and Valibot peers directly. Install
the `aiwg` CLI separately. Remote tools require an authenticated project-bound
HTTP server; no Node built-ins are imported by the remote export.

[Full setup and package-mode guide](https://github.com/jmagly/aiwg/blob/main/docs/providers/flue.md)
