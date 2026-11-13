# Enforced worker delivery

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md).

Use `aiwg ralph-external --run-conductor` for Tier 0 runs whose deliverables must
contain only verifier-accepted bytes. The operator starts the existing MCP server
outside the conductor unit. No additional daemon or socket service is needed.

The host must enforce systemd user-unit namespaces. On affected Ubuntu hosts,
#4128's systemd-executor AppArmor configuration is required. The live isolation
probe must report enforced write confinement, home-read isolation and tmp
isolation; otherwise launch fails with `ISOLATION_UNAVAILABLE`, with no degraded
override. Verification additionally requires network isolation for protected checks.

Create a dedicated deliverable directory before launch. Protect that directory,
so renames, newly created files and editor writes are covered together. Each grant
must be an existing canonical absolute path without systemd path metacharacters.
The conductor root and repeatable `--bind` directories get `BindPaths=` and
`ReadWritePaths=`; `ReadWritePaths=` alone cannot reveal paths hidden by
`ProtectHome=tmpfs` or `PrivateTmp=yes` (#4130). Each repeatable `--deliverable`
gets `ReadOnlyPaths=`. Use repeatable `--bind-ro ABS_DIR` for CLI installation
directories and the AIWG build: these get `BindReadOnlyPaths=` and remain readable
without becoming writable. Writable grants cannot equal or sit inside a read-only
bind. Network remains enabled for APIs and localhost MCP.

The confined unit is named `aiwg-conductor-<pid>-<time>`. When `systemd-run` returns for any
reason, including a SIGTERM, SIGINT or SIGHUP sent to the wrapper's process group, the wrapper
stops that unit from outside, so a supervisor's timeout cannot leave the conductor running.
Add `--max-runtime-seconds N` (`RuntimeMaxSec=`) as a hard cap that holds even if the wrapper
itself is killed with SIGKILL.

Pass real paths for every grant. When `$HOME` or an install directory is a symlink
from `/home` to `/srv`, resolve it with `realpath` in the operator shell and pass
the resulting `/srv/...` path; symlink spellings are refused.

```sh
# Operator shell, outside the confined unit; configure the existing effect-ledger
# signing key first (aiwg effect keys init). Use a dedicated bearer environment.
aiwg mcp serve --toolsets workers --transport http --port 3100 \
  --project /absolute/project --token-env AIWG_DELIVERY_TOKEN \
  --tools worker-invoke,worker-verify-deliver

# Separate operator shell. Values are inherited by name, never placed in argv.
aiwg ralph-external --run-conductor \
  --conductor-root /absolute/project/control \
  --deliverable /absolute/project/control/deliver \
  --bind-ro /absolute/cli-install --bind-ro /absolute/aiwg-build \
  --setenv AIWG_DELIVERY_TOKEN \
  -- /bin/sh /absolute/project/control/start.sh
```

The HTTP listener requires bearer authentication and rejects non-localhost binds
when `workers` is enabled, even with `--allow-remote-bind`. Its workers exposure is
`worker-invoke` (including its `status` operation) and `worker-verify-deliver`.
`artifact-write` is disabled for that listener to prevent an alternate publication route. The
conductor unit hides `/run/user` and `/run/dbus`, clears manager connection
environment variables, and asserts the user-manager bus is unreachable before
executing the conductor. Never grant manager sockets through another path.

Inside the unit, call `worker-invoke` with `operation: "run"` and the bounded
brief's `role`, `task`, `group`, `brief`, `workdir`, `final_output`, `request_id`
and selected worker `transport` (normally `"shell"` for a CLI worker). The tool
resolves the selection on the external server before launch. Keep the MCP
session ID for subsequent `worker-invoke`
calls with `operation: "status"` and `invocation_id` set to the returned `invocationId`.
Native shell workers return an absolute `run_dir` in the run response and status.
For systemd shell workers, supply `run_dir` to select the owned-capture path;
omitting it retains the legacy dispatch path, which has no run record.
Pass it unchanged to `worker-verify-deliver` after confirmed termination. Optionally
choose an absolute `run_dir` in the served project when invoking the worker; its
parent must exist and the directory must be absent or empty, private and owned.
The launcher refuses run metadata inside any qualified worker-writable root. The server must
remain outside the unit: it launches workers with their selected native sandbox
or systemd isolation. Launching a worker CLI or `--launch-worker` inside the
conductor unit nests sandboxes and cannot reach the hidden user-manager bus.
The served project must contain the brief, prepared worker worktree and final
output path. Worker context deployment selects only that worker's provider,
uses project scope and keeps deploy-time state in the worker tree; an already
present provider bootstrap skips deployment.

Call `worker-verify-deliver` with `run_dir`, `deliverable_path`, optional
`artifact_path`, and a nonempty `checks` array. Each check has a unique `id`, an
absolute `command`, and optional `args`, `cwd`, `envNames`, `timeoutMs`. These
checks belong to conductor policy; worker claims and manifests never define them.
All artifact/run/destination paths are constrained to the served project root.
Use existing launcher-owned run records and confirmed-stop evidence. Workers
must have independently qualified writable roots; deliverables must be outside
those roots. Workers launched by the external server use their normal worker
isolation; the confinement wrapper does not change their sandbox policy.

Native shell launches and shell calls supplying `run_dir` use the same one-shot launcher and capture owner as
`--launch-worker`: `invocation.json`, `.launch-owner`, kernel termination records,
final evidence and sealed captures belong to that owner. Status and worker claims
are observations; the verifier independently authenticates the returned run.
The probe below launches a fake CLI through MCP, lets it create the artifact in
its own tree, then passes that launch's returned `run_dir` to MCP verification and delivery.

Only `accepted` results publish. The verifier reopens the source and checks the
bytes against `artifactDigest` immediately before atomic publication. Blocked,
rejected or changed artifacts leave the destination untouched. A signed effect
intent precedes publication; a completed delivery record follows and includes
the digest, destination, verifier ID, run directory and invocation ID.

```sh
aiwg ralph-external --verify-worker --delivery-status \
  --deliverable /absolute/project/control/deliver/answer.json --json
```

Run the helper from the same served project directory. It exits zero only when the current digest matches a completed,
signature-checked delivery record. Missing records and later edits are unverified.
A crash or ledger failure after rename can leave delivered bytes without a
completed receipt; the helper reports them unverified. Installed CLI/server code, ledger configuration, signing keys and ledger storage
must remain outside conductor-writable grants (use an external artifact root when
necessary). The ledger proves recorded delivery, not that the checks were sufficient.

Confinement covers declared paths, not other conductor behavior, remote effects,
or unprotected output. An operator or another host process can still alter files.
File-only bind mounts may retain the old inode after server replacement: protect
the containing deliverable directory to see published replacements. The optional
`AIWG_LIVE_CONDUCTOR_PROBE=1 node tools/testing/probe-conductor.mjs` uses
synthetic files, `/bin/sh`, a fake worker CLI exercising native bwrap, and local
MCP; it checks read-only binds and that the worker runs outside the conductor's
cgroup. It skips hosts without enforced namespaces.
No model CLI or paid API call is involved. #2918 direct-02/direct-19 reruns on
noodle remain an operator acceptance step before the 40-row study.
