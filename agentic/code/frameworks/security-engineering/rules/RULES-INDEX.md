# Security Engineering Rules Index

Applied-security enforcement rules for cryptographic primitive choices, chain-of-trust integrity, secret handling, supply-chain pinning, dependency-source policy, and related design-time concerns. Deployed when the `security-engineering` framework is installed.

---

## Tier 1 Rules (13 rules — applied cryptography, supply chain, language policy)

### HIGH

#### no-unauthenticated-encryption
**Summary**: Unauthenticated symmetric encryption modes (CBC, CTR, OFB, CFB, ECB) are PROHIBITED unless wrapped in a separate MAC over the ciphertext.
**Maps to review finding**: B1
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/no-unauthenticated-encryption.md

#### no-key-reuse-across-purposes
**Summary**: The same key material MUST NOT be used for two cryptographic purposes (encrypt + authenticate, encrypt + sign, etc.).
**Maps to review finding**: B2
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/no-key-reuse-across-purposes.md

#### no-adhoc-kdf
**Summary**: Ad-hoc key derivation is PROHIBITED.
**Maps to review findings**: B2 (ad-hoc combination), H1 (PBKDF2 misapplied)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/no-adhoc-kdf.md

#### crypto-flag-verification
**Summary**: When invoking crypto CLI tools (`openssl`, `gpg`, `age`, `7z`), KDF and mode parameters MUST be specified explicitly.
**Maps to review finding**: H6
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/crypto-flag-verification.md

#### ci-action-pinning
**Summary**: Every CI workflow `uses:` reference MUST be a 40-character commit SHA (not a tag); every `container:`/`image:` reference MUST be `<name>:<tag>@sha256:<digest>`.
**Maps to issue**: #1293 (B3 / Mini Shai-Hulud)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/ci-action-pinning.md

#### dependency-source-policy
**Summary**: Non-registry dependency sources (`git+`, `github:`, raw tarball URLs, `file:`, `link:`) are PROHIBITED — they bypass registry signature verification and can execute arbitrary code at install time via `prepare` scripts (Mini Shai-Hulud's primary propagation vector).
**Maps to issue**: #1297 (Mini Shai-Hulud follow-up)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/dependency-source-policy.md

#### banned-apis
**Summary**: Project banlists at `.aiwg/security/banned-apis.yaml` declare APIs that MUST NOT appear in source files (per language, per path scope, with inline `AIWG-allow:` annotations for documented exceptions).
**Maps to issue**: #1418 (curl checklist Practice 2)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/banned-apis.md

---

#### no-binary-blobs
**Summary**: Source repositories SHOULD NOT contain committed binary blobs unless covered by documented fixture, asset, SBOM, or vendored-source exceptions.
**Maps to issue**: #1424 (curl checklist Practice 6)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/no-binary-blobs.md

#### no-confusable-unicode
**Summary**: Unicode bidirectional controls, zero-width characters, and mixed-script/confusable identifiers are prohibited unless explicitly allowlisted.
**Maps to issue**: #1425 (curl checklist Practice 8)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/no-confusable-unicode.md

#### strict-toolchain
**Summary**: Projects must define and run strict compiler/linter/typecheck floors in CI; sanitizers and fuzzing are additive, not substitutes.
**Maps to issue**: #1427 (curl checklist Practice 13)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/strict-toolchain.md

#### committer-2fa-required
**Summary**: Every committer with write access must have strong platform-enforced 2FA; hardware keys preferred, TOTP minimum.
**Maps to issue**: #1429 (curl checklist Practice 25)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/committer-2fa-required.md

#### api-abi-stability
**Summary**: Library/SDK projects must preserve declared stable API/ABI contracts, use SemVer-compatible releases, and document deprecations before removals.
**Maps to issue**: #1430 (curl checklist Practice 26)
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/api-abi-stability.md

---

## Host publishing

### published-port-binding
**Summary**: Require explicit bind addresses for Compose and docker run published ports; review wildcard exposure and both firewall families.
**When to apply**: Changes to Compose ports, docker run publish options, or host-hardening reviews.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/published-port-binding.md

## Quick Reference by Context

| Task Type | Relevant Rules |
|---|---|
| **Encryption** | no-unauthenticated-encryption, crypto-flag-verification |
| **Key derivation** | no-adhoc-kdf, no-key-reuse-across-purposes |
| **Multi-key systems** | no-key-reuse-across-purposes, no-adhoc-kdf |
| **Password handling** | no-adhoc-kdf (Argon2id/PBKDF2 ≥600k) |
| **CLI crypto invocations** | crypto-flag-verification, no-unauthenticated-encryption |
| **CI workflow review** | ci-action-pinning |
| **Container image references** | ci-action-pinning |
| **package.json / lockfile review** | dependency-source-policy |
| **Reviewing cryptographic decisions** | All four crypto rules in sequence |
| **Per-language forbidden APIs** | banned-apis (+ language-specific banlists) |

---

## Tier 2 (planned)

Future Tier 2 rules will cover authentication-factor architecture, degraded-mode behavior, secret-handling-runtime, supply-chain trust, and physical-threat scenarios. Tracked under milestone `security-engineering-v1` (#52).

---

*Generated from security-engineering framework — 13 rules in Tier 1*
*Full rule files: @$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/*
