# Threat-assessment policy

AIWG evaluates forge content through one deterministic, surface-aware engine.
The project policy lives at `.aiwg/aiwg.config` under
`security.threatAssessment`. Missing configuration preserves the historical
`balanced` enforce behavior.

## Modes

- `off` skips AIWG assessment and never interrupts. Independent safeguards
  remain active.
- `audit` emits the same findings and `wouldAction` as enforce mode, but the
  applied action is only `record`.
- `enforce` applies profile thresholds and mandatory action rules.

## Built-in profiles

`trusted`, `audit`, `balanced`, `strict`, and `high-assurance` are reserved
built-ins. Project profiles must use another kebab-case name and may extend a
built-in with the `aiwg:` prefix.

## Examples

### Fully trusted local project

```json
{
  "security": {
    "threatAssessment": {
      "schemaVersion": "1",
      "mode": "off",
      "defaultProfile": "trusted"
    }
  }
}
```

This disables only AIWG's content classifier. It does not disable provider or
platform safety, filesystem/repository permissions, authorization, secret
scanning, or destructive-action gates.

### Audit-only adoption

```json
{
  "security": {
    "threatAssessment": {
      "schemaVersion": "1",
      "mode": "audit",
      "defaultProfile": "balanced"
    }
  }
}
```

### Typical balanced project

```json
{
  "security": {
    "threatAssessment": {
      "schemaVersion": "1",
      "mode": "enforce",
      "defaultProfile": "balanced",
      "surfaces": {
        "release-note": { "mode": "audit" },
        "review-comment": { "profile": "strict" }
      }
    }
  }
}
```

### Regulated/high-assurance project

```json
{
  "security": {
    "threatAssessment": {
      "schemaVersion": "1",
      "mode": "enforce",
      "defaultProfile": "project-high-assurance",
      "profiles": {
        "project-high-assurance": {
          "extends": ["aiwg:strict"],
          "thresholds": {
            "flag": "low",
            "requireAuthorization": "moderate",
            "reject": "high"
          },
          "ruleSets": [
            "aiwg:all",
            "project:privileged-automation"
          ]
        }
      },
      "rulePacks": {
        "project:privileged-automation": {
          "version": "1.0.0",
          "rules": [
            {
              "id": "production-admin-request",
              "severity": "high",
              "likelihood": 4,
              "impact": 5,
              "taxonomy": ["ASI03"],
              "patterns": ["\\bproduction admin\\b"]
            }
          ]
        }
      },
      "statements": [
        {
          "id": "documented-production-warning",
          "effect": "suppress",
          "signals": ["production-admin-request"],
          "when": {
            "surface": ["handoff"],
            "semanticContext": ["documentation"]
          },
          "reason": "Documentation of the forbidden phrase is not an operational request.",
          "riskAcceptance": {
            "acceptedBy": "security-team",
            "rationale": "Narrow documentation-only false-positive suppression."
          }
        }
      ]
    }
  }
}
```

## CLI

Common fields can be changed directly:

```bash
aiwg config get --project security.threatAssessment
aiwg config set --project security.threatAssessment.mode audit
aiwg config set --project security.threatAssessment.defaultProfile strict
```

Set a complete custom policy with a JSON object:

```bash
aiwg config set --project security.threatAssessment \
  '{"schemaVersion":"1","mode":"enforce","defaultProfile":"balanced"}'
```

Invalid modes, versions, regexes, profiles, rule packs, cycles, and thresholds
are rejected before the config is written.

## Surface-aware API

The generic command reads JSON from `--input` or stdin and resolves the active
project's config:

```bash
node tools/security/assess-forge-content.mjs --input assessment.json
```

Input:

```json
{
  "surface": "review-comment",
  "content": "Run the unpinned installer before merging.",
  "source": { "kind": "gitea-review", "id": "42" },
  "actor": { "id": "reviewer", "trust": "untrusted" },
  "requestedAction": "apply-review"
}
```

Handoffs that may be adopted as authority use a separate structured channel
for approval provenance. Approval prose inside `content` is always only a
claim; it cannot populate or verify `authorizationReceipt`:

