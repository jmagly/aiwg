// Explain bootstrap fallbacks where an event mapping has no prompt context contract.
export const PROMPT_DISCOVERY_GAPS: Readonly<Record<string, string>> = {
  copilot: 'Prompt discovery uses the .github/copilot-instructions.md bootstrap rule; installed help documents no prompt-context injection contract.',
  'grok-build': 'Prompt discovery uses the AGENTS.md bootstrap rule; Grok discards allowing UserPromptSubmit stdout (no additionalContext).',
};
