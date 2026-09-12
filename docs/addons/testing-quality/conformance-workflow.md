# Test conformance workflow

The testing-quality addon couples an explicit target protocol with executable inventory, evidence collection, assessment
and guarded normalization. Agents supply semantic review; the CLI supplies repeatable artifact handling and enforcement.
A report never turns static screening or a passing runner into proof that every test is meaningful.

## Deploy and orient

Deploy the addon using the `use` skill and `aiwg use testing-quality --provider <provider>`. This registers `aiwg
test-conformance` and makes the roles/skills discoverable. The provider selects how roles run; YAML flows describe agent
work, not a separate shell scheduler. For an installation without namespace registration, use the equivalent direct
entry point:

```bash
node "$AIWG_ROOT/agentic/code/addons/testing-quality/commands/test-conformance.mjs" --help
```

Run commands with `--root /path/to/target`; it defaults to the current directory. Protocol and artifact paths are
relative to the target. The default protocol path is `.aiwg/testing/conformance.yaml`. Machine outputs are versioned
artifacts; create new output paths for independent runs. Do not overwrite the original audit with post-repair evidence.

## Configure the target protocol

```bash
aiwg test-conformance init --root /path/to/target --platform auto --system example-service --name example-tests --output .aiwg/testing/conformance.yaml
aiwg test-conformance validate --root /path/to/target --input .aiwg/testing/conformance.yaml --schema conformance-protocol.v1
```

Review generated configuration using [protocol review](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/protocol-review.md). Auto-detection is a starting
point, not qualification. Protocol fields are `spec.platform`, `system`, `source`, `tests`, `areas`, `lanes`, `policy`
and `research`. Source/test include and exclude globs are explicit. Areas have stable IDs and include globs; a directory
label alone does not define an observed test type or SUT boundary.

Each lane has an ID, runner, include/exclude, required flag, command `{argv, timeoutMs, env?}` and result
`{format,path?}`. Optional discovery has its own command/result. Commands run target code: discovery can import modules,
initialize fixtures or invoke a compiler. Inspect configured commands and prerequisites before executing the authorized
scope. Result paths can use `{runId}` to preserve distinct raw reports. Missing discovery is unknown registration, even
when policy does not require it.

Negative controls bind an ID and description to a `changePlan`, command/result and affected `testIds`. They must
deliberately break the claimed behavior and show those tests reject it. A command exiting because its dependency is
missing does not qualify. Source-bound review and controls must be refreshed after source changes.

The protocol policy states required discovery/review/negative controls, skip handling, coverage thresholds and resource
limits. Decide coverage thresholds for the actual system, source denominator and risk. Preserve excluded lanes and
metrics as limitations. Research paths are user-configured local roots; `allowWeb` records web research policy.

## Inventory, sampling and evidence

```bash
aiwg test-conformance inventory --root /path/to/target --output .aiwg/testing/inventory-01.json
aiwg test-conformance sample --root /path/to/target --inventory .aiwg/testing/inventory-01.json --unit test-file --seed audit-2026-09 --size 20 --output .aiwg/testing/sample-01.json
aiwg test-conformance collect --root /path/to/target --mode discovery --lane all --output .aiwg/testing/discovery-01.json
aiwg test-conformance collect --root /path/to/target --mode execution --lane all --output .aiwg/testing/execution-01.json
```

Use `sample --unit registered-case --evidence .aiwg/testing/discovery-01.json` when selecting actual registered cases.
The default file sampling unit is not a sample of every static test declaration. Save the seed and area populations; use
a census when population is below quota. Explain area boundaries before reviewing. Source inventory must be reconciled
with runner registration and actual execution rather than used as a substitute for either.

The motivating AIWG audit found test files excluded solely by `.mjs` naming despite importing Vitest, incompatible
Node/Vitest APIs sharing a lane, CI commands absent for whole areas, and coverage values nested outside their effective
threshold key. Those are examples to investigate where applicable, not assumptions about the target.

A raw result file, its command exit, source hashes, runner versions and normalized cases together provide execution
evidence. Preserve setup failures, empty suites, malformed reports, skips, unavailable metrics and unsupported adapters.
Runner case counts may differ from source declarations through parameter expansion, loops or file-level harnesses. Do
not sum overlapping lanes as unique tests.

## Execute attributable negative controls

Configure each lane's `negativeControls` only after baseline case IDs are available. A control points to an existing
`TestNormalizationPlan` that changes inventoried source files; test, configuration, runner-entrypoint, deletion and
permission-change edits are rejected. Its command/result must exactly match the lane recipe, so an unrelated command
that merely exits nonzero cannot become evidence of a meaningful test.

