# Grok Build 1.0.92 headless captures (2026-11-23)

Operator-supplied captures from titan, Grok Build 1.0.92 and
`grok-4.7-build-fast`, replayed offline. The supplied capture directory was
`/tmp/r119/grokcap`; repository code and tests use only this fixture tree.

Version corrected by the conductor on 2026-11-24: the source binary reported
`grok 1.0.92 (b06756fd6256) [stable]` after its 2026-11-21 auto-update.
The historical directory name is retained; it does not identify the capture
version. Captured fixture bytes are unchanged by this correction.

The source store was `$GROK_HOME/sessions/<url-encoded-project>/<session-id>/`.
Project paths were sanitized to `/absolute/temp/project` and home to `$HOME`.
This projection additionally replaces system/user context, system reminders,
reasoning summaries and opaque encrypted reasoning with synthetic placeholders;
assistant fingerprints are removed. MCP diagnostic details in `events.jsonl`
are replaced with `sanitized: true`; these events are not parser fixtures.
Session/request/tool IDs, timestamps, ordering, model IDs, chat format, actual
user prompts, tool payloads, inline file text and explicit lineage are retained.

| Capture | Session ID suffix | Observation |
| --- | --- | --- |
| `s1-attach.jsonl` | `1f0e7ec2a5d2` | `@notes.txt` is embedded in prompt 0 as `<attached_files>/<file_contents>` text. |
| `s2-bigtool.jsonl` | `9adae4461f51` | The tool execution was cancelled before a large file read; no large tool output was captured. |
| `s3-continue.jsonl` | `9adae4461f51` | `--continue` retains the session ID and appends `continued-ok`. |
| `s4-fork.jsonl` | `ce69b0d6a1ff` | `--continue --fork-session` creates a new ID with parent ID and fork time in its summary. |

The cancelled stream has a `tool_call_update` with `status: failed`, a text
content block saying `User cancelled the execution for tool
\`run_terminal_command\``, and terminal `stopReason: cancelled`.
Chat history retains that text as the corresponding `tool_result`; Markdown
export retains the tool command summary and omits the result. The resumed
store includes both turns; the fork copies their history under the new ID.

Each native directory retains `summary.json`, `chat_history.jsonl`, diagnostic
`events.jsonl`, and `rewind_points.jsonl`. All captured rewind snapshot maps
are empty: these captures establish inline text ownership by session/prompt,
not external attachment or before/after snapshot ownership. The reader never
opens rewind points, diagnostics, attachment paths or snapshot files.
`export-<id>.md` files are the public CLI exports; import tests copy them to
the required `<id>.md` basename.

Compaction did not trigger in these captures. Earlier 2026-11-10 ACP and set-b
TUI fixtures remain the evidence for the existing text-only compaction path.
No new TUI, ACP, subagent, image or external snapshot behavior is qualified here.
Corrupt/partial/schema-change cases in the regression suite are synthetic
mutations, not observations of a live corrupted store.
