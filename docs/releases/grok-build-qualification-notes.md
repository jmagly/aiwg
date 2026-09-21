# Grok Build qualification release note

The `grok-build` provider remains experimental. This release adds a repeatable
Linux, macOS, Windows PowerShell, and WSL qualification program for the released
CLI. A live smoke receipt records version, OS, authentication mode, Grok
inspection, and AIWG deployment verification without credential material.
Stable promotion is gated on complete platform receipts and live evidence for
each native claim; deferred/unsupported surfaces are listed in the contract.

Grok Build is xAI's coding-agent CLI. It is separate from the stable Grok Bot
provider and from the Grok web Build experience. See the
[quickstart](../integrations/grok-build-quickstart.md),
[operator reference](../agents/providers/grok-build.md), and
[qualification gate](../providers/grok-build-qualification.md).
