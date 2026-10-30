// Render the single generated root framework context and fold in optional operator notes.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readAiwgOperatorNotes } from './finalization.js';
import { buildClaudeHookBlock, CLAUDE_HOOK_START, CLAUDE_HOOK_END } from './claude-hook.js';
import { dedupeProviderBootstrap } from './workspace-context.js';
import { dominantLineEnding, withLineEnding } from './line-endings.js';
import { buildParallelismSection, replaceOrAppendParallelismBlock } from './parallelism-section.js';
import { buildContextFinalizationBlock, replaceOrAppendFinalizationBlock } from './finalization.js';
import {
  buildExternalLinksSection,
  replaceOrAppendExternalLinksBlock,
} from './external-links-section.js';

const AIWG_SIGNATURE_COMMENT = '<!-- aiwg-managed -->';

export async function buildAiwgMdContent(
  projectPath: string,
  stagedClaudeMdContent?: string | null,
): Promise<string> {
  let claudeMdContent = stagedClaudeMdContent;
  if (stagedClaudeMdContent === undefined) {
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    try {
      claudeMdContent = await fs.readFile(claudeMdPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      claudeMdContent = null;
    }
  }

  // #1362: parallelism cap section, injected after generation so it surfaces
  // in regenerated context files regardless of CLAUDE.md content.
  const parallelismSection = await buildParallelismSection(projectPath);
  const finalizationBlock = await buildContextFinalizationBlock(
    projectPath,
    path.join(projectPath, 'AIWG.md'),
  );
  const externalLinksSection = await buildExternalLinksSection(projectPath);
  const { notes } = await readAiwgOperatorNotes(projectPath);
  const foldNotes = (content: string): string => {
    content = content.replace(/<!-- AIWG:operator-notes:start -->[\s\S]*?<!-- AIWG:operator-notes:end -->\r?\n?/g, '');
    return notes.trim() ? `${content.trimEnd()}\n\n<!-- AIWG:operator-notes:start -->\n${notes}\n<!-- AIWG:operator-notes:end -->\n` : content;
  };

  if (claudeMdContent) {
    // Insert the AIWG signature comment as the second line.
    // Top line is typically `# AIWG` or `# Project` heading; preserve it.
    // Regenerate may mirror CLAUDE.md before its hook updater runs. Normalize
    // that managed block here too so legacy duplicate policy never reaches
    // AIWG.md, even on the first refresh. Operator content stays untouched.
    claudeMdContent = dedupeProviderBootstrap(claudeMdContent);
    // Each provider startup owns core and hooks; mirroring them would load a
    // second copy through the shared framework companion.
    claudeMdContent = claudeMdContent.replace(/<!-- AIWG:(rule-core|rule-startup|rule-hook-[\w-]+):start -->[\s\S]*?<!-- AIWG:\1:end -->\r?\n?/g, '');
    const start = claudeMdContent.indexOf(CLAUDE_HOOK_START);
    const end = claudeMdContent.indexOf(CLAUDE_HOOK_END, start);
    if (start >= 0 && end >= start) {
      const hook = withLineEnding(buildClaudeHookBlock(), dominantLineEnding(claudeMdContent));
      claudeMdContent = claudeMdContent.slice(0, start) + hook + claudeMdContent.slice(end + CLAUDE_HOOK_END.length);
    }
    const lines = claudeMdContent.split('\n');

    // #1268: strip `@AIWG.md` self-include directives. CLAUDE.md uses
    // `@AIWG.md` to pull in the framework context; AIWG.md IS that framework
    // context, so the directive becomes a self-reference when copied through.
    // Match the directive when it appears on its own line (possibly indented).
    const SELF_INCLUDE_PATTERN = /^\s*@AIWG\.md\s*$/;
    // #3451: CLAUDE.md already `@`-imports WORKSPACE.md; a second `@` path to
    // the same file would load it twice, so AIWG.md refers to it in plain text.
    const CONFIG_IMPORT_PATTERN = /^\s*@\S*aiwg\.config\s*$/;
    const WORKSPACE_IMPORT_PATTERN = /^\s*@(?:\.\.\/)?WORKSPACE\.md\s*$/;
    const filtered = lines
      .filter((line) => !SELF_INCLUDE_PATTERN.test(line) && !/^\s*@(?:\.\/)?\.aiwg\/AIWG\.md\s*$/.test(line))
      .map((line) => {
        if (WORKSPACE_IMPORT_PATTERN.test(line)) {
          return 'WORKSPACE.md is the canonical project context (loaded by CLAUDE.md; read it first if your harness did not).';
        }
        // Legacy CLAUDE.md files may still `@`-import the raw JSON config.
        if (CONFIG_IMPORT_PATTERN.test(line)) {
          return 'Project configuration: `.aiwg/aiwg.config` (not auto-loaded; run `aiwg config show --project` to view it).';
        }
        return line;
      });

    const firstLine = filtered[0] ?? '';
    const rest = filtered.slice(1);

    // If the file already carries the signature elsewhere, don't double-insert.
    const alreadySigned = filtered.slice(0, 4).some((l) => l.includes(AIWG_SIGNATURE_COMMENT));
    const baseContent = alreadySigned
      ? filtered.join('\n')
      : [
          firstLine,
          AIWG_SIGNATURE_COMMENT,
          '<!-- Generated framework context shared by all providers. -->',
          ...rest,
        ].join('\n');

    const withParallelism = replaceOrAppendParallelismBlock(baseContent, parallelismSection);
    const withFinalization = replaceOrAppendFinalizationBlock(withParallelism, finalizationBlock);
    return foldNotes(replaceOrAppendExternalLinksBlock(withFinalization, externalLinksSection));
  }

  // A fresh non-Claude project has the same complete framework context.
  const stub = [
    '# AIWG.md', AIWG_SIGNATURE_COMMENT,
    '<!-- Generated framework context. Project/operator context belongs in WORKSPACE.md. -->', '',
  ].join('\n');
  const withParallelism = replaceOrAppendParallelismBlock(stub, parallelismSection);
  const withFinalization = replaceOrAppendFinalizationBlock(withParallelism, finalizationBlock);
  return foldNotes(replaceOrAppendExternalLinksBlock(withFinalization, externalLinksSection));
}

/**
 * Public API: build AIWG.md content for a given project.
 *
 * The wrapper exists so future variants (per-provider AIWG.md customization,
 * AIWG.local.md operator overrides, etc.) have a single entry point in the
 * surface API without callers reaching into the implementation.
 */
export async function generateAiwgMd(projectPath: string, stagedClaudeMdContent?: string | null): Promise<string> {
  return buildAiwgMdContent(projectPath, stagedClaudeMdContent);
}

/** Keep pipeline-owned startup boilerplate out of the shared context on redeploy. */
export async function generateAiwgMdForPipeline(projectPath: string): Promise<string> {
  let claudeMdContent: string | null;
  try { claudeMdContent = await fs.readFile(path.join(projectPath, 'CLAUDE.md'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    claudeMdContent = null;
  }
  // A generated startup hook is not project prose. Mirroring it would change
  // the initial shared-context stub on redeploy and duplicate provider policy.
  if (claudeMdContent?.includes(CLAUDE_HOOK_START)) {
    const prose = claudeMdContent
      .replace(/<!-- AIWG:claude-md-hook:start -->[\s\S]*?<!-- AIWG:claude-md-hook:end -->/g, '')
      .replace(/<!-- AIWG:(rule-core|rule-startup|rule-hook-[\w-]+):start -->[\s\S]*?<!-- AIWG:\1:end -->/g, '')
      .replace(/^\s*<!-- aiwg-managed -->\s*$/gm, '');
    if (!prose.trim()) claudeMdContent = null;
  }

  return buildAiwgMdContent(projectPath, claudeMdContent);
}
