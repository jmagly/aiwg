# Sanitized Grok Build CLI export fixtures

These synthetic fixtures reproduce the documented output of `grok export <id>
[file]` at public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. The upstream renderer emits only
exact `## User`, `## Assistant`, and `## Tools` sections. The fixture text
contains no account, credential, machine, or repository data.

The `coverage.json` manifest maps synthetic CLI projection cases for TUI,
headless, ACP, compaction, resume/fork, subagent, attachments/snapshots, partial,
corrupt, and changed-heading inputs. It explicitly marks which cases are only
loss assertions and still lack native evidence. The Markdown contract intentionally
omits TUI/headless/ACP mode, timestamps, model/version, cwd, compaction markers,
lineage, subagents, attachments, snapshots, and tool results. Tests assert that
AIWG reports those fields as unavailable rather than reconstructing them. These
synthetic exports do not claim to qualify those omitted native scenarios.

## Released-binary projection

See [captured-1.0.77](captured-1.0.77/README.md) for sanitized TUI and headless
CLI captures and native text/tool record shapes from 2026-11-09. These supersede
the earlier invented native record contract. Direct native projection requires
`AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1` and exact
`AIWG_GROK_BUILD_NATIVE_VERSION=1.0.77` or `1.0.92`, plus an authorized root.
Missing scenario captures remain deferred as listed there; the older `coverage.json` continues
to describe synthetic CLI loss assertions, not released native qualification.

The [2026-11-23 fixtures](captured-1.0.92-20261123/README.md) are from Grok Build
1.0.92, corrected from the original label; their historical directory name and
captured bytes are retained. Earlier 2026-11-09/10 fixtures remain 1.0.77.

`native-layout/` uses the observed chat record shapes with synthetic content and
matching `summary.json`. `session_search.sqlite` is an empty enumeration decoy,
never opened. `native-active-sessions.json` is still an AIWG-defined synthetic
registry fixture; no released-binary live-detection compatibility is claimed.
