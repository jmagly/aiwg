/** Legacy Hermes startup compatibility; activation delivery owns current startup policy. */
import fs from 'node:fs';
import path from 'node:path';
import { listOnDemandRuleFiles, renderOnDemandRuleSection } from './base.mjs';
import { writeContextFileSync } from './context-write.mjs';

/**
 * Generate a lean AGENTS.md for Hermes
 *
 * Hermes reaches AGENTS.md through its startup pointer on every task. Reserve
 * the 19,000-character budget for bootstrap, compact core and operator context.
 * See: docs/integrations/hermes-quickstart.md (Part 3)
 */
// Hermes context cap is 20K chars (head-tail truncated above). Hard limit
// to leave headroom for project-specific additions and skill-discovery.
const HERMES_AGENTS_MD_HARD_CAP = 19_000;
const HERMES_AGENTS_MD_SOFT_WARN = 15_000;

/** Preserve the harness limit for operator context; kernel bodies live in rules files. */
export function assertContextBudget(content, name = 'AGENTS.md') {
  if (content.length <= HERMES_AGENTS_MD_HARD_CAP) return;
  throw new Error(`Hermes ${name} (${content.length} chars) exceeds hard cap of ${HERMES_AGENTS_MD_HARD_CAP}. Review wrappers and operator additions.`);
}

/**
 * Top-7 CRITICAL rule directives, inlined into AGENTS.md for guaranteed
 * priming on every Hermes turn (#1318 / S7; skill-discovery added #1347).
 *
 * The full rule bodies are reachable without MCP via `aiwg discover` and
 * `aiwg show rule <name> --body`; MCP exposes the same path through `rule-list` and
 * `rule-show` when configured (#1320). The bodies exceed Hermes's 20K context
 * cap if inlined verbatim (anti-laziness alone was 32K chars; it now ships as a compact core body, #3450), so we inline
 * compressed directives only and point to CLI/MCP for the full text.
 *
 * Selection criteria: rules tagged CRITICAL/HIGH enforcement level whose
 * violations are silent or destructive (cost of remembering to query
 * rule-show > cost of inlining the directive). skill-discovery is HIGH
 * but is the linchpin of the discover-first architecture across all
 * providers and is therefore inlined alongside the CRITICAL set.
 */
const CRITICAL_RULE_DIRECTIVES = `## CRITICAL Rules (always apply)

These are the highest-enforcement AIWG rules. Full bodies are reachable without
MCP:
- Find rules: \`aiwg discover "rule <topic>" --type rule\`
- Fetch a rule: \`aiwg show rule <name> --body\`

If the optional MCP sidecar is configured, the same surface is available through
\`mcp_aiwg_rule_list\` and \`mcp_aiwg_rule_show\`.

### Rule: skill-discovery (discover-first protocol)
Before declining a user request as "outside AIWG's scope" or improvising a
workflow from training data, you MUST run \`aiwg discover "<user need>"\`
against the user's need. Most AIWG skills are not in your context; they reach
you through \`aiwg discover\` + \`aiwg show <type> <name>\`. If MCP is available,
\`mcp_aiwg_discover\` and type-specific show tools are equivalent. Run discover
whenever the user mentions AIWG, a framework name (sdlc, research, forensics,
ops, marketing, security-engineering, media-curator, knowledge-base), or
capability keywords (skill, agent, command, rule, workflow).

### Rule: citation-policy
Never fabricate citations, DOIs, URLs, or page numbers. Only cite sources that
exist in the research corpus (.aiwg/research/sources/). Match claim strength
to evidence quality (GRADE): HIGH = "demonstrates"; MODERATE = "suggests";
LOW = "limited evidence"; VERY LOW = "anecdotal". Document research gaps in
.aiwg/research/TODO.md when no source supports a claim.

### Rule: token-security
Never hard-code tokens, API keys, or secrets in source files or commit messages.
Never pass tokens as CLI arguments (visible in process list). Never echo or log
token values. Load from secure files (mode 600) or environment variables. Use
heredoc scope for multi-step operations so tokens don't persist beyond use.
Token files must NEVER be tracked in git (.gitignore enforced).

### Rule: versioning
CalVer format: \`YYYY.M.PATCH\` (e.g., \`2026.5.3\`). NEVER use leading zeros
(\`2026.01.5\` is broken — npm semver rejects it). Tags use \`v\` prefix.
CHANGELOG must use same format. PATCH resets each month.

### Rule: ops-safety
Detect interactive commands and flag for human execution (passwords, LUKS
passphrases, MFA — agents cannot type these). Gate destructive operations
(\`rm -rf\`, \`fdisk\`, \`mkfs\`, partition table changes) behind explicit
human confirmation. Assess blast radius before execution (CRITICAL = multi-host
/ data loss; HIGH = single-host outage). Dry-run first when the tool supports it.
Never cross host boundaries without confirmation.`;

