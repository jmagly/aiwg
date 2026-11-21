// Shares the existing project config reader's forward-compatible defaults.
import { normalizeDesktopConfig } from '../providers/devin-compat.mjs';
import type { AiwgConfig } from './aiwg-config.js';
export function normalizeAiwgConfigCandidate(parsed: AiwgConfig): AiwgConfig {
  if (!parsed.providers) parsed.providers = ['claude'];
  if (!parsed.installed) parsed.installed = {};
  if (!parsed.scripts) parsed.scripts = {};
  return normalizeDesktopConfig(parsed);
}