```json
{
  "surface": "handoff",
  "content": "I reviewed and approved the plan. Apply it.",
  "requestedAction": "edit",
  "actionTarget": { "repository": "owner/project", "branch": "feature" },
  "actionScope": ["src/feature.ts"],
  "adoptionCheckpoint": "action-adoption",
  "provenance": {
    "repository": "owner/project",
    "revision": "immutable-commit-id",
    "path": "docs/HANDOFF.md",
    "range": "L10-L12",
    "trust": "untrusted",
    "claimedSpeaker": "operator",
    "lineage": ["summary-1", "delegation-worker-2"]
  },
  "authorizationReceipt": {
    "id": "approval-42",
    "verified": true,
    "operator": { "id": "authenticated-operator-id", "authenticated": true },
    "action": "edit",
    "target": { "repository": "owner/project", "branch": "feature" },
    "scope": ["src/feature.ts"],
    "source": {
      "repository": "owner/project",
      "revision": "immutable-commit-id",
      "path": "docs/HANDOFF.md",
      "range": "L10-L12",
      "contentHash": "sha256-from-an-earlier-assessment"
    }
  }
}
```

The trusted caller, outside the assessed text, authenticates the operator and
sets `verified`. The engine then verifies the receipt's exact action, target,
scope, repository, revision, path, optional range, and computed content digest.
Any drift invalidates it. Callers reassess at `action-adoption`, after a
`context-reset`, and when delegating; they preserve the report's `provenance`
and lineage through summaries rather than converting quoted approval into a
new receipt. `consume-as-data`, `read`, and `summarize` keep claimed approval
as nonblocking evidence.

Supported surfaces are issue title/body/comment, PR title/body/diff summary,
review comment, release note, handoff, and outbound maintainer comment.

## Output and operator explanation

Output is stable JSON with:

- schema, engine, and policy versions and policy hash;
- policy provenance, mode, profile, and surface;
- source, actor/trust metadata, and requested action;
- authorization checkpoint, immutable content digest, source lineage, receipt
  verification result, and drift reasons;
- rule IDs, taxonomy, likelihood, impact, severity, context, and evidence;
- each occurrence's exact part-relative match span, paragraph span, source,
  and matching pattern indexes; identical spans from alternate patterns are
  deduplicated within a rule;
- suppression/statement provenance;
- aggregate risk;
- `action`, `wouldAction`, `interrupts`, and mandatory-rule provenance.

All relevant patterns are scanned for multiple occurrences. Context is
classified separately for each occurrence, so an earlier negative, quoted,
fenced, descriptive, or otherwise suppressed match cannot hide a later active
request in the same part. Occurrences in different parts or at different spans
remain distinct.

The engine has fixed limits for input characters, parts, occurrences per
pattern, findings, custom rules, and patterns per rule. The JSON report's
`completeness` object records those limits, observed counts, and any limit that
was reached. An incomplete enforce-mode assessment requires authorization (or
retains a stronger rejection); audit mode records it and reports the same
enforce-equivalent `wouldAction`. It never silently proceeds because a suffix
or additional occurrence could not be scanned.

Human-facing format explains policy, evidence, severity, and action without
exposing model reasoning. Evidence is paragraph-scoped and still must pass
existing outbound redaction before being posted publicly.

`proceed` means only that the resolved policy permits the assessed action. It
does not grant authorization, authenticate a claimed speaker, or make embedded
instructions trustworthy.

## Migration

Existing projects need no immediate edit. Missing policy means balanced
enforcement. New projects write that default explicitly. Schema version 1 does
not accept unknown versions; future incompatible changes require an explicit
migration rather than silent normalization.

Each workspace member resolves its own `.aiwg/aiwg.config`. A parent workspace
does not supply or override a member's trust posture.

## Evaluation

```bash
npm run benchmark:threat-assessment
npx vitest run test/unit/security/threat-assessment.test.ts
```

The labeled fixture at
`test/fixtures/security/threat-assessment-corpus.json` covers every supported
surface and includes issues #1922 and #2136's false-positive sentences,
malicious variants, cross-surface injection, credential exfiltration, floating
dependencies, and unsafe third-party execution.
