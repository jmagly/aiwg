import { RULE_PRECEDENCE_TEXT } from '../../rules/precedence.mjs';
import { maskCodeRegions } from './code-regions.js';
import { assertSafeContextFile, writeContextFileSync } from './context-file-safety.js';
/**
 * Context-finalization pass for generated provider context files.
 *
 * Templates provide the stable structure; this pass stitches in current
 * workspace facts from `.aiwg/aiwg.config` and rule authority pointers so
 * provider context files do not remain template-only (#1365).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  projectControlPath,
} from '../../config/project-artifacts.js';
import { renderTrackerProtocol, resolveTrackerAuthority } from '../../tracker/capability-protocol.js';
import { readConfig, readGitRemoteUrls } from '../../tracker/project-inputs.js';
import { DECISION_COMPACT_ANCHOR, inspectDecisionOffloadActivation } from '../../decision/offload-activation.js';
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
  const notesPath = displayProjectPath(projectPath, projectControlPath(projectPath, 'AIWG.md'));

  for (const [, entry] of installed) {
    for (const provider of Object.keys(entry.deployedTo ?? {})) {
      providerDeployments.add(provider);
    }
  }

  const trackerAuthority = resolveTrackerAuthority(config, remoteUrls);
  const decision = await inspectDecisionOffloadActivation({ cwd: projectPath });
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
    '- Generated framework context: `AIWG.md`',
    '',
    '### Rule Precedence',
    '',
    RULE_PRECEDENCE_TEXT,
    '',
    '### Capability Routing',
    '',
    'Routing authority: `aiwg show rule skill-discovery` (kernel); capability phrases: `aiwg show skill aiwg-utils-quickref`.',
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
    '- Root `AIWG.md` is the single generated framework context loaded through provider startup hooks.',
    `- Optional \`${notesPath}\` contains only operator-authored notes, folded into root AIWG.md on regenerate.`,
    '- Edit WORKSPACE.md Project Context for project conventions; edit .aiwg/AIWG.md only for optional framework notes, then run `aiwg regenerate`.',
    '- `AGENTS.md`, `CLAUDE.md`, `WARP.md`, `.hermes.md`, and `.github/copilot-instructions.md` are provider-facing bridges.',
    ...(decision.shouldAnchor ? ['', '## Compact Instructions', '', DECISION_COMPACT_ANCHOR] : []),
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

/** Compatibility renderer: normalized context now lives at the project root. */
export async function buildNormalizedAiwgMd(projectPath: string, existing = ''): Promise<string> {
  const block = await buildContextFinalizationBlock(projectPath);
  const base = existing || '# AIWG.md\n<!-- aiwg-managed -->\n';
  const signed = base.includes(AIWG_SIGNATURE_COMMENT) ? base : `${AIWG_SIGNATURE_COMMENT}\n${base}`;
  return replaceOrAppendExternalLinksBlock(
    replaceOrAppendFinalizationBlock(signed, block), await buildExternalLinksSection(projectPath),
  );
}

/** Remove only the contiguous legacy wrapper at the head, never quoted body lines. */
function stripLegacyNotesHeader(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').split(/(?<=\n)/);
  const wrappers = [
    /^# AIWG\.md$/,
    /^<!-- aiwg-managed -->$/,
    /^<!-- Normalized project-local AIWG context\. Operator notes may live outside AIWG-managed blocks\. -->$/,
    /^This file is the stable `[^`]+` entry point for AIWG skills, rules, and generated provider context\.$/,
  ];
  const removed = new Set<number>();
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i].replace(/\r?\n$/, '');
    if (!line.trim()) continue;
    const wrapper = wrappers.findIndex(pattern => pattern.test(line));
    if (wrapper < 0 || removed.has(wrapper)) break;
    removed.add(wrapper);
    lines[i] = '';
  }
  return lines.join('');
}

/** Strip only known generated wrappers; unknown text always belongs to the operator. */
export function extractAiwgOperatorNotes(existing: string): string {
  if (!existing.includes(AIWG_SIGNATURE_COMMENT)) return existing;
  let notes = stripLegacyNotesHeader(existing);
  for (const [start, end] of [
    [FINALIZATION_START, FINALIZATION_END],
    ['<!-- aiwg-external-links:start -->', '<!-- aiwg-external-links:end -->'],
  ]) {
    const pattern = new RegExp(`${start}[\\s\\S]*?${end}\\r?\\n?`, 'g');
    // Match in masked prose, then cut those exact offsets from the original.
    const matches = [...maskCodeRegions(notes).matchAll(pattern)];
    for (const match of matches.reverse()) {
      notes = notes.slice(0, match.index) + notes.slice(match.index! + match[0].length);
    }
  }
  return notes.trim() ? notes.replace(/^(?:\r?\n)+/, '') : '';
}

export async function readAiwgOperatorNotes(projectPath: string): Promise<{ path: string; existing: string | null; notes: string }> {
  const target = projectControlPath(projectPath, 'AIWG.md');
  await assertSafeContextFile(target);
  let existing: string | null = null;
  try { existing = await fs.readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { path: target, existing, notes: extractAiwgOperatorNotes(existing ?? '') };
}

/** Keep legacy files notes-only; journal even an empty migration for rollback. */
export async function migrateAiwgOperatorNotes(projectPath: string): Promise<void> {
  const { path: target, existing, notes } = await readAiwgOperatorNotes(projectPath);
  if (existing !== null && existing !== notes) writeContextFileSync(target, notes, 'utf8');
}

/** Compatibility writer used by init: emit only the generated root context. */
export async function writeNormalizedAiwgMd(projectPath: string, stagedClaudeMdContent?: string | null): Promise<string> {
  const target = path.join(projectPath, 'AIWG.md');
  await assertSafeContextFile(target);
  const { isOverwriteSafe } = await import('./generator.js');
  if (!(await isOverwriteSafe(target))) return target;
  const { buildAiwgMdContent } = await import('./aiwg-md.js');
  writeContextFileSync(target, await buildAiwgMdContent(projectPath, stagedClaudeMdContent), 'utf8');
  await migrateAiwgOperatorNotes(projectPath);
  return target;
}
