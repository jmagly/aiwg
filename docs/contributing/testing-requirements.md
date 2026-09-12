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
