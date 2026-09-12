# ADR 001: Natural voice ownership and evidence contract

Status: accepted design decision, 2026-09-06. Tracks #2293 and #2292.

Voice-framework owns author profiles, exemplar and evidence contracts. It extends the existing output-mode system. Writing diagnostics and revision belong to writing maintainers; each consumer owns its application and channel formatting. Research maintainers review evidence; independent evaluators and participating authors/readers qualify quality.

## Existing contract

Preserve `src/output-modes/types.ts`, `registry.ts` and `runtime.ts`: invocation/session/project scopes, existing resolver precedence, deterministic stage ordering, profile validation, protected-literal masking/restoration, validation callbacks and configured failure behavior. `unaltered` stays the default no-op. Profile selection or `AIWG_OUTPUT_MODES_JSON` alone is not proof a consumer applied a transformation. Literal preservation does not prove semantic or author-intent fidelity. Implement new capabilities through adapters to this contract, with explicit unsupported-consumer reporting, rather than a second resolver or hidden profile state.

The staged target is brief → draft/constrained edit → contextual critique → bounded revision → semantic/literal validation → channel formatting → final validation and author review. This decision specifies ownership and constraints; it does not claim these later workstreams have shipped or passed a human evaluation.

## Evidence boundary

The machine-readable [version 1 ledger](evidence-ledger.v1.json) pins eight inducted corpus records, source artifact hashes, primary URLs, source versions, locators, bounded inferences and unrun experiments. Corpus grades describe source quality under that repository's scheme. `productClaimConfidence` describes confidence in transfer to the proposed AIWG decision and remains separate. A policy decision is not an experimentally established effect.

The ledger incorporates the [pinned synthesis](https://git.integrolabs.net/section9/research-papers/src/commit/06824789c893f44387a95ca4a59cb05e65872ce9/documentation/analysis/natural-voice-evidence-and-evaluation.md). In particular, Baumler drafts already used author notes; topic-matched examples are not an established best selector; nonsignificant detector subgroup differences do not prove equality. Practitioner anecdotes cannot set numerical release thresholds. No detector score defines naturalness, and no universal exemplar count is established.

PersonalBench v1, Jangra v4 and Pearl v2 received versioned abstract acquisition and initial assessment on 2026-09-06. Their full methods have not been reviewed for adoption. All remain `defer-method-adoption`; neither an ensemble nor trained retrieval is a proven default. Their ledger entries identify the further assessment required. This avoids duplicating or inventing corpus induction records.

## Evidence refresh

A research maintainer must issue a new ledger version when a publication changes, is corrected/retracted, an archived hash drifts, a policy/tool changes, or a product decision relies on new evidence. Keep old ledger files and pinned corpus commits available. Record changed claims, limitations, review date and affected consumers; repeat claim-to-section/table inspection. URLs identify publications; hashes identify the exact reviewed bytes. Dynamic web HTML hashes identify acquisition bytes, not an immutable promise about subsequent responses.

A model, provider, prompt, exemplar selector, evaluator, decoding, channel or language change invalidates transfer of affected local qualification results until re-evaluated. Record exact model/provider versions where exposed, and explicitly record unknown snapshots. Freeze evaluator inputs separately from generation/profile construction. Register sample size rationale and thresholds before held-out testing, split authors/topics, analyze repeated observations by author, and retain blind author/reader outcomes alongside independent metrics. Deterministic ledger validation verifies provenance and policy constraints; it cannot prove human-rated quality.

## Verification

Run `node agentic/code/addons/voice-framework/docs/natural-voice/validate-ledger.mjs /path/to/research-papers` to verify every source and record hash at the pinned commit. Without the checkout argument it validates structure and policy only. Run the ledger fixture through the repository test runner. Review primary links and a sample of source table mappings when refreshing; a valid hash proves bytes, not the correctness of an inference.
