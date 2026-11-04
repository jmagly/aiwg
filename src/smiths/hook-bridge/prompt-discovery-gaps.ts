// Explain prompt discovery gaps where an event mapping has no context contract.
export const PROMPT_DISCOVERY_GAPS: Readonly<Record<string, string>> = {
  codex: 'Prompt discovery unavailable: the Codex bridge maps before_prompt but has no verified additionalContext injection contract.',
  hermes: 'Prompt discovery unavailable: the Hermes bridge returns an exit code without forwarding prompt JSON or injecting additionalContext.',
};
