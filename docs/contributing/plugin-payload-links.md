# Plugin payload links (#3204)

The installed-payload inventory found **121 unresolved relative Markdown links across 14 plugins** in the original checked-in payloads. Links are checked against each isolated plugin root, even when their targets exist elsewhere in the checkout. The regenerated canonical research skill also restored the bibliographic-services link described in #3204.

## Fixes

- Package the research bibliographic-services and corpus-data-model docs. Publish the bibliographic doc's cross-framework token-security link as a GitHub URL.
- Package directly referenced SDLC flows (Claude and Codex), Voice docs/flow/ledger, Utilities rules, and the Security Engineering CI rule.
- Rewrite shared rule and repository documentation links to their public GitHub source, checking the local source exists. Keep framework-owned files inside the plugin when available. Preserve fenced examples and inline code.
- Report missing targets and paths leaving a plugin, with plugin/file, line, original target, and reason. Images and reference definitions are included; anchors, URLs, fenced code, comments and inline code are excluded. Symlink and encoded traversal are checked. Markdown parsing covers common inline/reference syntax; it is not a complete CommonMark parser, and anchors and network URLs are not validated.

## Commands and merge overlap

Run `npm run package-plugins` to generate Claude payloads and print warnings; generate Codex with `node tools/plugin/package-plugins.mjs --plugin codex-sdlc --provider codex`.

Run `npm run lint:plugin-links` (or `node tools/plugin/package-plugins.mjs --plugin research --check-links`) for a read-only report. This strict check exits 1 while any unresolved link remains, including the reviewed cases below. Normal packaging warns without failing. The unit inventory fixture prevents additions to the reviewed unresolved set.

The packager preserves #3061 / PR #3203’s offline `--check` mode. `npm run lint:plugin-copies` regenerates default Claude payloads in a temporary directory using the same document copies and published-link rewrites as normal packaging, then compares them with tracked copies. It remains enabled in CI. The strict `lint:plugin-links` check is not wired into CI while the reviewed unresolved links below remain.

## Original inventory by plugin

| Plugin | Unresolved links |
| --- | ---: |
| agent-loop | 11 |
| aiwg-dev | 3 |
| codex-sdlc | 24 |
| compound-memory | 1 |
| context-curator | 3 |
| daemon | 2 |
| guided-implementation | 1 |
| research | 14 |
| sdlc | 28 |
| security-engineering | 3 |
| semantic-memory | 1 |
| testing-quality | 3 |
| utils | 14 |
| voice | 13 |

## Remaining inventory

All 11 remaining links are missing targets; no reported path leaves its plugin root. These are retained for review rather than inventing content or treating host-local paths as public docs.

| Plugin/file:line | Target | Decision needed |
| --- | --- | --- |
| `agent-loop/README.md:147` | `docs/examples/test-fix.md` | README names example docs absent from the addon: author examples or remove links? |
| `agent-loop/README.md:150` | `docs/examples/greenfield.md` | README names example docs absent from the addon: author examples or remove links? |
| `aiwg-dev/skills/devkit-create-agent/SKILL.md:12` | `~/.local/share/ai-writing-guide/docs/AGENT-DESIGN.md` | Host-local legacy reference: replace, remove, or keep as a runtime instruction? |
| `context-curator/README.md:163` | `~/.local/share/ai-writing-guide/docs/references/REF-002-llm-failure-modes-agentic.md` | Host-local legacy reference: replace, remove, or keep as a runtime instruction? |
| `context-curator/README.md:164` | `~/.local/share/ai-writing-guide/docs/AGENT-DESIGN.md#rule-6-scoped-context` | Host-local legacy reference: replace, remove, or keep as a runtime instruction? |
| `context-curator/README.md:165` | `~/.local/share/ai-writing-guide/.aiwg/planning/roig-2025-gap-analysis.md` | Host-local legacy reference: replace, remove, or keep as a runtime instruction? |
| `research/skills/induct-media/examples/expected-REF-101-radar.md:17` | `../citations/REF-101-citations.md` | Illustrative corpus fixtures: add fixture targets or render paths as code? |
| `research/skills/induct-media/examples/expected-REF-101-radar.md:17` | `../references/REF-101.md` | Illustrative corpus fixtures: add fixture targets or render paths as code? |
| `research/skills/induct-media/examples/expected-REF-101-radar.md:59` | `../references/REF-101.md` | Illustrative corpus fixtures: add fixture targets or render paths as code? |
| `research/skills/induct-media/examples/expected-REF-101-radar.md:60` | `../citations/REF-101-citations.md` | Illustrative corpus fixtures: add fixture targets or render paths as code? |
| `research/skills/induct-media/examples/expected-REF-101.md:112` | `../citations/REF-101-citations.md` | Illustrative corpus fixtures: add fixture targets or render paths as code? |
