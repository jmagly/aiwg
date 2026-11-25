// Frozen pre-native Devin adapter from main (2026.11.9), used to build legacy deployments.
import { withModelWrapper } from './model-wrapper.mjs';
export const transformAgent = withModelWrapper('devin', translateAgent);
function translateAgent(srcPath, content, opts) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, frontmatter, body] = fmMatch;

  // Extract metadata
  const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  const toolsMatch = frontmatter.match(/tools:\s*(.+)/)?.[1]?.trim();
  const modelMatch = frontmatter.match(/model:\s*(.+)/)?.[1]?.trim();

  // Build Devin Desktop-compatible format (plain markdown, no YAML)
  const lines = [];
  lines.push(`### ${name}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  // Parse and include tools as capabilities
  if (toolsMatch) {
    let tools;
    try {
      tools = toolsMatch.startsWith('[')
        ? JSON.parse(toolsMatch)
        : toolsMatch.split(/[,\s]+/).filter(Boolean);
    } catch (e) {
      tools = toolsMatch.split(/[,\s]+/).filter(Boolean);
    }

    if (tools.length > 0) {
      lines.push('<capabilities>');
      tools.forEach(t => lines.push(`- ${t.trim()}`));
      lines.push('</capabilities>');
      lines.push('');
    }
  }

  if (modelMatch) {
    lines.push(`**Model**: ${modelMatch}`);
    lines.push('');
  }

  lines.push(body.trim());
  return lines.join('\n');
}

/**
 * Transform command content to Devin Desktop workflow format
 */
export function transformCommand(srcPath, content, opts) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, frontmatter, body] = fmMatch;

  // Extract name and description from frontmatter
  const nameMatch = frontmatter.match(/name:\s*(.+)/);
  const descMatch = frontmatter.match(/description:\s*(.+)/);

  const name = nameMatch ? nameMatch[1].trim() : 'Workflow';
  const description = descMatch ? descMatch[1].trim() : '';

  // Build workflow format
  const lines = [];
  lines.push(`# ${name}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }
  lines.push('## Instructions');
  lines.push('');
  lines.push(body.trim());

  return lines.join('\n');
}

/**
 * Transform rule content for Devin Desktop — injects trigger frontmatter per ADR-2.
 *
 * Defaults to `trigger: always_on` (the ADR-2 §2 default-preservation choice
 * for the existing AIWG rule corpus). When the source frontmatter declares
 * a `globs:` or `applyTo:` field, the trigger is upgraded to `glob` and the
 * glob pattern is passed through as the Devin Desktop-native `glob:` field
 * (PUW-020 / #1121, glob-mode part of ADR-2 §1 mapping).
 *
 * Per ADR-2 §5: non-always_on modes require a live-Devin Desktop smoke test
 * gate before shipping to operators with the live loader. Until that gate
 * lands, the safe default is preserved for rules without explicit globs.
 */
export function transformRule(srcPath, content, opts) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (fmMatch) {
    const [, frontmatter, body] = fmMatch;
    // Already has a trigger field — preserve the file as-is.
    if (/^trigger:/m.test(frontmatter)) {
      return content;
    }

    // PUW-021 (#1122 sibling): pass through globs / applyTo as glob trigger.
    const globsMatch = /^\s*globs?\s*:\s*(.+)$/m.exec(frontmatter);
    const applyToMatch = /^\s*applyTo\s*:\s*(.+)$/m.exec(frontmatter);
    if (globsMatch || applyToMatch) {
      const globValue = (globsMatch?.[1] || applyToMatch?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
      const triggerLines = [`trigger: glob`];
      // Add Devin Desktop-native `glob:` field if not already present.
      if (!/^\s*glob\s*:/m.test(frontmatter)) {
        triggerLines.push(`glob: '${globValue}'`);
      }
      return `---\n${triggerLines.join('\n')}\n${frontmatter}\n---\n${body}`;
    }

    // Default: trigger: always_on (ADR-2 §2 safe default).
    return `---\ntrigger: always_on\n${frontmatter}\n---\n${body}`;
  }

  // No frontmatter — wrap with trigger.
  return `---\ntrigger: always_on\n---\n\n${content}`;
}

