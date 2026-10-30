/** Shared source frontmatter contract for lint, deployment, and show/MCP (#2938). */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { parse } from 'yaml';

export const RULE_ACTIVATIONS = Object.freeze(['core', 'kernel', 'summary', 'bound', 'paths', 'on-demand']);

// Core rules (#3450): compact normative bodies delivered to every harness's
// always-loaded surface regardless of deploy mode. A body is `<rule>.core.md`
// beside the full rule; the full rule is reachable only by plain path or
// `aiwg show rule <name>`, never an @ import.
export const CORE_BODY_MAX_BYTES = 1024;
export const CORE_TOTAL_MAX_BYTES = 6144;
export const CORE_RULES_START = '<!-- AIWG:rule-core:start -->';
export const CORE_RULES_END = '<!-- AIWG:rule-core:end -->';
const AT_IMPORT = /(?:^|[\s(`"'])@[\w$.\/-]*[\/.][\w$.\/-]*/m;

export const RULE_BINDING_TYPES = Object.freeze({ skills: 'skill', agents: 'agent', flows: 'flow' });
export const ruleFrontmatterSchema = JSON.parse(readFileSync(new URL('./rule-frontmatter.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(ruleFrontmatterSchema);
// Legacy paths/applies_to/scope never become activation inputs during migration.
const validateLegacy = ajv.compile({ type: 'object', properties: ruleFrontmatterSchema.properties });

export function inferRuleActivation() {
  // Missing metadata never grants an always-on policy surface.
  return 'on-demand';
}

/** Validate a parsed YAML mapping. Invalid explicit activation never falls back. */
export function validateRuleFrontmatter(data) {
  const diagnostics = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, diagnostics: [{ severity: 'error', code: 'frontmatter', message: 'Rule frontmatter must be a mapping.' }] };
  }
  const tagged = Object.hasOwn(data, 'activation');
  const checker = tagged ? validate : validateLegacy;
  if (!checker(data)) {
    for (const error of checker.errors ?? []) diagnostics.push({
      severity: 'error', code: 'frontmatter',
      message: `${error.instancePath || '/'} ${error.message}${error.params.missingProperty ? `: ${error.params.missingProperty}` : ''}`,
    });
  }
  if (!tagged) diagnostics.push({ severity: 'warn', code: 'missing-activation',
    message: `Missing activation; inferred ${inferRuleActivation(data.enforcement)} delivery (migration fallback); add explicit activation frontmatter.` });
  const valid = !diagnostics.some(item => item.severity === 'error');
  return {
    valid, diagnostics,
    ...(valid ? { rule: {
      ...data,
      activation: tagged ? data.activation : inferRuleActivation(data.enforcement),
      tagged,
      ...(typeof data.summary === 'string' ? { summary: data.summary.trim() } : {}),
      bound_to: { skills: [], agents: [], flows: [], ...data.bound_to },
    } } : {}),
  };
}

/** Maximum summary length in Unicode code points after trimming (#3728). */
export const RULE_SUMMARY_MAX_LENGTH = 240;

/**
 * Render a rule frontmatter failure as one line naming the file, the field
 * and the limit. Shared by deployment and `aiwg doctor --project-local`
 * (#3728) so both surfaces report the same reason; the raw Ajv pattern
 * message encodes the limit only as a regex, so a too-long summary gets an
 * explicit sentence.
 */
export function formatRuleFrontmatterError(file, data, diagnostics) {
  const detail = diagnostics.map((item) => item.message).join('; ');
  const summary = typeof data?.summary === 'string' ? data.summary.trim() : null;
  if (
    summary !== null
    && [...summary].length > RULE_SUMMARY_MAX_LENGTH
    && diagnostics.some((item) => item.message.includes('/summary'))
  ) {
    return `${file}: summary is ${[...summary].length} characters; the limit is ${RULE_SUMMARY_MAX_LENGTH} characters (single line). ${detail}`;
  }
  return `${file}: ${detail}`;
}

/** Parse complete Markdown source, preserving authored body and opaque metadata. */
export function parseRuleFrontmatter(content) {
  const source = content.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(source)) return { ...validateRuleFrontmatter({}), data: {}, body: content };
  const match = source.match(/^---\r?\n([\s\S]*?)^---[ \t]*\r?$(?:\n)?/m);
  if (!match) return { valid: false, diagnostics: [{ severity: 'error', code: 'frontmatter', message: 'Unterminated rule frontmatter.' }], data: {}, body: content };
  try {
    const data = match[1].trim() ? parse(match[1]) : {};
    return { ...validateRuleFrontmatter(data), data, body: source.slice(match[0].length) };
  } catch (error) {
    return { valid: false, diagnostics: [{ severity: 'error', code: 'frontmatter', message: `Invalid rule YAML: ${error.message}` }], data: {}, body: content };
  }
}

export function coreBodyPath(ruleFile) {
  return ruleFile.replace(/\.md$/, '.core.md');
}

/** Validate one core body's text. Returns error strings (empty when valid). */
export function validateCoreBody(text, label = 'core body') {
  const errors = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!text.trim()) errors.push(`${label}: core body is empty`);
  if (bytes > CORE_BODY_MAX_BYTES) errors.push(`${label}: core body is ${bytes} bytes; the per-body cap is ${CORE_BODY_MAX_BYTES} bytes`);
  if (/^---\r?\n/.test(text)) errors.push(`${label}: core body must not carry frontmatter`);
  if (AT_IMPORT.test(text)) errors.push(`${label}: core body must not contain an @ file reference/import; use a plain path or \`aiwg show rule <name>\``);
  return errors;
}

/** Validate the whole core set against the reserved budget. */
export function validateCoreSet(bodies) {
  const total = bodies.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
  return total > CORE_TOTAL_MAX_BYTES
    ? [`Core rules total ${total} bytes; the reserved core budget is ${CORE_TOTAL_MAX_BYTES} bytes (${bodies.map(item => `${item.name}: ${Buffer.byteLength(item.text, 'utf8')}`).join(', ')})`]
    : [];
}

/** Read and validate the core body for a rule file; throws with a clear diagnostic. */
export function readCoreBody(ruleFile) {
  const file = coreBodyPath(ruleFile);
  if (!existsSync(file)) throw new Error(`${ruleFile}: activation core requires a compact body file ${path.basename(file)}`);
  const text = readFileSync(file, 'utf8').trim();
  const errors = validateCoreBody(text, file);
  if (errors.length) throw new Error(errors.join('; '));
  return text;
}

/**
 * Measure the core slice already deployed in a project, for `aiwg doctor`.
 * Native providers write core-<name>.md(c) files; the others carry a marked
 * section in their startup context file.
 */
export function measureDeployedCoreRules(target, provider, rulesDir) {
  const bodies = [];
  if (['claude', 'cursor'].includes(provider)) {
    const dir = rulesDir || path.join(target, `.${provider}`, 'rules');
    if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => /^core-.+\.(md|mdc)$/.test(n))) {
      // Count the authored body only, not the managed marker or MDC frontmatter.
      const text = readFileSync(path.join(dir, name), 'utf8')
        .replace(/^<!-- aiwg:managed[^\n]*-->\n/, '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      bodies.push({ name, bytes: Buffer.byteLength(text, 'utf8') });
    }
  } else {
    for (const name of ['AIWG.md', 'AGENTS.md', 'WARP.md']) {
      const file = path.join(target, name);
      if (!existsSync(file)) continue;
      const content = readFileSync(file, 'utf8');
      for (const [startMarker, endMarker] of [[CORE_RULES_START, CORE_RULES_END],
        ['<!-- AIWG:core-rules:start -->', '<!-- AIWG:core-rules:end -->']]) {
        const start = content.indexOf(startMarker);
        const end = content.indexOf(endMarker);
        if (start < 0 || end <= start) continue;
        const section = content.slice(start + startMarker.length, end).trim();
        const parts = section.replace(/^## Core rules\s*/, '').split(/(?=^# Core: )/m).filter(text => text.trim());
        const named = parts.every(text => /^# Core: /m.test(text));
        for (const text of named ? parts : [section]) {
          const ruleName = text.match(/aiwg show rule ([\w-]+)/)?.[1];
          bodies.push({ name: ruleName || name, bytes: Buffer.byteLength(text.trim(), 'utf8') });
        }
        break;
      }
      if (bodies.length) break;
    }
  }
  return { bodies, bytes: bodies.reduce((sum, item) => sum + item.bytes, 0), limit: CORE_TOTAL_MAX_BYTES };
}
