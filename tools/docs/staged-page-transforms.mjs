// Transforms applied to the staged public copy of each documentation page.
//
// Summary: Pagenary uses a manifest summary, else front-matter `summary` or
// `description`, else an empty <meta name="description">. Derive one for
// pages that declare none.
//
// Repository links: a relative link that leaves docs/ (to source, tests or
// addon docs) cannot resolve on the site, so point it at the repository.
//
// Excluded-page links: a link to a page kept out of the public site points at
// the repository copy of that page.

import path from 'node:path';

const REPOSITORY_BLOB = 'https://github.com/jmagly/aiwg/blob/main/';

/** Rewrite relative links that resolve outside docs/ to repository URLs. */
export function repositoryLinks(content, relativeDirectory) {
  const directory = relativeDirectory.split(path.sep).join('/');
  return content.replace(/\]\(((?:\.\.\/)+[^)\s#]+)(#[^)\s]*)?\)/g, (match, target, anchor = '') => {
    const resolved = path.posix.normalize(path.posix.join('docs', directory, target));
    if (resolved.startsWith('docs/') || resolved.startsWith('../')) return match;
    return `](${REPOSITORY_BLOB}${resolved}${anchor})`;
  });
}

/**
 * Rewrite relative links to pages that exist in docs/ but are excluded from the
 * public site (contributor or agent-only material) to repository URLs, so
 * strict link validation still fails on links whose target does not exist.
 */
export function excludedPageLinks(content, relativeDirectory, { isExcluded, existsInSource }) {
  const directory = relativeDirectory.split(path.sep).join('/');
  return content.replace(/\]\((?!https?:|mailto:|#|\/)([^)\s#]+\.md)(#[^)\s]*)?\)/g, (match, target, anchor = '') => {
    const resolved = path.posix.normalize(path.posix.join(directory, target));
    if (resolved.startsWith('../') || !isExcluded(resolved) || !existsInSource(resolved)) return match;
    return `](${REPOSITORY_BLOB}docs/${resolved}${anchor})`;
  });
}

const MAX_LENGTH = 155;
const MIN_LENGTH = 40;
const COMMAND_LIKE = /\b(?:npx\s+)?aiwg\s+(?:--?)?[a-z]|\bnpm\s+(?:install|i|add)\b|(?<![a-z0-9-])--[a-z]|[/$]aiwg-[a-z]/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function plainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*`]+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text) {
  if (text.length <= MAX_LENGTH) return text;
  const cut = text.slice(0, MAX_LENGTH - 1);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentenceEnd >= MIN_LENGTH) return cut.slice(0, sentenceEnd + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

/** First prose paragraph of a Markdown body, as plain text of at most 155 characters. */
export function deriveSummary(body) {
  let inFence = false;
  let paragraph = [];
  const flush = () => {
    const raw = paragraph.join(' ');
    paragraph = [];
    // A "**Label:** value" block is page metadata, not a description.
    if (/^\*\*[^*]+\*\*\s*:|^\*\*[^*]+:\*\*/.test(raw)) return '';
    const text = plainText(raw);
    // The public build keeps CLI syntax out of user pages; a description
    // must not reintroduce a command or a flag.
    if (COMMAND_LIKE.test(text)) return '';
    return text.length >= MIN_LENGTH ? text : '';
  };
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      const text = flush();
      if (text) return truncate(text);
      continue;
    }
    if (inFence) continue;
    // Headings, tables, lists, quotes, rules, comments and block HTML are not prose.
    const structural = trimmed === '' || /^(#{1,6} |\||[-*+] |\d+\. |>|<|-{3,}$|={3,}$|\[.*\]: )/.test(trimmed);
    if (structural) {
      const text = flush();
      if (text) return truncate(text);
      continue;
    }
    paragraph.push(trimmed);
  }
  const text = flush();
  return text ? truncate(text) : '';
}

/**
 * Return the page with a front-matter `summary` added when it has neither a
 * summary nor a description and one can be derived. Otherwise return it unchanged.
 */
export function withDerivedSummary(content) {
  const match = FRONTMATTER.exec(content);
  if (match && /^(summary|description):\s*\S/m.test(match[1])) return content;
  const summary = deriveSummary(match ? content.slice(match[0].length) : content);
  if (!summary) return content;
  const line = `summary: ${JSON.stringify(summary)}`;
  if (!match) return `---\n${line}\n---\n\n${content}`;
  return `---\n${match[1]}\n${line}\n---\n${content.slice(match[0].length)}`;
}
