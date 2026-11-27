// Known project context layouts, backed by provider deployers and documentation.
export const PROVIDERS = Object.freeze({
  // tools/agents/providers/pi.mjs (paths, kernelSkillsPath, createAgentsMd);
  // docs/providers/pi-direct.md (native AGENTS.md / CLAUDE.md loading).
  pi: {
    skills: ['.agents/skills', '.pi/skills', '.pi/.aiwg/skills'],
    memory: ['CLAUDE.md'], bridges: ['AGENTS.md'],
  },
  // tools/agents/providers/omp.mjs (paths, createAgentsMd);
  // docs/providers/omp.md (Native resources and project bootstrap).
  omp: {
    agents: '.omp/agents', rules: '.omp/rules', skills: ['.agents/skills'],
    bridges: ['.omp/AGENTS.md'],
  },
  // tools/agents/providers/antigravity.mjs (paths, deploySkills, createAgentsMd);
  // docs/providers/antigravity.md (Documented Google Surfaces, Integration Notes).
  antigravity: {
    rules: '.antigravity/rules',
    agents: '.agents/agents', skills: ['.agents/skills', '.agents/.aiwg/skills'],
    bridges: ['AGENTS.md'],
  },
  // tools/agents/providers/deepseek-harness.mjs (paths, createAgentsMd);
  // docs/providers/deepseek-harness.md (native AGENTS.md / CLAUDE.md context).
  'deepseek-harness': {
    skills: ['.agents/skills'], memory: ['CLAUDE.md'], bridges: ['AGENTS.md'],
  },
  claude: {
    agents: '.claude/agents', rules: '.claude/rules',
    skills: ['.claude/skills', '.claude/.aiwg/skills'],
    memory: ['CLAUDE.md'],
  },
  codex: {
    agents: '.codex/agents', rules: '.codex/rules',
    skills: ['.agents/skills', '.codex/.aiwg/skills'],
    bridges: ['AGENTS.md'],
  },
  copilot: {
    agents: '.github/agents', rules: '.github/instructions',
    skills: ['.github/skills', '.github/.aiwg/skills'],
    bridges: ['.github/copilot-instructions.md'],
  },
  cursor: {
    agents: '.cursor/agents', rules: '.cursor/rules',
    skills: ['.cursor/skills', '.cursor/.aiwg/skills'],
  },
  factory: {
    agents: '.factory/droids', rules: '.factory/rules',
    skills: ['.factory/skills', '.factory/.aiwg/skills'],
  },
  opencode: {
    agents: '.opencode/agent', rules: '.opencode/rule',
    skills: ['.opencode/skill', '.opencode/.aiwg/skill'],
  },
  warp: {
    agents: '.warp/agents', rules: '.warp/rules',
    skills: ['.warp/skills', '.warp/.aiwg/skills'],
    bridges: ['WARP.md'],
  },
  devin: {
    agents: '.windsurf/agents', rules: '.windsurf/rules',
    skills: ['.windsurf/skills', '.windsurf/.aiwg/skills'],
    bridges: ['AGENTS.md'],
  },
  hermes: {
    bridges: ['.hermes.md'],
  },
  openhuman: {
    agents: '.agents/agents', rules: '.agents/rules', skills: ['.agents/skills'],
    bridges: ['AGENTS.md'],
  },
  // Bridge-only: never invent ~/.grokbot or skill trees. Shared AIWG.md /
  // WORKSPACE.md are scanned via SHARED_CONTEXT.
  grokbot: {
    bridges: ['AGENTS.md'],
  },
  // Grok Build: project skills/agents under .grok/; rules stay indexed and
  // are loaded natively (.grok/rules), so there is no AIWG-managed rules
  // root to scan here.
  'grok-build': {
    agents: '.grok/agents',
    skills: ['.grok/skills'],
    bridges: ['AGENTS.md'],
  },
  // Muse Code: discover-first AGENTS.md bridge + project skill root. Never
  // invent ~/.muse or ~/.agents/skills. .muse/ holds hooks that run outside
  // Muse's sandbox, so it is audited via hook ownership, not session context.
  muse: {
    skills: ['.agents/skills'],
    bridges: ['AGENTS.md'],
  },
});

// Every provider this scanner can resolve a layout for. Callers that filter
// a `providers` list before invoking `scanContextMemoryFirewall` (doctor.mjs
// in particular, #2640) should check membership against this instead of
// hand-maintaining a parallel literal list — a provider added here is
// otherwise easy to add to one list and forget the other.
export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));
