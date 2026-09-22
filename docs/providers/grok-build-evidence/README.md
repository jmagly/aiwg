# Grok Build qualification receipts

`linux.json` is a **partial** Linux PUW receipt for the released 1.0.38 binary. The official `@xai-official/grok-linux-x64@1.0.38` npm archive matched its published SHA-512 integrity before the binary was extracted into an isolated temporary directory. An isolated npm install of `@xai-official/grok@1.0.38` used the reviewed postinstall explicitly because the local npm script policy deferred it. The installed binary matched the independently extracted binary SHA-256. The same isolated npm prefix was updated to 1.0.40 and preserved operator state. The receipt records live `grok inspect --json` and `aiwg build-verify` outcomes, plus project and user-scope deploy/removal, repeat, framework refresh, path safety, secret-canary, and compatibility observations. No authentication was established, so `authenticationMode` is `unverified`.

The public source commit and its internal `SOURCE_REV` are separate identifiers in the receipt. Neither is a verified mapping from this binary to a monorepo commit. The [Linux recovery check](linux-rollback.md) records a controlled refresh failure and exact operator backup restoration; it does not claim automatic transactional rollback.

The [macOS ARM64 receipt](macos.json) and [PUW record](macos-puw.md) cover a native run on Mutsu using the same released 1.0.38 pin. Clean and existing-config projects, project and user scopes, update, refresh, removal, path safety, manual backup recovery, and the generated `AGENTS.md`/`CLAUDE.md` hooks were exercised in isolated paths. Mutsu inspection found one `AGENTS.md` instruction and AIWG skills; build verification was ready. Its authentication mode is also `unverified`.

Credentialed native surfaces and Windows PowerShell and WSL qualification remain pending. Neither host receipt promotes the provider to stable.

The same released 1.0.38 binary advertised only `grok.com` during ACP initialization. A sanitized [ACP observation](../../../test/fixtures/providers/grok-build-acp-init-1.0.38.json) records the method ID; it does not establish a credentialed ACP session. AIWG therefore keeps ACP authentication fail-closed.