const HERMES_AGENTS_MD_FOOTER = `## Optional MCP Server Surface (\`aiwg mcp serve\`)

MCP is optional. The baseline path is file deploy + \`aiwg discover\` /
\`aiwg show\` from the CLI. MCP exposes the same AIWG catalog and execution
surface as provider-agnostic tools when configured.

**Discovery** (read-only, no project required):
- \`mcp_aiwg_discover\` — semantic search across skills/agents/commands/rules
- \`mcp_aiwg_skill_list\` / \`mcp_aiwg_skill_show\`
- \`mcp_aiwg_command_list\` / \`mcp_aiwg_command_show\`
- \`mcp_aiwg_rule_list\` / \`mcp_aiwg_rule_show\`
- \`mcp_aiwg_agent_list\` / \`mcp_aiwg_agent_show\`
- \`mcp_aiwg_template_list\` / \`mcp_aiwg_template_show\` / \`mcp_aiwg_template_render\`

**Execution** (allow-listed):
- \`mcp_aiwg_command_run\` — dispatches to any of 94 AIWG CLI commands. Destructive
  commands require \`confirmed: true\`.

**Artifacts** (project-required, .aiwg/ directory):
- \`mcp_aiwg_artifact_read\` / \`mcp_aiwg_artifact_write\``;

function mergeHermesContext(file, generated, kind) {
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  existing = existing.replace(/\n?<!-- AIWG:rule-startup:start -->[\s\S]*?<!-- AIWG:rule-startup:end -->\n?/g, '');
  const start = `<!-- AIWG:hermes-${kind}:start -->`;
  const end = `<!-- AIWG:hermes-${kind}:end -->`;
  const managed = `${start}\n${generated}\n${end}`;
  if (existing.includes(start)) return existing.slice(0, existing.indexOf(start)) + managed + existing.slice(existing.indexOf(end) + end.length);
  if (kind === 'context' && existing.startsWith('# AIWG Integration') && existing.includes(HERMES_AGENTS_MD_FOOTER)) {
    existing = existing.slice(existing.indexOf(HERMES_AGENTS_MD_FOOTER) + HERMES_AGENTS_MD_FOOTER.length);
  } else if (kind === 'routing' && existing.includes(generated)) {
    existing = existing.replace(generated, '');
  }
  return existing ? `${existing.trimEnd()}\n\n${managed}\n` : `<!-- aiwg-managed -->\n${managed}\n`;
}