```bash
aiwg test-conformance collect --root /path/to/target --mode controls --lane all --evidence .aiwg/testing/execution-01.json --output .aiwg/testing/controls-01.json
```

This explicit controls operation applies the guarded source mutation, executes the same lane, and restores it in
`finally`. It then executes the original lane again. Selected cases must pass before and after restoration and fail
during the mutation with unchanged case identities; startup failure, timeout, missing cases and malformed output remain
unknown. A mutation that leaves the selected cases passing is `survived` and fails conformance. The receipt retains
plans, transaction journals and baseline/mutant/restored runner evidence. Verification rechecks raw hashes and the exact
expected source delta rather than trusting stored status labels.

If restoration cannot complete, control processing stops with unknown status and recovery evidence; do not continue
other controls on an altered source tree. Add the controls receipt as another `--evidence` input to `assess`. This
bounded experiment supports the named oracle and changed behavior; it is not a whole-system mutation score or universal
proof of test validity.

## Oracle review and assessment

Assign cases to the Test Oracle Reviewer with [test review](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/test-review.md), exact source bindings and
relevant helpers/SUT. Record what a test actually observes, wrong behavior it rejects, fixture isolation, cleanup and
normalization concerns. Early returns, count-only acceptance, absent `findIndex` values, permissive timeout outcomes and
fail-open validator setup deserve control-flow inspection. A lexical candidate is not a confirmed defect.

Machine `--reviews` input must follow the current review contract and accurately describe its completed scope. Markdown
review forms are working documents, not automatically machine-valid evidence. Review 20 per area for a bounded audit; if
whole-scope `requireReview` applies, all unreviewed cases/files remain outstanding. Do not mark a whole file reviewed
from one sampled case. A green assessment also cannot erase unknown optional discovery from the report.

```bash
aiwg test-conformance assess --root /path/to/target --inventory .aiwg/testing/inventory-01.json --evidence .aiwg/testing/discovery-01.json --evidence .aiwg/testing/execution-01.json --reviews .aiwg/testing/reviews-01.json --output .aiwg/testing/assessment-01.json
aiwg test-conformance report --root /path/to/target --assessment .aiwg/testing/assessment-01.json --format markdown --output .aiwg/testing/report-01.md
```

Use [conformance report](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/conformance-report.md) for additional narrative: test breakdown/types/SUT,
coverage denominator, sampling limits, research and prioritized repair. Artifact validation checks structure;
substantive conformance needs correct sufficient evidence. Report exact assessment status and scope rather than implying
all tests are certified.

## Repair and platform normalization

Create an edits JSON document with `purpose` and `edits: [{path, content}]`. Content is the complete intended UTF-8
file; null means an intentional deletion. The plan captures complete original and replacement content, hashes and
permissions. Use [normalization plan review](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/normalization-plan.md) for acceptance and verification.

```bash
aiwg test-conformance plan --root /path/to/target --changes .aiwg/testing/edits-01.json --output .aiwg/testing/plan-01.json
aiwg test-conformance apply --root /path/to/target --plan .aiwg/testing/plan-01.json --receipt .aiwg/testing/apply-01.json
aiwg test-conformance rollback --root /path/to/target --receipt .aiwg/testing/apply-01.json --output .aiwg/testing/rollback-01.json
```

Apply within existing task authorization after reviewing the concrete result. Rollback is an alternative when the
applied batch needs reversal, not an unconditional next step. The engine rejects source drift, traversal, symlinks and
conflicting receipt paths; identical completed replay is idempotent. It bounds plans to 1,000 edits and 2 MiB combined
before/after content. There is no shell execution inside a plan.

A durable receipt precedes target writes. Partial failure records observed states and does not claim successful
application or automatic rollback. Inspect that receipt and create a recovery plan; completed rollback refuses unrelated
later edits. Avoid concurrent editors during apply: filesystem preconditions are not a cross-process transaction lock.

The platform template layer develops/deploys target testing conventions independently from provider addon deployment:

```bash
aiwg test-conformance templates --root /path/to/target --action list --platform javascript-vitest
aiwg test-conformance templates --root /path/to/target --action develop --platform generic --source .aiwg/testing/custom-template-source.json --output .aiwg/testing/custom-template.json
aiwg test-conformance templates --root /path/to/target --action deploy --platform javascript-vitest --template javascript-vitest:vitest.config.example --output .aiwg/testing/template-plan.json
aiwg test-conformance apply --root /path/to/target --plan .aiwg/testing/template-plan.json
```

