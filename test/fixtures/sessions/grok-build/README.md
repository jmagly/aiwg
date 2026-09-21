# Sanitized Grok Build CLI export fixtures

These synthetic fixtures reproduce the documented output of `grok export <id>
[file]` at public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. The upstream renderer emits only
exact `## User`, `## Assistant`, and `## Tools` sections. The fixture text
contains no account, credential, machine, or repository data.

The cases model visible transcript content, resumed/forked-session wording,
partial content, and changed headings. The Markdown contract intentionally
omits TUI/headless/ACP mode, timestamps, model/version, cwd, compaction markers,
lineage, subagents, attachments, snapshots, and tool results. Tests assert that
AIWG reports those fields as unavailable rather than reconstructing them. These
synthetic exports do not claim to qualify those omitted native scenarios.

Direct `$GROK_HOME/sessions` fixtures are absent by design. Native parsing stays
disabled until sanitized files from a released binary establish the complete
schema and a qualified version range.
