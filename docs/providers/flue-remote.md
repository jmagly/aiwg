# Connect my Flue app to AIWG on my build server

Run a dedicated AIWG MCP listener on the build server, bound to one project.
Flue connects by URL and mounts the tools you select. This uses Streamable HTTP;
stdio remains the default for local coding assistants.

## Setup

Use Node 24 or newer, an installed AIWG CLI, and Flue `@flue/runtime` 2.3.0.
Provision your project's artifact location before starting. The listener pins
`--project` and its configured artifact root at startup, including an external
root selected by `.aiwg-location` or the AIWG artifact environment settings.
An unavailable configured root refuses startup; there is no local fallback.

Generate a private token in your service environment, without putting its value
in command arguments or source code:

```bash
export AIWG_MCP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
aiwg mcp serve --transport http --project /srv/build/my-project \
  --token-env AIWG_MCP_TOKEN --port 3100
```

The endpoint is `http://127.0.0.1:3100/mcp`; `http://localhost:3100/mcp` is also
accepted on the default bind. For another machine, place a TLS
reverse proxy in front of it, preserve the Authorization and MCP session headers,
and allow the proxy's public hostname:

```bash
aiwg mcp serve --transport http --project /srv/build/my-project \
  --token-file /run/secrets/aiwg-mcp --allowed-host build.example.internal
```

Keep the file readable only by the service account. Supply exactly one of
`--token-env <NAME>` and `--token-file <path>`; the CLI accepts no token-value flag.
Loopback binds `127.0.0.1`, `::1` and `[::1]` need no remote-bind opt-in or warning.
Other bind addresses require `--allow-remote-bind` and emit a warning.
TLS termination and firewall configuration belong to the operator.
Use this dedicated listener for MCP; `aiwg serve` is the local dashboard.

## Flue client

In an agent's render function:

```ts
import { useMcpConnection } from '@flue/runtime';

const url = process.env.AIWG_MCP_URL!; // e.g. https://build.example.internal/mcp
useMcpConnection({
  name: 'aiwg',
  url,
  auth: process.env.AIWG_MCP_TOKEN,
  tools: ['discover', 'skill-show', 'artifact-write'],
});
```

Tools appear as `mcp__aiwg__discover`, `mcp__aiwg__skill-show` and
`mcp__aiwg__artifact-write`. Outside an agent render, use `createMcpConnection`
with the same configuration, and close the returned connection after use.
Flue executes the prepared tool adapter; calling a returned tool's `.run()`
directly is unsupported by Flue 2.3.0.

The server exposes `discover`, registered `*-show` tools and `artifact-write`.
`--tools discover,skill-show` narrows this set. It cannot enable `command-run`,
worker invocation or other operations. Optional toolsets stay off even if the
service environment contains `AIWG_MCP_TOOLSETS`; name them explicitly with
`--toolsets`. For example, `--toolsets flows --tools discover,flow-show` permits
flow cards. Selecting a missing or prohibited tool refuses server startup.

## Token rotation and session ownership

With `--token-file`, atomically replace the token file. Every HTTP request reads
it again. Old credentials then receive 401; a new token cannot reuse a session
created with the old token (404). Reconnect and initialize a fresh session with
the new credential. The service operator rotates the file; the application
operator updates Flue's credential source. Flue also accepts an `auth` resolver
for retrieving a current token per request. An environment token is captured at
startup; restart that listener after changing its environment.

## Errors and limits

- **401:** Missing, invalid or rotated token, or an unreadable token file. Check
  the service credential source and Flue's `auth`. Bodies and tokens are not logged.
- **403:** Host or Origin is outside the allowlist. Add exact proxy hostnames with
  repeatable `--allowed-host`; a port on an entry restricts that entry to that port.
  Requests without Origin are supported. Browser Origin values must be HTTP(S)
  origins with an allowed host. This endpoint does not provide browser CORS setup.
- **404:** Unknown, deleted, expired or differently authenticated session; reconnect
  and initialize. The endpoint path must be `/mcp`.
- **413:** Request body exceeds 1 MiB, including chunked bodies; reduce content size.
- **503:** Session cap reached (default 8, adjustable with `--max-sessions`), shutdown
  in progress, or the pinned project changed. Close unused sessions or restart as
  appropriate. Idle sessions expire after 300 seconds.
  A disconnected session holds its slot until its work drains, so a full server
  can briefly return 503 while that work finishes.
- **Tool unavailable:** Flue fails connection setup if an explicitly selected tool
  is absent. Check both server `--tools`/`--toolsets` and Flue's `tools` list.

A normal SDK client can DELETE its session on disconnect. Abruptly disconnected
clients retain their session until the idle timeout. MCP cancellation reaches
CLI-backed tools and terminates their child process. SIGTERM and SIGINT stop
admission, close sessions and cancel their in-flight work before closing the
listener. Clients must initialize again after a restart.

## Project isolation and measured capability support

Each listener owns one project; run separate listeners and tokens for separate
projects. Inputs cannot select another project: scope fields such as
`project_dir` are removed from tool schemas and rejected when supplied. Artifact
paths are relative to the pinned artifact root. Traversal and escaping symlinks
fail closed. Authorized writes can overwrite artifacts within that root.

The offline integration test uses the installed MCP SDK and Flue 2.3.0 against
real discovery, show and artifact-write tools on ephemeral loopback ports. The
SDK client can list AIWG resources and prompts. Flue's connection returns only
`name`, `tools` and `close`, lists tools, and does not expose resource or prompt
adapters. Inspection of that pinned connection implementation finds no
elicitation handler; treat resources, prompts and elicitation as unsupported
through this Flue connection. This does not claim a live deployed or Cloudflare
qualification. Use show tools for authored cards and companion content.

Reproduce without model calls or committed credentials:

```bash
nice -n 19 npx vitest run --config config/vitest.config.js test/integration/mcp-http.test.ts
TMPDIR=/var/tmp nice -n 19 npm run test:release-slow -- test/integration/flue-mcp-http.test.ts
```

The release lane resolves Flue from `examples/flue-node/node_modules`, or from
`$AIWG_FLUE_DEPENDENCIES/node_modules` when that variable names a provisioned
Flue 2.3.0 project. Tests generate their own temporary tokens and projects.
