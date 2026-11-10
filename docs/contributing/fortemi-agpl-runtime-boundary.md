# Decision record: Fortemi AGPL runtime boundary

- Status: accepted for transparent disclosure; legal conclusion unresolved
- Date: 2026-08-14
- Owners: AIWG maintainers
- Review trigger: any Fortemi/Bytecask version, entry point, process boundary, distribution format, or network-service behavior changes
- Legal review due: before representing the combined runtime as MIT-only or making a new compliance claim

This record is an engineering and licensing-risk assessment, not legal advice.

## Context

AIWG's root package and `@aiwg/cli` declare `@fortemi/core@2026.7.15` as a production dependency. Fortemi declares `@bytecask/core@^2026.7.5`; the reviewed lockfile resolves Bytecask `2026.7.5`. Both dependency packages declare `AGPL-3.0-only`, while AIWG-authored code declares MIT.

The dependencies are functional, not metadata-only. Removing or moving Fortemi to `devDependencies` would break supported discovery, portable shard conversion, and marketplace provenance verification.

## Observed package and runtime boundary

| AIWG caller | Imported entry point | Execution and data boundary |
| --- | --- | --- |
| `src/artifacts/fortemi-core-query-adapter.ts` | `@fortemi/core/aiwg-index` | In-process function calls over structured index objects and query results |
| `src/artifacts/fortemi-shard-export.ts` | `@fortemi/core/aiwg-index-shard` | In-process conversion of AIWG index objects to archive bytes and receipts |
| `src/marketplace/provenance.ts` | `@fortemi/core/aiwg-index-shard` | In-process conversion and loss reporting |
| `src/marketplace/provenance.ts` | `@fortemi/core` | In-process archive validation and unpacking; the root Fortemi bundle also contains a lazy Bytecask import used by Fortemi storage paths |

The JavaScript `import()` syntax defers module loading; it does not create a process or protocol boundary. The calls exchange rich objects, archives, and receipts in the same Node.js process.

The npm archives have a separate storage boundary:

- `aiwg` and `@aiwg/cli` contain AIWG files plus dependency declarations, but do not vendor Fortemi/Bytecask object code;
- npm downloads Fortemi and Bytecask as separate package archives during installation;
- each reviewed dependency archive contains an AGPL license file and repository metadata;
- release CI's signed CycloneDX SBOM scans the installed release workspace, so it records the resolved dependency graph even though those files are not embedded in the AIWG tarball.

## License evidence and interpretation limits

The [GNU AGPL text](https://www.gnu.org/licenses/agpl-3.0.html) requires preservation of notices and license terms when conveying covered code, provides object-code/corresponding-source options in section 6, and adds a source-offer rule for modified versions designed for remote network interaction in section 13.

The [GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins) states the FSF view that dynamically linked modules making function calls and sharing data structures form a combined program, while simple separate-process invocation can be a separate work. The [GNU license list](https://www.gnu.org/licenses/license-list.html#Expat) classifies the Expat/MIT-style license as GPL-compatible. Compatibility permits code to be combined under the copyleft terms; it does not mean the combined program can be conveyed under MIT terms alone.

These sources support a conservative engineering conclusion: AIWG's in-process Fortemi integration presents a credible combined-work question, and separate npm tarballs or dynamic import syntax do not resolve it. They do not establish a jurisdiction-specific legal outcome. A qualified reviewer must determine the obligations for the exact copyright ownership, publication, and deployment facts.

The AGPL network clause is conditional. Ordinary local CLI execution is not inherently remote network interaction. If an operator modifies Fortemi/Bytecask and exposes that modified program through an AIWG network service, section 13 requires specific review and potentially a prominent corresponding-source offer.

## Decision

1. Preserve Fortemi as a production dependency and keep existing discovery and shard capabilities.
2. Do not describe the installed AIWG/Fortemi runtime as unconditionally MIT-only. “MIT” continues to describe AIWG-authored code and the AIWG package's license field; dependency licenses remain independently applicable, and the combined-work question is explicitly unresolved.
3. Ship [`THIRD_PARTY_NOTICES.md`](https://github.com/jmagly/aiwg/blob/main/THIRD_PARTY_NOTICES.md) in both npm packages. It names the reviewed licenses, versions, immutable source commits, release tags, registry integrity values, entry points, and inspection commands.
4. Continue signed SBOM publication, but describe it accurately as the installed release graph observed by CI rather than files embedded in the AIWG tarball.
5. Keep the exact Fortemi pin. Do not reclassify a runtime import as development-only or hide either dependency from metadata/SBOM output.
6. Seek a capability-preserving resolution before making a stronger licensing claim. Preferred order:
   - obtain an explicit permissive/dual-license grant for the narrow Fortemi AIWG entry points and any Bytecask code they require;
   - otherwise introduce a separately installed, separately executed service/worker with a documented stable protocol and parity tests;
   - otherwise license the combined distribution under terms confirmed compatible by qualified counsel.

## Licensing intent and supply-chain license score (2026-11-10)

AIWG-authored code is MIT on purpose. Teams that build their own implementations bundle AIWG concepts and often remix AIWG itself; MIT lets them do that with minimal obligation. Copyleft obligations stay on the more concrete products, Fortemi and Bytecask (AGPL-3.0-only), where the line between a customer's implementation and the product is clearer. The operator confirmed this intent on 2026-11-10.

Both `aiwg` and `@aiwg/cli` declare the Fortemi production dependency, so the Socket post-publish audit scores both at license 0.7. That score accurately reports this documented boundary. `ci/socket-score-baseline.json` records 0.7 for both packages (`@aiwg/cli` since 2026-11-10, #4064). It is not a change to any license or a new compliance claim; the combined-work question above stays open.

## Compliance checklist

For every release while this boundary exists:

- retain the Fortemi production dependency and exact AIWG pin;
- ship AIWG's MIT license and this third-party notice in both package archives;
- retain dependency license files and repository metadata in their own npm archives;
- publish and sign the resolved dependency SBOM;
- verify the source links and registry integrity values when versions change;
- run the existing Fortemi query, discovery, shard conversion, and release-discovery tests;
- obtain legal review before claiming the whole installed combination is governed only by MIT.

## Consequences

This decision improves transparency and source accessibility without reducing product behavior. It does not eliminate the combined-work risk. A later process-boundary change is acceptable only with parity coverage for query ranking, portable shard bytes/receipts, marketplace envelope verification, and the documented compatibility window.
