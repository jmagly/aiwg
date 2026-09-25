/**
 * Context-finalization pass for generated provider context files.
 *
 * Templates provide the stable structure; this pass stitches in current
 * workspace facts from `.aiwg/aiwg.config` and the discover-first protocol so
 * provider context files do not remain template-only (#1365).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  projectAiwgPath,
  projectControlPath,
  resolveProjectAiwgDir,
} from '../../config/project-artifacts.js';
import { renderTrackerProtocol, resolveTrackerAuthority } from '../../tracker/capability-protocol.js';
import { readConfig, readGitRemoteUrls } from '../../tracker/project-inputs.js';
import {
  buildExternalLinksSection,
  replaceOrAppendExternalLinksBlock,
} from './external-links-section.js';

export const FINALIZATION_START = '<!-- aiwg-context-finalization:START -->';
export const FINALIZATION_END = '<!-- aiwg-context-finalization:END -->';
const AIWG_SIGNATURE_COMMENT = '<!-- aiwg-managed -->';

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none recorded';
}

function displayProjectPath(projectPath: string, targetPath: string): string {
  const relative = path.relative(projectPath, targetPath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return targetPath;
}

function documentRelativeHref(projectPath: string, documentPath: string, targetPath: string): string {
  const absoluteDocument = path.isAbsolute(documentPath)
    ? documentPath
    : path.resolve(projectPath, documentPath);
  const absoluteTarget = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(projectPath, targetPath);
  const relative = path.relative(path.dirname(absoluteDocument), absoluteTarget).replace(/\\/g, '/');
  if (!relative) return `./${path.basename(absoluteTarget)}`;
  return relative.startsWith('./') || relative.startsWith('../')
    ? relative
    : `./${relative}`;
}

export async function buildContextFinalizationBlock(
  projectPath: string,
  documentPath = path.join(projectPath, 'AIWG.md'),
): Promise<string> {
  const config = await readConfig(projectPath);
  const remoteUrls = await readGitRemoteUrls(projectPath);
  const providers = config?.providers ?? [];
  const installed = Object.entries(config?.installed ?? {});
  const installedNames = installed.map(([name]) => name);
  const providerDeployments = new Set<string>();
  const normalizedAiwgMdPath = displayProjectPath(projectPath, projectControlPath(projectPath, 'AIWG.md'));
  const normalizedAiwgMdLabel = `\`${normalizedAiwgMdPath}\``;

  for (const [, entry] of installed) {
    for (const provider of Object.keys(entry.deployedTo ?? {})) {
      providerDeployments.add(provider);
    }
  }

  const trackerAuthority = resolveTrackerAuthority(config, remoteUrls);
  const lines = [
    FINALIZATION_START,
    '## Context Finalization',
    '',
    'This section is synthesized after template emission from the current workspace state. Preserve operator-authored content outside AIWG-managed blocks; rerun `aiwg regenerate` to refresh this section after provider, framework, or MCP wiring changes.',
    '',
    '### Workspace Snapshot',
    '',
    `- Configured providers: ${formatList(providers)}`,
    `- Installed frameworks/addons: ${formatList(installedNames)}`,
    `- Recorded deployments: ${formatList([...providerDeployments].sort())}`,
    `- Normalized project context: \`${normalizedAiwgMdPath}\``,
    '',
    '### Discover-First Protocol',
    '',
    'Classify every user turn FIRST: is it a **new directive** or a continuation? When a message names or references an AIWG command/capability — even as pasted content like an `address-issues` tracker table, an issue list, or a `flow-*` name — treat it as a new directive and ACT: run `aiwg discover "<the need>"`, fetch with `aiwg show <type> <name>`, and invoke it. Do NOT ask "what would you like me to do with these?" when the action is implied — a pasted `address-issues #1234` table means run the address-issues workflow on those issues.',
    '',
    'Also run `aiwg discover` before declining an AIWG request as out of scope or inventing a workflow from memory. The CLI ranks AIWG capabilities across the installed corpus and rebuilds the index from `$AIWG_ROOT` automatically, so a "no matches" for a command you know is deployed is a bug — not a signal it is absent. Commands AIWG deploys to your provider command directory (`.opencode/command/`, `.claude/commands/`, `~/.codex/prompts/`, …) ARE discoverable this way; fetch them with `aiwg show command <name>`. This prevents decline-without-search failures, ask-instead-of-act on new directives, and hallucinated skill or agent names. Full rule: `agentic/code/addons/aiwg-utils/rules/skill-discovery.md`.',
    '',
    '### Engagement Verification',
    '',
    'When a user asks whether AIWG is active or engaged in this project, run or read `aiwg status --probe --json` and report the result plainly: engaged state, project root, deployed provider files, installed frameworks/addons, and the next action from the probe. Do not add AIWG attribution, signatures, generated-by text, or passive footers to user files, commits, PRs, comments, code headers, or docs.',
    '',
    renderTrackerProtocol(trackerAuthority, {
      configHref: documentRelativeHref(projectPath, documentPath, trackerAuthority.configPath),
    }),
    '',
    '### Source Model',
    '',
    `- ${normalizedAiwgMdLabel} is the normalized project-local context entry point.`,
    '- Root `AIWG.md` is the generated cross-provider companion loaded through `AGENTS.md` and provider twins.',
    `- \`AGENTS.md\`, \`WARP.md\`, \`.hermes.md\`, and \`.github/copilot-instructions.md\` are provider-facing bridges, not replacements for ${normalizedAiwgMdLabel}.`,
    FINALIZATION_END,
    '',
  ];

  return lines.join('\n');
}

export function replaceOrAppendFinalizationBlock(content: string, block: string): string {
  const pattern = new RegExp(
    `${FINALIZATION_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${FINALIZATION_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
  );

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}`;
}

export async function buildNormalizedAiwgMd(projectPath: string, existing = ''): Promise<string> {
  const normalizedDocumentPath = projectControlPath(projectPath, 'AIWG.md');
  const block = await buildContextFinalizationBlock(projectPath, normalizedDocumentPath);
  const externalLinksSection = await buildExternalLinksSection(projectPath);
  const normalizedAiwgMdPath = displayProjectPath(projectPath, projectControlPath(projectPath, 'AIWG.md'));
  const base = existing.trim().length > 0
    ? existing
    : [
        '# AIWG.md',
        AIWG_SIGNATURE_COMMENT,
        '<!-- Normalized project-local AIWG context. Operator notes may live outside AIWG-managed blocks. -->',
        '',
        `This file is the stable \`${normalizedAiwgMdPath}\` entry point for AIWG skills, rules, and generated provider context.`,
        '',
      ].join('\n');

  const signed = base.includes(AIWG_SIGNATURE_COMMENT)
    ? base
    : base.replace(/^([^\n]*)(\n|$)/, `$1\n${AIWG_SIGNATURE_COMMENT}\n`);

  const withFinalization = replaceOrAppendFinalizationBlock(signed, block);
  return replaceOrAppendExternalLinksBlock(withFinalization, externalLinksSection);
}

export async function writeNormalizedAiwgMd(projectPath: string): Promise<string> {
  const targetPath = projectControlPath(projectPath, 'AIWG.md');
  let existing = '';
  try {
    existing = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const content = await buildNormalizedAiwgMd(projectPath, existing);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const normalizedContent = content.endsWith('\n') ? content : `${content}\n`;
  await fs.writeFile(targetPath, normalizedContent, 'utf8');

  const artifactRoot = resolveProjectAiwgDir(projectPath);
  const artifactPath = projectAiwgPath(projectPath, 'AIWG.md');
  if (artifactPath !== targetPath) {
    try {
      await fs.access(artifactRoot);
      await fs.writeFile(artifactPath, normalizedContent, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return targetPath;
}
