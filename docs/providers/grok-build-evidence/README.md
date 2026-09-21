# Grok Build qualification receipts

`linux.json` is a **partial** Linux PUW receipt for the released 1.0.38 binary. The official `@xai-official/grok-linux-x64@1.0.38` npm archive matched its published SHA-512 integrity before the binary was extracted into an isolated temporary directory. The receipt records the binary SHA-256, the live `grok inspect --json` and `aiwg build-verify` outcomes, and project deployment, repeat deployment, and reviewed removal observations. No authentication was established, so `authenticationMode` is `unverified`.

The source revision in the receipt is the contract pin, not a verified mapping from this binary to a monorepo commit. Upstream `SOURCE_REV` currently differs from that pin. Clean installer execution, credentialed native surfaces, full update/refresh/rollback, and macOS, Windows PowerShell, and WSL qualification remain pending. Do not use this receipt to promote the provider to stable.
