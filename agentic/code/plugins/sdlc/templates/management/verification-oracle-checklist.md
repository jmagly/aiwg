---
name: verification-oracle-checklist
description: Independent conductor verification and PR evidence checklist for milestone issue delivery
---

# Verification oracle checklist

Use with each brief's `verificationOracle`; record observations, not worker claims.

- [ ] Each acceptance ID maps to an executable command, cwd, inputs, expected
  exit and observable result; missing or unsafe checks block dispatch.
- [ ] Tests fail for the original behavior before implementation and pass after;
  touched tests and neighbors pass without weakened assertions.
- [ ] Conductor inspects the diff and independently runs checks outside the writer
  sandbox on the exact head intended for delivery; record base/head/tree digests.
- [ ] Build the branch; resolve the actual executable/module path and revision.
  Verify the real build, not the installed runtime or stale build output.
- [ ] A real run beats stubs for I/O-boundary fixes: exercise the filesystem,
  CLI, HTTP or MCP boundary read-only with authorized inputs, or a fake local
  fixture. Record any fixture limitation; do not claim untested live behavior.
- [ ] Record observed stdout/stderr, exit codes, test counts and evidence refs.
  Independent review covers the current head under subagent-scoping requirements.
- [ ] Changed bytes after verification trigger a fresh check of the resulting head.
- [ ] PR body separates worker claims from independent conductor observations.
- [ ] Required author/committer, signature/key and signed local merge are confirmed
  under repository delivery policy; PR/issue closure is reconciled with merge SHA.
- [ ] Watch post-merge CI for that SHA on the configured default branch (main).
  Queued, missing or unavailable CI is pending, not green.
- [ ] Red CI: retain logs, instrument/root-cause, fix forward on a new branch,
  link the follow-up, verify and watch the resulting main run until green.
- [ ] Archive evidence before worktree cleanup; record activity and checkpoint.

## PR body evidence block

```markdown
### Independent conductor verification
- Issue / acceptance IDs: <IDs>
- Worker claims: <summary and archived final-output reference>
- Verified base / head / tree digest: <values>
- Branch build identity: <build command, resolved entrypoint and revision/digest>

| Acceptance ID | Conductor command / cwd | Expected | Observed exit / counts / result | Evidence |
| --- | --- | --- | --- | --- |
| <ID> | <exact command> | <oracle> | <independently observed result> | <ref> |

- Current-head independent review: <ref and unresolved findings>
- Limitations / deferred criteria: <reason or none>
- Delivery policy / merge identity and signature check: <required checks>
- Post-merge CI: pending until <default-branch SHA, run URL/ID, conclusion>;
  fix-forward: <follow-up link/result if needed>.
- Closure evidence / archived worker evidence / activity / checkpoint: <refs>
```

Update the CI and merge evidence after merge through the authorized tracker
surface. A pre-merge PR evidence block cannot assert future CI success.
