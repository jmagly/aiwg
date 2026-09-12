# Evidence ledger verification, 2026-09-06

Scope: #2293 evidence contract. This is a citation/provenance check, not a replicated experiment or a human quality qualification.

The research checkout HEAD resolved to `06824789c893f44387a95ca4a59cb05e65872ce9`. The validator read every ledger record, synthesis and listed source artifact through `git show <commit>:<path>` and matched its SHA-256. This verifies all pinned corpus link paths and bytes without relying on the mutable checkout contents. No corpus sources were copied into AIWG.

All ten primary URLs in the eight records returned the expected publication or page through web retrieval: five academic records, both GOV.UK pages, the Willison policy and highlighter, and the Reddit thread. Reddit retrieval remains a cached partial rendering; no exact publication timestamp or complete-comment claim is made. Publisher/arXiv versions matched the ledger. The three additional versioned arXiv abstract pages also returned HTTP 200 in direct acquisition; their acquisition hashes are recorded separately. Full-method review and corpus induction for these candidates remain deferred.

Sample claim-to-source checks against archived extracted text:

| Record | Location inspected | Verified interpretation |
|---|---|---|
| REF-2453 | Table 6, extracted text lines 478–491 | Enron five-shot attribution 69.33 and similarity-control 36.00 occur in the same follow-up table; these are subset results, not universal selector rankings. |
| REF-2454 | Draft prompt, extracted text line 264; Appendix B.1 around lines 898–905; interface around 1635–1643 | The draft prompt includes participant-written details; bullet points supplied by the author are part of generation. Describing the baseline as content without author notes would be incorrect. |
| REF-2456 | Published Table 3 around extracted text lines 381–398 | Advanced-group FPR is 24.1 in both rows with a reported nonsignificant comparison. Neither the equal rounded rates nor that test establishes population equivalence. |

Line numbers refer to source text artifacts named and hashed in the ledger, not to a future extraction or publisher layout. Table/section references remain the durable claim locators.

Targeted tests: `npx vitest run --config config/vitest.config.js test/unit/voice/evidence-ledger.test.ts` passed all three tests. Fixtures reject an anecdote used to set a numeric release threshold, a silently adopted abstract-only candidate, an unpinned corpus link and a missing claim locator. The tests intentionally make no claim about generated prose quality. Repository build/typecheck/package validation belongs to integration of the complete issue changes.
