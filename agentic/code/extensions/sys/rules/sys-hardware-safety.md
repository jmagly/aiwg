---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Hardware Safety — Dual-Phase Validation

**Enforcement Level**: CRITICAL
**Scope**: Any operation involving TPM, LUKS, boot chain, firmware, partition tables, or RAID arrays
**Issue**: #491

## Principle

Modifications to boot chain, TPM, LUKS, firmware, partition tables, or RAID arrays can permanently brick a system. These operations require dual-phase validation: research first, then execute only after explicit human approval.

## Mandatory Rules

1. **Phase 1 — Research and Document Current State**: Before proposing any modification to a protected subsystem, the agent must:
   - Document the current state completely (e.g., `cryptsetup luksDump`, `tpm2_getcap`, `efibootmgr -v`, `fdisk -l`, `mdadm --detail`)
   - Identify all dependencies (what breaks if this changes)
   - Draft the proposed change as a plan, not as executable commands
   - Present the plan to the human operator

2. **Phase 2 — Human Approval Required**: The agent must receive explicit human confirmation before:
   - Modifying any LUKS header or keyslot
   - Writing to TPM PCR banks or NVRAM
   - Changing EFI boot entries or Secure Boot keys
   - Modifying partition tables (`fdisk`, `parted`, `gdisk`)
   - Altering RAID array membership (`mdadm --add`, `--remove`, `--grow`)
   - Flashing firmware or BIOS updates
   - Running `dd` targeting block devices
   - Any `cryptsetup` write operation

3. **Never automate destructive hardware operations**: Even if the human has pre-approved a class of operations, each individual destructive operation requires its own confirmation. Batch approval is not valid for this rule.

4. **Recovery documentation before modification**: Before executing any approved change, ensure a recovery path is documented. If the change is irreversible without hardware access, state this explicitly.

5. **Protected commands**: The following commands (and equivalents) must never be executed without Phase 2 approval:
   - `cryptsetup luksFormat`, `luksAddKey`, `luksRemoveKey`, `luksKillSlot`
   - `tpm2_nvdefine`, `tpm2_nvwrite`, `tpm2_clear`
   - `efibootmgr -c`, `-b ... -B`, `--delete-bootnum`
   - `fdisk`, `parted`, `gdisk` (write mode)
   - `mdadm --create`, `--grow`, `--remove`
   - `dd of=/dev/*`
   - `flashrom`, `fwupd` (firmware write operations)
   - `mokutil --import`, `--delete`

## Violation Response

If an agent attempts to execute a protected command without completing both phases, the operation must be blocked and the violation logged. This is not a warning — it is a hard stop.

## Rationale

A misconfigured LUKS header or TPM policy can render a system permanently inaccessible without physical intervention. Unlike software errors, hardware and boot chain mistakes often cannot be undone remotely. The time cost of dual-phase validation is negligible compared to the cost of a bricked remote system.
