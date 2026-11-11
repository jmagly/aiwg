# Workspace Repository Access

AIWG treats filesystem/tool capability and repository authorization as separate
things. A writable clone is not automatically authorized for edits, commits,
pushes, tracker comments, service actions, or destructive work.

## Canonical manifest

The preferred manifest is the workspace root's `.aiwg/aiwg.config`:

```json
{
  "version": "1",
  "providers": ["codex"],
  "installed": {},
  "scripts": {},
  "workspace": {
    "name": "home",
    "root": "~/dev"
  },
  "repos": [
    {
      "name": "aiwg",
      "path": "./aiwg",
      "allowed": ["read", "write", "commit", "push", "issue-comment"]
    },
    {
      "name": "sysops",
      "path": "/srv/ops/sysops",
      "provider": "gitea",
      "allowed": ["read", "issue-comment"],
      "notes": "handoff-only"
    }
  ]
}
```

Relative member paths resolve from `workspace.root`, or from the repository
containing the workspace config when `workspace.root` is absent. Absolute paths
may point anywhere on the system.

Each member has its own `<member>/.aiwg/aiwg.config`. That member config—not the
workspace root config—controls:

- `delivery`, including branch mode, default branch, committer, commit signing,
  and distinct release-tag signing;
- `remotes.primary`, `remotes.issue_tracker`, and `remotes.ci`;
- `remotes.tracker_actor`, including `forbid_actors`;
- `remotes.transport`, including the authenticated forge login, protocol,
  project helper, and public SSH key fingerprint;
- issue taxonomy and other repo-local policy.

Remote URLs are read from the member clone, so provider and domain routing is
per member. The optional `repos[].provider` field is only a hint for self-hosted
domains whose forge type cannot be identified from the URL; a detectable URL
takes precedence.

## Authorization semantics

The effective permission is an intersection:

1. the target must resolve to a listed workspace member;
2. `repos[].allowed` must contain the operation;
3. the member's own config must permit and correctly route the workflow;
4. repo-local instructions may narrow access further.

Unlisted paths and unlisted actions deny by default, regardless of filesystem
writability or which tools are available.

Allowed operations:

- `read`
- `write`
- `commit`
- `push`
- `issue-comment`
- `service-action`
- `destructive`

## External member discovery

An absolute member can be resolved when a command starts from the workspace root
or receives that root explicitly. If commands also start directly inside the
external member, add a back-reference to the member config:

```json
{
  "workspace": {
    "member_of": "/home/me/dev/workspace-root"
  }
}
```

`AIWG_WORKSPACE=/home/me/dev/workspace-root` is the explicit process-level
alternative. A `member_of` config cannot also declare `repos`.

## CLI

```bash
aiwg repo-access list
aiwg repo-access status
aiwg repo-access explain --path /srv/ops/sysops
aiwg repo-access check --path /srv/ops/sysops --action issue-comment
aiwg repo-access check --path /srv/ops/sysops --action write
```

`list` and `status` show each member's resolved provider/domain, delivery mode,
tracker route, config path, and drift. `check` exits `0` for allowed, `1` for
denied, and `2` for invalid manifests or usage.

If no manifest is configured, `check` exits `2` and names the canonical
`.aiwg/aiwg.config` `workspace` + `repos` blocks, the legacy YAML fallbacks,
and the registration command. With operator authorization, register the repo
in an existing project config:

```bash
aiwg repo-access add --path /srv/ops/sysops --name sysops --allow read,issue-comment
```

`add` writes `repos` entries to `.aiwg/aiwg.config`; it does not create a legacy
YAML manifest. The config must already exist. Grant only the authorized actions.

## Legacy manifest compatibility

Existing YAML manifests remain supported when the nearest workspace config does
not declare `repos`:

```text
.aiwg/ops/security/repo-access.manifest.yaml
.aiwg/security/repo-access.manifest.yaml
```

```yaml
version: "1"
default_policy: deny
repos:
  - name: project
    path: .
    actions: [read, write, commit, push, issue-comment]
```

When both formats exist, `.aiwg/aiwg.config` is authoritative. Migrate by
copying each YAML `repos[]` entry into the root config, renaming `actions` to
`allowed`, adding `workspace.name`, and then removing the YAML file after
`aiwg repo-access status` reports the expected members.

## Ops workspace compatibility

`aiwg ops` remains an ops-framework specialization. Its registry adapts to the
same `workspace`/`repos` shape; when a canonical workspace config is present,
ops pushes use each member's configured primary remote/default branch and honor
the member's `push` capability. The user-level ops registry is not a second
authorization source.

The `respect-repo-access-manifest` rule requires this preflight for all
cross-repository operations and mutations.
