# Grok Build qualification and stable-promotion gate

Grok Build is the `grok` coding-agent CLI (`grok-build` in AIWG), distinct from
Grok Bot and Grok web Build. The adapter remains **experimental**. The supplied
Linux **1.0.77** captures (2026-11-09, banner revision `50ca579fa996`) establish
only the behaviors in the [native-surface inventory](grok-build-evidence/2026-11-09.md).
Windows PowerShell and WSL PUWs are **deferred: no captures supplied**.

The [contract](grok-build-qualification.json) keeps `capturedRelease` separate
from its historical 1.0.38 source-review pins: public commit
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` and internal `SOURCE_REV`
`559751fdcec02d413e4c57c8832ab275e4f44980`. Neither is a verified 1.0.77 source
mapping. Needs full public source commit and internal revision for that release;
never expand a short banner hash into an invented mapping.

## Provider under workflow

Use a disposable project and isolated home, never your real home. Qualify a
clean project and an existing project with operator-owned `.grok/config.toml`,
`.grok/skills/operator/SKILL.md`, `WORKSPACE.md`, `AGENTS.md`, `CLAUDE.md`, and
`.agents/skills/operator/SKILL.md`. Use canary strings, never credentials.

| Host | Current evidence | Required lifecycle |
|---|---|---|
| Linux | 1.0.77 deploy/discovery/trust/headless/session captures; historical 1.0.38 lifecycle receipt | Repeat clean/existing install, update, deploy, verify, refresh, uninstall against 1.0.77 |
| Windows PowerShell | Deferred: needs Windows PUW | Full lifecycle with native PowerShell paths and user/project scopes |
| WSL | Deferred: needs WSL PUW | Full lifecycle inside WSL and Windows-mounted project; Linux binary inside WSL |

After installing a reviewed released binary, record `grok --version`. Use the
[quickstart](../integrations/grok-build-quickstart.md) for connect/deploy/verify:

```text
aiwg use all --provider grok-build --scope project --dry-run
aiwg use all --provider grok-build --scope project
aiwg regenerate --workspace --provider grok-build
grok inspect
aiwg build-verify --provider grok-build
aiwg use all --provider grok-build --scope user --dry-run
```

Review the resolved user root before applying user scope. Global npm installation
and provider user-scope deployment are separate choices. Trust the reviewed
project in Grok Build: untrusted folders load no project instructions, even
when user skills appear. Native project paths are `.grok/skills` and
`.grok/rules`; `.agents/skills` and Claude-compatible surfaces do not substitute
for them. Needs isolated 1.0.77 `.agents/skills` discovery/precedence evidence.

For each lifecycle step, hash operator-owned files and compare the permitted
roots before/after. Repeat deployment/regeneration and prove idempotence.
Reject symlink/path escapes. Inject a controlled refresh failure and restore
from an explicit backup; prove exact preimages. The historical Linux recovery
record is **operator restoration**, not automatic transactional rollback. Scan
logs/receipts for the synthetic canary and private paths. Confirm shared
`CLAUDE.md` content survives. Refresh with `aiwg refresh --skip-update
--provider grok-build --frameworks sdlc`, then verify again. Preview uninstall
with `aiwg remove grok-build --provider grok-build --dry-run`; review ownership
before applying removal. Preserve modified/unverifiable and operator files.

## Read-only live smoke

In a source checkout, from an already deployed, trusted disposable project:

```bash
AIWG_GROK_BUILD_LIVE_SMOKE=1 AIWG_GROK_BUILD_AUTH_MODE=interactive \
  node /path/to/aiwg/tools/providers/grok-build-qualification.mjs smoke \
  --output /private/new-receipt.json
```

The existing `npm run smoke:grok-build:live -- --output FILE` alias works when
run from the deployed checkout. Explicit opt-in is required. Missing opt-in,
missing binary, or unavailable/undeclared login skips with exit zero. For managed
login declare `AIWG_GROK_BUILD_AUTH_MODE=managed`; an existing `XAI_API_KEY`
records `api-key-environment` without printing or reading credential files.
Auth mode is environment-presence or operator-declaration evidence, **not**
proof that credentials work. `AIWG_GROK_BUILD_BIN` can select a pinned executable.

Only `grok --version`, `grok inspect`, and `aiwg build-verify --provider
grok-build` run. No prompt/model, deployment, or configuration mutation runs.
Unexpected release, untrusted/missing project surfaces, or a wrong/failed AIWG
receipt fails. Successful output is created exclusively with owner permissions;
existing files are never replaced. It records OS/release, version, auth mode,
a sanitized projection of inspect output (trust, relative instruction/rule
paths, AIWG project skill names), deployed surfaces, and the expected provider
receipt (`aiwg.build.verify.v1`, `grok-build`, `ready`). Arbitrary inspect/config
text and unrelated receipt fields are dropped. Lifecycle checks remain pending.

`npm run gate:grok-build` reads the inventory and existing receipt directory.
While experimental it reports `gated: false, ready: false`. Stable promotion
requires matching released/source pins, exactly one complete Linux, Windows
PowerShell and WSL receipt, passed lifecycle checks, and local live evidence for
every claimed native surface. Fixture-backed native claims block promotion.
Unsupported/deferred surfaces require explicit reasons and withdrawal of the
native claim. Evidence references must resolve to nonempty files under `docs/`
or `test-results/`, without traversal or symlink escapes. Captures do not turn
pending checks into passes. Never copy historical pins into a new receipt.

## CLI/schema drift check and proposed scheduling

The [snapshot](../../test/fixtures/providers/grok-build/capture-1.0.77/snapshot.json)
records captured version, observed flag/format tokens, JSON result keys, and
stream event types. Compare against an installed binary without a model call:

```bash
npm run drift:grok-build -- --capture \
  --json-file /reviewed/headless-json.out \
  --stream-file /reviewed/headless-streaming-json.out
```

This mode runs only local `--version`/`--help`. For fully offline replay, pass
`--version-file FILE --help-file FILE` as well. JSON/stream samples must come
from a separately authorized capture; the tool never generates them. It exits
one on drift or missing samples and names the affected contract. Missing
JSON/stream samples yield `partial`, never a successful full comparison.
Differences in JSON top-level keys and event discriminants are exact; help
checks cover the observed token subset. Full help additions, nested config
schema changes and InspectReport JSON drift remain deferred: needs full help,
config schema, and InspectReport JSON captures. The legacy drift mode without
`--capture` checks upstream Git revisions over the network; it is separate
from this local binary/schema comparison and was not run for this task.

Proposed release/scheduled check (design only): on an operator-approved runner
with the pinned CLI, run this comparison at release cut and weekly against
reviewed samples. Retain the detected differences and route review to
`grok-build-qualification.json`, inspection/config owners, headless transport,
and session adapters. Require a reviewed replacement snapshot after drift;
never update the pin automatically. Existing workflow revision checks do not
perform this comparison. **No workflow changes are included**; adding or wiring
this job needs operator approval.

Troubleshooting: check folder trust before redeploying; confirm project versus
user scope and `GROK_HOME`; compare inspection with the AIWG receipt; restart
the provider after changes. See [MCP sidecar/hooks](../integrations/grok-build-native-extensions.md),
[sessions](grok-build-sessions.md), [models](grok-build-models.md),
[headless automation](../integrations/grok-build-ci.md), and
[migration/recovery](../migration/grok-build-from-claude-workaround.md).
ACP, subagent dispatch, worktrees, MCP execution and hook execution require the
specific new captures listed in the inventory before stable claims.
