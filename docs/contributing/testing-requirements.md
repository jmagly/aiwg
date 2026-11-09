# AIWG Testing Requirements

This document defines testing requirements for contributions to the AIWG toolkit.

## Regression Testing Requirements

### When Full Regression Testing is Required

Significant changes to AIWG require full regression testing and validation across all supported
providers before merging. "Significant changes" include:

| Change Type | Full Regression Required | Reason |
|-------------|-------------------------|--------|
| New agents | Yes | Agents deploy to all provider formats |
| New commands | Yes | Commands may have provider-specific behavior |
| New skills | Yes | Skills are deployed with frameworks |
| CLI changes | Yes | CLI handles all provider deployments |
| Manifest changes | Yes | Manifests control deployment behavior |
| Framework modifications | Yes | Frameworks are core to all providers |
| Addon modifications | Yes | Addons deploy across providers |
| Template changes | No (unless structural) | Templates are provider-agnostic |
| Documentation only | No | No deployment impact |

### Provider Validation Matrix

All significant changes must be validated against these providers:

| Provider | Deployment Target | Validation Command |
|----------|-------------------|-------------------|
| Claude Code | `.claude/agents/`, `.claude/commands/` | `aiwg use sdlc` |
| GitHub Copilot | `.github/agents/` | `aiwg use sdlc --provider copilot` |
| Warp | `WARP.md` | `aiwg use sdlc --provider warp` |
| Factory AI | `.factory/droids/` | `aiwg use sdlc --provider factory` |
| OpenCode | `.opencode/agent/` | `aiwg use sdlc --provider opencode` |
| Cursor | `.cursor/rules/` | `aiwg use sdlc --provider cursor` |
| OpenAI/Codex | `.codex/agents/` | `aiwg use sdlc --provider codex` |

### Validation Checklist

Before submitting a PR with significant changes:

```bash
# 1. Run full test suite
npm test

# 2. Lint all modified markdown files
npm exec markdownlint-cli2 "path/to/modified/**/*.md"

# 3. Deploy to each provider and verify
aiwg use sdlc --provider claude --force
aiwg use sdlc --provider factory --force
aiwg use sdlc --provider openai --force

# 4. Verify new content is deployed correctly
ls .claude/commands/your-new-command.md
ls .factory/commands/your-new-command.md
ls .codex/commands/your-new-command.md

# 5. Check manifest is updated
cat agentic/code/addons/your-addon/manifest.json | jq '.commands'
```

## Known Provider Limitations

### General-Purpose Commands (aiwg-utils)

**Current behavior**: Commands from `aiwg-utils` addon currently only deploy to Claude Code
(`.claude/commands/`), not to other providers.

**Impact**: Commands like `/aiwg-refresh`, `/aiwg-regenerate`, `/workspace-*` are only available
in Claude Code sessions.

**Tracking**: This is a known CLI limitation to be addressed in future releases.

### Provider-Specific Features

| Feature | Claude | Factory | OpenAI | Cursor | Warp |
|---------|--------|---------|--------|--------|------|
| Agents | ✓ | ✓ | ✓ | ✓ | ✓ |
| SDLC Commands | ✓ | ✓ | ✓ | ✓ | ✓ |
| Utils Commands | ✓ | ✗ | ✗ | ✗ | ✗ |
| Skills | ✓ | ✓ | ✓ | ✓ | ✓ |
| MCP Integration | ✓ | ✓ | ✗ | ✗ | ✗ |

## Test Categories

### Unit Tests

- Location: `test/unit/`
- Run: `npx vitest run test/unit/`
- Coverage: Core CLI functionality, parsers, validators

### Integration Tests

- Location: `test/integration/`
- Run: `npx vitest run test/integration/`
- Coverage: Provider deployments, CLI end-to-end

### Provider-Specific Tests

- Claude Code: `test/integration/claude-code-deployment.test.ts`
- Factory AI: `test/integration/factory-deployment.test.ts`
- OpenAI/Codex: `test/integration/openai-deployment.test.ts`

## Optional Backends

