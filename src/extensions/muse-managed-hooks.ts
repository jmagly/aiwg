// Canonical Muse hook registrations shared by deployment and read-only drift checks.
export const promptDiscoveryHook = {
  id: 'aiwg-prompt-discovery',
  event: 'UserPromptSubmit',
  group: { matcher: '*', hooks: [{ type: 'command', command: 'node .muse/hooks/aiwg-prompt-discovery.cjs', timeout: 2 }] },
  reason: 'Inject strong AIWG candidates or require discover before answering or declining; skip system turns, bounded and fail open.',
  removal: 'Set AIWG_PROMPT_DISCOVERY=0, or remove this group from .muse/hooks.json.',
};

/**
 * The AIWG-managed hook set. Each entry carries a stated reason (why this
 * hook runs on the operator's machine, outside the agent sandbox) and a
 * removal path (how the operator takes it back out).
 *
 * SessionEnd is intentionally *not* installed yet: Muse documents SessionEnd
 * as observational-only (its output cannot block termination or inject
 * context), and AIWG has no session-catalog note command to invoke — wiring
 * a hook to a command that does not exist would fail every session end.
 * When a real catalog-note command lands, it slots in here with its own
 * reason + removal path.
 */
export const AIWG_MANAGED_HOOKS = [
  {
    id: 'aiwg-session-start',
    event: 'SessionStart',
    // Muse matcher groups take ONLY `hooks` + optional `matcher`; no
    // in-band AIWG tags (they would break the group).
    //
    // Muse Code 1.4.0 parses hook stdout as hook output: empty output, plain
    // text, and `{"hookSpecificOutput": ...}` are accepted, but any other
    // JSON key fails the hook ("unsupported `deploymentFailures` in output of
    // SessionStart hook output"). `aiwg refresh --quiet` prints its JSON
    // report, so stdout is discarded; the exit status still records a failed
    // drift check in Muse's hook log. `--provider muse` is required because
    // provider detection is fail-closed for muse and would resolve `claude`.
    // Hook commands run through a shell, so the redirect is honored.
    group: {
      matcher: '*',
      hooks: [{ type: 'command', command: 'aiwg refresh --dry-run --quiet --provider muse > /dev/null', timeout: 60 }],
    },
    reason:
      'Session-start drift check. Runs a read-only `aiwg refresh --dry-run --provider muse` ' +
      'and records its exit status in the Muse hook log. Dry-run by construction: it ' +
      'never mutates the repo, and its report is not injected into the session.',
    removal:
      'Delete this matcher group from `.muse/hooks.json` (the one whose command is ' +
      '`aiwg refresh --dry-run --quiet --provider muse > /dev/null`), or run `aiwg use --provider muse --no-hooks` ' +
      'to stop AIWG managing hooks for this project.',
  },
  promptDiscoveryHook,
];

