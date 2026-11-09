---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# LUKS/TPM2 Dual-Phase Validation

**Enforcement Level**: CRITICAL
**Scope**: Any operation involving LUKS keyslots, TPM2 enrollment, initramfs changes, or disk encryption configuration
**Issue**: #778

## Principle

LUKS and TPM2 operations can permanently lock a system out of its own encrypted volumes. A single missing passphrase slot or failed TPM2 PCR policy can render all data inaccessible without physical intervention and specialized recovery tooling. These operations are irreversible in failure states. No LUKS or TPM2 write operation may proceed without completing a mandatory two-phase validation sequence.

## Mandatory Rules

### Phase 1 — Pre-Enrollment Verification (MUST complete before any write)

Before any `systemd-cryptenroll`, `cryptsetup luksAddKey`, `cryptsetup luksRemoveKey`, or equivalent operation, the agent must verify and document all of the following:

1. **Model-specific TPM2 compatibility research**: Check the target host's hardware model against known TPM2 firmware issues. Common problem areas include AMD fTPM instability on Ryzen platforms, Dell TPM2 firmware bugs requiring specific BIOS versions, and Lenovo ThinkPad TPM2 PCR volatility. Document the model, firmware version, and any known issues found.

2. **Initramfs contents verification**: Confirm the initramfs includes required TPM2 modules before enrollment:
   ```bash
   lsinitramfs /boot/initrd.img-$(uname -r) | grep -E "tpm|cryptsetup|systemd-cryptenroll"
   ```
   Required modules: `tpm2_tis`, `tpm2_tis_core`, `tpm_crb`, `cryptsetup`, `systemd-cryptenroll` binary.

3. **Passphrase slot 0 integrity confirmation**: Verify the fallback passphrase slot is active and accessible:
   ```bash
   cryptsetup luksDump /dev/{device} | grep -A2 "Keyslot 0"
   ```
   Slot 0 must show `ENABLED`. If slot 0 is not active, STOP — this is a pre-existing misconfiguration that must be resolved before proceeding.

4. **Live USB availability confirmation**: Confirm that a bootable recovery medium (live USB or equivalent) has been tested on this specific hardware within the last 90 days. Document the medium and test date. If no tested live USB is available, STOP and require the operator to prepare one before proceeding.

5. **Recovery procedure documentation**: Write the full recovery procedure to the associated issue or ticket before any modification. The recovery procedure must cover: how to boot from live USB, how to open the LUKS volume with the passphrase, and how to remove a failed TPM2 keyslot with `systemd-cryptenroll --wipe-slot=tpm2`.

### Phase 2 — Enrollment (only after Phase 1 is complete and documented)

1. Enroll the TPM2 key with explicit PCR binding:
   ```bash
   systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=0+7 /dev/{device}
   ```

2. Verify TPM2 PCR binding was recorded in the LUKS header:
   ```bash
   cryptsetup luksDump /dev/{device} | grep -A10 "tpm2"
   ```

3. Test TPM2 unlock by performing a controlled reboot. Do not proceed past this step until the system has rebooted successfully with TPM2 auto-unlock.

4. After successful reboot, verify passphrase slot 0 is still intact:
   ```bash
   cryptsetup luksDump /dev/{device} | grep -A2 "Keyslot 0"
   ```
   If slot 0 is no longer `ENABLED`, this is a critical failure — immediately use the live USB to restore passphrase access.

## Detection Patterns

Flag any of the following for Phase 1 verification before execution:

| Command Pattern | Risk |
|----------------|------|
| `systemd-cryptenroll --tpm2*` | TPM2 keyslot enrollment |
| `systemd-cryptenroll --wipe-slot*` | Keyslot removal |
| `cryptsetup luksAddKey*` | New keyslot addition |
| `cryptsetup luksRemoveKey*` | Keyslot removal |
| `cryptsetup luksKillSlot*` | Forced keyslot removal |
| `cryptsetup luksFormat*` | Full LUKS header rewrite |
| `dracut -f` or `update-initramfs -u` | Initramfs rebuild (may break TPM2 PCR policy) |

## Absolute Prohibitions

- **DO NOT remove passphrase slot 0 under any circumstances.** TPM2 unlock can fail due to firmware updates, PCR drift, or hardware replacement. Slot 0 is the permanent fallback. Any request to remove slot 0 must be escalated to the human operator with an explicit warning.
- **DO NOT enroll TPM2 on a host with a live USB that has not been tested on that specific hardware.** USB boot compatibility is hardware-dependent.
- **DO NOT proceed if any Phase 1 check fails.** There are no acceptable exceptions. Document the failure and escalate.

## Escalation Triggers

STOP and escalate to the human operator if:
- Any Phase 1 check fails for any reason
- The host hardware model is not in a verified known-good TPM2 list for the kernel version in use
- The initramfs contents are missing any required TPM2 module
- Slot 0 shows as anything other than `ENABLED` before enrollment
- The TPM2 enrollment command fails or returns unexpected output
- The system fails to reboot successfully with TPM2 auto-unlock

## Rationale

A locked-out encrypted system is not a software problem — it requires physical access, specialized tooling, and potentially forensic recovery procedures. The time cost of Phase 1 validation is measured in minutes. The cost of skipping it is measured in hours of recovery time or, in the worst case, permanent data loss. The dual-phase requirement is non-negotiable.
