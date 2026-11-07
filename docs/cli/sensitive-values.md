---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.sensitive-values
---

# Supplying sensitive values

Use terminal entry when available, then stdin, a private file, a named operating-system store entry, and a named shell variable last. Pass references on the command line; keep the value itself off it. The inventory below distinguishes commands using the shared resolver from compatibility sources that still need migration.

## Standard input methods

For an adopted command, replace `<prefix>` with `api-key` for `mcp profile login`, `token` for `decision setup jev`, `value` for `auth secret set`, `key` for `marketplace publish`, `bearer` for `agentcard verify`, `resource-token` for protected release resources, or `token` for Git package fetches, live issue import/export and the optional preexisting local-executor bearer.

| Preference | Input | What it exposes |
| --- | --- | --- |
| 1 | No source flag with a terminal, or `--<prefix>-interactive` | AIWG reads an entry without terminal echo. The value lives in AIWG memory and reaches the intended recipient only. Terminal/session recording and software running as your user remain part of the trust boundary. |
| 2 | `--<prefix>-stdin` | A pipe carries the value into AIWG memory. The source process and AIWG can read it; the value does not enter argv or the shell environment. |
| 3 | `--<prefix>-file <path>` | The path is visible on argv; the content remains on disk. On supported POSIX hosts, AIWG requires a regular file owned by the current user with no group/other access, and rejects symlinks and multiple hard links. Use mode `0600` or `0400`. Windows file input fails closed until native ACL validation is available; use stdin or the native store there. |
| 4 | `--<prefix>-store <name>` | Only the entry name appears on argv. The existing native store used by `aiwg auth login` protects the value at rest: macOS Keychain, Windows Credential Manager, or Linux Secret Service. Store availability, unlock state, and your user account govern access. |
| 5 | `--<prefix>-env <NAME>` | Only the variable name appears on argv. The invoking shell and its other children can inherit the value, and process/environment inspection can expose it. AIWG keeps it out of unrelated child environments. |

Protected release resource input never prompts without `--resource-token-interactive`. With no source it keeps the optional `AIWG_RESOURCE_TOKEN_FILE`, then `AIWG_RESOURCE_TOKEN`, then auth store access token lookup; offline cache reads do not look up implicit credentials.

Local-executor input never prompts unless `--token-interactive` is selected. With no source it retains `AIWG_EXECUTOR_TOKEN`, then its existing restart cache, then registration-issued token behavior. Sandbox management and cost-report named references use their documented file/store selectors without prompting. Jev runtime retains its environment variables and credential record.

Marketplace signing accepts multiline PEM (finish hidden terminal entry with an empty line); other values remain one line. Agentcard verification without a source remains unauthenticated. Git package fetches without a source retain their env/file lookup order and SSH-agent fallback. Live issue sync retains its provider environment lookups after terminal/source selection.

An explicit source bypasses the terminal question. The shared resolver orders explicitly requested terminal entry, stdin, file, store, then environment. All adopted commands apply this precedence when several sources are selected. With no explicit source, a terminal selects entry, except for the optional and runtime behaviors above. MCP registration uses the explicit per-value locators described below and never prompts by default. A selected but missing, empty, invalid, or inaccessible source fails; it does not silently fall through to a less preferred source. Without a terminal and without an input source, the command errors and names its source flags. Piped data requires the stdin flag, so a headless command never guesses whether stdin is a credential or other input.

For example, pipe a manager's output directly into either adopted command:

```bash
vault read -field=key secret/openai | aiwg mcp profile login ops --api-key-stdin
op read 'op://Engineering/Jev/api-key' | aiwg decision setup jev --token-stdin --verify
```

Use a private file or an existing named store entry when a pipe is unsuitable:

```bash
aiwg mcp profile login ops --api-key-file "$HOME/.config/aiwg/openai-key"
aiwg decision setup jev --token-store jev-production --verify
aiwg mcp profile login ops --api-key-store openai-production
```

Named raw values use service `aiwg.sensitive-values` and account `<name>` in the existing native store. These entries are separate from the OAuth access/refresh pair created by `aiwg auth login`. Save a value once through the existing auth command, then refer to its name in day-to-day commands. Repeating `set` replaces the entry; `delete` removes it:

```bash
op read 'op://Engineering/OpenAI/api-key' | aiwg auth secret set openai-production --value-stdin
aiwg auth secret delete openai-production
```

Do not type a value into an `export` statement or a command argument: shell history may retain it. Never enable shell tracing around credential-producing commands.

## MCP registry values

`aiwg mcp add` and `aiwg mcp update` accept per-value sources in the existing
`--env-from KEY=SOURCE` and `--header-env HEADER=SOURCE` flags. Repeat either
flag for independent values; the existing comma-separated form also works.
A repeated target uses the last mapping. Paths containing commas cannot use this
syntax. These flags save references, never resolved values, in the MCP registry.