`better-sqlite3` is an **optional** peer dependency. `npm install && npm test` on a
clean checkout is green without it: every suite that needs the sqlite backend
reports as *skipped*, and the run warns once naming the remedy.

```
[skip] optional sqlite backend unavailable — `better-sqlite3` is not installed;
run `npm run features:sqlite` (or `aiwg features install sqlite`) to enable these suites
```

To run those suites locally, install the backend the same way CI does:

```bash
npm run features:sqlite
npm test
```

CI runs `npm run features:sqlite` before the suite, so the sqlite-backed paths are
always exercised for real on `main` — a local skip and a CI run are both honest.

A missing optional backend warns; it never fails the suite. When you add a test
that needs sqlite, guard it with the shared helper rather than assuming the
package is present:

```ts
import { describeWithSqlite, itWithSqlite, backendUnavailable } from '../helpers/sqlite.js';

describeWithSqlite('catalog lifecycle', () => { /* ... */ });
itWithSqlite('imports through the repository', async () => { /* ... */ });

// Table-driven suites that loop over backends:
it.skipIf(backendUnavailable(backend))(`${backend} round-trips`, async () => { /* ... */ });
```

Tests whose *subject* is the unavailable-backend path — such as
`createGraphBackend`'s remediation message — must stay unguarded so the degraded
path keeps its coverage.

## Temporary directory cleanup

The [#3018 audit](testing-temp-audit.md) records leaking prefixes and their owners.

`npm test` (also the default portion of `npm run test:ci`) runs Vitest in a
private `TMPDIR` and checks it after the child exits, even when tests fail.
Unexpected files or directories fail the lane and are retained at the printed
path for diagnosis. Only the private run's Node/tsx process caches are removed
by the runner; it never sweeps the shared system temp directory.

Tests own their fixtures. Import `mkdtemp` or `mkdtempSync` from
`test/helpers/temp-dir.ts` for file-scoped cleanup in `afterAll`, or use an
existing `afterEach`/`try`-`finally` cleanup. Create fixtures inside hooks or
tests: module-level allocation can leak when an entire suite is skipped.
Keep external destinations beneath another owned temporary directory so their
empty parents are removed too. Filtered runs still use the gate:

```bash
npm test -- test/unit/artifacts/output-policy.test.ts
```

For a direct Vitest run with a caller-owned private `TMPDIR`, run
`npm run lint:tmpdir-leaks -- --dir "$TMPDIR"` afterward. This standalone
checker reports entries and never removes them.

## Windows simulation on Linux

Import `test/helpers/windows-simulation.mjs` from either `.ts` or `.mjs` tests.
Use `withWindows(fn, { profile })` for one synchronous or asynchronous call, or
`withPlatform('darwin', fn)` / `withPlatform('linux', fn)` for other branches.
These restore the original property descriptor even when the callback throws or
rejects. For an entire describe block, register the Vitest hooks:

```ts
import { beforeEach, afterEach, describe } from 'vitest';
import { useWindowsSimulation } from '../../helpers/windows-simulation.mjs';

describe('Windows behavior', () => {
  useWindowsSimulation({ beforeEach, afterEach }, { profile: 'C:\\Users\\Test User' });
  // Tests see win32, the simulated environment and os.homedir().
});
```

For individual tests needing activation partway through setup, register
`const simulatePlatform = usePlatformSimulation({ afterEach })` once, then call
`simulatePlatform('win32', { profile })`. Its teardown unwinds repeated overrides.
Keep these tests serial within each worker; concurrent tests share process state.
The guard in `test/unit/testing/windows-simulation-guard.test.mjs` rejects direct
platform overrides, including overrides embedded in child-process source strings.
The helper has no Vitest dependency, so child snippets can import `withWindows` too.

Windows simulation sets USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA,
TEMP/TMP and stubs both default and named `os.homedir()` imports. The default
profile is the current USERPROFILE or home; pass a Windows-shaped profile for
pure path tests. `os.tmpdir()` stays on the host temp directory so real fixtures
can still use `mkdtemp`. All overridden values are restored after the scope.
Use `windowsPath('C', 'Program Files', 'AIWG')` and
`uncPath('server', 'share', 'folder with spaces')` to build Windows strings.
Use `createJunction(target, link)` for real filesystem fixtures: it resolves an
absolute target and passes `'junction'`, matching staged provider references.

`assertWindowsCommandSafe(command)` checks portable literal hook/launcher
commands: double quotes protect path operands; single quotes alone do not quote
for cmd.exe; `%VAR%` expands even inside cmd.exe quotes; PowerShell expands
`$VAR` in double quotes and interprets backticks. Encode path data containing
these characters, as `verifiedHookCommand` does. The assertion conservatively
requires quoting all Windows path operands and rejects shell control syntax.

Simulation does not change Node's default `path` implementation (use
`path.win32` for pure Windows paths). Native `os.platform()` and separately
spawned processes still report the host OS. It does not emulate NTFS permissions or junction
semantics, or execute real cmd.exe/PowerShell parsing. On Linux the junction is
a directory symlink. Command assertions check a portable subset; they are not a
shell parser or a substitute for future tests on a Windows runner.

