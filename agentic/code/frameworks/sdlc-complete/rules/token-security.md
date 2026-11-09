---
precedence: critical
overridable: true
enforcement: critical
triggers:
  - how do I handle a token safely
  - where do I put an api key
  - load a secret in a script
  - token security
  - credential handling
activation: kernel
summary: "Protect credentials in every role: never hard-code, print, commit, or pass secrets as arguments; load them at point of use with restricted permissions."
---

# Token Security Rules

**Enforcement Level**: CRITICAL
**Scope**: All agents, commands, skills, generated code, and reviews
**Issue**: #18

## Mandatory Rules

1. Never hard-code credentials in files or commands. Load them from secure
   files or environment variables at the point of use.
2. Never pass tokens as command-line arguments. Pass them through the
   environment or load them inside the consuming script.
3. Never echo, print, or log token values or expose them in command history.
   Log only operation status; validate credentials and handle missing values.
4. Scope multi-line token operations to a quoted heredoc subshell so token
   variables are discarded when it exits. Do not export tokens early and retain
   them throughout a script; use an inline load for a single operation.
5. Never commit tokens or token files. Ignore real secret files and use only
   placeholders in example configuration.
6. Require token-file mode 600 (owner read/write only); validate permissions and
   fix insecure modes before use. Select admin versus standard tokens appropriately.
7. In CI/CD, use secret-backed environment variables. In application code,
   read the environment, fail clearly when a credential is absent, and never
   log its value.

## Agent, Command, and Skill Requirements

API-using agent definitions MUST include heredoc-based usage examples, security
notes stating that tokens remain scoped, unlogged, and cleaned up, and references
to the security documentation below.
API-using agent definitions MUST state in their security notes that tokens are never exposed in command history.

Token-using commands and skills MUST check that the credential file exists,
validate and repair its permissions to 600, and use heredoc-scoped operations.
Token-using commands and skills MUST report a missing credential file and terminate before attempting authenticated operations.
Generated authentication code MUST follow the same secure patterns, include
validation and error handling, and keep real secrets outside version control.

## Validation and Remediation

Apply these requirements at agent/command creation, code generation, review,
and periodic audit. Before completing token-related work, check every rule above
and ensure security documentation is referenced in agent definitions.

On finding a violation, immediately remove hard-coded tokens, update ignore
rules for tracked secret files, and rotate exposed credentials via the service's
web UI. Promptly replace insecure patterns and add security notes.
After identifying a token-security violation, audit the entire codebase for similar violations as a follow-up.
There are no exceptions.

If uncertain, consult the references, default to the most restrictive pattern
(a heredoc with point-of-use loading), and ask before implementing if uncertainty
remains.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/token-security.md - Security documentation and examples
- @$AIWG_ROOT/agentic/code/addons/security/secure-token-load.md - Pattern library
- @~/.claude/CLAUDE.md - Token-file locations and API patterns
