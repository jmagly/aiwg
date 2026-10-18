/** Shared source frontmatter contract for lint, deployment, and show/MCP (#2938). */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { parse } from 'yaml';

export const RULE_ACTIVATIONS = Object.freeze(['kernel', 'summary', 'bound', 'paths', 'on-demand']);
export const RULE_BINDING_TYPES = Object.freeze({ skills: 'skill', agents: 'agent', flows: 'flow' });
export const ruleFrontmatterSchema = JSON.parse(readFileSync(new URL('./rule-frontmatter.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(ruleFrontmatterSchema);
// Legacy paths/applies_to/scope never become activation inputs during migration.
const validateLegacy = ajv.compile({ type: 'object', properties: ruleFrontmatterSchema.properties });

export function inferRuleActivation(enforcement) {
  return typeof enforcement === 'string' && ['medium', 'low'].includes(enforcement.trim().toLowerCase())
    ? 'on-demand' : 'kernel';
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
    message: `Missing activation; inferred ${inferRuleActivation(data.enforcement)} delivery from legacy enforcement (migration fallback).` });
  if (Object.hasOwn(data, 'enforcedBy')) diagnostics.push({ severity: 'info', code: 'reserved-enforcedBy',
    message: 'enforcedBy is opaque reserved metadata (#2839); it has no effect.' });
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
