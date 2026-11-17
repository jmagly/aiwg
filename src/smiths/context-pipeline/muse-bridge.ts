/**
 * Muse-native discover-first bridge text for the AGENTS.md managed section
 * (#227).
 *
 * Muse Code reads project AGENTS.md natively — but only after the workspace
 * is explicitly trusted (first-run trust prompt). The bridge therefore leads
 * with the trust-gated load, follows the Muse-native instruction order
 * (this AGENTS.md first, discovery, then WORKSPACE.md and AIWG.md), and states the
 * discover-first protocol (`aiwg discover` / `aiwg show`) with no auto-load
 * claims for other AIWG paths. Artifact references and one-sentence
 * summaries only — never full bodies — per
 * docs/architecture/adr-muse-provider-target.md. No CLAUDE.md shim, no
 * foreign-provider context file.
 *
 * Deterministic: static text only — no timestamps, no randomness — so
 * `aiwg regenerate --provider muse` produces byte-identical output.
 *
 * This module is intentionally dependency-free: the bridge text is consumed
 * by `buildProviderBootstrapBlock` (workspace-context.ts), which must not
 * pull provider-policy.ts's module-evaluation side effects into every
 * import graph.
 *
 * @issue #227
 */
export function buildMuseBridgeText(): string {
  return [
    'This file is the discover-first AIWG bridge for Muse Code. Muse loads',
    'project AGENTS.md natively — but only after the workspace is explicitly',
    'trusted (first-run trust prompt). Until the workspace is trusted, this',
    'file does not load: trust the workspace when prompted, then start a new',
    'Muse session so the bridge is read.',
    '',
    'Instruction order: this AGENTS.md first (native startup context).',
    'On every new directive, run `aiwg discover "<intent>"` as the first information-gathering call,',
    'before reading WORKSPACE.md, AIWG.md, the rules index, or quickrefs; this includes coding, decline, and bug-report requests.',
    'After discovery, read and follow [WORKSPACE.md](./WORKSPACE.md)',
    'for project/operator context, then [AIWG.md](./AIWG.md), the single generated',
    'context for AIWG discovery, quickrefs, and framework routing.',
    'Plain Markdown links are explicit reading instructions; AIWG does not',
    'claim Muse auto-loads any other AIWG path on its own.',
    '',
    "For AIWG lookup, never open `.agents/skills/**` or `agentic/code/**`, including a discovered skill's mirror file or a template. After discover, use `aiwg show <type> <name>` and its drill-ins (`--section`, `--rules --with-rule-bodies`, `--body`); read required rules before governed work.",
    'Prefer indexed',
    'agents, skills, rules, and commands over guessing. Store artifact',
    'references and one-sentence summaries only — never paste full artifact',
    'bodies into context or memory.',
    '',
    'After `aiwg regenerate` or a redeploy, trust the workspace again if',
    'prompted and start a new Muse session to re-read this file. Changes are',
    'not picked up by reloading an IDE window.',
  ].join('\n');
}
