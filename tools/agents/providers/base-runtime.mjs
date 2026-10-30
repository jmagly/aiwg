// Shared provider runtime utilities.

/**
 * Shared utilities for provider modules
 *
 * This module contains common functions used across all providers:
 * - File operations (ensureDir, listMdFiles, writeFile, etc.)
 * - Model configuration loading
 * - Frontmatter parsing
 * - Other shared utilities
 */

import realFs from 'fs';

import path from 'path';

import os from 'os';

import yaml from 'yaml';

import { classifyModelRole } from './model-role.mjs';

import { createHash } from 'crypto';

import { createRequire } from 'module';

import { importImpl } from '../../_resolve-impl.mjs';


import { writeContextFileSync } from './context-write.mjs';


const { parseRuleFrontmatter, inferRuleActivation } = await importImpl(import.meta.url, 'rules/activation.mjs');

const { resolveRulesInlineBudget, DEFAULT_RULES_INLINE_BUDGET_TOKENS } = await importImpl(import.meta.url, 'rules/inline-budget.mjs');

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

const { helperEnvironment } = await importImpl(import.meta.url, 'process/cli-command.mjs');

const { extractFrameworkSlug, sameSkillOwner, mergeArtifactOwnership, canDeploySkill, pruneRecordedSkillFiles, releaseSkillOwnership } =
  await importImpl(import.meta.url, 'providers/skill-ownership.mjs');


// Use graceful-fs to prevent EMFILE crashes on systems with low ulimit.
// graceful-fs queues open() calls when FD pressure is detected and retries
// after a backoff, transparently wrapping the native fs module.
let fs;

try {
  const require = createRequire(import.meta.url);
  const gracefulFs = require('graceful-fs');
  gracefulFs.gracefulify(realFs);
  fs = realFs;
} catch {
  // graceful-fs not available — fall back to native fs
  fs = realFs;
}

export { realFs, path, os, yaml, classifyModelRole, createHash, createRequire, importImpl, writeContextFileSync, parseRuleFrontmatter, inferRuleActivation, resolveRulesInlineBudget, DEFAULT_RULES_INLINE_BUDGET_TOKENS, boundedExecFileSync, helperEnvironment, extractFrameworkSlug, sameSkillOwner, mergeArtifactOwnership, canDeploySkill, pruneRecordedSkillFiles, releaseSkillOwnership, fs };
