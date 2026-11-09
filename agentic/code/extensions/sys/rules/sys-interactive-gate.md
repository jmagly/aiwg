---
precedence: high
overridable: true
activation: kernel
enforcement: high
---

# Interactive Command Gate

**Enforcement Level**: HIGH
**Scope**: Any shell command that requires interactive input (passwords, passphrases, confirmations, interactive editors)
**Issue**: #491

## Principle

Agents cannot provide passwords, passphrases, or interactive input to commands. Commands requiring interactive input must be flagged for human execution. The agent must never attempt to pipe, expect, or automate credential entry.

## Mandatory Rules

1. **Detect interactive commands before execution**: Before running any command, check it against the known interactive patterns below. If a match is found, present the command to the human and wait for them to execute it.

2. **Never provide credentials**: The agent must never:
   - Pipe passwords to `sudo` (e.g., `echo "pass" | sudo -S`)
   - Use `expect` scripts to automate password entry
   - Provide LUKS passphrases via `--key-file=-` with stdin
   - Type into `passwd` prompts
   - Automate any MFA/2FA prompt

3. **Flag and present**: When an interactive command is needed, the agent must:
   - Explain what the command does
   - Present the exact command to run
   - State what interactive input will be required
   - Wait for the human to confirm execution and report the result

4. **Known interactive command patterns**:

   | Command / Pattern | Interactive Input Required |
   |------------------|--------------------------|
   | `sudo {anything}` (without NOPASSWD) | Password prompt |
   | `cryptsetup luksOpen`, `luksFormat` | LUKS passphrase |
   | `passwd` | New password (twice) |
   | `ssh-keygen` (without `-N ""`) | Passphrase prompt |
   | `fdisk {device}` (without `-l`) | Interactive partition editor |
   | `parted {device}` (interactive mode) | Interactive partition editor |
   | `mysql -p`, `psql` (without `.pgpass`) | Database password |
   | `gpg --gen-key` | Key parameters and passphrase |
   | `systemctl edit` | Opens editor |
   | `visudo` | Opens editor |
   | `crontab -e` | Opens editor |
   | `git rebase -i` | Opens editor |
   | Any command with `read -s` | Hidden input prompt |

5. **Safe alternatives**: When possible, suggest non-interactive alternatives:
   - `sudo` with NOPASSWD for specific commands (if pre-configured)
   - `ssh-keygen -N "" -f {path}` for passwordless key generation
   - `fdisk -l` (read-only) instead of interactive `fdisk`
   - `parted -s` (scripted mode) instead of interactive
   - `EDITOR=tee visudo <<< "content"` patterns (with extreme caution)

6. **Ambiguous cases**: If unsure whether a command will prompt for input, flag it as potentially interactive and let the human decide.

## Validation

Before executing any command, check:

- [ ] Command is not in the known interactive patterns list
- [ ] Command does not contain password/passphrase arguments in plaintext
- [ ] Command does not use `expect`, `pexpect`, or stdin password piping
- [ ] If the command may prompt, it has been flagged for human execution

## Rationale

Agents operating in non-interactive shells cannot respond to password prompts, causing commands to hang or fail silently. More critically, attempting to automate credential entry creates security risks (credentials in shell history, process lists, or logs). The correct approach is to hand interactive commands to the human operator.