| Source | Registration and runtime behavior |
| --- | --- |
| `ENV_NAME` | Existing behavior: persist the shell variable name. A native harness resolves its own supported syntax when connecting. |
| `file:/absolute/private/path` | Persist the absolute file path; AIWG's runtime client reads it with the shared private-file checks at connection time. The file must remain available. |
| `store:NAME` | Persist the existing named OS-store entry; AIWG's runtime client reads it at connection time using the shared resolver. |
| `stdin:STORE_NAME` | Explicitly read one value from piped stdin and save it to the named OS-store entry, replacing that entry if present. Persist only `store:STORE_NAME`. At most one value per invocation may use stdin. |
| `interactive:STORE_NAME` | Explicitly request hidden terminal entry, save it to the named OS-store entry, and persist only `store:STORE_NAME`. Headless use fails and names the source options. |

```bash
# No secret bytes on argv or in the registry
op read 'op://Engineering/Service/token' | aiwg mcp add service \
  --url https://service.example/mcp --header-env Authorization=stdin:service-auth
aiwg mcp update service --header-env Authorization=store:service-auth
aiwg mcp add local-service --type stdio --command service-mcp \
  --env-from API_KEY=file:/home/operator/.config/service/private-key
aiwg mcp update service --header-env Authorization=interactive:service-auth
```

File/store references are supported by AIWG's registry-backed runtime client
(currently the Fortemi storage adapter, for stdio, HTTP and SSE). They are
**refused** by native provider config writers, including profile/session config
writers: those clients cannot call AIWG's resolver. For `mcp inject`, `mcp install`
and provider/profile sessions, keep using `--env-from KEY=ENV_NAME` or
`--header-env HEADER=ENV_NAME`. AIWG never substitutes file/store values into
provider config files. With `NODE_DEBUG=child_process` enabled, AIWG refuses
credential-bearing stdio configurations before spawning the server to prevent Node from
printing its environment. The receiving MCP server can access its assigned
values; its own handling of them remains part of the trust boundary.

Registration never reads durable file/store/environment sources, prompts, or
consumes stdin unless `stdin:` or `interactive:` is selected. Missing or invalid
selected input fails without falling back. OS-store saves and registry writes
are separate operations: if a later save or registry write fails, an entry
already saved to the OS store remains there, as with `auth secret set`.

Compatibility `--env KEY=VALUE` and `--headers 'Name: value'` (also `Name=value`)
remain literal. Secret-looking names/values produce one stderr deprecation
warning per add/update invocation, without echoing values. Ordinary values
remain quiet. Existing literal registry entries load unchanged, and AIWG does
not migrate or rewrite them during reads.

`--args` remains literal: argument values are visible in process argv and are
stored in the registry/provider config. Supply secrets through the env/header
reference forms instead. Reference support does not protect a secret placed in
`--args`, imported literal config, or a receiving server's own output.

## Daemon startup references

The existing daemon config loader resolves each active recipient's references at
startup and reload, without prompting or replacing references in JSON/YAML:

| Recipient | Reference field | Legacy input, when no reference is selected |
| --- | --- | --- |
| Web UI | `interface.web.token_ref` | `interface.web.token`, then `AIWG_WEB_TOKEN`; absent means no authentication, as before. |
| Inbound webhook configuration | `webhook.secret_env` | Existing variable name, default `AIWG_WEBHOOK_SECRET`; an unset legacy variable stays optional. |
| Telegram | `messaging.telegram.botToken_ref` (alias `token_ref`) | `botToken`, then `token`, then `AIWG_TELEGRAM_TOKEN`. |
| Discord | `messaging.discord.botToken_ref` (alias `token_ref`) | `botToken`, then `token`, then `AIWG_DISCORD_TOKEN`. |
| Slack bot | `messaging.slack.botToken_ref` | `botToken`, then `AIWG_SLACK_BOT_TOKEN`. |
| Slack webhook | `messaging.slack.webhookUrl_ref` | `webhookUrl`, then `AIWG_SLACK_WEBHOOK_URL`. |

Each reference accepts `ENV_NAME`, `file:ABSOLUTE_PATH`, or `store:NAME`, with
the same private-file checks and named OS store described above. For example:

```yaml
interface:
  web:
    enabled: true
    token_ref: store:daemon-web
webhook:
  enabled: true
  secret_env: file:/home/operator/.config/aiwg/webhook-secret
messaging:
  telegram:
    botToken_ref: AIWG_TELEGRAM_TOKEN
    defaultChatId: "123456789"
  slack:
    webhookUrl_ref: store:daemon-slack-webhook
    botToken_ref: store:daemon-slack-bot
```

