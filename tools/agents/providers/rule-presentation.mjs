/** Render deployed rule references without links to catalog-only siblings. */
import path from 'node:path';

export function projectOnDemandReferences(rules, nativePaths = false) {
  const byFile = new Map(rules.map(rule => [path.resolve(rule.file), rule]));
  return rules.map(rule => {
    const rewrite = content => content?.replace(
      /\[[^\]\n]+\]\((?:\.\/)?([\w-]+)\.md\)[ \t]*\(`aiwg show rule \1(?: --body)?`, on-demand\)/g,
      (reference, name) => {
        const sibling = byFile.get(path.resolve(path.dirname(rule.file), `${name}.md`));
        // Only known catalog rules can replace a relative file reference. Keep
        // unknown/broken links and links to files selected for native delivery.
        if (!sibling?.tagged || sibling.name !== name || sibling.activation === 'kernel' ||
            (nativePaths && sibling.activation === 'paths')) return reference;
        return `\`aiwg show rule ${name} --body\` (on-demand)`;
      },
    );
    return { ...rule, content: rewrite(rule.content), body: rewrite(rule.body),
      ...(rule.coreBody === undefined ? {} : { coreBody: rewrite(rule.coreBody) }) };
  });
}

export function renderRuleKernelIndex(rules, nativePaths = false, perRuleFetch = false, kernelFile) {
  const summary = rules.filter(rule => rule.tagged && (rule.canonicalActivation || rule.activation) === 'summary');
  const paths = rules.filter(rule => rule.tagged && (rule.canonicalActivation || rule.activation) === 'paths');
  const kernels = rules.filter(rule => rule.tagged && (kernelFile || perRuleFetch ? rule.activation : rule.canonicalActivation || rule.activation) === 'kernel');
  if (!summary.length && !paths.length && !kernels.length) return '';
  const lines = ['# Rule kernel index', ''];
  // RULES-INDEX receipts are parsed by deployment accounting; retain their command format.
  // #3900: "fetch before governed work" made Muse read every rule before discovery; fetch on need.
  if (!perRuleFetch) lines.push("Fetch a rule's full body when a task or discovered component needs it: `aiwg show rule <name> --body`.", '');
  if (kernelFile && kernels.length) lines.push("Kernel rules bind every task and subagent task. On a new task, first run discovery for the request (`aiwg discover --stdin <<'AIWG_REQUEST'`, the request, then `AIWG_REQUEST`) before reading any file below; then read a kernel file before work its subject covers.", '');
  for (const rule of kernels) lines.push(kernelFile
    ? `- ${rule.name} — ${rule.summary || 'Binding kernel rule.'} Full rule: [${kernelFile(rule)}](./${kernelFile(rule)}).`
    : perRuleFetch
    ? `- ${rule.name} — ${rule.summary || 'Binding kernel rule.'} Full rule: \`aiwg show rule ${rule.name} --body\`.`
    : `- ${rule.name}${rule.summary ? ` — ${rule.summary}` : ''}`, '');
  for (const rule of summary) lines.push(perRuleFetch
    ? `- ${rule.name} — ${rule.summary} Fetch when a task or discovered component needs it: \`aiwg show rule ${rule.name} --body\`.`
    : `- ${rule.name}${rule.summary ? ` — ${rule.summary}` : ''}`, '');
  if (paths.length) {
    lines.push(nativePaths ? '## Path rules (native)' : '## Path rules (prompt emulation)', '',
      nativePaths ? 'The provider loads these rules for matching paths; full contracts remain available through the commands below.' : 'Before reading or changing files, compare intended project-relative paths with the globs below and fetch matching rules before their first read/write. If paths are initially unknown, check when they become known. An agent-only task has no path match. This is prompt emulation, not a filesystem hook.', '');
    for (const rule of paths) lines.push(`- ${rule.name} | ${rule.paths.map(glob => `\`${glob}\``).join(', ')} | ${rule.summary} | \`aiwg show rule ${rule.name} --body\``, '');
  }
  return lines.join('\n');
}

