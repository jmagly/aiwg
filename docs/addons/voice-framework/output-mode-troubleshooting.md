# Troubleshoot output modes

## The selected mode has no visible effect

Run:

```bash
aiwg output-mode status
```

If the mode appears, confirm the actual skill, script, or provider adapter consumes `AIWG_OUTPUT_MODES_JSON`. Selection resolves and exports policy; it does not intercept arbitrary provider responses or rewrite stdout from an unaware script.

For one invocation, place wrapper modes before `--`:

```bash
aiwg run skill <name> --output-mode personal-syntax -- <skill-arguments>
```

## `Unknown output mode`

Check the ID and registry:

```bash
aiwg output-mode list
aiwg output-mode show <id>
```

Project profiles must be in `.aiwg/output-modes/`. Personal profiles must be in the `output-modes/` directory below `aiwg config path`. File extensions must be `.yaml`, `.yml`, or `.json`.

## A personal profile is not found

Do not assume the active directory is `~/.config/aiwg`. AIWG may use `AIWG_CONFIG`, an active provider runtime, `~/.aiwg`, or the XDG-compatible fallback. Locate it with:

```bash
aiwg config path
```

Then place the profile below that directory's `output-modes/` folder.

## Profile validation fails

The diagnostic names the file and invalid field. Common causes are:

- uppercase, spaces, or underscores in `id`;
- a missing required field;
- an unknown `kind`, `stage`, validation level, or protected-content class;
- duplicate IDs within the same project or user directory;
- `validated` without `validation.hook`;
- `conformance` without both `validation.hook` and `validation.standardVersion`;
- an extra field not defined by the schema.

Compare the profile with [the custom-profile guide](./custom-output-modes.md) and [the schema](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/voice-framework/schemas/output-mode-profile.schema.json).

## Two modes conflict

`aiwg output-mode status` validates the entire effective stack. Two modes of the same non-voice kind cannot compose. Multiple voice modes require `mergeStrategy: weighted-voice`. A profile may also declare an explicit `conflicts` entry.

Session state can conflict with a proposed project mode. Clear the session state, then retry only if the project combination is itself valid:

```bash
aiwg output-mode clear --scope session
aiwg output-mode enable <id> --scope project
```

AIWG validates proposed session and project stacks before saving them. A failed enable or disable operation leaves the previous state intact.

## A required mode is missing

If a profile declares `requires`, enable every listed ID in the effective stack. Requirements are not selected automatically.

```bash
aiwg output-mode show <id>
aiwg output-mode status --output-mode <required-id> --output-mode <id>
```

## Mandatory validation cannot run

A `validated` or `conformance` profile must declare a hook, and the consumer must map that ID to an implemented validator. AIWG never executes a hook value as a shell command. Add the allowlisted validator integration or reduce the profile to `advisory` without making a validation or conformance claim.

## Protected content causes a failure

The transformer removed, altered, or duplicated an opaque placeholder. Adjust the transform prompt or deterministic rewriter so every placeholder is returned exactly once. Add a regression case containing the affected literal class.

Protected spans are restored exactly; the mode cannot intentionally reformat code, commands, citations, quotations, identifiers, or machine-readable blocks while those classes are protected.

## Reset to unaltered output

```bash
aiwg output-mode clear --scope session
aiwg output-mode clear --scope project
aiwg output-mode status
```

The final status should report `Effective output mode: unaltered` and `No transformations active.`