Explicit reference fields take precedence over literals and default environment
variables. Selected missing/invalid file, store or `*_ref` environment input
fails startup without fallback. Existing `${ENV_NAME}` profile placeholders and
`file:`/`store:` locators in token/URL fields also resolve as references. Bare
strings in legacy token/URL fields stay literal, including strings that look
like variable names. Literal config secrets warn once per config instance,
without printing values; they remain on disk and are not migrated.

Config credentials enable their messaging adapter; existing environment-based
discovery remains. Disabled adapters without their legacy enable variable, and
the housekeeper profile's conversational settings, are not resolved. Slack's
bot token is optional and resolves only when its webhook adapter is active.
`daemon-init` copies profile references only and never reads credentials.
Adapters receive their own secrets; worker environments exclude daemon secret
variables and resolved values, while retaining provider authentication.

Remaining: this daemon has no inbound webhook listener. The loader resolves
`webhook.secret_env` into recipient-local startup config, but does not add an
HTTP receiver or change webhook delivery behavior. Standalone adapter
constructors retain literal/environment input; reference resolution belongs to
the daemon loader. Receiving services' own handling and legacy environment
exposure at the daemon launch boundary remain part of the trust boundary.

## Child-process boundaries

`NODE_DEBUG=child_process` can print spawn arguments and the complete child environment. A secret-free argv is insufficient if a helper inherits the shell environment. Adopted boundaries use an explicit allowed-variable list: native-store helpers, OAuth browser launch, Codex profile login, MCP nested AIWG calls, Muse version/Grok inspection probes, package and provenance Git probes, and the update notifier. Generic script-runner, refresh and Ralph/provider session children still need separate recipient-specific review. Daemon workers exclude the daemon credentials described above; their broader provider environment contract is unchanged. AIWG deploy and CLI subprocesses retain their full environment. The MCP login key reaches `codex login --with-api-key` through stdin. Its output is bounded and redacted before AIWG displays it. Jev verification uses an in-process HTTP request. Private-file contents and resolved store values never belong in errors or status output.

## Storage backend references

Storage credentials resolve at the backend boundary, so the same configuration
applies to `storage test`, `storage migrate`, `storage import-corpus` and other
operations using that backend. No backend prompts or consumes stdin.

| Backend | Reference selector | Default / compatibility behavior |
| --- | --- | --- |
| Logseq | `apiTokenEnv` in the existing storage backend config | Omitted: read `LOGSEQ_API_TOKEN`; missing token warns and keeps filesystem writes. An explicit missing reference errors when `useApi` is enabled. `useApi: false` does not resolve credentials. |
| PostgreSQL | `connectionStringEnv` in backend options | Omitted: read `AIWG_POSTGRES_URL`. Required missing input errors. TLS policy is unchanged. |
| PostgREST | `authorizationEnv` in backend options | Omitted: unauthenticated. The selected source supplies the entire Authorization value, including any `Bearer ` prefix. |
| Fortemi | MCP registry `headerEnv` / `envFrom` | Existing registry resolution above; Authorization references receive the existing `Bearer ` prefix. Literal headers remain literal. |

Logseq, Fortemi, PostgreSQL and PostgREST selectors accept `ENV_NAME`,
`file:/absolute/private/path` or `store:NAME`. Environment names keep their existing raw-value lookup; file/store
forms use the shared resolver and private-file checks. Store entries use the same
`aiwg auth secret set` owner. Selection never falls through to another source.
For example, set Logseq's `apiTokenEnv` to `store:logseq-production`.
PostgreSQL driver failures and decoded PostgREST error responses do not expose
connection strings, passwords or authorization values. Their pinned reference
benchmark evidence is requalified against the adopted credential resolution.
Keep connection strings and authorization bytes out of config, argv and support
output.

## Child-process boundaries

`NODE_DEBUG=child_process` can print spawn arguments and the complete child environment. A secret-free argv is insufficient if a helper inherits the shell environment. Adopted boundaries use an explicit allowed-variable list: native-store helpers, OAuth browser launch, Codex profile login, MCP nested AIWG calls, Muse version/Grok inspection probes, package and provenance Git probes, and the update notifier. Provider/session and qualified worker exceptions are documented below; generic script-runner, refresh and daemon workers still need separate recipient-specific review. AIWG deploy and CLI subprocesses retain their full environment. The MCP login key reaches `codex login --with-api-key` through stdin. Its output is bounded and redacted before AIWG displays it. Jev verification uses an in-process HTTP request. Private-file contents and resolved store values never belong in errors or status output.

