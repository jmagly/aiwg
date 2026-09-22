# macOS ARM64 Grok Build provider-under-workflow receipt

Observed on 2026-09-22 UTC on Mutsu, the macOS ARM64 builder documented in
the IT ops fleet inventory. The host reported macOS 26.6.1. Work ran in a
disposable directory on `/Volumes/build`, with AIWG checked out at
`39fc0c25d850bf0275f82819582836b47695efd8`; `GROK_HOME` and
`AIWG_CONFIG` pointed inside that directory. The host's older global AIWG
installation was not used. No host credential, login state, or operator home
content was copied into the fixtures.

The released `@xai-official/grok-darwin-arm64@1.0.38` archive matched its npm
registry integrity
`sha512-PUyVeEKffN0EJa59jjsxk0+lCrgqoeGalTJDCEybkP3nfmqVEQtSwBbHc9/GmgyjgNxNIWKCygFViFUnAfDE1A==`.
The archive SHA-256 was
`0cdee905e0fdd6aa1d4503fa1517b4ed88d29c7f3351d57fd1621fab7c064425`.
The matching `@xai-official/grok@1.0.38` wrapper was installed with npm
scripts disabled, and its reviewed `bin/postinstall.js` was invoked explicitly
with the isolated `GROK_HOME`. The installed binary reported `grok 1.0.38`;
its SHA-256 was
`a3c5c279339a1294cc99b4d105fe7c67a9f64d20647f2edf131ee72d70f94ed1`.
These package checks do not establish a binary-to-source commit mapping.

The clean project and a second project with operator-owned `.grok/config.toml`,
native and compatibility skills, `WORKSPACE.md`, `AGENTS.md`, and `CLAUDE.md`
were initialized as disposable Git repositories. Only those paths were granted
Grok project trust. The clean-project smoke command generated
[`macos.json`](macos.json): `grok inspect --json` reported one `AGENTS.md`
instruction, 26 skills, and three agents; `aiwg build-verify --provider
grok-build` returned `ready`. The smoke receipt records authentication as
`unverified`.

In the existing-config project, project deploy and canonical workspace
regeneration preserved the operator content. Repeating both commands left
SHA-256 hashes of generated context and operator files unchanged. An
`aiwg refresh --skip-update --provider grok-build --frameworks sdlc` pass left
build verification `ready`. Reviewed project removal and user-scope removal
removed AIWG-owned skills while retaining operator config, native and
compatibility skills, and the operator notes in `AGENTS.md` and `CLAUDE.md`.
User-scope actions used the isolated `GROK_HOME`.

`grok update --check` reported 1.0.40 available. Both 1.0.40 npm archives
matched registry SHA-512 metadata; the 1.0.40 wrapper postinstall script had
the same SHA-256 as 1.0.38. Updating the isolated npm prefix to 1.0.40 left
the versioned 1.0.38 binary and the operator user skill intact. The updated
binary reported 1.0.40, and project inspection still found trusted
instructions and AIWG skills. The qualification receipt itself remains pinned
to the tested 1.0.38 release.

Deploy and removal preview refused a symlinked project `.grok` root. User
deployment also refused a symlinked `GROK_HOME/skills` root. In both cases,
the file outside the intended root was unchanged. A separate controlled
refresh failure against a symlinked project root was followed by restoration
from an operator backup; preimage and restored hashes matched. This proves
manual backup recovery, not automatic transactional rollback. A synthetic
canary in operator-owned config did not appear in captured lifecycle logs or
inspection and verification summaries. Alternating Claude and Grok workspace
regeneration retained both operator notes, kept `WORKSPACE.md` before
`AIWG.md` in `AGENTS.md`, and left exactly one Claude provider bootstrap hook.

The run did not authenticate Grok Build or exercise credentialed model calls,
ACP, headless execution, native sessions, subagents, or worktrees. The provider
remains experimental while those surfaces and Windows PowerShell and WSL
qualification are pending. Fortemi's Mutsu CI workflow demonstrates a future
automation pattern: exact-revision checkout, pinned host identity, shared-host
lock, and a bounded receipt. This run used direct pinned SSH access; no
Fortemi CI credential or AIWG Vault policy was reused.
