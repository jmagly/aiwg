/** Markdown payload-link inventory. No checkout existence can satisfy a plugin link. */
import fs from 'node:fs';
import path from 'node:path';

// Mask code/comments without changing offsets, so diagnostics retain source lines.
function prose(body) {
  let fence;
  return body.replace(/<!--[^]*?-->/g, text => text.replace(/[^\n]/g, ' '))
    .split('\n').map(line => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
        return ' '.repeat(line.length);
      }
      if (marker) { fence = marker[1]; return ' '.repeat(line.length); }
      return line.replace(/(`+)[^]*?\1/g, text => ' '.repeat(text.length));
    }).join('\n');
}

export function markdownLinks(body) {
  const content = prose(body);
  // Inline links/images (including angle destinations and one nested pair of
  // parentheses), plus reference definitions. Definitions are checked once.
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()\\]|\\.|\([^()]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)|^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm;
  return [...content.matchAll(pattern)].map(match => {
    const target = match[1] ?? match[2] ?? match[3] ?? match[4];
    return {
      target,
      start: match.index + match[0].indexOf(target, match[0].indexOf(']') + 2),
      line: content.slice(0, match.index).split('\n').length,
    };
  });
}

function outside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Separate from generation/check mode so the copy-drift guard can reuse it. */
export function checkPluginLinks(pluginDir) {
  const root = fs.realpathSync(pluginDir);
  const offenders = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        for (const { target, line } of markdownLinks(fs.readFileSync(file, 'utf8'))) {
          if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target)) continue;
          let destination;
          try { destination = decodeURIComponent(target.split(/[?#]/)[0]).replace(/\\([ ()])/g, '$1'); }
          catch { destination = target.split(/[?#]/)[0]; }
          if (!destination) continue;
          const resolved = path.resolve(path.dirname(file), destination);
          const exists = fs.existsSync(resolved);
          const reason = outside(root, resolved) || (exists && outside(root, fs.realpathSync(resolved)))
            ? 'outside-payload' : !exists ? 'missing-target' : null;
          if (reason) offenders.push({ file: path.relative(root, file).split(path.sep).join('/'), line, target, reason });
        }
      }
    }
  }
  visit(root);
  return offenders;
}

export function reportPluginLinks(pluginDir, log = console.warn) {
  const offenders = checkPluginLinks(pluginDir);
  for (const item of offenders) {
    log(`${path.basename(pluginDir)}/${item.file}:${item.line}: ${item.reason}: ${item.target}`);
  }
  log(`${path.basename(pluginDir)}: ${offenders.length} unresolved relative Markdown link(s)`);
  return offenders;
}