A provider or authenticated service may be the intended credential recipient. Its authentication channel is part of that command's contract; the short helper environment must not be confused with permission to forward every shell variable. The inventory's deferred rows and documented provider exceptions do not promise the adopted source-entry commands' complete source or child-debug protections.

### Provider recipient exceptions

The existing policy in `agentic/code/providers/model-capabilities.v1.json` separates full sessions (`sessionEnvAllowlist`) from qualified single-shot workers (`workerHealthAdapter.invocation.envAllowlist` intersected with the selected profile's `envAllowlist`). `tools/ralph-external/lib/session-environment.mjs` applies session inheritance; `src/models/worker-installation.mjs` validates the worker intersection and `src/serve/worker-invocation.ts` renders only approved names through `env -i`. Worker dispatch, Ralph and mission execution consume these qualified invocation records rather than introducing a general credential-forwarding exception.

The table records credential-bearing variables and provider configuration locators; the same lists also contain ordinary execution variables. Every bundled provider has an explicit session list. An empty list deliberately grants no provider-specific inheritance. Full sessions retain the shared base execution/proxy/CA/SSH environment, `LC_*`, `XDG_*`, `GIT_*`, and explicit adapter overrides. Qualified worker profiles are narrower. Providers may also read their own login files through permitted home/config directories; those files remain provider-owned. The lists cover the evidenced authentication and configuration paths below; they do not forward arbitrary plugin/tool credentials or every provider behavior override.

| Provider | Full-session intended-recipient exceptions | Qualified worker exceptions |
| --- | --- | --- |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`; `GOOGLE_APPLICATION_CREDENTIALS`; `CLAUDE_CONFIG_DIR`, Anthropic endpoint/model and Bedrock/Vertex selectors | `ANTHROPIC_API_KEY`; provider login files through `HOME` |
| Codex | `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `CODEX_HOME` | Provider login files through `CODEX_HOME` / `HOME`; no API-key env exception |
| Copilot | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_HOME` | `PATH` only; no credential env exception |
| Factory | `FACTORY_API_KEY` | `FACTORY_API_KEY`; provider login files through `HOME` |
| OpenCode | Shared model API variables listed below; `OPENCODE_API_KEY`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` | `PATH` only; no credential env exception |
| OMP | Shared model API variables; `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | `PATH` only; no credential env exception |
| Pi | Shared model API variables; `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (plus synthetic test selectors) | `PATH` only; no credential env exception |
| DeepSeek Harness | `DEEPSEEK_API_KEY`, `DSH_HOME` | `DEEPSEEK_API_KEY` |
| Muse | Synthetic test selectors only | Provider login files through `HOME`; no credential env exception |
| Antigravity | `GEMINI_API_KEY`; requires `modelProvider: "gemini"` in provider settings | Same key and provider login files through `HOME`; the version-bound profile remains unqualified |
| Cursor | `CURSOR_API_KEY` | `CURSOR_API_KEY`; provider login files through `HOME` |
| Warp | `WARP_API_KEY` | `WARP_API_KEY` |
| OpenClaw | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`; `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD` | `OPENROUTER_API_KEY` |
| Grok Build | `XAI_API_KEY`, `GROK_HOME`; `GROK_CODE_XAI_API_KEY` is unconfirmed and excluded | `XAI_API_KEY`; provider login files through `HOME` |
| Hermes | Shared model API variables below; `ANTHROPIC_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`, `CUSTOM_BASE_URL`, `HERMES_HOME`, `HERMES_INFERENCE_PROVIDER` | `PATH` only; no credential env exception; session overrides do not widen worker policy |
| OpenHuman | `OPENHUMAN_CORE_TOKEN`, `OPENHUMAN_CORE_RPC_URL`, `OPENHUMAN_CORE_HOST`, `OPENHUMAN_CORE_PORT`, `OPENHUMAN_WORKSPACE`, `OPENHUMAN_DOTENV_PATH`, `OPENHUMAN_KEYRING_MASTER_KEY`, `OPENHUMAN_KEYRING_MASTER_KEY_FILE`, `OPENHUMAN_APP_ENV`, `BACKEND_URL`, `OPENHUMAN_MODEL` | `PATH` only; no credential env exception |
| Windsurf | Explicit `[]`: desktop login; no evidenced CLI credential variable | Coverage-only; no worker execution or qualified worker adapter/allowlist |
| Grokbot | Explicit `[]`: desktop/cloud login; no evidenced CLI credential variable | Coverage-only; no worker execution or qualified worker adapter/allowlist |

The shared model API variables for OpenCode, OMP, Pi and Hermes are exactly `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, and `DEEPSEEK_API_KEY`. These exceptions identify intended provider recipients; unrelated helpers must not receive them. Full-session debug output and provider-produced output can expose credentials, so this documentation does not add an argv/output secrecy guarantee for provider-owned execution.

Session evidence reviewed for #3624 on 2026-10-26, in repository → official documentation → local help/source order:

| Provider | Evidence and limits |
| --- | --- |
| Antigravity | [Direct profile](../providers/antigravity-direct.md) records missing-login probes; [official authentication](https://antigravity.google/docs/install/) now confirms the key and required settings selector. Key alone does nothing. This resolves the old guess, without claiming a successful authenticated worker run. |
| Cursor | [Direct profile](../providers/cursor-direct.md), existing worker policy, and installed `cursor-agent --help` explicitly name `CURSOR_API_KEY`. |
| Warp | [Direct profile](../providers/warp-direct.md) and adapter authentication contract name `WARP_API_KEY`; [official CLI reference](https://docs.warp.dev/reference/cli) confirms it. Installed `warp-terminal --help` also names it explicitly. |
| OpenClaw | [Direct profile](../providers/openclaw-direct.md) establishes OpenRouter; installed `dist/extensions/{openai,anthropic,google,openrouter,mistral,xai}` provider contracts read the listed keys. [Official environment reference](https://docs.openclaw.ai/help/environment) and installed path/gateway readers establish the configuration and gateway variables. |
| Grok Build | [CLI auth evidence](../providers/grok-build-cli-evidence.md#5-authentication) establishes `XAI_API_KEY`; `src/providers/grok-build-paths.ts` and [official settings](https://docs.x.ai/build/settings) establish `GROK_HOME`. The redactor's `GROK_CODE_XAI_API_KEY` name alone does not prove CLI consumption. |
| Hermes | [Direct profile](../providers/hermes-direct.md) establishes OpenRouter and inference selection; `src/providers/hermes-home.ts` establishes home resolution. Installed `hermes_cli/auth.py`, `runtime_provider.py` and `hermes_constants.py`, plus the [official environment reference](https://hermes-agent.nousresearch.com/docs/reference/environment-variables), establish the listed model credentials, endpoints and locators. `HERMES_YOLO_MODE` is excluded. |
| OpenHuman | [Session adapter evidence](../providers/openhuman-sessions.md) and [upstream `.env.example` at the adapter's pinned revision](https://github.com/tinyhumansai/openhuman/blob/216ea322a3c1269dada70751ac5c08eac7dc7596/.env.example) establish core auth, encrypted keyring and runtime config names; that revision's `core/cli.rs` reads `OPENHUMAN_DOTENV_PATH`. Detection-only `OPENHUMAN_HOME` is unconfirmed and excluded. |
| Windsurf | [Session contract](../providers/windsurf-sessions.md) supports desktop transcript import; the registry's out-of-scope worker coverage records no CLI worker contract. Installed `windsurf --help` reports the Devin Desktop editor interface, without a provider credential variable. No credential name is inferred from another product's CLI. |
| Grokbot | [Native-surface evidence](../integrations/grokbot-native-surfaces-evidence.md) and [session contract](../providers/grokbot-sessions.md) establish desktop/cloud surfaces, not a credential-bearing CLI worker. Installed `grok-bot --help` could not initialize without an X display; the probe was stopped. No variable name or execution authority is inferred from Grok Build or Cursor. |

Local probes used `--help` with cleared environments and isolated empty homes; no auth/token files, live credentials or model calls were used. Help confirms CLI shape, not authentication success. Unlisted tool-specific credentials and unconfirmed names stay excluded from implicit provider inheritance.

<a id="sensitive-input-inventory-3079-slice-1"></a>

## Sensitive-input inventory: #3079 slices 1–4

The “existing input” column records the implementation before this slice; the last column records adoption. A row covers all commands sharing the named owner, including aliases. Public keys, signing-key identifiers, credential reference names, and provider-presence checks are not secret values.

| Command / option or configured surface | Sensitive value and existing input | Source owner | Slice status / remaining work |
| --- | --- | --- | --- |
| `aiwg mcp profile login <name>`; `--api-key-stdin`, `--api-key-file`, `--api-key-env` | API key from explicit stdin, owner-only regular private file, or named environment variable; no-source TTY path delegates OAuth to Codex. | `src/mcp/cli.mjs`, `src/mcp/adapters/codex-runtime.ts` | Adopted: shared resolver adds `--api-key-store`, masked terminal entry and shared source precedence. |
| `aiwg decision setup jev`; `--token-stdin` | API key from explicit stdin, then `JEV_API_KEY` / `AIWG_DECISION_JEV_API_KEY`; no terminal prompt; persists private `jev.json`. | `src/cli/handlers/decision.ts`, `src/decision/ask.ts` | Adopted: shared resolver adds `--token-file`, `--token-store`, `--token-env`; environment selection is explicit (`--token-env JEV_API_KEY`); existing runtime environment lookup is unchanged. |
| `aiwg init`, `aiwg setup project`, `aiwg setup --apply`; `--credential <provider>=env:NAME\|file:PATH\|store:NAME\|stdin`, `--token-stdin` | Provider/Jev API input: references saved in plans, bytes resolved only at apply from named environment, file, stdin or masked prompt; Jev is handed to setup on stdin. | `src/discovery/plan-apply.ts`, `src/cli/handlers/setup.ts`, `src/cli/handlers/guided-setup.ts` | Adopted: existing plan references and apply IO use shared resolution; `store:NAME` extends the same schema. `stdin` can prompt at a terminal or read explicit piped input at apply. |
| `aiwg auth login`, `auth status`, `auth logout`; `--device`, `--store file --allow-file-store` | Login obtains OAuth access/refresh tokens over HTTPS and saves them in the native store; status/logout read that entry. Explicit file fallback stores private JSON. No raw token CLI argument. | `src/auth/client.ts`, `src/auth/credential-store.ts`, `src/cli/handlers/auth.ts` | Existing OAuth owner retained; native helper child environment hardened. Named raw-value set/delete uses the same auth command family. |
| `aiwg auth secret set <name>`; `--value-interactive`, `--value-stdin`, `--value-file`, `--value-store`, `--value-env`; `auth secret delete <name>` | Named raw values saved in the existing native store, separate from the OAuth entry. | `src/cli/handlers/auth.ts`, `src/auth/sensitive-input.ts`, `src/auth/credential-store.ts` | Adopted: same five sources and headless refusal; save/delete never prints the value. |
| `aiwg discover`, `show`, `resource-versions`, `use`, and artifact web-resource resolution | Protected release bearer: `AIWG_RESOURCE_TOKEN_FILE`, then `AIWG_RESOURCE_TOKEN`, then the auth store access token. File checks regular/non-symlink and private mode. | `src/auth/config.ts`, `src/auth/resource-credentials.ts`, `src/artifacts/cli.ts`, `src/cli/handlers/resource-versions.ts`, `src/cli/handlers/use.ts` | Adopted: shared `--resource-token-interactive`, `--resource-token-stdin`, `--resource-token-file`, `--resource-token-store`, and `--resource-token-env` precede the unchanged optional file/env/auth-store order. Both file forms use shared ownership, mode, symlink and hard-link checks. No implicit prompt; public and offline behavior is retained. Remaining: auth login still owns OAuth refresh/access-token lifecycle; use deployment helpers do not receive the release token variable. |
| `aiwg decision ask` and enabled live decision consumers | Jev key from `JEV_API_KEY` / `AIWG_DECISION_JEV_API_KEY`, then a project/user OpenBao reference, then `~/.config/aiwg/credentials/jev.json`; private file and directory modes checked. | `src/decision/jev-credentials.ts`, `src/decision/ask.ts` | Adopted: reference-only configuration uses native secret-store AppRole IDs; the key stays in process memory, without child-environment export. Offline inspection reports the reference path only. Unavailable references fall back to LLM. Existing private-file checks and setup remain supported. See [Jev reference setup](../decision/jev-quickstart.md). |
| `aiwg mcp add`, `mcp update`; `--env`, `--headers`, `--args`, registry import/config; `--header-env`, `--env-from` | Literal environment/header/argument values can contain secrets; named environment references avoid literals in registry. Credential policy restricts persisted/rendered values. `mcp inject`, `mcp install`, `session --mcp` and profile launch consume that registry. | `src/mcp/cli.mjs`, `src/mcp/credentials.mjs`, `src/mcp/registry.ts`, `src/mcp/registry.mjs`, `src/storage/backends/fortemi.ts` | Adopted: repeatable `--env-from`/`--header-env` accept environment names, private-file and OS-store references; explicit `stdin:STORE_NAME`/`interactive:STORE_NAME` save through the existing OS store. AIWG runtime resolution uses the shared resolver; native provider/profile configs require environment references and refuse file/store locators. Secret-looking literal env/header inputs warn once. Remaining: `--args`, imported/configured literals and existing registry literals stay literal, without migration; their argv/at-rest exposure remains. |
| `aiwg install <github:…\|gitea:…>` and `marketplace` Git adapter fetches | `GITHUB_TOKEN`, then `~/.aiwg/credentials/github`; `GITEA_TOKEN`, then `~/.config/gitea/token` / `~/.aiwg/credentials/gitea`; otherwise SSH agent. Token is embedded in HTTPS clone URL. | `src/packages/adapters/github.ts`, `src/packages/adapters/gitea.ts`, `src/packages/adapters/git.ts` | Adopted: standard `--token-*` sources precede the unchanged env/file lookup order and SSH-agent fallback. Private files use shared validation. Tokens stay outside serializable sources and clone URLs; a temporary mode-0600, origin-scoped Git config in a mode-0700 directory is included by path only and removed after fetch. Debug logs contain no token. Windows token fetches fail closed pending temporary-file ACL validation; use SSH there. |
| `aiwg marketplace publish`; `--key <pem>` | Ed25519 private PEM read directly from the named file. `--public-key`, `--key-id`, and setup `--signing-key` are public material/identifiers. | `src/cli/handlers/marketplace.ts`, `src/marketplace/exchange.ts` | Adopted: standard `--key-*` sources support multiline PEM; `--key <path>` remains a private-file alias. Shared checks reject nonregular, unowned, exposed or linked files. Signing material stays in-process; Git probes receive an allowed environment. |
| `aiwg effect` signed writes, `effect keys init\|rotate`; configured host key provider | Signing keys generated internally and loaded from native secret store, or explicitly selected private file. Test-only environment fixture is restricted to test context. | `src/cli/handlers/effect.ts`, `src/effects/` | Existing key lifecycle retained; native helper child environment hardened. No externally supplied raw-key option to migrate. |
| `aiwg cost-report`; `--key <key_ref>`, `--fleet`, `--config` | OpenRouter API key from `AIWG_OPENROUTER_KEY_<KEY_REF>` first, otherwise owner-only regular file in private `~/.config/aiwg/keys/`; fleet YAML contains references only. | `src/cost/fleet-report.ts`, `src/cli/handlers/cost-report.ts` | Adopted: implicit named environment then the same private key file use shared resolution and file checks. Optional `--key-store <name>` for `--key`, or per-fleet-entry `key_store`, selects a named OS store entry. Each ref is isolated; a selected missing source errors without another ref fallback. No terminal prompting or general raw-key argument is added. |
| `aiwg issue import --live`, `issue export --live` | Tracker bearer from `AIWG_GITEA_TOKEN` / `GITEA_TOKEN`, or `AIWG_GITHUB_TOKEN` / `GITHUB_TOKEN`; passed to in-process HTTP client. | `src/issues/live.ts`, `src/issues/cli.ts` | Adopted: explicit `--token-*` sources (including `--token-interactive`) precede the established provider-specific environment lookups. With no source and no provider variable, requests stay unauthenticated, as before, for public repositories. The in-process HTTP client redacts reflected values and errors. |
| `aiwg local-executor serve` | Optional `AIWG_EXECUTOR_TOKEN`; otherwise registration obtains and persists an executor bearer token for restarts. | `src/cli/handlers/local-executor.ts`, `tools/ralph-external/executor-shim.mjs` | Adopted: optional `--token-interactive`, `--token-stdin`, `--token-file`, `--token-store`, `--token-env` precede the legacy `AIWG_EXECUTOR_TOKEN` and restart cache. The same cache location persists registration-issued tokens in a 0600 file within a 0700 directory; restart reads use shared private-file checks. Tokens stay out of events and registration errors; no implicit prompt. Windows cache persistence fails closed pending native ACL validation. Host agent execution keeps its existing isolation contract. |
| Daemon startup, web UI, inbound webhooks and messaging adapters | Web token from config or `AIWG_WEB_TOKEN`; webhook `secret_env` names a shell variable (default `AIWG_WEBHOOK_SECRET`); Telegram/Discord/Slack tokens and Slack webhook URL from adapter config or `AIWG_TELEGRAM_TOKEN`, `AIWG_DISCORD_TOKEN`, `AIWG_SLACK_BOT_TOKEN`, `AIWG_SLACK_WEBHOOK_URL`. | `tools/daemon/daemon-main.mjs`, `tools/daemon/config.mjs`, `tools/messaging/adapters/` | Adopted: existing loader resolves independent environment/private-file/OS-store references at startup without prompting or persisting bytes; literal config warns once. Web and messaging recipients receive only their own values; daemon worker environments exclude these credentials. `daemon-init` remains references-only. Remaining: legacy literals stay on disk; standalone constructors retain literal/env input; daemon launch retains legacy environment exposure. Inbound webhook config resolves, but no inbound listener exists in this daemon. |
| `aiwg storage test\|migrate\|import-corpus` and every operation using configured remote storage | Logseq `LOGSEQ_API_TOKEN`; Fortemi MCP registry header/env references or legacy literal headers; PostgreSQL configured `connectionStringEnv` (default `AIWG_POSTGRES_URL`); PostgREST configured `authorizationEnv`. | `src/storage/backends/logseq.ts`, `fortemi.ts`, `postgres.ts`, `postgrest.ts` | Adopted: Logseq `apiTokenEnv` (default `LOGSEQ_API_TOKEN`) accepts environment names or shared-resolver `file:ABSOLUTE_PATH` / `store:NAME` references; reflected HTTP errors are sanitized. Fortemi reuses MCP registry resolution; legacy environment/header values remain supported with reflected-error redaction. Missing explicit sources fail; neither backend prompts. Logseq keeps its optional missing-default-token warning and filesystem fallback; literal MCP config remains literal at rest. Adopted: PostgreSQL `connectionStringEnv` (default `AIWG_POSTGRES_URL`) and PostgREST `authorizationEnv` accept environment names or shared-resolver `file:ABSOLUTE_PATH` / `store:NAME` references. Selected missing input fails without prompting or fallback; driver and decoded HTTP errors do not expose credentials. Pinned reference benchmark evidence is requalified locally. PostgREST without authorization stays unauthenticated; receiving services retain access to their assigned credentials. |
| `aiwg uhp harnesses\|models\|run` and authenticated UHP API consumers; `--profile` | Named profile's `credential.source: env` and `credential.name` resolved at request time. Inline profile credentials rejected. Discovery is unauthenticated. | `src/uhp/config.ts`, `src/uhp/client.ts` | Adopted: reference-only profile contract verified in `validateUhpConfig` and request-time `resolveEnvironmentCredential`; inline profile tokens, endpoint userinfo and extra credential-locator fields are rejected without echoing values. Discovery stays unauthenticated; authenticated calls use only the named env reference, with no prompt or new file/store source. |
| `aiwg agentcard verify`; `--bearer <token>` | Optional bearer supplied literally on argv, forwarded as an HTTP bearer for the card endpoint. | `src/cli/handlers/agentcard.ts`, `src/a2a/agent-card.ts` | Adopted: standard `--bearer-*` sources; no source keeps unauthenticated access. Compatibility `--bearer` warns that argv exposes the value. HTTP errors and reflected output redact the bearer. |
| `aiwg diagnose`; `--include-secrets`, `--stdout` | Reads environment and local configuration/log files for a support bundle. Default sanitizes sensitive environment/config fields; `--include-secrets` intentionally disables sanitization and `--stdout` prints the bundle. | `src/cli/handlers/diagnose.ts` | Adopted as documented: explicit `--include-secrets` retains intentional secret output; command help and docs require review before sharing. Opt-in emits a secret-free stderr warning, including with `--stdout`. Default sanitization is unchanged; collected content still requires review, and a resolver cannot protect bytes intentionally included in the bundle. |
| `aiwg mcp serve --toolsets sandbox` | Management bearer read from `AIWG_SANDBOX_MANAGEMENT_TOKEN_FILE`; regular/private mode checked. | `src/mcp/tools/agentic-sandbox.mjs` | Adopted: `AIWG_SANDBOX_MANAGEMENT_TOKEN_FILE` retains priority and uses shared private-file validation; optional `AIWG_SANDBOX_MANAGEMENT_TOKEN_STORE` selects a named OS store entry. No implicit prompt or raw bearer flag; management HTTP remains the intended recipient. |
| `aiwg session`, worker dispatch, Ralph and mission provider execution | Provider-owned login files and provider-specific named API variables are intentionally consumed by the provider; for example Grok Build `XAI_API_KEY` (`GROK_CODE_XAI_API_KEY` remains unconfirmed and excluded). AIWG also inspects provider settings containing inline-credential indicators. | `src/providers/`, provider adapters and worker-dispatch environment policy | Adopted as documented: [per-provider recipient exceptions](#provider-recipient-exceptions) record the existing full-session lists and qualified worker/profile intersections. Session follow-up #3624: all bundled providers now declare session lists with evidence; Windsurf and Grokbot remain coverage-only with explicit empty lists. Worker qualification and provider-owned login/output contracts remain independent. |

Developer-only `tools/` qualification, smoke, benchmark and release scripts are outside the public command surface. They also read synthetic/live opt-in environment credentials (`AIWG_JEV_LOAD_API_KEY` with `--credential-env`, `AIWG_DECISION_JEV_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `AIWG_FORTEMI_LIVE_TOKEN`, `SOCKET_API_TOKEN`, `AIWG_FORGE_TOKEN`, `AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN`, `GITHUB_TOKEN`) or an OpenBao helper. Their live paths are deferred; tests for this slice use synthetic values, isolated temporary files and injected stores only.

`aiwg dataset` remote adapters accept opaque credential locators, reject secret-bearing URLs/configuration, and require an external authorized resolver; they do not currently resolve CLI secret bytes themselves. HTTP credentials received by `aiwg serve` over authenticated API requests are protocol input, not command-line input. Those contracts remain with their existing owners.