export function generateAgentsMd(agentCount, skillCount, targetDir, opts) {
  if (opts.contextFiles === false || opts.ruleDelivery) return;
  const { dryRun } = opts;

  // Startup is reserved for rule contracts. Workflow routing, artifact catalogs,
  // and the optional MCP tool inventory duplicate discover/show and consume
  // Hermes's finite per-turn context before the kernel is appended.
  const header = `# AIWG Integration

Skills: \`$HERMES_HOME/skills/\` (kernel), \`$HERMES_HOME/skills/.aiwg/\` (standard).
Find: \`aiwg discover "rule <topic>" --type rule\`. Fetch: \`aiwg show rule <name> --body\`.
MCP is optional; \`mcp_aiwg_rule_show\` exposes the same rule catalog.
`;

  // On-demand tier (#1675): the MEDIUM/LOW rules not inlined above. Hermes has
  // no scanned rule dir, so the bridge file notes the tier with fetch hints.
  const onDemandSection = opts.srcRoot
    ? renderOnDemandRuleSection(listOnDemandRuleFiles(opts.srcRoot))
    : '';
  const migrated = new Set((opts.ruleDelivery?.rules || []).filter(rule => rule.tagged).map(rule => rule.name));
  const directives = CRITICAL_RULE_DIRECTIVES.split(/(?=^### Rule: )/m).filter(section => section.startsWith('### Rule: ') && !migrated.has(section.match(/^### Rule: ([^ \n]+)/)?.[1])).join('');
  const sections = [header, directives];
  if (onDemandSection) sections.push(onDemandSection);
  // The optional tool inventory is available on demand through the CLI.
  const destPath = path.join(targetDir, 'AGENTS.md');
  const output = mergeHermesContext(destPath, sections.join('\n\n'), 'context');

  if (!opts.ruleDelivery && !opts.deferRuleProjection) assertContextBudget(output, 'AGENTS.md');

  if (dryRun) {
    console.log(`[dry-run] Would write AGENTS.md (${output.length} chars, ${Math.round(output.length / 4)} tokens estimated)`);
  } else {
    writeContextFileSync(destPath, output, 'utf8');
    const charCount = output.length;
    const tokenEstimate = Math.round(charCount / 4);
    let budgetNote;
    if (charCount > HERMES_AGENTS_MD_SOFT_WARN) {
      budgetNote = `⚠ ${charCount} chars — above soft warn (${HERMES_AGENTS_MD_SOFT_WARN}); below hard cap (${HERMES_AGENTS_MD_HARD_CAP})`;
    } else {
      budgetNote = `✓ within budget (cap: ${HERMES_AGENTS_MD_HARD_CAP})`;
    }
    console.log(`  Created AGENTS.md (${charCount} chars, ~${tokenEstimate} tokens, ${budgetNote})`);
  }

  return 1;
}

/**
 * Generate `.hermes.md` thin pointer at the project root (#1319 / S8).
 *
 * Hermes loads `.hermes.md` with priority over `AGENTS.md` (first-match-wins
 * at `agent/prompt_builder.py:1417-1456`). The pointer is short so the
 * actual context payload remains in AGENTS.md which is shared with other
 * tools (Claude Code, Codex, etc.).
 */
export function generateHermesMd(targetDir, opts) {
  if (opts.contextFiles === false || opts.ruleDelivery) return;
  const { dryRun } = opts;
  const body = `# Hermes Routing

AIWG project context lives in \`AGENTS.md\` (this file is a thin Hermes pointer).

**Routing**: see \`AGENTS.md\` in this directory.
**MCP**: AIWG is reachable via \`mcp_aiwg_*\` tools.
**Skills**: kernel skills at \`$HERMES_HOME/skills/\`; standard skills at \`$HERMES_HOME/skills/.aiwg/\`.
When unset, \`HERMES_HOME\` defaults to the platform-native Hermes home.

Hermes loads only \`.hermes.md\` when it is present (first-match-wins). Keep
this file minimal; its routing instruction tells the agent to read \`AGENTS.md\`
when the full AIWG project context is needed.
`;
  const destPath = path.join(targetDir, '.hermes.md');
  if (dryRun) {
    console.log(`[dry-run] Would write .hermes.md (${body.length} chars)`);
  } else {
    writeContextFileSync(destPath, mergeHermesContext(destPath, body, 'routing'), 'utf8');
    console.log(`  Created .hermes.md (${body.length} chars)`);
  }
  return 1;
}

