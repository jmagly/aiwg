# Scope And Recovery

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Use this page when AIWG seems installed but the agent is looking at the wrong files, missing project context, or writing setup into the wrong folder. Each section starts with what you can ask your assistant, then gives the command reference.

People often run setup from `$HOME`, `/tmp`, or another convenient shell location, then the AI assistant has no useful project context. The fix is usually not a new framework. It is moving to the right folder and verifying scope.

We chose a recovery page instead of a hard error because the warning is meant to protect beginners without breaking automation. While `$HOME` and `/tmp` are difficult defaults for project context, some empty-project setups are valid. Treat the warning as a 30s pause, not a failure.

Validation baseline: test this page against AIWG version 2026.5. While the recovery flow is deliberately short, maintainers should record any issue that failed inside the first 300s of folder diagnosis.

## The Default: Project Scope

> "Am I in the right project folder? Check for project signals and tell me whether to move before deploying."

Your assistant checks the current folder for project signals and confirms scope before you deploy.

For a single project, project-scoped setup is the simplest start. Run AIWG from the folder that contains the project you want the AI assistant to understand:

For multi-repository work, see [Working Across Multiple Projects](../guides/multi-project-workspaces.md).


Good signs include `.git/`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or another project file. After deploy, you should also see `.aiwg/` and provider files such as `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, or `AGENTS.md`.

### Command reference

```bash
cd /path/to/your/project
pwd
ls -a
aiwg wizard --dry-run --goal "help me start a project"
```

## Global Or User Scope

> "Should this AIWG capability be project-scoped or available across projects?"

Your assistant asks you to finish the sentence below so the capability lands in the intended scope.

Choose shared capabilities deliberately; you should be able to finish this sentence:

```text
I want this AIWG capability available across projects because ...
```

Global or user-scoped setup is for capabilities you intentionally want across many projects, such as personal defaults or provider-level reusable skills. It is not the beginner default because it does not by itself teach AIWG about a specific project.

## If You Ran AIWG In The Wrong Folder

> "I may be in the wrong folder. Check where I am and tell me how to recover."

Your assistant checks the current location, names the recovery move, and previews the wizard from the right project root.

Stop before adding more frameworks. Check where you are:

If the folder is `$HOME`, `/tmp`, `/`, or another place that is not your project, move to the intended project root and rerun the wizard preview:

Then deploy from the correct folder:

### Command reference

```bash
pwd
ls -a
aiwg status --probe --json
```

```bash
cd /path/to/the/right/project
aiwg wizard --dry-run --goal "help me start a project"
```

```bash
aiwg wizard
```

## What The Project-Isolation Warning Means

> "AIWG warned that no project was detected here. Should I continue or move first?"

Your assistant explains that the warning is informational and tells you whether your folder is an intentional setup or a beginner pause point.

`aiwg use` may warn:

```text
No project detected here. AIWG will deploy to the current directory. To associate AIWG with a specific project, run this from your project root.
```

That warning is informational. It does not block the command because some users intentionally deploy to new or unusual folders. For beginners, treat it as a pause point: confirm the folder before continuing.

The warning is deliberately non-blocking. Blocking unusual directories would break valid automation and empty-project setup, but staying silent makes the beginner failure difficult to diagnose.

## Recovery Prompt

> "I may be in the wrong folder. Check pwd, list the project signals you see, run or read aiwg status --probe --json, and tell me whether I should move before deploying AIWG."

Your assistant checks the working directory, lists project signals, reads the probe report, and tells you whether to move before deploying.

Ask the agent:

### Command reference

```text
I may be in the wrong folder. Check pwd, list the project signals you see, run or read aiwg status --probe --json, and tell me whether I should move before deploying AIWG.
```

```bash
aiwg status --probe --json
```

## Undo A Framework Deploy

> "Remove the marketing framework from this project and show me what will change first"

Your assistant starts in the project folder and runs a dry run. The preview lists
recorded agents, commands, rules, skills, hook scripts and settings contributions,
with a reason for each removal, restoration or preserved path. Settings lines
include the key path, such as `.claude/settings.json#/aiwg/mode`. The preview
writes nothing; review it before asking your assistant to apply the removal.

Removal restores recorded pre-deploy settings values, or deletes keys that did
not exist before deployment. When another framework still contributes a value
or hook, its contribution stays. For example, removing marketing after deploying
SDLC and marketing leaves the SDLC settings and shared hooks in place. Removing
both restores the pre-deploy settings, including the original file bytes when
nothing was edited and the deploy recorded a byte preimage.

Edited files, settings values and hook entries are kept and reported. Shared
files stay while their receipt releases only the selected framework's ownership.
Files and settings without verifiable ownership or pre-deploy values are kept;
older deployments may need manual review. Shared context bridges such as
`CLAUDE.md` are kept when their pre-deploy operator content cannot be verified.
Do not delete these paths just because they appeared in the deploy directory.

A partial removal retains unresolved contributions in the ownership receipts and
keeps deployment records for them. A second run leaves operator edits intact;
after you reconcile an edited value with its recorded deployed value, rerun the
same command to finish. Completed contributions are released from the receipts
so they are not restored again. File deletions, settings restoration, receipt
updates and deployment-record updates share a transaction: a failed restoration
rolls them back together and reports the recovery journal path.

### Command reference

```bash
cd /path/to/your/project
aiwg remove marketing --dry-run
aiwg remove marketing
# Limit the preview or removal to a recorded provider:
aiwg remove marketing --provider claude --dry-run
# After reviewing the first removal, preview the remaining framework:
aiwg remove sdlc --dry-run
```

`--keep-registry` keeps installed/deployedTo records. `--force` does not override
bundled framework ownership checks or overwrite operator edits.

## Related

- [Start Here](start-here.md)
- [Provider Handoff](provider-handoff.md)
- [Verify AIWG Is Working](verify-aiwg-is-working.md)
