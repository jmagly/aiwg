---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Key Material Handling

**Enforcement Level**: CRITICAL
**Scope**: All private keys, LUKS passphrases, HSM PIN material, certificate signing keys, and any cryptographic secret
**Issue**: #778

## Principle

Private key material, once exposed outside its intended trust boundary, must be considered compromised. There is no remediation path that does not involve revoking and replacing the key. The cost of a key ceremony or HSM operation is trivial compared to the cost of a CA compromise. Key material never appears in logs, shell history, environment variables, tracked files, or agent output.

## Mandatory Rules

### Logging and Output Prohibitions

1. **Never log key material**: Commands that output private key material must never be executed in a context where output is logged. This includes agent output, CI/CD logs, system journals, and debug traces.

2. **Never echo or print private key content**: Agents must not use `cat`, `echo`, `print`, or equivalent to display private key files in output or to the operator. If a key file must be inspected, inspect only the public component or metadata (e.g., `openssl pkey -noout -text -in key.pem` reads metadata without printing the key material).

3. **Redact PEM content in all agent output**: If an agent inadvertently receives output containing PEM-encoded key material (lines between `-----BEGIN ... KEY-----` and `-----END ... KEY-----`), it must redact those lines before including them in any response or log.

### Git and Version Control Prohibitions

4. **Never commit private key files**: Files with the following extensions or naming patterns must never be staged or committed: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `ca.key`, `server.key`, `client.key`, or any file whose content matches a PEM PRIVATE KEY header.

5. **Pre-commit detection**: Before any git operation, scan staged files for PEM private key headers:
   ```bash
   git diff --cached | grep -q "BEGIN.*PRIVATE KEY" && echo "BLOCKED: private key detected in staged changes"
   ```

6. **Secret scanning**: If a repository does not have pre-commit secret scanning configured (e.g., `git-secrets`, `truffleHog`, `gitleaks`), flag this as a compliance gap.

### Environment Variable Prohibitions

7. **Never pass key material via environment variables**: Private keys and passphrases must not be passed as `KEY=value` environment variables. Use file paths to key material in secure locations (mode `0400`, owner root or the service account) instead.

8. **Never pass key material as CLI arguments**: Arguments to commands are visible in `/proc/{pid}/cmdline` and `ps` output. Key material must be passed via files or stdin pipes only, and only when the command explicitly supports secure stdin input (e.g., `--passphrase-file` or `--key-file`).

### HSM-Specific Rules

9. **HSM-backed keys are never exported**: Private keys generated on or imported to an HSM (YubiHSM, YubiKey, Nitrokey, CloudHSM) must never be exported. If an operation requires the key outside the HSM, the operation design is wrong — redesign to use the HSM for signing.

10. **HSM PIN material follows the same rules as private keys**: YubiKey PIN, PUK, management key, and YubiHSM authentication key must not appear in logs, git, environment variables, or agent output.

11. **Key ceremony procedures require a witness**: Any operation that generates a new CA key, imports a key to an HSM, or performs an equivalent ceremony must be witnessed by a second authorized operator. The witness and the ceremony operator must both sign the audit record.

### Key Generation Requirements

12. **Algorithm minimums**: New keys must meet minimum algorithm standards:
    - RSA: minimum 4096-bit
    - ECDSA: minimum P-384 (secp384r1)
    - Ed25519: acceptable for SSH and general signing
    - RSA-2048: only acceptable for legacy compatibility with documented justification
    - MD5 and SHA-1: never use for new key material or certificate signatures

13. **Generation location**: Keys for production use must be generated on the device or HSM that will hold them, or in an airgapped environment. Never generate production CA keys on a general-purpose internet-connected workstation without documented justification.

## Detection Patterns

| Pattern | Action |
|---------|--------|
| PEM PRIVATE KEY header in any tracked file | BLOCK git operation, alert operator |
| PEM PRIVATE KEY header in command output | REDACT before including in response |
| Key file path as CLI `--password` or `-p` argument | BLOCK, suggest `--key-file` alternative |
| `openssl genrsa` or `openssl ecparam ... -genkey` without explicit output file | FLAG — key may appear in stdout |
| `tpm2_export` or HSM export commands | BLOCK, escalate |
| `PASSPHRASE=`, `PASSWORD=`, `KEY=` in environment | FLAG as compliance gap |

## Audit Trail Requirements

Every key ceremony, CA signing operation, HSM enrollment, and certificate issuance must produce an audit record containing:
- Timestamp (UTC)
- Operation type
- Operator identity
- Witness identity (for ceremonies)
- Key identifier (fingerprint or serial, never the key itself)
- Purpose and scope of the key
- Expiry date
- Storage location

Audit records are stored in the ops artifact directory (`.aiwg/security/` or equivalent) and must not be deleted.

## Rationale

Key material exposure is categorically different from other security incidents. Software vulnerabilities can be patched. Exposed private keys cannot be uncompromised — every certificate signed by a compromised CA, every connection authenticated with a compromised key, and every secret encrypted to a compromised key must be treated as known to the adversary. The only remediation is full revocation and re-issuance, which in a fleet context can be a days-long operation. Prevention is the only viable strategy.