## Default shard balance and release infrastructure tests

The four default CI shards use Vitest's native `--shard=INDEX/COUNT` interface
with `tools/testing/duration-sequencer.mjs`. It sorts files by measured duration
(longest first, path order for ties) and places each file in the lightest shard
(lowest shard index for ties). Each shard also starts its longest measured
files first, avoiding a late heavy file after other workers finish. Unmeasured files use `defaultSeconds` from
`config/test-durations.json`, so adding a file never excludes it. The inventory
gate invokes the configured sequencer and proves a disjoint, complete partition:

```bash
node tools/testing/check-native-shards.mjs 4
npm test -- --shard=1/4 --maxWorkers=4
```

Refresh the checked-in map after a representative full run. The extra reporter
records file durations including module imports, setup and suite hooks; ordinary
Vitest JSON reports are also accepted, but omit imports, setup, and leading and
trailing suite hooks. Multiple reports can
be supplied together when collecting CI shards. Refreshing preserves existing
entries for files absent from the supplied reports.

```bash
npm test -- --maxWorkers=6 --reporter=default --reporter=./tools/testing/refresh-test-durations.mjs
npm run test:durations -- test-results/file-durations.json
node tools/testing/check-native-shards.mjs 4
```

`config/test-lanes.mjs` assigns exhaustive provider deployment matrices to
`test:release-slow`; default shards exclude them. Small public CLI deployment
smokes and focused CLI contracts remain on every merge. The `test:deployment`
lane owns the full-corpus deployment suites and runs them one file at a time.
CI splits it into two shards (`deploymentShards` in `config/test-lanes.mjs`),
selected with `AIWG_DEPLOYMENT_SHARD=1` or `2`. Locally, `npm run test:deployment`
runs every file. When you add a deployment suite, add it to the shard whose
measured time is lower. See
[release validation](versioning.md#publication-surfaces-and-release-infrastructure-validation) for the
required pre-tag/publication gates and manual workflow entry point.

## Minimum Test Coverage

| Category | Minimum Coverage | Current |
|----------|-----------------|---------|
| Line coverage | 80% | Enforced via CI |
| Branch coverage | 75% | Enforced via CI |
| Function coverage | 90% | Enforced via CI |

## PR Requirements

### For Significant Changes

1. **All tests passing**: 0 failures allowed
2. **Provider validation**: Verified deployment to at least Claude, Factory, OpenAI
3. **Lint clean**: No markdown lint errors in modified files
4. **Manifest updated**: New commands/agents/skills added to manifest
5. **README updated**: New features documented in relevant README

### For Documentation-Only Changes

1. **Lint clean**: No markdown lint errors
2. **Links valid**: All internal links resolve

## Automated CI Checks

The following are enforced automatically on all PRs:

- `npm test` - Full test suite
- `markdownlint-cli2` - Markdown linting
- Type checking via TypeScript
- Coverage thresholds

## Manual Verification

Some checks require manual verification before merge:

- [ ] Deployed to Claude Code and verified new content appears
- [ ] Deployed to at least one other provider (Factory or OpenAI)
- [ ] Tested command/agent functionality in actual session
- [ ] Verified no regressions in existing functionality
