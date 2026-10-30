# Flue tools (2.3.0)

The provider deploy can copy `templates/aiwg/tools.ts` to the app's `src/aiwg/tools.ts`; `AIWG_TOOL_NAMES` lists its three tools for deployment consumers (#3121).

```ts
import { useTool } from '@flue/runtime';
import { aiwg_discover, aiwg_show, aiwg_artifact_write } from './aiwg/tools';

// Inside the app's agent or specialist function:
useTool(aiwg_discover);
useTool(aiwg_show);
useTool(aiwg_artifact_write);
```

The default tools run the installed `aiwg mcp serve` in the app's launch directory.
For another trusted project or executable, call `createAiwgTools({ cwd, command, args, env })`
at app setup and mount the returned tools. Configuration belongs to the app,
never to model tool inputs. The app needs AIWG installed on PATH, Node 24+, and
the tested Flue 2.3.0 graph: Valibot, `@modelcontextprotocol/client` 2.0.0 and
its `/stdio` export. These are already present in the pinned lab graph; AIWG
does not install dependencies or provide model credentials.

Each call owns a stdio child and closes it on success or failure. The child
inherits the SDK's safe process settings plus AIWG root/path settings; optional
subsystem toolsets are disabled. No HTTP listener, gateway, `local()` sandbox,
approval bridge or model invocation is involved. Artifact writes go through
AIWG's `artifact-write`; the server resolves the project's configured artifact
root, pins it and enforces containment. The caller cannot set `project_dir`.
This scope applies to these tools; other app code retains its own host access.

`aiwg_show` supports the four MCP card tools: skill, agent, command and rule.
It always fetches governing rule summaries and bodies, and maps an optional
single heading to MCP's section array. Discovery retains all eight MCP asset
types. Its `query` maps to `discover.phrase`; the MCP default limit remains in
effect. Schema parity compares those public projections with live `tools/list`
schemas; fixed arguments and the omitted project selector remain server-owned.

Transport decision (#3123/#3124): the SDK stdio client works. Flue's documented
trusted-code route (`@flue/runtime/dist/index.mjs:744-750`) calls `new URL` and
constructs its own HTTP/SSE transport (`dist/mcp-CYraeuuF.mjs:44-56,114-125`).
The spike supplies both stdio and a custom transport with a throwing fetch;
both reach the HTTP fetch instead of a custom transport. The SDK connects to
the existing `src/mcp/server.mjs` over stdio and directly calls all three tools.
SDK evidence: `@modelcontextprotocol/client/package.json` exports `./stdio`;
`dist/stdio.mjs:48-81` spawns the child with stdin/stdout pipes. No gateway is
needed. Sources are the installed Flue 2.3.0 lab, checked in a temporary copy.

Run the reproducible smoke without reading lab environment files or state:

```sh
TMPDIR=/var/tmp node tools/testing/flue-lab-smoke.mjs --lab /path/to/flue-lab
```

It copies only the lab's package manifests and installed dependencies into
`os.tmpdir()` and deletes the copy afterward. It loads the actual TypeScript
template in Node, checks actual Valibot/MCP parity, and calls the tool functions
against a synthetic discovery CLI and the real AIWG MCP artifact server.
The default unit lane uses small Flue/Valibot builder doubles and the repository's
SDK 1.x client shim, keeping optional app dependencies out of AIWG itself;
the lab smoke verifies the full real Flue/Valibot/SDK 2.x boundary.