Select actual platform/template IDs from `templates --action list`; the Vitest example ID above is a shipped registry
entry. Custom-template source is JSON with `id`, `platform`, `description`, `variables` and `files`. Development
produces a self-contained `TestNormalizationTemplate` artifact validated by `custom-template.v1`; the source file is no
longer needed after development. For example:

```json
{
  "id": "service-test-config",
  "platform": "generic",
  "description": "Target-specific reporter configuration",
  "variables": [
    { "name": "system", "type": "string", "required": true },
    { "name": "timeout", "type": "number", "required": false, "default": 5000 }
  ],
  "files": [
    { "path": "test.config.json", "content": "{\"system\":{{system|json}},\"timeout\":{{timeout}}}\n" }
  ]
}
```

Types are string, number, boolean and path. Substitutions permit only `{{name}}` and `{{name|json}}`; JSON encoding
quotes/escapes values for JSON or JavaScript literals. Raw substitution remains literal text and requires review for its
output context. Destination-path substitutions require path-typed variables, which must remain safely relative. There
are no executable template expressions, imports, includes or implicit file reads. Unknown variables, type mismatches,
unsafe paths and undeclared substitutions fail. `deployTemplate(root, {source, variables})` accepts supplied values and
returns a normalization plan; the CLI accepts the same object from a target-relative JSON file through `--variables`.
Bundled examples contain no variable declarations; develop a custom template to parameterize real target configuration.

For the example above, save `{"system":"orders-service","timeout":5000}` in `.aiwg/testing/template-values.json`, then
generate the real target configuration plan:

```bash
aiwg test-conformance templates --root /path/to/target --action deploy --source .aiwg/testing/custom-template.json --variables .aiwg/testing/template-values.json --output .aiwg/testing/custom-plan.json
```

Review the custom-template source contract and generated plan before applying. A template may standardize fixture setup,
cleanup, runner registration, reporter output or protocol conventions; its deployment alone does not prove correct
tests. Fixing an ineffective oracle requires an actual semantic change and rerun.

Run the finite normalization flow for one batch, refresh inventory/discovery/execution/reviews and assess again. Repeat
for an explicitly bounded batch budget, preserving artifacts for every pass. End on conformance or publish incomplete
status with remaining findings; do not loosen the acceptance scope to finish the loop.

## Research and platform support

```bash
aiwg test-conformance research --root /path/to/target --query "mutation and property testing for the configured platform" --output .aiwg/testing/tool-research.json
```

Use the platform research skill and [tool recommendation](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/tool-recommendation.md) to turn located sources
into grounded choices. The prior audit's corpus was `~/dev/research/research-papers`; configure real user paths rather
than embedding that location into shipped defaults. Missing local roots are reported. Web lookup plans and shipped links
are leads until actually opened and assessed; no research command silently installs proposed tooling.

Keep qualification levels separate:

| Level | What it establishes | What remains |
| --- | --- | --- |
| Researched platform recipe | Official version-specific commands/conventions have been examined | Actual parser and target execution |
| Fixture-tested adapter | Supported reporter forms normalize correctly, including malformed/negative cases | Target compatibility and real orchestration |
| Target-verified integration | Actual target discovery/execution/results/controls and deployment have been exercised | Other versions/platforms and semantic scope not reviewed |

A format enum or profile does not certify support. Unsupported JUnit/TRX or other reporter variants must produce a
missing-adapter gap until their parser is implemented and qualified. Custom runners may emit the canonical result
format; preserve original output and qualify mapping using [adapter
qualification](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/adapter-qualification.md). Consult the runtime's current support matrix and tests rather
than assuming all researched platforms are verified.

## YAML flow contract

`flows/test-conformance-audit.yaml`, `flows/test-conformance-normalize.yaml` and
`flows/test-platform-qualification.yaml` use `flow.aiwg.io/v1` FlowPlaybook and FlowCapability resources. Capabilities
bind named artifact paths and delegate concrete tasks to the addon roles. They are agent playbooks using the commands
above; deploying YAML alone does not run target commands. The audit flow preserves separate protocol, inventory,
evidence, reviews and assessment outputs. The platform qualification flow produces protocol, research and template
artifacts; its qualification work must record which support level was actually demonstrated. The normalization flow
processes exactly one batch and ends with verification and report; the steward may repeat it up to the declared budget
with new artifact paths.
