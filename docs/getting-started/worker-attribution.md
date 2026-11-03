# Worker attribution and capacity recovery

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This page covers
> how worker capacity is counted and how to recover a blocked launch.

AIWG launchers and rendered `models resolve --format shell` commands set
`AIWG_WORKER_INVOCATION_ID`, `AIWG_WORKER_WORKSPACE`, and `AIWG_WORKER_GROUP`.
The workspace is the canonical absolute worker workdir (symlinks resolved when
available). Use the same workdir when checking a group's occupancy. Separate
worktrees have separate workspace identities. These markers describe ownership
within the current UID; they are not a security boundary against that UID.

The host census counts each running/activating current-user `aiwg-worker-*.service`
once, plus distinct invocation IDs outside those units. Descendants sharing an
invocation ID count once, including descendants observed outside the original
unit. Exact workspace/group marker pairs supply group occupancy, independent of
opaque service names. Conflicting pairs remain unattributed. Without marker
pairs, unambiguous exact or configured group prefixes in unit/invocation names retain their legacy group
attribution. These legacy names do not establish a different workspace; explicit
workspace/group markers take precedence over names.

Unattributed workers retain their host occupancy. They consume `max_workers` and
the aggregate `max_parallel_subagents` ceiling, and count against every named
group's cap. Attributed workers from another workspace consume host capacity only;
attributed workers from another group in this workspace consume that group's cap.
Other tuple caps lacking attribution continue using total occupancy.
A full attributed group produces `OG_HOST_CAPACITY`; host occupancy involving
unknown ownership produces `OG_HOST_ATTRIBUTION`, including group refusals
caused by unknown workers. Neither means that the adapter is unqualified. Resource reports expose `workerAttributions` (unit/invocation ID,
count, attribution status and any workspace/group), `workerUnknown`, and
`workerWorkspace`; capacity diagnostics include the counted identities.

For a blocked review, run this read-only command from its workdir:

```bash
aiwg doctor --resources --group reviews --json
```

Retain the collection timestamp, freshness, thresholds/origins, failures,
`workerAttributions`, `workerUnknown`, and `workerGroups`. For each reported unit,
inspect its current identity without stopping it:

```bash
systemctl --user show aiwg-worker-EXACT-NAME.service \
  --property=Id --property=MainPID --property=ControlGroup --property=ActiveState
```

An owner can correlate the exact unit/cgroup and invocation ID with their
launcher-owned `invocation.json` and `process.json` records, and inspect only the
three `AIWG_WORKER_*` marker fields in that process's environment. Preserve the
workspace, group, UID and cgroup evidence together; a service name or informational
Codex/Muse process count is insufficient attribution.

Older live jobs without markers or unambiguous legacy group names remain unknown
until they finish. Do not stop or
relabel another owner's jobs, add fabricated markers, or raise caps to reconcile
them. Unknown jobs continue to occupy every group's cap even with host headroom.
Wait for their owner's normal completion or use another qualified host, then
refresh the report. For your next attempt, re-resolve and run the exact newly rendered command (or the normal AIWG launcher)
to obtain markers automatically. No qualification run is needed to repair a
capacity refusal.
